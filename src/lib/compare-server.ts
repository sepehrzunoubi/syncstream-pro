/**
 * Compare & Sync on the server: reading both documents with every tab, importing the reference
 * against the named styles of the tabs it goes into, and, when a sync starts, setting up what the
 * sync can't type (new tabs, renamed blank tabs, page setup, table structure, footnotes, headers)
 * before working out the additions it types, tab by tab, top to bottom.
 */

import type { docs_v1 } from "googleapis";
import { importDoc, type DocDefaults, type ImportedDoc } from "./doc-import";
import { openTab } from "./doc-tabs";
import { compareDocs, matchTabs, applyBreaks } from "./compare";
import type { CompareBreak, CompareResult, CompareSide, CompareTab, TabCompare, TabMap, TabTarget } from "./compare-types";
import { additions, adoptStructure, breakAnchors, directEdits, segmentEdits, tokenize, untokenize, type Segment } from "./doc-model";
import { documentStyleRequest } from "./page-setup";
import { buildDripPlan } from "./drip-engine";
import { parseAnchors, withAnchors } from "./breaks";
import { plainFormat } from "./rich-text";
import { buildSyncRecords, MAX_COMPARE_SEGMENTS, parseSegments, segmentBoundaries, spotsForTabs, type SegmentInput } from "./sync-plan";
import type { SyncContext, SyncJob, SyncPlan } from "./sync-store";
import { wordsInTabs } from "./google";
import type { EditorNode } from "./rich-text";

type Doc = docs_v1.Schema$Document;
type RawTab = docs_v1.Schema$Tab;

export interface TabInfo { id: string; title: string; level: number; parentId: string | null; emoji?: string; index: number }

/** Every tab of a raw document, parents before their children, with their parents */
export function rawTabs(doc: Doc): TabInfo[] {
  const out: TabInfo[] = [];
  const walk = (tabs: RawTab[] | undefined, parentId: string | null, level: number) => {
    for (const t of tabs ?? []) {
      const p = t.tabProperties;
      if (p?.tabId && t.documentTab) {
        out.push({ id: p.tabId, title: p.title || "Untitled tab", level, parentId, ...(p.iconEmoji ? { emoji: p.iconEmoji } : {}), index: out.length });
      }
      walk(t.childTabs, p?.tabId ?? parentId, level + 1);
    }
  };
  walk(doc.tabs, null, 0);
  return out;
}

/** A tab's content imported, against `defaults` when given */
function importTab(doc: Doc, tabId: string, defaults?: DocDefaults): ImportedDoc {
  const open = openTab(doc, tabId);
  if (!open) throw new Error(`Tab ${tabId} is gone`);
  return importDoc(open.doc, defaults ? { defaults } : {});
}

/** The named styles a tab made through the API starts with (Google's defaults) */
const blankDefaults = (): DocDefaults => importDoc({} as Doc).defaults;

function side(doc: Doc, documentId: string, tabs: CompareTab[]): CompareSide {
  return { documentId, name: doc.title || "Untitled document", revisionId: doc.revisionId ?? "", tabs };
}

/** Only targets that make sense for these documents; the rest are matched automatically */
export function cleanTabMap(raw: unknown, left: TabInfo[], right: TabInfo[]): TabMap {
  const out: TabMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const leftIds = new Set(left.map((t) => t.id));
  for (const t of right) {
    const v = (raw as Record<string, unknown>)[t.id] as Partial<TabTarget> | undefined;
    if (!v || typeof v !== "object") continue;
    if (v.kind === "skip") out[t.id] = { kind: "skip" };
    else if (v.kind === "new") out[t.id] = { kind: "new", title: t.title, ...(t.emoji ? { emoji: t.emoji } : {}), parentRightTabId: t.parentId };
    else if (v.kind === "tab" && typeof v.leftTabId === "string" && leftIds.has(v.leftTabId)) out[t.id] = { kind: "tab", leftTabId: v.leftTabId };
  }
  return out;
}

export interface Sides { left: CompareSide; right: CompareSide; tabMap: TabMap }

/**
 * Both documents as compare reads them. LEFT's tabs as they are; the reference's tabs first as they
 * are (to match tabs by title and content), then again against the named styles of the tab each
 * goes into, so what it copies keeps the reference's look there.
 */
export function buildSides(leftDoc: Doc, leftId: string, rightDoc: Doc, rightId: string, given?: unknown): Sides {
  const lt = rawTabs(leftDoc);
  const rt = rawTabs(rightDoc);
  const leftTabs: CompareTab[] = lt.map((t) => ({ ...t, doc: importTab(leftDoc, t.id) }));
  const left = side(leftDoc, leftId, leftTabs);
  const ownRight = side(rightDoc, rightId, rt.map((t) => ({ ...t, doc: importTab(rightDoc, t.id) })));
  const tabMap: TabMap = matchTabs(left, ownRight, cleanTabMap(given, lt, rt));
  // A blank default tab renamed is only for the automatic match; a tab picked by hand keeps its name
  const byId = new Map(leftTabs.map((t) => [t.id, t]));
  const rightTabs: CompareTab[] = rt.map((t) => {
    const target = tabMap[t.id];
    const into = target?.kind === "tab" ? byId.get(target.leftTabId) : undefined;
    return { ...t, doc: importTab(rightDoc, t.id, into ? into.doc.defaults : blankDefaults()) };
  });
  return { left, right: side(rightDoc, rightId, rightTabs), tabMap };
}

/** Thrown when either document changed since the comparison the user reviewed */
export class CompareChangedError extends Error {
  constructor() { super("changed"); }
}

/** What a start needs from Google (the routes pass the real calls; tests pass a stub) */
export interface CompareGoogle {
  read(documentId: string): Promise<Doc>;
  batch(documentId: string, requests: Record<string, unknown>[], tabId: string | null): Promise<Record<string, unknown>[]>;
  createTab(documentId: string, props: { title: string; parentTabId?: string | null; index?: number; iconEmoji?: string }): Promise<string>;
  renameTab(documentId: string, tabId: string, title: string): Promise<void>;
  /** Re-host an image the reference shows (its URL lasts 30 minutes); null when it can't be */
  rehost(url: string): Promise<string | null>;
}

export interface PreparedTab {
  tabId: string;
  title: string;
  base: EditorNode;
  target: EditorNode;
  segments: Segment[];
  anchors: { at: number; minutes: number }[];
}

export interface PreparedCompare {
  result: CompareResult;
  tabs: PreparedTab[];
  /** LEFT as read after the set-up, for the spots */
  leftDoc: Doc;
  /** Images that couldn't be copied */
  droppedImages: number;
}

const TAB_LIMIT = 100;
const MAX_STRUCTURAL_ROUNDS = 4;

/**
 * Set up what the sync can't type and work out what it does, tab by tab. `reviewed` are the
 * revisions the user compared; a change in either gives CompareChangedError.
 */
export async function prepareCompare(g: CompareGoogle, input: {
  leftId: string;
  rightId: string;
  leftRevision: string;
  rightRevision: string;
  tabMap: unknown;
  skip: string[];
  breaks: CompareBreak[];
}): Promise<PreparedCompare> {
  const [firstLeft, rightDoc] = await Promise.all([g.read(input.leftId), g.read(input.rightId)]);
  let leftDoc = firstLeft;
  if ((leftDoc.revisionId ?? "") !== input.leftRevision || (rightDoc.revisionId ?? "") !== input.rightRevision) throw new CompareChangedError();
  let sides = buildSides(leftDoc, input.leftId, rightDoc, input.rightId, input.tabMap);
  let result = compareDocs(sides.left, sides.right, { tabMap: sides.tabMap, skip: input.skip });
  const work = result.tabs.filter((t) => t.target.kind !== "skip" && t.stats.changes > 0);

  // New tabs (parents first, as the reference orders them) and blank default tabs renamed
  const created = new Map<string, string>(); // reference tab id → new LEFT tab id
  const leftTabs = rawTabs(leftDoc);
  if (leftTabs.length + work.filter((t) => t.target.kind === "new").length > TAB_LIMIT) throw new Error("Google Docs allows at most 100 tabs in a document");
  const targetOf = (rightTabId: string | null): string | null => {
    if (!rightTabId) return null;
    const t = sides.tabMap[rightTabId];
    if (t?.kind === "tab") return t.leftTabId;
    return created.get(rightTabId) ?? null;
  };
  for (const t of work) {
    if (t.target.kind === "new") {
      const parentTabId = targetOf(t.target.parentRightTabId);
      const id = await g.createTab(input.leftId, { title: t.target.title, ...(parentTabId ? { parentTabId } : {}), ...(t.target.emoji ? { iconEmoji: t.target.emoji } : {}) });
      created.set(t.rightTabId, id);
    } else if (t.target.kind === "tab" && t.target.rename) {
      await g.renameTab(input.leftId, t.target.leftTabId, t.target.rename);
    }
  }

  // Everything new now has a tab: compare again against what LEFT has now (the new tabs are blank,
  // with their own named styles), each reference tab going into its tab
  if (created.size) {
    leftDoc = await g.read(input.leftId);
    const map: TabMap = { ...sides.tabMap };
    for (const [r, l] of created) map[r] = { kind: "tab", leftTabId: l };
    sides = buildSides(leftDoc, input.leftId, rightDoc, input.rightId, map);
    result = compareDocs(sides.left, sides.right, { tabMap: sides.tabMap, skip: input.skip });
  }

  // Images: the reference's addresses expire, so each is copied to SyncStream's image store
  let droppedImages = 0;
  const hosted = new Map<string, string | null>();
  const rehost = async (src: string) => {
    if (!hosted.has(src)) hosted.set(src, await g.rehost(src).catch(() => null));
    return hosted.get(src) ?? null;
  };

  const ready: { tab: TabCompare; tabId: string; target: EditorNode }[] = [];
  for (const tab of result.tabs) {
    if (tab.target.kind !== "tab" || tab.stats.changes === 0) continue;
    const tabId = tab.target.leftTabId;
    let target = applyBreaks(tab, input.breaks.filter((b) => b.rightTabId === tab.rightTabId));
    target = await mapImages(target, async (src) => {
      const url = await rehost(src);
      if (!url) droppedImages++;
      return url;
    });
    // A new or blank tab takes the reference's page setup and headers
    const setup: Record<string, unknown>[] = [];
    if (tab.setup?.pageSetup) setup.push(documentStyleRequest(tab.setup.pageSetup));
    if (setup.length) await g.batch(input.leftId, setup, tabId);
    for (const which of ["header", "footer"] as const) {
      const seg = tab.setup?.[which];
      if (!seg?.nodes.length) continue;
      const replies = await g.batch(input.leftId, [which === "header" ? { createHeader: { type: "DEFAULT" } } : { createFooter: { type: "DEFAULT" } }], tabId);
      const reply = replies[0] as { createHeader?: { headerId?: string }; createFooter?: { footerId?: string } } | undefined;
      const segId = reply?.createHeader?.headerId ?? reply?.createFooter?.footerId;
      if (!segId) continue;
      const empty: EditorNode = { type: "doc", content: [{ type: "paragraph", attrs: {}, content: [] }] };
      const edits = segmentEdits(empty, { type: "doc", content: seg.nodes }, segId);
      if (edits.requests.length) await g.batch(input.leftId, edits.requests as Record<string, unknown>[], tabId);
    }
    // What the sync can't type, written now: table structure and footnotes, without the text the sync
    // types around them. A table's structure is read back (Google gives its cells their indices)
    // before anything else is written, as autosave does
    let base = tab.base;
    let structure = structureOnly(tab.merged, tab.origin);
    const notes = footnoteSources(tab, sides.right);
    const made: string[] = [];
    for (let round = 0; round < MAX_STRUCTURAL_ROUNDS; round++) {
      const edits = directEdits(base, structure);
      if (!edits.requests.length) break;
      const replies = await g.batch(input.leftId, onlyAdding(edits.requests as Record<string, unknown>[]), tabId);
      const ids = replies.map((r) => (r as { createFootnote?: { footnoteId?: string } }).createFootnote?.footnoteId).filter((x): x is string => !!x);
      for (const id of ids) {
        const nodes = notes[made.length];
        made.push(id);
        if (!nodes?.length) continue;
        // A footnote Docs creates holds a space and its newline: diffed from that, it ends up exactly as the reference's
        const fresh: EditorNode = { type: "doc", content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: " " }] }] };
        const fill = segmentEdits(fresh, { type: "doc", content: nodes }, id);
        if (fill.requests.length) await g.batch(input.leftId, fill.requests as Record<string, unknown>[], tabId);
      }
      // The new references are those footnotes now: they must not be made again
      if (ids.length) structure = withFootnoteIds(structure, made);
      if (!edits.structural) break;
      leftDoc = await g.read(input.leftId);
      base = { type: "doc", content: importTab(leftDoc, tabId).nodes };
      structure = adoptStructure(base, structure);
    }
    if (made.length) target = withFootnoteIds(target, made);
    // Anything else the sync can't type (an empty line on its own beside a new table, say), now
    // that the structure is in and no longer part of the difference
    for (let round = 0; round < 2; round++) {
      leftDoc = await g.read(input.leftId);
      base = { type: "doc", content: importTab(leftDoc, tabId).nodes };
      const rest = directEdits(base, adoptStructure(base, target));
      if (!rest.requests.length) break;
      await g.batch(input.leftId, onlyAdding(rest.requests as Record<string, unknown>[]), tabId);
    }
    ready.push({ tab, tabId, target });
  }

  // LEFT as it is now, and what each tab still needs typed
  leftDoc = await g.read(input.leftId);
  const titles = new Map(rawTabs(leftDoc).map((t) => [t.id, t.title]));
  const tabs: PreparedTab[] = [];
  for (const { tabId, target } of ready) {
    const base: EditorNode = { type: "doc", content: importTab(leftDoc, tabId).nodes };
    const adopted = adoptStructure(base, target);
    const { segments } = additions(base, adopted);
    if (!segments.length) continue;
    tabs.push({ tabId, title: titles.get(tabId) ?? "", base, target: adopted, segments, anchors: breakAnchors(adopted, segments) });
  }
  return { result, tabs, leftDoc, droppedImages };
}

/** The document with each image's address replaced (null: the image is left out) */
async function mapImages(doc: EditorNode, to: (src: string) => Promise<string | null>): Promise<EditorNode> {
  const walk = async (n: EditorNode): Promise<EditorNode | null> => {
    if (n.type === "image" && n.marks?.some((m) => m.type === "syncAdd")) {
      const src = typeof n.attrs?.src === "string" ? n.attrs.src : "";
      const url = src ? await to(src) : null;
      return url ? { ...n, attrs: { ...n.attrs, src: url } } : null;
    }
    if (!n.content) return n;
    const content: EditorNode[] = [];
    for (const c of n.content) {
      const m = await walk(c);
      if (m) content.push(m);
    }
    return { ...n, content };
  };
  return (await walk(doc)) ?? doc;
}

/** Requests that would take anything away from LEFT: never sent by a comparison */
const REMOVING = new Set(["deleteContentRange", "deleteTableRow", "deleteTableColumn", "deleteHeader", "deleteFooter", "deletePositionedObject", "deleteNamedRange", "deleteTab"]);

/** The requests, refused whole if any would remove something of LEFT's (a bug, never the user's content lost) */
function onlyAdding(requests: Record<string, unknown>[]): Record<string, unknown>[] {
  const bad = requests.find((r) => Object.keys(r).some((k) => REMOVING.has(k)));
  if (bad) throw new Error(`A comparison must never remove anything from your document (${Object.keys(bad)[0]})`);
  return requests;
}

/** The reference footnote's content for each footnote reference the tab adds, in order */
function footnoteSources(tab: TabCompare, right: CompareSide): (EditorNode[] | null)[] {
  const rightTab = right.tabs.find((t) => t.id === tab.rightTabId);
  if (!rightTab) return [];
  const rightToks = tokenize({ type: "doc", content: rightTab.doc.nodes });
  const out: (EditorNode[] | null)[] = [];
  tokenize(tab.merged).forEach((t, i) => {
    if (t.k !== "fn" || t.fid) return;
    const o = tab.origin[i];
    const src = o != null && o >= 0 ? rightToks[o] : undefined;
    const fid = src && src.k === "fn" ? src.fid : null;
    out.push(fid ? rightTab.doc.footnotes[fid]?.nodes ?? null : null);
  });
  return out;
}

/**
 * The structure a tab's additions need, without anything the sync types: LEFT as it is, plus the
 * reference's tables, rows and cells (empty), its footnote references, and the paragraphs that hold
 * a new footnote reference (only the reference in them). The sync then types the text around them.
 */
export function structureOnly(merged: EditorNode, origin: number[]): EditorNode {
  const toks = tokenize(merged);
  const keep = toks.map(() => false);
  /** Whether each open cell is one the reference adds */
  const cells: boolean[] = [];
  let paragraphStart = 0;
  toks.forEach((t, i) => {
    const own = !(origin[i] >= 0);
    if (t.k === "st") {
      keep[i] = true;
      if (t.kind === "cell") cells.push(!own);
      else if (t.kind === "cellEnd") cells.pop();
      paragraphStart = i + 1;
      return;
    }
    if (own) {
      keep[i] = true;
      if (t.k === "nl") paragraphStart = i + 1;
      return;
    }
    if (t.k === "fn") { keep[i] = true; return; }
    if (t.k === "nl") {
      let note = false;
      for (let j = paragraphStart; j < i && !note; j++) note = toks[j].k === "fn" && origin[j] >= 0;
      // An empty line right before a new table is the one Docs makes with it (a table always
      // follows a paragraph): it goes in with the table
      const beforeTable = paragraphStart === i && toks[i + 1]?.k === "st" && (toks[i + 1] as { kind: string }).kind === "table" && origin[i + 1] >= 0;
      keep[i] = note || beforeTable || (cells.length > 0 && cells[cells.length - 1]);
      paragraphStart = i + 1;
    }
    // Copied text, images, page breaks and line breaks: typed by the sync
  });
  return untokenize(toks.filter((_, i) => keep[i]));
}

/** The document with its new footnote references (no id yet) given these ids, in order */
function withFootnoteIds(doc: EditorNode, ids: string[]): EditorNode {
  let i = 0;
  const walk = (n: EditorNode): EditorNode => {
    if (n.type === "footnoteRef" && !n.attrs?.fid && i < ids.length) return { ...n, attrs: { ...n.attrs, fid: ids[i++] } };
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return walk(doc);
}

export const COMPARE_CHANGED = "One of the documents changed since you compared them. Here's the comparison again.";
const MAX_CONTEXT_JSON = 900_000;
const MAX_TEXT_CHARS = 1_000_000;

export interface CompareJobInput {
  id: string;
  userId: string;
  documentId: string;
  documentName: string;
  breaksMode: "auto" | "none" | "manual";
  targetMinutes: number | null;
  typoFrequency: number;
  seed?: number;
  startInMinutes: number;
  now: number;
  accessToken: string;
  refreshToken: string;
}

export type CompareJob =
  | { ok: true; plan: SyncPlan; job: SyncJob; context: SyncContext | null }
  | { ok: false; status: number; error: string; code?: string };

/** One sync typing the prepared additions, tab by tab, top to bottom, with the manual breaks placed */
export function buildCompareJob(prepared: PreparedCompare, o: CompareJobInput): CompareJob {
  const nothing = { ok: false as const, status: 400, error: "Your document already has everything in the reference.", code: "nothing" };
  if (!prepared.tabs.length) return nothing;
  // The additions, tab by tab, as one source; manual breaks moved to their place in it
  const raw: SegmentInput[] = [];
  const anchors: { at: number; minutes: number }[] = [];
  let offset = 0;
  for (const t of prepared.tabs) {
    for (const a of t.anchors) anchors.push({ at: a.at + offset, minutes: a.minutes });
    for (const s of t.segments) {
      raw.push({ at: s.at, mode: s.mode, text: s.text, format: s.format, tabId: t.tabId });
      offset += s.text.length;
    }
  }
  const parsed = parseSegments(raw, { maxSegments: MAX_COMPARE_SEGMENTS });
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error === "Invalid additions" && raw.length > MAX_COMPARE_SEGMENTS ? `That's more than ${MAX_COMPARE_SEGMENTS.toLocaleString()} separate places to type into in one sync. Skip some changes, or copy one tab at a time.` : `This comparison can't be typed: ${parsed.error}` };
  const segments = parsed.segments;
  const text = segments.map((s) => s.text).join("");
  if (!text.trim()) return nothing;
  if (text.length > MAX_TEXT_CHARS) return { ok: false, status: 400, error: `That's more than ${MAX_TEXT_CHARS.toLocaleString()} characters to copy in one sync.` };
  const boundaries = segmentBoundaries(segments);
  let placed = null;
  if (o.breaksMode === "manual" && anchors.length) {
    const a = parseAnchors(anchors, text, { ends: boundaries });
    if (!a.ok) return { ok: false, status: 400, error: a.error };
    placed = a.anchors;
  }
  const drip = buildDripPlan(text, {
    targetMinutes: o.breaksMode === "manual" ? null : o.targetMinutes,
    breaks: o.breaksMode === "auto" ? "auto" : [],
    typoFrequency: o.typoFrequency,
    ...(o.seed != null ? { seed: o.seed } : {}),
    ...(boundaries.length ? { boundaries } : {}),
  });
  const plan = placed ? withAnchors(drip, placed) : drip;
  if (!plan.actions.length) return { ok: false, status: 400, error: "Nothing to type" };
  const spots = spotsForTabs(prepared.leftDoc, segments);
  if (!spots) return { ok: false, status: 409, error: COMPARE_CHANGED, code: "changed" };

  // What the running view shows: each tab as it will be, with where each segment's text came from
  let first = 0;
  const tabs = prepared.tabs.map((t) => {
    const entry = { tabId: t.tabId, title: t.title, first, doc: t.target, ranges: t.segments.map((s) => s.tokens) };
    first += t.segments.length;
    return entry;
  });
  const lead = tabs[0];
  let context: SyncContext | null = { doc: lead.doc, ranges: lead.ranges, tabs };
  if (JSON.stringify(context).length > MAX_CONTEXT_JSON) context = null;
  const many = prepared.tabs.length > 1 || (prepared.leftDoc.tabs?.length ?? 0) > 1;
  const { plan: syncPlan, job } = buildSyncRecords({
    id: o.id,
    userId: o.userId,
    documentId: o.documentId,
    documentName: (prepared.leftDoc.title || o.documentName || "Untitled document").trim().slice(0, 200),
    tab: { id: lead.tabId, title: many ? lead.title : "" },
    tabs: prepared.tabs.map((t) => ({ id: t.tabId, title: t.title })),
    plan,
    format: plainFormat(text),
    segments,
    spots,
    startInMinutes: o.startInMinutes,
    now: o.now,
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    baselineWordCount: wordsInTabs(prepared.leftDoc, prepared.tabs.map((t) => t.tabId)),
  });
  return { ok: true, plan: syncPlan, job, context };
}
