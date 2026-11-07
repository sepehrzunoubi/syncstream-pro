/**
 * A PDF page as paragraphs and tables in reading order.
 *
 * A tagged PDF (Google Docs, Word, Chromium with tags) says which glyphs
 * make each paragraph, heading, list item and table cell: its structure
 * tree is followed. An untagged one is read by its geometry: columns are
 * found by the gutters between them, then lines are grouped into
 * paragraphs by the gaps, indents and styles between them.
 */

import type { Glyph, PageImage, PdfPage, Shape, StructNode } from "./pdf-extract";
import { buildLines, lineOf, type Char, type Line } from "./pdf-lines";
import { findGrids, type Grid, type GridCell } from "./pdf-tables";
import { parseMarker, shapeBullet, type Marker } from "./pdf-lists";

export interface CharStyle {
  family: string;
  weight: number;
  italic: boolean;
  /** Points, as Docs sets it (a superscript keeps its text's size) */
  size: number;
  color: string;
  underline: boolean;
  strike: boolean;
  highlight: string | null;
  link: string | null;
  shift: 0 | 1 | -1;
}

/** A character of a paragraph with its look */
export interface StyledChar {
  ch: string;
  style: CharStyle;
  image?: PageImage;
  /** A line break inside the paragraph (Shift+Enter) */
  br?: true;
}

export interface ParaMarker {
  marker: Marker;
  /** Where the glyph starts and where the text after it starts */
  x: number;
  textX: number;
  style: CharStyle | null;
  /** Read from the text (not a drawn shape), and how sure: a wide gap after it, or a hanging indent */
  strong: boolean;
}

export interface Para {
  kind: "para";
  page: number;
  lines: Line[];
  /** Its structure role (P, H1, LI, Figure…), when the PDF is tagged */
  role: string | null;
  /** Nesting depth of its list in the structure tree */
  structLevel: number | null;
  /** The box it is laid out in: the column, or the table cell */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Reading order on its page */
  order: number;
  inCell: boolean;
  marker: ParaMarker | null;
  /** Shading of the whole paragraph, and the box it fills (its spacing included) */
  shading: string | null;
  shadingBox: { y0: number; y1: number } | null;
  /** Filled in by analyse() */
  chars: StyledChar[];
}

export interface TableCellItem {
  cell: GridCell;
  paras: Para[];
}

export interface TableItem {
  kind: "table";
  page: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  order: number;
  grid: Grid;
  cells: TableCellItem[];
}

export type Item = Para | TableItem;

export interface LayoutContext {
  tagged: boolean;
  /** Whether lists in the structure tree are tagged (L/LI), so a plain P is never a list item */
  structLists: boolean;
  /** The text column's edges across the document, for single-column pages */
  left: number;
  right: number;
  /** Line pitch most text of a size has, by size rounded to half a point */
  pitch: Map<number, number>;
  /** Glyphs of headers, footers and page numbers, read on their own */
  excluded: Set<Glyph>;
  /** The producer hyphenates words at line ends itself (TeX, InDesign); Docs, browsers, Word and LibreOffice don't by default */
  autoHyphens: boolean;
  /** Words the document has on one line, lowercase: whether a word broken at a hyphen is written with it */
  words: Set<string>;
  /** Per page: the shapes that may decorate text, and the small shapes that may be bullets */
  deco: Map<number, Decorations>;
  bullets: Map<number, Shape[]>;
}

const BLOCK_ROLES = new Set(["P", "H", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "Caption", "Title", "Figure", "TOCI", "Note", "Code", "Formula", "Quote", "Subtitle"]);
const CONTAINERS = new Set(["Root", "Document", "DocumentFragment", "Part", "Art", "Sect", "Div", "NonStruct", "BlockQuote", "L", "Table", "TBody", "THead", "TFoot", "TR", "TOC", "Index", "Private", "Aside", ""]);
const isSpace = (s: string) => /^\s+$/.test(s);
const WHITE = "#ffffff";

/** The structure element a glyph's text belongs to as a block */
function blockOf(node: StructNode | undefined | null): StructNode | null {
  if (!node) return null;
  for (let n: StructNode | null = node; n; n = n.parent) if (BLOCK_ROLES.has(n.role)) return itemOf(n) ?? n;
  // No paragraph-like element: the outermost element under a container
  let n: StructNode = node;
  while (n.parent && !CONTAINERS.has(n.parent.role)) n = n.parent;
  return n;
}

/**
 * A list item's first paragraph is the item (Word and LibreOffice tag an item as LI > Lbl + LBody > P):
 * its glyph (in Lbl) and its text are one paragraph. Later paragraphs of the item stay paragraphs.
 */
function itemOf(block: StructNode): StructNode | null {
  if (block.role === "LI" || !/^(P|H\d?)$/.test(block.role)) return null;
  let li: StructNode | null = block.parent;
  while (li && li.role !== "LI") { if (li.role === "L" || BLOCK_ROLES.has(li.role)) return null; li = li.parent; }
  if (!li) return null;
  const first = (n: StructNode): StructNode | null => {
    for (const k of n.kids) { if (k.role === "L") continue; if (/^(P|H\d?)$/.test(k.role)) return k; const f = first(k); if (f) return f; }
    return null;
  };
  return first(li) === block ? li : null;
}

const listDepth = (n: StructNode): number => { let d = 0; for (let p = n.parent; p; p = p.parent) if (p.role === "L") d++; return d; };

// ── Columns ──────────────────────────────────────────────────────────────

interface Atom { x0: number; x1: number; y: number; top: number; bottom: number; glyphs: Glyph[] }

/** Runs of glyphs on one baseline with no wide gap: what columns are cut from */
function atomsOf(glyphs: Glyph[]): Atom[] {
  const sorted = [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Glyph[][] = [];
  for (const g of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - g.y) <= 0.3 * Math.max(row[0].size, g.size)) row.push(g);
    else rows.push([g]);
  }
  const atoms: Atom[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let cur: Atom | null = null;
    for (const g of row) {
      if (isSpace(g.ch)) { if (cur) cur.glyphs.push(g); continue; }
      if (!cur || g.x - cur.x1 > Math.max(g.size * 1.0, 7)) {
        cur = { x0: g.x, x1: g.x + g.w, y: g.y, top: g.y - g.size * 0.8, bottom: g.y + g.size * 0.2, glyphs: [g] };
        atoms.push(cur);
      } else {
        cur.glyphs.push(g);
        cur.x1 = Math.max(cur.x1, g.x + g.w);
        cur.top = Math.min(cur.top, g.y - g.size * 0.8);
        cur.bottom = Math.max(cur.bottom, g.y + g.size * 0.2);
      }
    }
  }
  return atoms;
}

const rowsOf = (atoms: Atom[]) => {
  const ys = [...new Set(atoms.map((a) => Math.round(a.y)))].sort((a, b) => a - b);
  return ys.length;
};

/** Regions of a page, in reading order: bands top to bottom, columns left to right within a band */
function regions(atoms: Atom[], depth = 0): Atom[][] {
  if (atoms.length < 4 || depth > 6) return [atoms];
  const v = verticalCut(atoms);
  if (v) return [...regions(v[0], depth + 1), ...regions(v[1], depth + 1)];
  // A band across the page (a title) above or below columns
  const byTop = [...atoms].sort((a, b) => a.top - b.top);
  const gaps: { at: number; size: number }[] = [];
  let bottom = byTop[0].bottom;
  for (let i = 1; i < byTop.length; i++) {
    if (byTop[i].top > bottom + 1) gaps.push({ at: (bottom + byTop[i].top) / 2, size: byTop[i].top - bottom });
    bottom = Math.max(bottom, byTop[i].bottom);
  }
  for (const gap of gaps.sort((a, b) => b.size - a.size).slice(0, 10)) {
    const above = atoms.filter((a) => a.y < gap.at);
    const below = atoms.filter((a) => a.y >= gap.at);
    if (!above.length || !below.length) continue;
    if (verticalCut(above) || verticalCut(below)) return [...regions(above, depth + 1), ...regions(below, depth + 1)];
  }
  return [atoms];
}

/** A gutter between two columns of text, if there is one */
function verticalCut(atoms: Atom[]): [Atom[], Atom[]] | null {
  const sorted = [...atoms].sort((a, b) => a.x0 - b.x0);
  let reach = sorted[0].x1;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.x0 - reach >= 8) {
      const left = sorted.slice(0, i), right = sorted.slice(i);
      if (columnsLookLikeText(left, right, reach, a.x0)) return [left, right];
    }
    reach = Math.max(reach, a.x1);
  }
  return null;
}

function columnsLookLikeText(left: Atom[], right: Atom[], gapStart: number, gapEnd: number): boolean {
  if (rowsOf(left) < 2 || rowsOf(right) < 2) return false;
  const lTop = Math.min(...left.map((a) => a.top)), lBot = Math.max(...left.map((a) => a.bottom));
  const rTop = Math.min(...right.map((a) => a.top)), rBot = Math.max(...right.map((a) => a.bottom));
  const overlap = Math.min(lBot, rBot) - Math.max(lTop, rTop);
  if (overlap < 0.5 * Math.min(lBot - lTop, rBot - rTop)) return false;
  // Columns of running text: the left one's lines run up to the gutter, the right one's start at one edge
  const lx0 = Math.min(...left.map((a) => a.x0));
  const lw = gapStart - lx0;
  const fullLeft = left.filter((a) => a.x1 >= gapStart - 0.25 * lw).length / left.length;
  const rx0 = Math.min(...right.map((a) => a.x0));
  const flushRight = right.filter((a) => a.x0 - rx0 < 4).length / right.length;
  return fullLeft >= 0.5 && flushRight >= 0.5 && gapEnd - gapStart < 0.4 * (lw + 1);
}

// ── Decorations: highlights, underlines, strikes, links, shading, bullets ─

export interface Decorations {
  fills: Shape[];
  thin: Shape[];
  links: PdfPage["links"];
}

function decorationsOf(page: PdfPage, used: Set<Shape>): Decorations {
  const area = page.width * page.height;
  const fills: Shape[] = [];
  const thin: Shape[] = [];
  for (const s of page.shapes) {
    if (used.has(s) || !s.rect) continue;
    const w = s.x1 - s.x0, h = s.y1 - s.y0;
    if (h <= 2.2 && w >= 1) thin.push(s);
    else if (s.fill && s.fill !== WHITE && w * h < 0.6 * area) fills.push(s);
  }
  return { fills, thin, links: page.links };
}

/** Shapes by the bands of the page they cross, so a character only looks at the shapes near it */
const BAND = 24;
interface Bands { fills: Map<number, Shape[]>; thin: Map<number, Shape[]>; links: Map<number, PdfPage["links"]> }
const bandCache = new WeakMap<Decorations, Bands>();
function bandsOf(deco: Decorations): Bands {
  const hit = bandCache.get(deco);
  if (hit) return hit;
  const index = <T extends { y0: number; y1: number }>(xs: T[]) => {
    const m = new Map<number, T[]>();
    for (const x of xs) for (let b = Math.floor(x.y0 / BAND); b <= Math.floor(x.y1 / BAND); b++) push(m, b, x);
    return m;
  };
  const bands = { fills: index(deco.fills), thin: index(deco.thin), links: index(deco.links) };
  bandCache.set(deco, bands);
  return bands;
}
const at = <T>(m: Map<number, T[]>, y: number): T[] => m.get(Math.floor(y / BAND)) ?? [];

function styleOf(c: Char, line: Line, deco: Decorations): CharStyle {
  const g = c.glyph;
  const f = g?.font;
  const size = c.shift ? line.size : c.size;
  const style: CharStyle = {
    family: f?.docs.family ?? "Arial",
    weight: Math.max(f?.docs.weight ?? 400, g?.fakeBold ? 700 : 0),
    italic: !!(f?.docs.italic || g?.fakeItalic),
    size: Math.round(size * 2) / 2,
    color: g?.color ?? "#000000",
    underline: false,
    strike: false,
    highlight: null,
    link: null,
    shift: c.shift,
  };
  if (!g && !c.image) return style;
  const cx = (c.x0 + c.x1) / 2;
  const y = c.y;
  const s = c.size;
  const bands = bandsOf(deco);
  for (const r of at(bands.fills, y - 0.25 * s)) {
    if (r.x0 - 0.5 <= cx && cx <= r.x1 + 0.5 && r.y0 <= y - 0.45 * s && r.y1 >= y - 0.05 * s && r.y1 - r.y0 < 2.6 * s) style.highlight = r.fill;
  }
  if (g && !isSpace(c.ch)) {
    const near = new Set([...at(bands.thin, y - 0.5 * s), ...at(bands.thin, y), ...at(bands.thin, y + 0.35 * s)]);
    for (const r of near) {
      if (r.x0 > cx || r.x1 < cx) continue;
      const mid = (r.y0 + r.y1) / 2;
      if (r.y1 - r.y0 > Math.max(1.8, 0.14 * s)) continue;
      if (mid > y && mid < y + 0.32 * s) style.underline = true;
      else if (mid < y - 0.12 * s && mid > y - 0.5 * s) style.strike = true;
    }
  }
  for (const l of at(bands.links, y - 0.3 * s)) {
    if (l.url && l.x0 - 1 <= cx && cx <= l.x1 + 1 && l.y0 - 1 <= y - 0.3 * s && y - 0.3 * s <= l.y1 + 1) { style.link = l.url; break; }
  }
  return style;
}

// ── Building paragraphs ───────────────────────────────────────────────────

function newPara(page: number, lines: Line[], box: { left: number; right: number }, order: number, extra: Partial<Para> = {}): Para {
  return {
    kind: "para", page, lines, role: null, structLevel: null, left: box.left, right: box.right,
    top: Math.min(...lines.map((l) => l.top)), bottom: Math.max(...lines.map((l) => l.bottom)),
    order, inCell: false, marker: null, shading: null, shadingBox: null, chars: [], ...extra,
  };
}

/** The pitch between two lines of this size that are in one paragraph */
function pitchFor(ctx: LayoutContext, size: number): number {
  return ctx.pitch.get(Math.round(size * 2) / 2) ?? size * 1.2;
}

const firstWordWidth = (l: Line) => {
  let w = 0;
  for (const c of l.chars) { if (isSpace(c.ch) && w > 0) break; if (!isSpace(c.ch)) w += c.x1 - c.x0; }
  return w;
};

const textStart = (l: Line) => l.chars.find((c) => !isSpace(c.ch));
const boldShare = (l: Line) => {
  let b = 0, n = 0;
  for (const c of l.chars) { if (!c.glyph || isSpace(c.ch)) continue; n++; if ((c.glyph.font.docs.weight >= 600) || c.glyph.fakeBold) b++; }
  return n ? b / n : 0;
};

/** Whether a line starts with a list marker (and where its text starts) */
function markerAt(l: Line): { marker: Marker; x: number; textX: number; chars: Char[]; strong: boolean } | null {
  const chars = l.chars.filter((c) => !c.image);
  let i = 0;
  while (i < chars.length && isSpace(chars[i].ch)) i++;
  let j = i;
  while (j < chars.length && !isSpace(chars[j].ch) && j - i < 8) j++;
  if (j === i) return null;
  let word = chars.slice(i, j).map((c) => c.ch).join("");
  let marker = parseMarker(word);
  // A marker with no space drawn after it ("10.Ivan"): the gap before its text shows where it ends
  for (let e = i + 1; !marker && e < j && e - i <= 6; e++) {
    if (chars[e].x0 - chars[e - 1].x1 < 1) continue;
    const m = parseMarker(chars.slice(i, e).map((c) => c.ch).join(""));
    if (m) { marker = m; j = e; word = chars.slice(i, e).map((c) => c.ch).join(""); }
  }
  if (!marker) return null;
  let k = j;
  while (k < chars.length && isSpace(chars[k].ch)) k++;
  const next = chars[k];
  const end = Math.max(...chars.slice(i, j).map((c) => c.x1));
  // Only a glyph: an empty list item (a bullet, not a number, which could be anything)
  if (!next) return marker.kind === "ordered" ? null : { marker, x: chars[i].x0, textX: NaN, chars: chars.slice(i), strong: !["-", "*", "o"].includes(word) };
  const gap = next.x0 - end;
  const em = chars[i].size || l.size;
  if (gap < 1) return null;
  // Bullets no sentence starts with are sure; numbers, dashes and "o" need a list's wide gap after them
  const sure = marker.kind !== "ordered" && !["-", "*", "o", "–", "—"].includes(word);
  return { marker, x: chars[i].x0, textX: next.x0, chars: chars.slice(i, k), strong: sure || gap >= 0.45 * em };
}

/** Group the lines of one column (or cell) into paragraphs, by their gaps, indents and looks */
function segment(lines: Line[], box: { left: number; right: number }, ctx: LayoutContext): Line[][] {
  const out: Line[][] = [];
  let cur: Line[] = [];
  lines.forEach((line, i) => {
    if (!cur.length) { cur.push(line); return; }
    const prev = cur[cur.length - 1];
    if (startsNew(cur, prev, line, box, ctx, lines[i + 1])) { out.push(cur); cur = [line]; }
    else cur.push(line);
  });
  if (cur.length) out.push(cur);
  return out;
}

function startsNew(cur: Line[], prev: Line, line: Line, box: { left: number; right: number }, ctx: LayoutContext, after?: Line): boolean {
  if (line.page !== prev.page || line.rtl !== prev.rtl) return true;
  if (markerAt(line)) return true;
  const dy = line.y - prev.y;
  if (dy <= 0) return true;
  if (Math.abs(line.size - prev.size) > 0.12 * Math.max(line.size, prev.size)) return true;
  const expected = cur.length >= 2 ? (cur[cur.length - 1].y - cur[0].y) / (cur.length - 1) : pitchFor(ctx, prev.size);
  if (dy > expected * 1.22 + 0.8) {
    // Wider than the document's lines, but the line before wrapped and the line after follows at the
    // same pitch: a paragraph with wider line spacing (double spaced)
    const wrapped = box.right - prev.x1 < firstWordWidth(line) + 0.6 * prev.size;
    const same = after && after.page === line.page && Math.abs(after.y - line.y - dy) < 0.6 && Math.abs(after.x0 - line.x0) < 1.5 && Math.abs(after.size - line.size) < 0.3;
    if (!(cur.length === 1 && wrapped && same && dy <= 2.6 * prev.size && box.right - line.x1 < firstWordWidth(after) + 0.6 * line.size)) return true;
  }
  // A bold line on its own (a heading run in) above regular text
  if (cur.length === 1 && boldShare(prev) > 0.9 && boldShare(line) < 0.5) return true;
  const em = prev.size;
  const mid = (l: Line) => (l.x0 + l.x1) / 2;
  const centered = Math.abs(mid(prev) - mid(line)) < 2 && Math.abs(prev.x0 - line.x0) > 2;
  const rightAligned = Math.abs(prev.x1 - line.x1) < 1.5 && Math.abs(prev.x0 - line.x0) > 2 && Math.abs(line.x1 - box.right) < 3;
  if (!centered && !rightAligned) {
    // A list item's next lines start under its text, not under its glyph
    const m = cur.length === 1 ? markerAt(cur[0]) : null;
    const cont = cur.length >= 2 ? cur[1].x0 : m && Number.isFinite(m.textX) ? m.textX : null;
    if (cont != null && Math.abs(line.x0 - cont) > 1.5) return true;
    if (cont == null && line.x0 > prev.x0 + 0.5 * em) return true;
  }
  // The line before stopped short although this line's first word would have fit: it ended its paragraph
  const room = centered ? (box.right - box.left) - (prev.x1 - prev.x0) : rightAligned || prev.rtl ? prev.x0 - box.left : box.right - prev.x1;
  const space = 0.3 * em;
  if (room > firstWordWidth(line) + space * 2 + 1) return true;
  return false;
}

/** Images in a line of text: on its baseline, beside its glyphs */
function inlineImages(images: PageImage[], lines: Line[]): Map<Line, PageImage[]> {
  const out = new Map<Line, PageImage[]>();
  for (const img of images) {
    let best: Line | null = null;
    let bestD = Infinity;
    for (const l of lines) {
      const d = Math.abs(img.y1 - l.y);
      if (d > 0.45 * l.size + 2) continue;
      if (img.y1 - img.y0 > 30 * l.size) continue;
      // Not over the line's own text
      const over = l.chars.some((c) => c.glyph && !isSpace(c.ch) && c.x0 < img.x1 - 1 && c.x1 > img.x0 + 1);
      if (over) continue;
      if (d < bestD) { best = l; bestD = d; }
    }
    if (best) push(out, best, img);
  }
  return out;
}

/** Rebuild a line with images placed in it */
function withImages(l: Line, imgs: PageImage[] | undefined): Line {
  if (!imgs?.length) return l;
  const glyphs = l.chars.map((c) => c.glyph).filter((g): g is Glyph => !!g);
  const next = lineOf(glyphs, l.page, imgs);
  return { ...next, y: l.y, size: l.size };
}

/** An image on its own line, as a paragraph */
function imagePara(img: PageImage, page: number, box: { left: number; right: number }, order: number, size: number): Para {
  const line: Line = {
    chars: [{ ch: "\uFFFC", x0: img.x0, x1: img.x1, y: img.y1, size, glyph: null, image: img, shift: 0 }],
    x0: img.x0, x1: img.x1, y: img.y1, size, top: img.y0, bottom: img.y1, rtl: false, page,
  };
  return newPara(page, [line], box, order, { role: "Figure" });
}

/**
 * The page's paragraphs and tables in reading order. `ctx.excluded` holds the glyphs of its header,
 * footer and page numbers.
 */
export function pageItems(page: PdfPage, ctx: LayoutContext): Item[] {
  const n = page.index;
  const grids = findGrids(page.shapes, page);
  const used = new Set<Shape>();
  for (const g of grids) for (const s of g.used) used.add(s);
  const body = page.glyphs.filter((g) => !ctx.excluded.has(g));
  // What's in a table goes to its cells
  const inGrid = (x: number, y: number) => grids.findIndex((g) => x >= g.x0 - 0.5 && x <= g.x1 + 0.5 && y >= g.y0 - 0.5 && y <= g.y1 + 0.5);
  const gridGlyphs = grids.map(() => [] as Glyph[]);
  const gridImages = grids.map(() => [] as PageImage[]);
  const flowGlyphs: Glyph[] = [];
  for (const g of body) {
    const k = inGrid(g.x + g.w / 2, g.y - g.size * 0.3);
    if (k >= 0) gridGlyphs[k].push(g); else flowGlyphs.push(g);
  }
  const images = page.images.filter((i) => i.encoded !== undefined && contentImage(i, page));
  const flowImages: PageImage[] = [];
  for (const img of images) {
    const k = inGrid((img.x0 + img.x1) / 2, (img.y0 + img.y1) / 2);
    if (k >= 0) gridImages[k].push(img); else flowImages.push(img);
  }
  // Bullets drawn as shapes: small round or square marks left of a line's text
  const bulletShapes = page.shapes.filter((s) => !used.has(s) && (s.fill || s.stroke) && s.fill !== WHITE && s.x1 - s.x0 >= 1.2 && s.x1 - s.x0 <= 8 && s.y1 - s.y0 >= 1.2 && s.y1 - s.y0 <= 8 && Math.abs((s.x1 - s.x0) - (s.y1 - s.y0)) < 1.5);
  const deco = decorationsOf(page, used);

  const items: Item[] = [];
  let order = 0;
  if (ctx.tagged && page.struct) {
    // Glyphs by the structure element they belong to, in the tree's order
    const blocks = new Map<StructNode, Glyph[]>();
    const loose: Glyph[] = [];
    for (const g of flowGlyphs) {
      const node = g.mcid != null ? page.struct.byMcid.get(g.mcid) : undefined;
      const b = blockOf(node);
      if (!b || g.artifact) { loose.push(g); continue; }
      push(blocks, b, g);
    }
    const blockImages = new Map<StructNode, PageImage[]>();
    const looseImages: PageImage[] = [];
    for (const img of flowImages) {
      let b = blockOf(img.mcid != null ? page.struct.byMcid.get(img.mcid) : undefined);
      // A figure inside a paragraph is an image in its text
      for (let a = b?.parent ?? null; b?.role === "Figure" && a; a = a.parent) if (/^(P|H\d?|LI|TD|TH|Caption)$/.test(a.role)) { b = a; break; }
      if (b) push(blockImages, b, img); else looseImages.push(img);
    }
    const all = [...new Set([...blocks.keys(), ...blockImages.keys()])].sort((a, b) => a.order - b.order);
    // A table the structure tree has and no rules draw: its rows and cells from the tree
    const tables = new Map<StructNode, StructNode[]>();
    for (const node of all) { const t = tableOf(node); if (t) push(tables, t, node); }
    for (const [t, members] of tables) {
      const table = structTable(t, members, blocks, blockImages, page, ctx, deco);
      if (table) items.push(table);
    }
    const nodes = all.filter((node) => !tableOf(node));
    const colBox = columnBoxes(nodes.flatMap((node) => blocks.get(node) ?? []), ctx, page);
    for (const node of nodes) {
      const glyphs = blocks.get(node) ?? [];
      const imgs = blockImages.get(node) ?? [];
      const lines = buildLines(glyphs, n);
      const box = colBox(glyphs[0] ?? null);
      const generic = !BLOCK_ROLES.has(node.role) || node.role === "Figure";
      const placed = inlineImages(imgs, lines);
      const own = imgs.filter((i) => ![...placed.values()].some((l) => l.includes(i)));
      const ready = lines.map((l) => withImages(l, placed.get(l)));
      const groups = generic && ready.length > 1 ? segment(ready, box, ctx) : ready.length ? [ready] : [];
      const paras = groups.map((ls) => newPara(n, ls, box, order++, { role: node.role, structLevel: node.role === "LI" ? listDepth(node) - 1 : null }));
      for (const img of own) paras.push(imagePara(img, n, box, order++, 11));
      paras.sort((a, b) => a.top - b.top);
      items.push(...paras);
    }
    // Untagged text in a tagged page: read by geometry, placed by where it is
    if (loose.length || looseImages.length) for (const p of untaggedItems(loose, looseImages, page, ctx, () => order++)) items.push(p);
  } else {
    for (const p of untaggedItems(flowGlyphs, flowImages, page, ctx, () => order++)) items.push(p);
  }
  // Tables, each where its top is among the page's items
  grids.forEach((grid, k) => {
    // A frame around nothing (a colour swatch, a box in a drawing) isn't a table
    if (!gridGlyphs[k].some((g) => !isSpace(g.ch)) && !gridImages[k].length) return;
    const table = tableItem(grid, gridGlyphs[k], gridImages[k], page, ctx);
    if (table) items.push(table);
  });
  orderItems(items, ctx.tagged && !!page.struct);
  ctx.deco.set(n, deco);
  ctx.bullets.set(n, bulletShapes);
  return items;
}

/** An image that is part of the content: not a speck, and not a picture of the whole page (a scan, a background) */
export function contentImage(i: PageImage, page: { width: number; height: number }): boolean {
  return i.x1 - i.x0 >= 3 && i.y1 - i.y0 >= 3 && (i.x1 - i.x0) * (i.y1 - i.y0) < 0.85 * page.width * page.height;
}

/** The column box a glyph's text is in, from the page's columns (one column: the document's edges) */
function columnBoxes(glyphs: Glyph[], ctx: LayoutContext, page: PdfPage): (g: Glyph | null) => { left: number; right: number } {
  const regs = regions(atomsOf(glyphs.filter((g) => !isSpace(g.ch))));
  if (regs.length <= 1) return () => ({ left: ctx.left, right: ctx.right });
  const boxes = regs.map((r) => ({ left: Math.min(...r.map((a) => a.x0)), right: Math.max(...r.map((a) => a.x1)), top: Math.min(...r.map((a) => a.top)), bottom: Math.max(...r.map((a) => a.bottom)) }));
  const single = boxes.every((b) => b.right - b.left > 0.75 * (ctx.right - ctx.left));
  if (single) return () => ({ left: ctx.left, right: ctx.right });
  return (g) => {
    if (!g) return { left: ctx.left, right: ctx.right };
    const b = boxes.find((b) => g.x >= b.left - 1 && g.x <= b.right + 1 && g.y >= b.top - 1 && g.y <= b.bottom + g.size) ?? null;
    if (!b) return { left: ctx.left, right: Math.min(page.width, ctx.right) };
    // A column as wide as the page is the page's text column
    return b.right - b.left > 0.75 * (ctx.right - ctx.left) ? { left: ctx.left, right: ctx.right } : { left: b.left, right: b.right };
  };
}

/** Paragraphs of text with no structure: columns, then lines, then paragraphs */
function untaggedItems(glyphs: Glyph[], images: PageImage[], page: PdfPage, ctx: LayoutContext, next: () => number): Para[] {
  const n = page.index;
  const regs = glyphs.length ? regions(atomsOf(glyphs)) : [];
  const multi = regs.length > 1 && !regs.every((r) => Math.max(...r.map((a) => a.x1)) - Math.min(...r.map((a) => a.x0)) > 0.75 * (ctx.right - ctx.left));
  const boxes = regs.map((reg) => {
    const x0 = Math.min(...reg.map((a) => a.x0)), x1 = Math.max(...reg.map((a) => a.x1));
    return { box: multi && x1 - x0 < 0.75 * (ctx.right - ctx.left) ? { left: x0, right: x1 } : { left: ctx.left, right: ctx.right }, x0, x1, top: Math.min(...reg.map((a) => a.top)), bottom: Math.max(...reg.map((a) => a.bottom)) };
  });
  // Each image in the region (column) its middle is in; one between regions goes with the nearest
  const regionOf = (img: PageImage) => {
    const cx = (img.x0 + img.x1) / 2, cy = (img.y0 + img.y1) / 2;
    let best = -1, bestD = Infinity;
    boxes.forEach((b, k) => {
      const dx = cx < b.x0 ? b.x0 - cx : cx > b.x1 ? cx - b.x1 : 0;
      const dy = cy < b.top ? b.top - cy : cy > b.bottom ? cy - b.bottom : 0;
      if (dx * 4 + dy < bestD) { bestD = dx * 4 + dy; best = k; }
    });
    return best;
  };
  const byRegion = regs.map(() => [] as PageImage[]);
  const homeless: PageImage[] = [];
  for (const img of images) { const k = regionOf(img); if (k >= 0) byRegion[k].push(img); else homeless.push(img); }
  const out: Para[] = [];
  regs.forEach((reg, k) => {
    const { box } = boxes[k];
    const lines = buildLines(reg.flatMap((a) => a.glyphs), n);
    const placed = inlineImages(byRegion[k], lines);
    const ready = lines.map((l) => withImages(l, placed.get(l)));
    const paras = segment(ready, box, ctx).map((ls) => newPara(n, ls, box, 0));
    const inline = new Set([...placed.values()].flat());
    for (const img of byRegion[k]) if (!inline.has(img)) paras.push(imagePara(img, n, box, 0, 11));
    // Top to bottom within the column
    paras.sort((a, b) => a.top - b.top);
    for (const p of paras) { p.order = next(); out.push(p); }
  });
  for (const img of homeless) out.push(imagePara(img, n, { left: ctx.left, right: ctx.right }, next(), 11));
  return out;
}

/**
 * Items in reading order: the structure tree's (or the columns') order, with each item that came from
 * elsewhere (a table, an image, untagged text) placed before the first item below it in its column
 */
function orderItems(items: Item[], tagged: boolean) {
  const flow = items.filter((i) => i.kind === "para" && (tagged ? i.role !== null : true)) as Para[];
  const others = items.filter((i) => !flow.includes(i as Para));
  flow.sort((a, b) => a.order - b.order);
  const result: Item[] = [...flow];
  for (const o of others.sort((a, b) => a.top - b.top)) {
    const at = result.findIndex((r) => r.top >= o.top - 1 && overlapsX(r, o));
    if (at < 0) result.push(o); else result.splice(at, 0, o);
  }
  items.length = 0;
  items.push(...result);
}
const overlapsX = (a: Item, b: Item) => {
  const ax0 = a.kind === "para" ? a.left : a.left, ax1 = a.kind === "para" ? a.right : a.right;
  const bx0 = b.kind === "para" ? b.left : b.left, bx1 = b.kind === "para" ? b.right : b.right;
  return Math.min(ax1, bx1) - Math.max(ax0, bx0) > 0;
};

const tableOf = (n: StructNode): StructNode | null => { for (let p: StructNode | null = n; p; p = p.parent) if (p.role === "Table") return p; return null; };
const cellOf = (n: StructNode): StructNode | null => { for (let p: StructNode | null = n; p; p = p.parent) if (p.role === "TD" || p.role === "TH") return p; return null; };

/**
 * A table from the structure tree (Table, TR, TD/TH and their spans) whose cells no rules draw: its
 * columns are where its cells' text sits, a cell's background the filled box behind its text.
 */
function structTable(t: StructNode, members: StructNode[], blocks: Map<StructNode, Glyph[]>, blockImages: Map<StructNode, PageImage[]>, page: PdfPage, ctx: LayoutContext, deco: Decorations): TableItem | null {
  const n = page.index;
  const rows: StructNode[][] = [];
  const walk = (node: StructNode) => {
    for (const k of node.kids) {
      if (k.role === "TR") rows.push(k.kids.filter((c) => c.role === "TD" || c.role === "TH"));
      else if (/^(THead|TBody|TFoot)$/.test(k.role)) walk(k);
    }
  };
  walk(t);
  if (!rows.length) return null;
  // Columns: each cell in the first free column of its row, rows spanned taken
  const taken: Set<number>[] = rows.map(() => new Set());
  const placedCells: { node: StructNode; row: number; col: number; colspan: number; rowspan: number }[] = [];
  rows.forEach((cells, r) => {
    let c = 0;
    for (const node of cells) {
      while (taken[r].has(c)) c++;
      const colspan = Math.max(1, node.colSpan ?? 1), rowspan = Math.max(1, Math.min(rows.length - r, node.rowSpan ?? 1));
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) taken[r + dr].add(c + dc);
      placedCells.push({ node, row: r, col: c, colspan, rowspan });
      c += colspan;
    }
  });
  const cols = Math.max(...taken.map((s) => (s.size ? Math.max(...s) + 1 : 0)));
  if (!cols) return null;
  // Each cell's lines, from the blocks inside it
  const memberSet = new Set(members);
  const cellLines = new Map<StructNode, { blocks: { node: StructNode; lines: Line[]; images: PageImage[] }[]; x0: number; x1: number; y0: number; y1: number }>();
  for (const pc of placedCells) {
    const inside = [...memberSet].filter((m) => cellOf(m) === pc.node).sort((a, b) => a.order - b.order);
    const bl = inside.map((node) => ({ node, lines: buildLines(blocks.get(node) ?? [], n), images: blockImages.get(node) ?? [] }));
    const ls = bl.flatMap((b) => b.lines);
    const imgs = bl.flatMap((b) => b.images);
    const x0 = Math.min(...ls.map((l) => l.x0), ...imgs.map((i) => i.x0)), x1 = Math.max(...ls.map((l) => l.x1), ...imgs.map((i) => i.x1));
    const y0 = Math.min(...ls.map((l) => l.top), ...imgs.map((i) => i.y0)), y1 = Math.max(...ls.map((l) => l.bottom), ...imgs.map((i) => i.y1));
    cellLines.set(pc.node, { blocks: bl, x0, x1, y0, y1 });
  }
  const filled = placedCells.filter((pc) => Number.isFinite(cellLines.get(pc.node)!.x0));
  if (!filled.length) return null;
  // Column edges halfway between one column's text and the next's; rows likewise
  const pad = 5;
  const xs: number[] = [Math.min(...filled.filter((pc) => pc.col === 0).map((pc) => cellLines.get(pc.node)!.x0), Infinity) - pad];
  for (let c = 1; c < cols; c++) {
    const before = filled.filter((pc) => pc.col + pc.colspan === c).map((pc) => cellLines.get(pc.node)!.x1);
    const after = filled.filter((pc) => pc.col === c).map((pc) => cellLines.get(pc.node)!.x0);
    const edge = before.length && after.length ? (Math.max(...before) + Math.min(...after)) / 2 : after.length ? Math.min(...after) - pad : before.length ? Math.max(...before) + pad : xs[c - 1] + 36;
    xs.push(Math.max(edge, xs[c - 1] + 6));
  }
  xs.push(Math.max(...filled.filter((pc) => pc.col + pc.colspan === cols).map((pc) => cellLines.get(pc.node)!.x1), xs[cols - 1] + 12) + pad);
  if (!Number.isFinite(xs[0])) xs[0] = Math.min(...filled.map((pc) => cellLines.get(pc.node)!.x0)) - pad;
  const ys: number[] = [Math.min(...filled.filter((pc) => pc.row === 0).map((pc) => cellLines.get(pc.node)!.y0), Infinity) - pad];
  for (let r = 1; r < rows.length; r++) {
    const above = filled.filter((pc) => pc.row + pc.rowspan === r).map((pc) => cellLines.get(pc.node)!.y1);
    const below = filled.filter((pc) => pc.row === r).map((pc) => cellLines.get(pc.node)!.y0);
    const edge = above.length && below.length ? (Math.max(...above) + Math.min(...below)) / 2 : below.length ? Math.min(...below) - pad : ys[r - 1] + 14;
    ys.push(Math.max(edge, ys[r - 1] + 4));
  }
  ys.push(Math.max(...filled.map((pc) => cellLines.get(pc.node)!.y1)) + pad);
  if (!Number.isFinite(ys[0])) ys[0] = Math.min(...filled.map((pc) => cellLines.get(pc.node)!.y0)) - pad;
  const used = new Set<Shape>();
  const cells: TableCellItem[] = placedCells.map((pc) => {
    const info = cellLines.get(pc.node)!;
    const cell: GridCell = { row: pc.row, col: pc.col, rowspan: pc.rowspan, colspan: pc.colspan, x0: xs[pc.col], x1: xs[pc.col + pc.colspan], y0: ys[pc.row], y1: ys[pc.row + pc.rowspan], background: null };
    // Its background: the smallest filled box behind its text
    if (Number.isFinite(info.x0)) {
      const cx = (info.x0 + info.x1) / 2, cy = (info.y0 + info.y1) / 2;
      const behind = deco.fills.filter((f) => f.x0 <= cx && f.x1 >= cx && f.y0 <= cy && f.y1 >= cy && f.x1 - f.x0 <= (xs[cols] - xs[0]) + 2).sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
      if (behind[0]) { cell.background = behind[0].fill; used.add(behind[0]); cell.x0 = Math.min(cell.x0, behind[0].x0); }
    }
    const box = { left: cell.x0 + pad, right: cell.x1 - pad };
    const paras: Para[] = [];
    let order = 0;
    for (const b of info.blocks) {
      const placed = inlineImages(b.images, b.lines);
      const ready = b.lines.map((l) => withImages(l, placed.get(l)));
      if (ready.length) paras.push(newPara(n, ready, box, order++, { role: b.node.role, structLevel: b.node.role === "LI" ? listDepth(b.node) - 1 : null, inCell: true }));
      for (const img of b.images) if (![...placed.values()].some((l) => l.includes(img))) paras.push(imagePara(img, n, box, order++, 11));
    }
    return { cell, paras };
  });
  deco.fills = deco.fills.filter((f) => !used.has(f));
  const grid: Grid = { x0: xs[0], y0: ys[0], x1: xs[cols], y1: ys[rows.length], xs, ys, cells: cells.map((c) => c.cell), used };
  return { kind: "table", page: n, top: grid.y0, bottom: grid.y1, left: grid.x0, right: grid.x1, order: -1, grid, cells };
}

function tableItem(grid: Grid, glyphs: Glyph[], images: PageImage[], page: PdfPage, ctx: LayoutContext): TableItem | null {
  const n = page.index;
  const cells: TableCellItem[] = grid.cells.map((cell) => ({ cell, paras: [] }));
  const byCell = cells.map(() => [] as Glyph[]);
  const imgByCell = cells.map(() => [] as PageImage[]);
  const find = (x: number, y: number) => cells.findIndex((c) => x >= c.cell.x0 - 0.5 && x <= c.cell.x1 + 0.5 && y >= c.cell.y0 - 0.5 && y <= c.cell.y1 + 0.5);
  for (const g of glyphs) { const k = find(g.x + g.w / 2, g.y - g.size * 0.3); if (k >= 0) byCell[k].push(g); }
  for (const img of images) { const k = find((img.x0 + img.x1) / 2, (img.y0 + img.y1) / 2); if (k >= 0) imgByCell[k].push(img); }
  cells.forEach((c, k) => {
    const lines = buildLines(byCell[k], n);
    // The cell's text box: its padding is how far its text sits from its edges
    const pad = lines.length ? Math.max(0, Math.min(...lines.map((l) => l.x0)) - c.cell.x0) : 5;
    const inner = { left: c.cell.x0 + Math.min(pad, 12), right: c.cell.x1 - Math.min(pad, 12) };
    const placed = inlineImages(imgByCell[k], lines);
    const ready = lines.map((l) => withImages(l, placed.get(l)));
    let order = 0;
    // Tagged cells keep their structure's paragraphs; other cells split on gaps and markers
    const groups = page.struct && ctx.tagged ? splitByStruct(ready, page) : segment(ready, inner, ctx);
    for (const ls of groups) c.paras.push(newPara(n, ls, inner, order++, { inCell: true }));
    for (const img of imgByCell[k]) if (![...placed.values()].some((l) => l.includes(img))) c.paras.push(imagePara(img, n, inner, order++, 11));
    c.paras.sort((a, b) => a.top - b.top);
  });
  return { kind: "table", page: n, top: grid.y0, bottom: grid.y1, left: grid.x0, right: grid.x1, order: -1, grid, cells };
}

/** Lines of a tagged cell grouped by the paragraph elements they belong to */
function splitByStruct(lines: Line[], page: PdfPage): Line[][] {
  const out: Line[][] = [];
  let key: StructNode | null | undefined;
  for (const l of lines) {
    const g = l.chars.find((c) => c.glyph && c.glyph.mcid != null)?.glyph;
    const node = g && g.mcid != null ? page.struct!.byMcid.get(g.mcid) : null;
    let b: StructNode | null = node ?? null;
    while (b && !["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI"].includes(b.role) && b.parent && !["TD", "TH"].includes(b.role)) b = b.parent;
    if (out.length && b === key) out[out.length - 1].push(l);
    else { out.push([l]); key = b; }
  }
  return out;
}

// ── One paragraph: its marker, its characters and their look ───────────────

/**
 * A paragraph's list marker (text it starts with, or a shape just left of it) and its shading. The
 * marker stays in its text until the document's lists are settled (see settleMarker).
 */
export function findMarker(p: Para, ctx: LayoutContext) {
  const first = p.lines[0];
  if (!first) return;
  const deco = ctx.deco.get(first.page) ?? { fills: [], thin: [], links: [] };
  const bulletShapes = ctx.bullets.get(first.page) ?? [];
  const m = p.role === "Figure" ? null : markerAt(first);
  const allowText = !ctx.tagged || !ctx.structLists || p.role === "LI" || p.role === null;
  const s0 = textStart(first);
  if (m && allowText && !/^H\d?$|^Title$/.test(p.role ?? "")) {
    const styleChar = m.chars.find((c) => c.glyph && !isSpace(c.ch));
    p.marker = { marker: m.marker, x: m.x, textX: m.textX, style: styleChar ? styleOf(styleChar, first, deco) : null, strong: m.strong || p.role === "LI" };
    markerChars.set(p, new Set(m.chars));
  } else if (s0 && p.role !== "Figure") {
    const shape = bulletShapes.find((s) => s.x1 <= s0.x0 - 0.5 && s.x0 >= s0.x0 - 3 * first.size && (s.y0 + s.y1) / 2 <= first.y + 0.1 * first.size && (s.y0 + s.y1) / 2 >= first.y - 0.8 * first.size);
    if (shape && (!ctx.tagged || !ctx.structLists || p.role === "LI")) {
      p.marker = { marker: shapeBullet(shape), x: shape.x0, textX: s0.x0, style: { ...styleOf(s0, first, deco), color: shape.fill ?? shape.stroke ?? "#000000" }, strong: true };
    }
  }
  // Shading: a filled box under the paragraph, from where its text starts to its right edge
  const x0 = Math.min(...p.lines.map((l) => l.x0), p.marker?.x ?? Infinity);
  const shade = deco.fills.find((r) => r.x1 >= p.right - 1.5 && r.x0 <= x0 + 1 && r.y1 >= first.y - 0.3 * first.size && r.y0 <= first.y);
  if (shade) {
    p.shading = shade.fill;
    const boxes = deco.fills.filter((r) => r.fill === shade.fill && r.x1 >= p.right - 1.5 && r.y1 >= p.top - 1 && r.y0 <= p.bottom + 1 && r.x0 <= x0 + 1);
    p.shadingBox = { y0: Math.min(...boxes.map((b) => b.y0)), y1: Math.max(...boxes.map((b) => b.y1)) };
    shadingOf.set(p, new Set(boxes));
  }
}

const markerChars = new WeakMap<Para, Set<Char>>();
const shadingOf = new WeakMap<Para, Set<Shape>>();

/** Take a paragraph's marker out of its text (it is a list item), or forget it (it isn't) */
export function settleMarker(p: Para, isItem: boolean) {
  if (!p.marker) return;
  if (!isItem) { p.marker = null; markerChars.delete(p); return; }
  const drop = markerChars.get(p);
  if (drop) p.lines[0] = { ...p.lines[0], chars: p.lines[0].chars.filter((c) => !drop.has(c)), x0: p.marker.textX };
  markerChars.delete(p);
}

/** The paragraph's characters with their looks, its lines joined as Docs wraps them */
export function buildChars(p: Para, ctx: LayoutContext) {
  p.chars = [];
  const skip = shadingOf.get(p);
  p.lines.forEach((line, li) => {
    const pageDeco = ctx.deco.get(line.page) ?? { fills: [], thin: [], links: [] };
    const deco = skip ? { ...pageDeco, fills: pageDeco.fills.filter((r) => !skip.has(r)) } : pageDeco;
    const styled = line.chars.map((c) => ({ c, s: styleOf(c, line, deco) }));
    // Spaces take the look of the text around them; a space between two underlined (linked,
    // highlighted) words is underlined too, as Docs has it
    for (let i = 0; i < styled.length; i++) {
      const cur = styled[i];
      if (!isSpace(cur.c.ch)) continue;
      let prev: (typeof styled)[number] | undefined;
      for (let k = i - 1; k >= 0; k--) if (!isSpace(styled[k].c.ch)) { prev = styled[k]; break; }
      let nxt: (typeof styled)[number] | undefined;
      for (let k = i + 1; k < styled.length; k++) if (!isSpace(styled[k].c.ch)) { nxt = styled[k]; break; }
      const base = prev ?? nxt;
      if (!base) continue;
      const both = <K extends keyof CharStyle>(k: K) => (prev && nxt && prev.s[k] && prev.s[k] === nxt.s[k] ? prev.s[k] : null);
      cur.s = {
        ...base.s,
        underline: !!both("underline"), strike: !!both("strike"),
        highlight: (both("highlight") as string | null) ?? (cur.s.highlight && base.s.highlight === cur.s.highlight ? cur.s.highlight : null),
        link: both("link") as string | null, shift: 0,
      };
    }
    if (li > 0) {
      const join = joinLines(p, p.lines[li - 1], line, ctx);
      const last = p.chars[p.chars.length - 1];
      const firstStyled = styled.find((x) => !isSpace(x.c.ch));
      if (join === "br") p.chars.push({ ch: "\n", br: true, style: last?.style ?? firstStyled?.s ?? styled[0].s });
      else if (join === "space" && last) {
        const keep = <K extends "underline" | "strike" | "highlight" | "link">(k: K) => (last.style[k] && firstStyled?.s[k] === last.style[k] ? last.style[k] : k === "underline" || k === "strike" ? false : null);
        p.chars.push({ ch: " ", style: { ...last.style, underline: keep("underline") as boolean, strike: keep("strike") as boolean, highlight: keep("highlight") as string | null, link: keep("link") as string | null, shift: 0 } });
      } else if (join === "dehyphen" && last?.ch === "-") p.chars.pop();
    }
    for (const { c, s } of styled) p.chars.push(c.image ? { ch: "\uFFFC", style: s, image: c.image } : { ch: c.ch, style: s });
  });
  // No spaces at the ends of the paragraph or around its line breaks
  while (p.chars.length && isSpace(p.chars[0].ch) && !p.chars[0].br) p.chars.shift();
  while (p.chars.length && isSpace(p.chars[p.chars.length - 1].ch) && !p.chars[p.chars.length - 1].br) p.chars.pop();
  const collapsed: StyledChar[] = [];
  for (const c of p.chars) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && c.ch === " " && prev.ch === " ") continue;
    if (prev?.br && c.ch === " ") continue;
    if (c.br && prev?.ch === " ") collapsed.pop();
    collapsed.push(c);
  }
  p.chars = collapsed;
}

/** How a wrapped line joins the one before: a space, nothing (a hyphen or a long word), or a line break */
function joinLines(p: Para, prev: Line, line: Line, ctx: LayoutContext): "space" | "none" | "dehyphen" | "br" {
  const prevText = prev.chars.map((c) => c.ch).join("").trimEnd();
  const text = line.chars.map((c) => c.ch).join("").trimStart();
  const em = prev.size;
  const right = p.right;
  const remaining = right - prev.x1;
  const nextWord = text.split(/\s/)[0] ?? "";
  const charW = (line.x1 - line.x0) / Math.max(1, text.length);
  const fills = remaining < charW * 2.5;
  // A line that stopped short although the next word would have fitted ends in a line break
  const mid = (l: Line) => (l.x0 + l.x1) / 2;
  const centered = Math.abs(mid(prev) - mid(line)) < 2 && Math.abs(prev.x0 - line.x0) > 2;
  const room = centered ? (p.right - p.left) - (prev.x1 - prev.x0) : remaining;
  if (nextWord && room > firstWordWidth(line) + 0.35 * em * 2 + 1 && ctx.tagged) return "br";
  if (/[\p{L}\p{N}]-$/u.test(prevText)) {
    // A word broken at its own hyphen keeps it; one the producer hyphenated loses it. The document's own
    // words say which, where they can
    const head = (/([\p{L}\p{N}]+)-$/u.exec(prevText)?.[1] ?? "").toLowerCase();
    const tail = (/^([\p{L}\p{N}]+)/u.exec(text)?.[1] ?? "").toLowerCase();
    if (ctx.words.has(`${head}-${tail}`)) return "none";
    if (ctx.words.has(head + tail)) return "dehyphen";
    if (ctx.autoHyphens && /^\p{Ll}/u.test(text) && !/-\p{L}+-$/u.test(prevText)) return "dehyphen";
    return "none";
  }
  if (/[\u00AD]$/.test(prevText)) return "dehyphen";
  if (!prevText.includes(" ") && fills && !/[.,;:!?)]$/.test(prevText)) return "none";
  // A long link or word broken where the line ran out
  const lastWord = prevText.split(/\s/).pop() ?? "";
  if (fills && lastWord.length > 25 && /[/._\-?=&%]/.test(lastWord) && !/\s/.test(text.slice(0, 1))) return "none";
  return "space";
}

/** Add to the list a map holds for a key */
function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}
