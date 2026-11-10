/**
 * The order a spreadsheet is built in, as a person builds one.
 *
 * A sheet goes top to bottom in sections (runs of rows with something in them), and inside a
 * section left to right in blocks (runs of columns). Each block gets its labels first, then the
 * numbers typed by hand, then its formulas. A formula is never typed before every cell it reads
 * holds its value: one that reads cells further down, to the right or on a later tab waits, and is
 * written (going back to it) as soon as the last of them is in. A formula repeated down a column or
 * along a row is typed once and filled. When a section's cells are in, it is formatted: merges,
 * row heights, then each part of the look on the ranges that share it (bold on these, this fill on
 * those, a number format, borders), the way a toolbar is used. What most of a sheet shares (its
 * font, size, text colour) is set once, on the whole area, before any typing.
 */

import { precedents, formulaSignature } from "./formula";
import { hasContent, type Cell, type Rect, type Workbook } from "./model";
import { ASPECTS, aspectKey, hasAspect, type Aspect, type Step } from "./steps";

/** A block of this many hand-typed values or more is pasted in, a few rows at a time */
export const PASTE_MIN_CELLS = 300;
export const PASTE_ROWS = 25;
/** Cells one reference is followed into; a larger range is followed by its first and last cells */
const MAX_RANGE_EDGES = 4000;
/** Parts of the look set once for the whole sheet when most of its cells share one value */
const BASE_ASPECTS: readonly Aspect[] = ["family", "size", "color", "vAlign", "hAlign", "wrap", "numFmt", "fill"];
const BASE_MIN_CELLS = 24;

/** A section of a sheet, for the plan's outline */
export interface PlanSection {
  /** Index of its first step */
  at: number;
  sheet: number;
  /** Its rows, from 0, inclusive */
  rows: [number, number];
  /** Its first label, when it has one */
  title: string;
}

export interface StepPlan { steps: Step[]; sections: PlanSection[] }

/** A sheet's cells by row, for walking a rectangle */
class RowIndex {
  /** rows[r] = [first, past last] indexes into cells */
  private readonly rows = new Map<number, [number, number]>();
  readonly maxRow: number;
  constructor(readonly cells: readonly Cell[]) {
    let max = -1;
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i].r;
      const span = this.rows.get(r);
      if (span) span[1] = i + 1;
      else this.rows.set(r, [i, i + 1]);
      if (r > max) max = r;
    }
    this.maxRow = max;
  }

  /** Indexes of the cells in row `r` from column c0 to c1 */
  inRow(r: number, c0: number, c1: number, fn: (index: number) => void): void {
    const span = this.rows.get(r);
    if (!span) return;
    // (cells in a row are in column order: find the first at or past c0)
    let lo = span[0], hi = span[1];
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cells[mid].c < c0) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < span[1] && this.cells[i].c <= c1; i++) fn(i);
  }

  inRect(rect: Rect, fn: (index: number) => void): void {
    const last = Math.min(rect[2], this.maxRow);
    if (last - rect[0] > this.rows.size * 4) {
      // A tall range over few rows: go by the rows there are
      for (const r of this.rows.keys()) if (r >= rect[0] && r <= last) this.inRow(r, rect[1], rect[3], fn);
      return;
    }
    for (let r = rect[0]; r <= last; r++) this.inRow(r, rect[1], rect[3], fn);
  }

  at(r: number, c: number): number {
    let found = -1;
    this.inRow(r, c, c, (i) => { found = i; });
    return found;
  }
}

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

/** Runs of consecutive numbers in a sorted list */
function runs(sorted: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else if (!last || last[1] !== n) out.push([n, n]);
  }
  return out;
}

interface Node { s: number; i: number }

/** A min-heap of formula cells ready to type, earliest tab, row and column first */
class ReadyHeap {
  private readonly items: Node[] = [];
  constructor(private readonly wb: Workbook) {}
  private less(a: Node, b: Node): boolean {
    if (a.s !== b.s) return a.s < b.s;
    const x = this.wb.sheets[a.s].cells[a.i], y = this.wb.sheets[b.s].cells[b.i];
    return x.r !== y.r ? x.r < y.r : x.c < y.c;
  }
  get size() { return this.items.length; }
  push(n: Node) {
    const h = this.items;
    h.push(n);
    for (let i = h.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  pop(): Node | undefined {
    const h = this.items;
    const top = h[0];
    const last = h.pop();
    if (h.length && last) {
      h[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Whether the cell is typed: it holds something, or carries a note */
const isTyped = (cell: Cell): boolean => hasContent(cell) || (!!cell.note && !cell.spill);
const isText = (cell: Cell): boolean => cell.f == null && cell.e == null && (typeof cell.v === "string" || (!hasContent(cell) && !!cell.note));

export function planSteps(wb: Workbook): StepPlan {
  const steps: Step[] = [];
  const sections: PlanSection[] = [];
  const sheets = wb.sheets;
  const index = sheets.map((s) => new RowIndex(s.cells));
  const done = sheets.map((s) => new Uint8Array(s.cells.length));
  const reached = sheets.map((s) => new Uint8Array(s.cells.length));
  const queued = sheets.map((s) => new Uint8Array(s.cells.length));
  /** Cells a formula still waits for */
  const pending = sheets.map((s) => new Int32Array(s.cells.length));
  /** The formulas that read a cell */
  const dependents = sheets.map(() => new Map<number, Node[]>());
  /** The tabs a formula names, which must exist before it is typed */
  const needs = sheets.map(() => new Map<number, number[]>());
  const waitingOnSheet = sheets.map(() => [] as Node[]);
  const created = new Uint8Array(sheets.length);
  const signatures = sheets.map(() => new Map<number, string>());
  const heap = new ReadyHeap(wb);

  const sheetByName = new Map<string, number>();
  sheets.forEach((s, i) => sheetByName.set(s.name.toLowerCase(), i));
  const nameByText = new Map<string, { sheet: number; rect: Rect }>();
  for (const n of wb.names ?? []) nameByText.set(n.name.toLowerCase(), n);

  // What every formula reads
  sheets.forEach((sheet, s) => {
    sheet.cells.forEach((cell, i) => {
      if (cell.f == null || cell.spill) return;
      const { refs, names } = precedents(cell.f);
      const targets: { sheet: number; rect: Rect }[] = [];
      for (const ref of refs) {
        const t = ref.sheet == null ? s : sheetByName.get(ref.sheet.toLowerCase());
        if (t != null) targets.push({ sheet: t, rect: ref.rect });
      }
      for (const name of names) { const n = nameByText.get(name.toLowerCase()); if (n) targets.push(n); }
      const edges = new Set<number>();
      const tabs = new Set<number>();
      for (const t of targets) {
        if (t.sheet !== s) tabs.add(t.sheet);
        const found: number[] = [];
        index[t.sheet].inRect(t.rect, (j) => { if (isTyped(sheets[t.sheet].cells[j]) && !(t.sheet === s && j === i)) found.push(j); });
        const follow = found.length > MAX_RANGE_EDGES ? [found[0], found[found.length - 1]] : found;
        for (const j of follow) edges.add(t.sheet * 262144 + j);
      }
      for (const key of edges) {
        const ts = Math.floor(key / 262144), tj = key % 262144;
        const list = dependents[ts].get(tj);
        if (list) list.push({ s, i }); else dependents[ts].set(tj, [{ s, i }]);
      }
      pending[s][i] = edges.size;
      if (tabs.size) needs[s].set(i, Array.from(tabs));
    });
  });

  const signature = (s: number, i: number): string => {
    let sig = signatures[s].get(i);
    if (sig == null) { const c = sheets[s].cells[i]; sig = formulaSignature(c.f ?? "", c.r, c.c); signatures[s].set(i, sig); }
    return sig;
  };
  const tabsReady = (s: number, i: number): boolean => (needs[s].get(i) ?? []).every((t) => created[t]);
  const isReady = (s: number, i: number): boolean => !done[s][i] && !!reached[s][i] && pending[s][i] <= 0 && tabsReady(s, i);
  const offer = (s: number, i: number) => {
    if (queued[s][i] || !isReady(s, i)) return;
    queued[s][i] = 1;
    heap.push({ s, i });
  };
  const markDone = (s: number, i: number) => {
    if (done[s][i]) return;
    done[s][i] = 1;
    for (const d of dependents[s].get(i) ?? []) { pending[d.s][d.i]--; offer(d.s, d.i); }
  };
  const emitCells = (k: "type" | "fill" | "paste", s: number, cells: number[]) => {
    if (!cells.length) return;
    steps.push({ k, s, cells });
    for (const i of cells) markDone(s, i);
  };

  /** Type every formula that is ready, filling the ones repeated below or beside it */
  const flush = () => {
    for (let n = heap.pop(); n; n = heap.pop()) {
      const { s, i } = n;
      if (done[s][i]) continue;
      const cell = sheets[s].cells[i];
      const sig = signature(s, i);
      const follow = (dr: number, dc: number): number[] => {
        const out: number[] = [];
        for (let k = 1; ; k++) {
          const j = index[s].at(cell.r + dr * k, cell.c + dc * k);
          if (j < 0 || sheets[s].cells[j].f == null || !isReady(s, j) || signature(s, j) !== sig) break;
          out.push(j);
        }
        return out;
      };
      const down = follow(1, 0);
      const fill = down.length ? down : follow(0, 1);
      emitCells("type", s, [i]);
      emitCells("fill", s, fill);
    }
  };

  /** Mark a sheet's unreached formulas reached and type what can be typed (cycles, at the very end) */
  const forceRemaining = () => {
    sheets.forEach((sheet, s) => {
      sheet.cells.forEach((cell, i) => {
        if (cell.f == null || cell.spill || done[s][i]) return;
        reached[s][i] = 1;
        offer(s, i);
      });
    });
    flush();
    // Formulas that read each other in a circle never become ready: typed as they come
    sheets.forEach((sheet, s) => {
      sheet.cells.forEach((cell, i) => { if (cell.f != null && !cell.spill && !done[s][i]) emitCells("type", s, [i]); });
    });
  };

  steps.push({ k: "theme" });
  /** Charts that draw from a later sheet, by the sheet they wait for */
  const chartsAfter = new Map<number, Step[]>();

  sheets.forEach((sheet, s) => {
    const cells = sheet.cells;
    const rows = index[s];
    steps.push({ k: "sheet", s });
    created[s] = 1;
    for (const w of waitingOnSheet[s]) offer(w.s, w.i);
    if (wb.defaultFont.size !== 10) steps.push({ k: "base", s, what: "size" });
    if (sheet.defaultRowPx !== 21) steps.push({ k: "base", s, what: "rows" });
    if (sheet.defaultColPx !== 100) steps.push({ k: "base", s, what: "cols" });
    (wb.names ?? []).forEach((n, i) => { if (n.sheet === s) steps.push({ k: "name", i }); });
    for (const [from, to, v] of sheet.colStyles ?? []) steps.push({ k: "band", s, d: "c", from, to, v });
    for (const [from, to, v] of sheet.rowStyles ?? []) steps.push({ k: "band", s, d: "r", from, to, v });

    // Sections: runs of rows with something typed in them
    const typedRows = new Set<number>();
    for (const cell of cells) if (isTyped(cell)) typedRows.add(cell.r);
    const bands = runs(Array.from(typedRows).sort((a, b) => a - b));

    // What most of the sheet shares in a part of its look is set once, up front
    const baseKey = new Map<Aspect, string>();
    const styled = cells.filter((c) => c.s && wb.styles[c.s]);
    for (const a of BASE_ASPECTS) {
      const counts = new Map<string, { n: number; v: number }>();
      const defined: Cell[] = [];
      for (const cell of styled) {
        const style = wb.styles[cell.s!];
        if (!hasAspect(style, a)) continue;
        defined.push(cell);
        const key = aspectKey(style, a);
        const e = counts.get(key);
        if (e) e.n++; else counts.set(key, { n: 1, v: cell.s! });
      }
      if (defined.length < BASE_MIN_CELLS || bands.length < 2) continue;
      let best: { key: string; n: number; v: number } | null = null;
      for (const [key, e] of counts) if (!best || e.n > best.n) best = { key, ...e };
      if (!best || best.n < defined.length * 0.5) continue;
      baseKey.set(a, best.key);
      steps.push({ k: "fmt", s, a, v: best.v, rects: coverRects(defined) });
    }

    let colsSized = false;
    bands.forEach(([r0, r1], b) => {
      const at = steps.length;
      // The cells typed in this section, and the runs of columns they sit in
      const typed: number[] = [];
      for (let r = r0; r <= r1; r++) rows.inRow(r, 0, Infinity, (i) => { if (isTyped(cells[i])) typed.push(i); });
      const blocks = runs(Array.from(new Set(typed.map((i) => cells[i].c))).sort((x, y) => x - y));
      let title = "";
      for (const [c0, c1] of blocks) {
        const mine = typed.filter((i) => cells[i].c >= c0 && cells[i].c <= c1);
        const texts = mine.filter((i) => isText(cells[i]));
        const values = mine.filter((i) => cells[i].f == null && !isText(cells[i]));
        const formulas = mine.filter((i) => cells[i].f != null);
        if (!title) {
          // (a heading or a label names the section better than a lone symbol)
          const words = texts.filter((i) => typeof cells[i].v === "string");
          const first = words.find((i) => String(cells[i].v).trim().length > 2) ?? words[0];
          if (first != null) title = String(cells[first].v).trim().slice(0, 60);
        }
        if (texts.length + values.length >= PASTE_MIN_CELLS) {
          // A table of data: pasted in, a few rows at a time
          const constants = mine.filter((i) => cells[i].f == null);
          for (let r = r0; r <= r1; r += PASTE_ROWS) emitCells("paste", s, constants.filter((i) => cells[i].r >= r && cells[i].r < r + PASTE_ROWS));
        } else {
          for (const i of texts) emitCells("type", s, [i]);
          for (const i of values) emitCells("type", s, [i]);
        }
        for (const i of formulas) {
          reached[s][i] = 1;
          const waits = (needs[s].get(i) ?? []).filter((t) => !created[t]);
          for (const t of waits) waitingOnSheet[t].push({ s, i });
          offer(s, i);
        }
        flush();
      }
      sections.push({ at, sheet: s, rows: [r0, r1], title });

      // Formatting: this section's rows, and the empty styled rows under it
      const from = b === 0 ? 0 : r0;
      const to = b === bands.length - 1 ? Infinity : bands[b + 1][0] - 1;
      const merges = sheet.merges.filter((m) => m[0] >= from && m[0] <= to);
      if (merges.length) steps.push({ k: "merge", s, rects: merges });
      for (const [a0, a1, px] of sheet.rowPx) {
        const lo = Math.max(a0, from), hi = Math.min(a1, to);
        if (lo <= hi) steps.push({ k: "size", s, d: "r", from: lo, to: hi, px });
      }
      if (!colsSized) {
        colsSized = true;
        for (const [c0, c1, px] of sheet.colPx) steps.push({ k: "size", s, d: "c", from: c0, to: c1, px });
      }
      const inBand: Cell[] = [];
      const rich: number[] = [];
      const last = Math.min(to, rows.maxRow);
      for (let r = from; r <= last; r++) rows.inRow(r, 0, Infinity, (i) => {
        const cell = cells[i];
        if (cell.s && wb.styles[cell.s]) inBand.push(cell);
        if (cell.runs?.length || cell.link) rich.push(i);
      });
      for (const a of ASPECTS) {
        const groups = new Map<string, { v: number; cells: Cell[] }>();
        for (const cell of inBand) {
          const style = wb.styles[cell.s!];
          if (!hasAspect(style, a)) continue;
          const key = aspectKey(style, a);
          if (baseKey.get(a) === key) continue;
          const g = groups.get(key);
          if (g) g.cells.push(cell); else groups.set(key, { v: cell.s!, cells: [cell] });
        }
        for (const g of groups.values()) steps.push({ k: "fmt", s, a, v: g.v, rects: coverRects(g.cells) });
      }
      for (const i of rich) steps.push({ k: "runs", s, cell: i });
    });

    // A sheet with looks but nothing typed still gets them
    if (!bands.length) {
      for (const [c0, c1, px] of sheet.colPx) steps.push({ k: "size", s, d: "c", from: c0, to: c1, px });
      for (const [a0, a1, px] of sheet.rowPx) steps.push({ k: "size", s, d: "r", from: a0, to: a1, px });
      if (sheet.merges.length) steps.push({ k: "merge", s, rects: sheet.merges });
      for (const a of ASPECTS) {
        const groups = new Map<string, { v: number; cells: Cell[] }>();
        for (const cell of styled) {
          const style = wb.styles[cell.s!];
          if (!hasAspect(style, a)) continue;
          const key = aspectKey(style, a);
          const g = groups.get(key);
          if (g) g.cells.push(cell); else groups.set(key, { v: cell.s!, cells: [cell] });
        }
        for (const g of groups.values()) steps.push({ k: "fmt", s, a, v: g.v, rects: coverRects(g.cells) });
      }
    }

    // Charts go in once the cells they draw from are there (on this sheet, or a later one)
    (sheet.charts ?? []).forEach((chart, i) => {
      const last = Math.max(s, ...chart.series.map((x) => x.src.sheet), chart.domain?.sheet ?? 0);
      if (last <= s) steps.push({ k: "chart", s, i });
      else (chartsAfter.get(last) ?? chartsAfter.set(last, []).get(last)!).push({ k: "chart", s, i });
    });
    for (const waiting of chartsAfter.get(s) ?? []) steps.push(waiting);

    // Finishing touches
    if (sheet.frozenRows || sheet.frozenCols) steps.push({ k: "prop", s, p: "freeze" });
    if (sheet.filter) steps.push({ k: "filter", s });
    if (sheet.groups?.length) steps.push({ k: "groups", s });
    if (sheet.hideGridlines) steps.push({ k: "prop", s, p: "gridlines" });
    if (sheet.tabColor) steps.push({ k: "prop", s, p: "tab" });
    (sheet.validations ?? []).forEach((_v, i) => steps.push({ k: "dv", s, i }));
    if (sheet.conditional?.length) steps.push({ k: "cf", s });
    for (const [from, to] of sheet.hiddenRows ?? []) steps.push({ k: "hide", s, d: "r", from, to });
    for (const [from, to] of sheet.hiddenCols ?? []) steps.push({ k: "hide", s, d: "c", from, to });
  });

  forceRemaining();
  // A hidden tab is hidden last: formulas were still being written into it
  sheets.forEach((sheet, s) => { if (sheet.hidden) steps.push({ k: "prop", s, p: "hidden" }); });
  return { steps, sections };
}
