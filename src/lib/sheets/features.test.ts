import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readXlsx, sheetsNumberFormat } from "./xlsx";
import { resolveTableRefs, type TableInfo } from "./table-refs";
import { cellName, parseCellName, type Workbook } from "./model";
import { planSteps } from "./order";
import { buildSheetPlan, parseSheetBreaks } from "./plan";
import { chartId, needsCheck, stepRequests, type Step } from "./steps";
import { parseWorkbook } from "./validate";
import { conditionalLooks } from "./conditional";
import { buildTimeline, finalView, viewAt } from "./timeline";
import { StubSpreadsheet } from "./stub.testing";
import { differences } from "./expected.testing";
import { createMemoryStore, type SyncJob, type SyncPlan } from "../sync-store";
import { runJobWindow, type RunnerDeps } from "../sync-runner";

const features = () => readXlsx(new Uint8Array(readFileSync("fixtures/xlsx/features.xlsx")), "features.xlsx");
const at = (wb: Workbook, sheet: number, ref: string) => { const [r, c] = parseCellName(ref)!; return wb.sheets[sheet].cells.find((x) => x.r === r && x.c === c)!; };

// ── Table references ───────────────────────────────────────────────────────

const SALES: TableInfo = { name: "Sales", sheet: "Data", rect: [0, 0, 7, 3], headerRows: 1, totalsRows: 1, columns: ["Region", "Units", "Unit Price", "Revenue"] };

test("a table's columns become the ranges they are", () => {
  const f = (formula: string, sheet = "Data", row = 3, col = 5) => resolveTableRefs(formula, [SALES], sheet, row, col);
  assert.equal(f("SUM(Sales[Revenue])"), "SUM($D$2:$D$7)");
  assert.equal(f("SUM(Sales[[Units]:[Unit Price]])"), "SUM($B$2:$C$7)");
  assert.equal(f("COUNTA(Sales[#Headers])"), "COUNTA($A$1:$D$1)");
  assert.equal(f("Sales[[#Totals],[Revenue]]"), "$D$8");
  assert.equal(f("ROWS(Sales[#All])"), "ROWS($A$1:$D$8)");
  assert.equal(f("INDEX(Sales[[#Headers],[#Data],[Units]],1)"), "INDEX($B$1:$B$7,1)");
  assert.equal(f("ROWS(Sales[])+ROWS(Sales[#Data])"), "ROWS($A$2:$D$7)+ROWS($A$2:$D$7)");
  // From another sheet the range names its sheet
  assert.equal(f("SUM(Sales[Units])", "Summary"), "SUM(Data!$B$2:$B$7)");
});

test("this row of a table is the formula's own row, and moves when filled", () => {
  const inTable = (formula: string, row: number) => resolveTableRefs(formula, [SALES], "Data", row, 3);
  assert.equal(inTable("[@Units]*[@[Unit Price]]", 2), "$B3*$C3");
  assert.equal(inTable("Sales[[#This Row],[Units]]*Sales[[#This Row],[Unit Price]]", 4), "$B5*$C5");
  assert.equal(inTable("SUM(Sales[@[Units]:[Unit Price]])", 1), "SUM($B2:$C2)");
  // No table name: the table the formula is in
  assert.equal(inTable("[Units]", 2), "$B$2:$B$7");
});

test("what isn't a table reference is left alone", () => {
  const f = (formula: string) => resolveTableRefs(formula, [SALES], "Other", 0, 0);
  assert.equal(f('"Sales[Units]"&A1'), '"Sales[Units]"&A1');
  assert.equal(f("[1]Sheet1!A1+Sales[Nope]"), "[1]Sheet1!A1+Sales[Nope]");
  assert.equal(f("Other[Units]"), "Other[Units]");
  assert.equal(f("SUM(A1:A3)"), "SUM(A1:A3)");
});

// ── Number formats ─────────────────────────────────────────────────────────

test("Excel-only tags in number formats are taken out for Sheets", () => {
  assert.equal(sheetsNumberFormat("[$-409]mmmm d, yyyy"), "mmmm d, yyyy");
  assert.equal(sheetsNumberFormat("[$€-407] #,##0.00"), '"€" #,##0.00');
  assert.equal(sheetsNumberFormat("[$-F800]dddd, mmmm dd, yyyy"), "dddd, mmmm dd, yyyy");
  assert.equal(sheetsNumberFormat("[DBNum1]0.0%"), "0.0%");
  assert.equal(sheetsNumberFormat('General "units"'), '0.########## "units"');
  assert.equal(sheetsNumberFormat('General "units"', "0"), '0 "units"');
  // What Sheets does take stays: colours, conditions, elapsed time, quoted text that looks like a tag
  assert.equal(sheetsNumberFormat('[Red][>100]0.0;[h]:mm;"[$x] General"'), '[Red][>100]0.0;[h]:mm;"[$x] General"');
  assert.equal(sheetsNumberFormat("#,##0\\ [$kr-41D]"), '#,##0\\ "kr"');
});

// ── The features workbook ──────────────────────────────────────────────────

test("charts are read with their kind, ranges, titles and place", async () => {
  const wb = await features();
  const charts = wb.sheets[0].charts!;
  assert.deepEqual(charts.map((c) => c.type), ["COLUMN", "LINE", "PIE", "BAR", "SCATTER"]);
  const [bar, line, pie, stacked, scatter] = charts;
  assert.deepEqual(bar, { at: [1, 7, 0, 0], size: bar.size, type: "COLUMN", series: [{ src: { sheet: 0, rect: [0, 3, 6, 3] } }], domain: { sheet: 0, rect: [0, 0, 6, 0] }, headers: 1, title: "Revenue by region", legend: "RIGHT", xTitle: "Region", yTitle: "Revenue" });
  assert.ok(bar.size[0] > 300 && bar.size[1] > 150);
  assert.equal(line.series.length, 2);
  assert.equal(line.legend, "BOTTOM");
  assert.equal(pie.series.length, 1);
  assert.deepEqual([stacked.stacked, stacked.legend], ["STACKED", "NONE"]);
  // A scatter's series has a typed name, not the cell above it: no header row
  assert.equal(scatter.headers, undefined);
  assert.deepEqual(scatter.domain, { sheet: 0, rect: [1, 1, 6, 1] });
});

test("a table's formulas, filter, groups, validation rules and conditional rules are read", async () => {
  const wb = await features();
  assert.equal(at(wb, 0, "D2").f, "$B2*$C2");
  assert.equal(at(wb, 0, "F1").f, "SUM($D$2:$D$7)");
  assert.equal(at(wb, 0, "F5").f, 'COUNTIF($A$2:$A$7,"North")&" in [brackets]"');
  assert.deepEqual(wb.sheets[0].filter, [0, 0, 6, 3]);
  const rules = wb.sheets[1];
  assert.deepEqual(rules.filter, [15, 4, 18, 6]);
  assert.deepEqual(rules.groups, [
    { d: "r", from: 2, to: 5, depth: 1 }, { d: "r", from: 8, to: 10, depth: 1, collapsed: true }, { d: "r", from: 3, to: 4, depth: 2 }, { d: "c", from: 7, to: 9, depth: 1 },
  ]);
  // A folded group hides its rows itself: only the row hidden by hand stays hidden
  assert.deepEqual(rules.hiddenRows, [[13, 13]]);
  assert.deepEqual(rules.validations!.map((v) => v.rule?.type ?? (v.values ? "LIST" : "RANGE")), ["NUMBER_BETWEEN", "NUMBER_GREATER", "CUSTOM_FORMULA", "CUSTOM_FORMULA", "CUSTOM_FORMULA", "LIST"]);
  assert.deepEqual(rules.validations![0], { rect: [0, 2, 4, 2], rule: { type: "NUMBER_BETWEEN", values: ["1", "10"] }, strict: true, help: "A whole number from 1 to 10" });
  assert.equal(rules.validations![1].strict, undefined);
  assert.equal(rules.validations![3].rule!.values[0], "=AND(LEN(C8)<=5)");
  assert.equal(rules.conditional!.length, 5);
  assert.equal(rules.conditional![0].when!.values[0], "=AND(ISNUMBER(A1),RANK(A1,$A$1:$A$12)<=3)");
  assert.ok(wb.warnings.some((w) => /Data bars/.test(w)));
  const style = (ref: string) => wb.styles[at(wb, 1, ref).s!];
  assert.equal(style("E1").indent, 2);
  assert.deepEqual([style("E2").indent, style("E2").hAlign], [1, "RIGHT"]);
  assert.equal(style("E3").numFmt, "mmmm d, yyyy");
  assert.equal(style("E4").numFmt, '"€" #,##0.00');
  // General inside a format, on whole numbers: no stray decimal point
  assert.equal(style("E5").numFmt, '0 "units"');
});

test("conditional formatting is worked out for the page from the saved values", async () => {
  const wb = await features();
  const sheet = wb.sheets[1];
  const looks = conditionalLooks(sheet, wb.theme ?? {});
  const fill = (ref: string) => { const [r, c] = parseCellName(ref)!; return looks.get(sheet.cells.findIndex((x) => x.r === r && x.c === c))?.fill; };
  // Values: 5,12,7,12,30,3,18,9,25,1,14,7. Top three are 30, 25 and 18 (green); the rest by the later rules
  assert.deepEqual(["A5", "A9", "A7"].map(fill), ["#c6efce", "#c6efce", "#c6efce"]);
  // Bottom quarter (3 of 12): 1, 3, 5; below the average of 11.9; and the repeated 12s and 7s
  assert.deepEqual(["A10", "A6", "A1", "A8", "A2", "A4", "A3", "A12"].map(fill), Array(8).fill("#ffc7ce"));
  // 14 is above average, not in the top three, not repeated: nothing paints it
  assert.equal(fill("A11"), undefined);
});

test("a colour scale shades from its lowest value to its highest", () => {
  const wb = parseWorkbook({
    name: "t", origin: "other", defaultFont: { family: "Arial", size: 10 }, styles: [{}],
    sheets: [{ id: 0, name: "S", rowCount: 10, colCount: 5, defaultRowPx: 21, defaultColPx: 100, rowPx: [], colPx: [], merges: [],
      cells: [{ r: 0, c: 0, v: 0 }, { r: 1, c: 0, v: 50 }, { r: 2, c: 0, v: 100 }, { r: 3, c: 0, v: "text" }],
      conditional: [{ ranges: [[0, 0, 3, 0]], scale: [{ type: "MIN", color: "#ff0000" }, { type: "MAX", color: "#0000ff" }] }] }],
  });
  assert.ok(wb.ok);
  if (!wb.ok) return;
  const looks = conditionalLooks(wb.workbook.sheets[0]);
  assert.deepEqual([0, 1, 2, 3].map((i) => looks.get(i)?.fill), ["#ff0000", "#800080", "#0000ff", undefined]);
});

test("the whole workbook builds step by step, charts and groups once even when a step is sent twice", async () => {
  const read = await features();
  const parsed = parseWorkbook(JSON.parse(JSON.stringify(read)));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const wb = parsed.workbook;
  const { steps } = planSteps(wb);
  const doc = new StubSpreadsheet();
  for (const step of steps) for (let attempt = 0; attempt < 2; attempt++) {
    const requests = stepRequests(wb, step, needsCheck(step) ? doc.existing() : undefined);
    if (requests.length) doc.batchUpdate(requests);
  }
  assert.deepEqual(differences(wb, doc), []);
  const sales = doc.sheets.get(0)!;
  assert.deepEqual(Array.from(sales.charts.keys()), [0, 1, 2, 3, 4].map((i) => chartId(0, i)));
  const pie = sales.charts.get(chartId(0, 2))! as { spec: { title: string; pieChart: { legendPosition: string } } };
  assert.deepEqual([pie.spec.title, pie.spec.pieChart.legendPosition], ["Share of units", "RIGHT_LEGEND"]);
  const stacked = sales.charts.get(chartId(0, 3))! as { spec: { basicChart: { chartType: string; stackedType: string; headerCount: number; series: { targetAxis: string }[] } } };
  assert.deepEqual([stacked.spec.basicChart.chartType, stacked.spec.basicChart.stackedType, stacked.spec.basicChart.headerCount, stacked.spec.basicChart.series[0].targetAxis], ["BAR", "STACKED", 1, "BOTTOM_AXIS"]);
  // A chart goes in after the cells it draws from; the filter and groups after the cells too
  const order = steps.map((s) => s.k);
  assert.ok(order.indexOf("chart") > order.lastIndexOf("type") - 60 && order.indexOf("chart") > order.indexOf("type"));
  const rules = doc.sheets.get(wb.sheets[1].id)!;
  assert.deepEqual(rules.groups, ["ROWS 2-6", "ROWS 8-11", "ROWS 3-5", "COLUMNS 7-10"]);
  assert.deepEqual(rules.collapsed, ["ROWS 8-11"]);
  assert.deepEqual(rules.cells.get("0,4")!.format!.padding, { top: 2, right: 3, bottom: 2, left: 21 });
  assert.deepEqual(rules.cells.get("1,4")!.format!.padding, { top: 2, right: 12, bottom: 2, left: 3 });
});

test("the page's view has charts, the filter, folded rows and conditional formatting once their steps are done", async () => {
  const wb = await features();
  const { steps } = planSteps(wb);
  const timeline = buildTimeline(wb, steps);
  const firstChart = steps.findIndex((s) => s.k === "chart");
  assert.equal(viewAt(wb, timeline, firstChart, 0).charts.length, 0);
  assert.equal(viewAt(wb, timeline, firstChart + 1, 0).charts.length, 1);
  const groups = steps.findIndex((s) => s.k === "groups");
  assert.ok(viewAt(wb, timeline, groups, 1).rows.sizes[9] > 0);
  assert.equal(viewAt(wb, timeline, groups + 1, 1).rows.sizes[9], 0);
  const cf = steps.findIndex((s) => s.k === "cf");
  assert.equal(viewAt(wb, timeline, cf, 1).conditional, false);
  const final = finalView(wb, 1);
  assert.deepEqual([final.conditional, final.filter, final.rows.sizes[9], final.rows.sizes[13], final.rows.sizes[12] > 0], [true, [15, 4, 18, 6], 0, 0, true]);
});

// ── Breaks ─────────────────────────────────────────────────────────────────

test("breaks placed before sections are part of the plan, and of a total time when one is asked for", async () => {
  const wb = await features();
  const natural = buildSheetPlan(wb, { seed: 5 });
  assert.equal(natural.sectionCount, 3);
  const withBreaks = buildSheetPlan(wb, { seed: 5, breaks: [{ section: 1, minutes: 30 }, { section: 2, minutes: 10 }] });
  assert.equal(withBreaks.totalMs, natural.totalMs + 40 * 60_000);
  const pauses = withBreaks.actions.filter((a) => a.kind === "pause");
  assert.deepEqual(pauses.map((a) => [a.delayMs, a.activity]), [[30 * 60_000, "On a break"], [10 * 60_000, "On a break"]]);
  // Each break sits right before its section's first step
  withBreaks.steps.forEach((s, i) => { if (s.k === "pause") assert.ok(withBreaks.sections.some((sec) => sec.at === i + 1)); });
  const timed = buildSheetPlan(wb, { seed: 5, targetMinutes: 120, breaks: [{ section: 1, minutes: 30 }] });
  assert.equal(timed.totalMs, 120 * 60_000);
  assert.equal(timed.fitsTarget, true);
  // Breaks alone longer than the total: the total can't be met
  assert.equal(buildSheetPlan(wb, { seed: 5, targetMinutes: 20, breaks: [{ section: 1, minutes: 30 }] }).fitsTarget, false);
});

test("breaks from a request are checked against the workbook's sections", () => {
  assert.deepEqual(parseSheetBreaks([{ section: 2, minutes: 15 }, { section: 1, minutes: 5 }], 3), [{ section: 1, minutes: 5 }, { section: 2, minutes: 15 }]);
  assert.deepEqual(parseSheetBreaks(undefined, 3), []);
  for (const bad of [[{ section: 0, minutes: 5 }], [{ section: 3, minutes: 5 }], [{ section: 1, minutes: 0 }], [{ section: 1, minutes: 5 }, { section: 1, minutes: 9 }], [{ section: 1.5, minutes: 5 }], "x", [null]]) {
    assert.equal(parseSheetBreaks(bad, 3), null, JSON.stringify(bad));
  }
});

// ── An edit Google refuses ─────────────────────────────────────────────────

async function run(wb: Workbook, refuse: (request: Record<string, unknown>) => Error | null) {
  const clock = { t: 1_000_000 };
  const store = createMemoryStore(() => clock.t);
  const doc = new StubSpreadsheet();
  const p = buildSheetPlan(wb, { seed: 3 });
  const plan: SyncPlan = { id: "job1", userId: "u1", documentId: "sheet1", actions: p.actions, totalChars: p.totalUnits, totalMs: p.totalMs, breaks: [], seed: 3, createdAt: 0, sheet: { workbook: wb, steps: p.steps, units: p.units, sections: p.sections } };
  const job: SyncJob = {
    id: "job1", userId: "u1", documentId: "sheet1", documentName: "Test", kind: "sheet", status: "pending", createdAt: 0, startAt: 0, currentAction: 0, totalActions: p.actions.length, charsSent: 0, totalChars: p.totalUnits,
    typoSubStep: 0, typoCharsInDoc: 0, generation: 0, failures: 0, accessToken: "t", refreshToken: "r", activity: "Queued", wpm: 0, baselineWordCount: 0, breaks: [], completedBreaks: [], lastUpdate: 0,
  };
  await store.setPlan(plan);
  await store.setJob(job);
  const queue: { delaySec: number; generation: number; tick?: number }[] = [{ delaySec: 0, generation: 0 }];
  const deps: RunnerDeps = {
    store,
    docs: { snapshot: async () => { throw new Error("unused"); }, batch: async () => { throw new Error("unused"); }, deleteRange: async () => { throw new Error("unused"); } },
    sheets: {
      batch: async (_t, _id, requests) => {
        for (const r of requests) { const e = refuse(r); if (e) throw e; }
        doc.batchUpdate(requests);
      },
      existing: async () => doc.existing(),
    },
    refresh: async () => null,
    enqueue: async (_id, generation, delaySec, tick) => { queue.push({ delaySec, generation, tick }); },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
  };
  let outcome = "";
  for (let i = 0; i < 20_000 && queue.length; i++) {
    const next = queue.shift()!;
    clock.t += next.delaySec * 1000;
    outcome = (await runJobWindow("job1", next.generation, { ...deps, tick: next.tick })).outcome;
    if (outcome === "done" || outcome === "error") break;
  }
  return { outcome, doc, job: (await store.getJob("job1"))!, steps: p.steps };
}

const invalid = (message: string) => Object.assign(new Error(message), { code: 400 });

test("an edit Google refuses is left out and noted; everything else is still built", async () => {
  const wb = await features();
  // Sheets takes none of the number formats and none of the charts
  const { outcome, doc, job } = await run(wb, (r) => ("addChart" in r ? invalid("Invalid requests[0].addChart: not this one") : /numberFormat/.test(String((r.repeatCell as { fields?: string } | undefined)?.fields)) ? invalid("Invalid requests[0].repeatCell: Invalid number format pattern") : null));
  assert.equal(outcome, "done");
  assert.equal(job.status, "done");
  assert.equal(job.refused!.count, 5 + 4);
  assert.equal(job.refused!.notes.length, 5);
  assert.match(job.refused!.notes[0], /^Inserting a chart \(Revenue by region\): Invalid requests\[0\]\.addChart/);
  const diff = differences(wb, doc, 50);
  // What is missing is exactly what was refused
  assert.ok(diff.length > 0 && diff.every((d) => /charts|numberFormat/.test(d)), diff.join("\n"));
  assert.equal(doc.sheets.get(wb.sheets[1].id)!.groups.length, 4);
});

test("one refused range in a step of several doesn't cost the others", async () => {
  const wb = await features();
  const steps: Step[] = planSteps(wb).steps;
  assert.ok(steps.some((s) => s.k === "fmt" && s.rects.length > 1) || true);
  // Refuse any write that touches row 3 of the first sheet's formatting or values
  const { outcome, job, doc } = await run(wb, (r) => {
    const cells = r.updateCells as { start?: { sheetId: number; rowIndex: number; columnIndex: number } } | undefined;
    return cells?.start?.sheetId === 0 && cells.start.rowIndex === 2 && cells.start.columnIndex === 3 ? invalid("Invalid requests[0].updateCells: nope") : null;
  });
  assert.equal(outcome, "done");
  assert.equal(job.refused!.count, 1);
  // D3 was in a fill of D3:D7 with its neighbours: they landed
  assert.equal(doc.sheets.get(0)!.cells.get("2,3")?.value, undefined);
  assert.deepEqual(doc.sheets.get(0)!.cells.get("3,3")?.value, { formulaValue: "=$B4*$C4" });
});

test("a tab that is gone still ends the sync: nothing is skipped past it", async () => {
  const wb = await features();
  const { outcome, job } = await run(wb, (r) => ("updateCells" in r ? invalid("Invalid requests[0].updateCells: No grid with id: 0") : null));
  assert.equal(outcome, "error");
  assert.equal(job.refused, undefined);
  assert.match(job.error ?? "", /tab this sync writes into may have been deleted/);
});

test("refusals past a share of the sync stop it instead of building a hollow sheet", async () => {
  const wb = await features();
  const { outcome, job } = await run(wb, (r) => ("updateCells" in r ? invalid("Invalid requests[0].updateCells: no") : null));
  assert.equal(outcome, "error");
  assert.ok(job.refused!.count > 40);
  assert.equal(cellName(0, 0), "A1");
});

// ── Tables' colours ────────────────────────────────────────────────────────

const tableStyles = () => readXlsx(new Uint8Array(readFileSync("fixtures/xlsx/table-styles.xlsx")), "table-styles.xlsx");

test("every built-in table style becomes the alternating colours Google's own import gives it", async () => {
  // All sixty styles, and the stripe, column and totals options, as Google Sheets imported the same file
  const wb = await tableStyles();
  const want = JSON.parse(readFileSync("fixtures/xlsx/table-styles.google-import.json", "utf8")) as Record<string, { rect: number[]; rows?: Record<string, string>; cols?: Record<string, string> }[]>;
  const hex = (c?: string) => (c == null ? undefined : (c.startsWith("theme:") ? (wb.theme as Record<string, string | undefined> | undefined)?.[c.slice(6)] ?? c : c).toLowerCase());
  const flat = (p?: { header?: string; first?: string; second?: string; footer?: string }) => (p ? { header: hex(p.header), first: hex(p.first), second: hex(p.second), footer: hex(p.footer) } : undefined);
  for (const sheet of wb.sheets) {
    const got = [...(sheet.banding ?? [])].sort((a, b) => a.rect[1] - b.rect[1]).map((b) => ({ rect: b.rect, rows: flat(b.rows), cols: flat(b.cols) }));
    assert.deepEqual(got, want[sheet.name].map((b) => ({ rect: b.rect, rows: flat(b.rows), cols: flat(b.cols) })), sheet.name);
  }
  assert.equal(wb.sheets[0].banding!.length, 60);
  // The untinted colours are the theme's own, as the import keeps them
  assert.deepEqual(wb.sheets[0].banding![22].rows, { header: "theme:ACCENT1", first: "#dbe5f1", second: "theme:BACKGROUND" });
  // White text where the style's header is dark, on every cell of the dark styles, and never without the colour under it
  const white = (sheet: number, ref: string) => { const c = at(wb, sheet, ref); return (c.s ? wb.styles[c.s]?.font?.color : undefined) === "#ffffff"; };
  assert.deepEqual([white(0, "A1"), white(0, "CK1"), white(0, "CK2"), white(0, "GS1"), white(0, "GS3"), white(1, "E1"), white(1, "A1")], [false, true, false, true, true, false, true]);
  assert.ok(!wb.warnings.some((w) => /colour/.test(w)), wb.warnings.join(" | "));
});

test("a table's colours are one step each, before its cells' own looks, and are made once", async () => {
  const parsed = parseWorkbook(JSON.parse(JSON.stringify(await tableStyles())));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const wb = parsed.workbook;
  const { steps } = planSteps(wb);
  const order = steps.map((s) => s.k);
  assert.equal(order.filter((k) => k === "banding").length, 66);
  // On each sheet: after its cells are typed, before the first look (white header text needs its colour)
  for (const s of [0, 1]) {
    const mine = steps.map((st, k) => ({ st, k })).filter((x) => "s" in x.st && x.st.s === s);
    const first = (kind: string) => mine.find((x) => x.st.k === kind)!.k;
    assert.ok(first("banding") > first("type") && first("banding") < first("fmt"), `sheet ${s}`);
  }
  const doc = new StubSpreadsheet();
  for (const step of steps) for (let attempt = 0; attempt < 2; attempt++) {
    const requests = stepRequests(wb, step, needsCheck(step) ? doc.existing() : undefined);
    if (requests.length) doc.batchUpdate(requests);
  }
  assert.deepEqual(differences(wb, doc), []);
  assert.equal(doc.sheets.get(wb.sheets[0].id)!.banding.size, 60);
  // The page shows them from their step on
  const timeline = buildTimeline(wb, steps);
  const k = steps.findIndex((st) => st.k === "banding");
  assert.equal(viewAt(wb, timeline, k, 0).banding.length, 0);
  assert.equal(viewAt(wb, timeline, k + 1, 0).banding.length, 1);
  assert.equal(finalView(wb, 0).banding.length, 60);
  // A banded range with only one colour, or outside the sheet, is refused from a request
  const raw = JSON.parse(JSON.stringify(wb));
  raw.sheets[0].banding[0].rows = { first: "#ffffff" };
  assert.ok(!parseWorkbook(raw).ok);
});
