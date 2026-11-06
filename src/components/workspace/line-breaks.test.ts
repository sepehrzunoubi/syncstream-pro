import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { DecorationSet } from "@tiptap/pm/view";
import { editorExtensions } from "./extensions";
import { DocsLineBreaks, hyphenRanges } from "./line-breaks";

const schema = getSchema(editorExtensions);
const para = (...runs: (string | { text: string; bold?: boolean })[]) =>
  schema.nodeFromJSON({
    type: "paragraph",
    content: runs.map((r) => (typeof r === "string" ? { type: "text", text: r } : { type: "text", text: r.text, ...(r.bold ? { marks: [{ type: "bold" }] } : {}) })),
  });
const covered = (block: PMNode) => hyphenRanges(block, 0).map(([a, b]) => block.textBetween(a, b));

test("a hyphen inside a word is kept with the character after it", () => {
  assert.deepEqual(covered(para("on up-to-date data")), ["-t", "-d"]);
  // Not a hyphen between words, or one with a space on either side: lines can break there
  assert.deepEqual(covered(para("pros - cons, -1, re- and x")), []);
  assert.deepEqual(covered(para("COVID-19")), ["-1"]);
  // Across runs in different formats
  assert.deepEqual(covered(para({ text: "well-", bold: true }, "known")), ["-k"]);
  // A character outside the basic plane is kept whole
  assert.deepEqual(covered(para("a-\u{1F600}")), ["-\u{1F600}"]);
});

test("editing keeps the hyphens' spans where a fresh layout would put them", () => {
  const doc = schema.node("doc", null, [para("one-two three"), para("four five-six")]);
  // The plugin as the editor has it
  const plugins = DocsLineBreaks.config.addProseMirrorPlugins!.call({} as never);
  let state = EditorState.create({ schema, doc, plugins });
  const spans = (s: EditorState) => {
    const set = plugins[0].getState(s) as DecorationSet;
    return set.find().map((d) => s.doc.textBetween(d.from, d.to)).sort();
  };
  assert.deepEqual(spans(state), ["-s", "-t"]);
  const edits = [
    (s: EditorState) => s.tr.insertText("-x", 4), // "one-x-two"
    (s: EditorState) => s.tr.delete(1, 5), // drops "one-"
    (s: EditorState) => s.tr.split(3), // splits a word with a hyphen in it
    (s: EditorState) => s.tr.insertText("re-", s.doc.content.size - 1),
    (s: EditorState) => s.tr.join(s.doc.child(0).nodeSize),
  ];
  for (const edit of edits) {
    state = state.apply(edit(state));
    const fresh = EditorState.create({ schema, doc: state.doc, plugins });
    assert.deepEqual(spans(state), spans(fresh), state.doc.textContent);
  }
});
