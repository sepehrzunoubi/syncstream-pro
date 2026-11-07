/**
 * What a PDF draws, page by page: every glyph with its exact position, font,
 * size and colour, the filled and stroked shapes around it (highlights,
 * underlines, table rules, list bullets), images, links and the structure
 * tree of a tagged PDF. Read from pdf.js's operator list, so a colour or a
 * link that starts in the middle of a line is placed exactly.
 *
 * Coordinates are page points from the top-left corner, y down; a glyph's
 * y is its baseline.
 */

import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { docsFont, fontMetrics, naturalLineHeight, type DocsFont } from "./pdf-fonts";
import { loadPdfJs } from "./pdfjs";

export interface PdfFont {
  id: string;
  /** PostScript name without the subset tag */
  name: string;
  docs: DocsFont;
  /** Fractions of the size */
  ascent: number;
  descent: number;
  /** Docs' natural line height of the family */
  lineHeight: number;
  /** Glyph space to text space */
  unitsScale: number;
}

export interface Glyph {
  ch: string;
  x: number;
  /** Baseline */
  y: number;
  /** Advance */
  w: number;
  size: number;
  font: PdfFont;
  color: string;
  /** Marked-content id, tying it to the structure tree */
  mcid: number | null;
  /** Inside an Artifact (headers, footers, page numbers) */
  artifact: boolean;
  /** Drawn filled and stroked (a fake bold), or slanted (a fake italic) */
  fakeBold: boolean;
  fakeItalic: boolean;
  /** Drawing order on the page */
  seq: number;
}

export interface Shape {
  fill: string | null;
  stroke: string | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** An axis-aligned rectangle (a stroked line is a thin one) */
  rect: boolean;
  curves: boolean;
  mcid: number | null;
  seq: number;
}

export interface PdfPixels {
  width: number;
  height: number;
  /** pdf.js ImageKind: 1 grayscale 1 bit, 2 RGB, 3 RGBA */
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface PageImage {
  /** Same object drawn again (a logo on every page) */
  objId: string | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mcid: number | null;
  seq: number;
  /** Decoded pixels, until they are encoded (see encoded) */
  pixels: PdfPixels | null;
  /** The image as a file Docs can insert; null when it couldn't be encoded */
  encoded?: { mime: "image/png" | "image/jpeg"; data: Uint8Array; width: number; height: number } | null;
}

export interface PageLink {
  url: string | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** An element of the structure tree */
export interface StructNode {
  role: string;
  parent: StructNode | null;
  kids: StructNode[];
  /** Its place in the tree, depth first */
  order: number;
  alt?: string;
  lang?: string;
  colSpan?: number;
  rowSpan?: number;
  /** Marked-content ids directly under it */
  mcids: number[];
}

export interface PdfPage {
  index: number;
  width: number;
  height: number;
  glyphs: Glyph[];
  shapes: Shape[];
  images: PageImage[];
  links: PageLink[];
  struct: { root: StructNode; byMcid: Map<number, StructNode> } | null;
  /** Glyphs left out: rotated or vertical text, or text drawn outside the page */
  skipped: number;
}

export interface PdfDocumentInfo {
  pages: number;
  producer: string;
  creator: string;
  title: string;
  tagged: boolean;
  lang: string | null;
}

export class PdfOpenError extends Error {
  constructor(public code: "encrypted" | "invalid", message: string) {
    super(message);
  }
}

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/* eslint-disable @typescript-eslint/no-explicit-any */
type PdfJs = any;

/** pdf.js's own font and CMap data, so PDFs that only name a standard font (Helvetica) still measure right */
function dataDirs(): { standardFontDataUrl?: string; cMapUrl?: string } {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    const root = path.dirname(req.resolve("pdfjs-dist/package.json"));
    const fonts = path.join(root, "standard_fonts") + path.sep;
    const cmaps = path.join(root, "cmaps") + path.sep;
    return { ...(fs.existsSync(fonts) ? { standardFontDataUrl: fonts } : {}), ...(fs.existsSync(cmaps) ? { cMapUrl: cmaps } : {}) };
  } catch {
    return {};
  }
}

export interface OpenedPdf {
  info: PdfDocumentInfo;
  page(n: number): Promise<PdfPage>;
  close(): Promise<void>;
}

/** Open a PDF. Throws PdfOpenError when it needs a password or isn't a PDF. */
export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const pdfjs: PdfJs = await loadPdfJs();
  const task = pdfjs.getDocument({
    // pdf.js takes ownership of (and detaches) the buffer it is given
    data: new Uint8Array(bytes),
    ...dataDirs(),
    cMapPacked: true,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    fontExtraProperties: true,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc: any;
  try {
    doc = await task.promise;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "PasswordException") throw new PdfOpenError("encrypted", "password");
    throw new PdfOpenError("invalid", String((err as Error)?.message ?? err));
  }
  const meta = await doc.getMetadata().catch(() => null);
  const markInfo = await doc.getMarkInfo().catch(() => null);
  const marked = markInfo instanceof Map ? markInfo.get("Marked") === true : markInfo?.Marked === true;
  const info: PdfDocumentInfo = {
    pages: doc.numPages,
    producer: String(meta?.info?.Producer ?? ""),
    creator: String(meta?.info?.Creator ?? ""),
    title: String(meta?.info?.Title ?? ""),
    tagged: marked,
    lang: typeof meta?.info?.Language === "string" ? meta.info.Language : null,
  };
  const fonts = new Map<string, PdfFont>();
  return {
    info,
    page: (n: number) => readPage(pdfjs, doc, n, fonts),
    close: async () => { await task.destroy().catch(() => {}); },
  };
}

/** Ligatures and Arabic presentation forms as plain letters; everything else as drawn */
function normalizeChars(s: string): string {
  return /[\uFB00-\uFB06\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s) ? s.normalize("NFKC") : s;
}

function hexOf(args: any[]): string | null {
  const v = args?.[0];
  if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (args && args.length >= 3 && args.slice(0, 3).every((x: unknown) => typeof x === "number")) {
    const h = (x: number) => Math.max(0, Math.min(255, Math.round(x <= 1 && args.every((y: number) => y <= 1) ? x * 255 : x))).toString(16).padStart(2, "0");
    return `#${h(args[0])}${h(args[1])}${h(args[2])}`;
  }
  return null;
}
const grayHex = (g: number) => { const v = Math.round(Math.max(0, Math.min(1, g)) * 255).toString(16).padStart(2, "0"); return `#${v}${v}${v}`; };
const cmykHex = (c: number, m: number, y: number, k: number) => {
  const ch = (v: number) => Math.round(255 * (1 - Math.min(1, v + k))).toString(16).padStart(2, "0");
  return `#${ch(c)}${ch(m)}${ch(y)}`;
};

function fontOf(page: any, id: string, cache: Map<string, PdfFont>): PdfFont {
  const hit = cache.get(id);
  if (hit) return hit;
  let raw: any = null;
  try { raw = page.commonObjs.has(id) ? page.commonObjs.get(id) : null; } catch { raw = null; }
  const name = String(raw?.name ?? "").replace(/^[A-Z]{6}\+/, "");
  const docs = docsFont(name || raw?.fallbackName || "", { serif: raw?.isSerifFont, mono: raw?.isMonospace, bold: raw?.bold || raw?.black, italic: raw?.italic });
  const m = fontMetrics(docs.family, raw);
  const unitsScale = typeof raw?.fontMatrix?.[0] === "number" && raw.fontMatrix[0] > 0 ? raw.fontMatrix[0] : 0.001;
  const font: PdfFont = { id, name, docs, ascent: m.ascent, descent: m.descent, lineHeight: naturalLineHeight(docs.family, raw), unitsScale };
  cache.set(id, font);
  return font;
}

function walkStruct(tree: any): PdfPage["struct"] {
  if (!tree || typeof tree !== "object") return null;
  const byMcid = new Map<number, StructNode>();
  let order = 0;
  const build = (n: any, parent: StructNode | null, depth: number): StructNode => {
    const node: StructNode = { role: String(n.role ?? ""), parent, kids: [], order: order++, mcids: [] };
    if (typeof n.alt === "string") node.alt = n.alt;
    if (typeof n.lang === "string") node.lang = n.lang;
    if (Number.isInteger(n.colSpan)) node.colSpan = n.colSpan;
    if (Number.isInteger(n.rowSpan)) node.rowSpan = n.rowSpan;
    for (const c of n.children ?? []) {
      if (c?.type === "content" && typeof c.id === "string") {
        const m = /_mc(\d+)$/.exec(c.id);
        if (m) { const id = Number(m[1]); node.mcids.push(id); if (!byMcid.has(id)) byMcid.set(id, node); }
      } else if (c && !c.type && depth < 200) node.kids.push(build(c, node, depth + 1));
    }
    return node;
  };
  const root = build(tree, null, 0);
  return byMcid.size ? { root, byMcid } : null;
}

async function pixelsOf(page: any, id: string): Promise<PdfPixels | null> {
  const objs = id.startsWith("g_") ? page.commonObjs : page.objs;
  const img: any = await new Promise((resolve) => {
    try { objs.get(id, resolve); } catch { resolve(null); }
    setTimeout(() => resolve(null), 5000);
  });
  if (!img?.data || !img.width || !img.height) return null;
  return { width: img.width, height: img.height, kind: img.kind, data: img.data };
}

/** Pixels above this aren't decoded into the result (a 6000 x 6000 scan) */
const MAX_IMAGE_PIXELS = 40_000_000;

async function readPage(pdfjs: PdfJs, doc: any, n: number, fonts: Map<string, PdfFont>): Promise<PdfPage> {
  const { OPS } = pdfjs;
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform as Matrix;
  const width = viewport.width as number;
  const height = viewport.height as number;
  const ops = await page.getOperatorList();
  const fn: number[] = ops.fnArray;
  const args: any[][] = ops.argsArray;

  const glyphs: Glyph[] = [];
  const shapes: Shape[] = [];
  const images: PageImage[] = [];
  let skipped = 0;
  let seq = 0;

  interface Box { x0: number; y0: number; x1: number; y1: number }
  interface GState { ctm: Matrix; fill: string; stroke: string; lineWidth: number; fillAlpha: number; font: PdfFont | null; size: number; charSp: number; wordSp: number; hScale: number; leading: number; rise: number; render: number; clip: Box | null }
  let g: GState = { ctm: IDENTITY, fill: "#000000", stroke: "#000000", lineWidth: 1, fillAlpha: 1, font: null, size: 0, charSp: 0, wordSp: 0, hScale: 1, leading: 0, rise: 0, render: 0, clip: null };
  // A clip path applies to what is drawn after the path that follows it (as its bounding box)
  let pendingClip = false;
  const clipped = (x: number, y: number) => !!g.clip && (x < g.clip.x0 - 0.5 || x > g.clip.x1 + 0.5 || y < g.clip.y0 - 0.5 || y > g.clip.y1 + 0.5);
  const outside = (b: Box) => !!g.clip && (b.x1 < g.clip.x0 - 0.5 || b.x0 > g.clip.x1 + 0.5 || b.y1 < g.clip.y0 - 0.5 || b.y0 > g.clip.y1 + 0.5);
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const marked: { tag: string; mcid: number | null }[] = [];
  const currentMcid = () => { for (let i = marked.length - 1; i >= 0; i--) if (marked[i].mcid != null) return marked[i].mcid; return null; };
  const inArtifact = () => marked.some((m) => m.tag === "Artifact");
  const dev = () => mul(base, g.ctm);

  const addShape = (paintOp: number, buf: ArrayLike<number> | null) => {
    if (!buf) return;
    const fillOps = [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke];
    const strokeOps = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke];
    const filled = fillOps.includes(paintOp);
    const stroked = strokeOps.includes(paintOp);
    if (!filled && !stroked) return;
    const m = dev();
    const lw = Math.max(0.1, g.lineWidth * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])));
    // Subpaths, each a list of points; a rectangle or a line is kept as such
    const subs: { pts: [number, number][]; curves: boolean; closed: boolean }[] = [];
    let cur: { pts: [number, number][]; curves: boolean; closed: boolean } | null = null;
    for (let i = 0; i < buf.length;) {
      const op = buf[i++];
      if (op === 0) { cur = { pts: [apply(m, buf[i], buf[i + 1])], curves: false, closed: false }; subs.push(cur); i += 2; }
      else if (op === 1) { cur?.pts.push(apply(m, buf[i], buf[i + 1])); i += 2; }
      else if (op === 2) { if (cur) { cur.curves = true; cur.pts.push(apply(m, buf[i], buf[i + 1]), apply(m, buf[i + 2], buf[i + 3]), apply(m, buf[i + 4], buf[i + 5])); } i += 6; }
      else if (op === 3) { if (cur) { cur.curves = true; cur.pts.push(apply(m, buf[i], buf[i + 1]), apply(m, buf[i + 2], buf[i + 3])); } i += 4; }
      else if (op === 4) { if (cur) cur.closed = true; }
      else break;
    }
    const box = (pts: [number, number][]) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return { x0, y0, x1, y1 };
    };
    const axisRect = (pts: [number, number][]) => {
      const b = box(pts);
      return pts.length >= 4 && pts.length <= 5 && pts.every(([x, y]) => (Math.abs(x - b.x0) < 0.05 || Math.abs(x - b.x1) < 0.05) && (Math.abs(y - b.y0) < 0.05 || Math.abs(y - b.y1) < 0.05));
    };
    const mcid = currentMcid();
    const push = (s: Omit<Shape, "mcid" | "seq">) => {
      if (s.x1 < -2 || s.y1 < -2 || s.x0 > width + 2 || s.y0 > height + 2 || outside(s)) return;
      shapes.push({ ...s, mcid, seq: seq++ });
    };
    const simple = subs.every((s) => !s.curves && (axisRect(s.pts) || s.pts.length === 2));
    if (simple && subs.length > 1 && subs.length <= 400) {
      for (const s of subs) emit(s.pts, false);
    } else {
      const all = subs.flatMap((s) => s.pts);
      if (all.length) emit(all, subs.some((s) => s.curves), subs.length === 1 && axisRect(subs[0].pts));
    }
    function emit(pts: [number, number][], curves: boolean, isRect = axisRect(pts)) {
      const b = box(pts);
      const line = pts.length === 2 && (Math.abs(b.x1 - b.x0) < 0.05 || Math.abs(b.y1 - b.y0) < 0.05);
      if (filled) push({ fill: g.fillAlpha < 0.2 ? null : g.fill, stroke: null, ...b, rect: isRect, curves });
      if (stroked) {
        const h = lw / 2;
        if (line || isRect) {
          // A stroked line or rectangle as the thin filled rectangles it draws
          const edges = line ? [b] : [{ ...b, y1: b.y0 }, { ...b, y0: b.y1 }, { ...b, x1: b.x0 }, { ...b, x0: b.x1 }];
          for (const e of edges) push({ fill: null, stroke: g.stroke, x0: e.x0 - (e.x1 - e.x0 < 0.05 ? h : 0), x1: e.x1 + (e.x1 - e.x0 < 0.05 ? h : 0), y0: e.y0 - (e.y1 - e.y0 < 0.05 ? h : 0), y1: e.y1 + (e.y1 - e.y0 < 0.05 ? h : 0), rect: true, curves: false });
        } else push({ fill: null, stroke: g.stroke, ...b, rect: false, curves });
      }
    }
  };

  const pendingPixels: { img: PageImage; id: string }[] = [];
  for (let i = 0; i < fn.length; i++) {
    const op = fn[i];
    const a = args[i];
    switch (op) {
      case OPS.save: stack.push({ ...g }); break;
      case OPS.restore: g = stack.pop() ?? g; break;
      case OPS.transform: g.ctm = mul(g.ctm, a as Matrix); break;
      case OPS.paintFormXObjectBegin: stack.push({ ...g }); if (Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0])) g.ctm = mul(g.ctm, Array.from(a[0] as ArrayLike<number>) as Matrix); break;
      case OPS.paintFormXObjectEnd: g = stack.pop() ?? g; break;
      case OPS.setFillRGBColor: case OPS.setFillColor: { const h = hexOf(a); if (h) g.fill = h; break; }
      case OPS.setStrokeRGBColor: case OPS.setStrokeColor: { const h = hexOf(a); if (h) g.stroke = h; break; }
      case OPS.setFillGray: g.fill = grayHex(a[0]); break;
      case OPS.setStrokeGray: g.stroke = grayHex(a[0]); break;
      case OPS.setFillCMYKColor: g.fill = cmykHex(a[0], a[1], a[2], a[3]); break;
      case OPS.setStrokeCMYKColor: g.stroke = cmykHex(a[0], a[1], a[2], a[3]); break;
      case OPS.setLineWidth: g.lineWidth = a[0]; break;
      case OPS.setGState: {
        for (const [k, v] of (a?.[0] ?? []) as [string, unknown][]) {
          if (k === "ca" && typeof v === "number") g.fillAlpha = v;
          else if (k === "LW" && typeof v === "number") g.lineWidth = v;
        }
        break;
      }
      case OPS.beginText: tm = IDENTITY; tlm = IDENTITY; break;
      case OPS.setFont: g.font = fontOf(page, a[0], fonts); g.size = a[1]; break;
      case OPS.setCharSpacing: g.charSp = a[0]; break;
      case OPS.setWordSpacing: g.wordSp = a[0]; break;
      case OPS.setHScale: g.hScale = a[0] / 100; break;
      case OPS.setLeading: g.leading = a[0]; break;
      case OPS.setTextRise: g.rise = a[0]; break;
      case OPS.setTextRenderingMode: g.render = a[0]; break;
      case OPS.setTextMatrix: tm = Array.from(a[0] ?? a) as Matrix; tlm = tm; break;
      case OPS.moveText: tlm = mul(tlm, [1, 0, 0, 1, a[0], a[1]]); tm = tlm; break;
      case OPS.setLeadingMoveText: g.leading = -a[1]; tlm = mul(tlm, [1, 0, 0, 1, a[0], a[1]]); tm = tlm; break;
      case OPS.nextLine: tlm = mul(tlm, [1, 0, 0, 1, 0, -g.leading]); tm = tlm; break;
      case OPS.beginMarkedContent: marked.push({ tag: String(a?.[0] ?? ""), mcid: null }); break;
      case OPS.beginMarkedContentProps: {
        const props = a?.[1];
        const mcid = typeof props === "number" ? props : typeof props?.MCID === "number" ? props.MCID : null;
        marked.push({ tag: String(a?.[0] ?? ""), mcid });
        break;
      }
      case OPS.endMarkedContent: marked.pop(); break;
      case OPS.showText: case OPS.showSpacedText: {
        const font = g.font;
        if (!font) break;
        const fm = font.unitsScale;
        const invisible = g.render === 3 || g.render === 7 || g.fillAlpha < 0.15;
        const m = dev();
        for (const gl of (a[0] ?? []) as any[]) {
          if (typeof gl === "number") { tm = mul(tm, [1, 0, 0, 1, -gl * 0.001 * g.size * g.hScale, 0]); continue; }
          if (!gl) continue;
          const adv = ((gl.width ?? 0) * fm * g.size + g.charSp + (gl.isSpace ? g.wordSp : 0)) * g.hScale;
          const trm = mul(m, mul(tm, [g.size * g.hScale, 0, 0, g.size, 0, g.rise]));
          const next = mul(m, mul(mul(tm, [1, 0, 0, 1, adv, 0]), [g.size * g.hScale, 0, 0, g.size, 0, g.rise]));
          tm = mul(tm, [1, 0, 0, 1, adv, 0]);
          const ch = normalizeChars(String(gl.unicode ?? ""));
          if (!ch || invisible) continue;
          const size = Math.hypot(trm[2], trm[3]);
          // Horizontal text only: rotated labels and vertical writing don't flow with the page's text
          if (Math.abs(trm[1]) > 0.02 * Math.abs(trm[0]) || trm[0] <= 0 || size < 1) { skipped++; continue; }
          const x = trm[4];
          const y = trm[5];
          if (x < -size || x > width + size || y < 0 || y > height + size) { skipped++; continue; }
          // Clipped away: not on the page as printed
          if (clipped(x + (next[4] - x) / 2, y - size * 0.3)) continue;
          glyphs.push({
            ch, x, y, w: Math.max(0, next[4] - x), size, font, color: g.fill, mcid: currentMcid(), artifact: inArtifact(),
            fakeBold: g.render === 2 && g.lineWidth > 0, fakeItalic: Math.abs(trm[2] / trm[3]) > 0.12, seq: seq++,
          });
        }
        break;
      }
      case OPS.clip: case OPS.eoClip: pendingClip = true; break;
      case OPS.constructPath: {
        const [paintOp, data, minMax] = a as [number, any[], ArrayLike<number> | null];
        const buf = data?.[0];
        if (pendingClip) {
          pendingClip = false;
          if (minMax && minMax.length >= 4 && Number.isFinite(minMax[0])) {
            const m = dev();
            const pts = [apply(m, minMax[0], minMax[1]), apply(m, minMax[2], minMax[3]), apply(m, minMax[0], minMax[3]), apply(m, minMax[2], minMax[1])];
            const box = { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
            g.clip = g.clip ? { x0: Math.max(g.clip.x0, box.x0), y0: Math.max(g.clip.y0, box.y0), x1: Math.min(g.clip.x1, box.x1), y1: Math.min(g.clip.y1, box.y1) } : box;
          }
        }
        if (buf && typeof buf.length === "number") addShape(paintOp, buf);
        break;
      }
      case OPS.paintImageXObject: case OPS.paintInlineImageXObject: {
        const m = dev();
        const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const img: PageImage = { objId: typeof a[0] === "string" ? a[0] : null, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), mcid: currentMcid(), seq: seq++, pixels: null };
        if (img.x1 < 0 || img.y1 < 0 || img.x0 > width || img.y0 > height || outside(img)) break;
        if (typeof a[0] === "string") pendingPixels.push({ img, id: a[0] });
        else if (a[0]?.data) img.pixels = { width: a[0].width, height: a[0].height, kind: a[0].kind, data: a[0].data };
        images.push(img);
        break;
      }
    }
  }
  for (const { img, id } of pendingPixels) {
    const px = await pixelsOf(page, id);
    if (px && px.width * px.height <= MAX_IMAGE_PIXELS) img.pixels = px;
  }

  const annots = await page.getAnnotations().catch(() => []);
  const links: PageLink[] = [];
  for (const an of annots as any[]) {
    if (an?.annotationType !== 2 || !Array.isArray(an.rect)) continue;
    const [ax0, ay0] = apply(base, an.rect[0], an.rect[1]);
    const [ax1, ay1] = apply(base, an.rect[2], an.rect[3]);
    const r = [ax0, ay0, ax1, ay1];
    const url = typeof an.url === "string" ? an.url : typeof an.unsafeUrl === "string" ? an.unsafeUrl : null;
    links.push({ url, x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) });
  }
  const struct = walkStruct(await page.getStructTree().catch(() => null));
  page.cleanup();
  return { index: n - 1, width, height, glyphs, shapes, images, links, struct, skipped };
}
