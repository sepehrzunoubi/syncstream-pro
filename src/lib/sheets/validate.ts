/**
 * A workbook as it arrives at the server when a sync starts. The page reads the file, so what is
 * sent is whatever a browser sent: every value is checked and copied into a fresh Workbook, and
 * anything that isn't exactly what the model allows refuses the whole thing.
 */

import { type Banding, type BandColors, BORDER_STYLES, CHART_TYPES, THEME_SLOTS, type Border, type Cell, type CellStyle, type Chart, type ChartSource, type Color, type ConditionalRule, type DimensionGroup, type FontStyle, type NamedRange, type Rect, type Sheet, type SizeRun, type TextRun, type ThemeSlot, type Validation, type Workbook } from "./model";

export const MAX_WORKBOOK_CELLS = 150_000;
const MAX_SHEETS = 60;
const MAX_STYLES = 20_000;
const MAX_ROWS = 200_000;
const MAX_COLS = 18_278;
/** Google Sheets holds at most ten million cells in a spreadsheet */
const MAX_GRID_CELLS = 10_000_000;
const MAX_TEXT = 50_000;

class Invalid extends Error {}
const bad = (what: string): never => { throw new Invalid(what); };

type Obj = Record<string, unknown>;
const obj = (v: unknown, what: string): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : bad(what));
const arr = (v: unknown, what: string, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : bad(what));
const int = (v: unknown, min: number, max: number, what: string): number => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : bad(what));
const num = (v: unknown, min: number, max: number, what: string): number => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : bad(what));
const str = (v: unknown, max: number, what: string): string => (typeof v === "string" && v.length <= max ? v : bad(what));

const COLOR = /^#[0-9a-f]{6}$/;
function color(v: unknown, what: string): Color {
  const s = str(v, 20, what);
  if (COLOR.test(s)) return s;
  if (s.startsWith("theme:") && (THEME_SLOTS as readonly string[]).includes(s.slice(6))) return s;
  return bad(what);
}

function font(v: unknown, what: string): FontStyle {
  const o = obj(v, what);
  const out: FontStyle = {};
  if (o.family != null) { const f = str(o.family, 100, what).replace(/[\u0000-\u001f]/g, "").trim(); if (f) out.family = f; }
  if (o.size != null) out.size = num(o.size, 1, 400, what);
  if (o.bold === true) out.bold = true;
  if (o.italic === true) out.italic = true;
  if (o.underline === true) out.underline = true;
  if (o.strike === true) out.strike = true;
  if (o.color != null) out.color = color(o.color, what);
  return out;
}

function border(v: unknown, what: string): Border {
  const o = obj(v, what);
  const style = str(o.style, 20, what);
  if (!(BORDER_STYLES as readonly string[]).includes(style)) bad(what);
  return { style: style as Border["style"], color: color(o.color, what) };
}

const oneOf = <T extends string>(v: unknown, options: readonly T[], what: string): T => (options.includes(v as T) ? (v as T) : bad(what));

function style(v: unknown): CellStyle {
  const o = obj(v, "style");
  const out: CellStyle = {};
  if (o.font != null) { const f = font(o.font, "font"); if (Object.keys(f).length) out.font = f; }
  if (o.fill != null) out.fill = color(o.fill, "fill");
  if (o.borders != null) {
    const b = obj(o.borders, "borders");
    const sides: NonNullable<CellStyle["borders"]> = {};
    for (const side of ["top", "bottom", "left", "right"] as const) if (b[side] != null) sides[side] = border(b[side], "border");
    if (Object.keys(sides).length) out.borders = sides;
  }
  if (o.numFmt != null) { const f = str(o.numFmt, 500, "number format"); if (f) out.numFmt = f; }
  if (o.hAlign != null) out.hAlign = oneOf(o.hAlign, ["LEFT", "CENTER", "RIGHT"] as const, "alignment");
  if (o.vAlign != null) out.vAlign = oneOf(o.vAlign, ["TOP", "MIDDLE", "BOTTOM"] as const, "alignment");
  if (o.wrap != null) out.wrap = oneOf(o.wrap, ["WRAP", "CLIP"] as const, "wrapping");
  if (o.rotation != null) out.rotation = o.rotation === "vertical" ? "vertical" : int(o.rotation, -90, 90, "rotation");
  if (o.indent != null) { const n = int(o.indent, 0, 15, "indent"); if (n) out.indent = n; }
  return out;
}

function rect(v: unknown, rows: number, cols: number, what: string): Rect {
  const a = arr(v, what, 4);
  if (a.length !== 4) bad(what);
  const r0 = int(a[0], 0, rows - 1, what), c0 = int(a[1], 0, cols - 1, what), r1 = int(a[2], r0, rows - 1, what), c1 = int(a[3], c0, cols - 1, what);
  return [r0, c0, r1, c1];
}

function sizeRuns(v: unknown, count: number, what: string): SizeRun[] {
  return arr(v ?? [], what, 100_000).map((run) => {
    const a = arr(run, what, 3);
    const from = int(a[0], 0, count - 1, what);
    return [from, int(a[1], from, count - 1, what), int(a[2], 2, 2000, what)] as SizeRun;
  });
}

function spans(v: unknown, count: number, what: string): [number, number][] | undefined {
  if (v == null) return undefined;
  const out = arr(v, what, 100_000).map((s) => { const a = arr(s, what, 2); const from = int(a[0], 0, count - 1, what); return [from, int(a[1], from, count - 1, what)] as [number, number]; });
  return out.length ? out : undefined;
}

function styleSpans(v: unknown, count: number, styles: number, what: string): [number, number, number][] | undefined {
  if (v == null) return undefined;
  const out = arr(v, what, 20_000).map((s) => { const a = arr(s, what, 3); const from = int(a[0], 0, count - 1, what); return [from, int(a[1], from, count - 1, what), int(a[2], 1, styles - 1, what)] as [number, number, number]; });
  return out.length ? out : undefined;
}

const ERRORS = /^#(N\/A|DIV\/0!|REF!|VALUE!|NAME\?|NUM!|NULL!)$/;
const CONDITIONS = ["NUMBER_GREATER", "NUMBER_GREATER_THAN_EQ", "NUMBER_LESS", "NUMBER_LESS_THAN_EQ", "NUMBER_EQ", "NUMBER_NOT_EQ", "NUMBER_BETWEEN", "NUMBER_NOT_BETWEEN", "TEXT_EQ", "TEXT_CONTAINS", "TEXT_NOT_CONTAINS", "TEXT_STARTS_WITH", "TEXT_ENDS_WITH", "BLANK", "NOT_BLANK", "CUSTOM_FORMULA"] as const;

type PendingCharts = { sheet: Sheet; raw: unknown[] }[];

function chartSource(v: unknown, sheets: readonly Sheet[]): ChartSource {
  const o = obj(v, "chart range");
  const index = int(o.sheet, 0, sheets.length - 1, "chart range");
  return { sheet: index, rect: rect(o.rect, sheets[index].rowCount, sheets[index].colCount, "chart range") };
}

function chart(v: unknown, on: Sheet, sheets: readonly Sheet[]): Chart {
  const o = obj(v, "chart");
  const at = arr(o.at, "chart", 4);
  const size = arr(o.size, "chart", 2);
  const out: Chart = {
    at: [int(at[0], 0, on.rowCount - 1, "chart"), int(at[1], 0, on.colCount - 1, "chart"), int(at[2], 0, 5000, "chart"), int(at[3], 0, 5000, "chart")],
    size: [int(size[0], 20, 4000, "chart"), int(size[1], 20, 4000, "chart")],
    type: oneOf(o.type, CHART_TYPES, "chart"),
    series: arr(o.series, "chart", 100).map((s) => {
      const so = obj(s, "chart series");
      return { src: chartSource(so.src, sheets), ...(so.type != null ? { type: oneOf(so.type, ["COLUMN", "LINE", "AREA"] as const, "chart series") } : {}), ...(so.color != null ? { color: color(so.color, "chart series") } : {}) };
    }),
  };
  if (!out.series.length) bad("chart");
  if (o.stacked != null) out.stacked = oneOf(o.stacked, ["STACKED", "PERCENT_STACKED"] as const, "chart");
  if (o.title != null) out.title = str(o.title, 300, "chart");
  if (o.legend != null) out.legend = oneOf(o.legend, ["RIGHT", "LEFT", "TOP", "BOTTOM", "NONE"] as const, "chart");
  if (o.xTitle != null) out.xTitle = str(o.xTitle, 300, "chart");
  if (o.yTitle != null) out.yTitle = str(o.yTitle, 300, "chart");
  if (o.domain != null) out.domain = chartSource(o.domain, sheets);
  if (o.headers === 1) out.headers = 1;
  if (o.hole != null) out.hole = num(o.hole, 0, 0.9, "chart");
  return out;
}

function sheet(v: unknown, styles: number, budget: { cells: number; grid: number }, ids: Set<number>, names: Set<string>, first: boolean, pendingCharts: PendingCharts): Sheet {
  const o = obj(v, "sheet");
  const id = first ? int(o.id, 0, 0, "sheet id") : int(o.id, 1, 2_000_000_000, "sheet id");
  if (ids.has(id)) bad("sheet id");
  ids.add(id);
  // (Sheets refuses these in a tab's name)
  const name = str(o.name, 100, "sheet name").replace(/[\u0000-\u001f]/g, " ");
  if (!name.trim() || names.has(name.toLowerCase())) bad("sheet name");
  names.add(name.toLowerCase());
  const rowCount = int(o.rowCount, 1, MAX_ROWS, "rows");
  const colCount = int(o.colCount, 1, MAX_COLS, "columns");
  budget.grid -= rowCount * colCount;
  if (budget.grid < 0) bad("grid size");
  const out: Sheet = {
    id, name, rowCount, colCount,
    defaultRowPx: int(o.defaultRowPx, 2, 2000, "row height"), defaultColPx: int(o.defaultColPx, 2, 2000, "column width"),
    rowPx: sizeRuns(o.rowPx, rowCount, "row heights"), colPx: sizeRuns(o.colPx, colCount, "column widths"),
    merges: arr(o.merges ?? [], "merges", 50_000).map((m) => rect(m, rowCount, colCount, "merge")),
    cells: [],
  };
  if (o.hidden === true) out.hidden = true;
  if (o.hideGridlines === true) out.hideGridlines = true;
  if (o.rtl === true) out.rtl = true;
  if (o.tabColor != null) out.tabColor = color(o.tabColor, "tab colour");
  if (o.frozenRows != null) { const n = int(o.frozenRows, 0, rowCount - 1, "frozen rows"); if (n) out.frozenRows = n; }
  if (o.frozenCols != null) { const n = int(o.frozenCols, 0, colCount - 1, "frozen columns"); if (n) out.frozenCols = n; }
  const hr = spans(o.hiddenRows, rowCount, "hidden rows"); if (hr) out.hiddenRows = hr;
  const hc = spans(o.hiddenCols, colCount, "hidden columns"); if (hc) out.hiddenCols = hc;
  const cs = styleSpans(o.colStyles, colCount, styles, "column styles"); if (cs) out.colStyles = cs;
  const rs = styleSpans(o.rowStyles, rowCount, styles, "row styles"); if (rs) out.rowStyles = rs;
  if (o.spans != null) {
    let rects = 0;
    const list = arr(o.spans, "spans", 20_000).map((sp) => {
      const so = obj(sp, "span");
      const rs2 = arr(so.rects, "span", 200_000).map((r) => rect(r, rowCount, colCount, "span"));
      rects += rs2.length;
      if (!rs2.length || rects > 400_000) bad("span");
      return { v: int(so.v, 1, styles - 1, "span"), rects: rs2 };
    });
    if (list.length) out.spans = list;
  }

  const raw = arr(o.cells, "cells", MAX_WORKBOOK_CELLS);
  budget.cells -= raw.length;
  if (budget.cells < 0) bad("too many cells");
  let last = -1;
  for (const item of raw) {
    const c = obj(item, "cell");
    const cell: Cell = { r: int(c.r, 0, rowCount - 1, "cell row"), c: int(c.c, 0, colCount - 1, "cell column") };
    // Row by row, each position once: the steps name cells by their place in this list
    const key = cell.r * 16384 + cell.c;
    if (key <= last) bad("cell order");
    last = key;
    if (c.s != null) { const s = int(c.s, 0, styles - 1, "cell style"); if (s) cell.s = s; }
    if (c.v != null) {
      if (typeof c.v === "string") cell.v = str(c.v, MAX_TEXT, "cell text");
      else if (typeof c.v === "boolean") cell.v = c.v;
      else cell.v = num(c.v, -Number.MAX_VALUE, Number.MAX_VALUE, "cell number");
    }
    if (c.f != null) { const f = str(c.f, MAX_TEXT, "formula"); if (!f || f.startsWith("=")) bad("formula"); cell.f = f; }
    if (c.e != null) { const e = str(c.e, 20, "error"); if (!ERRORS.test(e)) bad("error"); cell.e = e; }
    if (c.runs != null) {
      const text = typeof cell.v === "string" ? cell.v : bad("text runs");
      let at = -1;
      const runs: TextRun[] = arr(c.runs, "text runs", 2000).map((r) => { const ro = obj(r, "text run"); const a = int(ro.at, at + 1, Math.max(0, text.length - 1), "text run"); at = a; return { at: a, font: font(ro.font, "text run") }; });
      if (runs.length) cell.runs = runs;
    }
    if (c.link != null) { const l = str(c.link, 2000, "link"); if (!/^(https?:\/\/|mailto:|#)/i.test(l)) bad("link"); cell.link = l; }
    if (c.note != null) { const n = str(c.note, 4000, "note"); if (n) cell.note = n; }
    if (c.spill != null) { const a = arr(c.spill, "spill", 2); cell.spill = [int(a[0], 0, rowCount - 1, "spill"), int(a[1], 0, colCount - 1, "spill")]; }
    out.cells.push(cell);
  }

  if (o.validations != null) {
    const list: Validation[] = arr(o.validations, "validation", 5000).map((d) => {
      const dv = obj(d, "validation");
      const extras = { ...(dv.strict === true ? { strict: true } : {}), ...(dv.help != null ? { help: str(dv.help, 500, "validation") } : {}) };
      const r = rect(dv.rect, rowCount, colCount, "validation");
      if (dv.values != null) return { rect: r, values: arr(dv.values, "validation", 500).map((x) => str(x, 500, "validation")), ...extras };
      if (dv.rule != null) {
        const rule = obj(dv.rule, "validation");
        return { rect: r, rule: { type: oneOf(rule.type, CONDITIONS, "validation"), values: arr(rule.values, "validation", 3).map((x) => str(x, 2000, "validation")) }, ...extras };
      }
      const source = str(dv.source, 1000, "validation");
      if (!source.startsWith("=")) bad("validation");
      return { rect: r, source, ...extras };
    });
    if (list.length) out.validations = list;
  }
  if (o.filter != null) out.filter = rect(o.filter, rowCount, colCount, "filter");
  if (o.banding != null) {
    const colors = (v: unknown): BandColors => {
      const p = obj(v, "banding");
      return { ...(p.header != null ? { header: color(p.header, "banding") } : {}), first: color(p.first, "banding"), second: color(p.second, "banding"), ...(p.footer != null ? { footer: color(p.footer, "banding") } : {}) };
    };
    const list: Banding[] = arr(o.banding, "banding", 200).map((b) => {
      const bo = obj(b, "banding");
      const band: Banding = { rect: rect(bo.rect, rowCount, colCount, "banding") };
      if (bo.rows != null) band.rows = colors(bo.rows);
      if (bo.cols != null) band.cols = colors(bo.cols);
      if (!band.rows && !band.cols) bad("banding");
      return band;
    });
    if (list.length) out.banding = list;
  }
  if (o.groups != null) {
    const list: DimensionGroup[] = arr(o.groups, "groups", 2000).map((g) => {
      const go = obj(g, "group");
      const d = oneOf(go.d, ["r", "c"] as const, "group");
      const count = d === "r" ? rowCount : colCount;
      const from = int(go.from, 0, count - 1, "group");
      return { d, from, to: int(go.to, from, count - 1, "group"), depth: int(go.depth, 1, 8, "group"), ...(go.collapsed === true ? { collapsed: true as const } : {}) };
    });
    if (list.length) out.groups = list;
  }
  // (a chart's ranges name sheets by their place in the workbook: checked once all are read)
  if (o.charts != null) pendingCharts.push({ sheet: out, raw: arr(o.charts, "charts", 50) });
  if (o.conditional != null) {
    const list: ConditionalRule[] = arr(o.conditional, "conditional formatting", 500).map((x) => {
      const rule = obj(x, "conditional formatting");
      const ranges = arr(rule.ranges, "conditional formatting", 500).map((r) => rect(r, rowCount, colCount, "conditional formatting"));
      if (!ranges.length) bad("conditional formatting");
      if (rule.scale != null) {
        const scale = arr(rule.scale, "colour scale", 3).map((p) => {
          const po = obj(p, "colour scale");
          return { type: oneOf(po.type, ["MIN", "MAX", "NUMBER", "PERCENT", "PERCENTILE"] as const, "colour scale"), ...(po.value != null ? { value: str(po.value, 200, "colour scale") } : {}), color: color(po.color, "colour scale") };
        });
        if (scale.length < 2) bad("colour scale");
        return { ranges, scale };
      }
      const w = obj(rule.when, "conditional formatting");
      const f = obj(rule.format, "conditional formatting");
      const format: NonNullable<ConditionalRule["format"]> = {};
      if (f.fill != null) format.fill = color(f.fill, "conditional formatting");
      if (f.color != null) format.color = color(f.color, "conditional formatting");
      for (const k of ["bold", "italic", "underline", "strike"] as const) if (f[k] === true) format[k] = true;
      return { ranges, when: { type: oneOf(w.type, CONDITIONS, "conditional formatting"), values: arr(w.values, "conditional formatting", 3).map((x2) => str(x2, 1000, "conditional formatting")) }, format };
    });
    if (list.length) out.conditional = list;
  }
  return out;
}

export function parseWorkbook(raw: unknown): { ok: true; workbook: Workbook } | { ok: false; error: string } {
  try {
    const o = obj(raw, "workbook");
    const styles = arr(o.styles, "styles", MAX_STYLES).map(style);
    if (!styles.length) styles.push({});
    styles[0] = {};
    const df = obj(o.defaultFont, "default font");
    const defaultFont = { family: str(df.family, 100, "default font").replace(/[\u0000-\u001f]/g, "").trim() || "Arial", size: num(df.size, 1, 400, "default font") };
    const budget = { cells: MAX_WORKBOOK_CELLS, grid: MAX_GRID_CELLS };
    const ids = new Set<number>();
    const names = new Set<string>();
    const rawSheets = arr(o.sheets, "sheets", MAX_SHEETS);
    if (!rawSheets.length) bad("sheets");
    const pendingCharts: PendingCharts = [];
    const sheets = rawSheets.map((s, i) => sheet(s, styles.length, budget, ids, names, i === 0, pendingCharts));
    for (const p of pendingCharts) { const list = p.raw.map((c) => chart(c, p.sheet, sheets)); if (list.length) p.sheet.charts = list; }
    const workbook: Workbook = {
      name: str(o.name, 300, "name").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) || "Untitled spreadsheet",
      origin: oneOf(o.origin, ["google", "excel", "other"] as const, "origin"),
      defaultFont, styles, sheets, warnings: [],
    };
    if (o.theme != null) {
      const t = obj(o.theme, "theme");
      const theme: Partial<Record<ThemeSlot, string>> = {};
      for (const slot of THEME_SLOTS) if (t[slot] != null) { const c = str(t[slot], 7, "theme"); if (!COLOR.test(c)) bad("theme"); theme[slot] = c; }
      if (Object.keys(theme).length) workbook.theme = theme;
    }
    if (o.names != null) {
      const seen = new Set<string>();
      const list: NamedRange[] = arr(o.names, "named ranges", 2000).map((n) => {
        const no = obj(n, "named range");
        const name = str(no.name, 250, "named range");
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) || seen.has(name.toLowerCase())) bad("named range");
        seen.add(name.toLowerCase());
        const si = int(no.sheet, 0, sheets.length - 1, "named range");
        return { name, sheet: si, rect: rect(no.rect, sheets[si].rowCount, sheets[si].colCount, "named range") };
      });
      if (list.length) workbook.names = list;
    }
    return { ok: true, workbook };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: `This workbook couldn't be read (${err.message}). Upload the file again.` };
    throw err;
  }
}
