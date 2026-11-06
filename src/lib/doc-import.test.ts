import { test } from "node:test";
import assert from "node:assert/strict";
import type { docs_v1 } from "googleapis";
import { anchorPosition, importDoc, indexedText } from "./doc-import";
import { additions, PENDING_MARK } from "./doc-model";
import { listLabels } from "./list-labels";

/** Build a documents.get body from paragraphs, assigning indices like Docs does */
function makeDoc(paras: { text: string; bullet?: { listId: string; nestingLevel?: number }; style?: docs_v1.Schema$TextStyle; image?: boolean }[], extra: Partial<docs_v1.Schema$Document> = {}): docs_v1.Schema$Document {
  const content: docs_v1.Schema$StructuralElement[] = [{ endIndex: 1, sectionBreak: {} }];
  let i = 1;
  for (const p of paras) {
    const start = i;
    const elements: docs_v1.Schema$ParagraphElement[] = [];
    if (p.image) {
      elements.push({ startIndex: i, endIndex: i + 1, inlineObjectElement: { inlineObjectId: "img1" } });
      i += 1;
    }
    const run = p.text + "\n";
    elements.push({ startIndex: i, endIndex: i + run.length, textRun: { content: run, textStyle: p.style ?? {} } });
    i += run.length;
    content.push({ startIndex: start, endIndex: i, paragraph: { elements, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, ...(p.bullet ? { bullet: p.bullet } : {}) } });
  }
  return { revisionId: "rev1", body: { content }, ...extra };
}

const lists = {
  q: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }, { glyphType: "ALPHA", glyphFormat: "%1." }] } },
  b: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
};

test("imports paragraphs as editable nodes, numbering questions across the answers between them", () => {
  const doc = makeDoc(
    [
      { text: "Logistics:", style: { underline: true } },
      { text: "What is your phone number?", bullet: { listId: "q" } },
      { text: "845" },
      { text: "Where will you be?", bullet: { listId: "q" } },
      { text: "If not, when?", bullet: { listId: "q", nestingLevel: 1 } },
      { text: "In NYC." },
      { text: "Are you available?", bullet: { listId: "q" } },
      { text: "A point", bullet: { listId: "b" } },
    ],
    { lists }
  );
  const out = importDoc(doc);
  assert.equal(out.empty, false);
  assert.equal(out.revisionId, "rev1");
  assert.equal(out.nodes.length, 8);
  assert.ok(out.nodes.every((n) => !n.attrs?.locked));
  const labels = listLabels(out.nodes.map((n) => n.attrs ?? {}));
  assert.deepEqual(labels, [null, "1.", null, "2.", "a.", null, "3.", "●"]);
  assert.deepEqual(out.nodes.map((n) => n.attrs?.list ?? null), [null, "ordered", null, "ordered", "ordered", null, "ordered", "bullet"]);
  assert.deepEqual(out.nodes[0].content, [{ type: "text", text: "Logistics:", marks: [{ type: "underline" }] }]);
});

test("an empty document imports as empty", () => {
  const out = importDoc(makeDoc([{ text: "" }, { text: "  " }]));
  assert.equal(out.empty, true);
  assert.equal(out.nodes.length, 2);
});

test("images show with their Google address and size", () => {
  const doc = makeDoc([{ text: "Pic", image: true }], {
    inlineObjects: { img1: { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: "https://lh3.googleusercontent.com/x" }, size: { width: { magnitude: 150, unit: "PT" }, height: { magnitude: 75, unit: "PT" } } } } } },
  });
  const out = importDoc(doc);
  assert.deepEqual(out.nodes[0].content?.[0], { type: "image", attrs: { src: "https://lh3.googleusercontent.com/x", width: 200, height: 100 } });
});

test("index-aligned text and anchor validation", () => {
  const doc = makeDoc([{ text: "Ab" }, { text: "Cd" }]);
  const chars = indexedText(doc);
  assert.equal(chars, "\0Ab\nCd\n");
  assert.equal(anchorPosition(chars, { mode: "after", at: 4 }), 4);
  assert.equal(anchorPosition(chars, { mode: "before", at: 4 }), 4);
  assert.equal(anchorPosition(chars, { mode: "before", at: 1 }), 1);
  assert.equal(anchorPosition(chars, { mode: "after", at: 7 }), 7);
  assert.equal(anchorPosition(chars, { mode: "after", at: 3 }), null, "not the end of a paragraph");
  assert.equal(anchorPosition(chars, { mode: "before", at: 2 }), null, "not the start of a paragraph");
  assert.equal(anchorPosition(chars, { mode: "before", at: 7 }), null, "past the last paragraph");
});

test("tables are locked and keep the indices after them right", () => {
  const doc: docs_v1.Schema$Document = {
    revisionId: "r",
    body: {
      content: [
        { endIndex: 1, sectionBreak: {} },
        { startIndex: 1, endIndex: 4, paragraph: { elements: [{ startIndex: 1, endIndex: 4, textRun: { content: "Hi\n" } }] } },
        { startIndex: 4, endIndex: 12, table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 6, endIndex: 10, paragraph: { elements: [{ startIndex: 6, endIndex: 10, textRun: { content: "Cel\n" } }] } }] }] }] } },
        { startIndex: 12, endIndex: 16, paragraph: { elements: [{ startIndex: 12, endIndex: 16, textRun: { content: "Bye\n" } }] } },
      ],
    },
  };
  const out = importDoc(doc);
  assert.equal(out.nodes.length, 3);
  assert.equal(out.nodes[1].type, "table");
  // The two indices before "Cel\n" and the two after it are kept as spans
  assert.equal(out.nodes[1].content?.[0].content?.[0].attrs?.span, 2);
  assert.equal(out.nodes[1].attrs?.endSpan, 2);
  // Text added at the end of "Bye" goes before its newline at index 15
  const base = { type: "doc", content: out.nodes };
  const target = { type: "doc", content: [out.nodes[0], out.nodes[1], { ...out.nodes[2], content: [...(out.nodes[2].content ?? []), { type: "text", text: "!", marks: [{ type: PENDING_MARK }] }] }] };
  assert.deepEqual(additions(base, target).segments.map((x) => x.at), [15]);
});

test("a list item added after a Docs item continues its numbering; a new list starts at 1", () => {
  const q = { list: "ordered", listId: "q", level: 0, glyph: { type: "DECIMAL", format: "%0." } };
  assert.deepEqual(
    listLabels([q, { list: null }, q, { ...q }, { list: null }, { list: "ordered" }, { list: "ordered" }, { list: "bullet" }]),
    ["1.", null, "2.", "3.", null, "1.", "2.", "\u25CF"]
  );
});

test("a Docs table is read as editable rows and cells with their index spans", async () => {
  const { importDoc } = await import("./doc-import");
  const { tokenize } = await import("./doc-model");
  const run = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, textRun: { content: text, textStyle: {} } });
  const para = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, paragraph: { elements: [run(text, startIndex)], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } });
  const cell = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + 1 + text.length, content: [para(text, startIndex + 1)], tableCellStyle: {} });
  // Row 8..18 holds cells 9..12 and 13..18; the table runs to 19, one index past its row
  const doc = {
    revisionId: "r",
    body: { content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      para("Intro\n", 1),
      { startIndex: 7, endIndex: 19, table: { rows: 1, columns: 2, tableRows: [{ startIndex: 8, endIndex: 18, tableCells: [cell("A\n", 9), cell("Bee\n", 12)] }], tableStyle: { tableColumnProperties: [{ width: { magnitude: 234, unit: "PT" } }, { width: { magnitude: 234, unit: "PT" } }] } } },
      para("After\n", 19),
    ] },
  };
  const { nodes } = importDoc(doc as never);
  const table = nodes[1];
  assert.equal(table.type, "table");
  assert.equal(table.content?.[0].content?.[0].attrs?.span, 3, "table, row and cell starts before the first cell's text");
  assert.equal(table.content?.[0].content?.[1].attrs?.span, 1, "one cell start before the second");
  const cells = table.content?.[0].content ?? [];
  assert.equal(cells.length, 2);
  assert.equal(cells[1].content?.[0].content?.[0].text, "Bee");
  assert.deepEqual(cells[0].attrs?.colwidth, [312]);
  // Index arithmetic: "After" starts at 19 in the token model too
  const toks = tokenize({ type: "doc", content: nodes });
  let at = 1;
  for (const t of toks) { if (t.k === "c" && t.c === "A" && at > 12) break; at += t.k === "st" ? t.span : t.k === "block" ? (t.node.attrs?.span as number) ?? 0 : 1; }
  assert.equal(at, 19);
  assert.equal(table.attrs?.endSpan, 2, "the row's and the table's ends");
});

test("headers, footers and footnotes are read as their own segments", async () => {
  const { importDoc } = await import("./doc-import");
  const run = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, textRun: { content: text, textStyle: {} } });
  const para = (text: string, startIndex: number, extra: Record<string, unknown>[] = []) => ({ startIndex, endIndex: startIndex + text.length, paragraph: { elements: [run(text, startIndex), ...extra], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } });
  const doc = {
    revisionId: "r",
    documentStyle: { defaultHeaderId: "kix.h", defaultFooterId: "kix.f", useFirstPageHeaderFooter: true, firstPageHeaderId: "kix.h1", marginHeader: { magnitude: 30, unit: "PT" } },
    headers: { "kix.h": { content: [para("Running head\n", 0)] }, "kix.h1": { content: [para("\n", 0)] } },
    footers: { "kix.f": { content: [para("Footer\n", 0)] } },
    footnotes: { "kix.fn1": { content: [para("A note\n", 0)] } },
    body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, para("Body", 1, [{ startIndex: 5, endIndex: 6, footnoteReference: { footnoteId: "kix.fn1", footnoteNumber: "1" } }, run("\n", 6)])] },
  };
  const out = importDoc(doc as never);
  assert.equal(out.header?.id, "kix.h");
  assert.equal(out.header?.nodes[0].content?.[0].text, "Running head");
  assert.equal(out.footer?.nodes[0].content?.[0].text, "Footer");
  assert.equal(out.firstPageHeader?.id, "kix.h1");
  assert.equal(out.useFirstPage, true);
  assert.equal(out.marginHeader, 30);
  assert.equal(out.marginFooter, 36);
  assert.equal(out.footnotes["kix.fn1"].nodes[0].content?.[0].text, "A note");
  const body = out.nodes[0];
  assert.deepEqual(body.content?.[1], { type: "footnoteRef", attrs: { fid: "kix.fn1", n: "1" } });
  assert.equal(body.attrs?.locked, undefined, "a paragraph with a footnote reference stays editable");
});

test("section breaks are read with their column layout, the first as a hidden marker", async () => {
  const { importDoc } = await import("./doc-import");
  const run = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, textRun: { content: text, textStyle: {} } });
  const para = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, paragraph: { elements: [run(text, startIndex)], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } });
  const cols = { columnProperties: [{ width: { magnitude: 225, unit: "PT" }, paddingEnd: { magnitude: 18, unit: "PT" } }, { width: { magnitude: 225, unit: "PT" }, paddingEnd: { magnitude: 0, unit: "PT" } }], columnSeparatorStyle: "BETWEEN_EACH_COLUMN", sectionType: "CONTINUOUS" };
  const doc = { revisionId: "r", body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {} } }, para("Title\n", 1), { startIndex: 7, endIndex: 9, sectionBreak: { sectionStyle: cols } }, para("Body\n", 9)] } };
  const { nodes } = importDoc(doc as never);
  assert.equal(nodes[0].content?.[0].text, "Title", "a one-column first section needs no marker");
  assert.deepEqual(nodes[1].attrs, { kind: "section", sectionType: "continuous", columns: 2, spacing: 18, line: true, locked: true, span: 2, bid: "b1" });
  // A first section in columns gets a hidden marker that occupies no indices
  const twoColFirst = { ...doc, body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: cols } }, para("Title\n", 1)] } };
  const { nodes: n2 } = importDoc(twoColFirst as never);
  assert.deepEqual(n2[0].attrs, { kind: "section", first: true, sectionType: "continuous", columns: 2, spacing: 18, line: true, locked: true, span: 0, bid: "b1" });
});

test("a merged cell: the cells it covers are left out when Docs lists them, their indices kept; nothing is left out when it doesn't", async () => {
  const { importDoc } = await import("./doc-import");
  const { directEdits } = await import("./doc-model");
  const run = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, textRun: { content: text, textStyle: {} } });
  const para = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, paragraph: { elements: [run(text, startIndex)], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } });
  const cell = (text: string, startIndex: number, style: object = {}) => ({ startIndex, endIndex: startIndex + 1 + text.length, content: [para(text, startIndex + 1)], tableCellStyle: style });
  // "Intro\n" 1..7; table at 7: row 8, cells 9 ("Wide\n" 10..15, spanning two columns) and 15 (covered, "\n" 16);
  // row 17, cells 18 ("A\n") and 21 ("B\n"); the table ends at 24; "After\n" 24..30
  const listed = {
    revisionId: "r",
    body: { content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      para("Intro\n", 1),
      { startIndex: 7, endIndex: 24, table: { rows: 2, columns: 2, tableRows: [
        { startIndex: 8, endIndex: 17, tableCells: [cell("Wide\n", 9, { columnSpan: 2, rowSpan: 1 }), cell("\n", 15, { columnSpan: 1, rowSpan: 1 })] },
        { startIndex: 17, endIndex: 24, tableCells: [cell("A\n", 18), cell("B\n", 21)] },
      ] } },
      para("After\n", 24),
    ] },
  };
  const nodes = importDoc(listed as never).nodes;
  const table = nodes.find((n) => n.type === "table")!;
  assert.deepEqual(table.content!.map((r) => r.content!.map((c) => [c.attrs?.colspan, (c.content?.[0].content ?? []).map((x) => x.text).join("")])), [[[2, "Wide"]], [[1, "A"], [1, "B"]]]);
  // Indices after the merged cell are right: typing in B and after the table goes where Docs has them
  const base = { type: "doc", content: nodes };
  const edited = JSON.parse(JSON.stringify(base));
  edited.content[1].content[1].content[1].content[0].content[0].text = "Bx";
  edited.content[2].content[0].text = "After!";
  assert.deepEqual(directEdits(base, edited).requests.filter((r) => r.insertText).map((r) => r.insertText), [{ location: { index: 29 }, text: "!" }, { location: { index: 23 }, text: "x" }]);
  // A row that doesn't list its whole grid (no covered cells in it) keeps every cell it has
  const short = JSON.parse(JSON.stringify(listed));
  short.body.content[2].table.tableRows[0].tableCells.pop();
  assert.deepEqual(importDoc(short as never).nodes.find((n) => n.type === "table")!.content!.map((r) => r.content!.length), [1, 2]);
  const odd = JSON.parse(JSON.stringify(listed));
  odd.body.content[2].table.tableRows[0].tableCells[0].tableCellStyle = {};
  assert.deepEqual(importDoc(odd as never).nodes.find((n) => n.type === "table")!.content!.map((r) => r.content!.length), [2, 2], "no merge, nothing left out");

  // A cell two rows tall and two wide: the row it covers whole has no cell of its own, as the editor's table has it
  // Table at 7: row 8, cells 9 ("Big\n" 10..14) and 14 (covered); row 16, cells 17 and 19 (covered); row 21,
  // cells 22 ("A\n") and 25 ("B\n"); the table ends at 28; "After\n" 28..34
  const tall = {
    revisionId: "r",
    body: { content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      para("Intro\n", 1),
      { startIndex: 7, endIndex: 28, table: { rows: 3, columns: 2, tableRows: [
        { startIndex: 8, endIndex: 16, tableCells: [cell("Big\n", 9, { columnSpan: 2, rowSpan: 2 }), cell("\n", 14)] },
        { startIndex: 16, endIndex: 21, tableCells: [cell("\n", 17), cell("\n", 19)] },
        { startIndex: 21, endIndex: 28, tableCells: [cell("A\n", 22), cell("B\n", 25)] },
      ] } },
      para("After\n", 28),
    ] },
  };
  const tallNodes = importDoc(tall as never).nodes;
  assert.deepEqual(tallNodes.find((n) => n.type === "table")!.content!.map((r) => r.content!.length), [1, 0, 2]);
  const tallEdited = JSON.parse(JSON.stringify(tallNodes));
  tallEdited[1].content[2].content[1].content[0].content[0].text = "Bx";
  tallEdited[2].content[0].text = "After!";
  assert.deepEqual(directEdits({ type: "doc", content: tallNodes }, { type: "doc", content: tallEdited }).requests.filter((r) => r.insertText).map((r) => r.insertText), [{ location: { index: 33 }, text: "!" }, { location: { index: 27 }, text: "x" }]);
});
