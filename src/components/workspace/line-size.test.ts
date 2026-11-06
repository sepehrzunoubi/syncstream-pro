import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { editorExtensions, lineSize, textLook } from "./extensions";

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

test("a paragraph takes the font and size all its text has, and only those", () => {
  const font = (text: string, fontFamily: string, fontSize?: number) => ({ type: "text", text, marks: [{ type: "textStyle", attrs: { fontFamily, ...(fontSize ? { fontSize } : {}) } }] });
  assert.deepEqual(textLook(para(run("plain"))), {});
  assert.deepEqual(textLook(para(font("a", "Calibri"), font("b", "Calibri"))), { font: "Calibri" });
  assert.deepEqual(textLook(para(run("a", 8), run("b", 8))), { size: 8 });
  assert.deepEqual(textLook(para(font("a", "Calibri", 8), font("b", "Calibri", 8))), { font: "Calibri", size: 8 });
  // Some of it in the paragraph's own font or size, or two of them: the paragraph keeps its own
  assert.deepEqual(textLook(para(run("a "), font("b", "Calibri", 8))), {});
  assert.deepEqual(textLook(para(font("a", "Calibri", 8), font("b", "Georgia", 9))), {});
  assert.deepEqual(textLook(para()), {});
});
