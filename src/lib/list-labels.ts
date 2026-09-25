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
  let run = 0;
  let runType: string | null = null;
  return paragraphs.map((p) => {
    if (!p.list) { run = 0; runType = null; return null; }
    if (p.listId) {
      run = 0;
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
    // A list made in the editor: consecutive items of one kind
    run = runType === p.list ? run + 1 : 1;
    runType = p.list;
    if (p.list === "check") return null;
    return p.list === "bullet" ? "●" : `${run}.`;
  });
}
