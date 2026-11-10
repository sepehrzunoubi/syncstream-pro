/**
 * The steps of a spreadsheet sync and the Google Sheets requests each one sends. A step is one
 * thing a person does in a sheet: type a cell, fill a formula down, select a range and make it
 * bold, drag a column wider, merge cells. The order of the steps is order.ts's; this file knows
 * only what each one writes.
 *
 * Every step can be sent twice without changing the result (the runner may retry one whose reply
 * was lost), except the ones `needsCheck` names, which the runner looks up first.
 */

import { cellName, rectName, type Border, type Cell, type CellStyle, type Chart, type ChartSource, type Color, type FontStyle, type Rect, type Sheet, type Workbook } from "./model";

/** One part of a cell's look, applied on its own as a person would (select, then one button) */
export const ASPECTS = ["family", "size", "bold", "italic", "underline", "strike", "color", "fill", "numFmt", "hAlign", "vAlign", "wrap", "rotation", "indent", "borders"] as const;
export type Aspect = (typeof ASPECTS)[number];

export type Step =
  /** The spreadsheet's theme: its default font and theme colours */
  | { k: "theme" }
  /** Iterative calculation turned on, as the workbook has it */
  | { k: "calc" }
  /** Make the tab (the first one is renamed) and size its grid */
  | { k: "sheet"; s: number; mode?: "add" | "update" }
  /** A sheet-wide default: every cell's font size, every row's height, every column's width */
  | { k: "base"; s: number; what: "size" | "rows" | "cols" }
  /** Whole columns or rows given a style */
  | { k: "band"; s: number; d: "c" | "r"; from: number; to: number; v: number }
  /** One part of the look taken off cells that have it and shouldn't (Compare & Sync) */
  | { k: "clear"; s: number; a: Aspect; rects: Rect[] }
  /** A look given to ranges of blank cells (the sheet's i-th span) */
  | { k: "span"; s: number; i: number }
  /** Type these cells (one, as a rule), each index into the sheet's cells */
  | { k: "type"; s: number; cells: number[] }
  /** Fill a formula from the cell before into these, or paste a block of values */
  | { k: "fill" | "paste"; s: number; cells: number[] }
  /** One part of the look of style `v`, applied to these ranges */
  | { k: "fmt"; s: number; a: Aspect; v: number; rects: Rect[] }
  /** Part of a cell's text given its own look, or the cell's link */
  | { k: "runs"; s: number; cell: number }
  | { k: "merge"; s: number; rects: Rect[] }
  /** Rows ("r") or columns ("c") resized, or hidden */
  | { k: "size"; s: number; d: "c" | "r"; from: number; to: number; px: number }
  | { k: "hide"; s: number; d: "c" | "r"; from: number; to: number }
  | { k: "prop"; s: number; p: "gridlines" | "freeze" | "tab" | "hidden" }
  | { k: "name"; i: number }
  | { k: "dv"; s: number; i: number }
  /** Filter buttons on the sheet's filter range */
  | { k: "filter"; s: number }
  /** Alternating colours on one of the sheet's banded ranges */
  | { k: "banding"; s: number; i: number }
  /** The sheet's row and column groups, all of them */
  | { k: "groups"; s: number }
  /** Insert the sheet's chart number `i` */
  | { k: "chart"; s: number; i: number }
  /** The sheet's conditional formatting, all of it */
  | { k: "cf"; s: number }
  /** Time away from the sheet */
  | { k: "pause" };

export type SheetsRequest = Record<string, unknown>;

// ── Values of the Sheets API ───────────────────────────────────────────────

export function colorStyle(color: Color): Record<string, unknown> {
  if (color.startsWith("theme:")) return { themeColor: color.slice(6) };
  const n = parseInt(color.slice(1), 16);
  // Exact fractions: Sheets keeps a colour as it is given, and a rounded one can land a shade off
  return { rgbColor: { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 } };
}

function borderValue(b: Border): Record<string, unknown> {
  return { style: b.style, colorStyle: colorStyle(b.color) };
}

/** Whether a number format shows dates, times, percentages: the Sheets API wants the kind named */
export function numberFormatType(pattern: string): "TEXT" | "NUMBER" | "PERCENT" | "SCIENTIFIC" | "DATE" | "TIME" | "DATE_TIME" {
  if (pattern.trim() === "@") return "TEXT";
  // Letters inside quotes, after a backslash or in brackets ([Red], [$-409]) are not codes
  const bare = pattern.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, "").replace(/[_*]./g, "");
  const date = /[yd]/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare));
  const time = /[hs]/i.test(bare) || /AM\/PM|A\/P/i.test(bare);
  if (date && time) return "DATE_TIME";
  if (date) return "DATE";
  if (time) return "TIME";
  if (bare.includes("%")) return "PERCENT";
  if (/E[+-]/i.test(bare)) return "SCIENTIFIC";
  return "NUMBER";
}

export function numberFormat(pattern: string): Record<string, unknown> {
  const type = numberFormatType(pattern);
  return type === "TEXT" ? { type } : { type, pattern };
}

export function textFormat(font: FontStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (font.family) out.fontFamily = font.family;
  if (font.size) out.fontSize = font.size;
  if (font.bold) out.bold = true;
  if (font.italic) out.italic = true;
  if (font.underline) out.underline = true;
  if (font.strike) out.strikethrough = true;
  if (font.color) out.foregroundColorStyle = colorStyle(font.color);
  return out;
}

/** Whether a style says anything about this part of the look */
export function hasAspect(style: CellStyle, a: Aspect): boolean {
  switch (a) {
    case "family": return style.font?.family != null;
    case "size": return style.font?.size != null;
    case "bold": return !!style.font?.bold;
    case "italic": return !!style.font?.italic;
    case "underline": return !!style.font?.underline;
    case "strike": return !!style.font?.strike;
    case "color": return style.font?.color != null;
    case "fill": return style.fill != null;
    case "numFmt": return style.numFmt != null;
    case "hAlign": return style.hAlign != null;
    case "vAlign": return style.vAlign != null;
    case "wrap": return style.wrap != null;
    case "rotation": return style.rotation != null;
    case "indent": return !!style.indent;
    case "borders": return style.borders != null;
  }
}

/** This part of a style, as text: two styles with the same text look the same in it */
export function aspectKey(style: CellStyle, a: Aspect): string {
  switch (a) {
    case "family": return style.font?.family ?? "";
    case "size": return String(style.font?.size ?? "");
    case "bold": case "italic": case "underline": case "strike": return hasAspect(style, a) ? "1" : "";
    case "color": return style.font?.color ?? "";
    case "fill": return style.fill ?? "";
    case "numFmt": return style.numFmt ?? "";
    case "hAlign": return style.hAlign ?? "";
    case "vAlign": return style.vAlign ?? "";
    case "wrap": return style.wrap ?? "";
    case "rotation": return String(style.rotation ?? "");
    case "indent": return style.indent ? `${style.indent}${style.hAlign === "RIGHT" ? "R" : "L"}` : "";
    case "borders": return style.borders ? JSON.stringify(style.borders) : "";
  }
}

const MASK: Record<Aspect, string> = {
  family: "userEnteredFormat.textFormat.fontFamily",
  size: "userEnteredFormat.textFormat.fontSize",
  bold: "userEnteredFormat.textFormat.bold",
  italic: "userEnteredFormat.textFormat.italic",
  underline: "userEnteredFormat.textFormat.underline",
  strike: "userEnteredFormat.textFormat.strikethrough",
  color: "userEnteredFormat.textFormat.foregroundColorStyle",
  fill: "userEnteredFormat.backgroundColorStyle",
  numFmt: "userEnteredFormat.numberFormat",
  hAlign: "userEnteredFormat.horizontalAlignment",
  vAlign: "userEnteredFormat.verticalAlignment",
  wrap: "userEnteredFormat.wrapStrategy",
  rotation: "userEnteredFormat.textRotation",
  indent: "userEnteredFormat.padding",
  borders: "userEnteredFormat.borders",
};

/** A cell's padding in Google Sheets, and what one step of Excel's indent adds to a side (about three spaces) */
export const CELL_PADDING = { top: 2, right: 3, bottom: 2, left: 3 };
export const INDENT_PX = 9;

/** The cell format that carries one part of a style */
export function aspectFormat(style: CellStyle, a: Aspect): Record<string, unknown> {
  const font = style.font ?? {};
  switch (a) {
    case "family": return { textFormat: { fontFamily: font.family } };
    case "size": return { textFormat: { fontSize: font.size } };
    case "bold": return { textFormat: { bold: true } };
    case "italic": return { textFormat: { italic: true } };
    case "underline": return { textFormat: { underline: true } };
    case "strike": return { textFormat: { strikethrough: true } };
    case "color": return { textFormat: { foregroundColorStyle: colorStyle(font.color!) } };
    case "fill": return { backgroundColorStyle: colorStyle(style.fill!) };
    case "numFmt": return { numberFormat: numberFormat(style.numFmt!) };
    case "hAlign": return { horizontalAlignment: style.hAlign };
    case "vAlign": return { verticalAlignment: style.vAlign };
    case "wrap": return { wrapStrategy: style.wrap };
    case "rotation": return { textRotation: style.rotation === "vertical" ? { vertical: true } : { angle: style.rotation } };
    case "indent": {
      // Sheets has no indent: the same room is made with padding, on the side the text starts from
      const extra = (style.indent ?? 0) * INDENT_PX;
      return { padding: style.hAlign === "RIGHT" ? { ...CELL_PADDING, right: CELL_PADDING.right + extra } : { ...CELL_PADDING, left: CELL_PADDING.left + extra } };
    }
    case "borders": {
      const b = style.borders!;
      const out: Record<string, unknown> = {};
      if (b.top) out.top = borderValue(b.top);
      if (b.bottom) out.bottom = borderValue(b.bottom);
      if (b.left) out.left = borderValue(b.left);
      if (b.right) out.right = borderValue(b.right);
      return { borders: out };
    }
  }
}

/** A whole style as one cell format, and the fields it sets */
export function styleFormat(style: CellStyle): { format: Record<string, unknown>; fields: string } {
  const format: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const a of ASPECTS) {
    if (!hasAspect(style, a)) continue;
    const part = aspectFormat(style, a);
    for (const [key, value] of Object.entries(part)) {
      if (key === "textFormat") format.textFormat = { ...(format.textFormat as object | undefined), ...(value as object) };
      else format[key] = value;
    }
    fields.push(MASK[a]);
  }
  return { format, fields: fields.join(",") };
}

export function gridRange(sheetId: number, rect: Rect): Record<string, number> {
  return { sheetId, startRowIndex: rect[0], endRowIndex: rect[2] + 1, startColumnIndex: rect[1], endColumnIndex: rect[3] + 1 };
}

/** What a cell holds, as the Sheets API takes it (nothing for an empty cell) */
export function cellValue(cell: Cell): Record<string, unknown> | undefined {
  if (cell.spill) return undefined;
  if (cell.f != null) return { formulaValue: "=" + cell.f };
  // An error someone left as a value: Sheets takes its name as a formula
  if (cell.e != null) return { formulaValue: "=" + cell.e };
  if (typeof cell.v === "number") return { numberValue: cell.v };
  if (typeof cell.v === "boolean") return { boolValue: cell.v };
  if (typeof cell.v === "string" && cell.v !== "") return { stringValue: cell.v };
  return undefined;
}

/** A link as Sheets takes it: one inside the workbook goes to the tab and cell by id */
export function linkUri(wb: Workbook, link: string): string {
  if (!link.startsWith("#")) return link;
  const m = /^#(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(link);
  if (!m) return link;
  const name = (m[1] ?? m[2]).replace(/''/g, "'");
  const sheet = wb.sheets.find((s) => s.name === name);
  return sheet ? `#gid=${sheet.id}&range=${m[3].replace(/\$/g, "")}` : link;
}

/** The runs of a cell's text: its rich text, and its link on all of it */
export function textRuns(wb: Workbook, cell: Cell): Record<string, unknown>[] {
  const style = cell.s ? wb.styles[cell.s] : undefined;
  const link = cell.link ? { link: { uri: linkUri(wb, cell.link) } } : null;
  // A link's run takes Sheets' link colour unless told the cell's own
  const keep = link && style?.font ? { ...(style.font.color ? { foregroundColorStyle: colorStyle(style.font.color) } : {}), ...(style.font.underline ? { underline: true } : {}) } : {};
  const runs = cell.runs?.length ? cell.runs : [{ at: 0, font: {} }];
  return runs.map((run) => ({ ...(run.at > 0 ? { startIndex: run.at } : {}), format: { ...keep, ...textFormat(run.font), ...(link ?? {}) } }));
}

/** updateCells requests that write `data` for each of these cells, neighbours in a row together */
function cellRequests(sheet: Sheet, indexes: readonly number[], fields: string, data: (cell: Cell) => Record<string, unknown>): SheetsRequest[] {
  const sorted = indexes.map((i) => sheet.cells[i]).filter(Boolean).sort((a, b) => a.r - b.r || a.c - b.c);
  const out: SheetsRequest[] = [];
  let run: Cell[] = [];
  const flush = () => {
    if (!run.length) return;
    out.push({ updateCells: { start: { sheetId: sheet.id, rowIndex: run[0].r, columnIndex: run[0].c }, rows: [{ values: run.map(data) }], fields } });
    run = [];
  };
  for (const cell of sorted) {
    const last = run[run.length - 1];
    if (last && (last.r !== cell.r || last.c + 1 !== cell.c)) flush();
    run.push(cell);
  }
  flush();
  return out;
}

const typedData = (cell: Cell): Record<string, unknown> => {
  const value = cellValue(cell);
  return { ...(value ? { userEnteredValue: value } : {}), ...(cell.note ? { note: cell.note } : {}) };
};

const DIMENSION = { c: "COLUMNS", r: "ROWS" } as const;

function conditionalRequests(wb: Workbook, sheet: Sheet): SheetsRequest[] {
  return (sheet.conditional ?? []).map((rule, index) => {
    const ranges = rule.ranges.map((r) => gridRange(sheet.id, r));
    if (rule.scale) {
      const point = (p: NonNullable<typeof rule.scale>[number]) => ({ type: p.type, ...(p.value != null ? { value: p.value } : {}), colorStyle: colorStyle(p.color) });
      const s = rule.scale;
      const gradientRule = s.length === 3 ? { minpoint: point(s[0]), midpoint: point(s[1]), maxpoint: point(s[2]) } : { minpoint: point(s[0]), maxpoint: point(s[1]) };
      return { addConditionalFormatRule: { index, rule: { ranges, gradientRule } } };
    }
    const f = rule.format ?? {};
    const text: Record<string, unknown> = {};
    if (f.color) text.foregroundColorStyle = colorStyle(f.color);
    if (f.bold) text.bold = true;
    if (f.italic) text.italic = true;
    if (f.underline) text.underline = true;
    if (f.strike) text.strikethrough = true;
    const format = { ...(f.fill ? { backgroundColorStyle: colorStyle(f.fill) } : {}), ...(Object.keys(text).length ? { textFormat: text } : {}) };
    return { addConditionalFormatRule: { index, rule: { ranges, booleanRule: { condition: { type: rule.when!.type, values: rule.when!.values.map((v) => ({ userEnteredValue: v })) }, format } } } };
  });
}

/** Steps that would write twice if sent twice: the runner reads what is there before sending one */
export const needsCheck = (step: Step): boolean => step.k === "sheet" || step.k === "name" || step.k === "cf" || step.k === "groups" || step.k === "chart" || step.k === "banding";

/** What the spreadsheet already has, as far as those steps care */
export interface Existing {
  sheetIds: ReadonlySet<number>;
  namedRangeIds: ReadonlySet<string>;
  /** Conditional formatting rules on each sheet, by sheet id */
  conditionalRules: ReadonlyMap<number, number>;
  /** Row and column groups on each sheet, by sheet id */
  groups?: ReadonlyMap<number, number>;
  chartIds?: ReadonlySet<number>;
  bandIds?: ReadonlySet<number>;
}

/** The id a sheet's i-th banded range is made with, so a step sent twice is seen to be there already */
export const bandId = (sheetIndex: number, i: number, base = 0): number => 800_000 + base + sheetIndex * 1000 + i;

/** The id a chart gets in the Google Sheet: the same on every try, so a retry can tell it is there */
export const chartId = (sheetIndex: number, i: number, base = 0): number => 900_000 + base + sheetIndex * 1000 + i;

const LEGEND = { RIGHT: "RIGHT_LEGEND", LEFT: "LEFT_LEGEND", TOP: "TOP_LEGEND", BOTTOM: "BOTTOM_LEGEND", NONE: "NO_LEGEND" } as const;

function chartRequest(wb: Workbook, sheetIndex: number, sheet: Sheet, chart: Chart, i: number): SheetsRequest | null {
  const source = (src: ChartSource) => { const on = wb.sheets[src.sheet]; return on ? { sourceRange: { sources: [gridRange(on.id, src.rect)] } } : null; };
  const series = chart.series.map((s) => ({ s, range: source(s.src) })).filter((x) => x.range);
  if (!series.length) return null;
  const domain = chart.domain ? source(chart.domain) : null;
  const legendPosition = LEGEND[chart.legend ?? "RIGHT"];
  let spec: Record<string, unknown>;
  if (chart.type === "PIE") {
    spec = { pieChart: { legendPosition, ...(domain ? { domain } : {}), series: series[0].range, ...(chart.hole ? { pieHole: chart.hole } : {}) } };
  } else {
    // A bar chart's values run along the bottom; every other kind's run up the side
    const bar = chart.type === "BAR";
    const axis = [
      ...(chart.xTitle ? [{ position: bar ? "LEFT_AXIS" : "BOTTOM_AXIS", title: chart.xTitle }] : []),
      ...(chart.yTitle ? [{ position: bar ? "BOTTOM_AXIS" : "LEFT_AXIS", title: chart.yTitle }] : []),
    ];
    spec = { basicChart: {
      chartType: chart.type, legendPosition, headerCount: chart.headers ?? 0,
      ...(chart.stacked ? { stackedType: chart.stacked } : {}),
      ...(axis.length ? { axis } : {}),
      ...(domain ? { domains: [{ domain }] } : {}),
      series: series.map(({ s, range }) => ({ series: range, targetAxis: bar ? "BOTTOM_AXIS" : "LEFT_AXIS", ...(chart.type === "COMBO" && s.type ? { type: s.type } : {}), ...(s.color ? { colorStyle: colorStyle(s.color) } : {}) })),
    } };
  }
  return { addChart: { chart: {
    chartId: chartId(sheetIndex, i, wb.idBase),
    spec: { ...(chart.title ? { title: chart.title } : {}), ...spec },
    position: { overlayPosition: { anchorCell: { sheetId: sheet.id, rowIndex: chart.at[0], columnIndex: chart.at[1] }, offsetXPixels: chart.at[2], offsetYPixels: chart.at[3], widthPixels: chart.size[0], heightPixels: chart.size[1] } },
  } } };
}

export const namedRangeId = (i: number, base = 0): string => `ss_name_${base ? `${base}_` : ""}${i}`;

/** The requests a step sends. `existing` (for the steps that need it) leaves out what is already there */
export function stepRequests(wb: Workbook, step: Step, existing?: Existing): SheetsRequest[] {
  if (step.k === "pause") return [];
  if (step.k === "calc") {
    return wb.iterate ? [{ updateSpreadsheetProperties: { properties: { iterativeCalculationSettings: { maxIterations: wb.iterate.max, convergenceThreshold: wb.iterate.threshold } }, fields: "iterativeCalculationSettings" } }] : [];
  }
  if (step.k === "theme") {
    const theme = wb.theme ?? {};
    const themeColors = Object.entries(theme).map(([colorType, hex]) => ({ colorType, color: colorStyle(hex!) }));
    // (a theme is only taken whole: all nine colours with the font)
    if (themeColors.length !== 9) return [];
    return [{ updateSpreadsheetProperties: { properties: { spreadsheetTheme: { primaryFontFamily: wb.defaultFont.family, themeColors } }, fields: "spreadsheetTheme" } }];
  }
  if (step.k === "name") {
    const n = wb.names?.[step.i];
    const sheet = n ? wb.sheets[n.sheet] : undefined;
    if (!n || !sheet || existing?.namedRangeIds.has(namedRangeId(step.i, wb.idBase))) return [];
    return [{ addNamedRange: { namedRange: { namedRangeId: namedRangeId(step.i, wb.idBase), name: n.name, range: gridRange(sheet.id, n.rect) } } }];
  }
  const sheet = wb.sheets[step.s];
  if (!sheet) return [];
  const id = sheet.id;
  switch (step.k) {
    case "sheet": {
      const grid = { rowCount: sheet.rowCount, columnCount: sheet.colCount };
      const props = { sheetId: id, title: sheet.name, gridProperties: grid, ...(sheet.rtl ? { rightToLeft: true } : {}) };
      const fields = "title,gridProperties.rowCount,gridProperties.columnCount" + (sheet.rtl ? ",rightToLeft" : "");
      // The spreadsheet is made with its first tab; a retry finds the others already added. (Compare & Sync
      // says which it is: a tab the spreadsheet has, or one to add wherever it comes in the workbook.)
      if (step.mode === "update" || (step.mode !== "add" && step.s === 0) || existing?.sheetIds.has(id)) return [{ updateSheetProperties: { properties: props, fields } }];
      return [{ addSheet: { properties: { ...props, index: step.s } } }];
    }
    case "base":
      if (step.what === "size") return [{ repeatCell: { range: { sheetId: id }, cell: { userEnteredFormat: { textFormat: { fontSize: wb.defaultFont.size } } }, fields: MASK.size } }];
      return [{ updateDimensionProperties: { range: { sheetId: id, dimension: step.what === "rows" ? "ROWS" : "COLUMNS", startIndex: 0, endIndex: step.what === "rows" ? sheet.rowCount : sheet.colCount }, properties: { pixelSize: step.what === "rows" ? sheet.defaultRowPx : sheet.defaultColPx }, fields: "pixelSize" } }];
    case "band": {
      const { format, fields } = styleFormat(wb.styles[step.v] ?? {});
      if (!fields) return [];
      const range = step.d === "c" ? { sheetId: id, startColumnIndex: step.from, endColumnIndex: step.to + 1 } : { sheetId: id, startRowIndex: step.from, endRowIndex: step.to + 1 };
      return [{ repeatCell: { range, cell: { userEnteredFormat: format }, fields } }];
    }
    case "clear":
      return step.rects.map((rect) => ({ repeatCell: { range: gridRange(id, rect), cell: {}, fields: MASK[step.a] } }));
    case "span": {
      const span = sheet.spans?.[step.i];
      const { format, fields } = styleFormat((span && wb.styles[span.v]) ?? {});
      if (!span || !fields) return [];
      return span.rects.map((rect) => ({ repeatCell: { range: gridRange(id, rect), cell: { userEnteredFormat: format }, fields } }));
    }
    case "type": case "fill": case "paste": {
      const withNote = step.cells.some((i) => sheet.cells[i]?.note);
      return cellRequests(sheet, step.cells, withNote ? "userEnteredValue,note" : "userEnteredValue", typedData);
    }
    case "fmt": {
      const style = wb.styles[step.v];
      if (!style || !hasAspect(style, step.a)) return [];
      const cell = { userEnteredFormat: aspectFormat(style, step.a) };
      return step.rects.map((rect) => ({ repeatCell: { range: gridRange(id, rect), cell, fields: MASK[step.a] } }));
    }
    case "runs": {
      const cell = sheet.cells[step.cell];
      if (!cell || (!cell.runs?.length && !cell.link)) return [];
      return cellRequests(sheet, [step.cell], "textFormatRuns", (c) => ({ textFormatRuns: textRuns(wb, c) }));
    }
    case "merge":
      return step.rects.map((rect) => ({ mergeCells: { range: gridRange(id, rect), mergeType: "MERGE_ALL" } }));
    case "size":
      return [{ updateDimensionProperties: { range: { sheetId: id, dimension: DIMENSION[step.d], startIndex: step.from, endIndex: step.to + 1 }, properties: { pixelSize: step.px }, fields: "pixelSize" } }];
    case "hide":
      return [{ updateDimensionProperties: { range: { sheetId: id, dimension: DIMENSION[step.d], startIndex: step.from, endIndex: step.to + 1 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } }];
    case "prop":
      if (step.p === "gridlines") return [{ updateSheetProperties: { properties: { sheetId: id, gridProperties: { hideGridlines: true } }, fields: "gridProperties.hideGridlines" } }];
      if (step.p === "freeze") return [{ updateSheetProperties: { properties: { sheetId: id, gridProperties: { frozenRowCount: sheet.frozenRows ?? 0, frozenColumnCount: sheet.frozenCols ?? 0 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } }];
      if (step.p === "tab") return sheet.tabColor ? [{ updateSheetProperties: { properties: { sheetId: id, tabColorStyle: colorStyle(sheet.tabColor) }, fields: "tabColorStyle" } }] : [];
      return [{ updateSheetProperties: { properties: { sheetId: id, hidden: true }, fields: "hidden" } }];
    case "dv": {
      const v = sheet.validations?.[step.i];
      if (!v) return [];
      const condition = v.values ? { type: "ONE_OF_LIST", values: v.values.map((x) => ({ userEnteredValue: x })) }
        : v.source ? { type: "ONE_OF_RANGE", values: [{ userEnteredValue: v.source }] }
        : v.rule ? { type: v.rule.type, values: v.rule.values.map((x) => ({ userEnteredValue: x })) } : null;
      if (!condition) return [];
      const list = !!(v.values || v.source);
      return [{ setDataValidation: { range: gridRange(id, v.rect), rule: { condition, ...(list ? { showCustomUi: true } : {}), ...(v.strict ? { strict: true } : {}), ...(v.help ? { inputMessage: v.help } : {}) } } }];
    }
    case "filter":
      return sheet.filter ? [{ setBasicFilter: { filter: { range: gridRange(id, sheet.filter) } } }] : [];
    case "groups": {
      const groups = sheet.groups ?? [];
      const range = (g: (typeof groups)[number]) => ({ sheetId: id, dimension: DIMENSION[g.d], startIndex: g.from, endIndex: g.to + 1 });
      // Groups are added, not set: a sheet that has them already only gets its folds
      const adds = (existing?.groups?.get(id) ?? 0) > 0 ? [] : groups.map((g) => ({ addDimensionGroup: { range: range(g) } }));
      const folds = groups.filter((g) => g.collapsed).map((g) => ({ updateDimensionGroup: { dimensionGroup: { range: range(g), depth: g.depth, collapsed: true }, fields: "collapsed" } }));
      return [...adds, ...folds];
    }
    case "banding": {
      const b = sheet.banding?.[step.i];
      if (!b || existing?.bandIds?.has(bandId(step.s, step.i, wb.idBase))) return [];
      const props = (p: NonNullable<typeof b.rows>) => ({
        ...(p.header ? { headerColorStyle: colorStyle(p.header) } : {}), firstBandColorStyle: colorStyle(p.first), secondBandColorStyle: colorStyle(p.second),
        ...(p.footer ? { footerColorStyle: colorStyle(p.footer) } : {}),
      });
      return [{ addBanding: { bandedRange: { bandedRangeId: bandId(step.s, step.i, wb.idBase), range: gridRange(id, b.rect), ...(b.rows ? { rowProperties: props(b.rows) } : {}), ...(b.cols ? { columnProperties: props(b.cols) } : {}) } } }];
    }
    case "chart": {
      const chart = sheet.charts?.[step.i];
      if (!chart || existing?.chartIds?.has(chartId(step.s, step.i, wb.idBase))) return [];
      const request = chartRequest(wb, step.s, sheet, chart, step.i);
      return request ? [request] : [];
    }
    case "cf":
      // Rules are added, not set: a sheet that has them already is left alone
      return (existing?.conditionalRules.get(id) ?? 0) > 0 ? [] : conditionalRequests(wb, sheet);
  }
}

/** A step in a few words, for the activity line and the plan ("Typing C5", "Bold on F3:G4") */
export function stepLabel(wb: Workbook, step: Step): string {
  if (step.k === "pause") return "Away from the sheet";
  if (step.k === "theme") return "Setting the font";
  if (step.k === "calc") return "Turning on iterative calculation";
  if (step.k === "name") return `Naming a range (${wb.names?.[step.i]?.name ?? ""})`;
  const sheet = wb.sheets[step.s];
  const at = (i: number) => { const c = sheet?.cells[i]; return c ? cellName(c.r, c.c) : ""; };
  const span = (cells: number[]) => (cells.length === 1 ? at(cells[0]) : `${at(cells[0])} to ${at(cells[cells.length - 1])}`);
  const ranges = (rects: Rect[]) => (rects.length === 1 ? rectName(rects[0]) : `${rectName(rects[0])} and ${rects.length - 1} more`);
  const dims = (d: "c" | "r", from: number, to: number) => (d === "c" ? `column${from === to ? "" : "s"} ${rectName([0, from, 0, to]).replace(/\d+/g, "")}` : `row${from === to ? "" : "s"} ${from + 1}${from === to ? "" : `-${to + 1}`}`);
  switch (step.k) {
    case "sheet": return step.s === 0 ? `Naming the tab "${sheet?.name}"` : `Adding the tab "${sheet?.name}"`;
    case "base": return step.what === "size" ? "Setting the font size" : step.what === "rows" ? "Setting the row height" : "Setting the column width";
    case "band": return `Formatting ${dims(step.d, step.from, step.to)}`;
    case "span": return `Formatting ${ranges(sheet?.spans?.[step.i]?.rects ?? [])}`;
    case "clear": return `Clearing ${ASPECT_WORDS[step.a].toLowerCase()} on ${ranges(step.rects)}`;
    case "type": { const c = sheet?.cells[step.cells[0]]; return c?.f != null ? `Writing the formula in ${span(step.cells)}` : `Typing ${span(step.cells)}`; }
    case "fill": return `Filling ${span(step.cells)}`;
    case "paste": return `Pasting ${span(step.cells)}`;
    case "fmt": return `${ASPECT_WORDS[step.a]} on ${ranges(step.rects)}`;
    case "runs": return `Formatting text in ${at(step.cell)}`;
    case "merge": return `Merging ${ranges(step.rects)}`;
    case "size": return `Resizing ${dims(step.d, step.from, step.to)}`;
    case "hide": return `Hiding ${dims(step.d, step.from, step.to)}`;
    case "prop": return step.p === "gridlines" ? "Hiding the gridlines" : step.p === "freeze" ? "Freezing panes" : step.p === "tab" ? "Colouring the tab" : "Hiding the tab";
    case "dv": { const v = sheet?.validations?.[step.i]; return v && !v.values && !v.source ? "Adding a validation rule" : "Adding a dropdown"; }
    case "filter": return "Turning on the filter";
    case "banding": return `Alternating colours on ${sheet?.banding?.[step.i] ? rectName(sheet.banding[step.i].rect) : "a table"}`;
    case "groups": return "Grouping rows and columns";
    case "chart": return `Inserting a chart${sheet?.charts?.[step.i]?.title ? ` (${sheet.charts[step.i].title})` : ""}`;
    case "cf": return "Adding conditional formatting";
  }
}

const ASPECT_WORDS: Record<Aspect, string> = {
  family: "Font", size: "Font size", bold: "Bold", italic: "Italic", underline: "Underline", strike: "Strikethrough", color: "Text colour",
  fill: "Fill colour", numFmt: "Number format", hAlign: "Alignment", vAlign: "Vertical alignment", wrap: "Text wrapping", rotation: "Text rotation", indent: "Indent", borders: "Borders",
};
