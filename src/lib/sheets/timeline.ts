/**
 * A workbook as it stands after any number of a sync's steps: which cells are typed, which parts of
 * each cell's look are on yet, what is merged, how wide the columns are. The page draws a sheet
 * from this, for the finished look (every step done), for the preview that plays the build, and
 * for a running sync.
 */

import { type Color, type Banding, layout, type CellStyle, type Chart, type Rect, type Sheet, type Workbook } from "./model";
import { ASPECTS, hasAspect, type Aspect, type Step } from "./steps";

/** Google Sheets' own defaults, before a sync has changed them */
export const SHEETS_DEFAULT_FONT = { family: "Arial", size: 10 };
export const SHEETS_ROW_PX = 21;
export const SHEETS_COL_PX = 100;

interface SheetTimeline {
  /** The step that makes the tab */
  createdAt: number;
  /** Per cell: the step that types it (Infinity: never typed) */
  typedAt: Float64Array;
  /** Per cell: the step that gives its text its runs or link */
  runsAt: Float64Array;
  /** Per cell: [step, aspect index, style index] for every time a part of its look is set, in order */
  looks: (number[] | undefined)[];
  /** Per merge: the step that merges it */
  mergedAt: number[];
  /** Size changes, in order: [step, "r" | "c", from, to, pixels (0: hidden)] */
  sizes: [number, "r" | "c", number, number, number][];
  gridlinesAt: number;
  freezeAt: number;
  tabAt: number;
  hiddenAt: number;
  sizeAt: number;
  filterAt: number;
  groupsAt: number;
  conditionalAt: number;
  /** Per chart: the step that inserts it */
  chartAt: number[];
  bandingAt: number[];
  spanAt: number[];
  /** What each step touches here, to show where the sync is */
  focus: Map<number, Rect[]>;
}

export interface Timeline {
  steps: number;
  themeAt: number;
  sheets: SheetTimeline[];
  /** The sheet each step works in (-1: none) */
  sheetOf: Int32Array;
}

const ASPECT_INDEX = new Map<Aspect, number>(ASPECTS.map((a, i) => [a, i]));

export function buildTimeline(wb: Workbook, steps: readonly Step[]): Timeline {
  const sheets: SheetTimeline[] = wb.sheets.map((s) => ({
    createdAt: Infinity, typedAt: new Float64Array(s.cells.length).fill(Infinity), runsAt: new Float64Array(s.cells.length).fill(Infinity),
    looks: new Array(s.cells.length), mergedAt: s.merges.map(() => Infinity), sizes: [], gridlinesAt: Infinity, freezeAt: Infinity, tabAt: Infinity, hiddenAt: Infinity, sizeAt: Infinity, filterAt: Infinity, groupsAt: Infinity, conditionalAt: Infinity, chartAt: (s.charts ?? []).map(() => Infinity), bandingAt: (s.banding ?? []).map(() => Infinity), spanAt: (s.spans ?? []).map(() => Infinity), focus: new Map(),
  }));
  // Cells by row, to find the ones a formatted range covers
  const rowsOf = wb.sheets.map((s) => {
    const rows = new Map<number, [number, number]>();
    s.cells.forEach((c, i) => { const span = rows.get(c.r); if (span) span[1] = i + 1; else rows.set(c.r, [i, i + 1]); });
    return rows;
  });
  const mergeIndex = wb.sheets.map((s) => new Map(s.merges.map((m, i) => [m.join(), i])));
  const sheetOf = new Int32Array(steps.length).fill(-1);
  let themeAt = Infinity;

  const eachCell = (s: number, rect: Rect, fn: (i: number) => void) => {
    const sheet = wb.sheets[s];
    const rows = rowsOf[s];
    const visit = (r: number) => {
      const span = rows.get(r);
      if (!span) return;
      for (let i = span[0]; i < span[1]; i++) { const c = sheet.cells[i].c; if (c >= rect[1] && c <= rect[3]) fn(i); }
    };
    if (rect[2] - rect[0] > rows.size * 2) { for (const r of rows.keys()) if (r >= rect[0] && r <= rect[2]) visit(r); }
    else for (let r = rect[0]; r <= rect[2]; r++) visit(r);
  };

  steps.forEach((step, k) => {
    if (step.k === "theme") { themeAt = Math.min(themeAt, k); return; }
    if (step.k === "pause" || step.k === "name") return;
    const t = sheets[step.s];
    const sheet = wb.sheets[step.s];
    if (!t || !sheet) return;
    sheetOf[k] = step.s;
    switch (step.k) {
      case "sheet": t.createdAt = Math.min(t.createdAt, k); break;
      case "base":
        if (step.what === "size") t.sizeAt = Math.min(t.sizeAt, k);
        else t.sizes.push([k, step.what === "rows" ? "r" : "c", 0, (step.what === "rows" ? sheet.rowCount : sheet.colCount) - 1, step.what === "rows" ? sheet.defaultRowPx : sheet.defaultColPx]);
        break;
      case "type": case "fill": case "paste": {
        const rects: Rect[] = [];
        for (const i of step.cells) { t.typedAt[i] = Math.min(t.typedAt[i], k); const c = sheet.cells[i]; if (c) rects.push([c.r, c.c, c.r, c.c]); }
        t.focus.set(k, rects.length > 40 ? [[Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))]] : rects);
        break;
      }
      case "fmt": {
        const a = ASPECT_INDEX.get(step.a)!;
        for (const rect of step.rects) eachCell(step.s, rect, (i) => { (t.looks[i] ??= []).push(k, a, step.v); });
        t.focus.set(k, step.rects);
        break;
      }
      case "runs": { t.runsAt[step.cell] = Math.min(t.runsAt[step.cell], k); const c = sheet.cells[step.cell]; if (c) t.focus.set(k, [[c.r, c.c, c.r, c.c]]); break; }
      case "merge":
        for (const rect of step.rects) { const i = mergeIndex[step.s].get(rect.join()); if (i != null) t.mergedAt[i] = Math.min(t.mergedAt[i], k); }
        t.focus.set(k, step.rects);
        break;
      case "size": t.sizes.push([k, step.d, step.from, step.to, step.px]); break;
      case "hide": t.sizes.push([k, step.d, step.from, step.to, 0]); break;
      case "prop":
        if (step.p === "gridlines") t.gridlinesAt = Math.min(t.gridlinesAt, k);
        else if (step.p === "freeze") t.freezeAt = Math.min(t.freezeAt, k);
        else if (step.p === "tab") t.tabAt = Math.min(t.tabAt, k);
        else t.hiddenAt = Math.min(t.hiddenAt, k);
        break;
      case "filter": t.filterAt = Math.min(t.filterAt, k); break;
      case "groups": t.groupsAt = Math.min(t.groupsAt, k); break;
      case "cf": t.conditionalAt = Math.min(t.conditionalAt, k); break;
      case "chart": if (step.i < t.chartAt.length) t.chartAt[step.i] = Math.min(t.chartAt[step.i], k); break;
      case "banding": if (step.i < t.bandingAt.length) t.bandingAt[step.i] = Math.min(t.bandingAt[step.i], k); break;
      case "span": if (step.i < t.spanAt.length) t.spanAt[step.i] = Math.min(t.spanAt[step.i], k); break;
      default: break;
    }
  });
  return { steps: steps.length, themeAt, sheets, sheetOf };
}

/** A sheet as the page draws it */
export interface SheetView {
  sheet: Sheet;
  /** Whether the tab exists yet */
  exists: boolean;
  hidden: boolean;
  tabColor?: string;
  hideGridlines: boolean;
  frozenRows: number;
  frozenCols: number;
  rows: { sizes: number[]; offsets: number[] };
  cols: { sizes: number[]; offsets: number[] };
  /** The font unstyled cells are drawn in */
  defaultFont: { family: string; size: number };
  merges: Rect[];
  /** Whether cell `i` shows its value */
  typed(i: number): boolean;
  /** Whether cell `i`'s text shows its runs and link */
  rich(i: number): boolean;
  /** Cell `i`'s look so far (undefined: plain) */
  styleOf(i: number): CellStyle | undefined;
  /** What the last step touched on this sheet */
  focus: Rect[];
  /** The charts on the sheet so far, the filter range once it is on, and whether conditional formatting is */
  charts: Chart[];
  filter?: Rect;
  conditional: boolean;
  /** The ranges with alternating colours so far */
  banding: Banding[];
  /** Blank ranges with a fill so far: what an empty coloured area shows */
  fills: { rects: Rect[]; fill: Color }[];
}

/**
 * Columns as Google Sheets draws them: a column's width is the room inside it, and its gridline is
 * one more pixel (a 100 pixel column takes 101 on screen). A row's height includes its gridline.
 */
function onScreen(sizes: number[]): { sizes: number[]; offsets: number[] } {
  const out = sizes.map((px) => (px > 0 ? px + 1 : 0));
  const offsets = new Array<number>(out.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < out.length; i++) offsets[i + 1] = offsets[i] + out[i];
  return { sizes: out, offsets };
}

/** Rows or columns with the folded groups' members taken out of sight */
function fold(sizes: number[], sheet: Sheet, d: "r" | "c"): number[] {
  const groups = (sheet.groups ?? []).filter((g) => g.d === d && g.collapsed);
  if (!groups.length) return sizes;
  const out = sizes.slice();
  for (const g of groups) for (let i = g.from; i <= g.to && i < out.length; i++) out[i] = 0;
  return out;
}

function offsetsOf(sizes: number[]): number[] {
  const o = new Array<number>(sizes.length + 1);
  o[0] = 0;
  for (let i = 0; i < sizes.length; i++) o[i + 1] = o[i] + sizes[i];
  return o;
}

/** The picked value of one part of a look, copied from the style that has it */
function takeAspect(into: CellStyle, from: CellStyle, a: Aspect): void {
  if (!hasAspect(from, a)) return;
  switch (a) {
    case "family": (into.font ??= {}).family = from.font!.family; break;
    case "size": (into.font ??= {}).size = from.font!.size; break;
    case "bold": (into.font ??= {}).bold = true; break;
    case "italic": (into.font ??= {}).italic = true; break;
    case "underline": (into.font ??= {}).underline = true; break;
    case "strike": (into.font ??= {}).strike = true; break;
    case "color": (into.font ??= {}).color = from.font!.color; break;
    case "fill": into.fill = from.fill; break;
    case "numFmt": into.numFmt = from.numFmt; break;
    case "hAlign": into.hAlign = from.hAlign; break;
    case "vAlign": into.vAlign = from.vAlign; break;
    case "wrap": into.wrap = from.wrap; break;
    case "rotation": into.rotation = from.rotation; break;
    case "indent": into.indent = from.indent; break;
    case "borders": into.borders = from.borders; break;
  }
}

/** The sheet's blank ranges that have a fill, among those `on` says are there */
function spanFills(wb: Workbook, sheet: Sheet, on: (i: number) => boolean): { rects: Rect[]; fill: Color }[] {
  const out: { rects: Rect[]; fill: Color }[] = [];
  (sheet.spans ?? []).forEach((span, i) => { const fill = wb.styles[span.v]?.fill; if (fill && on(i)) out.push({ rects: span.rects, fill }); });
  return out;
}

/** The finished sheet: every step done (what the workbook says, as it is) */
export function finalView(wb: Workbook, s: number): SheetView {
  const sheet = wb.sheets[s];
  return {
    sheet, exists: true, hidden: !!sheet.hidden, tabColor: sheet.tabColor, hideGridlines: !!sheet.hideGridlines,
    frozenRows: sheet.frozenRows ?? 0, frozenCols: sheet.frozenCols ?? 0,
    rows: (() => { const sizes = fold(layout(sheet.rowPx, sheet.rowCount, sheet.defaultRowPx, sheet.hiddenRows).sizes, sheet, "r"); return { sizes, offsets: offsetsOf(sizes) }; })(),
    cols: onScreen(fold(layout(sheet.colPx, sheet.colCount, sheet.defaultColPx, sheet.hiddenCols).sizes, sheet, "c")),
    defaultFont: wb.defaultFont, merges: sheet.merges,
    typed: () => true, rich: () => true,
    styleOf: (i) => { const c = sheet.cells[i]; return c?.s ? wb.styles[c.s] : undefined; },
    focus: [], charts: sheet.charts ?? [], filter: sheet.filter, conditional: !!sheet.conditional?.length, banding: sheet.banding ?? [], fills: spanFills(wb, sheet, () => true),
  };
}

/** Sheet `s` once the first `done` steps have run */
export function viewAt(wb: Workbook, timeline: Timeline, done: number, s: number): SheetView {
  if (done >= timeline.steps) return finalView(wb, s);
  const sheet = wb.sheets[s];
  const t = timeline.sheets[s];
  const rowSizes = new Array<number>(sheet.rowCount).fill(SHEETS_ROW_PX);
  const colSizes = new Array<number>(sheet.colCount).fill(SHEETS_COL_PX);
  for (const [k, d, from, to, px] of t.sizes) {
    if (k >= done) continue;
    const sizes = d === "r" ? rowSizes : colSizes;
    for (let i = Math.max(0, from); i <= to && i < sizes.length; i++) sizes[i] = px;
  }
  const cache = new Map<string, CellStyle | undefined>();
  const last = done - 1;
  return {
    sheet, exists: t.createdAt < done, hidden: t.hiddenAt < done, tabColor: t.tabAt < done ? sheet.tabColor : undefined, hideGridlines: t.gridlinesAt < done,
    frozenRows: t.freezeAt < done ? sheet.frozenRows ?? 0 : 0, frozenCols: t.freezeAt < done ? sheet.frozenCols ?? 0 : 0,
    rows: (() => { const sizes = t.groupsAt < done ? fold(rowSizes, sheet, "r") : rowSizes; return { sizes, offsets: offsetsOf(sizes) }; })(),
    cols: onScreen(t.groupsAt < done ? fold(colSizes, sheet, "c") : colSizes),
    defaultFont: { family: timeline.themeAt < done ? wb.defaultFont.family : SHEETS_DEFAULT_FONT.family, size: t.sizeAt < done ? wb.defaultFont.size : SHEETS_DEFAULT_FONT.size },
    merges: sheet.merges.filter((_m, i) => t.mergedAt[i] < done),
    typed: (i) => t.typedAt[i] < done,
    rich: (i) => t.runsAt[i] < done,
    styleOf: (i) => {
      const looks = t.looks[i];
      if (!looks) return undefined;
      // The last value each part of the look was given before now
      const picks = new Array<number>(ASPECTS.length).fill(0);
      let any = false;
      for (let j = 0; j < looks.length; j += 3) { if (looks[j] >= done) break; picks[looks[j + 1]] = looks[j + 2]; any = true; }
      if (!any) return undefined;
      const key = picks.join();
      if (cache.has(key)) return cache.get(key);
      const style: CellStyle = {};
      picks.forEach((v, a) => { if (v) takeAspect(style, wb.styles[v], ASPECTS[a]); });
      cache.set(key, style);
      return style;
    },
    focus: last >= 0 && timeline.sheetOf[last] === s ? t.focus.get(last) ?? [] : [],
    charts: (sheet.charts ?? []).filter((_c, i) => t.chartAt[i] < done), filter: t.filterAt < done ? sheet.filter : undefined, conditional: t.conditionalAt < done, banding: (sheet.banding ?? []).filter((_b, i) => t.bandingAt[i] < done), fills: spanFills(wb, sheet, (i) => t.spanAt[i] < done),
  };
}

/** The sheet the sync is working in after `done` steps: the last one it touched */
export function activeSheet(timeline: Timeline, done: number): number {
  for (let k = Math.min(done, timeline.steps) - 1; k >= 0; k--) if (timeline.sheetOf[k] >= 0) return timeline.sheetOf[k];
  return 0;
}

