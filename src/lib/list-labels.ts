/**
 * List numbers as Docs shows them. Items of one Docs list keep counting
 * across the paragraphs between them (questions with answers in between);
 * lists made in the editor count consecutive items.
 */

export interface Glyph {
  type?: string | null;
  format?: string | null;
  symbol?: string | null;
  start?: number | null;
}

export interface ListParagraph {
  list?: string | null;
  listId?: string | null;
  level?: number | null;
  glyph?: Glyph | null;
  /** Docs list style of a list made in the editor */
  preset?: string | null;
}

/** What each Docs list style draws at levels 0, 1 and 2 (then repeating); numbered styles give a glyph type and format */
export const PRESET_LEVELS: Record<string, (string | { type: string; format: string })[]> = {
  BULLET_DISC_CIRCLE_SQUARE: ["●", "○", "■"],
  BULLET_DIAMONDX_ARROW3D_SQUARE: ["❖", "➢", "■"],
  BULLET_CHECKBOX: ["☐", "☐", "☐"],
  BULLET_ARROW_DIAMOND_DISC: ["➔", "◆", "●"],
  BULLET_STAR_CIRCLE_SQUARE: ["★", "○", "■"],
  BULLET_ARROW3D_CIRCLE_SQUARE: ["➢", "○", "■"],
  BULLET_LEFTTRIANGLE_DIAMOND_DISC: ["◄", "◆", "●"],
  BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE: ["❖", "◇", "■"],
  BULLET_DIAMOND_CIRCLE_SQUARE: ["◆", "○", "■"],
  NUMBERED_DECIMAL_ALPHA_ROMAN: [{ type: "DECIMAL", format: "%0." }, { type: "ALPHA", format: "%1." }, { type: "ROMAN", format: "%2." }],
  NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS: [{ type: "DECIMAL", format: "%0)" }, { type: "ALPHA", format: "%1)" }, { type: "ROMAN", format: "%2)" }],
  NUMBERED_DECIMAL_NESTED: [{ type: "DECIMAL", format: "%0." }, { type: "DECIMAL", format: "%0.%1." }, { type: "DECIMAL", format: "%0.%1.%2." }],
  NUMBERED_UPPERALPHA_ALPHA_ROMAN: [{ type: "UPPER_ALPHA", format: "%0." }, { type: "ALPHA", format: "%1." }, { type: "ROMAN", format: "%2." }],
  NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL: [{ type: "UPPER_ROMAN", format: "%0." }, { type: "UPPER_ALPHA", format: "%1." }, { type: "DECIMAL", format: "%2." }],
  NUMBERED_ZERODECIMAL_ALPHA_ROMAN: [{ type: "ZERO_DECIMAL", format: "%0." }, { type: "ALPHA", format: "%1." }, { type: "ROMAN", format: "%2." }],
};
const DEFAULT_PRESET: Record<string, string> = { bullet: "BULLET_DISC_CIRCLE_SQUARE", ordered: "NUMBERED_DECIMAL_ALPHA_ROMAN", check: "BULLET_CHECKBOX" };

/** The glyph a preset draws at a level: a symbol, or a numbered glyph with its format */
export function presetGlyph(preset: string, level: number): string | { type: string; format: string } {
  const levels = PRESET_LEVELS[preset] ?? PRESET_LEVELS.BULLET_DISC_CIRCLE_SQUARE;
  const g = levels[level % 3];
  if (typeof g === "string") return g;
  // Deeper levels keep the pattern, numbering their own level
  return level < 3 ? g : { type: g.type, format: g.format.replace(/%\d/g, (m) => `%${level - (2 - Number(m[1]))}`).replace(/%-?\d+/g, (m) => (Number(m.slice(1)) < 0 ? "" : m)) };
}

function roman(n: number): string {
  const table: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

function alpha(n: number): string {
  let out = "";
  while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

export function glyphNumber(n: number, type: string | null | undefined): string {
  switch (type) {
    case "ZERO_DECIMAL": return n < 10 ? `0${n}` : String(n);
    case "ALPHA": return alpha(n);
    case "UPPER_ALPHA": return alpha(n).toUpperCase();
    case "ROMAN": return roman(n);
    case "UPPER_ROMAN": return roman(n).toUpperCase();
    default: return String(n);
  }
}

/** The label of each paragraph ("3.", "a.", "●"), or null (not a list, or a checklist box) */
export function listLabels(paragraphs: ListParagraph[]): (string | null)[] {
  const byList = new Map<string, number[]>();
  let runType: string | null = null;
  return paragraphs.map((p) => {
    if (!p.list) { runType = null; return null; }
    if (p.listId) {
      runType = null;
      const level = Math.max(0, Math.min(8, p.level ?? 0));
      const counts = byList.get(p.listId) ?? [];
      counts[level] = (counts[level] ?? (p.glyph?.start ?? 1) - 1) + 1;
      counts.length = level + 1;
      byList.set(p.listId, counts);
      if (p.list === "check") return null;
      const g = p.glyph ?? {};
      if (g.symbol) return g.symbol;
      if (g.type === "NONE") return "";
      if (p.list === "bullet") return "●";
      const format = g.format || `%${level}.`;
      return format.replace(/%(\d)/g, (_, d: string) => glyphNumber(counts[Number(d)] ?? 1, Number(d) === level ? g.type : "DECIMAL"));
    }
    // A list made in the editor: consecutive items of one kind, counted per level
    const preset = p.preset ?? DEFAULT_PRESET[p.list] ?? DEFAULT_PRESET.bullet;
    const level = Math.max(0, Math.min(8, p.level ?? 0));
    const key = `local:${preset}`;
    if (runType !== key) { runType = key; byList.delete(key); }
    const counts = byList.get(key) ?? [];
    counts[level] = (counts[level] ?? 0) + 1;
    counts.length = level + 1;
    byList.set(key, counts);
    if (p.list === "check") return null;
    const g = presetGlyph(preset, level);
    if (typeof g === "string") return g;
    return g.format.replace(/%(\d)/g, (_, d: string) => glyphNumber(counts[Number(d)] ?? 1, Number(d) === level ? g.type : "DECIMAL"));
  });
}
