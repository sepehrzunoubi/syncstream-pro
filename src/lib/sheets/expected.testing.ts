/**
 * What a Google Sheet should hold once a workbook has been synced into it, built straight from the
 * workbook: tests compare it with what the steps actually wrote (stub.testing.ts).
 */

import type { Workbook } from "./model";
import { cellValue, styleFormat, textRuns } from "./steps";
import type { StubSpreadsheet } from "./stub.testing";

type Obj = Record<string, unknown>;

function merge(into: Obj, from: Obj): Obj {
  for (const [k, v] of Object.entries(from)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v) && typeof into[k] === "object" && into[k] !== null && k === "textFormat") into[k] = { ...(into[k] as Obj), ...(v as Obj) };
    else into[k] = structuredClone(v);
  }
  return into;
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));

/** Every difference between the spreadsheet and the workbook, in words (none: they match) */
export function differences(wb: Workbook, doc: StubSpreadsheet, limit = 20): string[] {
  const out: string[] = [];
  const say = (s: string) => { if (out.length < limit) out.push(s); };
  if (doc.sheets.size !== wb.sheets.length) say(`sheets: ${doc.sheets.size} instead of ${wb.sheets.length}`);
  wb.sheets.forEach((sheet, index) => {
    const got = doc.sheets.get(sheet.id);
    if (!got) { say(`sheet ${sheet.name} is missing`); return; }
    if (got.title !== sheet.name) say(`sheet title ${got.title} instead of ${sheet.name}`);
    if (got.index !== index) say(`sheet ${sheet.name} at ${got.index} instead of ${index}`);
    if (got.rowCount !== sheet.rowCount || got.colCount !== sheet.colCount) say(`sheet ${sheet.name} grid ${got.rowCount}x${got.colCount}`);
    if (!!got.hidden !== !!sheet.hidden) say(`sheet ${sheet.name} hidden ${got.hidden}`);
    if (!!got.hideGridlines !== !!sheet.hideGridlines) say(`sheet ${sheet.name} gridlines`);
    if (got.frozenRows !== (sheet.frozenRows ?? 0) || got.frozenCols !== (sheet.frozenCols ?? 0)) say(`sheet ${sheet.name} frozen`);
    const base: Obj = wb.defaultFont.size !== 10 ? { textFormat: { fontSize: wb.defaultFont.size } } : {};
    const under = (r: number, c: number): Obj => {
      const f = structuredClone(base);
      for (const [from, to, v] of sheet.colStyles ?? []) if (c >= from && c <= to) merge(f, styleFormat(wb.styles[v]).format);
      for (const [from, to, v] of sheet.rowStyles ?? []) if (r >= from && r <= to) merge(f, styleFormat(wb.styles[v]).format);
      return f;
    };
    const seen = new Set<string>();
    for (const cell of sheet.cells) {
      const key = `${cell.r},${cell.c}`;
      seen.add(key);
      const g = got.cells.get(key) ?? {};
      const format = cell.s ? merge(under(cell.r, cell.c), styleFormat(wb.styles[cell.s]).format) : under(cell.r, cell.c);
      if (canon(g.format ?? {}) !== canon(format)) say(`${sheet.name}!${key} format ${canon(g.format ?? {})} instead of ${canon(format)}`);
      if (canon(g.value) !== canon(cellValue(cell))) say(`${sheet.name}!${key} value ${canon(g.value)} instead of ${canon(cellValue(cell))}`);
      if ((g.note ?? "") !== (cell.note ?? "")) say(`${sheet.name}!${key} note`);
      const runs = cell.runs?.length || cell.link ? textRuns(wb, cell) : undefined;
      if (canon(g.runs) !== canon(runs)) say(`${sheet.name}!${key} runs ${canon(g.runs)} instead of ${canon(runs)}`);
    }
    for (const [key, g] of got.cells) {
      if (seen.has(key)) continue;
      const [r, c] = key.split(",").map(Number);
      if (g.value !== undefined) say(`${sheet.name}!${key} holds ${canon(g.value)}, nothing in the workbook`);
      if (canon(g.format ?? {}) !== canon(under(r, c))) say(`${sheet.name}!${key} format ${canon(g.format)} on a cell the workbook leaves plain`);
    }
    const merges = (list: readonly (readonly number[])[]) => list.map((m) => m.join()).sort().join(" ");
    if (merges(got.merges) !== merges(sheet.merges)) say(`sheet ${sheet.name} merges ${merges(got.merges)} instead of ${merges(sheet.merges)}`);
    for (let c = 0; c < sheet.colCount; c++) {
      let want = sheet.defaultColPx;
      for (const [from, to, px] of sheet.colPx) if (c >= from && c <= to) want = px;
      if ((got.colPx.get(c) ?? 100) !== want) say(`sheet ${sheet.name} column ${c} is ${got.colPx.get(c) ?? 100}px, not ${want}`);
    }
    for (let r = 0; r < sheet.rowCount; r++) {
      let want = sheet.defaultRowPx;
      for (const [from, to, px] of sheet.rowPx) if (r >= from && r <= to) want = px;
      if ((got.rowPx.get(r) ?? 21) !== want) say(`sheet ${sheet.name} row ${r} is ${got.rowPx.get(r) ?? 21}px, not ${want}`);
    }
    const hidden = (spans: readonly [number, number][] | undefined) => { const s: number[] = []; for (const [a, b] of spans ?? []) for (let i = a; i <= b; i++) s.push(i); return s.join(); };
    if (Array.from(got.hiddenRows).sort((a, b) => a - b).join() !== hidden(sheet.hiddenRows)) say(`sheet ${sheet.name} hidden rows`);
    if (Array.from(got.hiddenCols).sort((a, b) => a - b).join() !== hidden(sheet.hiddenCols)) say(`sheet ${sheet.name} hidden columns`);
    if (got.validations.length !== (sheet.validations?.length ?? 0)) say(`sheet ${sheet.name} dropdowns`);
    if (got.conditional.length !== (sheet.conditional?.length ?? 0)) say(`sheet ${sheet.name} conditional formatting`);
    if ((got.filter ?? []).join() !== (sheet.filter ?? []).join()) say(`sheet ${sheet.name} filter ${got.filter} instead of ${sheet.filter}`);
    if (got.groups.length !== (sheet.groups?.length ?? 0)) say(`sheet ${sheet.name} has ${got.groups.length} groups, not ${sheet.groups?.length ?? 0}`);
    if (got.collapsed.length !== (sheet.groups ?? []).filter((g) => g.collapsed).length) say(`sheet ${sheet.name} folded groups`);
    if (got.charts.size !== (sheet.charts?.length ?? 0)) say(`sheet ${sheet.name} has ${got.charts.size} charts, not ${sheet.charts?.length ?? 0}`);
  });
  if (doc.namedRanges.size !== (wb.names?.length ?? 0)) say("named ranges");
  return out;
}
