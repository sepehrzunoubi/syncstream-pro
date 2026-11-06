import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { editorExtensions, lineSize } from "./extensions";

const schema = getSchema(editorExtensions);
const run = (text: string, fontSize?: number) => ({ type: "text", text, ...(fontSize ? { marks: [{ type: "textStyle", attrs: { fontSize } }] } : {}) });
const para = (...content: object[]) => schema.nodeFromJSON({ type: "paragraph", content });

test("a paragraph's line size is its largest text's: its own size only where some text has it", () => {
  // Text in the paragraph's own size only: nothing of its own (the paragraph's 1em)
  assert.equal(lineSize(para(run("plain"))), null);
  assert.equal(lineSize(para()), null);
  // All of it 24pt, then some in the paragraph's size too, then two sizes
  assert.equal(lineSize(para(run("big", 24))), "24pt");
  assert.equal(lineSize(para(run("small "), run("big", 24))), "max(1em, 24pt)");
  assert.equal(lineSize(para(run("a", 8), run("b", 14), run("c", 8))), "max(14pt, 8pt)");
});
