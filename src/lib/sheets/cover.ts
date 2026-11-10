import type { Rect } from "./model";

/** The fewest rectangles (rows merged where their columns match) covering these cells, given row by row */
export function coverRects(cells: readonly { r: number; c: number }[]): Rect[] {
  const out: Rect[] = [];
  const open = new Map<string, Rect>();
  let i = 0;
  while (i < cells.length) {
    const r = cells[i].r;
    const seen = new Set<string>();
    while (i < cells.length && cells[i].r === r) {
      const c0 = cells[i].c;
      let c1 = c0;
      while (i + 1 < cells.length && cells[i + 1].r === r && cells[i + 1].c === c1 + 1) { i++; c1++; }
      i++;
      const key = `${c0},${c1}`;
      const rect = open.get(key);
      if (rect && rect[2] === r - 1) rect[2] = r;
      else { const made: Rect = [r, c0, r, c1]; open.set(key, made); out.push(made); }
      seen.add(key);
    }
    for (const key of Array.from(open.keys())) if (!seen.has(key)) open.delete(key);
  }
  return out;
}
