/**
 * Import a PDF: rebuild it as editor content that a sync types into a
 * Google Doc so the Doc looks like the PDF.
 *
 * Every character, image and page break comes out as a pending addition
 * (the syncAdd mark), with the PDF's fonts (as Docs families), sizes,
 * colours, highlights, underlines and links set explicitly, so it looks the
 * same whatever document it goes into. Paragraphs keep their alignment,
 * indents, line spacing and spacing; headings, lists and tables are rebuilt
 * as Docs' own; images are handed over as files (src "pdf-image:<key>")
 * for the caller to upload. The page size and margins, and a header and
 * footer repeated on the pages, come back alongside.
 */

import { PENDING_MARK } from "./doc-model";
import { PAPERS, PAPER_ORDER, type PageSetup, type PaperId } from "./page-setup";
import { NAMED_STYLES, normalizeLink, type EditorNode, type NamedStyle, type RunStyle } from "./rich-text";
import { openPdf, PdfOpenError, type Glyph, type OpenedPdf, type PdfDocumentInfo, type PdfPage } from "./pdf-extract";
import { buildLines, lineText, type Line } from "./pdf-lines";
import { buildChars, contentImage, findMarker, pageItems, settleMarker, type CharStyle, type Item, type LayoutContext, type Para, type StyledChar, type TableItem } from "./pdf-layout";
import { parseMarker, presetFor } from "./pdf-lists";
import { findGrids } from "./pdf-tables";
import { encodeImage } from "./pdf-images";

export interface PdfImage {
  key: string;
  mime: "image/png" | "image/jpeg";
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PdfImportResult {
  nodes: EditorNode[];
  pageSetup: PageSetup;
  header?: EditorNode[];
  footer?: EditorNode[];
  images: PdfImage[];
  /** Docs font families the content uses */
  fonts: string[];
  pages: number;
  /** The PDF had a structure tree, which gave its paragraphs, lists and tables */
  tagged: boolean;
  /** What couldn't be kept exactly, for people */
  warnings: string[];
  stats: { paragraphs: number; headings: number; listItems: number; tables: number; images: number; links: number };
}

export type PdfImportErrorCode = "encrypted" | "invalid" | "empty" | "scanned" | "tooLarge";

export class PdfImportError extends Error {
  constructor(public code: PdfImportErrorCode, message: string) {
    super(message);
    this.name = "PdfImportError";
  }
}

const MESSAGES: Record<PdfImportErrorCode, string> = {
  encrypted: "This PDF is protected with a password. Remove the password, then import it again.",
  invalid: "This file couldn't be read as a PDF. It may be damaged, or not a PDF.",
  empty: "This PDF has nothing in it to import.",
  scanned: "This PDF is a scanned image, so it has no text to copy. Import a PDF made from a text document instead.",
  tooLarge: "This PDF is too long to import.",
};

const ADD = { type: PENDING_MARK };
const isSpace = (s: string) => /^\s+$/.test(s);
const round = (v: number, step = 0.5) => Math.round(v / step) * step;

/** Read a PDF into editor content. Throws PdfImportError when it can't be imported. */
/**
 * `useTags: false` reads the pages by their geometry even when the PDF is tagged (how an untagged PDF
 * of the same document reads).
 */
export async function importPdf(bytes: Uint8Array, opts: { maxPages?: number; useTags?: boolean } = {}): Promise<PdfImportResult> {
  const maxPages = opts.maxPages ?? 300;
  let pdf: OpenedPdf;
  try {
    pdf = await openPdf(bytes);
  } catch (err) {
    if (err instanceof PdfOpenError && err.code === "encrypted") throw new PdfImportError("encrypted", MESSAGES.encrypted);
    throw new PdfImportError("invalid", MESSAGES.invalid);
  }
  try {
    const n = pdf.info.pages;
    if (!n) throw new PdfImportError("empty", MESSAGES.empty);
    if (n > maxPages) throw new PdfImportError("tooLarge", `This PDF has ${n} pages. You can import up to ${maxPages} at a time.`);
    const pages: PdfPage[] = [];
    // Images become files page by page, so only one page's pixels are held at a time
    const encoded = new Map<string, PdfPage["images"][number]["encoded"]>();
    for (let i = 1; i <= n; i++) {
      let page: PdfPage;
      try { page = await pdf.page(i); } catch {
        throw new PdfImportError("invalid", MESSAGES.invalid);
      }
      for (const img of page.images) {
        if (img.pixels && contentImage(img, page)) {
          const hit = img.objId != null ? encoded.get(img.objId) : undefined;
          img.encoded = hit !== undefined ? hit : await encodeImage(img.pixels, { w: img.x1 - img.x0, h: img.y1 - img.y0 }).catch(() => null);
          if (img.objId != null) encoded.set(img.objId, img.encoded);
        }
        img.pixels = null;
      }
      pages.push(page);
    }
    return await reconstruct(pages, opts.useTags === false ? { ...pdf.info, tagged: false } : pdf.info);
  } finally {
    await pdf.close();
  }
}

// ── The document's geometry ───────────────────────────────────────────────

/** Margins page setups commonly have, in points: inches and centimetres */
const COMMON_MARGINS = [72, 54, 36, 90, 108, 18, 56.7, 70.85, 85.05, 42.5, 28.35, 0];

/** The margin a measured one most likely is. The text may stop short of a margin, never pass it. */
function snapMargin(measured: number, slackAbove = 6): number {
  let best: number | null = null;
  for (const m of COMMON_MARGINS) {
    if (measured >= m - 1.5 && measured <= m + slackAbove && (best == null || Math.abs(measured - m) < Math.abs(measured - best))) best = m;
  }
  return best ?? Math.max(0, round(measured, 0.5));
}

/**
 * The left and right margins, and the text column's edges. Text never starts left of the left margin,
 * and wrapped lines run up to the right one: each measured edge is a bound. A left edge is the margin
 * whose 18 pt indent steps the lines start on (list glyphs sit a step in); without wrapped lines, the
 * right margin is taken to be the left one.
 */
function sideMargins(lines: Line[], W: number): { left: number; right: number; textLeft: number; textRight: number } {
  if (!lines.length) return { left: 72, right: 72, textLeft: 72, textRight: W - 72 };
  const minX0 = Math.min(...lines.map((l) => l.x0));
  let left = snapMargin(minX0, 4), best = -Infinity;
  for (const m of COMMON_MARGINS) {
    if (m > minX0 + 1.5 || minX0 - m > 108) continue;
    // Text starting on the margin itself counts twice (a list's glyphs sit a step in, so they don't)
    let fit = 0;
    for (const l of lines) {
      const k = (l.x0 - m) / 18;
      if (Math.abs(k - Math.round(k)) <= 1 / 18) fit += Math.abs(l.x0 - m) <= 1 && !startsWithMarker(l) ? 2 : 1;
    }
    const score = fit / lines.length + (m === 72 ? 0.05 : 0) - (minX0 - m) / 2000;
    if (score > best + 1e-9) { best = score; left = m; }
  }
  const x1s = lines.map((l) => l.x1).filter((x) => x <= W - 4);
  const maxX1 = x1s.length ? Math.max(...x1s) : W - left;
  // Lines that wrapped: near the right edge, with the next line of their paragraph under them
  const sorted = [...lines].sort((a, b) => a.page - b.page || a.y - b.y);
  let wrapped = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (a.page === b.page && a.x1 >= maxX1 - 12 && a.x1 - a.x0 >= (W - 2 * left) * 0.5 && b.y - a.y < a.size * 1.8 && b.x0 <= a.x0 + 1) wrapped++;
  }
  const right = wrapped >= 2 ? snapMargin(W - maxX1, 10) : left;
  const textRight = W - right >= maxX1 - 0.5 ? W - right : maxX1;
  return { left, right, textLeft: left, textRight };
}

function startsWithMarker(l: Line): boolean {
  const word = lineText(l).trimStart().split(/\s/)[0] ?? "";
  return !!parseMarker(word) && word.length < lineText(l).trim().length;
}

function paperOf(w: number, h: number, color: string | null): PageSetup {
  const pw = Math.min(w, h), ph = Math.max(w, h);
  let paper: PaperId = "letter";
  let best = Infinity;
  for (const id of PAPER_ORDER) {
    const d = Math.abs(PAPERS[id].w - pw) + Math.abs(PAPERS[id].h - ph);
    if (d < best) { best = d; paper = id; }
  }
  const setup: PageSetup = { orientation: w > h ? "landscape" : "portrait", paper, margins: { top: 72, bottom: 72, left: 72, right: 72 }, color };
  if (best > 3) setup.custom = { w: round(pw, 0.01), h: round(ph, 0.01) };
  return setup;
}

/** Text that is a page number: "3", "Page 3", "3 of 12", "- 3 -", "iv" */
const PAGE_NUMBER = /^\s*(page\s*)?([#]|[ivxlcdm]+)(\s*(of|\/|-)\s*#)?\s*$|^\s*[-–—]\s*#\s*[-–—]\s*$/i;
const masked = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

interface Running {
  excluded: Set<Glyph>;
  header: Line[];
  footer: Line[];
  headerPage: number;
  footerPage: number;
}

/**
 * Lines repeated at the same place near the top or bottom of most pages are the header and footer;
 * page numbers among them are left out. In a tagged PDF, text outside the structure near the edges
 * is too.
 */
function runningLines(pages: PdfPage[], quick: Line[][], tagged: boolean): Running {
  const keyOf = (l: Line, page: PdfPage) => {
    const zone = l.bottom <= page.height * 0.11 ? "top" : l.top >= page.height * 0.89 ? "bottom" : null;
    return zone ? `${zone}|${masked(lineText(l))}|${Math.round(l.y / 4)}` : null;
  };
  const counts = new Map<string, Set<number>>();
  quick.forEach((lines, i) => lines.forEach((l) => { const k = keyOf(l, pages[i]); if (k) counts.set(k, (counts.get(k) ?? new Set()).add(i)); }));
  const out: Running = { excluded: new Set(), header: [], footer: [], headerPage: -1, footerPage: -1 };
  const need = Math.max(2, Math.ceil(pages.length * 0.4));
  quick.forEach((lines, i) => {
    const page = pages[i];
    for (const l of lines) {
      const k = keyOf(l, page);
      if (!k) continue;
      const glyphs = l.chars.map((c) => c.glyph).filter((g): g is Glyph => !!g);
      const outside = tagged && page.struct && glyphs.every((g) => g.artifact || g.mcid == null || !page.struct!.byMcid.has(g.mcid));
      const repeated = (counts.get(k)?.size ?? 0) >= need;
      if (!repeated && !outside) continue;
      for (const g of glyphs) out.excluded.add(g);
      const text = masked(lineText(l));
      if (PAGE_NUMBER.test(text) || !text) continue;
      const top = k.startsWith("top");
      // The first page that has them gives the header's (footer's) lines
      if (top && (out.headerPage < 0 || out.headerPage === i)) { out.headerPage = i; out.header.push(withoutPageNumber(l)); }
      if (!top && (out.footerPage < 0 || out.footerPage === i)) { out.footerPage = i; out.footer.push(withoutPageNumber(l)); }
    }
  });
  return out;
}

/** A running line without its page number ("Report · Page 3" → "Report ·") */
function withoutPageNumber(l: Line): Line {
  const text = lineText(l);
  const m = /\s*(page\s*)?\d+(\s*(of|\/)\s*\d+)?\s*$/i.exec(text);
  if (!m || m.index === 0) return l;
  return { ...l, chars: l.chars.slice(0, m.index) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
function mode(xs: number[], step: number): number | null {
  const count = new Map<number, number>();
  for (const x of xs) { const k = round(x, step); count.set(k, (count.get(k) ?? 0) + 1); }
  let best: number | null = null, n = 0;
  for (const [k, c] of count) if (c > n) { best = k; n = c; }
  return best;
}

// ── Reconstruction ────────────────────────────────────────────────────────

interface Block {
  item: Item;
  styleName: NamedStyle;
  above: number;
  below: number;
  /** Empty paragraphs before it, with the look of their lines */
  emptiesBefore: { style: CharStyle; count: number } | null;
  pageBreakAfter: boolean;
  listCont: boolean;
  /** Space between it and the list item next to it, which Docs' default (collapsing list spacing) would drop */
  keepListSpacing?: boolean;
}

async function reconstruct(pages: PdfPage[], info: PdfDocumentInfo): Promise<PdfImportResult> {
  const warnings = new Set<string>();
  // Text to read at all
  // A character a font doesn't say the letter of (private use, replacement, control), bullets aside
  const unreadableChar = (ch: string) => /[\uE000-\uF8FF\uFFFD]|[\u0000-\u0008\u000E-\u001F]/.test(ch) && parseMarker(ch)?.kind !== "bullet";
  let visible = 0, unreadable = 0;
  for (const p of pages) for (const g of p.glyphs) {
    if (isSpace(g.ch)) continue;
    visible++;
    if (unreadableChar(g.ch)) unreadable++;
  }
  const anyImages = pages.some((p) => p.images.length);
  if (!visible) throw new PdfImportError(anyImages ? "scanned" : "empty", anyImages ? MESSAGES.scanned : MESSAGES.empty);
  if (unreadable > visible * 0.5) throw new PdfImportError("scanned", "The text in this PDF can't be read: its fonts don't say which letters they draw. Import a PDF made from a text document instead.");
  if (unreadable) {
    for (const p of pages) p.glyphs = p.glyphs.filter((g) => !unreadableChar(g.ch));
    warnings.add("Some characters in this PDF couldn't be read and were left out.");
  }
  if (pages.some((p) => p.skipped > 5)) warnings.add("Rotated or vertical text in this PDF was left out.");
  if (pages.some(hasDrawings)) warnings.add("Shapes and drawings in this PDF aren't copied: Google Docs can't make them.");

  const producer = `${info.producer} ${info.creator}`;
  const fromDocs = /Google Docs/i.test(producer);

  // Lines of whole pages: headers and footers, margins, line pitch
  // (Table cells left out: their text starts at the cells' padding, not at the margin)
  const quick = pages.map((p) => {
    const grids = findGrids(p.shapes, p);
    const inGrid = (g: Glyph) => grids.some((t) => g.x >= t.x0 && g.x <= t.x1 && g.y >= t.y0 && g.y <= t.y1);
    return buildLines(grids.length ? p.glyphs.filter((g) => !inGrid(g)) : p.glyphs, p.index);
  });
  const running = runningLines(pages, quick, info.tagged);
  // Tagged: a structure tree that holds nearly all the text (headers and footers aside)
  let inTree = 0, total = 0;
  for (const p of pages) for (const g of p.glyphs) {
    if (isSpace(g.ch) || running.excluded.has(g)) continue;
    total++;
    if (p.struct && g.mcid != null && p.struct.byMcid.has(g.mcid)) inTree++;
  }
  const tagged = info.tagged && total > 0 && inTree >= total * 0.75;
  const roles = new Set<string>();
  if (tagged) for (const p of pages) { const walk = (n: NonNullable<PdfPage["struct"]>["root"]) => { roles.add(n.role); n.kids.forEach(walk); }; if (p.struct) walk(p.struct.root); }
  const bodyLines = quick.map((lines) => lines.filter((l) => !l.chars.some((c) => c.glyph && running.excluded.has(c.glyph))));
  const W = median(pages.map((p) => p.width)), H = median(pages.map((p) => p.height));
  const textLines = bodyLines.flat().filter((l) => l.chars.filter((c) => !isSpace(c.ch)).length >= 3);
  const { left: marginLeft, right: marginRight, textLeft, textRight } = sideMargins(textLines, W);
  const ctxLeft = textLeft, ctxRight = textRight;

  // The pitch between lines of each size
  const pitches = new Map<number, number[]>();
  for (const lines of bodyLines) {
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1], b = lines[i];
      const dy = b.y - a.y;
      // Lines of one paragraph: a gap between paragraphs is wider than this
      if (Math.abs(a.size - b.size) > 0.3 || dy < 0.95 * a.size || dy > 1.6 * a.size) continue;
      const k = round(a.size);
      push(pitches, k, dy);
    }
  }
  const pitch = new Map<number, number>();
  for (const [k, v] of pitches) pitch.set(k, mode(v, 0.05) ?? median(v));

  const ctx: LayoutContext = {
    tagged, structLists: roles.has("L") || roles.has("LI"), left: ctxLeft, right: ctxRight, pitch, excluded: running.excluded,
    autoHyphens: /TeX|InDesign|Quark|Scribus|Affinity|Pages|FrameMaker/i.test(producer), words: wordsOf(bodyLines), deco: new Map(), bullets: new Map(),
  };
  const perPage: Item[][] = pages.map((p) => pageItems(p, ctx));

  // Top and bottom margins: where the first and last lines sit, on the pages that show them best
  const tops: number[] = [], bottoms: number[] = [];
  perPage.forEach((items) => {
    const paras = items.filter((i): i is Para => i.kind === "para" && i.lines.length > 0);
    const tables = items.filter((i): i is TableItem => i.kind === "table");
    const firstP = paras[0], lastP = paras[paras.length - 1];
    const firstTop = Math.min(firstP ? lineTop(firstP.lines[0]) : Infinity, ...tables.map((t) => t.top));
    const lastBottom = Math.max(lastP ? lineBottom(lastP.lines[lastP.lines.length - 1]) : -Infinity, ...tables.map((t) => t.bottom));
    if (Number.isFinite(firstTop)) tops.push(firstTop);
    if (Number.isFinite(lastBottom)) bottoms.push(lastBottom);
  });
  // A first line lower than the side margins most likely has space above it; pages that end higher
  // than the top margin ran out of room for their next paragraph
  // (a low percentile, not the least: one page with stray text near its top shouldn't move them all)
  const sortedTops = [...tops].sort((a, b) => a - b);
  const measuredTop = sortedTops.length ? sortedTops[sortedTops.length >= 5 ? Math.floor(sortedTops.length * 0.1) : 0] : 72;
  const side = Math.min(marginLeft, marginRight);
  const marginTop = measuredTop >= side - 2 && measuredTop - side <= 36 ? side : snapMargin(measuredTop, 6);
  const lowest = bottoms.length ? Math.max(...bottoms) : H - marginTop;
  const marginBottom = H - lowest >= marginTop - 2 ? marginTop : snapMargin(H - lowest, 4);
  const pageColor = (() => {
    const bg = pages[0]?.shapes.find((s) => s.fill && s.x0 <= 1 && s.y0 <= 1 && s.x1 >= W - 1 && s.y1 >= H - 1);
    return bg?.fill && bg.fill !== "#ffffff" ? bg.fill : null;
  })();
  const pageSetup = paperOf(W, H, pageColor);
  pageSetup.margins = { top: marginTop, bottom: Math.min(marginBottom, H / 3), left: marginLeft, right: marginRight };

  // Paragraphs cut by a page break are one paragraph
  for (const items of perPage) for (const it of items) eachPara(it, (p) => findMarker(p, ctx));
  const flow: Item[] = [];
  const pageEnd = new Set<Item>();
  const topY = (() => {
    const firsts = perPage.map((items) => items.find((i) => i.kind === "para") as Para | undefined).filter((p): p is Para => !!p).map((p) => p.lines[0].y);
    return firsts.length ? Math.min(...firsts) : 0;
  })();
  perPage.forEach((items) => {
    items.forEach((it, k) => {
      const prev = flow[flow.length - 1];
      if (k === 0 && prev && prev.kind === "para" && it.kind === "para" && continues(prev, it, topY, ctx)) {
        prev.lines.push(...it.lines);
        prev.bottom = it.bottom;
        pageEnd.delete(prev);
        if (items.length === 1) pageEnd.add(prev);
        return;
      }
      flow.push(it);
      if (k === items.length - 1) pageEnd.add(it);
    });
  });

  // Lists: which markers make list items, their levels, and Docs list styles
  const bodyBottom = H - pageSetup.margins.bottom;
  const endsEarly = new Set<Item>([...pageEnd].filter((it) => bodyBottom - it.bottom >= H * 0.25));
  const listWarnings = settleLists(flow, ctx, endsEarly);
  for (const w of listWarnings) warnings.add(w);

  // Paragraph by paragraph: characters, alignment, indents, line spacing
  for (const it of flow) eachPara(it, (p) => buildChars(p, ctx));
  const bodySize = dominantSize(flow);
  const headingStyles = headings(flow, bodySize, tagged && [...roles].some((r) => /^H\d?$/.test(r)));

  const blocks: Block[] = flow.map((item) => ({ item, styleName: item.kind === "para" ? headingStyles.get(item) ?? "normal" : "normal", above: 0, below: 0, emptiesBefore: null, pageBreakAfter: false, listCont: false }));
  // Numbered lists that go on after the paragraphs between their items
  for (const b of blocks) if (b.item.kind === "para" && listContinues.has(b.item)) b.listCont = true;
  spacing(blocks, pageEnd, pageSetup, H, fromDocs, pitch);

  // Images: one file per image object drawn
  const images: PdfImage[] = [];
  const keys = new Map<unknown, string>();
  const imageKey = async (img: NonNullable<StyledChar["image"]>): Promise<string | null> => {
    const id = img.objId ?? img;
    if (keys.has(id)) return keys.get(id)!;
    if (img.encoded === undefined) return null;
    const enc = img.encoded;
    if (!enc) { warnings.add("An image in this PDF couldn't be copied."); return null; }
    const key = `img${images.length + 1}`;
    images.push({ key, ...enc });
    keys.set(id, key);
    return key;
  };

  const fonts = new Set<string>();
  const stats = { paragraphs: 0, headings: 0, listItems: 0, tables: 0, images: 0, links: 0 };
  const nodes: EditorNode[] = [];
  for (const b of blocks) {
    if (b.emptiesBefore) for (let k = 0; k < b.emptiesBefore.count; k++) nodes.push(emptyParagraph(b.emptiesBefore.style));
    if (b.item.kind === "table") {
      nodes.push(await tableNode(b.item, ctx, imageKey, fonts, stats));
      stats.tables++;
      if (b.pageBreakAfter) nodes.push({ type: "paragraph", attrs: { ...paraAttrs(null, "normal"), box: { start: 0, first: 0, above: 0, below: 0 } }, content: [{ type: "pageBreak", marks: [ADD] }] });
      continue;
    }
    const node = await paragraphNode(b.item, b, ctx, imageKey, fonts, stats);
    if (b.pageBreakAfter) node.content = [...(node.content ?? []), { type: "pageBreak", marks: [ADD] }];
    nodes.push(node);
  }
  if (!nodes.length) throw new PdfImportError("empty", MESSAGES.empty);

  const segmentNodes = async (lines: Line[], page: number): Promise<EditorNode[] | undefined> => {
    if (!lines.length) return undefined;
    const box = { left: pageSetup.margins.left, right: W - pageSetup.margins.right };
    const out: EditorNode[] = [];
    const sorted = [...lines].sort((a, b) => a.y - b.y);
    for (const line of sorted) {
      const para: Para = { kind: "para", page, lines: [line], role: null, structLevel: null, left: box.left, right: box.right, top: line.top, bottom: line.bottom, order: 0, inCell: false, marker: null, shading: null, shadingBox: null, chars: [] };
      buildChars(para, ctx);
      if (!para.chars.length) continue;
      out.push(await paragraphNode(para, { item: para, styleName: "normal", above: 0, below: 0, emptiesBefore: null, pageBreakAfter: false, listCont: false }, ctx, async () => null, fonts, { paragraphs: 0, headings: 0, listItems: 0, tables: 0, images: 0, links: 0 }));
    }
    return out.length ? out : undefined;
  };
  const header = await segmentNodes(running.header, running.headerPage);
  const footer = await segmentNodes(running.footer, running.footerPage);

  if (flow.some((it) => it.kind === "para" && !it.inCell && it.right - it.left < 0.75 * (ctx.right - ctx.left))) warnings.add("Text in columns is imported as one column, in reading order.");
  return {
    nodes, pageSetup, ...(header ? { header } : {}), ...(footer ? { footer } : {}), images, fonts: [...fonts].sort(), pages: pages.length, tagged, warnings: [...warnings], stats,
  };
}

/** Curved shapes larger than a bullet, or filled boxes with no text in them: a drawing, a chart, a logo */
function hasDrawings(p: PdfPage): boolean {
  let n = 0;
  for (const s of p.shapes) {
    const w = s.x1 - s.x0, h = s.y1 - s.y0;
    if (w > p.width * 0.95 && h > p.height * 0.95) continue;
    const curved = s.curves && w > 10 && h > 10;
    const box = s.rect && s.fill && s.fill !== "#ffffff" && w > 24 && h > 24 && !p.glyphs.some((g) => g.x >= s.x0 && g.x <= s.x1 && g.y >= s.y0 && g.y <= s.y1);
    if (curved || box) n++;
  }
  return n >= 2;
}

/** The words written on one line (not broken across two), lowercase, hyphenated ones as they are */
function wordsOf(lines: Line[][]): Set<string> {
  const out = new Set<string>();
  for (const page of lines) for (const l of page) {
    const words = lineText(l).toLowerCase().split(/[^\p{L}\p{N}-]+/u);
    // The last word may go on in the next line
    words.slice(0, -1).forEach((w) => { if (w && !w.endsWith("-")) out.add(w); });
  }
  return out;
}

const lineTop = (l: Line) => {
  const g = l.chars.find((c) => c.glyph)?.glyph;
  const lh = g?.font.lineHeight ?? 1.15, desc = g?.font.descent ?? 0.21;
  return l.chars.some((c) => c.image) ? l.top : l.y - (lh - desc) * l.size;
};
const lineBottom = (l: Line) => {
  const g = l.chars.find((c) => c.glyph)?.glyph;
  return l.y + (g?.font.descent ?? 0.21) * l.size;
};

function eachPara(it: Item, fn: (p: Para) => void) {
  if (it.kind === "para") fn(it);
  else for (const c of it.cells) for (const p of c.paras) fn(p);
}

/** The size most of the document's text is in */
function dominantSize(items: Item[]): number {
  const count = new Map<number, number>();
  for (const it of items) eachPara(it, (p) => {
    for (const l of p.lines) for (const c of l.chars) if (c.glyph && !isSpace(c.ch)) { const k = round(c.size); count.set(k, (count.get(k) ?? 0) + 1); }
  });
  let best = 11, n = 0;
  for (const [k, c] of count) if (c > n) { best = k; n = c; }
  return best;
}

/** Whether the first paragraph of a page goes on with the last of the page before */
function continues(prev: Para, next: Para, topY: number, ctx: LayoutContext): boolean {
  if (next.page !== prev.page + 1 || prev.inCell || next.inCell) return false;
  const last = prev.lines[prev.lines.length - 1], first = next.lines[0];
  if (!last || !first) return false;
  if (ctx.tagged && prev.role !== next.role) return false;
  if (/^H\d?$|^Title$|^Figure$/.test(next.role ?? "")) return false;
  if (Math.abs(last.size - first.size) > 0.5) return false;
  // A list item goes on when the next page's part has no marker of its own
  if (next.role === "LI" || next.marker) return next.role === "LI" && !next.marker && ctx.tagged;
  if (first.y > topY + 2) return false;
  const cont = prev.lines.length > 1 ? prev.lines[prev.lines.length - 1].x0 : prev.marker ? prev.marker.textX : null;
  if (cont != null && Math.abs(first.x0 - cont) > 1.5) return false;
  if (cont == null && Math.abs(first.x0 - last.x0) > 1.5) return false;
  // The line before the break ran to the edge: the next word didn't fit
  const word = first.chars.findIndex((c, i) => i > 0 && isSpace(c.ch));
  const wordW = word > 0 ? first.chars[word - 1].x1 - first.x0 : first.x1 - first.x0;
  return prev.right - last.x1 < wordW + 0.6 * last.size;
}

// ── Lists ─────────────────────────────────────────────────────────────────

/** Paragraphs between two items of a numbered list that goes on after them */
const listContinues = new WeakSet<Para>();
/** Per list item: its kind, level and Docs list style */
const listOf = new WeakMap<Para, { kind: "bullet" | "ordered" | "check"; level: number; preset: string }>();

function settleLists(flow: Item[], ctx: LayoutContext, endsEarly: Set<Item>): string[] {
  const warnings: string[] = [];
  const seqs: Para[][] = [[]];
  for (const it of flow) {
    if (it.kind === "para") seqs[0].push(it);
    else for (const c of it.cells) seqs.push(c.paras);
  }
  for (const seq of seqs) {
    // A weak marker ("1." with a narrow gap, "-") counts when its neighbours are items like it, or it hangs
    const item = seq.map((p) => !!p.marker && p.marker.strong);
    // Neighbours: the items around it, past items nested between (a contact's email under its name)
    const around = (i: number) => {
      const out: Para[] = [];
      for (const dir of [-1, 1]) for (let k = i + dir, n = 0; k >= 0 && k < seq.length && seq[k].marker && n < 6; k += dir, n++) out.push(seq[k]);
      return out;
    };
    seq.forEach((p, i) => {
      if (!p.marker || item[i]) return;
      const near = around(i).some((q) => q.marker && q.marker.marker.kind === p.marker!.marker.kind && Math.abs(q.marker.x - p.marker!.x) < 2.5);
      const hangs = p.lines.length > 1 && Math.abs(p.lines[1].x0 - p.marker.textX) < 1.5;
      item[i] = near || hangs;
    });
    seq.forEach((p, i) => settleMarker(p, item[i]));
    // Runs of items, with the paragraphs between two items of a numbered list that counts on
    let run: Para[] = [];
    const runs: Para[][] = [];
    seq.forEach((p) => {
      // A page that ends early (a new tab or section after it) ends its list too
      if (run.length && endsEarly.has(run[run.length - 1]) && p.page !== run[run.length - 1].page) { runs.push(run); run = []; }
      if (p.marker) run.push(p);
      else if (run.length) { runs.push(run); run = []; }
    });
    if (run.length) runs.push(run);
    // Levels: the structure's list depth, Docs' 36 pt steps, or the order of the glyphs' places
    const left = (p: Para) => (p.inCell ? p.left : ctx.left);
    for (const run of runs) for (const kind of ["bullet", "ordered", "check"] as const) {
      // Bulleted and numbered items next to each other are lists of their own, each with its levels
      const r = run.filter((p) => p.marker!.marker.kind === kind || (kind === "ordered" && p.marker!.marker.kind !== "bullet" && p.marker!.marker.kind !== "check"));
      if (!r.length) continue;
      const onGrid = (p: Para) => { const k = (p.marker!.x - left(p) - 18) / 36; return Math.abs(k - Math.round(k)) < 0.05 && k > -0.05; };
      const docsGrid = r.filter(onGrid).length >= r.length * 0.6;
      const xs: number[] = [];
      for (const p of [...r].sort((a, b) => a.marker!.x - b.marker!.x)) if (!xs.length || p.marker!.x - xs[xs.length - 1] > 4) xs.push(p.marker!.x);
      for (const p of r) {
        const level = ctx.tagged && ctx.structLists && p.role === "LI" && p.structLevel != null ? p.structLevel
          : docsGrid && onGrid(p) ? Math.round((p.marker!.x - left(p) - 18) / 36)
          : xs.findIndex((x) => p.marker!.x - x <= 4);
        listOf.set(p, { kind: p.marker!.marker.kind, level: Math.max(0, Math.min(8, level)), preset: "" });
      }
    }
    // Numbered items under a numbered item keep its numbering: deeper items of another kind join it
    for (const r of runs) {
      for (let i = 0; i < r.length; i++) {
        const outer = listOf.get(r[i])!;
        if (outer.kind !== "ordered") continue;
        let j = i + 1;
        while (j < r.length && listOf.get(r[j])!.level > outer.level) j++;
        if (j < r.length && listOf.get(r[j])!.level === outer.level && listOf.get(r[j])!.kind === "ordered") for (let k = i + 1; k < j; k++) listOf.get(r[k])!.kind = "ordered";
      }
    }
    // A numbered list goes on across other paragraphs when its numbers do
    const lists: Para[][] = [];
    for (const r of runs) {
      const prevList = lists[lists.length - 1];
      const head = r[0];
      const lastOf = (list: Para[], level: number) => [...list].reverse().find((p) => listOf.get(p)!.level === level);
      const before = prevList && lastOf(prevList, listOf.get(head)!.level);
      if (before && listOf.get(before)!.kind === "ordered" && listOf.get(head)!.kind === "ordered" && head.marker!.marker.n === before.marker!.marker.n + 1 && head.marker!.marker.glyph.type === before.marker!.marker.glyph.type) {
        const from = seq.indexOf(prevList[prevList.length - 1]), to = seq.indexOf(head);
        const between = seq.slice(from + 1, to);
        if (between.every((p) => p.lines.length <= 6)) {
          for (const p of between) listContinues.add(p);
          prevList.push(...r);
          continue;
        }
      }
      lists.push([...r]);
    }
    for (const list of lists) {
      for (const kind of ["bullet", "ordered", "check"] as const) {
        const items = list.filter((p) => listOf.get(p)!.kind === kind);
        if (!items.length) continue;
        const preset = presetFor(kind, items.map((p) => ({ level: listOf.get(p)!.level, glyph: p.marker!.marker.glyph })));
        for (const p of items) listOf.get(p)!.preset = preset;
        const first = items.find((p) => listOf.get(p)!.level === 0) ?? items[0];
        if (kind === "ordered" && first.marker!.marker.n > 1) warnings.push("A numbered list that starts above 1 is numbered from 1, as Google Docs makes new lists.");
      }
    }
  }
  return warnings;
}

// ── Headings ──────────────────────────────────────────────────────────────

/** Named styles: the structure's headings, or, without them, text larger than the body ranked by size */
function headings(flow: Item[], body: number, tagsHaveHeadings: boolean): Map<Para, NamedStyle> {
  const out = new Map<Para, NamedStyle>();
  const paras = flow.filter((i): i is Para => i.kind === "para" && i.chars.length > 0);
  const sizeOf = (p: Para) => dominantCharStyle(p.chars)?.size ?? body;
  if (tagsHaveHeadings) {
    const generic: Para[] = [];
    for (const p of paras) {
      const m = /^H([1-6])$/.exec(p.role ?? "");
      if (m) out.set(p, `h${m[1]}` as NamedStyle);
      else if (p.role === "Title") out.set(p, "title");
      else if (p.role === "H") generic.push(p);
    }
    const sizes = [...new Set(generic.map((p) => round(sizeOf(p))))].sort((a, b) => b - a);
    for (const p of generic) out.set(p, `h${Math.min(6, sizes.indexOf(round(sizeOf(p))) + 1)}` as NamedStyle);
    return out;
  }
  // A heading is short, larger than the body text, and not followed by more text its size (a passage
  // set in a larger size is text, not headings)
  const nextOf = (p: Para) => paras[paras.indexOf(p) + 1];
  const candidates = paras.filter((p) => {
    const s = dominantCharStyle(p.chars);
    const bold = (s?.weight ?? 400) >= 600;
    if (listOf.has(p) || p.lines.length > 2 || p.inCell || p.chars.length > 160 || sizeOf(p) < body * (bold ? 1.1 : 1.3)) return false;
    const next = nextOf(p);
    return !next || Math.abs(sizeOf(next) - sizeOf(p)) > 0.5 || (dominantCharStyle(next.chars)?.weight ?? 400) < (dominantCharStyle(p.chars)?.weight ?? 400);
  });
  const sizes = [...new Set(candidates.map((p) => round(sizeOf(p))))].sort((a, b) => b - a);
  if (!sizes.length) return out;
  const top = candidates.filter((p) => round(sizeOf(p)) === sizes[0]);
  let rank = sizes;
  // One line far larger than anything else, at the start: the document's title
  if (top.length === 1 && paras.indexOf(top[0]) <= 1 && sizes.length > 1 && sizes[0] >= sizes[1] * 1.2 && sizes[0] >= 23) {
    out.set(top[0], "title");
    rank = sizes.slice(1);
    // A line just under the title, smaller and plain: its subtitle
    const sub = paras[paras.indexOf(top[0]) + 1];
    const ss = sub && dominantCharStyle(sub.chars);
    if (sub && ss && sub.lines.length === 1 && !listOf.has(sub) && ss.weight < 600 && ss.size >= body * 1.1 && ss.size < sizes[0] * 0.8) out.set(sub, "subtitle");
  }
  for (const p of candidates) {
    if (out.has(p) || [...out.values()].includes("subtitle") && out.get(p) === "subtitle") continue;
    const k = rank.indexOf(round(sizeOf(p)));
    if (k >= 0) out.set(p, `h${Math.min(6, k + 1)}` as NamedStyle);
  }
  return out;
}

function dominantCharStyle(chars: StyledChar[]): CharStyle | null {
  const count = new Map<string, { s: CharStyle; n: number }>();
  for (const c of chars) {
    if (isSpace(c.ch) || c.image) continue;
    const k = `${c.style.family}|${c.style.size}|${c.style.weight}|${c.style.italic}|${c.style.color}`;
    const e = count.get(k) ?? { s: c.style, n: 0 };
    e.n++;
    count.set(k, e);
  }
  let best: { s: CharStyle; n: number } | null = null;
  for (const e of count.values()) if (!best || e.n > best.n) best = e;
  return best?.s ?? chars.find((c) => !c.image)?.style ?? null;
}

// ── Spacing: line spacing, space between paragraphs, empty lines, page breaks ─

/** A paragraph's line spacing (Docs' percent) and the part of its line box above and below the baseline */
function lineBox(p: Para): { spacing: number | null; above: number; below: number; nlh: number; size: number } {
  const s = dominantCharStyle(p.chars);
  const g = p.lines[0]?.chars.find((c) => c.glyph)?.glyph;
  const nlh = g?.font.lineHeight ?? 1.15;
  const desc = g?.font.descent ?? 0.21;
  const size = s?.size ?? p.lines[0]?.size ?? 11;
  const dys: number[] = [];
  // Lines with images, superscripts or subscripts can be taller than their text makes them
  const plain = (l: Line) => !l.chars.some((c) => c.image || c.shift);
  for (let i = 1; i < p.lines.length; i++) {
    const a = p.lines[i - 1], b = p.lines[i];
    if (a.page !== b.page || !plain(a) || !plain(b)) continue;
    dys.push(b.y - a.y);
  }
  const spacing = dys.length ? snapSpacing(median(dys) / (size * nlh) * 100) : null;
  const first = p.lines[0];
  const imageTop = first?.chars.some((c) => c.image) ? first.y - first.top : 0;
  return { spacing, above: Math.max(imageTop, (nlh - desc) * size), below: desc * size, nlh, size };
}

function snapSpacing(pct: number): number {
  for (const v of [100, 115, 150, 200]) if (Math.abs(pct - v) <= v * 0.03) return v;
  return Math.max(50, Math.min(500, Math.round(pct)));
}

const spacingOf = new WeakMap<Para, number>();

function spacing(blocks: Block[], pageEnd: Set<Item>, setup: PageSetup, H: number, fromDocs: boolean, pitch: Map<number, number>) {
  // Line spacing: a paragraph's own, else what paragraphs in its size and font have
  const bySize = new Map<string, number[]>();
  const keyOf = (p: Para) => { const s = dominantCharStyle(p.chars); return `${s?.family}|${s?.size}`; };
  for (const b of blocks) if (b.item.kind === "para") {
    const lb = lineBox(b.item);
    if (lb.spacing != null) { spacingOf.set(b.item, lb.spacing); push(bySize, keyOf(b.item), lb.spacing); }
  }
  const all = [...bySize.values()].flat();
  const docSpacing = mode(all, 1) ?? 115;
  // One line: its font and size's spacing elsewhere, else the pitch lines of its size have in the document
  const guess = (p: Para) => {
    const own = mode(bySize.get(keyOf(p)) ?? [], 1);
    if (own != null) return own;
    const lb = lineBox(p);
    const pt = pitch.get(round(lb.size));
    return pt ? snapSpacing((pt / (lb.size * lb.nlh)) * 100) : docSpacing;
  };
  for (const b of blocks) if (b.item.kind === "para" && !spacingOf.has(b.item)) spacingOf.set(b.item, guess(b.item));
  for (const b of blocks) if (b.item.kind === "table") for (const c of b.item.cells) for (const p of c.paras) spacingOf.set(p, lineBox(p).spacing ?? guess(p));

  const boxOf = (it: Item) => {
    if (it.kind === "table") return { top: it.top, bottom: it.bottom, firstY: it.top, lastY: it.bottom, above: 0, below: 0, h: 0, style: null as CharStyle | null };
    const lb = lineBox(it);
    const sp = (spacingOf.get(it) ?? 115) / 100;
    const first = it.lines[0], last = it.lines[it.lines.length - 1];
    // Docs puts a line's extra spacing below its text
    const below = lb.below + (sp - 1) * lb.nlh * lb.size;
    return { top: first.y - lb.above, bottom: last.y + below, firstY: first.y, lastY: last.y, above: lb.above, below, h: lb.nlh * lb.size * sp, style: dominantCharStyle(it.chars) };
  };
  const bodyBottom = H - setup.margins.bottom;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const it = b.item;
    const box = boxOf(it);
    const prev = blocks[i - 1];
    const firstOnPage = !prev || prev.item.page !== it.page || pageEnd.has(prev.item);
    if (it.kind === "para" && it.shadingBox) {
      // Shading fills the paragraph's box, its spacing included
      b.above = Math.max(0, round(box.top - it.shadingBox.y0));
      b.below = Math.max(0, round(it.shadingBox.y1 - box.bottom));
    }
    if (firstOnPage) {
      const s = box.top - setup.margins.top;
      if (!(it.kind === "para" && it.shadingBox) && s >= 2 && (it.page === 0 || prev?.pageBreakAfter || i === 0)) b.above = round(Math.min(s, 72));
      continue;
    }
    if (!prev) continue;
    const pbox = boxOf(prev.item);
    let gap = box.top - pbox.bottom - prev.below - (it.kind === "para" && it.shadingBox ? b.above : 0);
    if (gap < 1.25) { if (!(it.kind === "para" && it.shadingBox)) b.above = 0; continue; }
    // Empty paragraphs leave only their height: whole lines of the text around them
    if (it.kind === "para" && prev.item.kind === "para" && !it.inCell) {
      const unit = box.h || pbox.h;
      const k = unit > 0 ? Math.floor((gap + 1.5) / unit) : 0;
      const rest = gap - k * unit;
      if (k >= 1 && fromDocs && b.styleName === "normal" && prev.styleName === "normal") {
        b.emptiesBefore = { style: (box.style ?? pbox.style)!, count: Math.min(k, 20) };
        gap = Math.max(0, rest);
      }
    }
    if (gap < 1.25) continue;
    // The space goes above the paragraph; after a heading, the heading's own space below first
    const prevStyle = prev.styleName;
    if (prevStyle !== "normal" && prev.item.kind === "para" && !prev.item.shadingBox) {
      const want = NAMED_STYLES[prevStyle].space[1];
      prev.below = round(Math.min(gap, want));
      gap -= prev.below;
    }
    if (!(it.kind === "para" && it.shadingBox)) b.above = round(gap);
    else if (prev.item.kind === "para" && !prev.item.shadingBox) prev.below = round(prev.below + Math.max(0, gap - b.above));
  }
  // Docs leaves out the space between items of one list unless told not to: the PDF shows it
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1], b = blocks[i];
    if (a.item.kind === "para" && b.item.kind === "para" && listOf.has(a.item) && listOf.has(b.item) && !b.emptiesBefore && (a.below > 0 || b.above > 0)) a.keepListSpacing = b.keepListSpacing = true;
  }
  // Page breaks: a page that ends with a quarter of it empty, or with room for what the next page starts with
  for (let i = 0; i < blocks.length - 1; i++) {
    const b = blocks[i];
    if (!pageEnd.has(b.item)) continue;
    const next = blocks[i + 1];
    if (next.item.page === b.item.page) continue;
    const box = boxOf(b.item);
    const room = bodyBottom - box.bottom - b.below;
    const nbox = boxOf(next.item);
    const nextNeeds = next.item.kind === "para" ? Math.min(nbox.bottom - nbox.top, nbox.h * 2) + next.above : Math.min(40, next.item.bottom - next.item.top);
    if (room >= H * 0.25 || (room > nextNeeds + 6 && room >= H * 0.08 && next.styleName === "normal")) b.pageBreakAfter = true;
  }
}

// ── Editor nodes ──────────────────────────────────────────────────────────

function paraAttrs(p: Para | null, styleName: NamedStyle): Record<string, unknown> {
  return {
    styleName, textAlign: null, indent: 0, firstLine: false, lineSpacing: p ? spacingOf.get(p) ?? 115 : 115, list: null,
    indentEnd: null, box: null, keep: null, borders: null, shading: p?.shading && p.shading !== "#ffffff" ? p.shading : null, spacingMode: null,
  };
}

/** Indents on Docs' 18 pt grid when they are within a point of it */
function snapIndent(v: number): number {
  const g = Math.round(v / 18) * 18;
  return Math.abs(v - g) <= 1 ? g : round(v, 0.5);
}

/** Alignment and indents from the paragraph's lines, against its box */
function geometry(p: Para): { align: "left" | "center" | "right" | "justify"; start: number; first: number; end: number; rtl: boolean } {
  const lines = p.lines.filter((l) => l.chars.some((c) => !isSpace(c.ch)));
  const rtl = lines.filter((l) => l.rtl).length > lines.length / 2;
  const { left, right } = p;
  const same = (a: number[]) => a.length > 0 && Math.max(...a) - Math.min(...a) < 1.5;
  if (!lines.length) return { align: rtl ? "right" : "left", start: 0, first: 0, end: 0, rtl };
  const x1s = lines.map((l) => l.x1), mids = lines.map((l) => (l.x0 + l.x1) / 2);
  const center = (left + right) / 2;
  let align: "left" | "center" | "right" | "justify";
  const near = (a: number, b: number, t = 1.5) => Math.abs(a - b) <= t;
  const listItem = listOf.has(p);
  if (lines.length >= 2) {
    const rest = lines.slice(1);
    const body = listItem ? lines : rest;
    const full = lines.slice(0, -1).filter((l) => near(l.x1, Math.max(...x1s.slice(0, -1)), 0.8)).length;
    const stretched = lines.slice(0, -1).some(isStretched);
    const fullAtRight = lines.slice(0, -1).every((l) => right - l.x1 < 1.2);
    // Justified: every line but the last runs to the edge, stretched (two lines: the first must be)
    const justified = full === lines.length - 1 && (lines.length > 2 ? fullAtRight || stretched : stretched && (fullAtRight || rtl));
    if (!rtl && justified && same(body.map((l) => l.x0))) align = "justify";
    else if (rtl && justified && stretched && same(body.map((l) => l.x1))) align = "justify";
    else if (!rtl && same(body.map((l) => l.x0))) align = "left";
    else if (rtl && same(body.map((l) => l.x1))) align = "right";
    else if (same(x1s) && near(x1s[0], right, 3)) align = "right";
    else if (same(mids)) align = "center";
    else align = rtl ? "right" : "left";
  } else {
    const l = lines[0];
    const x = l.x0 - left;
    const atStop = Math.abs(x / 18 - Math.round(x / 18)) < 0.05 || (p.marker != null && near(l.x0, p.marker.textX, 1));
    if (rtl) align = near(l.x1, right, 2) ? "right" : near(mids[0], center, 2) ? "center" : "left";
    else if (atStop || near(l.x0, left, 1)) align = "left";
    else if (near(l.x1, right, 2)) align = "right";
    else if (near(mids[0], center, 2.5)) align = "center";
    else align = "left";
  }
  if (rtl) {
    const startEdge = (l: Line) => right - l.x1;
    const start = align === "right" || align === "justify" ? (lines.length > 1 ? startEdge(lines[1]) : startEdge(lines[0])) : 0;
    const first = align === "right" || align === "justify" ? startEdge(lines[0]) - start : 0;
    return { align, start: Math.max(0, snapIndent(start)), first: snapIndent(first), end: 0, rtl };
  }
  if (align === "center" || align === "right") {
    const end = align === "right" ? Math.max(0, right - Math.max(...x1s)) : 0;
    return { align, start: 0, first: 0, end: end > 2 ? snapIndent(end) : 0, rtl };
  }
  const start = Math.max(0, (lines.length > 1 && !listItem ? lines[1].x0 : lines[0].x0) - left);
  const first = lines[0].x0 - left - start;
  let end = 0;
  if (align === "justify") end = Math.max(0, right - Math.max(...x1s.slice(0, -1)));
  return { align, start: snapIndent(start), first: snapIndent(first), end: end > 2 ? snapIndent(end) : 0, rtl };
}

/** A line whose word gaps are wider than its spaces: stretched to the edge (justified) */
function isStretched(l: Line): boolean {
  let n = 0, wide = 0;
  for (let i = 1; i + 1 < l.chars.length; i++) {
    const c = l.chars[i];
    if (c.ch !== " " || !c.glyph) continue;
    const prev = l.chars[i - 1], next = l.chars[i + 1];
    if (isSpace(prev.ch) || isSpace(next.ch)) continue;
    n++;
    if (next.x0 - prev.x1 > (c.x1 - c.x0) + 0.12) wide++;
  }
  if (n) return wide / n > 0.6;
  // No space glyphs: gaps between words against the font's usual space
  const gaps: number[] = [];
  for (let i = 1; i + 1 < l.chars.length; i++) if (l.chars[i].ch === " " && !l.chars[i].glyph) gaps.push(l.chars[i].x1 - l.chars[i].x0);
  return gaps.length > 0 && median(gaps) > 0.36 * l.size;
}

function marksOf(s: CharStyle, base?: number): NonNullable<EditorNode["marks"]> {
  const marks: NonNullable<EditorNode["marks"]> = [];
  if (s.weight >= 700) marks.push({ type: "bold" });
  if (s.italic) marks.push({ type: "italic" });
  if (s.underline) marks.push({ type: "underline" });
  if (s.strike) marks.push({ type: "strike" });
  if (s.shift === 1) marks.push({ type: "superscript" });
  if (s.shift === -1) marks.push({ type: "subscript" });
  const href = normalizeLink(s.link);
  if (href) marks.push({ type: "link", attrs: { href } });
  if (s.highlight && s.highlight !== "#ffffff") marks.push({ type: "highlight", attrs: { color: s.highlight } });
  const weight = s.weight !== 400 && s.weight !== 700 ? s.weight : null;
  marks.push({ type: "textStyle", attrs: { fontFamily: s.family, fontSize: base ?? s.size, color: s.color, fontWeight: weight } });
  return marks;
}

const styleKey = (s: CharStyle) => `${s.family}|${s.weight}|${s.italic}|${s.size}|${s.color}|${s.underline}|${s.strike}|${s.highlight}|${s.link}|${s.shift}`;

type ImageKeyFn = (img: NonNullable<StyledChar["image"]>) => Promise<string | null>;
type Stats = PdfImportResult["stats"];

/** Inline content: text runs of one look, images, line breaks, every one a pending addition */
async function inlineContent(p: Para, imageKey: ImageKeyFn, fonts: Set<string>, stats: Stats): Promise<EditorNode[]> {
  const out: EditorNode[] = [];
  let run = "";
  let runStyle: CharStyle | null = null;
  let lastLink: string | null = null;
  const flush = () => {
    if (run && runStyle) {
      out.push({ type: "text", text: run, marks: [...marksOf(runStyle), ADD] });
      fonts.add(runStyle.family);
      if (runStyle.link && runStyle.link !== lastLink && normalizeLink(runStyle.link)) stats.links++;
      lastLink = runStyle.link;
    }
    run = "";
    runStyle = null;
  };
  for (const c of p.chars) {
    if (c.br) { flush(); out.push({ type: "hardBreak", marks: [ADD] }); continue; }
    if (c.image) {
      flush();
      const key = await imageKey(c.image);
      if (key) {
        out.push({ type: "image", attrs: { src: `pdf-image:${key}`, width: Math.round((c.image.x1 - c.image.x0) / 0.75), height: Math.round((c.image.y1 - c.image.y0) / 0.75) }, marks: [ADD] });
        stats.images++;
      }
      continue;
    }
    // Docs drops control characters and tabs stay tabs
    const ch = c.ch.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    if (!ch) continue;
    if (!runStyle || styleKey(runStyle) !== styleKey(c.style)) { flush(); runStyle = c.style; }
    run += ch;
  }
  flush();
  return out;
}

async function paragraphNode(p: Para, b: Block, ctx: LayoutContext, imageKey: ImageKeyFn, fonts: Set<string>, stats: Stats): Promise<EditorNode> {
  const content = await inlineContent(p, imageKey, fonts, stats);
  const geo = geometry(p);
  const attrs = paraAttrs(p, b.styleName);
  const align = geo.rtl ? (geo.align === "right" ? null : geo.align) : geo.align === "left" ? null : geo.align;
  attrs.textAlign = align;
  if (geo.rtl) attrs.dir = "rtl";
  const list = listOf.get(p);
  if (list && p.marker) {
    const textX = Number.isFinite(p.marker.textX) ? p.marker.textX : p.marker.x + 18;
    const start = snapIndent(Math.max(0, (geo.rtl ? p.right - textX : textX - p.left)));
    const marker = snapIndent(geo.rtl ? 0 : p.marker.x - textX);
    attrs.list = list.kind;
    attrs.level = list.level;
    attrs.preset = list.preset;
    attrs.box = { start, marker, above: b.above, below: b.below };
    // The glyph's own look, when it isn't the text's
    const first = p.chars.find((c) => !isSpace(c.ch) && !c.image)?.style;
    if (p.marker.style) fonts.add(p.marker.style.family);
    if (p.marker.style && first && styleKey({ ...p.marker.style, link: null, underline: false, strike: false, highlight: null }) !== styleKey({ ...first, link: null, underline: false, strike: false, highlight: null })) {
      attrs.glyphStyle = glyphStyle(p.marker.style);
    }
    stats.listItems++;
  } else {
    attrs.box = { start: geo.start, first: geo.first, above: b.above, below: b.below };
    if (b.styleName === "normal") { if (content.length) stats.paragraphs++; } else stats.headings++;
  }
  if (geo.end) attrs.indentEnd = geo.end;
  if (b.listCont) attrs.listCont = true;
  if (b.keepListSpacing) attrs.spacingMode = "NEVER_COLLAPSE";
  if (!content.length) {
    const s = p.chars[0]?.style;
    if (s) attrs.nl = marksOf(s).filter((m) => m.type !== "link");
  }
  return { type: "paragraph", attrs, content };
}

function glyphStyle(s: CharStyle): RunStyle {
  const g: RunStyle = { font: s.family, size: s.size, color: s.color };
  if (s.weight >= 700) g.b = 1;
  if (s.italic) g.i = 1;
  if (s.weight !== 400 && s.weight !== 700) g.w = s.weight;
  return g;
}

function emptyParagraph(style: CharStyle): EditorNode {
  const nl = marksOf({ ...style, underline: false, strike: false, link: null, highlight: null, shift: 0 });
  return { type: "paragraph", attrs: { ...paraAttrs(null, "normal"), box: { start: 0, first: 0, above: 0, below: 0 }, nl }, content: [] };
}

async function tableNode(t: TableItem, ctx: LayoutContext, imageKey: ImageKeyFn, fonts: Set<string>, stats: Stats): Promise<EditorNode> {
  const { xs } = t.grid;
  const widths = xs.slice(1).map((x, i) => Math.round((x - xs[i]) / 0.75));
  const rows = new Map<number, EditorNode[]>();
  for (const c of t.cells) {
    const content: EditorNode[] = [];
    for (const p of c.paras) {
      if (!p.chars.length) continue;
      content.push(await paragraphNode(p, { item: p, styleName: "normal", above: 0, below: 0, emptiesBefore: null, pageBreakAfter: false, listCont: listContinues.has(p) }, ctx, imageKey, fonts, stats));
    }
    if (!content.length) content.push({ type: "paragraph", attrs: { ...paraAttrs(null, "normal"), box: { start: 0, first: 0, above: 0, below: 0 } }, content: [] });
    const cell: EditorNode = {
      type: "tableCell",
      attrs: { colspan: c.cell.colspan, rowspan: c.cell.rowspan, colwidth: widths.slice(c.cell.col, c.cell.col + c.cell.colspan), background: c.cell.background },
      content,
    };
    push(rows, c.cell.row, cell);
  }
  const rowNodes: EditorNode[] = [];
  for (let r = 0; r < t.grid.ys.length - 1; r++) rowNodes.push({ type: "tableRow", attrs: {}, content: rows.get(r) ?? [] });
  return { type: "table", attrs: {}, content: rowNodes };
}

/** Add to the list a map holds for a key */
function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}
