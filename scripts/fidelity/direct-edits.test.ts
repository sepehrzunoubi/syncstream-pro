/**
 * Edits saved straight to the document (directEdits, the autosave of a Docs-backed document) make the
 * Google Doc what the editor shows: each edit is applied to a document in the strict stub, which is
 * then read back and compared with the editor (text, list labels and which list each item is in).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Command } from "@tiptap/pm/state";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow } from "@tiptap/pm/tables";
import { editorExtensions } from "../../src/components/workspace/extensions";
import { blankWithPdf, replaceWithPdf } from "../../src/components/workspace/use-pdf-import";
import { tableLinesPlugin } from "../../src/components/workspace/table-lines";
import { importDoc } from "../../src/lib/doc-import";
import { additions, adoptStructure, directEdits } from "../../src/lib/doc-model";
import { EDIT_REQUESTS } from "../../src/lib/docs-requests";
import type { EditorNode } from "../../src/lib/rich-text";
import { labelsOf, STRICT } from "./fidelity";
import { createStrictStubDocs } from "./strict-stub";

const NUMBERED = "NUMBERED_DECIMAL_ALPHA_ROMAN";
const text = (nodes: EditorNode[]) => nodes.map((n) => (n.content ?? []).map((c) => c.text ?? "").join(""));

/** A Docs document made by `setup`, read as the editor reads it; `edit` makes the editor's version, which is saved */
async function save(setup: object[], edit: (base: EditorNode[]) => EditorNode[]) {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("direct");
  await docs.batchUpdate(id, setup as never);
  const base = importDoc(await docs.get(id)).nodes;
  const target = edit(base);
  const { requests } = directEdits({ type: "doc", content: base }, { type: "doc", content: target });
  await docs.batchUpdate(id, requests as never);
  return { target, after: importDoc(await docs.get(id)).nodes };
}

test("indenting an item of a Docs list with a tabbed answer between items keeps the answer's tab and every item's bullet", async () => {
  const { target, after } = await save([
    { insertText: { location: { index: 1 }, text: "Q1\nans\nQ2\nQ3\nEnd" } },
    { createParagraphBullets: { range: { startIndex: 1, endIndex: 14 }, bulletPreset: NUMBERED } },
    { deleteParagraphBullets: { range: { startIndex: 4, endIndex: 8 } } },
    { insertText: { location: { index: 4 }, text: "\t" } },
  ], (base) => {
    const q3 = base[3];
    return [base[0], base[1], base[2], { ...q3, attrs: { ...q3.attrs, level: 1, preset: NUMBERED, listId: null, glyph: null, box: null } }, base[4]];
  });
  assert.deepEqual(labelsOf(target), ["1.", "2.", "a."], "the editor");
  assert.deepEqual(text(after), ["Q1", "\tans", "Q2", "Q3", "End"]);
  assert.deepEqual(labelsOf(after), ["1.", "2.", "a."], "the document");
});

test("a new numbered item after a Docs list's answer starts a list of its own, as the editor numbers it", async () => {
  const { target, after } = await save([
    { insertText: { location: { index: 1 }, text: "Q1\nans\nQ2\nEnd" } },
    { createParagraphBullets: { range: { startIndex: 1, endIndex: 11 }, bulletPreset: NUMBERED } },
    { deleteParagraphBullets: { range: { startIndex: 4, endIndex: 8 } } },
  ], (base) => {
    // Enter at the end of "ans", then Numbered list, then "new"
    const added: EditorNode = { type: "paragraph", attrs: { ...base[1].attrs, list: "ordered", listId: null, level: 0, glyph: null, preset: null, box: null, listCont: null }, content: [{ type: "text", text: "new" }] };
    return [base[0], base[1], added, base[2], base[3]];
  });
  assert.deepEqual(labelsOf(target), ["1.", "1.", "2."], "the editor");
  assert.deepEqual(text(after), ["Q1", "ans", "new", "Q2", "End"]);
  assert.deepEqual(labelsOf(after), ["1.", "1.", "2."], "the document");
  assert.equal(after[0].attrs?.listId, after[3].attrs?.listId, "Q2 stays in Q1's list");
  assert.notEqual(after[2].attrs?.listId, after[0].attrs?.listId, "the new item is a list of its own");
});

test("a pasted table's cell backgrounds reach the document once the table is in it, and stay in the editor", async () => {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("cells");
  await docs.batchUpdate(id, [{ insertText: { location: { index: 1 }, text: "Intro\nAfter" } }] as never);
  let base: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  const cell = (text: string, background: string | null = null): EditorNode => ({ type: "tableCell", attrs: { background }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text, marks: [{ type: "syncAdd" }] }] }] });
  const table: EditorNode = { type: "table", attrs: {}, content: [
    { type: "tableRow", attrs: {}, content: [cell("Name", "#fff2cc"), cell("Score")] },
    { type: "tableRow", attrs: {}, content: [cell("Ada"), cell("90", "#d9ead3")] },
  ] };
  let editor: EditorNode = { type: "doc", content: [base.content![0], table, base.content![1]] };
  // As the autosave goes: a table's shape first, read back and adopted, then the rest
  for (let round = 0; round < 4; round++) {
    const { requests, structural, saved } = directEdits(base, editor);
    if (!requests.length) break;
    for (const r of requests) assert.ok(EDIT_REQUESTS.has(Object.keys(r)[0]), `${Object.keys(r)[0]} is an edit the route takes`);
    await docs.batchUpdate(id, requests as never);
    if (structural) {
      base = { type: "doc", content: importDoc(await docs.get(id)).nodes };
      editor = adoptStructure(base, editor);
    } else base = saved;
  }
  const backgrounds = (doc: EditorNode) => (doc.content ?? []).filter((n) => n.type === "table").flatMap((t) => (t.content ?? []).map((r) => (r.content ?? []).map((c) => c.attrs?.background ?? null)));
  const read = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  assert.deepEqual(backgrounds(read), [["#fff2cc", null], [null, "#d9ead3"]], "the document");
  assert.deepEqual(backgrounds(editor), [["#fff2cc", null], [null, "#d9ead3"]], "the editor, after the table was adopted");
  assert.equal(directEdits(base, editor).requests.length, 0, "nothing left to save");
  // The cells' text is the sync's to type
  assert.deepEqual(additions(base, editor).segments.map((x) => x.text), ["Name", "Score", "Ada", "90"]);
});

test("a pasted table with merged cells is made once, merged as the editor has it, and its text goes into the right cells", async () => {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("merged");
  await docs.batchUpdate(id, [
    { insertText: { location: { index: 1 }, text: "Intro\nAfter" } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 2 }, paragraphStyle: { namedStyleType: "HEADING_2" }, fields: "namedStyleType" } },
  ] as never);
  let base: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  const cell = (text: string, colspan = 1, rowspan = 1, background: string | null = null): EditorNode => ({ type: "tableCell", attrs: { colspan, rowspan, background }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text, marks: [{ type: "syncAdd" }] }] }] });
  // Three columns wide, no row with three cells: a heading cell across all three; a cell two rows
  // tall, and beside it a cell two columns wide in each row (the last one shaded)
  const table: EditorNode = { type: "table", attrs: {}, content: [
    { type: "tableRow", attrs: {}, content: [cell("Wide", 3)] },
    { type: "tableRow", attrs: {}, content: [cell("Tall", 1, 2), cell("B", 2)] },
    { type: "tableRow", attrs: {}, content: [cell("C", 2, 1, "#d9ead3")] },
  ] };
  let editor: EditorNode = { type: "doc", content: [base.content![0], table, base.content![1]] };
  const structural: boolean[] = [];
  for (let round = 0; round < 4; round++) {
    const out = directEdits(base, editor);
    if (!out.requests.length) break;
    structural.push(!!out.structural);
    for (const r of out.requests) assert.ok(EDIT_REQUESTS.has(Object.keys(r)[0]), `${Object.keys(r)[0]} is an edit the route takes`);
    await docs.batchUpdate(id, out.requests as never);
    if (out.structural) {
      base = { type: "doc", content: importDoc(await docs.get(id)).nodes };
      editor = adoptStructure(base, editor);
    } else base = out.saved;
  }
  // The table is made once (then the newline Docs puts before a new table is taken out), and nothing is left to save
  assert.deepEqual(structural.filter(Boolean), [true]);
  assert.equal(directEdits(base, editor).requests.length, 0);
  const doc = await docs.get(id);
  const tables = (doc.body?.content ?? []).filter((e) => e.table);
  assert.equal(tables.length, 1);
  const spans = tables[0].table!.tableRows!.map((r) => r.tableCells!.map((c) => [c.tableCellStyle?.rowSpan ?? 1, c.tableCellStyle?.columnSpan ?? 1]));
  assert.deepEqual(spans, [[[1, 3], [1, 1], [1, 1]], [[2, 1], [1, 2], [1, 1]], [[1, 1], [1, 2], [1, 1]]]);
  // Read back, the editor's shape: the covered cells are left out
  const read = importDoc(doc).nodes.find((n) => n.type === "table")!;
  assert.deepEqual(read.content!.map((r) => r.content!.map((c) => [c.attrs?.colspan, c.attrs?.rowspan, c.attrs?.background])), [[[3, 1, null]], [[1, 2, null], [2, 1, null]], [[2, 1, "#d9ead3"]]]);
  // The sync types each cell's text where additions put it
  const { segments } = additions(base, editor);
  const typed = segments.slice().sort((a, b) => b.at - a.at).map((x) => ({ insertText: { location: { index: x.at }, text: x.text } }));
  await docs.batchUpdate(id, typed as never);
  const after = importDoc(await docs.get(id)).nodes;
  const cellText = (t: EditorNode) => t.content!.map((r) => r.content!.map((c) => (c.content ?? []).map((p) => (p.content ?? []).map((x) => x.text ?? "").join("")).join("|")));
  assert.deepEqual(cellText(after.find((n) => n.type === "table")!), [["Wide"], ["Tall", "B"], ["C"]]);
  assert.deepEqual(after.filter((n) => n.type === "paragraph").map((p) => [(p.content ?? []).map((x) => x.text ?? "").join(""), p.attrs?.styleName]), [["Intro", "h2"], ["After", "normal"]]);
});

/** Saves as the autosave does until nothing is left: a table's shape first, read back and adopted, then the rest */
async function autosave(docs: ReturnType<typeof createStrictStubDocs>, id: string, base: EditorNode, editor: EditorNode) {
  const rounds: string[][] = [];
  const structural: boolean[] = [];
  for (let round = 0; round < 5; round++) {
    const out = directEdits(base, editor);
    if (!out.requests.length) break;
    rounds.push(out.requests.map((r) => Object.keys(r)[0]));
    structural.push(!!out.structural);
    for (const r of out.requests) assert.ok(EDIT_REQUESTS.has(Object.keys(r)[0]), `${Object.keys(r)[0]} is an edit the route takes`);
    await docs.batchUpdate(id, out.requests as never);
    if (out.structural) {
      base = { type: "doc", content: importDoc(await docs.get(id)).nodes };
      editor = adoptStructure(base, editor);
    } else base = out.saved;
  }
  return { base, editor, rounds, structural };
}

test("a table's columns read back as Docs gives them: evenly distributed ones with no width, a fixed one with its own", async () => {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("columns");
  await docs.batchUpdate(id, [{ insertTable: { rows: 1, columns: 2, location: { index: 1 } } }] as never);
  const columns = async () => (await docs.get(id)).body!.content!.find((e) => e.table)!.table!.tableStyle!.tableColumnProperties;
  const widths = async () => importDoc(await docs.get(id)).nodes.find((n) => n.type === "table")!.content![0].content!.map((c) => c.attrs?.colwidth ?? null);
  assert.deepEqual(await columns(), [{ widthType: "EVENLY_DISTRIBUTED" }, { widthType: "EVENLY_DISTRIBUTED" }]);
  assert.deepEqual(await widths(), [null, null]);
  await docs.batchUpdate(id, [{ updateTableColumnProperties: { tableStartLocation: { index: 2 }, columnIndices: [1], tableColumnProperties: { widthType: "FIXED_WIDTH", width: { magnitude: 150, unit: "PT" } }, fields: "widthType,width" } }] as never);
  assert.deepEqual(await columns(), [{ widthType: "EVENLY_DISTRIBUTED" }, { widthType: "FIXED_WIDTH", width: { magnitude: 150, unit: "PT" } }]);
  assert.deepEqual(await widths(), [null, [200]]);
});

const schema = getSchema(editorExtensions);
type Cell = [text: string, colspan?: number, rowspan?: number];

/** A document with a table of these rows, made and filled as a pasted one is (its text typed by a sync), as read back */
async function docWithTable(rows: Cell[][]) {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("table");
  await docs.batchUpdate(id, [{ insertText: { location: { index: 1 }, text: "Intro\nAfter" } }] as never);
  const start: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  const cell = ([t, colspan = 1, rowspan = 1]: Cell): EditorNode => ({ type: "tableCell", attrs: { colspan, rowspan }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: t, marks: [{ type: "syncAdd" }] }] }] });
  const table: EditorNode = { type: "table", attrs: {}, content: rows.map((r) => ({ type: "tableRow", attrs: {}, content: r.map(cell) })) };
  const { base, editor } = await autosave(docs, id, start, { type: "doc", content: [start.content![0], table, start.content![1]] });
  const typed = additions(base, editor).segments.slice().sort((a, b) => b.at - a.at).map((x) => ({ insertText: { location: { index: x.at }, text: x.text } }));
  await docs.batchUpdate(id, typed as never);
  return { docs, id, base: { type: "doc", content: importDoc(await docs.get(id)).nodes } as EditorNode };
}

/** The editor's document after one of the table menu's commands, with the caret in the cell that says `text` */
function withCommand(doc: EditorNode, text: string, command: Command): EditorNode {
  const node = schema.nodeFromJSON(doc);
  let pos = -1;
  node.descendants((n, p) => { if (pos < 0 && n.isText && n.text === text) pos = p; });
  let state = EditorState.create({ schema, doc: node, selection: TextSelection.create(node, pos) });
  assert.ok(command(state, (tr) => { state = state.apply(tr); }), "the command runs");
  return state.doc.toJSON() as EditorNode;
}

/** A document's first table: each row's cells, as text and spans */
const tableOf = (doc: EditorNode) => (doc.content ?? []).find((n) => n.type === "table")!.content!.map((r) => (r.content ?? []).map((c) => {
  const t = (c.content ?? []).map((p) => (p.content ?? []).map((x) => x.text ?? "").join("")).join("|");
  const spans = (c.attrs?.colspan as number ?? 1) > 1 || (c.attrs?.rowspan as number ?? 1) > 1 ? `[${c.attrs?.colspan ?? 1}x${c.attrs?.rowspan ?? 1}]` : "";
  return t + spans;
}));

for (const [name, rows, at, command, want] of [
  ["a row added below", [[["A"], ["B"]], [["C"], ["D"]]], "A", addRowAfter, [["A", "B"], ["", ""], ["C", "D"]]],
  ["a row added at the end (Tab in the last cell)", [[["A"], ["B"]], [["C"], ["D"]]], "D", addRowAfter, [["A", "B"], ["C", "D"], ["", ""]]],
  ["a column added to the right", [[["A"], ["B"]], [["C"], ["D"]]], "A", addColumnAfter, [["A", "", "B"], ["C", "", "D"]]],
  ["the first row taken out", [[["A"], ["B"]], [["C"], ["D"]], [["E"], ["F"]]], "A", deleteRow, [["C", "D"], ["E", "F"]]],
  ["a middle row taken out", [[["A"], ["B"]], [["C"], ["D"]], [["E"], ["F"]]], "C", deleteRow, [["A", "B"], ["E", "F"]]],
  ["the first column taken out", [[["A"], ["B"]], [["C"], ["D"]]], "A", deleteColumn, [["B"], ["D"]]],
  // Docs takes out every row a merged reference cell spans
  ["the rows of a cell two rows tall and two wide taken out", [[["A"], ["B"]], [["Big", 2, 2]], [], [["C"], ["D"]]], "Big", deleteRow, [["A", "B"], ["C", "D"]]],
  ["the top row of a cell two rows tall taken out", [[["Big", 1, 2], ["B"]], [["C"]], [["D"], ["E"]]], "B", deleteRow, [["Big", "C"], ["D", "E"]]],
  ["a column inside a cell two columns wide taken out", [[["Wide", 2], ["X"]], [["P"], ["Q"], ["R"]]], "Q", deleteColumn, [["Wide", "X"], ["P", "R"]]],
  ["a row added inside a cell two rows tall", [[["Tall", 1, 2], ["B"]], [["C"]], [["D"], ["E"]]], "B", addRowAfter, [["Tall[1x3]", "B"], [""], ["C"], ["D", "E"]]],
] as [string, Cell[][], string, Command, string[][]][]) {
  test(`a table the document has, with ${name}, is saved once, in place, and the rest of the table stays`, async () => {
    const { docs, id, base } = await docWithTable(rows);
    const editor = withCommand(base, at, command);
    assert.deepEqual(tableOf(editor), want, "the page");
    const saved = await autosave(docs, id, base, editor);
    assert.deepEqual(saved.structural.filter(Boolean), [true], "one structural save");
    assert.deepEqual(tableOf({ type: "doc", content: importDoc(await docs.get(id)).nodes }), want, "the document");
    assert.equal(directEdits(saved.base, saved.editor).requests.length, 0, "nothing left to save");
  });
}

test("a pasted table with a row a merge covers whole (Docs' HTML writes it as an empty <tr>) is made once, and stays made", async () => {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("covered");
  await docs.batchUpdate(id, [{ insertText: { location: { index: 1 }, text: "Intro\nAfter" } }] as never);
  const start: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  const cell = (text: string, colspan = 1, rowspan = 1): EditorNode => ({ type: "tableCell", attrs: { colspan, rowspan }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text, marks: [{ type: "syncAdd" }] }] }] });
  // Two columns; below the first row, one cell two rows tall and two wide, so the last row has no cell of its own
  const table: EditorNode = { type: "table", attrs: {}, content: [
    { type: "tableRow", attrs: {}, content: [cell("A"), cell("B")] },
    { type: "tableRow", attrs: {}, content: [cell("Big", 2, 2)] },
    { type: "tableRow", attrs: {}, content: [] },
    { type: "tableRow", attrs: {}, content: [cell("C"), cell("D")] },
  ] };
  const { base, editor, rounds } = await autosave(docs, id, start, { type: "doc", content: [start.content![0], table, start.content![1]] });
  // Made once, merged; then the newline Docs puts before a new table is taken out, and nothing is left
  assert.deepEqual(rounds, [["insertTable", "mergeTableCells"], ["deleteContentRange"]]);
  const doc = await docs.get(id);
  const read = importDoc(doc).nodes.find((n) => n.type === "table")!;
  assert.deepEqual(read.content!.map((r) => r.content!.length), [2, 1, 0, 2], "read back as the editor has it");
  // The sync types each cell's text where additions put it, and an edit after the table goes where Docs has it
  const typed = additions(base, editor).segments.slice().sort((a, b) => b.at - a.at).map((x) => ({ insertText: { location: { index: x.at }, text: x.text } }));
  await docs.batchUpdate(id, typed as never);
  const now = importDoc(await docs.get(id)).nodes;
  const cellText = (t: EditorNode) => t.content!.map((r) => r.content!.map((c) => (c.content ?? []).map((p) => (p.content ?? []).map((x) => x.text ?? "").join("")).join("|")));
  assert.deepEqual(cellText(now.find((n) => n.type === "table")!), [["A", "B"], ["Big"], [], ["C", "D"]]);
  const edited = JSON.parse(JSON.stringify(now)) as EditorNode[];
  const after = edited.find((n) => n.type === "paragraph" && n.content?.[0]?.text === "After")!;
  after.content![0].text = "After!";
  await docs.batchUpdate(id, directEdits({ type: "doc", content: now }, { type: "doc", content: edited }).requests as never);
  assert.deepEqual(text(importDoc(await docs.get(id)).nodes.filter((n) => n.type === "paragraph")), ["Intro", "After!"]);
});

test("a pasted table's column widths (from the copy's HTML) reach the document once the table is in it, and stay on the page", async () => {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("widths");
  await docs.batchUpdate(id, [{ insertText: { location: { index: 1 }, text: "Intro\nAfter" } }] as never);
  const start: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  const cell = (text: string, colwidth: number[], colspan = 1): EditorNode => ({ type: "tableCell", attrs: { colspan, colwidth }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text, marks: [{ type: "syncAdd" }] }] }] });
  const table: EditorNode = { type: "table", attrs: {}, content: [
    { type: "tableRow", attrs: {}, content: [cell("Wide", [120, 504], 2)] },
    { type: "tableRow", attrs: {}, content: [cell("Name", [120]), cell("Notes", [504])] },
  ] };
  const { base, editor, rounds } = await autosave(docs, id, start, { type: "doc", content: [start.content![0], table, start.content![1]] });
  assert.deepEqual(rounds, [["insertTable", "mergeTableCells"], ["updateTableColumnProperties", "updateTableColumnProperties", "deleteContentRange"]]);
  const widths = (doc: EditorNode) => (doc.content ?? []).filter((n) => n.type === "table").flatMap((t) => (t.content ?? []).map((r) => (r.content ?? []).map((c) => c.attrs?.colwidth ?? null)));
  const read: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  assert.deepEqual(widths(read), [[[120, 504]], [[120], [504]]], "the document");
  assert.deepEqual(widths(editor), [[[120, 504]], [[120], [504]]], "the page");
  assert.equal(directEdits(base, editor).requests.length, 0, "nothing left to save");
});

test("deleting the document's last paragraph leaves the one before it with its own style (Docs keeps the last newline, and its style)", async () => {
  const { target, after } = await save([
    { insertText: { location: { index: 1 }, text: "Title\nBody text" } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 2 }, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } },
  ], (base) => [base[0]]);
  assert.deepEqual(text(target), ["Title"]);
  assert.deepEqual(after.map((p) => [(p.content ?? []).map((c) => c.text ?? "").join(""), p.attrs?.styleName]), [["Title", "h1"]]);
});

test("Import PDF: a PDF that starts with a table, put on a blank page or in place of a document's content, is saved (Docs has a paragraph before every table)", async () => {
  const cell = (text: string): EditorNode => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text, marks: [{ type: "syncAdd" }] }] }] });
  const pdf: EditorNode[] = [
    { type: "table", attrs: {}, content: [{ type: "tableRow", attrs: {}, content: [cell("Name"), cell("Score")] }] },
    { type: "paragraph", attrs: {}, content: [{ type: "text", text: "After the table.", marks: [{ type: "syncAdd" }] }] },
  ];
  for (const [name, setup, page] of [
    ["blank", [], () => blankWithPdf(pdf)],
    ["replace", [{ insertText: { location: { index: 1 }, text: "Old title\nOld text" } }], (base: EditorNode) => replaceWithPdf(base, pdf)],
  ] as const) {
    const docs = createStrictStubDocs({ ...STRICT });
    const id = await docs.create(name);
    if (setup.length) await docs.batchUpdate(id, setup as never);
    const start: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
    // (each round is applied as the stub applies it: one Docs refuses throws here)
    const { base, editor } = await autosave(docs, id, start, (page as (b: EditorNode) => EditorNode)(start));
    assert.equal(directEdits(base, editor).requests.length, 0, `${name}: nothing left to save`);
    const read = importDoc(await docs.get(id)).nodes;
    assert.deepEqual(read.map((n) => (n.type === "table" ? "table" : text([n])[0])), ["", "table", ""], name);
    assert.deepEqual(additions(base, editor).segments.map((x) => x.text), ["Name", "Score", "After the table."], name);
  }
});

/**
 * The page as the editor leaves it after `content` goes in: with the paragraph Docs has before a
 * table, and ending with a paragraph (StarterKit's trailing node), as on a real page
 */
function asEditorHasIt(content: EditorNode[]): EditorNode {
  if (content[content.length - 1]?.type !== "paragraph") content = [...content, { type: "paragraph", attrs: {}, content: [] }];
  const empty = EditorState.create({ schema, plugins: [tableLinesPlugin()] });
  const { state } = empty.applyTransaction(empty.tr.replaceWith(0, empty.doc.content.size, schema.nodeFromJSON({ type: "doc", content }).content));
  return state.doc.toJSON() as EditorNode;
}

test("a table put at the very start of a document (Insert > Table on a new blank doc, or one pasted there) is saved, and so are later edits", async () => {
  const cell = (text = ""): EditorNode => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", attrs: {}, content: text ? [{ type: "text", text }] : [] }] });
  const table = (a: string, b: string): EditorNode => ({ type: "table", attrs: {}, content: [{ type: "tableRow", attrs: {}, content: [cell(a), cell(b)] }] });
  const para = (text: string): EditorNode => ({ type: "paragraph", attrs: {}, content: text ? [{ type: "text", text }] : [] });
  // As each comes onto the page: Insert > Table puts the table before the empty line it was in;
  // a paste can leave the page as the table alone, or two tables one after the other
  for (const [name, page] of [
    ["inserted", [table("", ""), para("")]],
    ["pasted", [table("Name", "Score")]],
    ["two tables", [table("A", "B"), table("C", "D"), para("After")]],
  ] as const) {
    const docs = createStrictStubDocs({ ...STRICT });
    const id = await docs.create(name);
    const start: EditorNode = { type: "doc", content: importDoc(await docs.get(id)).nodes };
    const editorDoc = asEditorHasIt([...page] as EditorNode[]);
    // (each round is applied as the stub applies it: one Docs refuses throws here)
    const { base, editor } = await autosave(docs, id, start, editorDoc);
    assert.equal(directEdits(base, editor).requests.length, 0, `${name}: nothing left to save`);
    // A later edit after the table still saves
    const more = asEditorHasIt([...(editor.content ?? []), para("Typed after")]);
    const after = await autosave(docs, id, base, more);
    assert.equal(directEdits(after.base, after.editor).requests.length, 0, `${name}: the later edit is saved too`);
  }
});

test("the page keeps Docs' paragraph before a table: at the start, after another table, after a section break; never twice", () => {
  const cell = (): EditorNode => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", attrs: {}, content: [] }] });
  const table: EditorNode = { type: "table", attrs: {}, content: [{ type: "tableRow", attrs: {}, content: [cell()] }] };
  const para = (text: string, attrs: Record<string, unknown> = {}): EditorNode => ({ type: "paragraph", attrs, content: text ? [{ type: "text", text }] : [] });
  const shape = (doc: EditorNode) => (doc.content ?? []).map((n) => (n.type === "table" ? "table" : n.attrs?.locked ? "locked" : `p:${(n.content ?? []).map((c) => c.text ?? "").join("")}`));
  assert.deepEqual(shape(asEditorHasIt([table, para("x")])), ["p:", "table", "p:x"]);
  assert.deepEqual(shape(asEditorHasIt([para("a"), table, table, para("")])), ["p:a", "table", "p:", "table", "p:"]);
  assert.deepEqual(shape(asEditorHasIt([para("a"), table, para("b")])), ["p:a", "table", "p:b"], "a table after text is left as it is");
  assert.deepEqual(shape(asEditorHasIt([para("a"), para("", { locked: true, kind: "section", sectionType: "NEXT_PAGE" }), table])), ["p:a", "locked", "p:", "table", "p:"], "after a section break");
  const once = asEditorHasIt([table]);
  assert.deepEqual(shape(asEditorHasIt(once.content ?? [])), ["p:", "table", "p:"], "and the fix is made once");
});
