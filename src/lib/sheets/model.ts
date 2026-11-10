/**
 * A spreadsheet as SyncStream holds it: what an .xlsx file says, already in the terms Google Sheets
 * uses (pixels, Sheets' border styles and alignments, colours as hex or a theme slot). The reader
 * (xlsx.ts) builds it, the page draws it, and the sync writes it into a Google Sheet.
 *
 * It travels as JSON (to the server when a sync starts, and into the stored plan), so its keys are
 * short and it holds nothing but plain values.
 */

/** "#rrggbb", or a slot of the spreadsheet's theme ("theme:ACCENT1") */
export type Color = string;

export const THEME_SLOTS = ["TEXT", "BACKGROUND", "ACCENT1", "ACCENT2", "ACCENT3", "ACCENT4", "ACCENT5", "ACCENT6", "LINK"] as const;
export type ThemeSlot = (typeof THEME_SLOTS)[number];

export const BORDER_STYLES = ["SOLID", "SOLID_MEDIUM", "SOLID_THICK", "DASHED", "DOTTED", "DOUBLE"] as const;
export type BorderStyle = (typeof BORDER_STYLES)[number];

export interface Border { style: BorderStyle; color: Color }

export interface FontStyle {
  family?: string;
  /** Points */
  size?: number;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  color?: Color;
}

/** How a cell looks. Every part is optional: an absent part is the spreadsheet's default */
export interface CellStyle {
  font?: FontStyle;
  fill?: Color;
  borders?: { top?: Border; bottom?: Border; left?: Border; right?: Border };
  /** An Excel number format ("#,##0.00", "yyyy-mm-dd"; "@" is plain text) */
  numFmt?: string;
  hAlign?: "LEFT" | "CENTER" | "RIGHT";
  vAlign?: "TOP" | "MIDDLE" | "BOTTOM";
  wrap?: "WRAP" | "CLIP";
  /** Degrees (-90 to 90), or letters stacked top to bottom */
  rotation?: number | "vertical";
  /** Excel's indent steps (each about three spaces wide), from the side the text is aligned to */
  indent?: number;
}

/** Part of a cell's text with a look of its own, from `at` (in characters) to the next run */
export interface TextRun { at: number; font: FontStyle }

export interface Cell {
  /** Row and column, from 0 */
  r: number;
  c: number;
  /** Index into Workbook.styles (absent: unstyled) */
  s?: number;
  /** What the cell holds; for a formula, the value it had when the file was saved */
  v?: number | string | boolean;
  /** The formula, without its "=", as Google Sheets takes it */
  f?: string;
  /** An error the cell shows ("#N/A"), for an error value or a formula that gave one */
  e?: string;
  runs?: TextRun[];
  /** Where the cell links to: a URL, or "#Sheet!A1" inside the workbook */
  link?: string;
  note?: string;
  /** Filled by the array formula in the cell at [row, column]: shown, never typed */
  spill?: [number, number];
}

/** [first row, first column, last row, last column], all inclusive, from 0 */
export type Rect = [number, number, number, number];

/** Consecutive rows or columns with the same size: [first, last, pixels] */
export type SizeRun = [number, number, number];

/** What a range's cells may hold: a dropdown (its choices, or the range they come from), or a rule */
export interface Validation {
  rect: Rect;
  /** A dropdown's choices, or the range they come from ("=Sheet!A1:A5") */
  values?: string[];
  source?: string;
  /** Any other rule, as a Sheets condition ("NUMBER_BETWEEN" with its two values, "CUSTOM_FORMULA" with one) */
  rule?: { type: string; values: string[] };
  /** Whether a value that breaks the rule is refused (otherwise it is only flagged) */
  strict?: boolean;
  /** The hint shown when the cell is picked */
  help?: string;
}
export type ListValidation = Validation;

/** Rows or columns folded together under a +/- control; an outer group comes before the ones inside it */
export interface DimensionGroup { d: "r" | "c"; from: number; to: number; depth: number; collapsed?: true }

/** Cells a chart draws from, on a sheet of the workbook (by its place in the list) */
export interface ChartSource { sheet: number; rect: Rect }

export const CHART_TYPES = ["COLUMN", "BAR", "LINE", "AREA", "SCATTER", "PIE", "COMBO"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface Chart {
  /** Where its top left corner is: the cell, and pixels into it */
  at: [number, number, number, number];
  /** Width and height in pixels */
  size: [number, number];
  type: ChartType;
  stacked?: "STACKED" | "PERCENT_STACKED";
  title?: string;
  legend?: "RIGHT" | "LEFT" | "TOP" | "BOTTOM" | "NONE";
  /** Titles of the category axis and the value axis */
  xTitle?: string;
  yTitle?: string;
  /** The labels along the category axis (a pie's slice names, a scatter's x values) */
  domain?: ChartSource;
  series: { src: ChartSource; type?: "COLUMN" | "LINE" | "AREA"; color?: Color }[];
  /** 1 when each range starts with its name (the cell above a column of values) */
  headers?: 0 | 1;
  /** A doughnut's hole, as a share of the pie */
  hole?: number;
}

export interface ConditionalRule {
  ranges: Rect[];
  /** A rule that paints matching cells */
  when?: { type: string; values: string[] };
  format?: { fill?: Color; color?: Color; bold?: true; italic?: true; underline?: true; strike?: true };
  /** A colour scale: two or three points */
  scale?: { type: "MIN" | "MAX" | "NUMBER" | "PERCENT" | "PERCENTILE"; value?: string; color: Color }[];
}

export interface Sheet {
  /** The id the Google Sheet's tab gets */
  id: number;
  name: string;
  hidden?: true;
  tabColor?: Color;
  hideGridlines?: true;
  rtl?: true;
  frozenRows?: number;
  frozenCols?: number;
  rowCount: number;
  colCount: number;
  defaultRowPx: number;
  defaultColPx: number;
  /** Rows and columns whose size isn't the default */
  rowPx: SizeRun[];
  colPx: SizeRun[];
  hiddenRows?: [number, number][];
  hiddenCols?: [number, number][];
  merges: Rect[];
  /** Whole columns, then whole rows, that carry a style: [first, last, style] */
  colStyles?: [number, number, number][];
  rowStyles?: [number, number, number][];
  /** Every cell with a value or a style, row by row */
  cells: Cell[];
  validations?: Validation[];
  conditional?: ConditionalRule[];
  /** The range with filter buttons on its first row */
  filter?: Rect;
  groups?: DimensionGroup[];
  charts?: Chart[];
}

export interface NamedRange { name: string; sheet: number; rect: Rect }

export interface Workbook {
  /** The file's name without its extension: the new Google Sheet's title */
  name: string;
  /** Who wrote the file: Google Sheets' own export sizes columns differently from Excel */
  origin: "google" | "excel" | "other";
  defaultFont: { family: string; size: number };
  /** The theme's colours, as hex, by slot */
  theme?: Partial<Record<ThemeSlot, string>>;
  /** styles[0] is the unstyled look */
  styles: CellStyle[];
  sheets: Sheet[];
  names?: NamedRange[];
  /** What the file has that isn't carried over, in plain words */
  warnings: string[];
}

// ── Addresses ──────────────────────────────────────────────────────────────

/** 0 → "A", 26 → "AA" */
export function colName(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** "A" → 0, "AA" → 26 (-1 when it isn't letters) */
export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) {
    const d = ch.charCodeAt(0) - 64;
    if (d < 1 || d > 26) return -1;
    n = n * 26 + d;
  }
  return n - 1;
}

export const cellName = (r: number, c: number): string => colName(c) + (r + 1);

/** "B7" → [6, 1]; null when it isn't a cell address */
export function parseCellName(ref: string): [number, number] | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return null;
  const c = colIndex(m[1]);
  const r = Number(m[2]) - 1;
  return c < 0 || r < 0 ? null : [r, c];
}

/** "B2:D9" (or one cell) → its rectangle */
export function parseRange(ref: string): Rect | null {
  const [a, b] = ref.split(":");
  const p = parseCellName(a);
  const q = b == null ? p : parseCellName(b);
  if (!p || !q) return null;
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
}

export function rectName(rect: Rect): string {
  const a = cellName(rect[0], rect[1]);
  const b = cellName(rect[2], rect[3]);
  return a === b ? a : `${a}:${b}`;
}

export const rectCells = (rect: Rect): number => (rect[2] - rect[0] + 1) * (rect[3] - rect[1] + 1);
export const inRect = (rect: Rect, r: number, c: number): boolean => r >= rect[0] && r <= rect[2] && c >= rect[1] && c <= rect[3];

/** A sheet's name as a formula writes it: quoted when it has anything but letters, digits and "_" */
export function sheetRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

// ── Sizes ──────────────────────────────────────────────────────────────────

/** The size of row or column `i`, given the runs that differ from the default */
export function sizeAt(runs: readonly SizeRun[], i: number, fallback: number): number {
  for (const [from, to, px] of runs) if (i >= from && i <= to) return px;
  return fallback;
}

/** Sizes of rows or columns 0..count-1 and where each starts: offsets[i] is the left/top edge of i */
export function layout(runs: readonly SizeRun[], count: number, fallback: number, hidden: readonly [number, number][] = []): { sizes: number[]; offsets: number[] } {
  const sizes = new Array<number>(count).fill(fallback);
  for (const [from, to, px] of runs) for (let i = Math.max(0, from); i <= to && i < count; i++) sizes[i] = px;
  for (const [from, to] of hidden) for (let i = Math.max(0, from); i <= to && i < count; i++) sizes[i] = 0;
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + sizes[i];
  return { sizes, offsets };
}

// ── Cells ──────────────────────────────────────────────────────────────────

/** Whether the cell holds anything (a value, a formula or an error), as opposed to only a look */
export const hasContent = (cell: Cell): boolean => !cell.spill && (cell.f != null || cell.e != null || (cell.v != null && cell.v !== ""));

/** The text someone types to get this cell: the formula with its "=", or the value */
export function typedText(cell: Cell): string {
  if (cell.f != null) return "=" + cell.f;
  if (cell.e != null) return cell.e;
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  return cell.v == null ? "" : String(cell.v);
}

export const cellKey = (r: number, c: number): number => r * 16384 + c;

/** The sheet's cells by position */
export function indexCells(sheet: Sheet): Map<number, number> {
  const at = new Map<number, number>();
  sheet.cells.forEach((cell, i) => at.set(cellKey(cell.r, cell.c), i));
  return at;
}

/** The rectangle around every cell with content ([0,0,0,0] for an empty sheet) */
export function usedRect(sheet: Sheet): Rect {
  let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1;
  for (const cell of sheet.cells) {
    if (!hasContent(cell)) continue;
    r0 = Math.min(r0, cell.r); c0 = Math.min(c0, cell.c); r1 = Math.max(r1, cell.r); c1 = Math.max(c1, cell.c);
  }
  return r1 < 0 ? [0, 0, 0, 0] : [r0, c0, r1, c1];
}

export interface WorkbookStats { sheets: number; cells: number; formulas: number; styled: number }

export function workbookStats(wb: Workbook): WorkbookStats {
  let cells = 0, formulas = 0, styled = 0;
  for (const sheet of wb.sheets) {
    for (const cell of sheet.cells) {
      if (hasContent(cell)) cells++;
      if (cell.f != null) formulas++;
      if (cell.s) styled++;
    }
  }
  return { sheets: wb.sheets.length, cells, formulas, styled };
}
