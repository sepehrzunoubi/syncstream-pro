import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { editorExtensions } from "./extensions";
import { offsetToPos } from "./pagination";
import { richFromEditorJSON, richToEditorJSON, OBJ } from "@/lib/rich-text";

test("offsetToPos maps source offsets to document positions, images included", () => {
  const schema = getSchema(editorExtensions);
  const json = richToEditorJSON(`ab\n\ncd${OBJ}e`, {
    v: 1,
    paragraphs: [0, 1, 2].map(() => ({ style: "normal" as const, align: "left" as const, indent: 0, firstLine: false, spacing: 115 })),
    runs: [{ len: 8 }],
    images: [{ at: 6, src: "https://x.test/a.png", w: 10, h: 10 }],
  });
  const doc = PMNode.fromJSON(schema, json);
  assert.equal(richFromEditorJSON(doc.toJSON()).text, `ab\n\ncd${OBJ}e`);
  // Paragraph 1 "ab": positions 1..3; paragraph 2 empty at 5; paragraph 3 starts at 7
  const expect: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 5], [4, 7], [5, 8], [6, 9], [7, 10], [8, 11]];
  for (const [offset, pos] of expect) assert.equal(offsetToPos(doc, offset), pos, `offset ${offset}`);
  // Text between the positions matches the source
  assert.equal(doc.textBetween(offsetToPos(doc, 4), offsetToPos(doc, 6)), "cd");
});
