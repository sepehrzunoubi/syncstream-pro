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
  if (ps.ps_ltr === false) out.direction = "RIGHT_TO_LEFT";
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

/**
 * Read Docs' clipboard copy. `plain` is the clipboard's text/plain: when it
 * says something else, the slice isn't trusted. Null when the copy has
 * content this can't read exactly.
 */
export function readDocsSlice(raw: unknown, plain?: string | null): DocsSlice | null {
  const r = unwrap(raw);
  if (!r) return null;
  const text = r.dsl_spacers;
  if (!text || STRUCTURAL.test(text)) return null;
  if (plain && comparable(plain) !== comparable(text)) return null;
  // Images, chips and suggestions live outside the text
  for (const v of Object.values(r.dsl_entitypositionmap ?? {})) if (Array.isArray(v) ? v.some((x) => x != null) : v != null) return null;
  for (const t of Object.values(r.dsl_entitytypemap ?? {})) if (t !== "list") return null;
  if (r.dsl_suggestedinsertions?.sgsl_sugg?.length || r.dsl_suggesteddeletions?.sgsl_sugg?.length) return null;

  const slices = new Map<string, StyleSlice>();
  for (const s of r.dsl_styleslices) if (s && typeof s.stsl_type === "string") slices.set(s.stsl_type, s);
  for (const kind of UNREAD) if (slices.get(kind)?.stsl_styles?.some((x) => x != null)) return null;

  const len = text.length;
  const textAt = runs(slices.get("text")?.stsl_styles, len);
  const linkAt = runs(slices.get("link")?.stsl_styles, len);
  const paraAt = runs(slices.get("paragraph")?.stsl_styles, len);
  const listAt = runs(slices.get("list")?.stsl_styles, len);

  const lists: Record<string, docs_v1.Schema$List> = {};
  const content: docs_v1.Schema$StructuralElement[] = [];
  let index = 1;
  let start = 0;
  const endsWithParagraph = text.endsWith("\n");
  while (start < len) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? len : nl + 1;
    const ps = nl < 0 ? slices.get("paragraph")?.stsl_trailing ?? null : paraAt[nl];
    const ls = nl < 0 ? slices.get("list")?.stsl_trailing ?? null : listAt[nl];
    // Runs: where the text style or the link changes
    const elements: docs_v1.Schema$ParagraphElement[] = [];
    let runStart = start;
    for (let i = start + 1; i <= end; i++) {
      if (i < end && textAt[i] === textAt[runStart] && linkAt[i] === linkAt[runStart]) continue;
      elements.push({ startIndex: index + runStart - start, endIndex: index + i - start, textRun: { content: text.slice(runStart, i), textStyle: textStyleOf(textAt[runStart], linkAt[runStart]) } });
      runStart = i;
    }
    const paragraph: docs_v1.Schema$Paragraph = { elements, paragraphStyle: paragraphStyleOf(ps) };
    const listId = typeof ls?.ls_id === "string" ? ls.ls_id : null;
    if (listId) {
      const list = lists[listId] ?? listOf(r.dsl_entitymap?.[listId]);
      if (list) {
        lists[listId] = list;
        paragraph.bullet = { listId, nestingLevel: Math.max(0, Math.min(8, num(ls?.ls_nest) ?? 0)), textStyle: textStyleOf(ls?.ls_ts as Style | undefined) };
      }
    }
    content.push({ startIndex: index, endIndex: index + end - start, paragraph });
    index += end - start;
    start = end;
  }
  return { doc: { body: { content }, lists }, endsWithParagraph, text };
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
