/**
 * Sync fidelity: type what the editor shows into a stub Google Doc with the real runner (typos and
 * all), read the document back as the editor would, and list every way the two differ: paragraph
 * styles, where each line sits, list numbers and glyphs (shape and style), and each character's look.
 * Zero differences is the promise SyncStream makes: the Google Doc ends up as the page showed it.
 *
 * The stub is strict-stub.ts, the offline stub plus the Docs behaviour its documentation states
 * (list join, bullet text styles, link defaults, each list style's glyphs) and what live runs
 * showed (a bullet made on its own lands at level 0 and keeps its tabs).
 */
import fs from "node:fs";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { docs_v1 } from "googleapis";
import { editorExtensions } from "../../src/components/workspace/extensions";
import { breaksAsParagraphs, insertParagraphs } from "../../src/components/workspace/paste";
import { importDoc } from "../../src/lib/doc-import";
import { readDocsSlice, sliceParagraphs, type DocsSlice } from "../../src/lib/docs-slice";
import { additions, PENDING_MARK } from "../../src/lib/doc-model";
import { buildDripPlan } from "../../src/lib/drip-engine";
import { snapshotOf } from "../../src/lib/google";
import { listLabels } from "../../src/lib/list-labels";
import { effectiveKeep, NAMED_STYLES, paragraphFromAttrs, parseFormat, plainFormat, richFromEditorJSON, styleFromMarks, type EditorNode } from "../../src/lib/rich-text";
import { buildSyncRecords, parseSegments, segmentBoundaries, spotsFor } from "../../src/lib/sync-plan";
import { runJobWindow, type RunnerDeps } from "../../src/lib/sync-runner";
import { createMemoryStore } from "../../src/lib/sync-store";
import { FastClock } from "../e2e-live/clock";
import { runnerDocsApi } from "../e2e-live/docs-client";
import { createStrictStubDocs, type StrictOptions } from "./strict-stub";

// ── Editor content, as a paste gives it ────────────────────────────────────

type Marks = NonNullable<EditorNode["marks"]>;
const ADD = { type: PENDING_MARK };
export const ts = (fontSize: number | null, color: string | null = "rgb(0, 0, 0)", fontFamily: string | null = "Arial") => ({ type: "textStyle", attrs: { fontFamily, fontSize, color } });
export const hl = (color: string) => ({ type: "highlight", attrs: { color } });
const PARA = { styleName: "normal", textAlign: null, indent: 0, firstLine: false, lineSpacing: 115, list: null, level: null, preset: null, indentEnd: null, box: null, keep: null, borders: null, shading: null };
type Piece = string | [string, Marks] | EditorNode;
/** A paragraph of new text */
export const P = (attrs: Record<string, unknown>, ...pieces: Piece[]): EditorNode => ({
  type: "paragraph",
  attrs: { ...PARA, ...attrs },
  content: pieces.map((p) => (typeof p === "string" ? { type: "text", text: p, marks: [ts(11), ADD] } : Array.isArray(p) ? { type: "text", text: p[0], marks: [...p[1], ADD] } : { ...p, marks: [...(p.marks ?? []), ADD] })),
});
export const box0 = { start: 0, first: 0, above: 0, below: 0 };
export const H1 = (text: string, extra: Marks = []) => P({ styleName: "h1", box: { start: 0, first: 0, above: 20, below: 6 } }, [text, [ts(20), ...extra]]);
const BR = { type: "hardBreak" } as EditorNode;
export const LI = (level: number, list: "bullet" | "ordered" = "bullet", ...pieces: Piece[]) => P({ list, level }, ...pieces);
export const EMPTY = (attrs: Record<string, unknown> = {}): EditorNode => ({ type: "paragraph", attrs: { ...PARA, ...attrs }, content: [] });

/** Everything in these paragraphs is new: it glows, and the sync types it */
export function asAdded(nodes: EditorNode[]): EditorNode[] {
  const mark = (n: EditorNode): EditorNode => ({
    ...n,
    ...(n.type === "text" || n.type === "image" || n.type === "hardBreak" ? { marks: [...(n.marks ?? []).filter((m) => m.type !== PENDING_MARK), ADD] } : {}),
    ...(n.content ? { content: n.content.map(mark) } : {}),
  });
  return nodes.map(mark);
}

const schema = getSchema(editorExtensions);
/** An empty Google Doc's named styles, as the editor reads them */
const EMPTY_DOC_DEFAULTS = { fontFamily: "Arial", fontSize: 11, lineSpacing: 115, styles: {} };

/**
 * A Docs clipboard capture (its -slice.json, with the .txt next to it) pasted into the editor's
 * document `base` with the cursor in its first paragraph, by the editor's own paste code. Null when
 * the paste reads the capture's HTML instead (the slice has content it leaves to the HTML).
 */
export function pasteCapture(path: string, base: EditorNode[]): EditorNode[] | null {
  const slice = readDocsSlice(fs.readFileSync(path, "utf8"), fs.readFileSync(path.replace(/-slice\.json$|\.slice\.json$/, ".txt"), "utf8"));
  return slice ? pasteSlice(slice, base, path) : null;
}

/** A Docs copy pasted at the start of the document, by the editor's paste code */
export function pasteSlice(slice: DocsSlice, base: EditorNode[], name = "the copy"): EditorNode[] {
  const nodes = sliceParagraphs(slice, EMPTY_DOC_DEFAULTS).map((n) => schema.nodeFromJSON(n));
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content: base }) });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
  const view = { get state() { return state; }, dispatch(tr: Transaction) { state = state.apply(tr); } } as unknown as EditorView;
  if (!insertParagraphs(view, nodes, slice.endsWithParagraph, EMPTY_DOC_DEFAULTS)) throw new Error(`${name}: the editor refused the paste`);
  return (state.doc.toJSON() as EditorNode).content ?? [];
}

/** A copy from Docs of these paragraphs (in a `size` of their own), the ones with a list item's `level` in one numbered list */
export function docsCopy(paras: { text: string; level?: number; size?: number }[]): DocsSlice {
  let at = 1;
  const content: docs_v1.Schema$StructuralElement[] = paras.map(({ text, level, size }) => {
    const startIndex = at;
    at += text.length + 1;
    return {
      startIndex,
      endIndex: at,
      paragraph: {
        elements: [{ startIndex, endIndex: at, textRun: { content: `${text}\n`, textStyle: size ? { fontSize: { magnitude: size, unit: "PT" } } : {} } }],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT", ...(level == null ? {} : { indentStart: { magnitude: 36 * (level + 1), unit: "PT" }, indentFirstLine: { magnitude: 36 * level + 18, unit: "PT" } }) },
        ...(level == null ? {} : { bullet: { listId: "kix.copied", nestingLevel: level } }),
      },
    };
  });
  const levels = [0, 1, 2].map((l) => ({ glyphType: ["DECIMAL", "ALPHA", "ROMAN"][l], glyphFormat: `%${l}.`, indentStart: { magnitude: 36 * (l + 1), unit: "PT" }, indentFirstLine: { magnitude: 36 * l + 18, unit: "PT" }, startNumber: 1 }));
  return { doc: { body: { content }, lists: { "kix.copied": { listProperties: { nestingLevels: levels } } } }, endsWithParagraph: true, text: paras.map((p) => p.text).join("\n") + "\n" };
}

// ── Running a sync ─────────────────────────────────────────────────────────

export interface SyncCase {
  /** Requests that give the target doc content before the sync */
  setup?: object[];
  /** The target doc's named styles, when not Google's defaults */
  namedStyles?: docs_v1.Schema$NamedStyle[];
  /** The editor after the paste, from the document's own paragraphs */
  target: (base: EditorNode[]) => EditorNode[];
}

export interface SyncOptions {
  seed?: number;
  /** Typo frequency, 0 to 1 */
  typos?: number;
  /** The dashboard's other path: the whole editor appended as one text (FormatIndex) */
  append?: boolean;
  stub?: StrictOptions;
}

/** The stub as SyncStream's fidelity is held to: every documented and observed Docs behaviour on */
export const STRICT: StrictOptions = { join: true, bulletStyle: true, soloTabs: true };

export async function syncInto(c: SyncCase, opts: SyncOptions = {}) {
  const docs = createStrictStubDocs({ ...(opts.stub ?? STRICT), namedStyles: c.namedStyles });
  const id = await docs.create("fidelity");
  if (c.setup) await docs.batchUpdate(id, c.setup);
  const setupBatches = docs.batches.length;
  const base: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  const target: EditorNode = { type: "doc", content: c.target(base.content ?? []) };
  const { segments } = additions(base, target);
  // Through JSON and the server's checks, as a sync request goes
  const parsed = opts.append ? { ok: true as const, segments: [] } : parseSegments(JSON.parse(JSON.stringify(segments.map(({ at, mode, text, format }) => ({ at, mode, text, format })))));
  if (!parsed.ok) throw new Error(parsed.error);
  const whole = richFromEditorJSON(target);
  const appendFormat = parseFormat(whole.text, JSON.parse(JSON.stringify(whole.format)));
  if (!appendFormat.ok) throw new Error(appendFormat.error);
  const text = opts.append ? whole.text : parsed.segments.map((x) => x.text).join("");
  const boundaries = segmentBoundaries(parsed.segments);
  const plan = buildDripPlan(text, { seed: opts.seed ?? 7, breaks: [], typoFrequency: opts.typos ?? 0.7, ...(boundaries.length ? { boundaries } : {}) });
  const current = await docs.get(id);
  const spots = opts.append ? undefined : spotsFor(current, snapshotOf(current).chars, parsed.segments)!;
  const clock = new FastClock();
  const store = createMemoryStore(clock.now);
  const { plan: syncPlan, job } = buildSyncRecords({ id: "job1", userId: "u", documentId: id, documentName: "fidelity", plan, format: opts.append ? appendFormat.format : plainFormat(text), segments: opts.append ? null : parsed.segments, spots, now: clock.now(), accessToken: "a", refreshToken: "r", baselineWordCount: 0 });
  await store.setPlan(syncPlan);
  await store.setJob(job);
  await store.addActiveJob("job1");
  const queue: { generation: number; delaySec: number; tick?: number }[] = [];
  const deps: RunnerDeps = { store, docs: runnerDocsApi(docs), refresh: async () => ({ access_token: "a" }), enqueue: async (_i, generation, delaySec, tick) => { queue.push({ generation, delaySec, tick }); }, now: clock.now, sleep: clock.sleep };
  let msg: { generation: number; delaySec: number; tick?: number } = { generation: 0, delaySec: 0 };
  let outcome = "";
  let error: string | undefined;
  for (;;) {
    const r = await runJobWindow("job1", msg.generation, { ...deps, tick: msg.tick });
    if (["done", "error", "cancelled", "paused", "not_found", "already_finished"].includes(r.outcome)) { outcome = r.outcome; error = r.job?.error; break; }
    const next = queue.shift();
    if (!next) throw new Error(`The runner stopped with ${r.outcome} and nothing queued`);
    clock.advance(next.delaySec * 1000);
    msg = next;
  }
  return { outcome, error, target, doc: await docs.get(id), batches: docs.batches.slice(setupBatches), actions: plan.actions.length };
}

// ── Comparing ───────────────────────────────────────────────────────────────

const SIZES: Record<string, number> = { normal: 11, title: 26, subtitle: 15, h1: 20, h2: 16, h3: 14, h4: 12, h5: 11, h6: 11 };
const SPACE: Record<string, [number, number]> = Object.fromEntries(Object.entries(NAMED_STYLES).map(([k, v]) => [k, v.space]));

/**
 * Content as the paste leaves it in the editor: each line break in it the paragraph the sync will
 * make of it (Docs drops U+000B sent through its API, commit 5675618), drawn as the break was
 */
export function asPasted(nodes: EditorNode[]): EditorNode[] {
  const state = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content: nodes }) });
  return (breaksAsParagraphs(state.tr, 0, state.doc.content.size, EMPTY_DOC_DEFAULTS).doc.toJSON() as EditorNode).content ?? [];
}

/** JSON with each object's keys in order, so the same values compare the same */
const sortedJSON = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Every way the document differs from what the editor shows, as importDoc reads it back */
export function differences(target: EditorNode, out: docs_v1.Schema$Document): string[] {
  const after = importDoc(out);
  // A style with what the paragraph's named style gives filled in (importDoc leaves out values equal to it)
  const filled = (s0: Record<string, unknown>, style: string) => {
    const s = { ...s0, font: s0.font ?? after.defaults.styles[style as "normal"]?.fontFamily ?? after.defaults.fontFamily, size: s0.size ?? after.defaults.styles[style as "normal"]?.fontSize ?? (style === "normal" ? after.defaults.fontSize : SIZES[style]), color: s0.color ?? after.defaults.styles[style as "normal"]?.color ?? "#000000" };
    return JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k, v]) => v != null && k !== "link").sort(([a], [b]) => a.localeCompare(b))));
  };
  const paras = (d: EditorNode[]) => d.map((n) => {
    const raw = paragraphFromAttrs(n.attrs);
    const sp = raw.space ?? { above: SPACE[raw.style][0], below: SPACE[raw.style][1] };
    // Where the text and the glyph sit. A list item is compared by how it looks: its glyph through the
    // labels below (the editor names a list style, the document its glyphs), its place by its indents,
    // whatever nesting level puts it there (Docs can't start a list nested; the sync indents the item instead)
    const level = raw.level ?? 0;
    const exact = raw.list ? raw.exact ?? { start: 36 * (level + 1), first: 36 * (level + 1) - 18 } : raw.exact ?? { start: raw.indent * 36, first: raw.indent * 36 + (raw.firstLine ? 36 : 0) };
    // Keep options as the page lays the paragraph out: its own, else its named style's in the document
    const p = { ...raw, keep: effectiveKeep(raw.keep, raw.style, after.defaults.keep), space: sp, glyph: undefined, preset: undefined, level: undefined, exact: exact && (exact.start || exact.first) ? exact : undefined, indent: undefined, firstLine: undefined, cont: undefined } as Record<string, unknown>;
    // An empty line is as tall as its newline's look makes it
    if (!n.content?.length) p.newline = filled(styleFromMarks(((n.attrs?.nl as Marks | undefined) ?? []).filter((m) => m.type !== PENDING_MARK)), raw.style);
    const chars: string[] = [];
    for (const c of n.content ?? []) {
      const s0 = styleFromMarks((c.marks ?? []).filter((m) => m.type !== PENDING_MARK));
      const link = s0.link ? `"link":${JSON.stringify(s0.link)},` : "";
      const sorted = link ? filled(s0, raw.style).replace("{", `{${link}`) : filled(s0, raw.style);
      if (c.type === "text") for (const ch of c.text ?? "") chars.push(ch + sorted);
      else chars.push(c.type ?? "?");
    }
    return { p, chars };
  });
  // The page as it is: a line break it shows must be one in the document too
  const shown = target.content ?? [];
  const want = paras(shown);
  const got = paras(after.nodes);
  const diffs: string[] = [];
  if (want.length !== got.length) diffs.push(`paragraph count: editor ${want.length}, doc ${got.length}`);
  for (let i = 0; i < Math.min(want.length, got.length); i++) {
    const w = want[i];
    const g = got[i];
    const wp = sortedJSON(w.p);
    const gp = sortedJSON(g.p);
    if (wp !== gp) diffs.push(`P${i} paragraph\n  editor ${wp}\n  doc    ${gp}`);
    const tx = (x: string[]) => x.map((c) => (c.length > 1 && c[1] === "{" ? c[0] : `[${c}]`)).join("");
    if (tx(w.chars) !== tx(g.chars)) { diffs.push(`P${i} text\n  editor ${JSON.stringify(tx(w.chars).slice(0, 70))}\n  doc    ${JSON.stringify(tx(g.chars).slice(0, 70))}`); continue; }
    for (let k = 0; k < w.chars.length; k++) {
      if (w.chars[k] !== g.chars[k]) { diffs.push(`P${i} char ${k} ${JSON.stringify(w.chars[k][0])}\n  editor ${w.chars[k].slice(1)}\n  doc    ${g.chars[k].slice(1)}`); break; }
    }
  }
  // List labels as the editor draws them and as Docs numbers the document's lists
  const wantLabels = listLabels(shown.map((n) => n.attrs ?? {}));
  const gotLabels = listLabels(after.nodes.map((n) => n.attrs ?? {}));
  for (let i = 0; i < Math.min(wantLabels.length, gotLabels.length); i++) {
    if (wantLabels[i] !== gotLabels[i]) diffs.push(`P${i} list label: editor ${JSON.stringify(wantLabels[i])}, doc ${JSON.stringify(gotLabels[i])}`);
  }
  // Bullet glyphs: the style the editor draws each glyph in (its own, else its first character's) and Docs' bullet style
  const outParas = (out.body?.content ?? []).filter((el) => el.paragraph).map((el) => el.paragraph!);
  shown.forEach((n, i) => {
    const p = outParas[i];
    if (!n.attrs?.list || !p?.bullet) return;
    const style = paragraphFromAttrs(n.attrs).style;
    const first = n.content?.find((c) => c.type === "text");
    const own = n.attrs.glyphStyle as Record<string, unknown> | null | undefined;
    const glyph = own ?? (first ? styleFromMarks((first.marks ?? []).filter((m) => m.type !== PENDING_MARK)) : {});
    // What the editor would draw for the document's bullet: importDoc's reading of Docs' bullet style
    const docGlyph = (after.nodes[i]?.attrs?.glyphStyle as Record<string, unknown> | undefined) ?? {};
    if (filled(glyph, style) !== filled(docGlyph, style)) diffs.push(`P${i} bullet glyph style: editor ${filled(glyph, style)}, doc ${filled(docGlyph, style)}`);
  });
  return diffs;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

const NAMED_RED_H1: docs_v1.Schema$NamedStyle[] = [
  { namedStyleType: "NORMAL_TEXT", textStyle: { fontSize: { magnitude: 12, unit: "PT" }, weightedFontFamily: { fontFamily: "Times New Roman", weight: 400 } }, paragraphStyle: { lineSpacing: 100, namedStyleType: "NORMAL_TEXT" } },
  { namedStyleType: "HEADING_1", textStyle: { fontSize: { magnitude: 24, unit: "PT" }, foregroundColor: { color: { rgbColor: { red: 0.8, green: 0, blue: 0 } } } }, paragraphStyle: { keepWithNext: true, spaceAbove: { magnitude: 24, unit: "PT" }, spaceBelow: { magnitude: 12, unit: "PT" } } },
  { namedStyleType: "HEADING_3", textStyle: { fontSize: { magnitude: 14, unit: "PT" }, foregroundColor: { color: { rgbColor: { red: 0.263, green: 0.263, blue: 0.263 } } } }, paragraphStyle: { keepWithNext: true } },
];

/** A document whose headings keep nothing with the next paragraph */
const NAMED_LOOSE_H2: docs_v1.Schema$NamedStyle[] = [
  { namedStyleType: "HEADING_2", textStyle: { fontSize: { magnitude: 16, unit: "PT" } }, paragraphStyle: { keepWithNext: false, keepLinesTogether: false, spaceAbove: { magnitude: 18, unit: "PT" }, spaceBelow: { magnitude: 6, unit: "PT" } } },
];

const LIST_DOC = [
  { insertText: { location: { index: 1 }, text: "Alpha\nBeta\nEnd" } },
];

export interface Scenario extends SyncCase {
  name: string;
  what: string;
  /** Not yet what the editor shows, and why (each is a limit of the Docs API or needs a live answer) */
  known?: string;
  /** The list labels Docs shows for this content, in order: the editor's must be these (the doc's then match them) */
  labels?: string[];
  /** The sizes Docs draws this content's empty lines in, in order: the editor's must be these */
  newlines?: number[];
}

/** The size each empty line is drawn in, in order: its newline's own, else its style's */
export const newlineSizesOf = (nodes: EditorNode[]): number[] => nodes.filter((n) => n.type === "paragraph" && !n.content?.length).map((n) => {
  const size = ((n.attrs?.nl as { type: string; attrs?: { fontSize?: unknown } }[] | undefined) ?? []).find((m) => m.type === "textStyle")?.attrs?.fontSize;
  return typeof size === "number" ? size : NAMED_STYLES[(n.attrs?.styleName as keyof typeof NAMED_STYLES) ?? "normal"]?.size ?? 11;
});

/** The labels the editor draws for its list items, in order */
export const labelsOf = (nodes: EditorNode[]): string[] =>
  listLabels(nodes.filter((n) => n.type === "paragraph").map((n) => n.attrs ?? {})).filter((l): l is string => l != null);

export const SCENARIOS: Scenario[] = [
  {
    name: "heading-then-list",
    what: "a heading with its own spacing, then list items and a paragraph with none",
    target: () => [H1("Quarterly plan overview"), LI(0, "bullet", "First item of the list"), LI(1, "bullet", "Nested item text here"), LI(0, "bullet", "Third item"), P({}, "A closing paragraph with no box")],
  },
  {
    name: "empty-after-heading",
    what: "an empty paragraph after a 20pt heading",
    target: () => [H1("Big heading"), EMPTY(), P({ box: box0 }, "Body text after the blank line"), EMPTY(), P({ box: box0 }, "End")],
  },
  {
    name: "mixed-ol-ul",
    what: "numbered level 0 with bullet sub-items",
    known: "a list style is all numbers or all bullets, so the sub-items become a bulleted list of their own; Docs starts a list at level 0, so they sit where level 1 does with level 0's glyph (● for ○; live recipe Q5)",
    target: () => [LI(0, "ordered", "Step one of the process"), LI(1, "bullet", "detail a here"), LI(1, "bullet", "detail b here"), LI(0, "ordered", "Step two of the process")],
  },
  {
    name: "list-starts-nested",
    what: "a pasted fragment whose first item is at level 1",
    target: () => [LI(1, "bullet", "Nested first item"), LI(2, "bullet", "Deeper item"), LI(0, "bullet", "Top item")],
  },
  {
    name: "solo-nested-item",
    what: "one level-2 item on its own, as a copy from inside a nested list gives (the reference document's partial-b)",
    known: "a bullet made on its own lands at level 0: the item sits where level 2 does, with level 0's glyph (● for ■; live recipe Q4)",
    target: () => [LI(2, "bullet", "price checks, content monitoring, shopping")],
  },
  {
    name: "all-nested",
    what: "a fragment whose items are all nested (levels 1, 2, 1)",
    known: "tabs nest an item only relative to the others it is created with, so the list starts at level 0: every item sits where its level does, drawn with the glyph of the level above (live recipe Q4)",
    target: () => [LI(1, "bullet", "Nested first item"), LI(2, "bullet", "Deeper item"), LI(1, "bullet", "Nested again")],
  },
  {
    name: "join-existing-list",
    what: "numbered items typed right after an existing numbered list in the same style",
    setup: [...LIST_DOC, { createParagraphBullets: { range: { startIndex: 1, endIndex: 11 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } }],
    target: (base) => [base[0], base[1], LI(0, "ordered", "Gamma"), LI(0, "ordered", "Delta"), base[2]],
  },
  {
    name: "nested-into-existing-list",
    what: "a sub-item added under an item of a list the document already has",
    setup: [...LIST_DOC, { createParagraphBullets: { range: { startIndex: 1, endIndex: 11 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } }],
    known: "a bullet made on its own lands at level 0, in a list of its own: the item sits where its level does, with level 0's glyph (live recipe Q3, Q4)",
    target: (base) => [base[0], base[1], P({ ...base[1].attrs, level: 1, glyph: { type: null, format: null, symbol: "○", start: null } }, "Beta child"), base[2]],
  },
  {
    name: "item-into-custom-glyph-list",
    what: "a level-1 item added to an existing list in another style (❖ ➢ ■)",
    setup: [...LIST_DOC, { createParagraphBullets: { range: { startIndex: 1, endIndex: 11 }, bulletPreset: "BULLET_DIAMONDX_ARROW3D_SQUARE" } }],
    known: "a bullet made on its own lands at level 0, in a list of its own: the item sits where its level does, with level 0's glyph (live recipe Q3, Q4)",
    target: (base) => [base[0], P({ ...base[0].attrs, level: 1, glyph: { type: null, format: null, symbol: "➢", start: null } }, "Alpha child"), base[1], base[2]],
  },
  {
    name: "link-black-plain",
    what: "a link styled black and not underlined",
    target: () => [P({ box: box0 }, "See ", ["the plain link", [ts(11), { type: "link", attrs: { href: "https://example.com/" } }]], " for details.")],
  },
  {
    name: "link-looks",
    what: "a link as Docs makes one (blue, underlined), one in red, and one underlined in grey",
    target: () => [
      P({ box: box0 }, ["Docs link", [ts(11, "#1155cc"), { type: "underline" }, { type: "link", attrs: { href: "https://example.com/a" } }]], " then ", ["red link", [ts(11, "#cc0000"), { type: "link", attrs: { href: "https://example.com/b" } }]]),
      P({ box: box0 }, ["grey underlined", [ts(11, "#666666"), { type: "underline" }, { type: "link", attrs: { href: "https://example.com/c" } }]], " end"),
    ],
  },
  {
    name: "small-caps",
    what: "small caps on part of a paragraph",
    target: () => [P({ box: box0 }, "Normal then ", ["Small Caps Words", [ts(11), { type: "smallCaps" }]], " normal again.")],
  },
  {
    name: "explicit-black-vs-named-colour",
    what: "explicitly black heading text, typed into a doc whose Heading 1 is red and Normal text is Times 12",
    namedStyles: NAMED_RED_H1,
    target: () => [H1("Black heading in source"), P({ styleName: "h3", box: { start: 0, first: 0, above: 16, below: 4 } }, ["Black H3 in source", [ts(14)]]), P({ box: box0 }, "Body text explicitly Arial 11 black")],
  },
  {
    name: "soft-break-in-list",
    what: "a list item with a line break inside it, pasted: the line after it a paragraph where the item's text starts",
    target: () => asPasted([LI(0, "bullet", "Line one of the item", BR, "line two of the same item"), LI(0, "bullet", "Next item")]),
  },
  {
    name: "soft-break-in-paragraph",
    what: "a paragraph indented its own way, with a first-line indent and space above and below, and two line breaks, pasted",
    target: () => asPasted([P({ box: { start: 36, first: 18, above: 10, below: 12 } }, "First line", BR, "second line", BR, "third line"), P({ box: box0 }, "After")]),
  },
  {
    name: "soft-break-in-heading",
    what: "a Heading 2 (18pt above, 6pt below by its style) with a line break, pasted",
    target: () => asPasted([P({ styleName: "h2" }, ["Heading line one", [ts(16)]], BR, ["line two", [ts(16)]]), P({ box: box0 }, "Body")]),
  },
  {
    name: "soft-break-spaced-items",
    what: "items with 6pt above and below that leave it out next to each other, then ones that keep it, each first one with a line break, pasted",
    target: () => asPasted([
      P({ list: "bullet", level: 0, box: { start: 36, marker: -18, above: 6, below: 6 } }, "Tight one", BR, "its second line"),
      P({ list: "bullet", level: 0, box: { start: 36, marker: -18, above: 6, below: 6 } }, "Tight two"),
      P({ box: box0 }, "Between"),
      P({ list: "ordered", level: 0, box: { start: 36, marker: -18, above: 6, below: 6 }, spacingMode: "NEVER_COLLAPSE" }, "Spaced one", BR, "its second line"),
      P({ list: "ordered", level: 0, box: { start: 36, marker: -18, above: 6, below: 6 }, spacingMode: "NEVER_COLLAPSE" }, "Spaced two"),
    ]),
  },
  {
    name: "empty-lines-after-formatted-text",
    what: "empty lines after text in a size and weight of its own: each as tall as the editor draws it (Docs gives typed text the look of the text before it)",
    target: () => asAdded([P({}, ["Big bold words", [ts(20), { type: "bold" }]]), EMPTY(), P({}, "Normal words"), EMPTY(), P({}, ["Small words", [ts(8)]]), EMPTY(), EMPTY()]),
  },
  {
    name: "empty-lines-own-size",
    what: "a copy from Docs with empty lines in sizes of their own (15pt, 6pt) between 11pt text: each as tall in the doc as in the copy",
    target: (base) => asAdded(pasteSlice(docsCopy([{ text: "Some words" }, { text: "", size: 15 }, { text: "Big words", size: 15 }, { text: "", size: 6 }, { text: "More words" }, { text: "" }]), base)),
    newlines: [15, 6, 11, 11],
  },
  {
    name: "list-across-paragraphs",
    what: "questions numbered by one Docs list with answers between them, copied from Docs and pasted: 1., 2., 3. as Docs pastes it",
    target: (base) => asAdded(pasteSlice(docsCopy([{ text: "Question one", level: 0 }, { text: "Its answer" }, { text: "Question two", level: 0 }, { text: "A sub-point", level: 1 }, { text: "An answer" }, { text: "" }, { text: "More of it" }, { text: "Question three", level: 0 }, { text: "After the list" }]), base)),
    labels: ["1.", "2.", "a.", "3."],
  },
  {
    name: "list-across-tabbed-answers",
    what: "answers between numbered questions that start with tabs: they keep them (Docs takes a paragraph's leading tabs when it bullets it), and the questions count on",
    target: (base) => asAdded(pasteSlice(docsCopy([{ text: "Question one here", level: 0 }, { text: "\tIndented answer" }, { text: "Question two here", level: 0 }, { text: "\t\tTwice indented" }, { text: "Question three", level: 0 }, { text: "After" }]), base)),
    labels: ["1.", "2.", "3."],
  },
  {
    name: "list-item-short-line-break",
    what: "a short numbered item with a line break, its line typed with it in one write: the items after it count on",
    target: () => asPasted([LI(0, "ordered", "One", { type: "hardBreak" }, "x"), LI(0, "ordered", "Two"), LI(0, "ordered", "Three")]),
    labels: ["1.", "2.", "3."],
  },
  {
    name: "list-custom-indent-space",
    what: "list items with their own indent (54pt) and 6pt above and below",
    target: () => [P({ list: "bullet", level: 0, box: { start: 54, marker: -18, above: 6, below: 6 } }, "Indented item with spacing"), P({ list: "bullet", level: 0, box: { start: 54, marker: -18, above: 6, below: 6 } }, "Second indented item")],
  },
  {
    name: "page-break-in-list",
    what: "a page break at the end of a list item, then another item",
    target: () => [LI(0, "bullet", "Item before the break", { type: "pageBreak" } as EditorNode), LI(0, "bullet", "Item after the break")],
  },
  {
    name: "list-blank-para",
    what: "a list, an empty line, then a paragraph (one write opens two paragraphs)",
    target: () => [LI(0, "bullet", "First item"), LI(0, "bullet", "Second item here"), EMPTY({ box: box0 }), P({ box: box0 }, "Paragraph after the blank line")],
  },
  {
    name: "title-blank-body",
    what: "a centred title, an empty line, then body text",
    target: () => [P({ styleName: "title", textAlign: "center", box: { start: 0, first: 0, above: 0, below: 3 } }, ["Centered Title", [ts(26)]]), EMPTY({ box: box0 }), P({ box: box0 }, "Body text that follows the title")],
  },
  {
    name: "keep-options",
    what: "keep options: a heading made here (its style's: kept with the next), a heading that keeps nothing, a paragraph kept with the next",
    target: () => [
      H1("Heading made here"),
      P({ styleName: "h1", box: { start: 0, first: 0, above: 20, below: 6 }, keep: {} }, ["Heading that keeps nothing", [ts(20)]]),
      P({ box: box0, keep: { withNext: true, singleLines: false } }, "Kept with the next one"),
      P({ box: box0 }, "Last"),
    ],
  },
  {
    name: "keep-from-the-doc",
    what: "a heading made here, typed into a doc whose Heading 2 keeps nothing",
    namedStyles: NAMED_LOOSE_H2,
    target: () => [P({ styleName: "h2", box: { start: 0, first: 0, above: 18, below: 6 } }, ["Loose heading", [ts(16)]]), P({ box: box0 }, "Body")],
  },
  {
    name: "list-spacing-modes",
    what: "list items with space after: ones that leave it out next to each other (Docs' default), ones that keep it, and ones with the document's mode",
    target: () => [
      P({ list: "bullet", level: 0, box: { start: 36, marker: -18, above: 0, below: 12 }, spacingMode: "COLLAPSE_LISTS" }, "Tight item one"),
      P({ list: "bullet", level: 0, box: { start: 36, marker: -18, above: 0, below: 12 }, spacingMode: "COLLAPSE_LISTS" }, "Tight item two"),
      P({ box: box0 }, "Between the lists"),
      P({ list: "ordered", level: 0, box: { start: 36, marker: -18, above: 0, below: 12 }, spacingMode: "NEVER_COLLAPSE" }, "Spaced item one"),
      P({ list: "ordered", level: 0, box: { start: 36, marker: -18, above: 0, below: 12 }, spacingMode: "NEVER_COLLAPSE" }, "Spaced item two"),
      P({ box: box0 }, "Between again"),
      P({ list: "bullet", level: 0, box: { start: 36, marker: -18, above: 0, below: 12 } }, "The document's mode"),
    ],
  },
  {
    name: "framed-then-plain",
    what: "a paragraph with a right indent, borders and shading, then plain ones typed after it (each newline copies the paragraph it is typed in)",
    target: () => [
      P({ box: box0, indentEnd: 36, shading: "#fce5cd", borders: { top: { width: 1, color: "#000000", dash: "SOLID", padding: 1 }, bottom: { width: 1, color: "#000000", dash: "SOLID", padding: 1 } } }, "A framed note"),
      P({ box: box0 }, "Plain after it"),
      P({ box: box0 }, "And another"),
    ],
  },
  {
    name: "right-to-left",
    what: "right-to-left paragraphs aligned to their start, their end and the center, one indented from its start and a bulleted one, then left-to-right text after them",
    target: () => [
      P({ dir: "rtl", box: box0 }, "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645"),
      P({ dir: "rtl", textAlign: "left", box: box0 }, "\u0646\u0635 \u0641\u064a \u0627\u0644\u064a\u0633\u0627\u0631"),
      P({ dir: "rtl", textAlign: "center", box: box0 }, "\u0641\u064a \u0627\u0644\u0648\u0633\u0637"),
      P({ dir: "rtl", box: { start: 36, first: 0, above: 0, below: 0 }, indentEnd: 18 }, "\u0645\u0632\u0627\u062d \u0645\u0646 \u0627\u0644\u064a\u0645\u064a\u0646"),
      P({ dir: "rtl", list: "bullet", level: 0 }, "\u0628\u0646\u062f"),
      P({ box: box0 }, "Left to right again"),
    ],
  },
  {
    name: "highlighted-bullets",
    what: "list items whose whole text is highlighted, long and short",
    target: () => [LI(0, "bullet", ["Industry subsegment value proposition", [ts(11), hl("rgb(217, 234, 211)")]]), LI(0, "bullet", ["Market size", [ts(11), hl("rgb(217, 234, 211)")]]), LI(0, "bullet", ["Big text list item with many words", [ts(14)]]), LI(0, "bullet", ["Big two", [ts(14)]])],
  },
];
