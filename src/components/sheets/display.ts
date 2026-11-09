/**
 * What a cell shows: its value through its number format, the way Google Sheets writes it, and
 * where it sits (numbers to the right, text to the left, unless the cell says otherwise).
 */

import { format as formatNumber, formatColor } from "numfmt";
import type { Cell, CellStyle, Workbook } from "@/lib/sheets/model";
import { numberFormatType } from "@/lib/sheets/steps";
import { fontStack } from "@/lib/rich-text";

export interface Shown {
  text: string;
  /** Where the value sits when the cell doesn't say */
  align: "left" | "right" | "center";
  /** A colour the number format gives ([Red]) */
  color?: string;
  /** Whether the text may run over empty neighbours (text does; numbers don't) */
  overflows: boolean;
}

const FORMAT_COLORS: Record<string, string> = { black: "#000000", blue: "#0000ff", cyan: "#00ffff", green: "#00ff00", magenta: "#ff00ff", red: "#ff0000", white: "#ffffff", yellow: "#ffff00" };

/** A number with no format, as Sheets shows it: up to fifteen digits, no grouping */
export function generalNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) return formatNumber("0.00E+00", n);
  const rounded = Number(n.toPrecision(15));
  const s = String(rounded);
  if (!/e/i.test(s)) return s;
  return rounded.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

export function shownValue(cell: Cell, style: CellStyle | undefined): Shown {
  if (cell.e != null) return { text: cell.e, align: "center", overflows: false };
  const v = cell.v;
  if (v == null || v === "") return { text: "", align: "left", overflows: false };
  if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE", align: "center", overflows: false };
  const pattern = style?.numFmt;
  if (typeof v === "string") {
    if (pattern && pattern.includes("@") && pattern.trim() !== "@") {
      try { return { text: formatNumber(pattern, v), align: "left", overflows: true }; } catch { /* shown as it is */ }
    }
    return { text: v, align: "left", overflows: true };
  }
  if (!pattern) return { text: generalNumber(v), align: "right", overflows: false };
  if (numberFormatType(pattern) === "TEXT") return { text: generalNumber(v), align: "left", overflows: true };
  try {
    const text = formatNumber(pattern, v, { locale: "en-US", nbsp: false });
    const color = formatColor(pattern, v);
    return { text, align: "right", overflows: false, ...(typeof color === "string" && FORMAT_COLORS[color.toLowerCase()] ? { color: FORMAT_COLORS[color.toLowerCase()] } : {}) };
  } catch {
    return { text: generalNumber(v), align: "right", overflows: false };
  }
}

/** A model colour as CSS: a theme slot is the workbook's colour for it */
export function cssColor(wb: Workbook, color: string | undefined): string | undefined {
  if (!color) return undefined;
  if (!color.startsWith("theme:")) return color;
  const slot = color.slice(6) as keyof NonNullable<Workbook["theme"]>;
  return wb.theme?.[slot] ?? (slot === "BACKGROUND" ? "#ffffff" : "#000000");
}

/** The fonts a workbook's cells are drawn in, for loading them: family → "italic,weight" variants */
export function workbookFonts(wb: Workbook): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (family: string | undefined, bold?: boolean, italic?: boolean) => {
    if (!family) return;
    const set = out.get(family) ?? new Set<string>();
    set.add(`${italic ? 1 : 0},${bold ? 700 : 400}`);
    out.set(family, set);
  };
  add(wb.defaultFont.family);
  for (const s of wb.styles) add(s.font?.family ?? wb.defaultFont.family, s.font?.bold, s.font?.italic);
  for (const sheet of wb.sheets) for (const cell of sheet.cells) for (const run of cell.runs ?? []) add(run.font.family, run.font.bold, run.font.italic);
  return out;
}

export const cssFont = (family: string): string => fontStack(family);
