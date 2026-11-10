/**
 * Two real financial models, held to Google Sheets' own import of them.
 *
 * fixtures/xlsx/models has each file as it was uploaded and as the .xlsx Google exports of the
 * spreadsheet its import made (`*.google-import.xlsx`). fcff.xlsx (16 tabs, an old Mac workbook
 * with its own colour palette, column-wide formats, cross-sheet dropdowns, text centred across
 * cells, comments) is read by the page itself and must come to exactly what Google made of it.
 * lbo.xls is the old binary format: Google converts it (POST /api/sheets/import), and the page
 * reads what it became. Both are then planned and built, step by step, in the in-memory
 * spreadsheet, and what is built must be the workbook.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOldExcel, readXlsx, XlsxError } from "./xlsx";
import { parseWorkbook } from "./validate";
import { planSteps } from "./order";
import { buildSheetPlan } from "./plan";
import { needsCheck, stepRequests } from "./steps";
import { buildTimeline, viewAt } from "./timeline";
import { StubSpreadsheet } from "./stub.testing";
import { differences } from "./expected.testing";
import { workbookDifferences } from "./same.testing";
import { MAX_STORED_JSON, storedSize } from "../sync-store";
import type { Workbook } from "./model";

const file = (name: string) => new Uint8Array(readFileSync(`fixtures/xlsx/models/${name}`));
const read = (name: string) => readXlsx(file(name), name);

/** As a start request carries it, planned, and built with every step sent twice: what differs from the workbook */
function build(read: Workbook) {
  const parsed = parseWorkbook(JSON.parse(JSON.stringify(read)));
  if (!parsed.ok) throw new Error(parsed.error);
  const wb = parsed.workbook;
  const { steps, sections } = planSteps(wb);
  const doc = new StubSpreadsheet();
  let requests = 0;
  for (const step of steps) for (let attempt = 0; attempt < 2; attempt++) {
    const reqs = stepRequests(wb, step, needsCheck(step) ? doc.existing() : undefined);
    if (attempt === 0) requests += reqs.length;
    if (reqs.length) doc.batchUpdate(reqs);
  }
  return { wb, steps, sections, doc, requests, differences: differences(wb, doc) };
}

test("a 16-tab valuation model reads exactly as Google Sheets imports it", async () => {
  const mine = await read("fcff.xlsx");
  const googles = await read("fcff.google-import.xlsx");
  assert.equal(mine.sheets.length, 16);
  assert.deepEqual(workbookDifferences(mine, googles), []);
  // What that takes, each a rule of Google's import and none of this file's own:
  const sheet = (name: string) => mine.sheets.find((s) => s.name === name)!;
  const style = (name: string, r: number, c: number) => { const cell = sheet(name).cells.find((x) => x.r === r && x.c === c)!; return mine.styles[cell.s!]; };
  // the workbook's own colour palette (an old Mac one: its red is dd0806, its yellow fcf305)
  assert.equal(style("Master Inputs Start here", 0, 0).font?.color, "#dd0806");
  assert.equal(style("Master Inputs Start here", 5, 1).fill, "#fcf305");
  // a font Sheets doesn't have is the one its import puts in its place
  assert.equal(mine.defaultFont.family, "Arimo");
  // dropdowns that read another sheet (Excel keeps those in an extension list)
  assert.deepEqual(sheet("Master Inputs Start here").validations?.find((v) => v.rect.join() === "8,1,8,1"), { rect: [8, 1, 8, 1], source: "='Country ERP'!$A$5:$A$196", strict: true });
  // text centred across a selection is a merged cell
  assert.ok(sheet("R&D converter").merges.some((m) => m.join() === "0,0,0,9"));
  // a column formatted as a whole: one range of blank cells with that look, not a thousand cells
  assert.ok((sheet("Read me first").spans?.length ?? 0) > 0);
  assert.ok(sheet("Read me first").cells.length < 60);
  // widths and heights in Google's pixels; a height Excel worked out itself isn't one
  assert.deepEqual(sheet("Read me first").colPx, [[0, 0, 89], [1, 1, 455]]);
  assert.equal(sheet("Read me first").defaultRowPx, 18);
  assert.deepEqual(sheet("Read me first").rowPx, []);
  assert.deepEqual(sheet("Valuation Model").rowPx, [[0, 72, 33]]);
  // comments as notes, line ends as Sheets keeps them
  assert.ok(sheet("Master Inputs Start here").cells.some((c) => c.note?.startsWith("Aswath Damodaran:\n")));
});

test("the valuation model builds, tab by tab, into exactly itself", async () => {
  const built = build(await read("fcff.xlsx"));
  assert.deepEqual(built.differences, []);
  assert.equal(built.doc.sheets.size, 16);
  // Every tab is made in the workbook's order, and a formula that reads a later tab waits for it
  const made = built.steps.filter((s) => s.k === "sheet").map((s) => (s as { s: number }).s);
  assert.deepEqual(made, Array.from({ length: 16 }, (_x, i) => i));
  const { wb, steps } = built;
  const stepOf = new Map<string, number>();
  steps.forEach((st, k) => { if (st.k === "type" || st.k === "fill" || st.k === "paste") for (const i of st.cells) stepOf.set(`${st.s}:${i}`, k); });
  const madeAt = new Map<number, number>();
  steps.forEach((st, k) => { if (st.k === "sheet") madeAt.set(st.s, k); });
  const names = wb.sheets.map((s) => s.name.toLowerCase());
  let crossTab = 0;
  wb.sheets.forEach((sheet, s) => sheet.cells.forEach((cell, i) => {
    if (cell.f == null) return;
    for (const m of cell.f.matchAll(/'([^']+)'!|\b([A-Za-z_][\w.]*)!/g)) {
      const other = names.indexOf((m[1] ?? m[2]).replace(/''/g, "'").toLowerCase());
      if (other < 0 || other === s) continue;
      crossTab++;
      assert.ok(stepOf.get(`${s}:${i}`)! > madeAt.get(other)!, `${sheet.name} cell ${i} is written before the tab ${wb.sheets[other].name} exists`);
    }
  }));
  assert.ok(crossTab > 100, `formulas that read another tab: ${crossTab}`);
  // It fits one stored plan, and the page can show it at any step
  const plan = buildSheetPlan(wb, { targetMinutes: null, seed: 7, breaks: [] });
  assert.ok(storedSize({ id: "x", userId: "u", documentId: "", actions: plan.actions, totalChars: plan.totalUnits, totalMs: plan.totalMs, breaks: [], seed: plan.seed, createdAt: 0, sheet: { workbook: wb, steps: plan.steps, units: plan.units, sections: plan.sections } } as never) < MAX_STORED_JSON);
  const timeline = buildTimeline(wb, steps);
  assert.equal(viewAt(wb, timeline, 0, 0).exists, false);
  assert.equal(viewAt(wb, timeline, steps.length, 15).exists, true);
});

test("an old .xls workbook is one Google converts: what it becomes is read, planned and built into exactly itself", async () => {
  // The page doesn't read the binary format: it asks for Google's conversion instead
  assert.equal(isOldExcel(file("lbo.xls")), true);
  await assert.rejects(read("lbo.xls"), (err: unknown) => err instanceof XlsxError && err.code === "oldExcel");
  // What POST /api/sheets/import hands back for it: the spreadsheet Google made, as an .xlsx
  const wb = await read("lbo.google-import.xlsx");
  assert.equal(wb.origin, "google");
  assert.deepEqual(wb.sheets.map((s) => s.name), ["Input", "Inc_St", "Bal_Sheet", "Cash_Flow", "Depr_Amort", "Income_Tax", "WACC", "DCF_Analysis", "IRR_Returns", "Ratios"]);
  assert.equal(wb.names?.length, 82);
  assert.deepEqual([wb.sheets[2].frozenRows, wb.sheets[2].frozenCols, wb.sheets[4].frozenRows, wb.sheets[4].frozenCols], [5, 2, 12, 5]);
  assert.equal(wb.sheets[4].groups?.length, 1);
  // A third of a million formatted empty cells, kept as ranges: the model stays small enough to sync
  const cells = wb.sheets.reduce((n, s) => n + s.cells.length, 0);
  assert.ok(cells < 10_000, `cells ${cells}`);
  assert.ok(wb.sheets.every((s) => (s.spans?.length ?? 0) > 0));
  const built = build(wb);
  assert.deepEqual(built.differences, []);
  assert.equal(built.doc.sheets.size, 10);
  assert.equal(built.doc.namedRanges.size, 82);
  const kinds = new Set(built.steps.map((s) => s.k));
  for (const k of ["sheet", "name", "span", "type", "fill", "fmt", "size", "merge", "dv", "groups", "prop"]) assert.ok(kinds.has(k as never), k);
});

test("reading the same workbook twice gives the same workbook, and Google's export of a sync would read the same again", async () => {
  // The reader is its own fixed point on what Google writes: read, written to the stub, the model unchanged
  const a = await read("fcff.google-import.xlsx");
  const b = await read("fcff.google-import.xlsx");
  assert.deepEqual(workbookDifferences(a, b), []);
  assert.deepEqual(build(a).differences, []);
});
