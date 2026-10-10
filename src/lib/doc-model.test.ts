import { test } from "node:test";
import assert from "node:assert/strict";
import { additions, directEdits, hasPending, rebase, tokenize, untokenize, PENDING_MARK } from "./doc-model";
import type { EditorNode } from "./rich-text";

const ADD = { type: PENDING_MARK };
type Piece = string | { text: string; marks?: EditorNode["marks"] };
const p = (pieces: Piece[] | string, attrs: Record<string, unknown> = {}): EditorNode => ({
  type: "paragraph",
  attrs,
  content: (typeof pieces === "string" ? [pieces] : pieces)
    .filter((x) => (typeof x === "string" ? x : x.text))
    .map((x) => (typeof x === "string" ? { type: "text", text: x } : { type: "text", text: x.text, ...(x.marks?.length ? { marks: x.marks } : {}) })),
});
const add = (text: string, marks: EditorNode["marks"] = []): Piece => ({ text, marks: [...marks, ADD] });
const doc = (...paras: EditorNode[]): EditorNode => ({ type: "doc", content: paras });

// "Why?\n" is Docs indices 1–5, "Yes.\n" 6–10, "End\n" 11–14
const BASE = doc(p("Why?", { list: "ordered" }), p("Yes."), p("End"));

test("tokens round-trip", () => {
  const d = doc(p(["Hi ", { text: "there", marks: [{ type: "bold" }] }]), p(""), p("x"));
  assert.deepEqual(untokenize(tokenize(d)), d);
});

test("no changes: nothing to save and nothing to sync", () => {
  assert.deepEqual(directEdits(BASE, BASE).requests, []);
  assert.deepEqual(additions(BASE, BASE).segments, []);
});

test("bolding existing text is saved directly, at the right indices", () => {
  const target = doc(p("Why?", { list: "ordered" }), p([{ text: "Yes", marks: [{ type: "bold" }] }, "."]), p("End"));
  const { requests, saved } = directEdits(BASE, target);
  assert.deepEqual(requests, [{ updateTextStyle: { range: { startIndex: 6, endIndex: 9 }, textStyle: { bold: true }, fields: "bold" } }]);
  assert.deepEqual(saved, target);
});

test("deleting existing text is saved directly", () => {
  const target = doc(p("Why?", { list: "ordered" }), p("Y."), p("End"));
  assert.deepEqual(directEdits(BASE, target).requests, [{ deleteContentRange: { range: { startIndex: 7, endIndex: 9 } } }]);
});

test("paragraph style and list changes are saved directly", () => {
  const target = doc(p("Why?"), p("Yes.", { styleName: "h1" }), p("End"));
  const { requests } = directEdits(BASE, target);
  assert.ok(requests.some((r) => JSON.stringify(r) === JSON.stringify({ deleteParagraphBullets: { range: { startIndex: 1, endIndex: 6 } } })));
  const h1 = requests.find((r) => (r.updateParagraphStyle as { fields?: string })?.fields?.includes("namedStyleType")) as { updateParagraphStyle: { range: unknown; paragraphStyle: { namedStyleType: string } } };
  assert.deepEqual(h1.updateParagraphStyle.range, { startIndex: 6, endIndex: 11 });
  assert.equal(h1.updateParagraphStyle.paragraphStyle.namedStyleType, "HEADING_1");
});

test("joining two paragraphs deletes the break between them", () => {
  const target = doc(p("Why?", { list: "ordered" }), p("Yes.End"));
  const { requests } = directEdits(BASE, target);
  assert.ok(requests.some((r) => JSON.stringify(r) === JSON.stringify({ deleteContentRange: { range: { startIndex: 10, endIndex: 11 } } })));
});

test("an answer typed on a new line after a question is one addition, typed after the question", () => {
  const target = doc(p("Why?", { list: "ordered" }), p([add("Because I love it.")]), p("Yes."), p("End"));
  assert.deepEqual(directEdits(BASE, target).requests, [], "additions are not saved directly");
  const { segments, text } = additions(BASE, target);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].mode, "inline");
  assert.equal(segments[0].at, 5, "just before the question's paragraph break");
  assert.equal(segments[0].text, "\nBecause I love it.");
  assert.equal(text, "\nBecause I love it.");
  assert.deepEqual(segments[0].format.paragraphs.map((x) => x.list ?? null), ["ordered", null]);
});

test("additions in several places become segments in document order", () => {
  const target = doc(p(["Why", add(" not"), "?"], { list: "ordered" }), p(["Yes.", add(" Sure.")]), p("End"));
  const { segments, text, boundaries } = additions(BASE, target);
  assert.deepEqual(segments.map((s) => [s.at, s.mode, s.text]), [[4, "inline", " not"], [10, "inline", " Sure."]]);
  assert.equal(text, " not Sure.");
  assert.deepEqual(boundaries, [4]);
});

test("a new paragraph at the very top opens a paragraph before the first one", () => {
  const target = doc(p([add("Intro")]), ...BASE.content!);
  const { segments } = additions(BASE, target);
  assert.deepEqual(segments.map((s) => [s.at, s.mode, s.text]), [[1, "before", "Intro"]]);
});

test("formatting and deleting glowing text keeps it an addition; deleting it removes it", () => {
  const target = doc(p("Why?", { list: "ordered" }), p(["Yes.", add(" Bold", [{ type: "bold" }])]), p("End"));
  const seg = additions(BASE, target).segments[0];
  assert.equal(seg.text, " Bold");
  assert.equal(seg.format.runs[seg.format.runs.length - 1].b, 1);
  assert.equal(hasPending(target), true);
  assert.equal(hasPending(BASE), false);
});

test("direct edits and additions together: only the direct ones are saved", () => {
  const target = doc(p([{ text: "Why?", marks: [{ type: "italic" }] }], { list: "ordered" }), p(["Yes.", add(" More.")]), p("End"));
  const { requests, saved } = directEdits(BASE, target);
  assert.deepEqual(requests, [{ updateTextStyle: { range: { startIndex: 1, endIndex: 5 }, textStyle: { italic: true }, fields: "italic" } }]);
  assert.deepEqual(saved, doc(p([{ text: "Why?", marks: [{ type: "italic" }] }], { list: "ordered" }), p("Yes."), p("End")));
  // After saving, the addition is still found against the new base
  assert.deepEqual(additions(saved, target).segments.map((s) => [s.at, s.text]), [[10, " More."]]);
});

test("reloading after the document changed elsewhere keeps additions where they were", () => {
  const target = doc(p("Why?", { list: "ordered" }), p([add("My answer")]), p("Yes."), p("End"));
  const changed = doc(p("Title"), p("Why?", { list: "ordered" }), p("Yes."), p("End!"));
  const out = rebase(changed, target);
  assert.deepEqual(out, doc(p("Title"), p("Why?", { list: "ordered" }), p([add("My answer")]), p("Yes."), p("End!")));
});

test("text that comes back without glowing (undoing a deletion) is put back directly", () => {
  const saved = doc(p("Why?", { list: "ordered" }), p("Y."), p("End"));
  const target = doc(p("Why?", { list: "ordered" }), p("Yes."), p("End"));
  const { requests } = directEdits(saved, target);
  assert.deepEqual(requests[0], { insertText: { location: { index: 7 }, text: "es" } });
  assert.ok(requests.slice(1).every((r) => r.updateTextStyle));
});

test("line breaks and empty lines are saved directly, not synced", () => {
  const withBreak: EditorNode = doc(p("Why?", { list: "ordered" }), { type: "paragraph", attrs: {}, content: [{ type: "text", text: "Yes." }, { type: "hardBreak", marks: [{ type: PENDING_MARK }] }] }, p("End"));
  assert.deepEqual(additions(BASE, withBreak).segments, []);
  // Docs drops soft breaks sent through the API, so they go in as a new paragraph
  assert.deepEqual(directEdits(BASE, withBreak).requests[0], { insertText: { location: { index: 10 }, text: "\n" } });
  const emptyLine = doc(p("Why?", { list: "ordered" }), p("Yes."), p(""), p("End"));
  assert.deepEqual(additions(BASE, emptyLine).segments, []);
  assert.deepEqual(directEdits(BASE, emptyLine).requests[0], { insertText: { location: { index: 10 }, text: "\n" } });
});

test("reopening shows Google's copy: only additions come back, not edits Google never got", () => {
  const google = doc(p("Why?", { list: "ordered" }), p("Yes.End"));
  // Last time the editor had a line break Google dropped, a split it never got, and one addition
  const shown = doc(
    p(["Why?", add(" Now")], { list: "ordered" }),
    { type: "paragraph", attrs: {}, content: [{ type: "text", text: "Ye" }, { type: "hardBreak" }, { type: "text", text: "s." }] },
    p("End"),
  );
  assert.deepEqual(rebase(google, shown), doc(p(["Why?", add(" Now")], { list: "ordered" }), p("Yes.End")));
});

test("indenting a list item re-makes its whole list with each item at its level", async () => {
  const { directEdits } = await import("./doc-model");
  const li = (text: string, level: number) => ({ type: "paragraph", attrs: { list: "bullet", level }, content: [{ type: "text", text }] });
  const base = { type: "doc", content: [li("one", 0), li("two", 0), li("three", 0)] };
  const target = { type: "doc", content: [li("one", 0), li("two", 1), li("three", 0)] };
  const { requests } = directEdits(base, target);
  const del = requests.find((r) => r.deleteParagraphBullets) as { deleteParagraphBullets: { range: { startIndex: number; endIndex: number } } };
  assert.deepEqual(del.deleteParagraphBullets.range, { startIndex: 1, endIndex: 15 }, "the whole run");
  const tab = requests.find((r) => r.insertText) as { insertText: { location: { index: number }; text: string } };
  assert.deepEqual(tab.insertText, { location: { index: 5 }, text: "\t" }, "one tab in front of 'two'");
  const create = requests.find((r) => r.createParagraphBullets) as { createParagraphBullets: { range: { startIndex: number; endIndex: number } } };
  assert.deepEqual(create.createParagraphBullets.range, { startIndex: 1, endIndex: 16 }, "the run plus the tab Docs will remove");
  assert.ok(requests.indexOf(tab) < requests.indexOf(create) && requests.indexOf(del) < requests.indexOf(tab));
});

test("page breaks and section breaks are saved as Docs inserts them", async () => {
  const { directEdits, additions, signature } = await import("./doc-model");
  const p = (content: Record<string, unknown>[], attrs: Record<string, unknown> = {}) => ({ type: "paragraph", attrs, content });
  const t = (text: string) => ({ type: "text", text });
  const base = { type: "doc", content: [p([t("one two")]), p([t("three")])] };
  // Ctrl+Enter after "one": the paragraph splits with a page break at the end of the first half
  const target = { type: "doc", content: [p([t("one"), { type: "pageBreak" }]), p([t(" two")]), p([t("three")])] };
  const { requests, saved } = directEdits(base, target);
  assert.deepEqual(requests, [{ insertPageBreak: { location: { index: 4 } } }]);
  assert.equal(signature(saved), "one\u000C\n two\nthree\n");
  // A section break after the first paragraph
  const withSection = { type: "doc", content: [p([t("one two")]), p([], { locked: true, kind: "section", sectionType: "continuous" }), p([t("three")])] };
  const r2 = directEdits(base, withSection);
  assert.deepEqual(r2.requests, [{ insertSectionBreak: { location: { index: 9 }, sectionType: "CONTINUOUS" } }]);
  // Docs puts a newline before the break: an empty paragraph, then the break covering one index
  assert.equal(r2.saved.content?.[1].type, "paragraph");
  assert.equal((r2.saved.content?.[1].content ?? []).length, 0);
  assert.equal(r2.saved.content?.[2].attrs?.kind, "section");
  assert.equal(r2.saved.content?.[2].attrs?.span, 1);
  // A page break typed inside an addition travels with the text as a form feed and newline
  const added = { type: "doc", content: [p([t("one two")]), p([t("three"), { type: "text", text: "new", marks: [{ type: "syncAdd" }] }, { type: "pageBreak", marks: [{ type: "syncAdd" }] }]), p([{ type: "text", text: "next page", marks: [{ type: "syncAdd" }] }])] };
  const { segments } = additions(base, added);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "new\u000C\nnext page");
});

test("tables: cells are editable paragraphs between structure tokens that keep Docs' indices", async () => {
  const { tokenize, untokenize, directEdits, additions, signature } = await import("./doc-model");
  const p = (text: string, marks?: { type: string }[]) => ({ type: "paragraph", attrs: {}, content: text ? [marks ? { type: "text", text, marks } : { type: "text", text }] : [] });
  const cell = (cid: string, ...paras: Record<string, unknown>[]) => ({ type: "tableCell", attrs: { cid, span: 1 }, content: paras });
  const row = (rid: string, ...cells: Record<string, unknown>[]) => ({ type: "tableRow", attrs: { rid, span: 1 }, content: cells });
  const table = (tid: string, ...rows: Record<string, unknown>[]) => ({ type: "table", attrs: { tid, span: 1 }, content: rows });
  // "Intro\n" (indices 1-6), table at 7: table(1) row(1) cell(1) "A\n"(2) cell(1) "B\n"(2) row(1) cell(1) "C\n" cell(1) "D\n", then "After\n"
  const base = { type: "doc", content: [p("Intro"), table("t1", row("r0", cell("c0", p("A")), cell("c1", p("B"))), row("r1", cell("c0", p("C")), cell("c1", p("D")))), p("After")] };
  const toks = tokenize(base);
  assert.deepEqual(untokenize(toks), base, "a table survives the round trip");
  assert.equal(signature(base), "Intro\n\u0000t1\u0000\u0000r1\u0000\u0000c1\u0000A\n\u0000c0\u0000\u0000c1\u0000B\n\u0000c0\u0000\u0000r0\u0000\u0000r1\u0000\u0000c1\u0000C\n\u0000c0\u0000\u0000c1\u0000D\n\u0000c0\u0000\u0000r0\u0000\u0000t0\u0000After\n");
  // Typing in cell D (its text starts at index 7+1+1+1+2+1+2+1+1+2+1 = 20): a direct edit at that index
  const edited = { type: "doc", content: [p("Intro"), table("t1", row("r0", cell("c0", p("A")), cell("c1", p("B"))), row("r1", cell("c0", p("C")), cell("c1", p("Dx")))), p("After")] };
  const r1 = directEdits(base, edited);
  assert.deepEqual(r1.requests.filter((r) => r.insertText), [{ insertText: { location: { index: 21 }, text: "x" } }]);
  // An addition in cell B goes to index 13
  const added = { type: "doc", content: [p("Intro"), table("t1", row("r0", cell("c0", p("A")), cell("c1", { type: "paragraph", attrs: {}, content: [{ type: "text", text: "B" }, { type: "text", text: "!", marks: [{ type: "syncAdd" }] }] })), row("r1", cell("c0", p("C")), cell("c1", p("D")))), p("After")] };
  assert.deepEqual(additions(base, added).segments.map((s) => [s.at, s.text]), [[14, "!"]]);
  // A new row after the first: one insertTableRow below row 0, and nothing else until the document is read back
  const withRow = { type: "doc", content: [p("Intro"), table("t1", row("r0", cell("c0", p("A")), cell("c1", p("B"))), { type: "tableRow", attrs: {}, content: [{ type: "tableCell", attrs: {}, content: [p("")] }, { type: "tableCell", attrs: {}, content: [p("")] }] }, row("r1", cell("c0", p("C")), cell("c1", p("D")))), p("After")] };
  const r2 = directEdits(base, withRow);
  assert.equal(r2.structural, true);
  assert.deepEqual(r2.requests, [{ insertTableRow: { tableCellLocation: { tableStartLocation: { index: 7 }, rowIndex: 0, columnIndex: 0 }, insertBelow: true } }]);
  // A new column at the end, and a deleted row
  const reshaped = { type: "doc", content: [p("Intro"), table("t1", row("r0", cell("c0", p("A")), cell("c1", p("B")), { type: "tableCell", attrs: {}, content: [p("")] })), p("After")] };
  const r3 = directEdits(base, reshaped);
  assert.deepEqual(r3.requests, [
    { insertTableColumn: { tableCellLocation: { tableStartLocation: { index: 7 }, rowIndex: 0, columnIndex: 1 }, insertRight: true } },
    { deleteTableRow: { tableCellLocation: { tableStartLocation: { index: 7 }, rowIndex: 1, columnIndex: 0 } } },
  ]);
  // A brand-new table before "After" is inserted empty at its index; a removed table is deleted whole
  const fresh = { type: "doc", content: [p("Intro"), table("t1", row("r0", cell("c0", p("A")), cell("c1", p("B"))), row("r1", cell("c0", p("C")), cell("c1", p("D")))), { type: "table", attrs: {}, content: [{ type: "tableRow", attrs: {}, content: [{ type: "tableCell", attrs: {}, content: [p("new")] }] }] }, p("After")] };
  assert.deepEqual(directEdits(base, fresh).requests, [{ insertTable: { rows: 1, columns: 1, location: { index: 22 } } }]);
  const gone = { type: "doc", content: [p("Intro"), p("After")] };
  assert.deepEqual(directEdits(base, gone).requests, [{ deleteContentRange: { range: { startIndex: 7, endIndex: 22 } } }]);
});

test("a header's edits are saved in its own segment, from index 0, never as additions", async () => {
  const { segmentEdits } = await import("./doc-model");
  const p = (text: string, marks?: { type: string }[]) => ({ type: "paragraph", attrs: {}, content: text ? [marks ? { type: "text", text, marks } : { type: "text", text }] : [] });
  const base = { type: "doc", content: [p("My essay")] };
  const target = { type: "doc", content: [p("My essay, draft"), p("Page", [{ type: "syncAdd" }])] };
  const { requests } = segmentEdits(base, target, "kix.h1");
  assert.deepEqual(requests.filter((r) => r.insertText), [
    { insertText: { location: { index: 8, segmentId: "kix.h1" }, text: ", draft\nPage" } },
  ]);
  for (const r of requests) {
    const body = Object.values(r)[0] as { range?: { segmentId?: string }; location?: { segmentId?: string } };
    assert.equal((body.range ?? body.location)?.segmentId, "kix.h1");
  }
});

test("columns: sections group into column sections for the editor and restyle the section in Docs", async () => {
  const { tokenize, untokenize, directEdits } = await import("./doc-model");
  const p = (text: string) => ({ type: "paragraph", attrs: {}, content: text ? [{ type: "text", text }] : [] });
  const first = (columns: number) => ({ type: "paragraph", attrs: { kind: "section", first: true, locked: true, span: 0, bid: "b0", columns, spacing: 36, line: false, textWidth: 468 }, content: [] });
  const brk = (columns: number) => ({ type: "paragraph", attrs: { kind: "section", locked: true, span: 2, bid: "b1", columns, spacing: 18, line: true, textWidth: 468 }, content: [] });
  const flat = { type: "doc", content: [first(1), p("Title"), brk(2), p("Left"), p("Right")] };
  const grouped = untokenize(tokenize(flat));
  assert.equal(grouped.content?.length, 4);
  assert.equal(grouped.content?.[3].type, "columnSection");
  assert.deepEqual(grouped.content?.[3].attrs, { columns: 2, spacing: 18, line: true });
  assert.equal(grouped.content?.[3].content?.length, 2);
  assert.deepEqual(tokenize(grouped), tokenize(flat), "the grouping changes nothing in the document");
  // Setting the first section to two columns: updateSectionStyle over its content, up to the break
  const twoCols = { type: "doc", content: [first(2), p("Title"), brk(2), p("Left"), p("Right")] };
  const { requests } = directEdits(flat, twoCols);
  assert.deepEqual(requests, [{
    updateSectionStyle: {
      range: { startIndex: 1, endIndex: 7 },
      sectionStyle: { columnProperties: [{ width: { magnitude: 216, unit: "PT" }, paddingEnd: { magnitude: 36, unit: "PT" } }, { width: { magnitude: 216, unit: "PT" }, paddingEnd: { magnitude: 0, unit: "PT" } }], columnSeparatorStyle: "NONE" },
      fields: "columnProperties,columnSeparatorStyle",
    },
  }]);
  // Back to one column in the second section: an empty column list
  const oneCol = { type: "doc", content: [first(1), p("Title"), { ...brk(1), attrs: { ...brk(1).attrs, columns: 1 } }, p("Left"), p("Right")] };
  const r2 = directEdits(flat, oneCol).requests[0].updateSectionStyle as { range: { startIndex: number; endIndex: number }; sectionStyle: { columnProperties: unknown[] } };
  assert.deepEqual(r2.range, { startIndex: 9, endIndex: 20 });
  assert.deepEqual(r2.sectionStyle.columnProperties, []);
});

test("deleting across a section break removes the text on both sides and keeps the break", () => {
  // "Alpha one\n" is indices 1–10, the break 11, "Gamma three\n" 12–23
  const brk = p([], { locked: true, kind: "section", sectionType: "next", span: 1, bid: "b1" });
  const base = doc(p("Alpha one"), brk, p("Gamma three"));
  const target = doc(p("Alpha"), brk, p("three"));
  const { requests, saved, structural } = directEdits(base, target);
  assert.ok(!structural);
  assert.deepEqual(requests, [
    { deleteContentRange: { range: { startIndex: 12, endIndex: 18 } } },
    { deleteContentRange: { range: { startIndex: 6, endIndex: 10 } } },
  ]);
  assert.deepEqual(saved, target);
  // Every paragraph around two breaks emptied (Select all, Delete): the breaks stay, the paragraphs stay separate
  const brk2 = p([], { locked: true, kind: "section", sectionType: "next", span: 1, bid: "b2" });
  const base2 = doc(p("Alpha"), brk, p("Beta"), brk2, p("Gamma"));
  const target2 = doc(p(""), brk, p(""), brk2, p(""));
  // "Alpha\n" 1–6, break 7, "Beta\n" 8–12, break 13, "Gamma\n" 14–19
  assert.deepEqual(directEdits(base2, target2).requests, [
    { deleteContentRange: { range: { startIndex: 14, endIndex: 19 } } },
    { deleteContentRange: { range: { startIndex: 8, endIndex: 12 } } },
    { deleteContentRange: { range: { startIndex: 1, endIndex: 6 } } },
  ]);
  assert.deepEqual(directEdits(base2, target2).saved, target2);
});

test("deleting across a table removes the text on both sides and keeps the table as it is", () => {
  const cell = (cid: string, text: string) => ({ type: "tableCell", attrs: { cid, span: 1 }, content: [p(text)] });
  const row = (rid: string, ...cells: Record<string, unknown>[]) => ({ type: "tableRow", attrs: { rid, span: 1 }, content: cells });
  const table = { type: "table", attrs: { tid: "t1", span: 1 }, content: [row("r0", cell("c0", "A"), cell("c1", "B"))] };
  // "Intro one\n" 1–10, table at 11: table(1) row(1) cell(1) "A\n" cell(1) "B\n" = 11–18, "After two\n" 19–28
  const base = doc(p("Intro one"), table, p("After two"));
  const target = doc(p("Intro"), table, p("two"));
  const { requests, saved, structural } = directEdits(base, target);
  assert.ok(!structural, "the table's shape did not change");
  assert.deepEqual(requests, [
    { deleteContentRange: { range: { startIndex: 19, endIndex: 25 } } },
    { deleteContentRange: { range: { startIndex: 6, endIndex: 10 } } },
  ]);
  assert.deepEqual(saved, target);
});
