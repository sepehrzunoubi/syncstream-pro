/**
 * Conditional formatting as the page shows it: which cells each rule paints, worked out from the
 * values the workbook was saved with. Rules on numbers, text, blanks, colour scales, and the
 * top/bottom, average, duplicate and error rules the reader writes as formulas are all drawn;
 * a rule that is someone's own formula isn't (the page has no formula engine), and Google Sheets
 * applies it once the sheet is built.
 */

import type { Cell, Color, ConditionalRule, Rect, Sheet } from "./model";

export interface ConditionalLook { fill?: Color; color?: Color; bold?: true; italic?: true; underline?: true; strike?: true }

const number = (cell: Cell): number | null => (typeof cell.v === "number" && cell.e == null ? cell.v : null);
const text = (cell: Cell): string => (cell.e != null ? cell.e : cell.v == null ? "" : typeof cell.v === "boolean" ? (cell.v ? "TRUE" : "FALSE") : String(cell.v));
const isBlank = (cell: Cell): boolean => cell.e == null && (cell.v == null || cell.v === "");

/** The reader's own formulas for rules Sheets has no kind for (see xlsx.ts), read back as what they test */
type Stat =
  | { kind: "rank"; bottom: boolean; n: number; percent: boolean }
  | { kind: "average"; above: boolean; orEqual: boolean; dev: number }
  | { kind: "count"; unique: boolean }
  | { kind: "error"; not: boolean };

function statOf(formula: string): Stat | null {
  let m = /^=AND\(ISNUMBER\([A-Z]+\d+\),RANK\([A-Z]+\d+,[$A-Z\d:]+(,1)?\)<=(?:(\d+)|MAX\(1,ROUNDDOWN\(COUNT\([$A-Z\d:]+\)\*(\d+)\/100,0\)\))\)$/.exec(formula);
  if (m) return { kind: "rank", bottom: !!m[1], n: Number(m[2] ?? m[3]), percent: m[3] != null };
  m = /^=AND\(ISNUMBER\([A-Z]+\d+\),[A-Z]+\d+([<>])(=?)AVERAGE\([$A-Z\d:]+\)(?:[+-](\d+(?:\.\d+)?)\*STDEVP\([$A-Z\d:]+\))?\)$/.exec(formula);
  if (m) return { kind: "average", above: m[1] === ">", orEqual: m[2] === "=", dev: Number(m[3] ?? 0) };
  m = /^=AND\([A-Z]+\d+<>"",COUNTIF\([$A-Z\d:]+,[A-Z]+\d+\)(>1|=1)\)$/.exec(formula);
  if (m) return { kind: "count", unique: m[1] === "=1" };
  if (/^=ISERROR\([A-Z]+\d+\)$/.test(formula)) return { kind: "error", not: false };
  if (/^=NOT\(ISERROR\([A-Z]+\d+\)\)$/.test(formula)) return { kind: "error", not: true };
  return null;
}

const hex = (c: Color, theme: Record<string, string | undefined>): [number, number, number] => {
  const v = c.startsWith("theme:") ? theme[c.slice(6)] ?? "#ffffff" : c;
  const n = parseInt(v.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const at = ((sorted.length - 1) * Math.min(100, Math.max(0, p))) / 100;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** Each cell's look from the sheet's conditional formatting, by its place in the sheet's cells */
export function conditionalLooks(sheet: Sheet, theme: Record<string, string | undefined> = {}): Map<number, ConditionalLook> {
  const out = new Map<number, ConditionalLook>();
  const rules = sheet.conditional ?? [];
  if (!rules.length) return out;
  const inRanges = (ranges: Rect[]): number[] => {
    const found: number[] = [];
    sheet.cells.forEach((c, i) => { if (!c.spill && ranges.some((r) => c.r >= r[0] && c.r <= r[2] && c.c >= r[1] && c.c <= r[3])) found.push(i); });
    return found;
  };
  // An earlier rule wins where two would set the same thing
  const paint = (i: number, look: ConditionalLook) => { out.set(i, { ...look, ...(out.get(i) ?? {}) }); };

  for (const rule of rules) {
    const cells = inRanges(rule.ranges);
    if (rule.scale) {
      const values = cells.map((i) => number(sheet.cells[i])).filter((v): v is number => v != null).sort((a, b) => a - b);
      if (!values.length) continue;
      const min = values[0], max = values[values.length - 1];
      const stops = rule.scale.map((p) => {
        const given = Number(p.value);
        const value = p.type === "MIN" ? min : p.type === "MAX" ? max : p.type === "NUMBER" ? given : p.type === "PERCENT" ? min + ((max - min) * given) / 100 : percentile(values, given);
        return { value, rgb: hex(p.color, theme) };
      });
      for (const i of cells) {
        const v = number(sheet.cells[i]);
        if (v == null) continue;
        let a = stops[0], b = stops[stops.length - 1];
        for (let k = 0; k + 1 < stops.length; k++) if (v >= stops[k].value) { a = stops[k]; b = stops[k + 1]; }
        const span = b.value - a.value;
        const t = span > 0 ? Math.min(1, Math.max(0, (v - a.value) / span)) : v >= b.value ? 1 : 0;
        const mix = a.rgb.map((ch, k) => Math.round(ch + (b.rgb[k] - ch) * t));
        paint(i, { fill: "#" + mix.map((ch) => ch.toString(16).padStart(2, "0")).join("") });
      }
      continue;
    }
    const when = rule.when;
    const look = lookOf(rule);
    if (!when || !look) continue;
    const nums = when.values.map((v) => Number(v));
    const given = when.values.map((v) => v.toLowerCase());
    let test: ((cell: Cell) => boolean) | null = null;
    if (when.type.startsWith("NUMBER_")) {
      // (a rule that compares with another cell or a formula can't be worked out here)
      if (when.values.some((v) => v.startsWith("=")) || nums.some((n) => !Number.isFinite(n))) continue;
      const [a, b] = nums;
      const cmp: Record<string, (v: number) => boolean> = {
        NUMBER_GREATER: (v) => v > a, NUMBER_GREATER_THAN_EQ: (v) => v >= a, NUMBER_LESS: (v) => v < a, NUMBER_LESS_THAN_EQ: (v) => v <= a,
        NUMBER_EQ: (v) => v === a, NUMBER_NOT_EQ: (v) => v !== a, NUMBER_BETWEEN: (v) => v >= Math.min(a, b) && v <= Math.max(a, b), NUMBER_NOT_BETWEEN: (v) => v < Math.min(a, b) || v > Math.max(a, b),
      };
      const f = cmp[when.type];
      if (f) test = (cell) => { const v = number(cell); return v != null && f(v); };
    } else if (when.type === "TEXT_CONTAINS") test = (cell) => !isBlank(cell) && text(cell).toLowerCase().includes(given[0]);
    else if (when.type === "TEXT_NOT_CONTAINS") test = (cell) => !text(cell).toLowerCase().includes(given[0]);
    else if (when.type === "TEXT_STARTS_WITH") test = (cell) => text(cell).toLowerCase().startsWith(given[0]);
    else if (when.type === "TEXT_ENDS_WITH") test = (cell) => text(cell).toLowerCase().endsWith(given[0]);
    else if (when.type === "TEXT_EQ") test = (cell) => text(cell).toLowerCase() === given[0];
    else if (when.type === "BLANK") test = isBlank;
    else if (when.type === "NOT_BLANK") test = (cell) => !isBlank(cell);
    else if (when.type === "CUSTOM_FORMULA") {
      const stat = statOf(when.values[0] ?? "");
      if (!stat) continue;
      // These rules are about the first range as a whole
      const pool = inRanges([rule.ranges[0]]);
      const values = pool.map((i) => number(sheet.cells[i])).filter((v): v is number => v != null);
      if (stat.kind === "rank") {
        const count = stat.percent ? Math.max(1, Math.floor((values.length * stat.n) / 100)) : stat.n;
        test = (cell) => { const v = number(cell); return v != null && values.filter((x) => (stat.bottom ? x < v : x > v)).length + 1 <= count; };
      } else if (stat.kind === "average") {
        const mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);
        const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length || 1));
        const bar = mean + (stat.above ? 1 : -1) * stat.dev * sd;
        test = (cell) => { const v = number(cell); return v != null && (stat.above ? (stat.orEqual ? v >= bar : v > bar) : stat.orEqual ? v <= bar : v < bar); };
      } else if (stat.kind === "count") {
        const counts = new Map<string, number>();
        for (const i of pool) { const k = text(sheet.cells[i]).toLowerCase(); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
        test = (cell) => { const n = counts.get(text(cell).toLowerCase()) ?? 0; return !isBlank(cell) && (stat.unique ? n === 1 : n > 1); };
      } else test = (cell) => (cell.e != null) !== stat.not;
    }
    if (!test) continue;
    for (const i of cells) if (test(sheet.cells[i])) paint(i, look);
  }
  return out;
}

function lookOf(rule: ConditionalRule): ConditionalLook | null {
  const f = rule.format;
  if (!f) return null;
  const look: ConditionalLook = {};
  if (f.fill) look.fill = f.fill;
  if (f.color) look.color = f.color;
  if (f.bold) look.bold = true;
  if (f.italic) look.italic = true;
  if (f.underline) look.underline = true;
  if (f.strike) look.strike = true;
  return Object.keys(look).length ? look : null;
}
