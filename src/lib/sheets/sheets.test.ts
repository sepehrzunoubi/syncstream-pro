import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readXlsx, XlsxError, applyTint } from "./xlsx";
import { formulaSignature, precedents, shiftFormula, toSheetsFormula, tokenize, joinTokens } from "./formula";
import { cellName, hasContent, parseCellName, parseRange, typedText, type Cell, type Sheet, type Workbook } from "./model";
import { coverRects, planSteps } from "./order";
import { buildSheetPlan, MIN_STEP_MS } from "./plan";
import { needsCheck, numberFormatType, stepRequests, type Step } from "./steps";
import { parseWorkbook } from "./validate";
import { buildTimeline, finalView, viewAt } from "./timeline";
import { StubSpreadsheet } from "./stub.testing";
import { differences } from "./expected.testing";
import { createMemoryStore, withHistory, type SyncJob, type SyncPlan } from "../sync-store";
import { runJobWindow, type RunnerDeps } from "../sync-runner";

const FIXTURE = "fixtures/xlsx/kitchen-sink.xlsx";
const fixture = () => readXlsx(new Uint8Array(readFileSync(FIXTURE)), "kitchen-sink.xlsx");

/** A workbook from a few cells: "=..." is a formula, anything else a value */
function book(sheets: { name: string; cells: Record<string, string | number | boolean> }[]): Workbook {
  return {
    name: "Test", origin: "other", defaultFont: { family: "Arial", size: 10 }, styles: [{}], warnings: [],
    sheets: sheets.map((s, i): Sheet => ({
      id: i === 0 ? 0 : 1000 + i, name: s.name, rowCount: 1000, colCount: 26, defaultRowPx: 21, defaultColPx: 100, rowPx: [], colPx: [], merges: [],
      cells: Object.entries(s.cells).map(([ref, v]): Cell => {
        const [r, c] = parseCellName(ref)!;
        return typeof v === "string" && v.startsWith("=") ? { r, c, f: v.slice(1) } : { r, c, v };
      }).sort((a, b) => a.r - b.r || a.c - b.c),
    })),
  };
}

/** The order cells are typed in, as "Sheet!A1" */
function typedOrder(wb: Workbook, steps: Step[]): string[] {
  const out: string[] = [];
  for (const st of steps) if (st.k === "type" || st.k === "fill" || st.k === "paste") for (const i of st.cells) { const c = wb.sheets[st.s].cells[i]; out.push(`${wb.sheets[st.s].name}!${cellName(c.r, c.c)}`); }
  return out;
}

/** Run every step into a stub spreadsheet, each sent twice (as a retry would) */
function build(wb: Workbook, steps: Step[]): StubSpreadsheet {
  const doc = new StubSpreadsheet();
  for (const step of steps) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const requests = stepRequests(wb, step, needsCheck(step) ? doc.existing() : undefined);
      if (requests.length) doc.batchUpdate(requests);
    }
  }
  return doc;
}

// ── Reading .xlsx ──────────────────────────────────────────────────────────

test("reads a workbook's sheets, sizes and sheet settings", async () => {
  const wb = await fixture();
  assert.equal(wb.name, "kitchen-sink");
  assert.deepEqual(wb.sheets.map((s) => s.name), ["Formats", "Data", "Hidden sheet", "Q'uote & co"]);
  assert.deepEqual(wb.sheets.map((s) => s.id), [0, 1001, 1002, 1003]);
  assert.deepEqual(wb.defaultFont, { family: "Calibri", size: 11 });
  const [formats, data, hidden] = wb.sheets;
  assert.equal(formats.frozenRows, 1);
  assert.equal(formats.frozenCols, 1);
  assert.equal(formats.tabColor, "#00b050");
  assert.equal(data.hideGridlines, true);
  assert.equal(hidden.hidden, true);
  assert.deepEqual(formats.hiddenRows, [[39, 39]]);
  // Row heights in points become pixels (x 4/3); the file's default 15 points is 20 pixels
  assert.equal(formats.defaultRowPx, 20);
  assert.deepEqual(formats.rowPx.slice(0, 3), [[1, 1, 13], [5, 5, 40], [7, 7, 80]]);
  assert.deepEqual(formats.merges, [[2, 10, 4, 11], [0, 10, 0, 12]]);
  assert.deepEqual(wb.names, [{ name: "TotalData", sheet: 1, rect: [3, 1, 3, 1] }]);
});

test("formulas come out as Google Sheets writes them", async () => {
  const wb = await fixture();
  const at = (ref: string) => { const [r, c] = parseCellName(ref)!; return wb.sheets[0].cells.find((x) => x.r === r && x.c === c)!; };
  assert.equal(at("H15").f, "SUM(H12:H14)");
  assert.equal(at("H16").f, "H15/$I$15");
  assert.equal(at("H19").f, "Data!B2+Data!B3");
  // Excel's prefix for newer functions is dropped, an array formula is wrapped as Google's import wraps it
  assert.equal(at("H24").f, 'IFS(H12=1,"one",TRUE,"other")');
  assert.equal(at("H23").f, "ARRAY_CONSTRAIN(ARRAYFORMULA(SUM(H12:H14*I12:I14)), 1, 1)");
  assert.equal(typedText(at("H15")), "=SUM(H12:H14)");
  // Text that looks like a formula stays text
  assert.equal(at("F23").v, "=text");
  assert.equal(at("F23").f, undefined);
  assert.equal(at("F12").v, true);
  assert.equal(at("F24").v, "line1\nline2");
});

test("styles land on what Google's own import of the file gives", async () => {
  const wb = await fixture();
  const styleAt = (ref: string) => { const [r, c] = parseCellName(ref)!; const cell = wb.sheets[0].cells.find((x) => x.r === r && x.c === c)!; return cell.s ? wb.styles[cell.s] : {}; };
  assert.deepEqual(styleAt("A1"), {});
  assert.deepEqual(styleAt("B1").font, { family: "Arial", size: 10 });
  assert.deepEqual(styleAt("C1").font, { family: "Times New Roman", size: 14, bold: true, italic: true });
  assert.equal(styleAt("G1").font?.color, "theme:ACCENT1");
  // A tinted theme colour is the colour itself
  assert.equal(styleAt("H1").font?.color, "#95b3d7");
  assert.equal(styleAt("A2").fill, "#ffff00");
  assert.equal(styleAt("B2").fill, "theme:ACCENT2");
  assert.equal(styleAt("C2").fill, "#e5b9b7");
  // A pattern that isn't a solid colour has no fill in Sheets
  assert.equal(styleAt("D2").fill, undefined);
  // A filled cell gets no borders of its own (Google's import adds colourless ones; nothing draws)
  assert.equal(styleAt("A2").borders, undefined);
  for (const [ref, style] of [["A4", "SOLID"], ["B4", "SOLID_MEDIUM"], ["C4", "SOLID_THICK"], ["D4", "DASHED"], ["E4", "DASHED"], ["F4", "DOUBLE"], ["G4", "DOTTED"]] as const) {
    assert.deepEqual(styleAt(ref).borders, { bottom: { style, color: "#0000ff" } }, ref);
  }
  assert.deepEqual(styleAt("A6").borders, { top: { style: "SOLID_THICK", color: "theme:ACCENT1" }, bottom: { style: "DOUBLE", color: "#000000" }, left: { style: "SOLID", color: "#000000" }, right: { style: "SOLID_MEDIUM", color: "#ff0000" } });
  assert.deepEqual(["A8", "B8", "C8", "D8", "E8", "F8", "H8"].map((r) => styleAt(r).hAlign), ["LEFT", "CENTER", "RIGHT", "LEFT", "CENTER", "CENTER", undefined]);
  assert.deepEqual(["A9", "B9", "C9", "D9"].map((r) => styleAt(r).vAlign), ["TOP", "MIDDLE", "BOTTOM", "MIDDLE"]);
  assert.equal(styleAt("A10").wrap, "WRAP");
  assert.equal(styleAt("B10").wrap, "CLIP");
  assert.equal(styleAt("D10").rotation, 45);
  assert.equal(styleAt("F10").rotation, -45);
  assert.equal(styleAt("G10").rotation, "vertical");
  assert.equal(styleAt("B15").numFmt, "#,##0");
  assert.equal(styleAt("B26").numFmt, "@");
  assert.equal(styleAt("B12").numFmt, undefined);
});

test("notes, links, rich text, dropdowns and conditional formatting are read", async () => {
  const wb = await fixture();
  const sheet = wb.sheets[0];
  const at = (ref: string) => { const [r, c] = parseCellName(ref)!; return sheet.cells.find((x) => x.r === r && x.c === c)!; };
  assert.equal(at("K7").link, "https://example.com/x");
  assert.equal(at("K8").note, "a note here");
  assert.deepEqual(at("K9").runs, [{ at: 0, font: {} }, { at: 6, font: { bold: true } }, { at: 11, font: { size: 14, italic: true, color: "#ff0000" } }]);
  assert.deepEqual(sheet.validations, [{ rect: [10, 10, 10, 10], values: ["a", "b", "c"] }]);
  assert.deepEqual(sheet.conditional, [
    { ranges: [[11, 7, 13, 7]], when: { type: "NUMBER_GREATER", values: ["1"] }, format: { color: "#9c0006", fill: "#ffc7ce" } },
    { ranges: [[11, 8, 13, 8]], scale: [{ type: "MIN", color: "#f8696b" }, { type: "MAX", color: "#63be7b" }] },
  ]);
});

test("files that aren't workbooks say why", async () => {
  await assert.rejects(readXlsx(new TextEncoder().encode("not a zip at all"), "x.xlsx"), (e: unknown) => e instanceof XlsxError && e.code === "notXlsx");
  const ole = new Uint8Array(64); ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await assert.rejects(readXlsx(ole, "old.xls"), (e: unknown) => e instanceof XlsxError && e.code === "oldExcel");
  await assert.rejects(readXlsx(ole, "locked.xlsx"), (e: unknown) => e instanceof XlsxError && e.code === "encrypted");
});

test("Excel's tint moves a theme colour's lightness", () => {
  assert.equal(applyTint("4f81bd", 0.4), "95b3d7");
  assert.equal(applyTint("c0504d", 0.6), "e5b9b7");
  assert.equal(applyTint("000000", -0.25), "000000");
});

// ── Formulas ───────────────────────────────────────────────────────────────

test("a formula's tokens join back to the formula", () => {
  for (const f of ['SUM(A1:B2)*$C$3+Sheet2!D4', `'My ''Sheet'''!A1&"a ""quoted"" A1"`, "IF(A1>0,TRUE,#N/A)", "Table1[Col]+LOG10(100)+A:A+1:1", "{1,2;3,4}", "x1y+TAX2024"]) {
    assert.equal(joinTokens(tokenize(f)), f);
  }
});

test("filling moves relative references and leaves absolute ones", () => {
  assert.equal(shiftFormula("F9*$C$7/$C$8", 1, 0), "F10*$C$7/$C$8");
  assert.equal(shiftFormula("SUM(A1:A5)+B$2+$C3", 2, 1), "SUM(B3:B7)+C$2+$C5");
  assert.equal(shiftFormula("Data!A1+'Other one'!B2", 1, 1), "Data!B2+'Other one'!C3");
  assert.equal(shiftFormula('"A1"&A1', 1, 0), '"A1"&A2');
  // A reference filled off the sheet's edge is an error, as in a spreadsheet
  assert.equal(shiftFormula("A1+1", -1, 0), "#REF!+1");
  assert.equal(shiftFormula("SUM(A:A)", 0, 2), "SUM(C:C)");
});

test("two cells holding one filled formula have the same signature", () => {
  assert.equal(formulaSignature("F21*$C$19/$C$20", 20, 6), formulaSignature("F22*$C$19/$C$20", 21, 6));
  assert.notEqual(formulaSignature("F21*2", 20, 6), formulaSignature("F21*2", 21, 6));
  assert.equal(formulaSignature("sum(H12:H14)", 14, 7), formulaSignature("SUM(I12:I14)", 14, 8));
});

test("a formula's precedents are its ranges and names", () => {
  const p = precedents("SUM(B2:B4)+Data!C1+TotalData*MAX(A:A)");
  assert.deepEqual(p.refs.map((r) => [r.sheet, r.rect.slice(0, 2).join()]), [[null, "1,1"], ["Data", "0,2"], [null, "0,0"]]);
  assert.deepEqual(p.refs[0].rect, [1, 1, 3, 1]);
  assert.ok(p.names.includes("TotalData"));
});

test("Excel-only spellings become Google's", () => {
  assert.equal(toSheetsFormula("=_xlfn.IFS(A1=1,2)"), "IFS(A1=1,2)");
  assert.equal(toSheetsFormula("_xlfn.XLOOKUP(A1,B:B,C:C)+_xlfn._xlws.FILTER(A:A,B:B)"), "XLOOKUP(A1,B:B,C:C)+FILTER(A:A,B:B)");
  assert.equal(toSheetsFormula("A1+1"), "A1+1");
});

test("a number format's kind is named for Sheets", () => {
  const kinds: [string, string][] = [["#,##0.00", "NUMBER"], ["0.00%", "PERCENT"], ["0.00E+00", "SCIENTIFIC"], ["yyyy-mm-dd", "DATE"], ["h:mm AM/PM", "TIME"], ["m/d/yyyy h:mm", "DATE_TIME"], ["@", "TEXT"], ['"$"#,##0;("$"#,##0);"-"', "NUMBER"], ["[h]:mm", "TIME"], ['#,##0 "days"', "NUMBER"], ["[Red]-0.0;[Blue]0.0", "NUMBER"], ["mmm yyyy", "DATE"]];
  for (const [pattern, kind] of kinds) assert.equal(numberFormatType(pattern), kind, pattern);
});

// ── The order ──────────────────────────────────────────────────────────────

/** A small model: inputs on the right, a total below, a formula above that waits for the total */
const MODEL = () => book([{ name: "Model", cells: {
  B2: "Investment", C2: "=2*F3", B3: "Shares", C3: "=C8+D8",
  F2: "per founder", F3: 100000,
  B6: "Name", C6: "Shares", D6: "Options", B7: "Ann", C7: 600, D7: "=C7*0.1", B8: "Total", C8: "=SUM(C7:C7)", D8: "=SUM(D7:D7)",
  B10: "Price", C10: "=C2/C3",
} }]);

test("every cell is typed once, and no formula before the cells it reads", () => {
  for (const wb of [MODEL(), book([{ name: "A", cells: { A1: "=B!A1+1", A2: 5 } }, { name: "B", cells: { A1: "=A!A2*2", B1: "=A1" } }])]) {
    const { steps } = planSteps(wb);
    const order = typedOrder(wb, steps);
    const expected = wb.sheets.flatMap((s) => s.cells.filter(hasContent).map((c) => `${s.name}!${cellName(c.r, c.c)}`));
    assert.deepEqual([...order].sort(), [...expected].sort());
    const at = new Map(order.map((k, i) => [k, i]));
    wb.sheets.forEach((s) => s.cells.forEach((cell) => {
      if (cell.f == null) return;
      const me = at.get(`${s.name}!${cellName(cell.r, cell.c)}`)!;
      for (const ref of precedents(cell.f).refs) {
        const target = wb.sheets.find((x) => x.name === (ref.sheet ?? s.name))!;
        for (const other of target.cells) {
          if (!hasContent(other) || other.r < ref.rect[0] || other.r > ref.rect[2] || other.c < ref.rect[1] || other.c > ref.rect[3]) continue;
          assert.ok(at.get(`${target.name}!${cellName(other.r, other.c)}`)! < me, `${cellName(cell.r, cell.c)} is typed before ${cellName(other.r, other.c)}, which it reads`);
        }
      }
    }));
  }
});

test("labels come first, then numbers, then formulas; a formula that reads ahead waits and is written when it can be", () => {
  const wb = MODEL();
  const order = typedOrder(wb, planSteps(wb).steps).map((k) => k.slice(6));
  // Section 1: labels, the input, then the formula the input unlocks. C3 reads the total row: it waits
  assert.deepEqual(order.slice(0, 5), ["B2", "B3", "F2", "F3", "C2"]);
  const i = (ref: string) => order.indexOf(ref);
  assert.ok(i("C3") > i("C8") && i("C3") > i("D8"), "C3 waits for the totals");
  // Going back: C3 is written straight after the totals, before the next section starts
  assert.ok(i("C3") < i("B10"), "C3 is written before moving on");
  assert.ok(i("C10") > i("C3"));
});

test("a formula repeated down a column is typed once and filled", () => {
  const wb = book([{ name: "S", cells: { A1: 1, A2: 2, A3: 3, A4: 4, B1: "=A1*2", B2: "=A2*2", B3: "=A3*2", B4: "=A4*2", C1: "=A1+$A$4" } }]);
  const steps = planSteps(wb).steps;
  const fills = steps.filter((s): s is Extract<Step, { k: "fill" | "paste" }> => s.k === "fill");
  assert.equal(fills.length, 1);
  assert.deepEqual(fills[0].cells.map((i) => cellName(wb.sheets[0].cells[i].r, wb.sheets[0].cells[i].c)), ["B2", "B3", "B4"]);
});

test("formulas that read each other in a circle are still typed, and the plan ends", () => {
  const wb = book([{ name: "S", cells: { A1: "=B1+1", B1: "=A1+1", C1: "=A1" } }]);
  const order = typedOrder(wb, planSteps(wb).steps);
  assert.deepEqual([...order].sort(), ["S!A1", "S!B1", "S!C1"]);
});

test("a big block of values is pasted a few rows at a time", () => {
  const cells: Record<string, number | string> = {};
  for (let r = 1; r <= 120; r++) { cells[`A${r}`] = `item ${r}`; cells[`B${r}`] = r; cells[`C${r}`] = r * 2; }
  const wb = book([{ name: "Data", cells }]);
  const steps = planSteps(wb).steps;
  assert.equal(steps.filter((s) => s.k === "type").length, 0);
  assert.equal(steps.filter((s) => s.k === "paste").length, 5);
});

test("ranges that share a look are covered by few rectangles", () => {
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 2; c < 6; c++) cells.push({ r, c });
  cells.push({ r: 3, c: 2 }, { r: 5, c: 0 });
  assert.deepEqual(coverRects(cells), [[0, 2, 2, 5], [3, 2, 3, 2], [5, 0, 5, 0]]);
});

test("building the fixture step by step gives exactly the workbook, with every step sent twice", async () => {
  const wb = await fixture();
  const { steps } = planSteps(wb);
  const doc = build(wb, steps);
  assert.deepEqual(differences(wb, doc), []);
  assert.equal(doc.title, "Untitled spreadsheet");
  assert.deepEqual((doc.theme as { primaryFontFamily: string }).primaryFontFamily, "Calibri");
  // A hidden tab is hidden only once everything has been written into it
  assert.equal(steps[steps.length - 1].k, "prop");
});

test("requests carry what Sheets needs: exact colours, formulas with their =, links as runs", async () => {
  const wb = await fixture();
  const sheet = wb.sheets[0];
  const idx = (ref: string) => { const [r, c] = parseCellName(ref)!; return sheet.cells.findIndex((x) => x.r === r && x.c === c); };
  const typed = stepRequests(wb, { k: "type", s: 0, cells: [idx("H15")] });
  assert.deepEqual(typed, [{ updateCells: { start: { sheetId: 0, rowIndex: 14, columnIndex: 7 }, rows: [{ values: [{ userEnteredValue: { formulaValue: "=SUM(H12:H14)" } }] }], fields: "userEnteredValue" } }]);
  const fill = stepRequests(wb, { k: "fmt", s: 0, a: "fill", v: sheet.cells[idx("A2")].s!, rects: [[1, 0, 1, 0]] }) as { repeatCell: { cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: { red: number; green: number; blue: number } } } }; fields: string } }[];
  assert.deepEqual(fill[0].repeatCell.cell.userEnteredFormat.backgroundColorStyle.rgbColor, { red: 1, green: 1, blue: 0 });
  assert.equal(fill[0].repeatCell.fields, "userEnteredFormat.backgroundColorStyle");
  const link = stepRequests(wb, { k: "runs", s: 0, cell: idx("K7") }) as { updateCells: { rows: { values: { textFormatRuns: { format: { link: { uri: string } } }[] }[] }[]; fields: string } }[];
  assert.equal(link[0].updateCells.fields, "textFormatRuns");
  assert.equal(link[0].updateCells.rows[0].values[0].textFormatRuns[0].format.link.uri, "https://example.com/x");
  // A note is written with the cell it is on
  const note = stepRequests(wb, { k: "type", s: 0, cells: [idx("K8")] }) as { updateCells: { fields: string; rows: { values: { note: string }[] }[] } }[];
  assert.equal(note[0].updateCells.fields, "userEnteredValue,note");
  assert.equal(note[0].updateCells.rows[0].values[0].note, "a note here");
});

// ── Timing ─────────────────────────────────────────────────────────────────

test("a plan is the same for the same seed, and no step follows another faster than Sheets allows", async () => {
  const wb = await fixture();
  const a = buildSheetPlan(wb, { seed: 42 });
  const b = buildSheetPlan(wb, { seed: 42 });
  assert.deepEqual(a.actions, b.actions);
  assert.notDeepEqual(a.actions.map((x) => x.delayMs), buildSheetPlan(wb, { seed: 43 }).actions.map((x) => x.delayMs));
  assert.equal(a.actions.length, a.steps.length);
  assert.ok(a.actions.every((x) => x.delayMs >= MIN_STEP_MS));
  assert.equal(a.totalMs, a.actions.reduce((s, x) => s + x.delayMs, 0));
  assert.equal(a.totalUnits, a.units.reduce((s, x) => s + x, 0));
});

test("a total time is met exactly: thinking shrinks or grows, and the rest is time away between sections", async () => {
  const wb = await fixture();
  const natural = buildSheetPlan(wb, { seed: 7 });
  const shorter = buildSheetPlan(wb, { seed: 7, targetMinutes: Math.ceil(natural.minMs / 60_000) + 2 });
  assert.equal(shorter.totalMs, (Math.ceil(natural.minMs / 60_000) + 2) * 60_000);
  assert.equal(shorter.steps.filter((s) => s.k === "pause").length, 0);
  const longer = buildSheetPlan(wb, { seed: 7, targetMinutes: 600 });
  assert.equal(longer.totalMs, 600 * 60_000);
  const pauses = longer.steps.map((s, i) => (s.k === "pause" ? i : -1)).filter((i) => i >= 0);
  assert.ok(pauses.length >= 1);
  // Time away sits right before a section starts, and the sections still point at their first step
  for (const i of pauses) assert.ok(longer.sections.some((s) => s.at === i + 1));
  assert.deepEqual(longer.steps.filter((s) => s.k !== "pause"), natural.steps);
  const tooShort = buildSheetPlan(wb, { seed: 7, targetMinutes: 1 });
  assert.equal(tooShort.fitsTarget, false);
  assert.equal(tooShort.totalMs, tooShort.minMs);
});

// ── What the server accepts ────────────────────────────────────────────────

test("a workbook read from a file passes the server's check unchanged", async () => {
  const wb = await fixture();
  const parsed = parseWorkbook(JSON.parse(JSON.stringify(wb)));
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(planSteps(parsed.workbook).steps, planSteps(wb).steps);
});

test("a workbook that isn't one is refused", () => {
  const good = () => JSON.parse(JSON.stringify(MODEL())) as Record<string, unknown> & { sheets: Record<string, unknown>[] };
  assert.ok(parseWorkbook(good()).ok);
  const cases: ((w: ReturnType<typeof good>) => void)[] = [
    (w) => { w.sheets = []; },
    (w) => { (w.sheets[0].cells as Record<string, unknown>[])[0].r = -1; },
    (w) => { (w.sheets[0].cells as Record<string, unknown>[])[0].f = "=A1"; },
    (w) => { (w.sheets[0].cells as unknown[]).reverse(); },
    (w) => { w.sheets[0].id = 5; },
    (w) => { w.sheets[0].rowCount = 1e9; },
    (w) => { (w.sheets[0].cells as Record<string, unknown>[])[0].s = 3; },
    (w) => { w.styles = [{}, { fill: "red" }]; },
    (w) => { (w.sheets[0].cells as Record<string, unknown>[])[0].link = "javascript:alert(1)"; },
    (w) => { w.sheets.push({ ...w.sheets[0], id: 1001 }); },
  ];
  for (const [i, breakIt] of cases.entries()) { const w = good(); breakIt(w); assert.equal(parseWorkbook(w).ok, false, `case ${i}`); }
  assert.equal(parseWorkbook(null).ok, false);
});

// ── The view at a step ─────────────────────────────────────────────────────

test("the sheet at step 0 is empty, and at the last step it is the finished one", async () => {
  const wb = await fixture();
  const { steps } = planSteps(wb);
  const timeline = buildTimeline(wb, steps);
  const start = viewAt(wb, timeline, 0, 0);
  assert.equal(start.exists, false);
  assert.ok(wb.sheets[0].cells.every((_c, i) => !start.typed(i) && start.styleOf(i) === undefined));
  assert.deepEqual(start.merges, []);
  assert.deepEqual(start.defaultFont, { family: "Arial", size: 10 });
  // One step short of the end, every cell is typed and looks as it will (the last step hides a tab)
  const end = viewAt(wb, timeline, steps.length - 1, 0);
  const final = finalView(wb, 0);
  wb.sheets[0].cells.forEach((cell, i) => {
    if (hasContent(cell)) assert.ok(end.typed(i), cellName(cell.r, cell.c));
    assert.deepEqual(end.styleOf(i) ?? {}, final.styleOf(i) ?? {}, cellName(cell.r, cell.c));
  });
  assert.deepEqual(end.cols, final.cols);
  assert.deepEqual(end.rows, final.rows);
  assert.deepEqual(end.merges.map(String).sort(), final.merges.map(String).sort());
  // A column takes its width plus its gridline on screen, as in Google Sheets
  assert.equal(final.cols.sizes[0], 34 + 1);
});

test("what a step touches is where the page looks", () => {
  const wb = MODEL();
  const { steps } = planSteps(wb);
  const timeline = buildTimeline(wb, steps);
  const k = steps.findIndex((s) => s.k === "type");
  const view = viewAt(wb, timeline, k + 1, 0);
  assert.deepEqual(view.focus, [[1, 1, 1, 1]]);
  assert.equal(view.typed(wb.sheets[0].cells.findIndex((c) => c.r === 1 && c.c === 1)), true);
  assert.equal(parseRange("B2:C3")!.join(), "1,1,2,2");
});

// ── The runner ─────────────────────────────────────────────────────────────

function sheetJob(wb: Workbook, seed = 3): { plan: SyncPlan; job: SyncJob } {
  const p = buildSheetPlan(wb, { seed });
  const plan: SyncPlan = { id: "job1", userId: "u1", documentId: "sheet1", actions: p.actions, totalChars: p.totalUnits, totalMs: p.totalMs, breaks: [], seed, createdAt: 0, sheet: { workbook: wb, steps: p.steps, units: p.units, sections: p.sections } };
  const job: SyncJob = {
    id: "job1", userId: "u1", documentId: "sheet1", documentName: "Test", kind: "sheet", status: "pending", createdAt: 0, startAt: 0, currentAction: 0, totalActions: p.actions.length, charsSent: 0, totalChars: p.totalUnits,
    typoSubStep: 0, typoCharsInDoc: 0, generation: 0, failures: 0, accessToken: "t", refreshToken: "r", activity: "Queued", wpm: 0, baselineWordCount: 0, breaks: [], completedBreaks: [], lastUpdate: 0,
  };
  return { plan, job };
}

/** Run a job to its end through the queue, on a clock that jumps instead of waiting */
async function runToEnd(wb: Workbook, tamper?: (doc: StubSpreadsheet, calls: { n: number }, requests: Record<string, unknown>[]) => Error | null) {
  const clock = { t: 1_000_000 };
  const store = withHistory(createMemoryStore(() => clock.t));
  const doc = new StubSpreadsheet();
  const { plan, job } = sheetJob(wb);
  await store.setPlan(plan);
  await store.setJob(job);
  const calls = { n: 0 };
  const queue: { delaySec: number; generation: number; tick?: number }[] = [{ delaySec: 0, generation: 0 }];
  const deps: RunnerDeps = {
    store,
    docs: { snapshot: async () => { throw new Error("a sheet job reads no document"); }, batch: async () => { throw new Error("a sheet job writes no document"); }, deleteRange: async () => { throw new Error("unused"); } },
    sheets: {
      batch: async (_t, _id, requests) => {
        calls.n++;
        const fail = tamper?.(doc, calls, requests);
        // (a lost reply: the write landed, the runner never heard)
        if (fail && fail.message === "after") { doc.batchUpdate(requests); throw new Error("reply lost"); }
        if (fail) throw fail;
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
  return { outcome, doc, store, calls, job: (await store.getJob("job1"))! };
}

test("a spreadsheet job runs through the queue and builds exactly the workbook", async () => {
  const wb = await fixture();
  const { outcome, doc, job, store } = await runToEnd(wb);
  assert.equal(outcome, "done");
  assert.deepEqual(differences(wb, doc), []);
  assert.equal(job.status, "done");
  assert.equal(job.charsSent, job.totalChars);
  assert.equal(job.currentAction, job.totalActions);
  // A finished job keeps no credentials, and its history line says how it ended
  assert.equal(job.accessToken, "");
  const history = await store.listHistory("u1");
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].kind, history[0].status, history[0].documentId], ["sheet", "done", "sheet1"]);
});

test("a step whose reply was lost, or that failed outright, is sent again and changes nothing", async () => {
  const wb = MODEL();
  const { outcome, doc, calls } = await runToEnd(wb, (_doc, c) => (c.n === 2 ? new Error("after") : c.n === 9 ? new Error("network down") : null));
  assert.equal(outcome, "done");
  assert.deepEqual(differences(wb, doc), []);
  assert.ok(calls.n > 10);
});

test("a tab whose add was answered by an error after it landed isn't added twice", async () => {
  const wb = book([{ name: "One", cells: { A1: 1 } }, { name: "Two", cells: { A1: "=One!A1+1" } }]);
  let failed = false;
  const { outcome, doc } = await runToEnd(wb, (_d, _c, requests) => {
    // The batch that adds the second tab lands, and its reply is lost
    if (!failed && requests.some((r) => "addSheet" in r)) { failed = true; return new Error("after"); }
    return null;
  });
  assert.equal(outcome, "done");
  assert.equal(failed, true);
  assert.deepEqual(differences(wb, doc), []);
  assert.deepEqual(Array.from(doc.sheets.values()).map((s) => s.title), ["One", "Two"]);
});

test("a spreadsheet that is gone ends the job in words about spreadsheets", async () => {
  const wb = MODEL();
  const gone = Object.assign(new Error("Requested entity was not found."), { code: 404 });
  const { outcome, job } = await runToEnd(wb, () => gone);
  assert.equal(outcome, "error");
  assert.match(job.error ?? "", /spreadsheet was deleted/);
});

test("the history keeps a sync's line after the sync is removed", async () => {
  const store = withHistory(createMemoryStore());
  const { job } = sheetJob(MODEL());
  await store.setJob(job);
  assert.equal((await store.listHistory("u1"))[0].status, "pending");
  // Progress alone writes nothing new; the end does
  await store.setJob({ ...job, status: "running", currentAction: 5 });
  assert.equal((await store.listHistory("u1"))[0].status, "pending");
  await store.setJob({ ...job, status: "done", finishedAt: 99, startedAt: 1 });
  await store.deleteJob(job.id);
  const [entry] = await store.listHistory("u1");
  assert.deepEqual([entry.status, entry.finishedAt, entry.kind], ["done", 99, "sheet"]);
  await store.removeHistory("u1", [job.id]);
  assert.deepEqual(await store.listHistory("u1"), []);
});
