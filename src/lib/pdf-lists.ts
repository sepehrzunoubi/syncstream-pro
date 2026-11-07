/**
 * List items of a PDF: the glyph or number that starts an item, what kind
 * of list it makes, and the Docs list style that draws a list's levels most
 * like the PDF does.
 */

import { presetForLevels, type Glyph } from "./list-labels";

export interface Marker {
  kind: "bullet" | "ordered" | "check";
  /** The bullet as Docs draws it, or the numbering */
  glyph: Glyph;
  /** The number it shows (1 for "a.", "i.", "1.") */
  n: number;
  text: string;
}

/**
 * Bullets as Docs names them; other bullets as the closest one Docs has. Word draws its bullets in
 * Symbol and Wingdings, whose glyphs often come out as private-use characters (U+F0xx) or as the
 * letter the font draws over ("§" is Wingdings' square, "o" Courier New's ring).
 */
const BULLETS: Record<string, string> = {
  "●": "●", "•": "●", "∙": "●", "⦁": "●", "⚫": "●", "◉": "●", "·": "●", "*": "●", "\uF0B7": "●", "\uF06C": "●",
  "○": "○", "◦": "○", "⚪": "○", "❍": "○", "o": "○", "\uF0A1": "○",
  "■": "■", "▪": "■", "◼": "■", "◾": "■", "§": "■", "\uF0A7": "■", "\uF06E": "■",
  "□": "□", "▫": "□", "◻": "□", "❑": "□", "❒": "□", "\uF06F": "□", "\uF071": "□",
  "◆": "◆", "♦": "◆", "\uF075": "◆", "◇": "◇", "❖": "❖", "\uF076": "❖",
  "➢": "➢", "➤": "➢", "►": "➢", "▸": "➢", "‣": "➢", "\uF0D8": "➢", "\uF0D8\uF020": "➢", "➔": "➔", "→": "➔", "➜": "➔", "⇨": "➔", "\uF0E8": "➔",
  "★": "★", "☆": "★", "◄": "◄", "◀": "◄",
  "–": "–", "—": "–", "-": "–", "⁃": "–", "−": "–",
  "✓": "✓", "✔": "✓", "\uF0FC": "✓", "☑": "☑", "☒": "☑", "☐": "☐", "❏": "☐",
};

const ROMAN = /^(?=[ivxlcdm]+$)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
function romanValue(s: string): number {
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const a = v[s[i]], b = v[s[i + 1]] ?? 0;
    n += a < b ? -a : a;
  }
  return n;
}
const alphaValue = (s: string) => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 96), 0);

/**
 * The marker a list item's text starts with, if it is one: a bullet, or a number in one of the
 * forms lists use ("1.", "1)", "(1)", "a.", "iv.", "A)", "1.2."). `prevType` breaks the tie
 * between a letter and a Roman numeral ("i." after "h." is a letter).
 */
export function parseMarker(raw: string, prevType?: string | null): Marker | null {
  const text = raw.trim();
  if (!text || text.length > 8) return null;
  const bullet = BULLETS[text];
  if (bullet === "☐" || bullet === "☑") return { kind: "check", glyph: { symbol: "☐" }, n: 1, text };
  if (bullet) return { kind: "bullet", glyph: { symbol: bullet }, n: 1, text };
  const m = /^(\()?((?:\d+\.)*\d+|[a-zA-Z]{1,4})([.)])?$/.exec(text);
  if (!m) return null;
  const open = !!m[1];
  const close = m[3] ?? "";
  // A bare number or letter isn't a list marker; "(1" without its closing isn't either
  if (!close || (open && close !== ")")) return null;
  const body = m[2];
  const fmt = (lvl: string) => `${open ? "(" : ""}${lvl}${close}`;
  if (/^[\d.]+$/.test(body)) {
    const parts = body.split(".").map(Number);
    if (parts.some((p) => !Number.isFinite(p) || p > 999)) return null;
    const n = parts[parts.length - 1];
    if (parts.length > 1) {
      const format = parts.map((_, k) => `%${k}`).join(".") + close;
      return { kind: "ordered", glyph: { type: "DECIMAL", format }, n, text };
    }
    return { kind: "ordered", glyph: { type: body.length > 1 && body.startsWith("0") ? "ZERO_DECIMAL" : "DECIMAL", format: fmt("%0") }, n, text };
  }
  const lower = body.toLowerCase();
  const upper = body !== lower;
  if (body !== lower && body !== body.toUpperCase()) return null;
  // "ii." "iv." are Roman; a lone "i." is too unless it follows "h."; a lone "v." "x." "c." are letters
  const asRoman = ROMAN.test(lower) && (lower.length > 1 ? !/^([cdlm])\1*$/.test(lower) : lower === "i" ? !/ALPHA/.test(prevType ?? "") : /ROMAN/.test(prevType ?? "") && /[vx]/.test(lower));
  if (asRoman) return { kind: "ordered", glyph: { type: upper ? "UPPER_ROMAN" : "ROMAN", format: fmt("%0") }, n: romanValue(lower), text };
  if (lower.length === 1) return { kind: "ordered", glyph: { type: upper ? "UPPER_ALPHA" : "ALPHA", format: fmt("%0") }, n: alphaValue(lower), text };
  return null;
}

/** A glyph drawn as a shape (a filled circle, a ring, a square), as browsers draw bullets */
export function shapeBullet(shape: { fill: string | null; stroke: string | null; curves: boolean }): Marker {
  const symbol = shape.curves ? (shape.fill ? "●" : "○") : shape.fill ? "■" : "□";
  return { kind: "bullet", glyph: { symbol }, n: 1, text: symbol };
}

/** The Docs list style for a list's items, from the glyphs its levels draw */
export function presetFor(kind: "bullet" | "ordered" | "check", levels: { level: number; glyph: Glyph }[]): string {
  if (kind === "check") return "BULLET_CHECKBOX";
  const glyphs: (Glyph | null)[] = [];
  const weights: number[] = [];
  for (const { level, glyph } of levels) {
    // A level's own number is written for its level: "%0." at level 1 is Docs' "%1."
    const own = glyph.format && (glyph.format.match(/%\d/g) ?? []).length === 1;
    const g = own ? { ...glyph, format: glyph.format!.replace(/%0/, `%${level}`) } : glyph;
    if (!glyphs[level]) glyphs[level] = g;
    weights[level] = (weights[level] ?? 0) + 1;
  }
  return presetForLevels(kind, glyphs, weights);
}
