/**
 * Compare & Sync for spreadsheets: a spreadsheet that holds an older version of a workbook is
 * brought up to the reference by typing only what differs, and ends up exactly the reference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readXlsx } from "./xlsx";
import { parseWorkbook } from "./validate";
import { planSteps } from "./order";
import { buildSheetPlan } from "./plan";
import { compareSteps } from "./compare";
import { needsCheck, stepRequests, type Step } from "./steps";
import { buildTimeline, viewAt } from "./timeline";
import { StubSpreadsheet } from "./stub.testing";
import { differences } from "./expected.testing";
import type { Workbook } from "./model";

const model = async (): Promise<Workbook> => {
  const parsed = parseWorkbook(JSON.parse(JSON.stringify(await readXlsx(new Uint8Array(readFileSync("fixtures/xlsx/models/fcff.xlsx")), "fcff.xlsx"))));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
};
const run = (doc: StubSpreadsheet, wb: Workbook, steps: readonly Step[]) => {
  let requests = 0;
  for (const step of steps) for (let attempt = 0; attempt < 2; attempt++) {
    const reqs = stepRequests(wb, step, needsCheck(step) ? doc.existing() : undefined);
    if (attempt === 0) requests += reqs.length;
    if (reqs.length) doc.batchUpdate(reqs);
  }
  return requests;
};
const at = (wb: Workbook, sheet: string, r: number, c: number) => wb.sheets.find((s) => s.name === sheet)!.cells.find((x) => x.r === r && x.c === c)!;

let changedNumber = "";
/** An older version of the workbook: a tab missing, numbers and a formula different, a look different, a note gone */
function older(want: Workbook): Workbook {
  const have: Workbook = JSON.parse(JSON.stringify(want));
  have.sheets = have.sheets.filter((s) => s.name !== "Option Value");
  const inputs = have.sheets.find((s) => s.name === "Master Inputs Start here")!;
  const number = inputs.cells.find((c) => typeof c.v === "number" && c.f == null && !c.note)!;
  number.v = 12345;
  changedNumber = `${number.r},${number.c}`;
  at(have, "Input Summary", 1, 1).f = "1+1";
  const titled = at(have, "Read me first", 0, 0);
  have.styles.push({ ...have.styles[titled.s!], font: { ...have.styles[titled.s!].font, bold: undefined, italic: true } });
  titled.s = have.styles.length - 1;
  const noted = have.sheets.find((s) => s.name === "Master Inputs Start here")!.cells.find((c) => c.note)!;
  delete noted.note;
  const sheet = have.sheets.find((s) => s.name === "Valuation Model")!;
  sheet.cells = sheet.cells.filter((c) => c.r < 40);
  sheet.merges = sheet.merges.slice(0, 1);
  return have;
}

test("a spreadsheet with an older version is brought up to the reference by what differs, and ends up exactly it", async () => {
  const want = await model();
  const have = older(want);
  const doc = new StubSpreadsheet();
  const whole = run(doc, have, planSteps(have).steps);
  assert.deepEqual(differences(have, doc), []);

  const plan = compareSteps(have, want);
  assert.deepEqual(plan.summary.newSheets, ["Option Value"]);
  const sent = run(doc, want, plan.steps);
  assert.deepEqual(differences(want, doc), []);
  // Far less than building the workbook again: the missing tab, the missing rows, and a handful of cells
  assert.ok(sent < whole / 4, `${sent} requests against ${whole}`);
  const kinds = plan.steps.map((s) => s.k);
  assert.equal(kinds.filter((k) => k === "sheet").length, 1);
  assert.deepEqual(plan.steps.find((s) => s.k === "sheet"), { k: "sheet", s: want.sheets.findIndex((s) => s.name === "Option Value"), mode: "add" });
  // What differed is typed, and only that
  const typedOn = (name: string) => { const s = want.sheets.findIndex((x) => x.name === name); return Array.from(plan.typed[s]).map((i) => `${want.sheets[s].cells[i].r},${want.sheets[s].cells[i].c}`); };
  assert.deepEqual(typedOn("Input Summary"), ["1,1"]);
  assert.ok(typedOn("Master Inputs Start here").includes(changedNumber));
  assert.equal(typedOn("Master Inputs Start here").length, 2, "the changed number and the cell whose note was gone");
  assert.deepEqual(typedOn("Read me first"), []);
  assert.ok(typedOn("Valuation Model").every((k) => Number(k.split(",")[0]) >= 40));
  // The look that differed is put right: bold set, and the italic the reference doesn't have taken off
  assert.ok(plan.steps.some((s) => s.k === "clear" && s.a === "italic" && s.rects.some((r) => r.join() === "0,0,0,0")));
  const s0 = want.sheets.findIndex((x) => x.name === "Read me first");
  assert.ok(plan.steps.some((s) => s.k === "fmt" && s.s === s0 && s.a === "bold" && s.rects.some((r) => r[0] === 0 && r[1] === 0)));
  // Sections follow what is left, in the reference's order
  assert.ok(plan.sections.length > 0 && plan.sections.every((sec, i) => i === 0 || sec.at > plan.sections[i - 1].at));
  assert.ok(plan.sections.every((sec) => sec.at < plan.steps.length));
});

test("a spreadsheet that already is the reference needs nothing; one that is empty needs all of it", async () => {
  const want = await model();
  const none = compareSteps(want, want);
  assert.deepEqual(none.steps, []);
  assert.deepEqual(none.summary, { newSheets: [], cells: 0, looks: 0, kept: [] });
  const empty: Workbook = { ...want, sheets: [], names: undefined, iterate: undefined };
  const all = compareSteps(empty, want);
  assert.equal(all.steps.filter((s) => s.k !== "theme").length, planSteps(want).steps.filter((s) => s.k !== "theme").length);
  assert.ok(all.steps.filter((s) => s.k === "sheet").every((s) => s.k === "sheet" && s.mode === "add"));
  // A tab the spreadsheet has but can't be written counts as missing: it is built as a new one
  const locked = compareSteps(want, want, new Set(want.sheets.slice(1).map((s) => s.name.toLowerCase())));
  assert.deepEqual(locked.summary.newSheets, [want.sheets[0].name]);
});

test("the plan and the page's preview follow the comparison: what is there shows from the start, what is typed appears in its turn", async () => {
  const want = await model();
  const have = older(want);
  const plan = buildSheetPlan(want, { seed: 3, have });
  assert.ok(plan.compare);
  assert.equal(plan.steps.length, compareSteps(have, want).steps.length);
  assert.ok(plan.totalMs < buildSheetPlan(want, { seed: 3 }).totalMs / 4);
  const timeline = buildTimeline(want, plan.steps, true);
  const s = want.sheets.findIndex((x) => x.name === "Input Summary");
  const changed = want.sheets[s].cells.findIndex((c) => c.r === 1 && c.c === 1);
  const other = want.sheets[s].cells.findIndex((c, i) => i !== changed && c.v != null);
  const start = viewAt(want, timeline, 0, s);
  assert.equal(start.exists, true);
  assert.equal(start.typed(other), true);
  assert.equal(start.typed(changed), false);
  assert.deepEqual(start.cols, viewAt(want, timeline, plan.steps.length, s).cols);
  // The new tab isn't there until its step
  const added = want.sheets.findIndex((x) => x.name === "Option Value");
  assert.equal(viewAt(want, timeline, 0, added).exists, false);
  assert.equal(viewAt(want, timeline, plan.steps.length - 1, added).exists, true);
});
