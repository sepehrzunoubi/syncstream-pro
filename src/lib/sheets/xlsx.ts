/**
 * Reading an .xlsx file into a Workbook (model.ts): every sheet's cells with their values, formulas
 * and looks, merged cells, row and column sizes, frozen panes, notes, links, dropdowns and
 * conditional formatting. Runs in the browser, on the file the person picked: nothing is uploaded
 * until a sync starts.
 *
 * Where Excel's terms and Google Sheets' differ, this lands on what Google's own import of the same
 * file gives (measured against it): its border styles, alignments, date and number formats, array
 * formulas, and a filled cell's colour.
 */

import { child, children, find, flag, parseXml, type XmlNode } from "./xml";
import { Zip, ZipError } from "./zip";
import { shiftFormula, toSheetsFormula } from "./formula";
import { resolveTableRefs, type TableInfo } from "./table-refs";
import { readCharts } from "./xlsx-charts";
import { readRels } from "./xlsx-parts";
import { numberFormatType } from "./steps";
import {
  cellName, hasContent, parseCellName, parseRange, rectName,
  type Border, type BorderStyle, type Cell, type CellStyle, type Color, type ConditionalRule, type DimensionGroup, type FontStyle, type NamedRange, type Rect, type Sheet, type SizeRun, type TextRun, type ThemeSlot, type Validation, type Workbook,
} from "./model";

export type XlsxErrorCode = "notXlsx" | "oldExcel" | "encrypted" | "empty" | "tooLarge" | "damaged";

export class XlsxError extends Error {
  constructor(public readonly code: XlsxErrorCode, message: string) { super(message); }
}

/** The largest file read */
export const MAX_XLSX_BYTES = 12 * 1024 * 1024;
/** Cells (with a value or a look) a workbook may have */
export const MAX_CELLS = 150_000;
export const MAX_SHEETS = 60;

const MESSAGES: Record<XlsxErrorCode, string> = {
  notXlsx: "This file isn't an Excel workbook (.xlsx).",
  oldExcel: "This is an older Excel file (.xls). Open it in Excel or Google Sheets, save it as .xlsx, and upload that.",
  encrypted: "This workbook is password protected. Remove the password in Excel, save it, and upload it again.",
  empty: "This workbook has no sheets with cells.",
  tooLarge: "This workbook is too large to sync cell by cell. Try a smaller one, or split it.",
  damaged: "This workbook couldn't be read. It may be damaged: open it in Excel, save it again, and upload that.",
};

const fail = (code: XlsxErrorCode): never => { throw new XlsxError(code, MESSAGES[code]); };

// ── Number formats, colours ────────────────────────────────────────────────

const BUILTIN_FORMATS: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
  5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)', 7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm",
  37: "#,##0_);(#,##0)", 38: "#,##0_);[Red](#,##0)", 39: "#,##0.00_);(#,##0.00)", 40: "#,##0.00_);[Red](#,##0.00)",
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
};

/**
 * A number format as Google Sheets takes it. Excel writes things into formats that Sheets refuses:
 * a locale or currency tag ("[$-409]", "[$€-407]"), number-shape tags ("[DBNum1]") and the word
 * General inside a longer format. Quoted text and escaped characters are left alone.
 */
export function sheetsNumberFormat(code: string, general = "0.##########"): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const j = code.indexOf('"', i + 1);
      const end = j < 0 ? code.length - 1 : j;
      out += code.slice(i, end + 1);
      i = end;
    } else if (ch === "\\" || ch === "_" || ch === "*") {
      out += code.slice(i, i + 2);
      i++;
    } else if (ch === "[") {
      const j = code.indexOf("]", i);
      if (j < 0) { out += ch; continue; }
      const inner = code.slice(i + 1, j);
      i = j;
      if (inner.startsWith("$")) {
        // A currency symbol with a locale after it: only the symbol is something to show
        const symbol = inner.slice(1).split("-")[0].replace(/"/g, "");
        if (symbol) out += `"${symbol}"`;
      } else if (!/^(DBNum|NatNum|ENG$|JPN$|CHS$|CHT$|KOR$)/i.test(inner)) out += `[${inner}]`;
    } else if (/^general/i.test(code.slice(i, i + 7))) {
      out += general;
      i += 6;
    } else out += ch;
  }
  return out;
}

const INDEXED = [
  "000000", "ffffff", "ff0000", "00ff00", "0000ff", "ffff00", "ff00ff", "00ffff",
  "000000", "ffffff", "ff0000", "00ff00", "0000ff", "ffff00", "ff00ff", "00ffff",
  "800000", "008000", "000080", "808000", "800080", "008080", "c0c0c0", "808080",
  "9999ff", "993366", "ffffcc", "ccffff", "660066", "ff8080", "0066cc", "ccccff",
  "000080", "ff00ff", "ffff00", "00ffff", "800080", "800000", "008080", "0000ff",
  "00ccff", "ccffff", "ccffcc", "ffff99", "99ccff", "ff99cc", "cc99ff", "ffcc99",
  "3366ff", "33cccc", "99cc00", "ffcc00", "ff9900", "ff6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];

/** A cell's theme colour number → Google's slot (the others, and any tinted one, become plain colours) */
const THEME_SLOT: Record<number, ThemeSlot> = { 0: "BACKGROUND", 1: "TEXT", 4: "ACCENT1", 5: "ACCENT2", 6: "ACCENT3", 7: "ACCENT4", 8: "ACCENT5", 9: "ACCENT6", 10: "LINK" };

/** Office's default theme, for a file without one: lt1, dk1, lt2, dk2, accents, links */
const DEFAULT_THEME = ["ffffff", "000000", "e7e6e6", "44546a", "4472c4", "ed7d31", "a5a5a5", "ffc000", "5b9bd5", "70ad47", "0563c1", "954f72"];

/** Excel's tint: towards white (positive) or black (negative), on the colour's lightness */
export function applyTint(hex: string, tint: number): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let R = l, G = l, B = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    R = hue(p, q, h + 1 / 3); G = hue(p, q, h); B = hue(p, q, h - 1 / 3);
  }
  // Cut, not rounded: what Google's import of a tinted colour gives (4F81BD at 0.4 is 95B3D7, C0504D at 0.6 is E5B9B7)
  const hex2 = (v: number) => Math.max(0, Math.min(255, Math.floor(v * 255 + 1e-9))).toString(16).padStart(2, "0");
  return hex2(R) + hex2(G) + hex2(B);
}

class Palette {
  constructor(readonly theme: string[]) {}

  /** A <color>-like element's colour; undefined for none or "automatic" */
  resolve(node: XmlNode | undefined): Color | undefined {
    if (!node) return undefined;
    const a = node.attrs;
    if (a.rgb && /^[0-9a-fA-F]{6,8}$/.test(a.rgb)) return "#" + a.rgb.slice(-6).toLowerCase();
    if (a.theme != null) {
      const idx = Number(a.theme);
      const tint = a.tint != null ? Number(a.tint) : 0;
      const base = this.theme[idx];
      if (!base) return undefined;
      if (!tint && THEME_SLOT[idx]) return "theme:" + THEME_SLOT[idx];
      return "#" + (tint ? applyTint(base, tint) : base);
    }
    if (a.indexed != null) {
      const idx = Number(a.indexed);
      if (idx === 64) return "#000000";
      if (idx === 65) return "#ffffff";
      return INDEXED[idx] ? "#" + INDEXED[idx] : undefined;
    }
    return undefined;
  }
}

function readTheme(xml: string | null): string[] {
  if (!xml) return DEFAULT_THEME;
  const scheme = find(parseXml(xml), "clrScheme");
  if (!scheme) return DEFAULT_THEME;
  const hex = (name: string): string | undefined => {
    const c = child(scheme, name);
    const v = child(c, "srgbClr")?.attrs.val ?? child(c, "sysClr")?.attrs.lastClr;
    return v && /^[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
  };
  // Cells number the theme's colours with the light and dark pairs swapped
  const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  return order.map((name, i) => hex(name) ?? DEFAULT_THEME[i]);
}

// ── Styles ─────────────────────────────────────────────────────────────────

/** Excel's border styles as Google Sheets draws them (what its own import picks) */
const BORDER: Record<string, BorderStyle> = {
  thin: "SOLID", medium: "SOLID_MEDIUM", thick: "SOLID_THICK", double: "DOUBLE", hair: "DOTTED",
  dashed: "DASHED", dotted: "DASHED", mediumDashed: "DASHED", dashDot: "DASHED", mediumDashDot: "DASHED", dashDotDot: "DASHED", mediumDashDotDot: "DASHED", slantDashDot: "DASHED",
};
const H_ALIGN: Record<string, CellStyle["hAlign"]> = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "LEFT", fill: "CENTER", centerContinuous: "CENTER", distributed: "CENTER" };
const V_ALIGN: Record<string, CellStyle["vAlign"]> = { top: "TOP", center: "MIDDLE", bottom: "BOTTOM", justify: "MIDDLE", distributed: "MIDDLE" };

function readFont(node: XmlNode | undefined, palette: Palette): FontStyle {
  const font: FontStyle = {};
  if (!node) return font;
  const on = (tag: string) => { const c = child(node, tag); return !!c && flag(c.attrs.val, true); };
  const name = (child(node, "name") ?? child(node, "rFont"))?.attrs.val;
  if (name) font.family = name;
  const size = Number(child(node, "sz")?.attrs.val);
  if (Number.isFinite(size) && size > 0) font.size = Math.round(size * 100) / 100;
  if (on("b")) font.bold = true;
  if (on("i")) font.italic = true;
  const u = child(node, "u");
  if (u && u.attrs.val !== "none") font.underline = true;
  if (on("strike")) font.strike = true;
  const color = palette.resolve(child(node, "color"));
  if (color) font.color = color;
  return font;
}

interface StyleBook {
  /** Deduplicated looks; [0] is the unstyled one */
  styles: CellStyle[];
  /** A cell's `s` (its xf) → index into styles */
  xf: number[];
  defaultFont: { family: string; size: number };
  /**
   * Styles whose number format has Excel's General inside it ("General \"units\""), by style, with the
   * format as the file has it: Sheets has no such code, so it is written for the values it shows
   */
  general: Map<number, string>;
  /** Differential formats, for conditional formatting */
  dxfs: NonNullable<ConditionalRule["format"]>[];
}

function readStyles(xml: string | null, palette: Palette): StyleBook {
  const book: StyleBook = { styles: [{}], xf: [0], defaultFont: { family: "Calibri", size: 11 }, general: new Map(), dxfs: [] };
  if (!xml) return book;
  const root = child(parseXml(xml), "styleSheet");
  if (!root) return book;

  const numFmts = new Map<number, string>();
  for (const n of children(child(root, "numFmts"), "numFmt")) numFmts.set(Number(n.attrs.numFmtId), n.attrs.formatCode ?? "");
  const fontNodes = children(child(root, "fonts"), "font");
  const fonts = fontNodes.map((n) => readFont(n, palette));
  if (fonts[0]?.family) book.defaultFont.family = fonts[0].family;
  if (fonts[0]?.size) book.defaultFont.size = fonts[0].size;

  const fills = children(child(root, "fills"), "fill").map((n): Color | undefined => {
    const p = child(n, "patternFill");
    // Only a solid fill has one colour; patterns are left out, as Google's import leaves them
    if (!p || p.attrs.patternType !== "solid") return undefined;
    return palette.resolve(child(p, "fgColor")) ?? palette.resolve(child(p, "bgColor"));
  });

  const borders = children(child(root, "borders"), "border").map((n): CellStyle["borders"] => {
    const out: NonNullable<CellStyle["borders"]> = {};
    const side = (tag: string, alt: string): Border | undefined => {
      const s = child(n, tag) ?? child(n, alt);
      const style = s ? BORDER[s.attrs.style ?? ""] : undefined;
      if (!s || !style) return undefined;
      return { style, color: palette.resolve(child(s, "color")) ?? "#000000" };
    };
    const top = side("top", "top"), bottom = side("bottom", "bottom"), left = side("left", "start"), right = side("right", "end");
    if (top) out.top = top;
    if (bottom) out.bottom = bottom;
    if (left) out.left = left;
    if (right) out.right = right;
    return Object.keys(out).length ? out : undefined;
  });

  const seen = new Map<string, number>([["{}", 0]]);
  const xfs = children(child(root, "cellXfs"), "xf");
  book.xf = xfs.map((xf, i) => {
    // The first format is the workbook's plain cell: its look is the spreadsheet's default
    if (i === 0) return 0;
    const style: CellStyle = {};
    const font = fonts[Number(xf.attrs.fontId ?? 0)];
    if (font && Object.keys(font).length) {
      // (a font that leaves its size out is drawn at the default size)
      style.font = { ...font, size: font.size ?? book.defaultFont.size };
    }
    const fill = fills[Number(xf.attrs.fillId ?? 0)];
    if (fill) style.fill = fill;
    const border = borders[Number(xf.attrs.borderId ?? 0)];
    if (border) style.borders = border;
    const fmtId = Number(xf.attrs.numFmtId ?? 0);
    const fmt = numFmts.get(fmtId) ?? BUILTIN_FORMATS[fmtId];
    if (fmt && fmt.trim().toLowerCase() !== "general") { const clean = sheetsNumberFormat(fmt); if (clean.trim()) style.numFmt = clean; }
    const al = child(xf, "alignment");
    if (al) {
      const h = H_ALIGN[al.attrs.horizontal ?? ""];
      if (h) style.hAlign = h;
      const v = V_ALIGN[al.attrs.vertical ?? ""];
      if (v) style.vAlign = v;
      if (flag(al.attrs.wrapText)) style.wrap = "WRAP";
      else if (flag(al.attrs.shrinkToFit)) style.wrap = "CLIP";
      const rot = Number(al.attrs.textRotation ?? 0);
      if (rot === 255) style.rotation = "vertical";
      else if (rot > 0 && rot <= 90) style.rotation = rot;
      else if (rot > 90 && rot <= 180) style.rotation = 90 - rot;
      const indent = Math.round(Number(al.attrs.indent ?? 0));
      if (indent > 0) style.indent = Math.min(15, indent);
    }
    const key = JSON.stringify(style);
    let idx = seen.get(key);
    if (idx == null) { idx = book.styles.length; book.styles.push(style); seen.set(key, idx); }
    if (fmt && /general/i.test(fmt.replace(/"[^"]*"/g, "")) && style.numFmt) book.general.set(idx, fmt);
    return idx;
  });

  book.dxfs = children(child(root, "dxfs"), "dxf").map((n) => {
    const out: NonNullable<ConditionalRule["format"]> = {};
    const font = readFont(child(n, "font"), palette);
    if (font.color) out.color = font.color;
    if (font.bold) out.bold = true;
    if (font.italic) out.italic = true;
    if (font.underline) out.underline = true;
    if (font.strike) out.strike = true;
    const p = child(child(n, "fill"), "patternFill");
    // (a conditional fill names its colour as the pattern's background)
    const fill = p ? palette.resolve(child(p, "bgColor")) ?? palette.resolve(child(p, "fgColor")) : undefined;
    if (fill) out.fill = fill;
    return out;
  });
  return book;
}

// ── Text ───────────────────────────────────────────────────────────────────

interface RichText { text: string; runs?: TextRun[] }

/** A shared or inline string: its text, and the runs that look different */
function readRich(node: XmlNode | undefined, palette: Palette): RichText {
  if (!node) return { text: "" };
  const rs = children(node, "r");
  if (!rs.length) return { text: child(node, "t")?.text ?? "" };
  let text = "";
  const runs: TextRun[] = [];
  for (const r of rs) {
    const t = child(r, "t")?.text ?? "";
    if (!t) continue;
    runs.push({ at: text.length, font: readFont(child(r, "rPr"), palette) });
    text += t;
  }
  return runs.some((r) => Object.keys(r.font).length) ? { text, runs } : { text };
}

// ── Parts ──────────────────────────────────────────────────────────────────

const CF_OPERATORS: Record<string, string> = {
  greaterThan: "NUMBER_GREATER", greaterThanOrEqual: "NUMBER_GREATER_THAN_EQ", lessThan: "NUMBER_LESS", lessThanOrEqual: "NUMBER_LESS_THAN_EQ",
  equal: "NUMBER_EQ", notEqual: "NUMBER_NOT_EQ", between: "NUMBER_BETWEEN", notBetween: "NUMBER_NOT_BETWEEN",
};

/** A value in a rule or a dropdown: a number as it is, text without its quotes, anything else as a formula */
function conditionValue(formula: string): string {
  const f = formula.trim();
  if (/^-?\d+(\.\d+)?$/.test(f)) return f;
  if (/^"(?:[^"]|"")*"$/.test(f)) return f.slice(1, -1).replace(/""/g, '"');
  return "=" + toSheetsFormula(f);
}

function sqrefRects(sqref: string | undefined): Rect[] {
  return (sqref ?? "").split(/\s+/).map((r) => parseRange(r)).filter((r): r is Rect => !!r);
}

interface ReadContext {
  zip: Zip;
  palette: Palette;
  book: StyleBook;
  shared: RichText[];
  origin: Workbook["origin"];
  warnings: Set<string>;
  budget: { cells: number };
  /** Every table of the workbook, for the formulas that name them */
  tables: TableInfo[];
  /** Drawing parts still to read for charts, once every sheet is known */
  drawings: { sheet: number; part: string }[];
  /** Dates count from 1904 (old Mac workbooks): four years and a day later than everyone else's */
  date1904: boolean;
}

/**
 * A column's width in Excel's character units, as pixels. Excel's own files count in its 7 pixel
 * digit. Google's export writes (pixels + 1) / digit, with a digit that follows the spreadsheet's
 * default font size (7 at 10 points, 8 at 11): `digit` is the one this file was written with.
 */
function colPixels(width: number, origin: Workbook["origin"], digit: number): number {
  if (origin === "google") return Math.max(2, Math.round(width * digit - 1));
  return Math.max(2, Math.floor(((256 * width + Math.floor(128 / 7)) / 256) * 7));
}
const rowPixels = (points: number): number => Math.max(2, Math.round((points * 4) / 3));

function pushRun(runs: SizeRun[], index: number, px: number) {
  const last = runs[runs.length - 1];
  if (last && last[1] === index - 1 && last[2] === px) last[1] = index;
  else runs.push([index, index, px]);
}
function pushSpan(spans: [number, number][], index: number) {
  const last = spans[spans.length - 1];
  if (last && last[1] === index - 1) last[1] = index;
  else spans.push([index, index]);
}

async function readSheet(ctx: ReadContext, part: string, name: string, id: number, index: number): Promise<Sheet> {
  const xml = await ctx.zip.text(part);
  if (xml == null) fail("damaged");
  const ws = child(parseXml(xml!), "worksheet");
  if (!ws) {
    // A chart sheet or a macro sheet: nothing to type
    ctx.warnings.add(`"${name}" isn't a worksheet (a chart or macro sheet): it is left out.`);
    return { id, name, rowCount: 1000, colCount: 26, defaultRowPx: 21, defaultColPx: 100, rowPx: [], colPx: [], merges: [], cells: [] };
  }
  const { origin, book, palette } = ctx;
  const google = origin === "google";
  const rels = await readRels(ctx.zip, part);

  const fmt = child(ws, "sheetFormatPr");
  const defaultRowPt = Number(fmt?.attrs.defaultRowHeight);
  const defaultColW = Number(fmt?.attrs.defaultColWidth);
  const baseColW = Number(fmt?.attrs.baseColWidth ?? 8);
  // A Google Sheet's rows are 21 pixels and its export gives each row its height; Excel's default is the file's
  const defaultRowPx = google ? 21 : Number.isFinite(defaultRowPt) && defaultRowPt > 0 ? rowPixels(defaultRowPt) : 20;
  // A Google Sheet's columns are 100 pixels until resized, so its default width says which digit it counts in
  const fromDefault = google && Number.isFinite(defaultColW) && defaultColW > 0 ? Math.round(101 / defaultColW) : 0;
  const digit = fromDefault >= 4 && fromDefault <= 20 ? fromDefault : Math.max(4, Math.round(book.defaultFont.size * 0.7));
  const defaultColPx = google ? 100
    : Number.isFinite(defaultColW) && defaultColW > 0 ? colPixels(defaultColW, origin, digit)
    : Math.ceil(((Number.isFinite(baseColW) ? baseColW : 8) * 7 + 5) / 8) * 8;

  const sheet: Sheet = { id, name, rowCount: 1000, colCount: 26, defaultRowPx, defaultColPx, rowPx: [], colPx: [], merges: [], cells: [] };

  const view = child(child(ws, "sheetViews"), "sheetView");
  if (view && !flag(view.attrs.showGridLines, true)) sheet.hideGridlines = true;
  if (view && flag(view.attrs.rightToLeft)) sheet.rtl = true;
  const pane = child(view, "pane");
  if (pane && /^frozen/.test(pane.attrs.state ?? "")) {
    const x = Math.round(Number(pane.attrs.xSplit ?? 0));
    const y = Math.round(Number(pane.attrs.ySplit ?? 0));
    if (x > 0) sheet.frozenCols = x;
    if (y > 0) sheet.frozenRows = y;
  }
  const tab = palette.resolve(child(child(ws, "sheetPr"), "tabColor"));
  if (tab) sheet.tabColor = tab;

  let maxColDeclared = 0;
  /** Outline levels of rows and columns (groups), and which of them are hidden */
  const levels = { r: new Map<number, number>(), c: new Map<number, number>() };
  const hiddenCols: [number, number][] = [];
  const colStyles: [number, number, number][] = [];
  for (const col of children(child(ws, "cols"), "col")) {
    const min = Number(col.attrs.min) - 1;
    const max = Number(col.attrs.max) - 1;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) continue;
    // (a width given for "every column to the end of the sheet" is the default by another name)
    const toEnd = max >= 16383 || max - min > 1000;
    const width = Number(col.attrs.width);
    if (Number.isFinite(width) && width >= 0 && !toEnd) {
      const px = colPixels(width, origin, digit);
      if (px !== defaultColPx) sheet.colPx.push([min, max, px]);
      maxColDeclared = Math.max(maxColDeclared, max + 1);
    }
    if (flag(col.attrs.hidden) && !toEnd) hiddenCols.push([min, max]);
    const colLevel = Number(col.attrs.outlineLevel ?? 0);
    if (colLevel > 0 && !toEnd) for (let i = min; i <= max; i++) levels.c.set(i, colLevel);
    const style = book.xf[Number(col.attrs.style ?? 0)] ?? 0;
    if (style && !toEnd) colStyles.push([min, max, style]);
  }
  if (hiddenCols.length) sheet.hiddenCols = hiddenCols;
  if (colStyles.length) sheet.colStyles = colStyles;

  // Array formulas fill a range from their first cell: the other cells show values they don't hold
  const spills: { rect: Rect; anchor: number }[] = [];
  const sharedFormulas = new Map<string, { f: string; r: number; c: number }>();
  const hiddenRows: [number, number][] = [];
  const rowStyles: [number, number, number][] = [];
  let maxRow = -1, maxCol = -1, maxRowDeclared = 0;
  let nextRow = 0;
  for (const row of children(child(ws, "sheetData"), "row")) {
    const r = row.attrs.r != null ? Number(row.attrs.r) - 1 : nextRow;
    if (!Number.isFinite(r) || r < 0) continue;
    nextRow = r + 1;
    maxRowDeclared = Math.max(maxRowDeclared, r + 1);
    const ht = Number(row.attrs.ht);
    if (Number.isFinite(ht) && ht > 0) {
      const px = rowPixels(ht);
      if (px !== defaultRowPx) pushRun(sheet.rowPx, r, px);
    }
    if (flag(row.attrs.hidden)) pushSpan(hiddenRows, r);
    const rowLevel = Number(row.attrs.outlineLevel ?? 0);
    if (rowLevel > 0) levels.r.set(r, rowLevel);
    if (flag(row.attrs.customFormat)) {
      const style = book.xf[Number(row.attrs.s ?? 0)] ?? 0;
      if (style) { const last = rowStyles[rowStyles.length - 1]; if (last && last[1] === r - 1 && last[2] === style) last[1] = r; else rowStyles.push([r, r, style]); }
    }
    let nextCol = 0;
    for (const c of row.children) {
      if (c.tag !== "c") continue;
      const pos = c.attrs.r ? parseCellName(c.attrs.r) : null;
      const col = pos ? pos[1] : nextCol;
      nextCol = col + 1;
      const cell: Cell = { r, c: col };
      const style = book.xf[Number(c.attrs.s ?? 0)] ?? 0;
      if (style) cell.s = style;

      const t = c.attrs.t ?? "n";
      const vNode = child(c, "v");
      const raw = vNode?.text ?? "";
      const fNode = child(c, "f");
      let rich: RichText | null = null;
      if (t === "s") rich = ctx.shared[Number(raw)] ?? { text: "" };
      else if (t === "inlineStr") rich = readRich(child(c, "is"), palette);
      if (rich) { if (rich.text !== "") { cell.v = rich.text; if (rich.runs) cell.runs = rich.runs; } }
      else if (t === "b") { if (raw !== "") cell.v = raw === "1" || raw.toLowerCase() === "true"; }
      else if (t === "e") { if (raw) cell.e = raw; }
      else if (t === "str" || t === "d") { if (raw !== "") cell.v = raw; }
      else if (raw !== "") { const n = Number(raw); if (Number.isFinite(n)) cell.v = n; else cell.v = raw; }

      if (fNode) {
        const ft = fNode.attrs.t;
        let formula: string | null = null;
        if (ft === "shared" && fNode.attrs.si != null) {
          if (fNode.text) { sharedFormulas.set(fNode.attrs.si, { f: fNode.text, r, c: col }); formula = fNode.text; }
          else { const m = sharedFormulas.get(fNode.attrs.si); if (m) formula = shiftFormula(m.f, r - m.r, col - m.c); }
        } else if (ft === "array" && fNode.text) {
          const rect = parseRange(fNode.attrs.ref ?? "") ?? [r, col, r, col];
          // What Google's import writes for an array formula: constrained to the cells it filled in Excel
          formula = `ARRAY_CONSTRAIN(ARRAYFORMULA(${toSheetsFormula(fNode.text)}), ${rect[2] - rect[0] + 1}, ${rect[3] - rect[1] + 1})`;
          if (rect[2] > rect[0] || rect[3] > rect[1]) spills.push({ rect, anchor: r * 16384 + col });
        } else if (ft === "dataTable") {
          ctx.warnings.add("A what-if data table is copied as the values it showed, not as a data table.");
        } else if (fNode.text) formula = fNode.text;
        if (formula != null && formula !== "") {
          cell.f = ft === "array" ? formula : toSheetsFormula(formula);
          // A formula's text result isn't rich text
          delete cell.runs;
        }
      }
      if (ctx.date1904 && typeof cell.v === "number" && cell.s) {
        const kind = book.styles[cell.s].numFmt ? numberFormatType(book.styles[cell.s].numFmt!) : "NUMBER";
        if (kind === "DATE" || kind === "DATE_TIME") cell.v += 1462;
      }
      if (cell.s == null && !hasContent(cell)) continue;
      if (--ctx.budget.cells < 0) fail("tooLarge");
      sheet.cells.push(cell);
      if (hasContent(cell) || cell.s) { maxRow = Math.max(maxRow, r); maxCol = Math.max(maxCol, col); }
    }
  }
  if (hiddenRows.length) sheet.hiddenRows = hiddenRows;
  if (rowStyles.length) sheet.rowStyles = rowStyles;
  sheet.cells.sort((a, b) => a.r - b.r || a.c - b.c);

  // Cells an array formula fills: shown with the formula's cell, never typed
  if (spills.length) {
    for (const cell of sheet.cells) {
      const key = cell.r * 16384 + cell.c;
      const s = spills.find((x) => x.anchor !== key && cell.r >= x.rect[0] && cell.r <= x.rect[2] && cell.c >= x.rect[1] && cell.c <= x.rect[3]);
      if (s && cell.f == null) cell.spill = [Math.floor(s.anchor / 16384), s.anchor % 16384];
    }
  }

  for (const m of children(child(ws, "mergeCells"), "mergeCell")) {
    const rect = parseRange(m.attrs.ref ?? "");
    if (rect && (rect[2] > rect[0] || rect[3] > rect[1])) { sheet.merges.push(rect); maxRow = Math.max(maxRow, rect[2]); maxCol = Math.max(maxCol, rect[3]); }
  }

  // Links: a cell's own, to the web or to a place in the workbook
  const at = new Map<number, Cell>();
  for (const cell of sheet.cells) at.set(cell.r * 16384 + cell.c, cell);
  for (const h of children(child(ws, "hyperlinks"), "hyperlink")) {
    const rect = parseRange(h.attrs.ref ?? "");
    if (!rect) continue;
    const rel = h.attrs["r:id"] ? rels.get(h.attrs["r:id"]) : undefined;
    let link = rel?.external ? rel.target : undefined;
    if (link && h.attrs.location) link += "#" + h.attrs.location;
    if (!link && h.attrs.location) link = "#" + h.attrs.location;
    if (!link) continue;
    for (let r = rect[0]; r <= Math.min(rect[2], rect[0] + 2000); r++) for (let c = rect[1]; c <= Math.min(rect[3], rect[1] + 200); c++) {
      const cell = at.get(r * 16384 + c);
      if (cell && typeof cell.v === "string" && cell.f == null) cell.link = link;
    }
  }

  // Notes (Excel's comments)
  for (const rel of rels.values()) {
    if (rel.type !== "comments" || rel.external) continue;
    const cx = await ctx.zip.text(rel.target);
    if (!cx) continue;
    for (const cm of children(find(parseXml(cx), "commentList"), "comment")) {
      const pos = parseCellName(cm.attrs.ref ?? "");
      if (!pos) continue;
      const text = readRich(child(cm, "text"), palette).text;
      if (!text) continue;
      let cell = at.get(pos[0] * 16384 + pos[1]);
      if (!cell) { cell = { r: pos[0], c: pos[1] }; sheet.cells.push(cell); at.set(pos[0] * 16384 + pos[1], cell); }
      cell.note = text.slice(0, 4000);
    }
  }
  sheet.cells.sort((a, b) => a.r - b.r || a.c - b.c);

  // What cells may hold: dropdowns, and rules on numbers, dates, text length or a formula
  const validations: Validation[] = [];
  let otherValidation = false;
  for (const dv of children(child(ws, "dataValidations"), "dataValidation")) {
    const f1 = (child(dv, "formula1")?.text ?? "").trim();
    const f2 = (child(dv, "formula2")?.text ?? "").trim();
    const type = dv.attrs.type ?? "";
    const op = dv.attrs.operator ?? "between";
    // Excel refuses a bad value unless told to only warn; the hint is its input message
    const extras = {
      ...(flag(dv.attrs.showErrorMessage, false) && (dv.attrs.errorStyle ?? "stop") === "stop" ? { strict: true } : {}),
      ...(flag(dv.attrs.showInputMessage) && dv.attrs.prompt ? { help: dv.attrs.prompt.slice(0, 500) } : {}),
    };
    for (const rect of sqrefRects(dv.attrs.sqref)) {
      if (type === "list" && f1) {
        if (/^"(?:[^"]|"")*"$/.test(f1)) validations.push({ rect, values: f1.slice(1, -1).replace(/""/g, '"').split(",").map((v) => v.trim()).filter(Boolean).slice(0, 500), ...extras });
        else validations.push({ rect, source: "=" + toSheetsFormula(f1), ...extras });
        continue;
      }
      // Rules are written about the range's first cell, as Sheets' custom formulas are
      const me = cellName(rect[0], rect[1]);
      const subject = type === "textLength" ? `LEN(${me})` : me;
      const a = f1 ? toSheetsFormula(f1) : "", b = f2 ? toSheetsFormula(f2) : "";
      const compare: Record<string, string> = {
        between: `AND(${subject}>=${a},${subject}<=${b})`, notBetween: `OR(${subject}<${a},${subject}>${b})`,
        equal: `${subject}=${a}`, notEqual: `${subject}<>${a}`, greaterThan: `${subject}>${a}`, lessThan: `${subject}<${a}`,
        greaterThanOrEqual: `${subject}>=${a}`, lessThanOrEqual: `${subject}<=${a}`,
      };
      const numeric = /^-?\d+(\.\d+)?$/;
      if ((type === "whole" || type === "decimal") && CF_OPERATORS[op] && numeric.test(f1) && (!/etween/.test(op) || numeric.test(f2))) {
        validations.push({ rect, rule: { type: CF_OPERATORS[op], values: /etween/.test(op) ? [f1, f2] : [f1] }, ...extras });
      } else if (type === "custom" && a) {
        validations.push({ rect, rule: { type: "CUSTOM_FORMULA", values: ["=" + a] }, ...extras });
      } else if (["whole", "decimal", "date", "time", "textLength"].includes(type) && a && compare[op] && (!/etween/.test(op) || b)) {
        const whole = type === "whole" ? `,${me}=INT(${me})` : "";
        const number = type === "textLength" ? "" : `ISNUMBER(${me}),`;
        validations.push({ rect, rule: { type: "CUSTOM_FORMULA", values: [`=AND(${number}${compare[op]}${whole})`] }, ...extras });
      } else otherValidation = true;
    }
  }
  if (validations.length) sheet.validations = validations;
  if (otherValidation) ctx.warnings.add("A data validation rule that couldn't be read isn't copied.");

  // Conditional formatting
  const conditional: ConditionalRule[] = [];
  let otherRule = false;
  let noSheetsKind = false;
  for (const cf of children(ws, "conditionalFormatting")) {
    const ranges = sqrefRects(cf.attrs.sqref);
    if (!ranges.length) continue;
    const rules = children(cf, "cfRule").sort((a, b) => Number(a.attrs.priority ?? 0) - Number(b.attrs.priority ?? 0));
    for (const rule of rules) {
      const type = rule.attrs.type;
      const formulas = children(rule, "formula").map((f) => f.text);
      const format = rule.attrs.dxfId != null ? book.dxfs[Number(rule.attrs.dxfId)] : undefined;
      if (type === "colorScale") {
        const cs = child(rule, "colorScale");
        const points = children(cs, "cfvo");
        const colors = children(cs, "color").map((c) => palette.resolve(c));
        const kinds: Record<string, NonNullable<ConditionalRule["scale"]>[number]["type"]> = { min: "MIN", max: "MAX", num: "NUMBER", percent: "PERCENT", percentile: "PERCENTILE" };
        const scale = points.map((p, i) => ({ type: kinds[p.attrs.type ?? ""], ...(p.attrs.val != null && p.attrs.type !== "min" && p.attrs.type !== "max" ? { value: p.attrs.val } : {}), color: colors[i] ?? "#ffffff" }));
        if ((scale.length === 2 || scale.length === 3) && scale.every((p) => p.type)) conditional.push({ ranges, scale });
        else otherRule = true;
        continue;
      }
      let when: ConditionalRule["when"];
      if (type === "cellIs" && CF_OPERATORS[rule.attrs.operator ?? ""] && formulas.length) {
        const values = formulas.map(conditionValue);
        const text = /^"/.test(formulas[0].trim());
        const op = rule.attrs.operator;
        when = text && (op === "equal" || op === "notEqual") ? { type: op === "equal" ? "TEXT_EQ" : "TEXT_NOT_CONTAINS", values } : { type: CF_OPERATORS[op!], values };
      } else if (type === "expression" && formulas[0]) when = { type: "CUSTOM_FORMULA", values: ["=" + toSheetsFormula(formulas[0])] };
      else if (type === "containsText" && rule.attrs.text) when = { type: "TEXT_CONTAINS", values: [rule.attrs.text] };
      else if (type === "notContainsText" && rule.attrs.text) when = { type: "TEXT_NOT_CONTAINS", values: [rule.attrs.text] };
      else if (type === "beginsWith" && rule.attrs.text) when = { type: "TEXT_STARTS_WITH", values: [rule.attrs.text] };
      else if (type === "endsWith" && rule.attrs.text) when = { type: "TEXT_ENDS_WITH", values: [rule.attrs.text] };
      else if (type === "containsBlanks") when = { type: "BLANK", values: [] };
      else if (type === "notContainsBlanks") when = { type: "NOT_BLANK", values: [] };
      else {
        // Rules Sheets has no kind for, written as the formula that says the same about the range's first cell
        const me = cellName(ranges[0][0], ranges[0][1]);
        const all = rectName(ranges[0]).replace(/([A-Z]+)(\d+)/g, "$$$1$$$2");
        const n = Number(rule.attrs.rank ?? 10);
        let f: string | null = null;
        if (type === "top10") {
          const count = flag(rule.attrs.percent) ? `MAX(1,ROUNDDOWN(COUNT(${all})*${n}/100,0))` : String(n);
          f = flag(rule.attrs.bottom) ? `AND(ISNUMBER(${me}),RANK(${me},${all},1)<=${count})` : `AND(ISNUMBER(${me}),RANK(${me},${all})<=${count})`;
        } else if (type === "aboveAverage") {
          const above = flag(rule.attrs.aboveAverage, true);
          const dev = Number(rule.attrs.stdDev ?? 0);
          const bar = dev ? `AVERAGE(${all})${above ? "+" : "-"}${dev}*STDEVP(${all})` : `AVERAGE(${all})`;
          f = `AND(ISNUMBER(${me}),${me}${above ? ">" : "<"}${flag(rule.attrs.equalAverage) ? "=" : ""}${bar})`;
        } else if (type === "duplicateValues") f = `AND(${me}<>"",COUNTIF(${all},${me})>1)`;
        else if (type === "uniqueValues") f = `AND(${me}<>"",COUNTIF(${all},${me})=1)`;
        else if (type === "containsErrors") f = `ISERROR(${me})`;
        else if (type === "notContainsErrors") f = `NOT(ISERROR(${me}))`;
        else if (type === "timePeriod") {
          const day = `INT(${me})`;
          const periods: Record<string, string> = {
            today: `${day}=TODAY()`, yesterday: `${day}=TODAY()-1`, tomorrow: `${day}=TODAY()+1`, last7Days: `AND(${day}>TODAY()-7,${day}<=TODAY())`,
            thisWeek: `AND(${day}>=TODAY()-WEEKDAY(TODAY())+1,${day}<=TODAY()-WEEKDAY(TODAY())+7)`, lastWeek: `AND(${day}>=TODAY()-WEEKDAY(TODAY())-6,${day}<=TODAY()-WEEKDAY(TODAY()))`,
            nextWeek: `AND(${day}>=TODAY()-WEEKDAY(TODAY())+8,${day}<=TODAY()-WEEKDAY(TODAY())+14)`,
            thisMonth: `AND(MONTH(${me})=MONTH(TODAY()),YEAR(${me})=YEAR(TODAY()))`, lastMonth: `AND(MONTH(${me})=MONTH(EDATE(TODAY(),-1)),YEAR(${me})=YEAR(EDATE(TODAY(),-1)))`,
            nextMonth: `AND(MONTH(${me})=MONTH(EDATE(TODAY(),1)),YEAR(${me})=YEAR(EDATE(TODAY(),1)))`,
          };
          f = periods[rule.attrs.timePeriod ?? ""] ? `AND(ISNUMBER(${me}),${periods[rule.attrs.timePeriod!]})` : null;
        }
        if (f) when = { type: "CUSTOM_FORMULA", values: ["=" + f] };
        else if (type === "dataBar" || type === "iconSet") noSheetsKind = true;
      }
      if (when && format && Object.keys(format).length) conditional.push({ ranges, when, format });
      else if (type !== "dataBar" && type !== "iconSet") otherRule = true;
    }
  }
  if (conditional.length) sheet.conditional = conditional;
  if (noSheetsKind) ctx.warnings.add("Data bars and icon sets aren't copied: Google Sheets has neither.");
  if (otherRule) ctx.warnings.add("A conditional formatting rule that couldn't be read isn't copied.");

  // Tables: their columns, for the formulas that name them, and their filter buttons
  let tableFilter: Rect | null = null;
  let tableCount = 0;
  for (const rel of rels.values()) {
    if (rel.type === "drawing" && !rel.external) {
      ctx.drawings.push({ sheet: index, part: rel.target });
      const dx = await ctx.zip.text(rel.target);
      if (dx && /<(xdr:)?(pic|sp|cxnSp)[\s>]/.test(dx)) ctx.warnings.add("Images and shapes aren't copied: Google Sheets has no way to place them from outside. The cells, formulas, formatting and charts are.");
    }
    if (rel.type === "pivotTable") ctx.warnings.add("Pivot tables are copied as the values they showed.");
    if (rel.type !== "table" || rel.external) continue;
    const tx = await ctx.zip.text(rel.target);
    const table = tx ? child(parseXml(tx), "table") : undefined;
    const ref = parseRange(table?.attrs.ref ?? "");
    if (!table || !ref) continue;
    tableCount++;
    const headerRows = Number(table.attrs.headerRowCount ?? 1) ? 1 : 0;
    const totalsRows = Number(table.attrs.totalsRowCount ?? 0) ? 1 : 0;
    const columns = children(child(table, "tableColumns"), "tableColumn").map((c) => c.attrs.name ?? "");
    for (const tableName of new Set([table.attrs.displayName, table.attrs.name].filter((x): x is string => !!x))) ctx.tables.push({ name: tableName, sheet: name, rect: ref, headerRows, totalsRows, columns });
    if (child(table, "autoFilter") && headerRows) tableFilter = [ref[0], ref[1], ref[2] - totalsRows, ref[3]];
    if (child(table, "tableStyleInfo")?.attrs.name) ctx.warnings.add("A table's own colour banding isn't copied: its cells, formulas and filter buttons are.");
  }
  // Sheets has one filter a sheet: the sheet's own, or its only table's
  const filter = parseRange(child(ws, "autoFilter")?.attrs.ref ?? "") ?? (tableCount === 1 ? tableFilter : null);
  if (filter) sheet.filter = filter;
  else if (tableCount > 1 && tableFilter) ctx.warnings.add("Only one range a sheet can have filter buttons in Google Sheets: the tables' filter buttons aren't copied.");

  // Groups: rows or columns at an outline level, each run a group; one whose rows are all hidden is folded
  const groups: DimensionGroup[] = [];
  const hiddenIn = (spans: [number, number][], i: number) => spans.some(([a, b]) => i >= a && i <= b);
  for (const d of ["r", "c"] as const) {
    const at = levels[d];
    const spans = d === "r" ? hiddenRows : hiddenCols;
    const deepest = Math.min(8, Math.max(0, ...at.values()));
    for (let depth = 1; depth <= deepest; depth++) {
      const members = Array.from(at.entries()).filter(([, level]) => level >= depth).map(([i]) => i).sort((x, y) => x - y);
      let from = -1, prev = -2;
      const close = (to: number) => {
        if (from < 0) return;
        let folded = true;
        for (let i = from; i <= to; i++) if (!hiddenIn(spans, i)) { folded = false; break; }
        groups.push({ d, from, to, depth, ...(folded ? { collapsed: true as const } : {}) });
      };
      for (const i of members) { if (i !== prev + 1) { close(prev); from = i; } prev = i; }
      close(prev);
    }
  }
  if (groups.length) {
    sheet.groups = groups;
    // A folded group hides its own rows: they aren't hidden a second time
    const folded = (d: "r" | "c", i: number) => groups.some((g) => g.d === d && g.collapsed && i >= g.from && i <= g.to);
    const keep = (d: "r" | "c", spans: [number, number][]) => {
      const out: [number, number][] = [];
      for (const [a, b] of spans) for (let i = a; i <= b; i++) if (!folded(d, i)) pushSpan(out, i);
      return out;
    };
    const rowsLeft = keep("r", hiddenRows), colsLeft = keep("c", hiddenCols);
    if (rowsLeft.length) sheet.hiddenRows = rowsLeft; else delete sheet.hiddenRows;
    if (colsLeft.length) sheet.hiddenCols = colsLeft; else delete sheet.hiddenCols;
  }

  sheet.rowCount = Math.max(1000, maxRow + 1, google ? maxRowDeclared : 0);
  sheet.colCount = Math.max(26, maxCol + 1, google ? maxColDeclared : 0);
  // Sizes past the grid's edge have nothing to size
  sheet.colPx = sheet.colPx.filter((run) => run[0] < sheet.colCount).map((run) => [run[0], Math.min(run[1], sheet.colCount - 1), run[2]] as SizeRun);
  return sheet;
}

/** Whether the bytes start like an .xls file (the old binary format) */
const isOldExcel = (b: Uint8Array) => b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

/** The workbook in an .xlsx (or .xlsm) file. Throws XlsxError with words for the person when it can't be read */
export async function readXlsx(bytes: Uint8Array, fileName = "Workbook.xlsx"): Promise<Workbook> {
  if (bytes.length > MAX_XLSX_BYTES) fail("tooLarge");
  // (an .xlsx with a password is an old-style container too, around an encrypted package)
  if (isOldExcel(bytes)) fail(/\.xls$/i.test(fileName) ? "oldExcel" : "encrypted");
  let zip: Zip;
  try { zip = new Zip(bytes); } catch { return fail("notXlsx"); }
  try {
    const rootRels = await readRels(zip, "");
    const wbPart = Array.from(rootRels.values()).find((r) => r.type === "officeDocument")?.target ?? "xl/workbook.xml";
    const wbXml = await zip.text(wbPart);
    if (!wbXml) return fail(zip.has("EncryptedPackage") ? "encrypted" : "notXlsx");
    const wb = child(parseXml(wbXml), "workbook");
    if (!wb) return fail("notXlsx");
    const rels = await readRels(zip, wbPart);
    const byType = (type: string) => Array.from(rels.values()).find((r) => r.type === type)?.target;

    const app = await zip.text("docProps/app.xml");
    const origin: Workbook["origin"] = app && /Microsoft Excel/i.test(app) ? "excel" : !app && /office\/mac\/excel\/2008\/main/.test(wbXml) ? "google" : "other";

    const themeHex = readTheme(await zip.text(byType("theme") ?? "xl/theme/theme1.xml"));
    const palette = new Palette(themeHex);
    const book = readStyles(await zip.text(byType("styles") ?? "xl/styles.xml"), palette);
    const sharedXml = await zip.text(byType("sharedStrings") ?? "xl/sharedStrings.xml");
    const shared = sharedXml ? children(child(parseXml(sharedXml), "sst"), "si").map((si) => readRich(si, palette)) : [];

    const warnings = new Set<string>();
    const date1904 = flag(child(wb, "workbookPr")?.attrs.date1904);
    const ctx: ReadContext = { zip, palette, book, shared, origin, warnings, budget: { cells: MAX_CELLS }, tables: [], drawings: [], date1904 };
    const sheetNodes = children(child(wb, "sheets"), "sheet");
    if (!sheetNodes.length) return fail("empty");
    if (sheetNodes.length > MAX_SHEETS) return fail("tooLarge");
    const sheets: Sheet[] = [];
    for (const node of sheetNodes) {
      const rel = rels.get(node.attrs["r:id"] ?? "");
      if (!rel) continue;
      // The new Google Sheet's first tab is the one it is made with (id 0); the rest are added
      const sheet = await readSheet(ctx, rel.target, (node.attrs.name ?? `Sheet${sheets.length + 1}`).slice(0, 100), sheets.length === 0 ? 0 : 1000 + sheets.length, sheets.length);
      if (node.attrs.state === "hidden" || node.attrs.state === "veryHidden") sheet.hidden = true;
      sheets.push(sheet);
    }
    if (!sheets.length || !sheets.some((s) => s.cells.length)) return fail("empty");
    // Google Sheets always shows one tab
    if (sheets.every((s) => s.hidden)) delete sheets[0].hidden;

    // General inside a longer format: digits as needed, and no stray decimal point when every value is whole
    if (book.general.size) {
      const whole = new Map<number, boolean>();
      for (const sheet of sheets) for (const cell of sheet.cells) {
        if (cell.s && book.general.has(cell.s) && typeof cell.v === "number") whole.set(cell.s, (whole.get(cell.s) ?? true) && Number.isInteger(cell.v));
      }
      for (const [idx, raw] of book.general) if (whole.get(idx)) book.styles[idx].numFmt = sheetsNumberFormat(raw, "0");
    }
    // Formulas that name a table's columns read cell ranges in Sheets
    if (ctx.tables.length) {
      for (const sheet of sheets) for (const cell of sheet.cells) {
        if (cell.f != null && cell.f.includes("[")) cell.f = resolveTableRefs(cell.f, ctx.tables, sheet.name, cell.r, cell.c);
      }
    }
    // Charts, now that the sheets their ranges name are all known
    const sheetIndex = new Map(sheets.map((s, i) => [s.name.toLowerCase(), i]));
    for (const d of ctx.drawings) {
      const sheet = sheets[d.sheet];
      if (!sheet) continue;
      const charts = await readCharts({ zip, sheetIndex, color: (node) => palette.resolve(node), warnings }, d.part, sheet);
      if (charts.length) sheet.charts = [...(sheet.charts ?? []), ...charts].slice(0, 50);
    }
    if (date1904) warnings.add("This workbook counts dates from 1904 (an old Mac setting): its dates are shifted to the usual calendar.");

    const names: NamedRange[] = [];
    for (const dn of children(child(wb, "definedNames"), "definedName")) {
      const name = dn.attrs.name ?? "";
      // Excel's own names (print areas, filters) aren't ranges someone named
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) || /^_xlnm\./.test(name) || flag(dn.attrs.hidden)) continue;
      const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/.exec(dn.text.trim());
      if (!m) continue;
      const sheetName = (m[1] ?? m[2]).replace(/''/g, "'");
      const sheet = sheets.findIndex((s) => s.name === sheetName);
      const rect = parseRange(m[3].replace(/\$/g, ""));
      if (sheet >= 0 && rect) names.push({ name, sheet, rect });
    }

    if (zip.names().some((n) => /vbaProject\.bin$/i.test(n))) warnings.add("Macros aren't copied.");
    const slots: [ThemeSlot, number][] = [["BACKGROUND", 0], ["TEXT", 1], ["ACCENT1", 4], ["ACCENT2", 5], ["ACCENT3", 6], ["ACCENT4", 7], ["ACCENT5", 8], ["ACCENT6", 9], ["LINK", 10]];
    const theme: Workbook["theme"] = {};
    for (const [slot, i] of slots) theme[slot] = "#" + themeHex[i];
    const name = fileName.replace(/\.(xlsx|xlsm|xltx)$/i, "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) || "Untitled spreadsheet";
    return { name, origin, defaultFont: book.defaultFont, theme, styles: book.styles, sheets, ...(names.length ? { names } : {}), warnings: Array.from(warnings) };
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    if (err instanceof ZipError) return fail("damaged");
    throw err;
  }
}
