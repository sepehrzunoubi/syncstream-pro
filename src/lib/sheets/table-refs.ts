/**
 * Excel's table references ("Sales[Amount]", "[@Price]*[@Qty]") written as cell ranges, which is
 * the only way Google Sheets reads them.
 */

import { colName, type Rect } from "./model";

/** An Excel table: where it is and what its columns are called */
export interface TableInfo {
  name: string;
  /** The sheet it is on, by name */
  sheet: string;
  /** All of it: header row, data and totals row */
  rect: Rect;
  headerRows: number;
  totalsRows: number;
  columns: string[];
}

const quoteSheet = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

/** The end of the bracket group starting at `start` ("[" there); a quote mark escapes the next character */
function bracketEnd(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") { i++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

const unescapeColumn = (name: string): string => name.replace(/'(.)/g, (_m, ch: string) => ch);

/** A table reference's inside ("[#Headers],[Sales]", "@Sales", "Sales") as cells, or null when it names nothing known */
function structuredRange(inner: string, table: TableInfo, row: number): { rect: Rect; thisRow: boolean } | null {
  let text = inner.trim();
  let thisRow = false;
  if (text.startsWith("@")) { thisRow = true; text = text.slice(1).trim(); }
  // Items: bracketed ones in a list ("[#All],[A]:[B]"), or the whole text as one
  const items: string[] = [];
  let ranged = false;
  if (text.includes("[")) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "[") {
        const end = bracketEnd(text, i);
        if (end < 0) return null;
        items.push(text.slice(i + 1, end));
        i = end;
      } else if (text[i] === ":") ranged = true;
    }
  } else if (text) items.push(text);

  let top = table.rect[0] + table.headerRows;
  let bottom = table.rect[2] - table.totalsRows;
  const columns: number[] = [];
  let all = false, headers = false, totals = false, data = false;
  for (const raw of items) {
    const item = raw.trim();
    if (/^#all$/i.test(item)) all = true;
    else if (/^#headers$/i.test(item)) headers = true;
    else if (/^#totals$/i.test(item)) totals = true;
    else if (/^#data$/i.test(item)) data = true;
    else if (/^#this row$/i.test(item)) thisRow = true;
    else {
      const name = unescapeColumn(item).toLowerCase();
      const at = table.columns.findIndex((c) => c.toLowerCase() === name);
      if (at < 0) return null;
      columns.push(at);
    }
  }
  if (all) { top = table.rect[0]; bottom = table.rect[2]; }
  else if (headers || totals) {
    if ((headers && !table.headerRows) || (totals && !table.totalsRows)) return null;
    const dataTop = top, dataBottom = bottom;
    top = headers ? table.rect[0] : data ? dataTop : table.rect[2] - table.totalsRows + 1;
    bottom = totals ? table.rect[2] : data ? dataBottom : table.rect[0] + table.headerRows - 1;
  }
  if (thisRow) { if (row < table.rect[0] || row > table.rect[2]) return null; top = bottom = row; }
  let left = table.rect[1], right = table.rect[3];
  if (columns.length === 1) left = right = table.rect[1] + columns[0];
  else if (columns.length === 2 && ranged) { left = table.rect[1] + Math.min(...columns); right = table.rect[1] + Math.max(...columns); }
  else if (columns.length > 1) return null;
  if (top > bottom) return null;
  return { rect: [top, left, bottom, right], thisRow };
}

/**
 * A formula with its table references written as cell ranges. `sheet`, `row` and `col` say where the
 * formula is: a reference with no table name is to the table it sits in, and "this row" is its own
 * row. A reference that names no known table or column is left as it is.
 */
export function resolveTableRefs(formula: string, tables: readonly TableInfo[], sheet: string, row: number, col: number): string {
  if (!tables.length || formula.indexOf("[") < 0) return formula;
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const own = tables.find((t) => t.sheet === sheet && row >= t.rect[0] && row <= t.rect[2] && col >= t.rect[1] && col <= t.rect[3]);
  let out = "";
  const s = formula;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      // A string, or a quoted sheet name: copied as it is (a doubled quote is one quote inside it)
      let j = i + 1;
      while (j < s.length) { if (s[j] === ch) { if (s[j + 1] === ch) { j += 2; continue; } break; } j++; }
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch !== "[") { out += ch; continue; }
    const end = bracketEnd(s, i);
    if (end < 0) { out += s.slice(i); break; }
    // The table's name, when one is written right before the bracket
    const before = /[A-Za-z_\\][A-Za-z0-9_.\\]*$/.exec(out);
    const named = before ? byName.get(before[0].toLowerCase()) : undefined;
    const table = named ?? (before ? undefined : own);
    const found = table ? structuredRange(s.slice(i + 1, end), table, row) : null;
    if (!table || !found) { out += s.slice(i, end + 1); i = end; continue; }
    if (named && before) out = out.slice(0, out.length - before[0].length);
    const [r0, c0, r1, c1] = found.rect;
    // A column of the table stays put when the formula is filled; "this row" moves with it
    const cellRef = (r: number, c: number) => "$" + colName(c) + (found.thisRow ? "" : "$") + (r + 1);
    const a1 = r0 === r1 && c0 === c1 ? cellRef(r0, c0) : cellRef(r0, c0) + ":" + cellRef(r1, c1);
    out += (table.sheet !== sheet ? quoteSheet(table.sheet) + "!" : "") + a1;
    i = end;
  }
  return out;
}
