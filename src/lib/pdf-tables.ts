/**
 * Tables drawn with ruling lines: the thin rectangles and strokes a PDF
 * draws a table's borders with, clustered into grids. A cell is the space
 * between rules; two cells with no rule between them are one merged cell.
 */

import type { Shape } from "./pdf-extract";

export interface GridCell {
  row: number;
  col: number;
  rowspan: number;
  colspan: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  background: string | null;
}

export interface Grid {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Column and row edges, left to right and top to bottom */
  xs: number[];
  ys: number[];
  /** Each cell once, merged cells with their spans, in row order */
  cells: GridCell[];
  /** The shapes the table drew (rules and backgrounds), so they aren't read as text decoration */
  used: Set<Shape>;
}

const RULE = 2.5;
const TOL = 1.6;

const isRule = (s: Shape) => s.rect && (s.fill || s.stroke) && Math.min(s.x1 - s.x0, s.y1 - s.y0) <= RULE && Math.max(s.x1 - s.x0, s.y1 - s.y0) >= 4;

function cluster(values: number[], tol: number): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

/** Tables on a page from its ruling lines */
export function findGrids(shapes: Shape[], page: { width: number; height: number }): Grid[] {
  const rules = shapes.filter(isRule);
  if (rules.length < 4) return [];
  // Rules that touch belong to one table
  const parent = rules.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a: Shape, b: Shape) => a.x0 <= b.x1 + TOL && b.x0 <= a.x1 + TOL && a.y0 <= b.y1 + TOL && b.y0 <= a.y1 + TOL;
  const order = rules.map((_, i) => i).sort((a, b) => rules[a].y0 - rules[b].y0);
  for (let a = 0; a < order.length; a++) {
    const ra = rules[order[a]];
    for (let b = a + 1; b < order.length; b++) {
      const rb = rules[order[b]];
      if (rb.y0 > ra.y1 + TOL) break;
      if (touch(ra, rb)) parent[find(order[a])] = find(order[b]);
    }
  }
  const groups = new Map<number, Shape[]>();
  rules.forEach((r, i) => { const k = find(i); push(groups, k, r); });
  const grids: Grid[] = [];
  for (const group of groups.values()) {
    const horiz = group.filter((r) => r.x1 - r.x0 > r.y1 - r.y0);
    const vert = group.filter((r) => r.x1 - r.x0 <= r.y1 - r.y0);
    if (horiz.length < 2 || vert.length < 2) continue;
    const x0 = Math.min(...group.map((r) => r.x0)), x1 = Math.max(...group.map((r) => r.x1));
    const y0 = Math.min(...group.map((r) => r.y0)), y1 = Math.max(...group.map((r) => r.y1));
    if (x1 - x0 < 20 || y1 - y0 < 8 || (x1 - x0 > page.width * 0.98 && y1 - y0 > page.height * 0.98)) continue;
    const xs = cluster(vert.map((r) => (r.x0 + r.x1) / 2), TOL * 1.5);
    const ys = cluster(horiz.map((r) => (r.y0 + r.y1) / 2), TOL * 1.5);
    if (xs.length < 2 || ys.length < 2) continue;
    const cols = xs.length - 1, rows = ys.length - 1;
    // Whether a rule covers most of the edge between two cells
    const covered = (kind: "v" | "h", at: number, from: number, to: number) => {
      const list = kind === "v" ? vert : horiz;
      let cover = 0;
      for (const r of list) {
        const pos = kind === "v" ? (r.x0 + r.x1) / 2 : (r.y0 + r.y1) / 2;
        if (Math.abs(pos - at) > TOL * 1.5) continue;
        const a = kind === "v" ? r.y0 : r.x0, b = kind === "v" ? r.y1 : r.x1;
        cover += Math.max(0, Math.min(b, to) - Math.max(a, from));
      }
      return cover >= 0.6 * (to - from);
    };
    // Cells: each slot joined to its neighbours across a missing rule
    const owner: number[][] = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => r * cols + c));
    const id = Array.from({ length: rows * cols }, (_, i) => i);
    const root = (i: number): number => (id[i] === i ? i : (id[i] = root(id[i])));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (c + 1 < cols && !covered("v", xs[c + 1], ys[r], ys[r + 1])) id[root(owner[r][c + 1])] = root(owner[r][c]);
      if (r + 1 < rows && !covered("h", ys[r + 1], xs[c], xs[c + 1])) id[root(owner[r + 1][c])] = root(owner[r][c]);
    }
    const spans = new Map<number, { r0: number; c0: number; r1: number; c1: number; n: number }>();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const k = root(owner[r][c]);
      const s = spans.get(k) ?? { r0: r, c0: c, r1: r, c1: c, n: 0 };
      s.r0 = Math.min(s.r0, r); s.c0 = Math.min(s.c0, c); s.r1 = Math.max(s.r1, r); s.c1 = Math.max(s.c1, c); s.n++;
      spans.set(k, s);
    }
    // A merge must be a rectangle; anything else is read as separate cells
    const rect = [...spans.values()].every((s) => s.n === (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1));
    const used = new Set<Shape>(group);
    const cells: GridCell[] = [];
    const all = rect ? [...spans.values()] : Array.from({ length: rows * cols }, (_, i) => ({ r0: Math.floor(i / cols), c0: i % cols, r1: Math.floor(i / cols), c1: i % cols, n: 1 }));
    for (const s of all.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0)) {
      const cell: GridCell = { row: s.r0, col: s.c0, rowspan: s.r1 - s.r0 + 1, colspan: s.c1 - s.c0 + 1, x0: xs[s.c0], y0: ys[s.r0], x1: xs[s.c1 + 1], y1: ys[s.r1 + 1], background: null };
      // The cell's own background: a filled rectangle covering it
      const area = (cell.x1 - cell.x0) * (cell.y1 - cell.y0);
      for (const f of shapes) {
        if (!f.fill || !f.rect || isRule(f)) continue;
        const ix = Math.max(0, Math.min(f.x1, cell.x1) - Math.max(f.x0, cell.x0));
        const iy = Math.max(0, Math.min(f.y1, cell.y1) - Math.max(f.y0, cell.y0));
        const fArea = (f.x1 - f.x0) * (f.y1 - f.y0);
        if (ix * iy >= 0.7 * area && fArea <= 1.6 * area) { cell.background = f.fill === "#ffffff" ? null : f.fill; used.add(f); }
      }
      cells.push(cell);
    }
    grids.push({ x0, y0, x1, y1, xs, ys, cells, used });
  }
  return grids;
}

/** Add to the list a map holds for a key */
function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}
