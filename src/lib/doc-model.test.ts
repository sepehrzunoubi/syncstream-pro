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
