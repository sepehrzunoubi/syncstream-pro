/**
 * Fuzzing the autosave against the strict Docs stub.
 *
 * A document is made in the stub as people make one in Docs (headings, lists nested by tabs, tables
 * with text, links and colours, page breaks, footnotes, images, empty lines), read as the editor reads
 * it, and edited with the editor's own transactions and plugins: typing (glowing additions, and text
 * that comes back as it was, as undo and moves put it), formatting, deleting, Enter and Backspace,
 * headings, lists and levels, alignment, tables and their rows and columns, pastes, page breaks,
 * footnotes and images. It is saved as the autosave saves it (use-autosave.ts), round by round until
 * nothing is left, sometimes between the edits too.
 *
 * What must hold: Docs takes every save (the strict stub refuses what Docs refuses, and a refused save
 * means every later save of that document fails), the saves come to an end, what the autosave believes
 * it saved is what Docs has, and the document then reads as the page shows it. Additions are a sync's
 * to type: they are typed in as a sync types them (plain text where additions() puts it) before the
 * text is compared, and only what the autosave saves (paragraphs with nothing glowing) is compared for
 * paragraph style, lists and the look of each character.
 *
 * A scenario is data: each block of the starting document and each edit has a seed of its own, so a
 * failing scenario can be made smaller by leaving blocks and edits out (minimize) and replayed exactly.
 */
import { getAttributesFromExtensions, getSchema, resolveExtensions } from "@tiptap/core";
import { createTable } from "@tiptap/extension-table";
import { joinBackward, joinForward, selectNodeBackward, selectNodeForward } from "@tiptap/pm/commands";
import { Fragment, Slice, type Mark, type Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, EditorState, Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, cellAround, CellSelection, deleteCellSelection, deleteColumn, deleteRow, deleteTable, inSameTable, tableEditing } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import type { docs_v1 } from "googleapis";
import { DocSync, LOAD_META } from "../../src/components/workspace/doc-sync";
import { editorExtensions } from "../../src/components/workspace/extensions";
import { lookForNewLinks } from "../../src/components/workspace/link-look";
import { deleteParts, editableParts } from "../../src/components/workspace/locked-edits";
import { insertParagraphs } from "../../src/components/workspace/paste";
import { tableLinesPlugin } from "../../src/components/workspace/table-lines";
import { importDoc, namedStyleText, type DocDefaults } from "../../src/lib/doc-import";
import { additions, adoptStructure, directEdits, groupColumns, hasPending, PENDING_MARK, signature } from "../../src/lib/doc-model";
import { EDIT_REQUESTS } from "../../src/lib/docs-requests";
import { listRuns, type ListParagraph } from "../../src/lib/list-labels";
import { createRng, type Rng } from "../../src/lib/prng";
import { effectiveIndent, OBJ, PAGE_BREAK, paragraphFromAttrs, resolveTextStyle, styleFromMarks, textRequest, type EditorNode } from "../../src/lib/rich-text";
import { STRICT } from "./fidelity";
import { createStrictStubDocs } from "./strict-stub";

export const schema = getSchema(editorExtensions);
type Docs = ReturnType<typeof createStrictStubDocs>;

// ── Scenarios ───────────────────────────────────────────────────────────────

export type BlockKind = "para" | "heading" | "tabbed" | "list" | "table" | "pagebreak" | "footnote" | "image" | "empty";
export type OpKind =
  | "type" | "typeDirect" | "capitalize" | "format" | "deleteInline" | "deleteAcross" | "selectAllDelete" | "deleteTable" | "clearCells"
  | "enter" | "join" | "heading" | "list" | "indent" | "align" | "insertTable" | "rowCol" | "paste" | "pageBreak" | "footnote" | "image";

export interface Scenario {
  blocks: { kind: BlockKind; seed: number }[];
  /** The last block's paragraph takes in the final empty one (the document ends with text) */
  endsWithText: boolean;
  /** Each edit, and whether the autosave runs right after it (it always runs after the last) */
  ops: { kind: OpKind; seed: number; save: boolean }[];
}

const BLOCK_WEIGHTS: [BlockKind, number][] = [["para", 6], ["heading", 3], ["tabbed", 1], ["list", 4], ["table", 3], ["pagebreak", 1], ["footnote", 1], ["image", 1], ["empty", 2]];
const OP_WEIGHTS: [OpKind, number][] = [
  ["type", 10], ["typeDirect", 4], ["capitalize", 2], ["format", 7], ["deleteInline", 5], ["deleteAcross", 6], ["selectAllDelete", 1], ["deleteTable", 1], ["clearCells", 2],
  ["enter", 7], ["join", 6], ["heading", 4], ["list", 6], ["indent", 4], ["align", 3], ["insertTable", 4], ["rowCol", 6], ["paste", 6], ["pageBreak", 3], ["footnote", 2], ["image", 2],
];

function weighted<T>(rng: Rng, items: [T, number][]): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let x = rng.next() * total;
  for (const [v, w] of items) { x -= w; if (x < 0) return v; }
  return items[items.length - 1][0];
}

/** The scenario a seed makes: a blank document or one of up to eight blocks, then one to eight edits */
export function scenarioOf(seed: number): Scenario {
  const rng = createRng(seed);
  const blank = rng.next() < 0.15;
  const blocks = blank ? [] : Array.from({ length: rng.int(1, 8) }, () => ({ kind: weighted(rng, BLOCK_WEIGHTS), seed: rng.int(0, 2 ** 31) }));
  const endsWithText = rng.next() < 0.4;
  const ops = Array.from({ length: rng.int(1, 8) }, () => ({ kind: weighted(rng, OP_WEIGHTS), seed: rng.int(0, 2 ** 31), save: rng.next() < 0.3 }));
  return { blocks, endsWithText, ops };
}

// ── The starting document, made in the stub ─────────────────────────────────

const WORDS = ["alpha", "beta", "gamma", "delta", "echo", "fox", "golf", "hotel", "ink", "jam", "kilo", "lima"];
const phrase = (d: Rng) => Array.from({ length: d.int(1, 3) }, () => d.pick(WORDS)).join(" ");
const HEADINGS = ["HEADING_1", "HEADING_2", "HEADING_3", "TITLE"];
const PRESETS = ["BULLET_DISC_CIRCLE_SQUARE", "NUMBERED_DECIMAL_ALPHA_ROMAN", "BULLET_CHECKBOX", "NUMBERED_UPPERALPHA_ALPHA_ROMAN"];
const rgbOf = (hex: string) => ({ color: { rgbColor: { red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 } } });

/** Character styles set on parts of [from, to), as Docs' toolbar sets them */
function textStyles(d: Rng, from: number, to: number): object[] {
  const out: object[] = [];
  if (to <= from) return out;
  for (let k = d.int(0, 2); k > 0; k--) {
    const a = d.int(from, to - 1);
    const b = d.int(a + 1, to);
    const range = { startIndex: a, endIndex: b };
    const pick = d.int(0, 7);
    const [textStyle, fields]: [object, string] =
      pick === 0 ? [{ bold: true }, "bold"]
        : pick === 1 ? [{ italic: true }, "italic"]
          : pick === 2 ? [{ underline: true }, "underline"]
            : pick === 3 ? [{ link: { url: `https://example.com/${d.pick(WORDS)}` } }, "link"]
              : pick === 4 ? [{ foregroundColor: rgbOf(d.pick(["#cc0000", "#38761d", "#1155cc"])) }, "foregroundColor"]
                : pick === 5 ? [{ backgroundColor: rgbOf("#ffff00") }, "backgroundColor"]
                  : pick === 6 ? [{ fontSize: { magnitude: d.pick([9, 14, 18]), unit: "PT" } }, "fontSize"]
                    : [{ weightedFontFamily: { fontFamily: "Georgia", weight: 400 } }, "weightedFontFamily"];
    out.push({ updateTextStyle: { range, textStyle, fields } });
  }
  return out;
}

const bodyEnd = (doc: docs_v1.Schema$Document) => { const c = doc.body?.content ?? []; return c[c.length - 1]?.endIndex ?? 2; };
const ins = (index: number, text: string) => ({ insertText: { location: { index }, text } });

/** Indices of the characters of the body's text paragraphs (not in tables) */
function textIndices(doc: docs_v1.Schema$Document): number[] {
  const out: number[] = [];
  for (const el of doc.body?.content ?? []) for (const pe of el.paragraph?.elements ?? []) {
    const t = pe.textRun?.content ?? "";
    for (let k = 0; k < t.length; k++) if (t[k] !== "\n") out.push((pe.startIndex ?? 0) + k);
  }
  return out;
}

/** One block added at the end of the document, before its final (empty) paragraph */
async function appendBlock(docs: Docs, id: string, block: Scenario["blocks"][number]): Promise<void> {
  const d = createRng(block.seed);
  const doc = await docs.get(id);
  const e = bodyEnd(doc) - 1;
  const reqs: object[] = [];
  switch (block.kind) {
    case "para": case "heading": case "tabbed": {
      const text = (block.kind === "tabbed" ? "\t" : "") + phrase(d);
      reqs.push(ins(e, `${text}\n`));
      if (block.kind === "heading") reqs.push({ updateParagraphStyle: { range: { startIndex: e, endIndex: e + text.length + 1 }, paragraphStyle: { namedStyleType: d.pick(HEADINGS) }, fields: "namedStyleType" } });
      if (d.next() < 0.25) reqs.push({ updateParagraphStyle: { range: { startIndex: e, endIndex: e + text.length + 1 }, paragraphStyle: { alignment: d.pick(["CENTER", "END", "JUSTIFIED"]) }, fields: "alignment" } });
      reqs.push(...textStyles(d, e, e + text.length));
      break;
    }
    case "list": {
      // Items nested by their leading tabs, which createParagraphBullets turns into levels
      const items: string[] = [];
      let level = 0;
      for (let k = d.int(1, 4); k > 0; k--) {
        level = items.length ? d.int(0, Math.min(2, level + 1)) : 0;
        items.push("\t".repeat(level) + phrase(d));
      }
      const text = `${items.join("\n")}\n`;
      reqs.push(ins(e, text));
      reqs.push(...textStyles(d, e, e + text.length - 1));
      reqs.push({ createParagraphBullets: { range: { startIndex: e, endIndex: e + text.length }, bulletPreset: d.pick(PRESETS) } });
      break;
    }
    case "table": {
      const rows = d.int(1, 3);
      const columns = d.int(1, 3);
      await docs.batchUpdate(id, [{ insertTable: { rows, columns, location: { index: e } } }] as never);
      const now = await docs.get(id);
      const table = (now.body?.content ?? []).find((el) => el.table && el.startIndex === e + 1);
      const starts = (table?.table?.tableRows ?? []).flatMap((r) => (r.tableCells ?? []).map((c) => c.content?.[0]?.startIndex ?? 0));
      for (const at of starts.reverse()) {
        if (d.next() < 0.25) continue;
        const text = phrase(d);
        reqs.push(ins(at, text), ...(d.next() < 0.3 ? [{ updateTextStyle: { range: { startIndex: at, endIndex: at + text.length }, textStyle: { bold: true }, fields: "bold" } }] : []));
      }
      break;
    }
    case "pagebreak": {
      // Ctrl+Enter in Docs: the break ends a line of text (or an empty one), the next line follows it
      const text = d.next() < 0.7 ? phrase(d) : "";
      if (text) reqs.push(ins(e, `${text}\n`));
      reqs.push({ insertPageBreak: { location: { index: e + text.length } } });
      break;
    }
    case "footnote": case "image": {
      let at = textIndices(doc);
      if (!at.length) {
        const text = phrase(d);
        await docs.batchUpdate(id, [ins(e, `${text}\n`)] as never);
        at = Array.from({ length: text.length }, (_, k) => e + k);
      }
      const index = d.pick(at) + (d.next() < 0.5 ? 1 : 0);
      if (block.kind === "footnote") reqs.push({ createFootnote: { location: { index } } });
      else reqs.push({ insertInlineImage: { location: { index }, uri: `https://example.com/img/${block.seed}.png`, objectSize: { width: { magnitude: 40, unit: "PT" }, height: { magnitude: 30, unit: "PT" } } } });
      break;
    }
    case "empty":
      reqs.push(ins(e, "\n"));
      break;
  }
  if (reqs.length) await docs.batchUpdate(id, reqs as never);
}

/** The scenario's starting document in the stub: its blocks, then (maybe) its last line takes in the final empty one */
async function makeStart(docs: Docs, id: string, s: Scenario): Promise<void> {
  for (const b of s.blocks) await appendBlock(docs, id, b);
  if (!s.endsWithText) return;
  const doc = await docs.get(id);
  const content = doc.body?.content ?? [];
  const last = content[content.length - 2];
  if (last?.paragraph && content.length > 2) await docs.batchUpdate(id, [{ deleteContentRange: { range: { startIndex: (last.endIndex ?? 0) - 1, endIndex: last.endIndex ?? 0 } } }] as never);
}

// ── The page: the editor's schema and the plugins that shape what an edit leaves ──────────────

/** StarterKit's TrailingNode: the page always ends with a paragraph */
function trailingParagraph(): Plugin {
  return new Plugin({
    appendTransaction: (trs, _old, state) => (trs.some((tr) => tr.docChanged) && state.doc.lastChild?.type.name !== "paragraph" ? state.tr.insert(state.doc.content.size, schema.nodes.paragraph.create()) : null),
  });
}

/** DocSync's plugins (what's typed or pasted glows, locked content stays), as the editor has them */
const docSyncPlugins = () => (DocSync.config.addProseMirrorPlugins as unknown as (this: unknown) => Plugin[]).call({ name: "docSync", options: {}, storage: {}, editor: null, parent: undefined });

type CommandProps = { tr: Transaction; state: EditorState; dispatch?: (tr: Transaction) => void };
type Commands = Record<string, (...args: unknown[]) => (props: CommandProps) => boolean>;
/** The editor's own paragraph commands (toggleList, indent, outdent, insertPageBreak, setCapitalization) */
const formatCommands = (editorExtensions.find((e) => e.name === "docFormat")!.config.addCommands as unknown as (this: unknown) => Commands).call({ name: "docFormat", options: {}, storage: {}, editor: null, parent: undefined });
/** Attributes a paragraph split at its end leaves behind (keepOnSplit: false), as TipTap's splitBlock does */
const NOT_KEPT_ON_SPLIT = new Set(getAttributesFromExtensions(resolveExtensions(editorExtensions as never)).filter((a) => a.type === "paragraph" && a.attribute.keepOnSplit === false).map((a) => a.name));
/** extensions.ts' NO_LIST: what leaving a list resets */
const NO_LIST = { list: null, listId: null, level: null, glyph: null, preset: null, box: null, listCont: null, softBreak: null };

export class Page {
  state: EditorState;
  constructor(doc: EditorNode) {
    this.state = EditorState.create({ schema, plugins: [...docSyncPlugins(), new Plugin({ appendTransaction: (trs, _o, s) => lookForNewLinks(trs, s) }), tableEditing(), tableLinesPlugin(), trailingParagraph()] });
    this.load(doc);
  }
  /** As loadDocument does: the editor's content replaced, not an addition */
  load(doc: EditorNode) {
    const node = schema.nodeFromJSON(doc);
    this.apply(this.state.tr.replaceWith(0, this.state.doc.content.size, node.content).setMeta(LOAD_META, true).setMeta("addToHistory", false));
  }
  apply(tr: Transaction) { this.state = this.state.applyTransaction(tr).state; }
  run(command: (props: CommandProps) => boolean): boolean { const tr = this.state.tr; return command({ tr, state: this.state, dispatch: (t) => this.apply(t) }); }
  runPM(command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean): boolean { return command(this.state, (t) => this.apply(t)); }
  /**
   * A selection as the editor can make one. A drag, a Shift+click or Shift+arrow from one table cell into
   * another makes prosemirror-tables select the cells (a CellSelection), never text from one to the
   * other; and one ending in a cell of another table selects only the cell it started in. False then.
   */
  select(from: number, to = from): boolean {
    const doc = this.state.doc;
    const a = cellAround(doc.resolve(from));
    const b = cellAround(doc.resolve(to));
    if (a && b && a.pos !== b.pos) {
      if (!inSameTable(a, b)) return false;
      this.apply(this.state.tr.setSelection(new CellSelection(a, b)));
      return true;
    }
    this.apply(this.state.tr.setSelection(TextSelection.create(doc, from, to)));
    return true;
  }
  get doc() { return this.state.doc; }
  get json(): EditorNode { return this.state.doc.toJSON() as EditorNode; }
  /** An editor view for paste.ts, which reads the state and dispatches */
  view(): EditorView {
    const state = () => this.state;
    return { get state() { return state(); }, dispatch: (tr: Transaction) => this.apply(tr) } as unknown as EditorView;
  }
}

// ── Edits ───────────────────────────────────────────────────────────────────

interface Para { pos: number; node: PMNode; cell: boolean }
function paragraphs(doc: PMNode, where: "any" | "body" | "cell" = "any"): Para[] {
  const out: Para[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "paragraph") return true;
    const cell = parent?.type.name === "tableCell" || parent?.type.name === "tableHeader";
    if (!node.attrs.locked && (where === "any" || (where === "cell") === cell)) out.push({ pos, node, cell });
    return false;
  });
  return out;
}
function caret(d: Rng, doc: PMNode, where: "any" | "body" | "cell" = "any"): number | null {
  const ps = paragraphs(doc, where);
  if (!ps.length) return null;
  const p = d.pick(ps);
  return p.pos + 1 + d.int(0, p.node.content.size);
}
function tablesIn(doc: PMNode): { pos: number; node: PMNode }[] {
  const out: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => { if (node.type.name === "table") out.push({ pos, node }); return node.type.name !== "paragraph"; });
  return out;
}

/** A mark of the toolbar's */
function randomMark(d: Rng): Mark {
  const m = schema.marks;
  switch (d.int(0, 8)) {
    case 0: return m.bold.create();
    case 1: return m.italic.create();
    case 2: return m.underline.create();
    case 3: return m.strike.create();
    case 4: return m.link.create({ href: `https://example.com/${d.pick(WORDS)}` });
    case 5: return m.textStyle.create({ color: d.pick(["#cc0000", "#38761d", "#000000"]) });
    case 6: return m.textStyle.create({ fontSize: d.pick([9, 14, 24]) });
    case 7: return m.highlight.create({ color: d.pick(["#ffff00", "#00ffff"]) });
    default: return m.superscript.create();
  }
}

/** A mark set as TipTap's setMark sets it: a textStyle's attributes go onto the ones the text has */
function setMark(tr: Transaction, from: number, to: number, mark: Mark) {
  if (mark.type !== schema.marks.textStyle) { tr.addMark(from, to, mark); return; }
  const pieces: [number, number, Record<string, unknown>][] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const own = node.marks.find((x) => x.type === mark.type)?.attrs ?? {};
    pieces.push([Math.max(pos, from), Math.min(pos + node.nodeSize, to), { ...own, ...mark.attrs }]);
  });
  for (const [a, b, attrs] of pieces) tr.addMark(a, b, mark.type.create(attrs));
}

/** Two carets in order, at least one character apart */
function range(d: Rng, doc: PMNode, across: boolean): [number, number] | null {
  if (!across) {
    const ps = paragraphs(doc).filter((p) => p.node.content.size > 0);
    if (!ps.length) return null;
    const p = d.pick(ps);
    const a = d.int(0, p.node.content.size - 1);
    return [p.pos + 1 + a, p.pos + 1 + d.int(a + 1, p.node.content.size)];
  }
  const ps = paragraphs(doc);
  if (ps.length < 2) return null;
  const i = d.int(0, ps.length - 2);
  const j = d.int(i + 1, Math.min(ps.length - 1, i + 4));
  return [ps[i].pos + 1 + d.int(0, ps[i].node.content.size), ps[j].pos + 1 + d.int(0, ps[j].node.content.size)];
}

/** Paragraphs a selection [from, to] touches, as updateAttributes finds them */
function eachParagraph(tr: Transaction, from: number, to: number, fn: (attrs: Record<string, unknown>) => Record<string, unknown>) {
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "paragraph" && !node.attrs.locked) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...fn(node.attrs) });
  });
}

/** A selection to act on: a caret (most often) or a range, within a paragraph or across a few */
function selection(d: Rng, doc: PMNode): [number, number] | null {
  const r = d.next() < 0.5 ? null : range(d, doc, d.next() < 0.5);
  if (r) return r;
  const at = caret(d, doc);
  return at == null ? null : [at, at];
}

/**
 * Backspace or Delete with this selection, as the editor has them: selected cells are cleared, a
 * selection reaching into a table from outside deletes the text around the table (DocSync's
 * deleteAcrossLocked); otherwise ProseMirror's deletion. Edit > Delete (TipTap's deleteSelection) is
 * ProseMirror's deletion whatever the selection spans.
 */
function deleteSelected(page: Page, menu = false) {
  if (page.state.selection instanceof CellSelection) { page.runPM(deleteCellSelection); return; }
  const parts = menu ? null : editableParts(page.state);
  if (parts?.length) { const tr = page.state.tr; deleteParts(tr, parts); page.apply(tr); return; }
  page.apply(page.state.tr.deleteSelection());
}

/** Paragraphs and maybe a table, as a copy brings them: text with marks, a heading or list item now and then */
function pastedNodes(d: Rng, inCell: boolean): PMNode[] {
  const para = (): EditorNode => {
    const attrs: Record<string, unknown> = {};
    const kind = d.int(0, 5);
    if (kind === 0) attrs.styleName = d.pick(["h1", "h2", "title"]);
    if (kind === 1) Object.assign(attrs, { list: d.pick(["bullet", "ordered"]), level: d.int(0, 1) });
    const text = d.next() < 0.15 ? "" : phrase(d);
    const marks = d.next() < 0.3 ? [randomMark(d).toJSON()] : [];
    return { type: "paragraph", attrs, content: text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : [] };
  };
  const nodes: EditorNode[] = Array.from({ length: d.int(1, 3) }, para);
  if (!inCell && nodes.length > 1 && d.next() < 0.4) {
    const cell = (): EditorNode => ({ type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: d.next() < 0.7 ? [{ type: "text", text: d.pick(WORDS) }] : [] }] });
    const rows = d.int(1, 2);
    const columns = d.int(1, 3);
    nodes.splice(1, 0, { type: "table", content: Array.from({ length: rows }, () => ({ type: "tableRow", content: Array.from({ length: columns }, cell) })) });
  }
  return nodes.map((n) => schema.nodeFromJSON(n));
}

/** One edit on the page; a short account of it, or null when it had nothing to act on */
export function applyOp(page: Page, kind: OpKind, seed: number, defaults: DocDefaults): string | null {
  const d = createRng(seed);
  const doc = page.doc;
  const m = schema.marks;
  switch (kind) {
    case "type": {
      // Typed text: it takes the marks where it goes (and maybe one more); DocSync makes it glow
      const at = caret(d, doc);
      if (at == null) return null;
      const text = (d.next() < 0.3 ? " " : "") + phrase(d);
      const tr = page.state.tr.insertText(text, at);
      let extra = "";
      if (d.next() < 0.3) { const mark = randomMark(d); setMark(tr, at, at + text.length, mark); extra = ` +${mark.type.name}`; }
      page.apply(tr);
      return `type ${JSON.stringify(text)} at ${at}${extra}`;
    }
    case "typeDirect": {
      // Text that comes back as it was (undo of a deletion, text moved within the page): not an addition
      const at = caret(d, doc);
      if (at == null) return null;
      const $at = doc.resolve(at);
      const marks = $at.marks().filter((x) => x.type.name !== PENDING_MARK);
      const pick = d.int(0, 9);
      const inBody = !paragraphs(doc).find((p) => at > p.pos && at <= p.pos + p.node.nodeSize - 1)?.cell;
      const node = pick === 0 && inBody ? schema.nodes.pageBreak.create() : pick === 1 ? schema.nodes.image.create({ src: `https://example.com/back/${d.int(1, 99)}.png`, width: 40, height: 30 }) : schema.text(phrase(d), d.next() < 0.3 ? [...marks, randomMark(d)] : marks);
      page.apply(page.state.tr.insert(at, node).setMeta("ssDirect", true));
      return `put back ${node.isText ? JSON.stringify(node.text) : node.type.name} at ${at}`;
    }
    case "capitalize": {
      const r = range(d, doc, d.next() < 0.3);
      if (!r) return null;
      if (!page.select(r[0], r[1])) return null;
      const mode = d.pick(["upper", "lower", "title"]);
      return page.run(formatCommands.setCapitalization(mode)) ? `capitalize ${mode} ${r[0]}-${r[1]}` : null;
    }
    case "format": {
      const r = range(d, doc, d.next() < 0.4);
      if (!r) return null;
      const [a, b] = r;
      const tr = page.state.tr;
      const mark = randomMark(d);
      const remove = d.next() < 0.3;
      if (remove) tr.removeMark(a, b, mark.type === m.textStyle && d.next() < 0.5 ? undefined : mark.type);
      else setMark(tr, a, b, mark);
      page.apply(tr);
      return `${remove ? "unset" : "set"} ${mark.type.name}${mark.attrs && Object.keys(mark.attrs).length ? JSON.stringify(mark.attrs) : ""} ${a}-${b}`;
    }
    case "deleteInline": case "deleteAcross": {
      const r = range(d, doc, kind === "deleteAcross");
      if (!r || !page.select(r[0], r[1])) return null;
      const menu = d.next() < 0.25;
      deleteSelected(page, menu);
      return `${menu ? "Edit > Delete" : "Backspace"} ${r[0]}-${r[1]}`;
    }
    case "selectAllDelete":
      page.apply(page.state.tr.setSelection(new AllSelection(page.doc)));
      page.apply(page.state.tr.deleteSelection());
      return "select all, delete";
    case "deleteTable": {
      const at = caret(d, doc, "cell");
      if (at == null) return null;
      page.select(at);
      return page.runPM(deleteTable) ? `delete the table at ${at}` : null;
    }
    case "clearCells": {
      const tables = tablesIn(doc);
      if (!tables.length) return null;
      const t = d.pick(tables);
      const cells: number[] = [];
      t.node.descendants((n, p) => { if (n.type.name === "tableCell" || n.type.name === "tableHeader") cells.push(t.pos + 1 + p); return n.type.name === "tableRow"; });
      const a = d.pick(cells);
      const b = d.pick(cells);
      page.apply(page.state.tr.setSelection(CellSelection.create(page.doc, a, b)));
      page.runPM(deleteCellSelection);
      return `clear cells ${a}-${b}`;
    }
    case "enter": {
      // Enter as the editor has it: an empty list item leaves its list; at the end of a heading the new
      // line is Normal text; otherwise TipTap's splitBlock
      const at = caret(d, doc);
      if (at == null) return null;
      page.select(at);
      const $at = page.doc.resolve(at);
      const parent = $at.parent;
      if (parent.attrs.list && parent.content.size === 0) {
        page.apply(page.state.tr.setNodeMarkup($at.before(), undefined, { ...parent.attrs, ...NO_LIST }));
        return `Enter in the empty list item at ${at}`;
      }
      const atEnd = $at.parentOffset === parent.content.size;
      const kept = Object.fromEntries(Object.entries(parent.attrs).filter(([k]) => !NOT_KEPT_ON_SPLIT.has(k)));
      const toNormal = atEnd && parent.attrs.styleName !== "normal" && !parent.attrs.list && parent.content.size > 0;
      const tr = page.state.tr.split(at, 1, atEnd ? [{ type: schema.nodes.paragraph, attrs: toNormal ? { ...kept, styleName: "normal" } : kept }] : undefined);
      const marks = page.state.storedMarks ?? $at.marks();
      if (marks.length) tr.ensureMarks(marks);
      page.apply(tr);
      return `Enter at ${at}`;
    }
    case "join": {
      const ps = paragraphs(doc);
      if (!ps.length) return null;
      const p = d.pick(ps);
      if (d.next() < 0.6) {
        // Backspace at the start: a list item outdents, then loses its bullet (DocFormat); else joinBackward
        page.select(p.pos + 1);
        if (p.node.attrs.list) {
          const level = (p.node.attrs.level as number | null) ?? 0;
          if (level > 0) page.run(formatCommands.outdent());
          else page.apply(page.state.tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, ...NO_LIST }));
          return `Backspace at the start of the list item at ${p.pos}`;
        }
        if (!page.runPM(joinBackward) && page.runPM(selectNodeBackward) && d.next() < 0.5) deleteSelected(page);
        return `Backspace at ${p.pos + 1}`;
      }
      page.select(p.pos + 1 + p.node.content.size);
      if (!page.runPM(joinForward) && page.runPM(selectNodeForward) && d.next() < 0.5) deleteSelected(page);
      return `Delete at ${p.pos + 1 + p.node.content.size}`;
    }
    case "heading": {
      // setNamedStyle: the style's size shows, so sizes of the text's own go; then the paragraphs' style
      const s = selection(d, doc);
      if (!s) return null;
      if (!page.select(s[0], s[1])) return null;
      const style = d.pick(["normal", "normal", "h1", "h2", "h3", "title", "subtitle"]);
      const tr = page.state.tr;
      const { $from, $to } = page.state.selection;
      const pieces: [number, number, Mark][] = [];
      page.doc.nodesBetween($from.start(), $to.end(), (node, pos) => {
        const mark = node.isText ? node.marks.find((x) => x.type === m.textStyle) : undefined;
        if (mark?.attrs.fontSize) pieces.push([Math.max(pos, $from.start()), Math.min(pos + node.nodeSize, $to.end()), mark]);
      });
      for (const [a, b, mark] of pieces) {
        tr.removeMark(a, b, m.textStyle);
        const rest = { ...mark.attrs, fontSize: null };
        if (Object.values(rest).some((v) => v != null)) tr.addMark(a, b, m.textStyle.create(rest));
      }
      eachParagraph(tr, s[0], s[1], () => ({ styleName: style }));
      page.apply(tr);
      return `style ${style} ${s[0]}-${s[1]}`;
    }
    case "list": {
      const s = selection(d, doc);
      if (!s) return null;
      if (!page.select(s[0], s[1])) return null;
      const type = d.pick(["bullet", "ordered", "check"]);
      const preset = d.next() < 0.3 ? d.pick(type === "ordered" ? ["NUMBERED_DECIMAL_ALPHA_ROMAN", "NUMBERED_UPPERALPHA_ALPHA_ROMAN"] : type === "check" ? ["BULLET_CHECKBOX"] : ["BULLET_DISC_CIRCLE_SQUARE", "BULLET_ARROW_DIAMOND_DISC"]) : undefined;
      page.run(formatCommands.toggleList(type, preset));
      return `toggle ${type}${preset ? ` ${preset}` : ""} list ${s[0]}-${s[1]}`;
    }
    case "indent": {
      const s = selection(d, doc);
      if (!s) return null;
      if (!page.select(s[0], s[1])) return null;
      const how = d.next() < 0.6 ? "indent" : "outdent";
      page.run(formatCommands[how]());
      return `${how} ${s[0]}-${s[1]}`;
    }
    case "align": {
      const s = selection(d, doc);
      if (!s) return null;
      const align = d.pick(["left", "center", "right", "justify"]);
      const tr = page.state.tr;
      eachParagraph(tr, s[0], s[1], () => ({ textAlign: align }));
      page.apply(tr);
      return `align ${align} ${s[0]}-${s[1]}`;
    }
    case "insertTable": {
      // Insert > Table: createTable, put in place of the selection (TipTap's insertTable). One that would
      // land in a table cell is refused by DocSync, so the page stays as it was
      const s = d.next() < 0.8 ? null : range(d, doc, false);
      const at = s ? s[0] : caret(d, doc, "body");
      if (at == null) return null;
      page.select(at, s ? s[1] : at);
      const rows = d.int(1, 3);
      const cols = d.int(1, 3);
      page.apply(page.state.tr.replaceSelectionWith(createTable(schema, rows, cols, false)));
      return `insert a ${rows}x${cols} table at ${at}${s ? `-${s[1]}` : ""}`;
    }
    case "rowCol": {
      const at = caret(d, doc, "cell");
      if (at == null) return null;
      page.select(at);
      const name = d.pick(["addRowBefore", "addRowAfter", "addColumnBefore", "addColumnAfter", "deleteRow", "deleteColumn"] as const);
      const command = { addRowBefore, addRowAfter, addColumnBefore, addColumnAfter, deleteRow, deleteColumn }[name];
      return page.runPM(command) ? `${name} at ${at}` : null;
    }
    case "paste": {
      // A paste in place of a caret or a range: Docs' way (insertParagraphs), else ProseMirror's own
      const s = selection(d, doc);
      if (!s) return null;
      // A paste onto selected cells is prosemirror-tables' own (it fills the cells): not modelled here
      if (!page.select(s[0], s[1]) || page.state.selection instanceof CellSelection) return null;
      const inCell = page.state.selection.$from.depth > 1;
      const nodes = pastedNodes(d, inCell);
      const ends = d.next() < 0.5;
      const what = nodes.map((n) => (n.type.name === "table" ? "table" : JSON.stringify(n.textContent))).join(",");
      // insertParagraphs logs a paste it can't make Docs' way, and the editor then pastes its own way, as here
      const log = console.error;
      console.error = () => {};
      let docsWay: boolean;
      try { docsWay = insertParagraphs(page.view(), nodes, ends, defaults, d.next() < 0.8); } finally { console.error = log; }
      if (docsWay) return `paste [${what}] ends=${ends} at ${s[0]}-${s[1]}`;
      const plain = nodes.filter((n) => n.type.name === "paragraph");
      page.apply(page.state.tr.replaceSelection(new Slice(Fragment.from(plain), 1, 1)).setMeta("paste", true));
      return `paste (ProseMirror) [${what}] at ${s[0]}-${s[1]}`;
    }
    case "pageBreak": {
      const at = caret(d, doc, d.next() < 0.85 ? "body" : "any");
      if (at == null) return null;
      page.select(at);
      return page.run(formatCommands.insertPageBreak()) ? `page break at ${at}` : null;
    }
    case "footnote": {
      const at = caret(d, doc);
      if (at == null) return null;
      page.apply(page.state.tr.insert(at, schema.nodes.footnoteRef.create({ fid: null })));
      return `footnote at ${at}`;
    }
    case "image": {
      const at = caret(d, doc);
      if (at == null) return null;
      page.apply(page.state.tr.insert(at, schema.nodes.image.create({ src: `https://example.com/new/${d.int(1, 99)}.png`, width: 40, height: 30 })));
      return `image at ${at}`;
    }
  }
}

// ── Saving, as use-autosave.ts does ─────────────────────────────────────────

export class FuzzFailure extends Error {
  constructor(public readonly kind: string, message: string) {
    super(`${kind}: ${message}`);
  }
}

/** Structural saves read the document back and save again; the autosave gives up after this many */
const MAX_STRUCTURAL_ROUNDS = 3;
/** Rounds one save may take before it counts as never ending */
const MAX_ROUNDS = 6;

interface Run { docs: Docs; id: string; page: Page; base: EditorNode; log: string[] }

const readBack = async (r: Run): Promise<EditorNode> => ({ type: "doc", content: groupColumns(importDoc(await r.docs.get(r.id)).nodes) });
const kinds = (requests: object[]) => requests.map((x) => Object.keys(x)[0]).join(",");

/**
 * Saves until nothing is left. A table's shape first, read back and its ids taken (the editor then
 * loads that, as the autosave does); otherwise the base becomes what was saved, and the document read
 * back must have it (verifyAgainstGoogle reloads when it doesn't: the edit didn't land as meant).
 */
async function autosave(r: Run): Promise<void> {
  let structural = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const out = directEdits(r.base, r.page.json);
    if (!out.requests.length) return;
    r.log.push(`  save${out.structural ? " (structural)" : ""}: ${JSON.stringify(out.requests)}`);
    for (const q of out.requests) if (!EDIT_REQUESTS.has(Object.keys(q)[0])) throw new FuzzFailure("not an edit the route takes", Object.keys(q)[0]);
    try {
      await r.docs.batchUpdate(r.id, out.requests as never);
    } catch (err) {
      throw new FuzzFailure("refused", `${(err as Error).message} [${kinds(out.requests)}]`);
    }
    const fresh = await readBack(r);
    if (out.structural) {
      if (++structural > MAX_STRUCTURAL_ROUNDS) throw new FuzzFailure("structural saves never end", kinds(out.requests));
      r.base = fresh;
      try {
        r.page.load(adoptStructure(fresh, r.page.json));
      } catch (err) {
        throw new FuzzFailure("the page can't take the adopted document", (err as Error).message);
      }
    } else {
      r.base = out.saved;
      if (signature(fresh) !== signature(r.base)) throw new FuzzFailure("saved differently", `Docs has ${JSON.stringify(signature(fresh))}, the autosave expected ${JSON.stringify(signature(r.base))}`);
    }
  }
  throw new FuzzFailure("saves never end", kinds(directEdits(r.base, r.page.json).requests));
}

/**
 * The additions typed in where additions() puts them, as the sync runner types them (contentRequests,
 * openAt): a segment typed before a paragraph opens it with a newline first and its text goes in before
 * that newline; a page break is insertPageBreak, which brings its own newline (the source's after it is
 * skipped); an image is insertInlineImage; then each run of the text in its look (textRequest). Last
 * first, so each goes where additions() says. Paragraph styles are the sync's too: they aren't compared.
 */
async function typeAdditions(r: Run): Promise<void> {
  const { segments } = additions(r.base, r.page.json);
  const requests: object[] = [];
  for (const { s } of segments.map((s, k) => ({ s, k })).sort((a, b) => b.s.at - a.s.at || b.k - a.k)) {
    if (s.mode === "before") requests.push(ins(s.at, "\n"));
    let pos = s.at;
    let buf = "";
    const flush = () => { if (buf) requests.push(ins(pos, buf)); pos += buf.length; buf = ""; };
    for (let k = 0; k < s.text.length; k++) {
      const ch = s.text[k];
      if (ch === PAGE_BREAK) { flush(); requests.push({ insertPageBreak: { location: { index: pos } } }); pos += 2; if (s.text[k + 1] === "\n") k++; continue; }
      const image = ch === OBJ ? s.format.images?.find((x) => x.at === k) : undefined;
      if (!image) { buf += ch; continue; }
      flush();
      requests.push({ insertInlineImage: { location: { index: pos }, uri: image.src } });
      pos += 1;
    }
    flush();
    // Where each character went: one index each, a page break two (with the newline Docs adds, the source's after it)
    const index: number[] = [];
    for (let k = 0, i = s.at; k <= s.text.length; k++) {
      index.push(i);
      i += s.text[k] === PAGE_BREAK && s.text[k + 1] !== "\n" ? 2 : 1;
    }
    let from = 0;
    for (const { len, ...style } of s.format.runs) {
      if (len > 0) requests.push(textRequest(resolveTextStyle(style), index[from], index[from + len]));
      from += len;
    }
  }
  if (!requests.length) return;
  r.log.push(`  sync: ${JSON.stringify(requests)}`);
  try {
    await r.docs.batchUpdate(r.id, requests as never);
  } catch (err) {
    throw new FuzzFailure("additions don't fit the saved document", `${(err as Error).message} [${kinds(requests)}]`);
  }
}

// ── Comparing ───────────────────────────────────────────────────────────────

/**
 * A paragraph as the comparison sees it. What it leaves out is what Docs (or reading it back)
 * legitimately puts its own way: a value a character's named style already gives (importDoc drops it,
 * the page may carry it as a mark), the look of a paragraph's newline, the box an empty paragraph's
 * attributes leave unset (paragraphFromAttrs resolves both sides the same), list and table ids. A list
 * item is compared by where it sits (its indents), not its nesting level: Docs can't start a list
 * nested, so its first items land at level 0 and are indented to where their level puts them (see
 * bulletRequests); their labels are then Docs' level 0 ones.
 */
interface ParaView { text: string; pending: boolean[]; looks: string[]; style: string; align: string; indent: string; list: string | null; level: number; solid: boolean }
type BlockView = { p: ParaView } | { rows: { span: string; paras: ParaView[] }[][] };

const sortedJSON = (v: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(v).filter(([, x]) => x != null).sort(([a], [b]) => a.localeCompare(b))));

function paraView(n: EditorNode, defaults: DocDefaults): ParaView {
  const pf = paragraphFromAttrs(n.attrs);
  const named = namedStyleText(defaults, pf.style);
  let text = "";
  const pending: boolean[] = [];
  const looks: string[] = [];
  for (const c of n.content ?? []) {
    const glow = !!c.marks?.some((x) => x.type === PENDING_MARK);
    // Filled in with what its named style gives (see lookIn), as one reads the other's
    const look = () => {
      const s = styleFromMarks((c.marks ?? []).filter((x) => x.type !== PENDING_MARK)) as Record<string, unknown>;
      return sortedJSON({ ...s, font: s.font ?? named.font, size: s.size ?? named.size, color: s.color ?? named.color });
    };
    const put = (ch: string, styled: boolean) => { text += ch; pending.push(glow); looks.push(styled ? look() : ""); };
    if (c.type === "text") for (const ch of c.text ?? "") put(ch, true);
    else if (c.type === "image") put(OBJ, false);
    else if (c.type === "pageBreak") put(PAGE_BREAK, false);
    else if (c.type === "footnoteRef") put("\u0001", false);
    else if (c.type === "hardBreak") put("\u000b", false);
    else put(`[${c.type}]`, false);
  }
  const glows = pending.some(Boolean);
  return {
    text,
    pending,
    looks,
    style: pf.style,
    align: pf.align,
    indent: JSON.stringify(pf.list ? pf.exact ?? { start: 36 * ((pf.level ?? 0) + 1), first: 36 * ((pf.level ?? 0) + 1) - 18 } : effectiveIndent(pf)),
    list: pf.list ?? null,
    level: pf.level ?? 0,
    solid: !glows,
  };
}

/**
 * Which paragraphs of one container (the body, or a cell) the autosave saves whole: nothing glows in
 * them or next to them. An addition takes in the new text and newlines next to it (direct text typed
 * beside it is the sync's to type too), so a paragraph next to one that glows (past empty lines) may
 * wait for the sync, its style with it.
 */
function markSolid(paras: ParaView[]) {
  const glows = (v: ParaView | undefined) => !!v?.pending.some(Boolean);
  const near = (i: number, step: number) => { let j = i + step; while (j >= 0 && j < paras.length && !paras[j].text.length) j += step; return paras[j]; };
  const solid = paras.map((v, i) => v.solid && !glows(near(i, -1)) && !glows(near(i, 1)));
  paras.forEach((v, i) => { v.solid = solid[i]; });
}

function viewOf(doc: EditorNode, defaults: DocDefaults): { blocks: BlockView[]; paras: ParaView[]; attrs: Record<string, unknown>[] } {
  const paras: ParaView[] = [];
  const attrs: Record<string, unknown>[] = [];
  const view = (n: EditorNode) => {
    const v = paraView(n.type === "paragraph" ? n : { type: "paragraph", content: [{ type: "text", text: `[${n.type}]` }] }, defaults);
    paras.push(v);
    attrs.push(n.type === "paragraph" ? n.attrs ?? {} : {});
    return v;
  };
  const blocks: BlockView[] = [];
  // The body's paragraphs between tables are one run of paragraphs; each cell is another
  let body: ParaView[] = [];
  for (const n of (doc.content ?? []).flatMap((b) => (b.type === "columnSection" ? b.content ?? [] : [b]))) {
    if (n.type === "table") {
      markSolid(body);
      body = [];
      blocks.push({ rows: (n.content ?? []).map((row) => (row.content ?? []).map((cell) => {
        const own = (cell.content ?? []).map(view);
        markSolid(own);
        return { span: `${cell.attrs?.colspan ?? 1}x${cell.attrs?.rowspan ?? 1}`, paras: own };
      })) });
      continue;
    }
    const v = view(n);
    body.push(v);
    blocks.push({ p: v });
  }
  markSolid(body);
  return { blocks, paras, attrs };
}

/** Which list each item is in, as the first item of that list's place (so ids don't matter) */
function partition(attrs: Record<string, unknown>[], keep: boolean[]): (number | null)[] {
  const { lists } = listRuns(attrs as ListParagraph[]);
  const first = new Map<string, number>();
  return lists.map((l, i) => {
    if (l == null || !keep[i]) return null;
    if (!first.has(l)) first.set(l, i);
    return first.get(l)!;
  });
}

const describePara = (p: ParaView) => `${JSON.stringify(p.text)} ${p.style} ${p.align}${p.list ? ` ${p.list}@${p.level}` : ""}${p.indent !== '{"start":0,"first":0}' ? ` indent ${p.indent}` : ""}`;

/** The ways Docs' document differs from the page, once the additions are typed in */
export function differences(docs: EditorNode, page: EditorNode, defaults: DocDefaults): string[] {
  const out: string[] = [];
  const g = viewOf(docs, defaults);
  const p = viewOf(page, defaults);
  const anyPending = p.paras.some((x) => x.pending.some(Boolean));
  const shape = (v: typeof g) => v.blocks.map((b) => ("p" in b ? "p" : `table[${b.rows.map((r) => r.map((c) => `${c.span}:${c.paras.length}`).join(" ")).join(" / ")}]`)).join(" ");
  if (shape(g) !== shape(p)) return [`blocks: Docs has ${shape(g)}, the page ${shape(p)}`];
  p.paras.forEach((pp, i) => {
    const gp = g.paras[i];
    if (gp.text !== pp.text) { out.push(`paragraph ${i} text: Docs has ${JSON.stringify(gp.text)}, the page ${JSON.stringify(pp.text)}`); return; }
    if (pp.solid || !anyPending) {
      for (const key of ["style", "align", "indent", "list"] as const) {
        if (gp[key] !== pp[key]) out.push(`paragraph ${i} ${key}: Docs has ${describePara(gp)}, the page ${describePara(pp)}`);
      }
    }
    // Each character's look as it shows: its own size, font and colour, else its paragraph's named style's.
    // A paragraph whose style waits for the sync (it's the sync's to set) is read in the page's style
    const named = namedStyleText(defaults, pp.style as never);
    const lookIn = (look: string, style: string) => {
      if (!look) return look;
      const s = JSON.parse(look) as Record<string, unknown>;
      const from = namedStyleText(defaults, style as never);
      if (gp.style !== pp.style && style === gp.style) {
        if (s.font === from.font && !s.w) s.font = named.font;
        if (s.size === from.size) s.size = named.size;
        if (s.color === from.color) s.color = named.color;
      }
      return sortedJSON(s);
    };
    for (let k = 0; k < pp.text.length; k++) {
      if (pp.pending[k]) continue;
      const g = lookIn(gp.looks[k], gp.style);
      if (g === pp.looks[k]) continue;
      out.push(`paragraph ${i} character ${k} (${JSON.stringify(pp.text[k])}): Docs has ${g}, the page ${pp.looks[k]}`);
      break;
    }
  });
  if (out.length) return out;
  // Lists: which list each item is in, and (with nothing glowing) the labels the page draws
  const keep = p.paras.map((x) => x.solid || !anyPending);
  const gl = JSON.stringify(partition(g.attrs, keep));
  const pl = JSON.stringify(partition(p.attrs, keep));
  if (gl !== pl) out.push(`lists: Docs groups the items ${gl}, the page ${pl}`);
  if (!anyPending) {
    // An item Docs holds at a shallower level than the page (a list that starts nested) has Docs' label for it
    const gLabels = listRuns(g.attrs as ListParagraph[]).labels;
    const pLabels = listRuns(p.attrs as ListParagraph[]).labels.map((l, i) => (g.paras[i].level < p.paras[i].level ? gLabels[i] : l));
    if (JSON.stringify(gLabels) !== JSON.stringify(pLabels)) out.push(`list labels: Docs has ${JSON.stringify(gLabels)}, the page ${JSON.stringify(pLabels)}`);
  }
  return out;
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface RunResult { failure: FuzzFailure | null; log: string[]; ops: number; saves: number; pending: boolean }

/** Plain text of a document, a line a paragraph (a table's cells between bars), for the log */
export function outline(doc: EditorNode): string {
  const line = (n: EditorNode) => (n.content ?? []).map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[img]" : c.type === "pageBreak" ? "[pb]" : c.type === "footnoteRef" ? "[fn]" : `[${c.type}]`)).join("") + (n.attrs?.list ? `  (${n.attrs.list}@${n.attrs.level ?? 0})` : "") + (n.attrs?.styleName && n.attrs.styleName !== "normal" ? `  (${n.attrs.styleName})` : "");
  return (doc.content ?? []).map((n) => (n.type === "table" ? `[table ${(n.content ?? []).map((r) => (r.content ?? []).map((c) => (c.content ?? []).map(line).join("/")).join("|")).join(" ; ")}]` : line(n))).join("\n");
}

export async function runScenario(s: Scenario): Promise<RunResult> {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("fuzz");
  const log: string[] = [];
  let ops = 0;
  let saves = 0;
  let pending = false;
  try {
    try {
      await makeStart(docs, id, s);
    } catch (err) {
      // The starting document is the fuzzer's own: one Docs wouldn't make is a fuzzer bug
      throw new FuzzFailure("start", (err as Error).message);
    }
    const imported = importDoc(await docs.get(id));
    const base: EditorNode = { type: "doc", content: groupColumns(imported.nodes) };
    const r: Run = { docs, id, page: new Page(base), base, log };
    log.push(`start:\n${outline(base)}`);
    for (const op of s.ops) {
      const what = applyOp(r.page, op.kind, op.seed, imported.defaults);
      if (what) { ops++; log.push(`${op.kind}: ${what}`, outline(r.page.json).replace(/^/gm, "    | ")); }
      if (op.save) { saves++; await autosave(r); }
    }
    saves++;
    await autosave(r);
    if (directEdits(r.base, r.page.json).requests.length) throw new FuzzFailure("saves never end", "requests left");
    log.push(`page:\n${outline(r.page.json)}`);
    pending = hasPending(r.page.json);
    await typeAdditions(r);
    const after = await readBack(r);
    log.push(`Docs, additions typed:\n${outline(after)}`);
    const diff = differences(after, r.page.json, imported.defaults);
    if (diff.length) throw new FuzzFailure(diff[0].replace(/ \(.*?\)/, "").split(":")[0].replace(/ \d+/g, ""), diff.join("\n"));
    return { failure: null, log, ops, saves, pending };
  } catch (err) {
    if (err instanceof FuzzFailure) return { failure: err, log, ops, saves, pending };
    return { failure: new FuzzFailure("crash", (err as Error).stack ?? String(err)), log, ops, saves, pending };
  }
}

/** A smaller scenario that fails the same way: blocks and edits left out, saves between edits dropped */
export async function minimize(s: Scenario, kind: string): Promise<Scenario> {
  let cur = s;
  const fails = async (c: Scenario) => (await runScenario(c)).failure?.kind === kind;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = cur.ops.length - 1; i >= 0; i--) {
      const c = { ...cur, ops: cur.ops.filter((_, k) => k !== i) };
      if (c.ops.length && await fails(c)) { cur = c; changed = true; }
    }
    for (let i = cur.blocks.length - 1; i >= 0; i--) {
      const c = { ...cur, blocks: cur.blocks.filter((_, k) => k !== i) };
      if (await fails(c)) { cur = c; changed = true; }
    }
    for (let i = 0; i < cur.ops.length; i++) {
      if (!cur.ops[i].save) continue;
      const c = { ...cur, ops: cur.ops.map((o, k) => (k === i ? { ...o, save: false } : o)) };
      if (await fails(c)) { cur = c; changed = true; }
    }
    if (cur.endsWithText) { const c = { ...cur, endsWithText: false }; if (await fails(c)) { cur = c; changed = true; } }
  }
  return cur;
}
