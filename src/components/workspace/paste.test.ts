import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { editorExtensions } from "./extensions";
import { breaksAsParagraphs, insertParagraphs, plainSpaces, restyleText } from "./paste";
import { readDocsSlice, sliceParagraphs } from "@/lib/docs-slice";
import type { DocDefaults } from "@/lib/doc-import";
import type { EditorNode } from "@/lib/rich-text";

const schema = getSchema(editorExtensions);
const ARIAL: DocDefaults = { fontFamily: "Arial", fontSize: 11, lineSpacing: 115, styles: {} };
const FIXTURES = path.join(__dirname, "..", "..", "..", "fixtures", "clipboard");

const para = (text: string, attrs: Record<string, unknown> = {}, marks: EditorNode["marks"] = []) =>
  schema.nodeFromJSON({ type: "paragraph", attrs, content: text ? [{ type: "text", text, ...(marks?.length ? { marks } : {}) }] : [] });

/** A stand-in for the editor view: a state, and dispatch that applies to it */
function viewOf(doc: PMNode, from: number, to = from) {
  const view = {
    state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, from, to) }),
    dispatched: [] as Transaction[],
    dispatch(tr: Transaction) { this.dispatched.push(tr); this.state = this.state.apply(tr); },
    dom: { dataset: {} },
  };
  return view as typeof view & EditorView;
}
const texts = (doc: PMNode) => { const out: string[] = []; doc.forEach((p) => out.push(p.textContent)); return out; };
const styles = (doc: PMNode) => { const out: string[] = []; doc.forEach((p) => out.push(p.attrs.styleName)); return out; };
/** The text the transaction's replace steps put in: what the sync would see as additions */
const inserted = (trs: Transaction[]) => trs.flatMap((tr) => tr.steps.filter((s): s is ReplaceStep => s instanceof ReplaceStep).map((s) => s.slice.content.textBetween(0, s.slice.content.size, "|")));

test("a whole copied document goes in before the empty paragraph it's pasted into, as in Docs", () => {
  const plain = fs.readFileSync(path.join(FIXTURES, "web-structured-data.txt"), "utf8");
  const slice = readDocsSlice(fs.readFileSync(path.join(FIXTURES, "web-structured-data.slice.json"), "utf8"), plain)!;
  // Ctrl+A leaves out the document's last, empty paragraph: the copy ends with the newline before it
  assert.equal(slice.endsWithParagraph, true);
  const nodes = sliceParagraphs(slice, ARIAL).map((n) => schema.nodeFromJSON(n));
  const view = viewOf(schema.node("doc", null, [para("", { lineSpacing: 200 })]), 1);
  assert.equal(insertParagraphs(view, nodes, slice.endsWithParagraph, ARIAL), true);
  // Its 45 paragraphs, then the one pasted into, still empty and as it was: 46, as the copied document has
  assert.equal(view.state.doc.childCount, 46);
  assert.equal(texts(view.state.doc).join("\n"), plain);
  assert.equal(view.state.doc.lastChild!.attrs.lineSpacing, 200);
  for (let k = 0; k < 45; k++) assert.deepEqual(view.state.doc.child(k).attrs, nodes[k].attrs, `paragraph ${k}`);
  // The caret ends in that last paragraph
  assert.equal(view.state.selection.from, view.state.doc.content.size - 1);
});

test("pasted into a paragraph: the first part takes the pasted format, the rest keeps its own", () => {
  const doc = schema.node("doc", null, [para("Hello world")]);
  const view = viewOf(doc, 7); // "Hello |world"
  const pasted = [para("Heading", { styleName: "h2" }), para("Body"), para("")];
  // A copy that ends with its last paragraph's newline
  assert.equal(insertParagraphs(view, pasted.slice(0, 2), true, ARIAL), true);
  assert.deepEqual(texts(view.state.doc), ["Hello Heading", "Body", "world"]);
  assert.deepEqual(styles(view.state.doc), ["h2", "normal", "normal"]);
  // Only the pasted text goes in: "Hello " and "world" were there already
  // (the open end of the pasted slice is the empty paragraph "world" joins)
  assert.deepEqual(inserted(view.dispatched), ["Heading|Body|"]);
  // The caret ends where the paste does
  assert.equal(view.state.selection.from, view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize + 1);
});

test("a copy ending mid-paragraph joins the text after the caret, keeping its own look", () => {
  const doc = schema.node("doc", null, [para("Hello world")]);
  const view = viewOf(doc, 7);
  // The heading's text has no size of its own: its style gives 20pt
  assert.equal(insertParagraphs(view, [para("One"), para("Big", { styleName: "h1" })], false, ARIAL), true);
  assert.deepEqual(texts(view.state.doc), ["Hello One", "Bigworld"]);
  assert.deepEqual(styles(view.state.doc), ["normal", "normal"]);
  const big = view.state.doc.child(1).child(0);
  assert.equal(big.text, "Big");
  assert.equal(big.marks.find((m) => m.type.name === "textStyle")?.attrs.fontSize, 20);
});

test("text copied from inside one paragraph goes in as text", () => {
  const view = viewOf(schema.node("doc", null, [para("Hello world", { styleName: "h3" })]), 7);
  assert.equal(insertParagraphs(view, [para("there ")], false, ARIAL), true);
  assert.deepEqual(texts(view.state.doc), ["Hello there world"]);
  assert.deepEqual(styles(view.state.doc), ["h3"]);
});

test("pasting over whole paragraphs replaces them; a partly copied last one keeps its format", () => {
  const doc = schema.node("doc", null, [para("Keep"), para("One"), para("Two"), para("End")]);
  // Select "One" through "Two", whole paragraphs
  const from = doc.child(0).nodeSize + 1;
  const to = from + doc.child(1).nodeSize + doc.child(2).nodeSize - 2;
  const view = viewOf(doc, from, to);
  assert.equal(insertParagraphs(view, [para("A", { textAlign: "center" }), para("B", { textAlign: "justify" })], false, ARIAL), true);
  assert.deepEqual(texts(view.state.doc), ["Keep", "A", "B", "End"]);
  assert.deepEqual([view.state.doc.child(1).attrs.textAlign, view.state.doc.child(2).attrs.textAlign], ["center", "justify"]);
});

test("a selection reaching into a locked paragraph is left to the usual paste", () => {
  const doc = schema.node("doc", null, [para("One"), para("Table", { locked: true }), para("Two")]);
  const view = viewOf(doc, 2, doc.content.size - 2);
  assert.equal(insertParagraphs(view, [para("X"), para("Y")], true, ARIAL), false);
  assert.equal(view.dispatched.length, 0);
});

test("non-breaking spaces from HTML become the spaces the copy's text has", () => {
  const nb = "\u00a0";
  const out = plainSpaces([para(`a${nb}b${nb}${nb}c`), para(`keep${nb}this`)], "a b  c\nkeep\u00a0this\n");
  assert.deepEqual(out.map((p) => p.textContent), ["a b  c", `keep${nb}this`]);
  // Text that doesn't line up is left alone
  const odd = [para(`x${nb}y`)];
  assert.equal(plainSpaces(odd, "something else")[0], odd[0]);
});

test("restyleText drops what the style gives and keeps what it doesn't", () => {
  const run = (marks: EditorNode["marks"]) => para("t", {}, marks).content;
  const ts = (attrs: Record<string, unknown>) => [{ type: "textStyle", attrs: { fontFamily: null, fontSize: null, color: null, fontWeight: null, ...attrs } }];
  const marksOf = (f: ReturnType<typeof run>) => f.child(0).marks.map((m) => ({ type: m.type.name, ...m.attrs }));
  // HTML spells out the style's own values: nothing is left
  assert.deepEqual(marksOf(restyleText(run(ts({ fontFamily: "Arial", fontSize: 20, color: "rgb(0, 0, 0)" })), "h1", "h1", ARIAL)), []);
  // Another font and colour stay, as hex
  assert.deepEqual(marksOf(restyleText(run([{ type: "highlight", attrs: { color: "rgb(255, 242, 204)" } }, ...ts({ fontFamily: "Georgia", color: "rgb(255, 0, 0)" })]), "normal", "normal", ARIAL)), [
    { type: "textStyle", fontFamily: "Georgia", fontSize: null, color: "#ff0000", fontWeight: null },
    { type: "highlight", color: "#fff2cc" },
  ]);
  // From a subtitle (15pt, grey in Docs) into normal text: it keeps its size and colour
  const grey: DocDefaults = { ...ARIAL, styles: { subtitle: { color: "#666666" } } };
  assert.deepEqual(marksOf(restyleText(run([]), "subtitle", "normal", grey)), [{ type: "textStyle", fontFamily: null, fontSize: 15, color: "#666666", fontWeight: null }]);
});

test("a line break or an image inside a pasted run is restyled with the run", () => {
  // Docs' HTML puts a soft line break (and an image) inside the run's span, so it carries every value the span spells out
  const spelled = [{ type: "textStyle", attrs: { fontFamily: "Arial", fontSize: 11, color: "rgb(0, 0, 0)", fontWeight: null } }];
  const red = [{ type: "textStyle", attrs: { fontFamily: "Arial", fontSize: 11, color: "rgb(255, 0, 0)", fontWeight: null } }];
  const p = schema.nodeFromJSON({ type: "paragraph", content: [
    { type: "text", text: "a", marks: spelled }, { type: "hardBreak", marks: spelled }, { type: "text", text: "b", marks: spelled },
    { type: "image", attrs: { src: "https://lh7-rt.googleusercontent.com/x" }, marks: spelled }, { type: "image", attrs: { src: "https://lh7-rt.googleusercontent.com/y" }, marks: red },
  ] });
  const out = restyleText(p.content, "normal", "normal", ARIAL);
  assert.deepEqual(Array.from({ length: out.childCount }, (_, i) => out.child(i).marks.map((m) => m.attrs.color ?? m.type.name)), [[], [], [], [], ["#ff0000"]]);
});

test("text pasted over a selection from a heading into the next paragraph keeps its own look", () => {
  const doc = schema.node("doc", null, [para("Hello world", { styleName: "h2" }), para("Item one", { list: "bullet", level: 0 })]);
  // "Hel[lo world" … "Item] one": the paragraph left is the heading, as when typing over the selection
  const view = viewOf(doc, 4, doc.child(0).nodeSize + 5);
  assert.equal(insertParagraphs(view, [para("body text")], false, ARIAL), true);
  assert.deepEqual(texts(view.state.doc), ["Helbody text one"]);
  assert.deepEqual(styles(view.state.doc), ["h2"]);
  const run = view.state.doc.child(0).child(1);
  assert.equal(run.text, "body text");
  assert.equal(run.marks.find((m) => m.type.name === "textStyle")?.attrs.fontSize, 11);
});

// ── Line breaks: the paragraphs the sync makes of them, drawn as the breaks were ──

const BR = { type: "hardBreak" } as const;
const withBreaks = (attrs: Record<string, unknown>, ...lines: string[]) =>
  schema.nodeFromJSON({ type: "paragraph", attrs, content: lines.flatMap((t, i) => [...(i ? [BR] : []), ...(t ? [{ type: "text", text: t }] : [])]) });
const look = (doc: PMNode) => { const out: unknown[] = []; doc.forEach((p) => out.push([p.textContent, p.attrs.list, p.attrs.box])); return out; };
const breaksIn = (doc: PMNode) => { let n = 0; doc.descendants((c) => { if (c.type.name === "hardBreak") n++; }); return n; };

test("a pasted list item with a line break: the item, then its next line where its text starts, with no glyph", () => {
  // The lists capture: "This item has line breaks.⏎Here is a second line." in a bulleted and a numbered list
  const file = (name: string) => fs.readFileSync(path.join(FIXTURES, "corpus", "lists", name), "utf8");
  const slice = readDocsSlice(file("full-slice.json"), file("full.txt"))!;
  const nodes = sliceParagraphs(slice, ARIAL).map((n) => schema.nodeFromJSON(n));
  assert.equal(nodes.filter((n) => n.textContent.includes("line breaks")).length, 2);
  const view = viewOf(schema.node("doc", null, [para("")]), 1);
  assert.equal(insertParagraphs(view, nodes, slice.endsWithParagraph, ARIAL), true);
  const doc = view.state.doc;
  assert.equal(breaksIn(doc), 0);
  assert.equal(doc.childCount, nodes.length + 1 + 2);
  const items: PMNode[] = [];
  doc.forEach((p, _o, i) => { if (p.textContent === "This item has line breaks.") items.push(p, doc.child(i + 1)); });
  assert.equal(items.length, 4);
  for (const [item, line] of [items.slice(0, 2), items.slice(2)]) {
    assert.ok(item.attrs.list);
    assert.equal(item.attrs.box.below, 0);
    assert.equal(line.textContent, "Here is a second line.");
    assert.equal(line.attrs.list, null);
    assert.equal(line.attrs.glyphStyle, null);
    // Where the item's text starts, no first-line indent, no space between the lines
    assert.deepEqual(line.attrs.box, { start: (item.attrs.level ?? 0) * 36 + 36, first: 0, above: 0, below: 0 });
  }
});

test("a pasted paragraph's lines keep its indent, its first-line indent only on the first, its spacing at the ends", () => {
  const view = viewOf(schema.node("doc", null, [para("")]), 1);
  const pasted = withBreaks({ box: { start: 36, first: 18, above: 10, below: 12 }, textAlign: "center", lineSpacing: 150 }, "one", "two", "three");
  assert.equal(insertParagraphs(view, [pasted, para("after")], true, ARIAL), true);
  assert.deepEqual(look(view.state.doc), [
    ["one", null, { start: 36, first: 18, above: 10, below: 0 }],
    ["two", null, { start: 36, first: 0, above: 0, below: 0 }],
    ["three", null, { start: 36, first: 0, above: 0, below: 12 }],
    ["after", null, null],
    ["", null, null],
  ]);
  // Each line is the same paragraph otherwise
  for (let k = 0; k < 3; k++) assert.deepEqual([view.state.doc.child(k).attrs.textAlign, view.state.doc.child(k).attrs.lineSpacing], ["center", 150]);
});

test("a line break in a heading: its style's space above on the first line, below on the last", () => {
  const view = viewOf(schema.node("doc", null, [para("")]), 1);
  assert.equal(insertParagraphs(view, [withBreaks({ styleName: "h2", indent: 1, firstLine: true }, "a", "b")], true, ARIAL), true);
  assert.deepEqual(look(view.state.doc).slice(0, 2), [["a", null, { start: 36, first: 36, above: 18, below: 0 }], ["b", null, { start: 36, first: 0, above: 0, below: 6 }]]);
  assert.deepEqual(styles(view.state.doc).slice(0, 2), ["h2", "h2"]);
  assert.deepEqual([view.state.doc.child(0).attrs.indent, view.state.doc.child(1).attrs.indent], [0, 0]);
});

test("items that leave out their space next to each other keep it out around a line break", () => {
  const item = (text: string[], extra: Record<string, unknown> = {}) => withBreaks({ list: "bullet", level: 1, box: { start: 72, marker: -18, above: 6, below: 6 }, ...extra }, ...text);
  const view = viewOf(schema.node("doc", null, [para("")]), 1);
  assert.equal(insertParagraphs(view, [item(["one", "its line"]), item(["two"]), item(["kept", "its line"], { spacingMode: "NEVER_COLLAPSE" }), item(["three"])], true, ARIAL), true);
  assert.deepEqual(look(view.state.doc).slice(0, 6), [
    ["one", "bullet", { start: 72, marker: -18, above: 6, below: 0 }],
    // Next to item two, which had no space above it next to item one, and still has none
    ["its line", null, { start: 72, first: 0, above: 0, below: 0 }],
    ["two", "bullet", { start: 72, marker: -18, above: 0, below: 6 }],
    // An item that keeps its space keeps it below its last line; the next one leaves out its own
    ["kept", "bullet", { start: 72, marker: -18, above: 6, below: 0 }],
    ["its line", null, { start: 72, first: 0, above: 0, below: 6 }],
    ["three", "bullet", { start: 72, marker: -18, above: 0, below: 6 }],
  ]);
  // In a document whose Normal text keeps list spacing, nothing is left out
  const keeps = viewOf(schema.node("doc", null, [para("")]), 1);
  assert.equal(insertParagraphs(keeps, [item(["one", "its line"]), item(["two"])], true, { ...ARIAL, spacingMode: "NEVER_COLLAPSE" }), true);
  assert.deepEqual(look(keeps.state.doc).slice(1, 3), [["its line", null, { start: 72, first: 0, above: 0, below: 6 }], ["two", "bullet", { start: 72, marker: -18, above: 6, below: 6 }]]);
});

test("lines pasted into a list item take its format; the caret stays after them", () => {
  const doc = schema.node("doc", null, [para("XY", { list: "ordered", level: 0, box: { start: 36, marker: -18, above: null, below: null }, bid: "b1" })]);
  const view = viewOf(doc, 2); // "X|Y"
  assert.equal(insertParagraphs(view, [withBreaks({ styleName: "h1" }, "a", "b")], false, ARIAL), true);
  assert.deepEqual(look(view.state.doc), [["Xa", "ordered", { start: 36, marker: -18, above: 0, below: 0 }], ["bY", null, { start: 36, first: 0, above: 0, below: 0 }]]);
  // The paragraph pasted into keeps its identity; the line split from it is new
  assert.deepEqual([view.state.doc.child(0).attrs.bid, view.state.doc.child(1).attrs.bid], ["b1", null]);
  assert.equal(view.state.selection.from, view.state.doc.child(0).nodeSize + 2);
});

test("line breaks outside what was pasted are left as they are", () => {
  const doc = schema.node("doc", null, [withBreaks({}, "kept", "as is"), para("end")]);
  const state = EditorState.create({ schema, doc });
  // Only the second paragraph is the paste
  const tr = breaksAsParagraphs(state.tr, doc.child(0).nodeSize, doc.content.size, ARIAL);
  assert.equal(tr.docChanged, false);
  // A line break in a locked paragraph (a table, a chip) is never split
  const locked = schema.node("doc", null, [withBreaks({ locked: true }, "a", "b")]);
  assert.equal(breaksAsParagraphs(EditorState.create({ schema, doc: locked }).tr, 0, locked.content.size, ARIAL).docChanged, false);
});

test("pasted HTML's images given as data are shown from blob: addresses until they are uploaded; others stay as they are", async () => {
  const { pastedImageSources, isUploadingImage } = await import("./pasted-images");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const out = pastedImageSources(`<p>a<img width="24" src="${png}">b<img src='https://lh7-rt.googleusercontent.com/x'><img src="data:text/html;base64,PGI+"></p>`);
  const srcs = Array.from(out.matchAll(/src=(["'])([^"']*)\1/g), (m) => m[2]);
  assert.match(srcs[0], /^blob:/);
  assert.equal(isUploadingImage(srcs[0]), true);
  assert.equal(srcs[1], "https://lh7-rt.googleusercontent.com/x");
  // Not an image: left for the editor to drop
  assert.equal(srcs[2], "data:text/html;base64,PGI+");
  assert.equal(isUploadingImage(srcs[1]), false);
  // The same image twice in a copy: one address, so one upload
  const twice = Array.from(pastedImageSources(`<p><img src="${png}"><img src='${png}'></p>`).matchAll(/src=(["'])([^"']*)\1/g), (m) => m[2]);
  assert.match(twice[0], /^blob:/);
  assert.equal(twice[1], twice[0]);
  // Nothing to do
  const plain = "<p>no images</p>";
  assert.equal(pastedImageSources(plain), plain);
});
