/**
 * Glyphs into lines of text. A line is the glyphs on one baseline, its
 * superscripts and subscripts with it, in reading order (right-to-left
 * runs put back in the order they are typed), with the spaces a PDF often
 * leaves out restored from the gaps between words.
 */

import type { Glyph, PageImage } from "./pdf-extract";

export interface Char {
  /** Text; " " or "\t" for a gap with no glyph of its own */
  ch: string;
  x0: number;
  x1: number;
  /** The glyph's own baseline */
  y: number;
  /** Size as drawn */
  size: number;
  glyph: Glyph | null;
  /** An image drawn in the line, as a character */
  image?: PageImage;
  /** 1 superscript, -1 subscript */
  shift: 0 | 1 | -1;
}

export interface Line {
  /** In reading order */
  chars: Char[];
  /** Ink edges of what isn't a space */
  x0: number;
  x1: number;
  /** Baseline */
  y: number;
  /** The size most of its text is */
  size: number;
  /** The tallest glyph's top and the lowest descent */
  top: number;
  bottom: number;
  rtl: boolean;
  page: number;
}

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR = /[\p{L}\p{M}]/u;
const DIGIT = /\p{N}/u;
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«" };
const isSpace = (s: string) => /^\s+$/.test(s);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** The size that most of these glyphs' text is in (by characters) */
export function dominantSize(glyphs: { size: number; ch: string }[]): number {
  const count = new Map<number, number>();
  for (const g of glyphs) {
    if (isSpace(g.ch)) continue;
    const k = Math.round(g.size * 2) / 2;
    count.set(k, (count.get(k) ?? 0) + g.ch.length);
  }
  let best = 0, n = -1;
  for (const [k, c] of count) if (c > n || (c === n && k > best)) { best = k; n = c; }
  return best || (glyphs[0]?.size ?? 11);
}

/**
 * Visual order (left to right) to reading order. A right-to-left line reads right to left except for
 * its runs of Latin letters and digits; a left-to-right line has its right-to-left runs reversed.
 * Brackets in right-to-left runs are drawn mirrored, so they swap back.
 */
function toLogical(chars: Char[]): { chars: Char[]; rtl: boolean } {
  let r = 0, l = 0;
  for (const c of chars) {
    if (RTL.test(c.ch)) r += c.ch.length;
    else if (LTR.test(c.ch)) l += c.ch.length;
  }
  if (!r) return { chars, rtl: false };
  const rtl = r >= l;
  const kind = (c: Char): "R" | "L" | "N" => (RTL.test(c.ch) ? "R" : LTR.test(c.ch) || DIGIT.test(c.ch) || c.image ? "L" : "N");
  // Maximal runs of the embedded direction (neutrals inside a run belong to it)
  const embedded = rtl ? "L" : "R";
  const out = rtl ? [...chars].reverse() : [...chars];
  const kinds = out.map(kind);
  const inRun = new Array(out.length).fill(false);
  for (let i = 0; i < out.length;) {
    if (kinds[i] !== embedded) { i++; continue; }
    let j = i;
    let last = i;
    while (j < out.length && kinds[j] !== (embedded === "L" ? "R" : "L")) { if (kinds[j] === embedded) last = j; j++; }
    const run = out.slice(i, last + 1).reverse();
    out.splice(i, run.length, ...run);
    for (let k = i; k <= last; k++) inRun[k] = true;
    i = last + 1;
  }
  // Mirrored glyphs: every character drawn right to left
  for (let i = 0; i < out.length; i++) {
    const rtlChar = rtl ? !inRun[i] : inRun[i];
    if (rtlChar && MIRROR[out[i].ch]) out[i] = { ...out[i], ch: MIRROR[out[i].ch] };
  }
  return { chars: out, rtl };
}

/**
 * Lines of one flow of text (a paragraph, a cell, a column). Glyphs on one baseline make a line;
 * smaller glyphs raised or lowered next to them are its superscripts and subscripts.
 */
export function buildLines(glyphs: Glyph[], page: number, images: PageImage[] = []): Line[] {
  if (!glyphs.length) return [];
  const sorted = [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x);
  interface Cluster { y: number; size: number; glyphs: Glyph[]; x0: number; x1: number }
  const clusters: Cluster[] = [];
  for (const g of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(g.y - c.y) <= 0.22 * Math.max(c.size, g.size)) {
      c.glyphs.push(g);
      if (g.size > c.size) c.size = g.size;
      c.x0 = Math.min(c.x0, g.x);
      c.x1 = Math.max(c.x1, g.x + g.w);
    } else clusters.push({ y: g.y, size: g.size, glyphs: [g], x0: g.x, x1: g.x + g.w });
  }
  // A cluster of small glyphs just above or below a line is its superscripts or subscripts
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if (!c.glyphs.length) continue;
    const small = dominantSize(c.glyphs);
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const j of [i - 1, i + 1, i - 2, i + 2]) {
      const n = clusters[j];
      if (!n || n === c || !n.glyphs.length) continue;
      const big = dominantSize(n.glyphs);
      const d = Math.abs(c.y - n.y);
      if (small < 0.9 * big && d < 0.62 * big && d > 0.08 * big && c.x0 >= n.x0 - 2 * big && c.x1 <= n.x1 + 4 * big && d < bestD) { best = n; bestD = d; }
    }
    if (best) {
      best.glyphs.push(...c.glyphs);
      best.x0 = Math.min(best.x0, c.x0);
      best.x1 = Math.max(best.x1, c.x1);
      c.glyphs = [];
    }
  }
  const lines: Line[] = [];
  for (const c of clusters) {
    if (!c.glyphs.length) continue;
    lines.push(lineOf(c.glyphs, page, images));
  }
  lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  return lines;
}

/** One line from the glyphs on its baseline (and its raised and lowered glyphs) */
export function lineOf(glyphs: Glyph[], page: number, images: PageImage[] = []): Line {
  const size = dominantSize(glyphs);
  // The baseline most full-size glyphs sit on
  const main = glyphs.filter((g) => g.size >= size * 0.9 && !isSpace(g.ch));
  const y = median((main.length ? main : glyphs).map((g) => g.y));
  const vis = [...glyphs].sort((a, b) => a.x - b.x || a.seq - b.seq);
  // A glyph drawn twice over itself (a fake bold) is one glyph
  const dedup: Glyph[] = [];
  for (const g of vis) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.ch === g.ch && Math.abs(prev.x - g.x) < 0.2 * g.size && Math.abs(prev.y - g.y) < 0.5 && g.w > 0) { dedup[dedup.length - 1] = { ...prev, fakeBold: true }; continue; }
    dedup.push(g);
  }
  // Gaps between letters with no space glyph: a word space when wider than the line's letter spacing allows
  const gaps: number[] = [];
  for (let i = 1; i < dedup.length; i++) {
    const a = dedup[i - 1], b = dedup[i];
    if (isSpace(a.ch) || isSpace(b.ch)) continue;
    gaps.push(b.x - (a.x + a.w));
  }
  // Letter spacing: the gap most letters have (none in ordinary text)
  const tracking = Math.max(0, median(gaps));
  const hasSpaces = dedup.some((g) => isSpace(g.ch));
  const chars: Char[] = [];
  const shiftOf = (g: Glyph): 0 | 1 | -1 => {
    if (g.size >= size * 0.92) return 0;
    const d = y - g.y;
    return d > 0.12 * size ? 1 : d < -0.08 * size ? -1 : 0;
  };
  for (let i = 0; i < dedup.length; i++) {
    const g = dedup[i];
    const prev = dedup[i - 1];
    if (prev && !isSpace(prev.ch) && !isSpace(g.ch)) {
      const gap = g.x - (prev.x + prev.w);
      const em = Math.max(prev.size, g.size) || size;
      // With space glyphs in the line, a gap must be larger to be a space no one drew
      const need = (hasSpaces ? 0.3 : 0.15) * em + tracking;
      if (gap > 2.5 * em) chars.push({ ch: "\t", x0: prev.x + prev.w, x1: g.x, y, size, glyph: null, shift: 0 });
      else if (gap > need) chars.push({ ch: " ", x0: prev.x + prev.w, x1: g.x, y, size, glyph: null, shift: 0 });
    }
    chars.push({ ch: g.ch, x0: g.x, x1: g.x + g.w, y: g.y, size: g.size, glyph: g, shift: shiftOf(g) });
  }
  // Images sitting on this baseline, between its words
  for (const img of images) chars.push({ ch: "\uFFFC", x0: img.x0, x1: img.x1, y: img.y1, size, glyph: null, image: img, shift: 0 });
  chars.sort((a, b) => (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
  // Collapse runs of spaces Docs would hold as one (a space glyph next to a restored one)
  const merged: Char[] = [];
  for (const c of chars) {
    const p = merged[merged.length - 1];
    if (p && isSpace(p.ch) && isSpace(c.ch) && (!p.glyph || !c.glyph)) { if (!p.glyph) merged[merged.length - 1] = c; continue; }
    merged.push(c);
  }
  const { chars: logical, rtl } = toLogical(merged);
  const ink = merged.filter((c) => !isSpace(c.ch));
  let top = Infinity, bottom = -Infinity;
  for (const c of ink) {
    if (c.image) { top = Math.min(top, c.image.y0); bottom = Math.max(bottom, c.image.y1); continue; }
    const f = c.glyph?.font;
    top = Math.min(top, c.y - (f?.ascent ?? 0.9) * c.size);
    bottom = Math.max(bottom, c.y + (f?.descent ?? 0.22) * c.size);
  }
  if (!ink.length) { top = y - size; bottom = y; }
  return {
    chars: logical,
    x0: ink.length ? Math.min(...ink.map((c) => c.x0)) : merged[0]?.x0 ?? 0,
    x1: ink.length ? Math.max(...ink.map((c) => c.x1)) : merged[0]?.x1 ?? 0,
    y,
    size,
    top,
    bottom,
    rtl,
    page,
  };
}

/** A line's text */
export const lineText = (l: Line) => l.chars.map((c) => c.ch).join("");
