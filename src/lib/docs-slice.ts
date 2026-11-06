/**
 * Google Docs' own clipboard format.
 *
 * Copying from Google Docs puts three things on the clipboard: text/plain,
 * text/html, and Docs' own copy of the selection
 * (application/x-vnd.google-docs-document-slice-clip+wrapped), which is
 * what Docs itself pastes from when the copy goes into another document.
 * The HTML loses detail (exact indents, list glyphs, which values are the
 * paragraph style's own, non-breaking spaces, empty paragraphs); the slice
 * has all of it.
 *
 * The slice is the document's text with style runs over it:
 *  - `dsl_spacers` is the text; "\n" ends a paragraph and "\u000b" is a
 *    line break.
 *  - each `dsl_styleslices` entry is one kind of style (text, paragraph,
 *    list, link...) as an array over the text: a non-null entry at i is the
 *    style from i on; null keeps the one before it. Paragraph and list
 *    styles sit on the paragraph's newline. Arrays end after their last
 *    change; a copy that ends inside a paragraph has that paragraph's style
 *    as the slice's `stsl_trailing`.
 *  - every value is given; `<key>_i: true` says it comes from the named
 *    style (so pasting it takes the destination's named style instead).
 *  - lists are entities in `dsl_entitymap`, one definition per nesting level.
 *
 * Here the slice becomes a documents.get response for the copied
 * paragraphs, so pasted content is read by the same code that reads a
 * Google Doc (doc-import). Anything this doesn't read exactly (tables,
 * images, equations, footnotes, suggestions) returns null, and the paste
 * falls back to the HTML.
 */

import type { docs_v1 } from "googleapis";
import { importDoc, type DocDefaults } from "./doc-import";
import { presetForLevels, type Glyph } from "./list-labels";
import type { EditorNode } from "./rich-text";

export const DOCS_SLICE_TYPE = "application/x-vnd.google-docs-document-slice-clip+wrapped";

type Style = Record<string, unknown>;
interface StyleSlice { stsl_type: string; stsl_styles: (Style | null)[]; stsl_trailing?: Style }
interface Resolved {
  dsl_spacers: string;
  dsl_styleslices: StyleSlice[];
  dsl_entitymap?: Record<string, Style>;
  dsl_entitytypemap?: Record<string, string>;
  dsl_entitypositionmap?: Record<string, unknown>;
  dsl_suggestedinsertions?: { sgsl_sugg?: unknown[] };
  dsl_suggesteddeletions?: { sgsl_sugg?: unknown[] };
}

export interface DocsSlice {
  /** The copied paragraphs, as documents.get would describe them */
  doc: docs_v1.Schema$Document;
  /** The copy ends with a whole paragraph (its newline was copied) */
  endsWithParagraph: boolean;
  /** The copied text */
  text: string;
}

/** Docs' paragraph heading codes */
const HEADING: Record<number, string> = { 0: "NORMAL_TEXT", 1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3", 4: "HEADING_4", 5: "HEADING_5", 6: "HEADING_6", 100: "TITLE", 101: "SUBTITLE" };
const ALIGNMENT: Record<number, string> = { 0: "START", 1: "CENTER", 2: "END", 3: "JUSTIFIED" };
/** List glyph codes: 9 draws the level's symbol; the others number it */
const GLYPH: Record<number, string> = { 10: "DECIMAL", 11: "ZERO_DECIMAL", 12: "UPPER_ALPHA", 13: "ALPHA", 14: "UPPER_ROMAN", 15: "ROMAN" };
/** A checklist level; the Docs API gives a checkbox no glyph type of its own or symbol (doc-import reads it so) */
const CHECKBOX = 17;
/**
 * Glyph codes of Docs' older list presets, which come with no symbol or format of their own (documents made
 * before the current presets): 0-2 are the bullets ● ○ ■, 3-7 numbers (4 and 6 by the pattern; never seen)
 */
const LEGACY: Record<number, { symbol?: string; type?: string }> = {
  0: { symbol: "\u25cf" }, 1: { symbol: "\u25cb" }, 2: { symbol: "\u25a0" },
  3: { type: "DECIMAL" }, 4: { type: "UPPER_ALPHA" }, 5: { type: "ALPHA" }, 6: { type: "UPPER_ROMAN" }, 7: { type: "ROMAN" },
};
/** A weighted font is its family and its weight: Docs copies Lexend Light as "Lexend;300" */
const WEIGHTED = /^(.+);(\d{3})$/;
const DASH: Record<number, string> = { 0: "SOLID", 1: "DOT", 2: "DASH" };

/** Kinds of content the slice can hold that this reader doesn't turn into paragraphs */
const UNREAD = new Set(["tbl", "row", "cell", "equation", "equation_function", "footnote", "horizontal_rule", "field", "code_snippet", "autogen", "column_sector", "esignature_signers"]);

/** Text the editor can hold as is: anything else is a structure (table, chip, equation) */
const STRUCTURAL = /[\u0000-\u0008\u000c-\u001f\u007f\ue000-\uf8ff]/;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pt = (v: unknown): docs_v1.Schema$Dimension | undefined => { const n = num(v); return n == null ? undefined : { magnitude: n, unit: "PT" }; };

function colorOf(v: unknown): string | undefined {
  const c = (v as { hclr_color?: unknown } | null)?.hclr_color;
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : undefined;
}
function optionalColor(hex: string): docs_v1.Schema$OptionalColor {
  const n = parseInt(hex.slice(1), 16);
  return { color: { rgbColor: { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 } } };
}

/** The slice's inner object, from the clipboard string (or an already parsed copy) */
function unwrap(raw: unknown, depth = 0): Resolved | null {
  if (depth > 4 || raw == null) return null;
  if (typeof raw === "string") {
    try { return unwrap(JSON.parse(raw), depth + 1); } catch { return null; }
  }
  if (typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.dsl_spacers === "string" && Array.isArray(o.dsl_styleslices)) return o as unknown as Resolved;
  if (o.resolved) return unwrap(o.resolved, depth + 1);
  if (o.data) return unwrap(o.data, depth + 1);
  return null;
}

/** The copied text, from Docs' copy even when the rest of it can't be read (whether its last newline was copied) */
export function sliceText(raw: unknown): string | null {
  return unwrap(raw)?.dsl_spacers ?? null;
}

/** The style in effect at each position of the text */
function runs(styles: (Style | null)[] | undefined, length: number): (Style | null)[] {
  const out = new Array<Style | null>(length).fill(null);
  let cur: Style | null = null;
  for (let i = 0; i < length; i++) {
    const s = styles?.[i];
    if (s) cur = s;
    out[i] = cur;
  }
  return out;
}

/** Docs' own text style: what's set on the text, leaving out what its named style gives it */
export function textStyleOf(ts: Style | null | undefined, link?: Style | null): docs_v1.Schema$TextStyle {
  const out: docs_v1.Schema$TextStyle = {};
  if (!ts) return out;
  const own = (k: string) => ts[`${k}_i`] !== true;
  if (own("ts_bd")) out.bold = ts.ts_bd === true;
  if (own("ts_it")) out.italic = ts.ts_it === true;
  if (own("ts_un")) out.underline = ts.ts_un === true;
  if (own("ts_st")) out.strikethrough = ts.ts_st === true;
  if (own("ts_sc")) out.smallCaps = ts.ts_sc === true;
  if (own("ts_va")) out.baselineOffset = ts.ts_va === "sup" ? "SUPERSCRIPT" : ts.ts_va === "sub" ? "SUBSCRIPT" : "NONE";
  if (own("ts_fs") && num(ts.ts_fs)) out.fontSize = pt(ts.ts_fs);
  if (own("ts_ff") && typeof ts.ts_ff === "string" && ts.ts_ff) {
    const weighted = WEIGHTED.exec(ts.ts_ff);
    out.weightedFontFamily = weighted ? { fontFamily: weighted[1], weight: Number(weighted[2]) } : { fontFamily: ts.ts_ff, weight: num(ts.ts_tw) ?? 400 };
  }
  if (own("ts_fgc2")) { const c = colorOf(ts.ts_fgc2); if (c) out.foregroundColor = optionalColor(c); }
  if (own("ts_bgc2")) { const c = colorOf(ts.ts_bgc2); if (c) out.backgroundColor = optionalColor(c); }
  const url = (link?.lnks_link as { ulnk_url?: unknown } | null | undefined)?.ulnk_url;
  if (typeof url === "string" && url) out.link = { url };
  return out;
}

function borderOf(b: unknown): docs_v1.Schema$ParagraphBorder | undefined {
  if (!b || typeof b !== "object") return undefined;
  const o = b as Style;
  const width = num(o.brdr_w) ?? 0;
  if (width <= 0) return undefined;
  const color = colorOf(o.brdr_c2) ?? "#000000";
  return { width: { magnitude: width, unit: "PT" }, color: optionalColor(color), dashStyle: DASH[num(o.brdr_ls) ?? 0] ?? "SOLID", padding: pt(num(o.brdr_s) ?? 0) };
}

/** Docs' own paragraph style, leaving out what its named style gives it */
export function paragraphStyleOf(ps: Style | null | undefined): docs_v1.Schema$ParagraphStyle {
  const out: docs_v1.Schema$ParagraphStyle = { namedStyleType: HEADING[num(ps?.ps_hd) ?? 0] ?? "NORMAL_TEXT" };
  if (!ps) return out;
  const own = (k: string) => ps[`${k}_i`] !== true && ps[k] !== undefined;
  if (own("ps_al")) out.alignment = ALIGNMENT[num(ps.ps_al) ?? 0] ?? "START";
  if (own("ps_ls") && num(ps.ps_ls)) out.lineSpacing = Math.round((ps.ps_ls as number) * 10000) / 100;
  if (own("ps_sb")) out.spaceAbove = pt(ps.ps_sb);
  if (own("ps_sa")) out.spaceBelow = pt(ps.ps_sa);
  if (own("ps_il")) out.indentStart = pt(ps.ps_il);
  if (own("ps_ifl")) out.indentFirstLine = pt(ps.ps_ifl);
  if (own("ps_ir")) out.indentEnd = pt(ps.ps_ir);
  if (own("ps_kwn")) out.keepWithNext = ps.ps_kwn === true;
  if (own("ps_klt")) out.keepLinesTogether = ps.ps_klt === true;
  if (own("ps_awao")) out.avoidWidowAndOrphan = ps.ps_awao === true;
  if (own("ps_pbb")) out.pageBreakBefore = ps.ps_pbb === true;
  if (own("ps_ltr")) out.direction = ps.ps_ltr === false ? "RIGHT_TO_LEFT" : "LEFT_TO_RIGHT";
  // Spacing between items of a list: 0 leaves it out (COLLAPSE_LISTS), 1 keeps it
  if (own("ps_sm")) out.spacingMode = num(ps.ps_sm) === 1 ? "NEVER_COLLAPSE" : "COLLAPSE_LISTS";
  const sides: [string, keyof docs_v1.Schema$ParagraphStyle][] = [["ps_bt", "borderTop"], ["ps_bb", "borderBottom"], ["ps_bl", "borderLeft"], ["ps_br", "borderRight"], ["ps_bbtw", "borderBetween"]];
  for (const [k, field] of sides) {
    if (!own(k)) continue;
    const b = borderOf(ps[k]);
    if (b) (out as Record<string, unknown>)[field] = b;
  }
  if (own("ps_sd") && ps.ps_sd && typeof ps.ps_sd === "object") {
    const c = colorOf((ps.ps_sd as Style).sd_bgc2) ?? colorOf(Object.values(ps.ps_sd as Style).find((v) => colorOf(v)));
    if (c) out.shading = { backgroundColor: optionalColor(c) };
  }
  return out;
}

/** A list entity's nesting levels as Docs' lists describe them */
function listOf(entity: Style | undefined): docs_v1.Schema$List | undefined {
  const levels = (entity?.le_nb as Record<string, Style> | undefined) ?? undefined;
  if (!levels) return undefined;
  const nestingLevels: docs_v1.Schema$NestingLevel[] = [];
  for (let n = 0; n < 9; n++) {
    const b = levels[`nl_${n}`];
    if (!b) { nestingLevels.push({}); continue; }
    const code = num(b.b_gt);
    const legacy = code != null && !b.b_gs ? LEGACY[code] : undefined;
    const symbol = typeof b.b_gs === "string" && b.b_gs ? b.b_gs : legacy?.symbol ?? "";
    const numbered = code != null ? GLYPH[code] ?? legacy?.type : undefined;
    const level: docs_v1.Schema$NestingLevel = {
      glyphFormat: typeof b.b_gf === "string" && b.b_gf ? b.b_gf : numbered ? `%${n}.` : `%${n}`,
      startNumber: num(b.b_sn) ?? 1,
      indentStart: pt(b.b_il),
      indentFirstLine: pt(b.b_ifl),
      bulletAlignment: num(b.b_a) === 1 ? "CENTER" : num(b.b_a) === 2 ? "END" : "START",
      textStyle: textStyleOf(b.b_ts as Style | undefined),
    };
    if (numbered) level.glyphType = numbered;
    else if (code === CHECKBOX) level.glyphType = "GLYPH_TYPE_UNSPECIFIED";
    else if (symbol) level.glyphSymbol = symbol;
    // A symbol level with no symbol draws none; a glyph code this doesn't know is drawn as a bullet
    else if (code === 9) level.glyphType = "NONE";
    else level.glyphSymbol = "\u25cf";
    nestingLevels.push(level);
  }
  return { listProperties: { nestingLevels } };
}

/** Text as both copies should have it: line ends the same, spaces plain */
const comparable = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\u000b\u2028]/g, "\n").replace(/\u00a0/g, " ").replace(/\n+$/, "");

/** A page break: in a paragraph's text, read as Docs' pageBreak element */
const PAGE_BREAK_CHAR = "\u000c";
const TABLE_START = "\u0010";
const TABLE_END = "\u0011";
/** A section break, at the start of the paragraph after it (its columns are the column_sector slice's) */
const SECTION_BREAK = "\ue905";
/**
 * Entities whose position says nothing about how the text looks. A positioned (floating) image is
 * anchored on the newline of the paragraph before the one it's drawn by, which the HTML draws it in:
 * the image is the HTML's (see mergeSliceWithHtml), and the paragraph it's anchored on is read whole.
 */
const INVISIBLE_ENTITIES = new Set(["bookmark", "named-range", "list", "positioned"]);
/** Where the slice has an inline image (on its "*") */
const INLINE_IMAGES = "inline";

/**
 * A block of the copy, in order: a paragraph, or a table. A paragraph is `exact` when this reads all
 * of it (text, line and page breaks); one with an image, chip, footnote, rule, field or equation in it
 * is read for its paragraph style only. `text` is its text as the page shows it (line breaks as "\n",
 * without the newline), for finding its counterpart in the copy's HTML; `images`, how many inline
 * images the paragraph has (its counterpart has them too).
 */
export interface SliceBlock { kind: "paragraph" | "table"; text: string; exact: boolean; images?: number }

/** Docs' copy read block by block: every block of it, each paragraph as documents.get describes it (see readDocsSliceParts) */
export interface DocsSliceParts extends DocsSlice { blocks: SliceBlock[] }

/** The copy's blocks, and how to read each, or null when the copy can't be read at all */
function readParts(r: Resolved): DocsSliceParts | null {
  const text = r.dsl_spacers;
  if (!text) return null;
  if (r.dsl_suggestedinsertions?.sgsl_sugg?.length || r.dsl_suggesteddeletions?.sgsl_sugg?.length) return null;

  const slices = new Map<string, StyleSlice>();
  for (const s of r.dsl_styleslices) if (s && typeof s.stsl_type === "string") slices.set(s.stsl_type, s);
  const len = text.length;
  // Positions of what lives outside the text, or that this doesn't read, by kind
  const marked = new Array<boolean>(len).fill(false);
  const image = new Array<boolean>(len).fill(false);
  for (const kind of UNREAD) slices.get(kind)?.stsl_styles?.forEach((x, i) => { if (x != null && i < len) marked[i] = true; });
  for (const [kind, v] of Object.entries(r.dsl_entitypositionmap ?? {})) {
    if (INVISIBLE_ENTITIES.has(kind)) continue;
    if (Array.isArray(v)) v.forEach((x, i) => { if (x != null && i < len) { marked[i] = true; if (kind === INLINE_IMAGES) image[i] = true; } });
    else if (v != null) return null;
  }

  const textAt = runs(slices.get("text")?.stsl_styles, len);
  const linkAt = runs(slices.get("link")?.stsl_styles, len);
  const paraAt = runs(slices.get("paragraph")?.stsl_styles, len);
  const listAt = runs(slices.get("list")?.stsl_styles, len);

  const lists: Record<string, docs_v1.Schema$List> = {};
  const content: docs_v1.Schema$StructuralElement[] = [];
  const blocks: SliceBlock[] = [];
  let index = 1;
  let start = 0;
  const endsWithParagraph = text.endsWith("\n");
  while (start < len) {
    if (text[start] === SECTION_BREAK) { start++; continue; }
    if (text[start] === TABLE_START) {
      // The whole table, nested ones in it too: its HTML is pasted for it
      let depth = 0;
      let end = start;
      for (; end < len; end++) {
        if (text[end] === TABLE_START) depth++;
        else if (text[end] === TABLE_END && --depth === 0) break;
      }
      const cells = text.slice(start, end + 1).split(/[\u0010-\u0012\u001c]+/).map((c) => c.replace(/\n$/, ""));
      blocks.push({ kind: "table", text: cells.filter(Boolean).join("\n"), exact: false });
      // In its place an element of its own that nothing reads as text (a list doesn't go on across it)
      content.push({ startIndex: index, endIndex: index + 1, paragraph: { elements: [{ startIndex: index, endIndex: index + 1, horizontalRule: {} }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } });
      index += 1;
      start = end + 1;
      continue;
    }
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? len : nl + 1;
    const ps = nl < 0 ? slices.get("paragraph")?.stsl_trailing ?? null : paraAt[nl];
    const ls = nl < 0 ? slices.get("list")?.stsl_trailing ?? null : listAt[nl];
    let exact = true;
    for (let i = start; i < end && exact; i++) if (marked[i] || (STRUCTURAL.test(text[i]) && text[i] !== PAGE_BREAK_CHAR)) exact = false;
    // Runs: where the text style or the link changes; a page break is an element of its own. What isn't
    // text (a placeholder for an image or chip) is left out: such a paragraph's content comes from elsewhere
    const elements: docs_v1.Schema$ParagraphElement[] = [];
    let at = index;
    let run = "";
    let runStyle: number | null = null;
    const flush = () => {
      if (!run || runStyle == null) return;
      elements.push({ startIndex: at, endIndex: at + run.length, textRun: { content: run, textStyle: textStyleOf(textAt[runStyle], linkAt[runStyle]) } });
      at += run.length;
      run = "";
    };
    for (let i = start; i < end; i++) {
      const c = text[i];
      if (c === PAGE_BREAK_CHAR) { flush(); elements.push({ startIndex: at, endIndex: at + 1, pageBreak: {} }); at += 1; continue; }
      if (marked[i] || STRUCTURAL.test(c)) continue;
      if (runStyle != null && (textAt[i] !== textAt[runStyle] || linkAt[i] !== linkAt[runStyle])) flush();
      if (!run) runStyle = i;
      run += c;
    }
    flush();
    const paragraph: docs_v1.Schema$Paragraph = { elements, paragraphStyle: paragraphStyleOf(ps) };
    const listId = typeof ls?.ls_id === "string" ? ls.ls_id : null;
    if (listId) {
      const list = lists[listId] ?? listOf(r.dsl_entitymap?.[listId]);
      if (list) {
        lists[listId] = list;
        paragraph.bullet = { listId, nestingLevel: Math.max(0, Math.min(8, num(ls?.ls_nest) ?? 0)), textStyle: textStyleOf(ls?.ls_ts as Style | undefined) };
      }
    }
    content.push({ startIndex: index, endIndex: at, paragraph });
    let images = 0;
    for (let i = start; i < end; i++) if (image[i]) images++;
    blocks.push({ kind: "paragraph", text: comparable(text.slice(start, end).replace(/[\u0000-\u0008\u000c-\u001f\u007f\ue000-\uf8ff]/g, "")), exact, ...(images ? { images } : {}) });
    index = at;
    start = end;
  }
  return { doc: { body: { content }, lists }, endsWithParagraph, text, blocks };
}

/**
 * Read Docs' clipboard copy. `plain` is the clipboard's text/plain: when it
 * says something else, the slice isn't trusted. Null when the copy has
 * content this can't read exactly.
 */
export function readDocsSlice(raw: unknown, plain?: string | null): DocsSlice | null {
  const r = unwrap(raw);
  if (!r || !r.dsl_spacers) return null;
  // Docs' text/plain leaves out page and section breaks
  if (plain && comparable(plain) !== comparable(r.dsl_spacers.replace(/[\u000c\ue905]/g, ""))) return null;
  // Images, chips and the like live outside the text
  for (const t of Object.values(r.dsl_entitytypemap ?? {})) if (t !== "list") return null;
  const parts = readParts(r);
  if (!parts || !parts.blocks.every((b) => b.kind === "paragraph" && b.exact)) return null;
  return { doc: parts.doc, endsWithParagraph: parts.endsWithParagraph, text: parts.text };
}

/**
 * Read Docs' clipboard copy block by block, whatever is in it: its paragraphs as readDocsSlice reads
 * them, and where the HTML has to give a block (a table, or what's in a paragraph with an image or chip:
 * see SliceBlock), that block. Null when it can't be read at all.
 */
export function readDocsSliceParts(raw: unknown): DocsSliceParts | null {
  const r = unwrap(raw);
  return r ? readParts(r) : null;
}

/**
 * The copied paragraphs as editor paragraphs, against the destination
 * document's named styles (`defaults`).
 *
 * A pasted list becomes a list made here, in the Docs list style closest to
 * its own glyphs, numbered from one: what a sync can create (the API makes
 * lists only in Docs' list styles, and can't set where numbering starts),
 * so the page shows what Docs will.
 *
 * A Docs list can number some levels and bullet others; a list style can't.
 * Its numbered items, its bulleted ones and its checkboxes each become a
 * list of their own kind, as a sync makes them.
 */
export function sliceParagraphs(slice: DocsSlice, defaults: DocDefaults): EditorNode[] {
  const nodes = importDoc(slice.doc, { defaults }).nodes;
  const key = (n: EditorNode) => `${n.attrs?.listId as string}\u0000${n.attrs?.list as string}`;
  // Per list and kind of item: how many items use each level
  const used = new Map<string, { id: string; kind: string; weights: number[] }>();
  for (const n of nodes) {
    const id = n.attrs?.listId as string | null | undefined;
    if (!id || !n.attrs?.list) continue;
    const u = used.get(key(n)) ?? { id, kind: n.attrs.list as string, weights: [] };
    const level = (n.attrs.level as number | null) ?? 0;
    u.weights[level] = (u.weights[level] ?? 0) + 1;
    used.set(key(n), u);
  }
  const presets = new Map<string, string>();
  for (const [k, { id, kind, weights }] of used) {
    const levels = slice.doc.lists?.[id]?.listProperties?.nestingLevels ?? [];
    const glyphs: Glyph[] = levels.map((l) => ({ type: l.glyphType ?? null, format: l.glyphFormat ?? null, symbol: l.glyphSymbol ?? null }));
    presets.set(k, presetForLevels(kind, glyphs, weights));
  }
  return nodes.map((n) => {
    const id = n.attrs?.listId as string | null | undefined;
    if (!id || !n.attrs) return n;
    return { ...n, attrs: { ...n.attrs, listId: null, glyph: null, preset: presets.get(key(n)) ?? null } };
  });
}

const nodeText = (n: EditorNode): string =>
  n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? "\n" : (n.content ?? []).map(nodeText).join(n.type === "paragraph" ? "" : "\n");
/** Text compared loosely: no spaces, and none of what stands in for an image, chip, footnote or rule */
const squash = (s: string) => s.replace(/[\s*#\-]/g, "");
/** Whether every character of `a` is in `b`, in order (`b` may have a chip's or footnote's text besides) */
function within(a: string, b: string): boolean {
  let k = 0;
  for (let i = 0; i < b.length && k < a.length; i++) if (b[i] === a[k]) k++;
  return k === a.length;
}

const imagesIn = (n: EditorNode) => (n.content ?? []).filter((c) => c.type === "image").length;

/** A paragraph with images and no text (Docs writes a floating image before the <p> it's drawn by, which pastes as one) */
const imageOnly = (n: EditorNode) => n.type === "paragraph" && imagesIn(n) > 0 && !/[^\s ]/.test(nodeText(n));
const imageCount = (ns: EditorNode[]): number => ns.reduce((a, n) => a + (n.type === "image" ? 1 : 0) + imageCount(n.content ?? []), 0);

/**
 * An exact paragraph from Docs' copy with the images its HTML counterpart draws in it (a positioned
 * image, which the copy anchors elsewhere): each where the HTML has it, after as much of the text. When
 * the two have the same text, that is counted in characters; otherwise in what isn't a space. A line
 * break counts as one either way.
 */
function withHtmlImages(node: EditorNode, h: EditorNode): EditorNode {
  const plain = (n: EditorNode) => nodeText(n).replace(/ /g, " ");
  const same = plain(node) === plain(h);
  const size = (s: string) => (same ? s.length : s.replace(/[\s ]/g, "").length);
  const images: { at: number; node: EditorNode }[] = [];
  let seen = 0;
  for (const c of h.content ?? []) {
    if (c.type === "image") images.push({ at: seen, node: c });
    else seen += c.type === "hardBreak" ? 1 : size(nodeText(c));
  }
  if (!images.length) return node;
  const content: EditorNode[] = [];
  let count = 0;
  let next = 0;
  // Each image goes just before what is past its place (counting only what isn't a space, after the spaces that end it)
  const place = (all: boolean) => { while (next < images.length && (all || images[next].at <= count)) content.push(images[next++].node); };
  place(false);
  for (const c of node.content ?? []) {
    if (c.type === "hardBreak") { place(false); content.push(c); count++; continue; }
    if (c.type !== "text" || !c.text) { content.push(c); continue; }
    let from = 0;
    for (let i = 0; i < c.text.length; i++) {
      if (!size(c.text[i])) continue;
      if (next < images.length && images[next].at <= count) {
        if (i > from) content.push({ ...c, text: c.text.slice(from, i) });
        from = i;
        place(false);
      }
      count++;
    }
    content.push(from ? { ...c, text: c.text.slice(from) } : c);
  }
  place(true);
  return { ...node, content };
}

/**
 * Docs' copy (read with readDocsSliceParts) with its HTML: the copy's blocks in order, each exact
 * paragraph as Docs' copy has it, and where only the HTML can say, the HTML's block: a table, or what is
 * in a paragraph with an image or chip (with the paragraph's format from Docs' copy). `sliceNodes` are
 * sliceParagraphs' nodes for the copy (one per block); `html`, the HTML's top-level nodes as pasted.
 * Each block's counterpart in the HTML is the next one of its kind, past only empty paragraphs (the HTML
 * has a few the copy doesn't); null when a block that needs one has none.
 */
export function mergeSliceWithHtml(parts: DocsSliceParts, sliceNodes: EditorNode[], html: EditorNode[]): EditorNode[] | null {
  if (sliceNodes.length !== parts.blocks.length) return null;
  const out: EditorNode[] = [];
  // A paragraph with nothing in it but spaces or line breaks (the HTML has some the copy doesn't, as around an image)
  const emptyAt = (k: number) => html[k]?.type === "paragraph" && !squash(nodeText(html[k])) && (html[k].content ?? []).every((c) => c.type === "text" || c.type === "hardBreak");
  let j = 0;
  for (let i = 0; i < parts.blocks.length; i++) {
    const b = parts.blocks[i];
    const node = sliceNodes[i];
    if (b.kind === "paragraph" && b.exact) {
      // Its counterpart, if the HTML has it (it leaves out an empty paragraph before a table). An empty
      // one's may be a line break (Docs writes some empty paragraphs as <p><br><span><br></span></p>)
      // A paragraph of images only before it holds floating images it draws, and is never an empty one's own
      let own: EditorNode | null = null;
      const floats: EditorNode[] = [];
      for (let k = j; k < html.length; k++) {
        const h = html[k];
        const text = h.type === "paragraph" && !imageOnly(h) ? nodeText(h) : null;
        if (text != null && (text.replace(/\u00a0/g, " ") === b.text || (b.text ? squash(text) === squash(b.text) : emptyAt(k) && /^\n*$/.test(text)))) { own = h; j = k + 1; break; }
        if (b.text && imageOnly(h)) { floats.push(...(h.content ?? []).filter((c) => c.type === "image")); continue; }
        if (!emptyAt(k) || !b.text) break;
      }
      const merged = own ? withHtmlImages(node, own) : node;
      out.push(own && floats.length ? { ...merged, content: [...floats, ...(merged.content ?? [])] } : merged);
      continue;
    }
    // A paragraph's counterpart has its text, and its images: one with only an image has no text to go by
    const fits = (h: EditorNode) => b.kind === "table" ? h.type === "table" : h.type === "paragraph" && within(squash(b.text), squash(nodeText(h))) && imagesIn(h) >= (b.images ?? 0);
    let found = -1;
    for (let k = j; k < html.length; k++) {
      if (fits(html[k])) { found = k; break; }
      if (!emptyAt(k)) break;
    }
    // An image the HTML left out: the paragraph by its text, or with none, the empty one in its place
    if (found < 0 && b.images) for (let k = j; k < html.length; k++) {
      if (html[k].type === "paragraph" && (squash(b.text) ? within(squash(b.text), squash(nodeText(html[k]))) : emptyAt(k))) { found = k; break; }
      if (!emptyAt(k)) break;
    }
    if (found < 0) return null;
    // Not the next block's own (as an image's paragraph the HTML left out would find): the copies differ
    const next = parts.blocks[i + 1];
    if (b.kind === "paragraph" && next?.kind === "paragraph" && next.exact && squash(next.text) && squash(next.text) !== squash(b.text) && squash(nodeText(html[found])) === squash(next.text)) return null;
    const h = html[found];
    j = found + 1;
    out.push(b.kind === "table" ? h : { ...h, attrs: { ...(h.attrs ?? {}), ...(node.attrs ?? {}) } });
  }
  // Every image the HTML draws, or the HTML is pasted as it is
  return imageCount(out) < imageCount(html) ? null : out;
}
