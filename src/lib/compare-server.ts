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
import { additions, adoptStructure, breakAnchors, directEdits, segmentEdits, tokenize, untokenize, type DirectEdits, type Segment, type Tok } from "./doc-model";
import { documentStyleRequest } from "./page-setup";
import { buildDripPlan } from "./drip-engine";
import { parseAnchors, withAnchors } from "./breaks";
import { plainFormat } from "./rich-text";
import { buildSyncRecords, MAX_COMPARE_SEGMENTS, parseSegments, segmentBoundaries, spotsForTabs, type SegmentInput } from "./sync-plan";
import type { SyncContext, SyncJob, SyncPlan } from "./sync-store";
import { wordsInTabs } from "./google";
import { isStaleRevision } from "./sync-runner";
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

/** Docs' name for a tab nobody named ("Tab 1") */
const DEFAULT_TITLE = /^(tab \d+|untitled tab)$/i;

/**
 * Only targets that make sense for these documents; the rest are matched automatically. A rename
 * is only what the page asks for a blank tab with Docs' default name (the reference tab's name, as
 * the automatic match gives it): `blank` are LEFT's tabs with nothing in them.
 */
export function cleanTabMap(raw: unknown, left: TabInfo[], right: TabInfo[], blank: ReadonlySet<string> = new Set()): TabMap {
  const out: TabMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const leftById = new Map(left.map((t) => [t.id, t]));
  for (const t of right) {
    if (!Object.prototype.hasOwnProperty.call(raw, t.id)) continue;
    const v = (raw as Record<string, unknown>)[t.id] as Partial<TabTarget> | undefined;
    if (!v || typeof v !== "object") continue;
    if (v.kind === "skip") out[t.id] = { kind: "skip" };
    else if (v.kind === "new") out[t.id] = { kind: "new", title: t.title, ...(t.emoji ? { emoji: t.emoji } : {}), parentRightTabId: t.parentId };
    else if (v.kind === "tab" && typeof v.leftTabId === "string" && leftById.has(v.leftTabId)) {
      const l = leftById.get(v.leftTabId)!;
      const name = t.title.trim();
      const rename = typeof v.rename === "string" && v.rename.trim() === name && name && blank.has(l.id) && DEFAULT_TITLE.test(l.title.trim()) && l.title.trim().toLowerCase() !== name.toLowerCase();
      out[t.id] = { kind: "tab", leftTabId: v.leftTabId, ...(rename ? { rename: name } : {}) };
    }
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
  const tabMap: TabMap = matchTabs(left, ownRight, cleanTabMap(given, lt, rt, new Set(leftTabs.filter((t) => t.doc.empty).map((t) => t.id))));
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

/** A start refused before anything is written, with what to tell the user */
export class CompareRefusedError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "refused") { super(message); }
}

/** What a start needs from Google (the routes pass the real calls; tests pass a stub) */
export interface CompareGoogle {
  read(documentId: string): Promise<Doc>;
  /** One batch in a tab. With `requiredRevisionId` (the read its indices come from) Google refuses it once the document has changed since. */
  batch(documentId: string, requests: Record<string, unknown>[], tabId: string | null, requiredRevisionId?: string): Promise<Record<string, unknown>[]>;
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
  /** Whether the set-up wrote anything (tabs, tables, footnotes, headers) */
  setUp?: boolean;
}

const TAB_LIMIT = 100;
const MAX_STRUCTURAL_ROUNDS = 4;
/** Google refusing a batch because a collaborator just edited: read again and work it out again, this often */
const STALE_RETRIES = 3;
/** Upstash takes at most 1 MB in one request: a sync's plan is stored in one */
export const MAX_PLAN_JSON = 950_000;
/** At most what a plan's actions take per character typed (typos at their most, over a set time: about 4.2) */
const PLAN_BYTES_PER_CHAR = 4.5;
const TOO_MANY_SPOTS = `That's more than ${MAX_COMPARE_SEGMENTS.toLocaleString("en-US")} separate places to type into in one sync. Skip some changes, or copy one tab at a time.`;
const TOO_MUCH = "That's more than one sync can copy. Choose “Don't copy this tab” for some of the reference's tabs, or skip some changes, then copy the rest in a second sync.";
const TOO_MANY_TABS = `Google Docs allows at most ${TAB_LIMIT} tabs in a document. Choose “Don't copy this tab” for some of the reference's tabs.`;

const bodyOf = (doc: ImportedDoc): EditorNode => ({ type: "doc", content: doc.nodes });

/**
 * What the sync would type, worked out from the comparison before anything is written: a start too
 * big to store (or with too many places to type into, or too many tabs) is refused while LEFT is
 * still as it was, not halfway through setting it up.
 */
function preflight(work: TabCompare[], leftTabCount: number, pace?: PlanPace) {
  if (leftTabCount + work.filter((t) => t.target.kind === "new").length > TAB_LIMIT) throw new CompareRefusedError(TOO_MANY_TABS, 400, "tooManyTabs");
  let segments = 0;
  let formats = 0;
  let text = "";
  for (const t of work) {
    // LEFT once the set-up is in is the structure; the rest is typed
    const typed = additions(structureOnly(t.merged, t.origin), t.merged);
    segments += typed.segments.length;
    formats += JSON.stringify(typed.segments.map((s) => s.format)).length;
    text += typed.text;
  }
  if (segments > MAX_COMPARE_SEGMENTS) throw new CompareRefusedError(TOO_MANY_SPOTS, 400, "tooManyPlaces");
  // The plan's actions as the sync will make them, or as many as typos at their most would
  const actions = pace && text.trim() ? JSON.stringify(dripPlan(text, pace, []).actions).length : text.length * PLAN_BYTES_PER_CHAR;
  if (actions + formats > MAX_PLAN_JSON) throw new CompareRefusedError(TOO_MUCH, 400, "tooLarge");
}

/** How a sync is paced: what the start's plan is made with */
export type PlanPace = Pick<CompareJobInput, "breaksMode" | "targetMinutes" | "typoFrequency" | "seed">;

function dripPlan(text: string, o: PlanPace, boundaries: number[]) {
  return buildDripPlan(text, {
    targetMinutes: o.breaksMode === "manual" ? null : o.targetMinutes,
    breaks: o.breaksMode === "auto" ? "auto" : [],
    typoFrequency: o.typoFrequency,
    ...(o.seed != null ? { seed: o.seed } : {}),
    ...(boundaries.length ? { boundaries } : {}),
  });
}

/**
 * Set up what the sync can't type and work out what it does, tab by tab. `reviewed` are the
 * revisions the user compared; a change in either gives CompareChangedError. Every write only adds:
 * a batch whose indices come from a read is refused by Google once LEFT changed since (a
 * collaborator typing), and is then worked out again from a new read. Started again after a start
 * that stopped halfway (or a sync cancelled), it picks up what that one made instead of making it
 * twice: tabs by their title, tables by their place, footnotes made for a paragraph not typed yet.
 */
export async function prepareCompare(g: CompareGoogle, input: {
  leftId: string;
  rightId: string;
  leftRevision: string;
  rightRevision: string;
  tabMap: unknown;
  skip: string[];
  breaks: CompareBreak[];
  /** The sync's pace, to tell before anything is written whether its plan can be stored */
  pace?: PlanPace;
}): Promise<PreparedCompare> {
  const [firstLeft, rightDoc] = await Promise.all([g.read(input.leftId), g.read(input.rightId)]);
  if ((firstLeft.revisionId ?? "") !== input.leftRevision || (rightDoc.revisionId ?? "") !== input.rightRevision) throw new CompareChangedError();
  /** LEFT as last read, while nothing has been written to it since */
  let latest: Doc | null = firstLeft;
  let setUp = false;
  const read = async (): Promise<Doc> => (latest ??= await g.read(input.leftId));
  const write = (requests: Record<string, unknown>[], tabId: string | null, revision?: string) => {
    latest = null;
    setUp = true;
    return g.batch(input.leftId, requests, tabId, revision);
  };
  /**
   * A batch worked out from the tab as read now, sent for that revision, and worked out again when
   * Google refuses it (someone edited the document since). `expect.text` is the tab's text as it
   * was compared, then as these batches leave it: when someone else has changed it, a batch worked
   * out from the comparison could take their edit back, so the user compares again instead.
   */
  const writeFresh = async (tabId: string, expect: { text: string }, make: (base: EditorNode) => DirectEdits) => {
    for (let attempt = 0; ; attempt++) {
      const doc = await read();
      const base = bodyOf(importTab(doc, tabId));
      if (textOf(base) !== expect.text) throw new CompareChangedError();
      const edits = make(base);
      if (!edits.requests.length) return null;
      try {
        const replies = await write(onlyAdding(edits.requests as Record<string, unknown>[]), tabId, doc.revisionId || undefined);
        expect.text = textOf(edits.saved);
        return { edits, replies };
      } catch (err) {
        if (!isStaleRevision(err) || attempt >= STALE_RETRIES) throw err;
      }
    }
  };

  let sides = buildSides(firstLeft, input.leftId, rightDoc, input.rightId, input.tabMap);
  let result = compareDocs(sides.left, sides.right, { tabMap: sides.tabMap, skip: input.skip });
  const work = result.tabs.filter((t) => t.target.kind !== "skip" && t.stats.changes > 0);
  preflight(work, sides.left.tabs.length, input.pace);

  // New tabs (parents first, as the reference orders them) and blank default tabs renamed
  const created = new Map<string, string>(); // reference tab id → new LEFT tab id
  const targetOf = (rightTabId: string | null): string | null => {
    if (!rightTabId) return null;
    const t = sides.tabMap[rightTabId];
    if (t?.kind === "tab") return t.leftTabId;
    return created.get(rightTabId) ?? null;
  };
  // LEFT's tabs under each parent, in order, kept up to date as tabs are made
  const children = new Map<string | null, string[]>();
  for (const t of sides.left.tabs) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t.id]);
  const rightTabs = sides.right.tabs;
  /** Where among LEFT's tabs under `parentTabId` a new tab goes: after the tab its nearest earlier
   *  sibling in the reference went into, else before the one its nearest later sibling went into */
  const placeOf = (rightTabId: string, parentTabId: string | null): number | undefined => {
    const here = rightTabs.find((x) => x.id === rightTabId);
    const under = children.get(parentTabId) ?? [];
    const siblings = rightTabs.filter((x) => x.parentId === (here?.parentId ?? null));
    const at = siblings.findIndex((x) => x.id === rightTabId);
    for (let i = at - 1; i >= 0; i--) {
      const k = under.indexOf(targetOf(siblings[i].id) ?? "");
      if (k >= 0) return k + 1;
    }
    for (let i = at + 1; i < siblings.length; i++) {
      const k = under.indexOf(targetOf(siblings[i].id) ?? "");
      if (k >= 0) return k;
    }
    return undefined;
  };
  for (const t of work) {
    if (t.target.kind === "new") {
      const parentTabId = targetOf(t.target.parentRightTabId);
      const index = placeOf(t.rightTabId, parentTabId);
      latest = null;
      setUp = true;
      const id = await g.createTab(input.leftId, { title: t.target.title, ...(parentTabId ? { parentTabId } : {}), ...(index != null ? { index } : {}), ...(t.target.emoji ? { iconEmoji: t.target.emoji } : {}) });
      created.set(t.rightTabId, id);
      const under = [...(children.get(parentTabId) ?? [])];
      under.splice(index ?? under.length, 0, id);
      children.set(parentTabId, under);
    } else if (t.target.kind === "tab" && t.target.rename) {
      latest = null;
      setUp = true;
      await g.renameTab(input.leftId, t.target.leftTabId, t.target.rename);
    }
  }

  // Everything new now has a tab: compare again against what LEFT has now (the new tabs are blank,
  // with their own named styles), each reference tab going into its tab
  if (created.size) {
    const map: TabMap = { ...sides.tabMap };
    for (const [r, l] of created) map[r] = { kind: "tab", leftTabId: l };
    sides = buildSides(await read(), input.leftId, rightDoc, input.rightId, map);
    result = compareDocs(sides.left, sides.right, { tabMap: sides.tabMap, skip: input.skip });
  }

  // Images: the reference's addresses expire, so each is copied to SyncStream's image store
  let droppedImages = 0;
  const hosted = new Map<string, string | null>();
  const rehost = async (src: string) => {
    if (!hosted.has(src)) hosted.set(src, await g.rehost(src).catch(() => null));
    return hosted.get(src) ?? null;
  };

  const ready: { tabId: string; target: EditorNode }[] = [];
  for (const compared of result.tabs) {
    if (compared.target.kind !== "tab" || compared.stats.changes === 0) continue;
    const tabId = compared.target.leftTabId;
    const rightTab = sides.right.tabs.find((t) => t.id === compared.rightTabId);
    // Footnotes an earlier start made for a paragraph the sync never typed are that paragraph's
    const { tab, reused } = reuseNoteParagraphs(docsTables(compared));
    let target = applyBreaks(tab, input.breaks.filter((b) => b.rightTabId === tab.rightTabId));
    target = await mapImages(target, async (src) => {
      const url = await rehost(src);
      if (!url) droppedImages++;
      return url;
    });
    // A new or blank tab takes the reference's page setup and headers
    if (tab.setup?.pageSetup) await write([documentStyleRequest(tab.setup.pageSetup)], tabId);
    for (const which of ["header", "footer"] as const) {
      const seg = tab.setup?.[which];
      if (!seg?.nodes.length) continue;
      const replies = await write([which === "header" ? { createHeader: { type: "DEFAULT" } } : { createFooter: { type: "DEFAULT" } }], tabId);
      const reply = replies[0] as { createHeader?: { headerId?: string }; createFooter?: { footerId?: string } } | undefined;
      const segId = reply?.createHeader?.headerId ?? reply?.createFooter?.footerId;
      if (!segId) continue;
      const empty: EditorNode = { type: "doc", content: [{ type: "paragraph", attrs: {}, content: [] }] };
      const edits = segmentEdits(empty, { type: "doc", content: seg.nodes }, segId);
      if (edits.requests.length) await write(edits.requests as Record<string, unknown>[], tabId);
    }
    // One an earlier start made and stopped before writing (or any left empty) takes the reference's
    const leftTab = sides.left.tabs.find((t) => t.id === tabId);
    for (const which of ["header", "footer"] as const) {
      const mine = leftTab?.doc[which];
      const theirs = rightTab?.doc[which];
      if (tab.setup?.[which] || !mine || !theirs?.nodes.length || !blankSegment(mine.nodes) || blankSegment(theirs.nodes)) continue;
      const edits = segmentEdits({ type: "doc", content: mine.nodes }, { type: "doc", content: theirs.nodes }, mine.id).requests as Record<string, unknown>[];
      if (edits.length && !edits.some(removes)) await write(edits, tabId);
    }
    // What the sync can't type, written now: table structure and footnotes, without the text the sync
    // types around them. A table's structure is read back (Google gives its cells their indices)
    // before anything else is written, as autosave does
    let structure = structureOnly(tab.merged, tab.origin);
    const notes = footnoteSources(tab, sides.right);
    const expect = { text: textOf(compared.base) };
    const made: string[] = [];
    /** Footnotes to give the reference's text: those made now, and empty ones already there (only added to) */
    const fills: { fid: string; nodes: EditorNode[] | null; made: boolean }[] = reused.map((r) => ({ fid: r.fid, nodes: rightNote(rightTab, r.rightToken), made: false }));
    for (let round = 0; round < MAX_STRUCTURAL_ROUNDS; round++) {
      const sent = await writeFresh(tabId, expect, (base) => directEdits(base, (structure = adoptStructure(base, structure))));
      if (!sent) break;
      const ids = new Set(sent.replies.map((r) => (r as { createFootnote?: { footnoteId?: string } }).createFootnote?.footnoteId).filter((x): x is string => !!x));
      if (ids.size) {
        // The replies come in the order the requests went (from the end of the document back): the
        // references' order is read back, and the new references are those footnotes from now on
        const order = footnoteRefs(importTab(await read(), tabId)).filter((id) => ids.has(id));
        structure = withFootnoteIds(structure, order);
        for (const id of order) {
          fills.push({ fid: id, nodes: notes[made.length] ?? null, made: true });
          made.push(id);
        }
      }
      if (!sent.edits.structural) break;
    }
    if (made.length) target = withFootnoteIds(target, made);
    // The reference's text into each footnote, all in one batch (a footnote Docs makes holds a space
    // and its newline: diffed from what it holds, it ends up exactly as the reference's)
    if (fills.length) {
      const own = importTab(await read(), tabId).footnotes;
      const requests: Record<string, unknown>[] = [];
      for (const fill of fills) {
        const now = own[fill.fid];
        if (!fill.nodes?.length || !now || !blankSegment(now.nodes)) continue;
        const edits = segmentEdits({ type: "doc", content: now.nodes }, { type: "doc", content: fill.nodes }, fill.fid).requests as Record<string, unknown>[];
        if (fill.made || !edits.some(removes)) requests.push(...edits);
      }
      if (requests.length) await write(requests, tabId);
    }
    ready.push({ tabId, target });
  }

  // LEFT as it is now, and what each tab still needs typed
  const leftDoc = await read();
  const titles = new Map(rawTabs(leftDoc).map((t) => [t.id, t.title]));
  const tabs: PreparedTab[] = [];
  for (const { tabId, target } of ready) {
    const base = bodyOf(importTab(leftDoc, tabId));
    const adopted = adoptStructure(base, target);
    const { segments } = additions(base, adopted);
    if (!segments.length) continue;
    tabs.push({ tabId, title: titles.get(tabId) ?? "", base, target: adopted, segments, anchors: tabBreakAnchors(adopted, segments) });
  }
  return { result, tabs, leftDoc, droppedImages, setUp };
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

const removes = (r: Record<string, unknown>) => Object.keys(r).some((k) => REMOVING.has(k));

/** The requests, refused whole if any would remove something of LEFT's (a bug, never the user's content lost) */
function onlyAdding(requests: Record<string, unknown>[]): Record<string, unknown>[] {
  const bad = requests.find(removes);
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
 * Docs makes a paragraph with each table it inserts: an empty one before the table, at the start
 * of the paragraph the table goes before (or before the tab's final newline, which then follows
 * the table). The comparison is put in that shape, so that what the start writes and what Docs then
 * has are the same and nothing is ever taken back: a new table right after a paragraph of LEFT's
 * (or another table) gets the empty line Docs makes before it, in place of the reference's empty
 * line after it, so the lines add up; a new table with nothing of LEFT's after it is followed by
 * the tab's final newline.
 */
export function docsTables(tab: TabCompare): TabCompare {
  const toks = tokenize(tab.merged);
  const origin = [...tab.origin];
  const own = (i: number) => !(origin[i] >= 0);
  const out: Tok[] = [];
  const outOrigin: number[] = [];
  let changed = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let end = i;
    if (t.k === "st" && t.kind === "table" && !own(i)) while (end < toks.length && !(toks[end].k === "st" && (toks[end] as { id: string }).id === `${t.id}/`)) end++;
    if (end === i || end >= toks.length) { out.push(t); outOrigin.push(origin[i]); continue; }
    let after = -1;
    for (let q = end + 1; q < toks.length && after < 0; q++) if (own(q)) after = q;
    const prevNew = out[out.length - 1]?.k === "nl" && outOrigin[outOrigin.length - 1] >= 0;
    if (after >= 0 && !prevNew) {
      // The empty line Docs makes before it, in the look of the paragraph it goes before
      let nl = after;
      while (nl < toks.length && toks[nl].k !== "nl") nl++;
      out.push({ k: "nl", attrs: { ...((toks[nl] as Extract<Tok, { k: "nl" }> | undefined)?.attrs ?? {}) } });
      outOrigin.push(-1);
      changed = true;
    }
    for (let q = i; q <= end; q++) { out.push(toks[q]); outOrigin.push(origin[q]); }
    // (the reference's empty line after it: Docs' one before it stands for it)
    if (after >= 0 && !prevNew && toks[end + 1]?.k === "nl" && !own(end + 1)) end++;
    if (after < 0) {
      changed = true;
      const last = toks.length - 1;
      // The tab's final newline follows the table: what the reference has after the table is typed
      // into it, its last paragraph ending with it
      if (last > end && toks[last].k === "nl") origin[last] = -1;
      else {
        let mine = -1;
        for (let q = out.length - 1; q >= 0 && mine < 0; q--) if (out[q].k === "nl" && !(outOrigin[q] >= 0)) mine = q;
        out.push({ k: "nl", attrs: { ...(mine >= 0 ? (out[mine] as Extract<Tok, { k: "nl" }>).attrs : {}) } });
        outOrigin.push(-1);
      }
    }
    i = end;
  }
  if (!changed) return tab;
  const merged = untokenize(out);
  if (tokenize(merged).length !== outOrigin.length) return tab;
  return { ...tab, merged, origin: outOrigin };
}

/**
 * The structure a tab's additions need, without anything the sync types: LEFT as it is, plus the
 * reference's tables, rows and cells (empty), its footnote references, the paragraphs that hold a
 * new footnote reference (only the reference in them), and empty lines with nothing typed beside
 * them. The sync then types the text around them. Nothing else is written before it types: a
 * paragraph of LEFT's is never restyled to make room.
 */
export function structureOnly(merged: EditorNode, origin: number[]): EditorNode {
  const toks = tokenize(merged);
  const keep = toks.map(() => false);
  const typed = (j: number) => { const t = toks[j]; return (t.k === "c" || t.k === "img" || t.k === "pb" || t.k === "br") && origin[j] >= 0; };
  /** Whether the run of new content around token i (between LEFT's own content and table structure) has anything the sync types */
  const inTypedRun = (i: number) => {
    const inRun = (j: number) => j >= 0 && j < toks.length && origin[j] >= 0 && toks[j].k !== "st";
    for (let j = i; inRun(j); j--) if (typed(j)) return true;
    for (let j = i + 1; inRun(j); j++) if (typed(j)) return true;
    return false;
  };
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
      // A table always follows a paragraph, and Docs makes one with each table it inserts: the new
      // paragraph right before a new table goes in with the table (its text, if any, typed after)
      const next = toks[i + 1];
      const beforeTable = next?.k === "st" && next.kind === "table" && origin[i + 1] >= 0;
      // An empty line on its own (beside a new table, say) has nothing typed with it: it goes in now
      const alone = paragraphStart === i && !inTypedRun(i);
      keep[i] = note || beforeTable || alone || (cells.length > 0 && cells[cells.length - 1]);
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

/** The ids of a tab's footnote references, in the order they come in its body */
const footnoteRefs = (doc: ImportedDoc): string[] => tokenize(bodyOf(doc)).flatMap((t) => (t.k === "fn" && t.fid ? [t.fid] : []));

/** A document's characters, without its structure (what a start never writes) */
const textOf = (doc: EditorNode) => tokenize(doc).map((t) => (t.k === "c" ? t.c : "")).join("");

/** Whether a header, footer or footnote holds nothing: empty lines and spaces only */
const blankSegment = (nodes: EditorNode[]) => tokenize({ type: "doc", content: nodes }).every((t) => t.k === "nl" || (t.k === "c" && !t.c.trim()));

/** The content of the reference footnote whose reference is token `rightToken` of the reference tab */
function rightNote(rightTab: CompareTab | undefined, rightToken: number): EditorNode[] | null {
  if (!rightTab || !(rightToken >= 0)) return null;
  const t = tokenize(bodyOf(rightTab.doc))[rightToken];
  return t?.k === "fn" && t.fid ? rightTab.doc.footnotes[t.fid]?.nodes ?? null : null;
}

/**
 * A start makes the footnotes of a new paragraph before the sync types its text: a paragraph of
 * LEFT's holding only footnote references, right before or after a new paragraph that adds as many,
 * is what a start left when it stopped (or its sync was cancelled) before typing it. The new
 * paragraph's text goes into that one, around its footnotes, instead of a second paragraph whose
 * footnotes are made again. `reused`: each of those footnotes, with the reference token it stands
 * for (its text, when still empty, is the reference's).
 */
export function reuseNoteParagraphs(tab: TabCompare): { tab: TabCompare; reused: { fid: string; rightToken: number }[] } {
  const toks = tokenize(tab.merged);
  const own = (i: number) => !(tab.origin[i] >= 0);
  const paragraphs: { s: number; e: number }[] = [];
  let s = 0;
  toks.forEach((t, i) => {
    if (t.k === "nl") { paragraphs.push({ s, e: i }); s = i + 1; } else if (t.k === "st" || t.k === "block") s = i + 1;
  });
  const notes = (p: { s: number; e: number }) => toks.slice(p.s, p.e).filter((t) => t.k === "fn").length;
  const left = (p: { s: number; e: number }) => p.e > p.s && toks.slice(p.s, p.e + 1).every((t, k) => own(p.s + k) && (t.k === "nl" || (t.k === "fn" && !!t.fid)));
  const added = (p: { s: number; e: number }) => toks.slice(p.s, p.e + 1).every((t, k) => !own(p.s + k) && (t.k !== "fn" || !t.fid));
  /** Paragraph start → the tokens (and origins) that stand there instead; a paragraph merged away stands for nothing */
  const swap = new Map<number, { e: number; toks: Tok[]; origin: number[] }>();
  const reused: { fid: string; rightToken: number }[] = [];
  for (let k = 0; k + 1 < paragraphs.length; k++) {
    const a = paragraphs[k];
    const b = paragraphs[k + 1];
    if (b.s !== a.e + 1 || swap.has(a.s)) continue;
    const [kept, typed] = left(a) && added(b) ? [a, b] : added(a) && left(b) ? [b, a] : [null, null];
    if (!kept || !typed || notes(kept) !== notes(typed) || notes(typed) === 0) continue;
    const theirs = toks.slice(kept.s, kept.e) as Extract<Tok, { k: "fn" }>[];
    const out: Tok[] = [];
    const origin: number[] = [];
    let n = 0;
    for (let q = typed.s; q < typed.e; q++) {
      const t = toks[q];
      if (t.k === "fn") {
        reused.push({ fid: theirs[n].fid!, rightToken: tab.origin[q] });
        out.push(theirs[n++]);
        origin.push(-1);
      } else { out.push(t); origin.push(tab.origin[q]); }
    }
    // The paragraph stays LEFT's: its end and look as LEFT has them
    out.push(toks[kept.e]);
    origin.push(-1);
    const first = Math.min(a.s, b.s);
    swap.set(first, { e: Math.max(a.e, b.e), toks: out, origin });
    k++;
  }
  if (!swap.size) return { tab, reused: [] };
  const outToks: Tok[] = [];
  const outOrigin: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const sw = swap.get(i);
    if (sw) { outToks.push(...sw.toks); outOrigin.push(...sw.origin); i = sw.e; continue; }
    outToks.push(toks[i]);
    outOrigin.push(tab.origin[i]);
  }
  const merged = untokenize(outToks);
  // (only when the document reads back token for token as built, which it always should)
  if (tokenize(merged).length !== outOrigin.length) return { tab, reused: [] };
  return { tab: { ...tab, merged, origin: outOrigin }, reused };
}

/**
 * Where each Manual break of a tab starts in its typed text. A break after the tab's last word is
 * kept: the next tab's text follows it (one after the job's very last word is dropped with the job's).
 */
function tabBreakAnchors(target: EditorNode, segments: Segment[]): { at: number; minutes: number }[] {
  return breakAnchors(target, [...segments, { tokens: [0, 0], text: "\n" }]);
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
  // (what couldn't be typed, a new tab or a header say, may be all there was: it's in now)
  const nothing = { ok: false as const, status: 400, error: prepared.setUp ? "Your document now has everything in the reference. There was nothing left to type." : "Your document already has everything in the reference.", code: "nothing" };
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
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error === "Invalid additions" && raw.length > MAX_COMPARE_SEGMENTS ? TOO_MANY_SPOTS : `This comparison can't be typed: ${parsed.error}` };
  const segments = parsed.segments;
  const text = segments.map((s) => s.text).join("");
  if (!text.trim()) return nothing;
  if (text.length > MAX_TEXT_CHARS) return { ok: false, status: 400, error: `That's more than ${MAX_TEXT_CHARS.toLocaleString()} characters to copy in one sync.` };
  const boundaries = segmentBoundaries(segments);
  let placed = null;
  if (o.breaksMode === "manual" && anchors.length) {
    // The set-up is in by now: a break that can't go where it was put (after the very last word,
    // say) is left out rather than stopping the start
    const fits = anchors.filter((a, i) => anchors.findIndex((b) => b.at === a.at) === i && parseAnchors([a], text, { ends: boundaries }).ok);
    const a = parseAnchors(fits, text, { ends: boundaries });
    if (!a.ok) return { ok: false, status: 400, error: a.error };
    placed = a.anchors;
  }
  const drip = dripPlan(text, o, boundaries);
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
  // (the live page reads a sync's tabs from `tabs` alone: the first tab isn't stored twice)
  let context: SyncContext | null = { tabs };
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
  // Stored in one request each: a plan Redis can't take is refused here, not with a failure after
  if (JSON.stringify(syncPlan).length > MAX_PLAN_JSON) return { ok: false, status: 400, error: TOO_MUCH, code: "tooLarge" };
  return { ok: true, plan: syncPlan, job, context };
}
