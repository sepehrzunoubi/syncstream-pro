/**
 * Edits saved straight to the document (directEdits, the autosave of a Docs-backed document) make the
 * Google Doc what the editor shows: each edit is applied to a document in the strict stub, which is
 * then read back and compared with the editor (text, list labels and which list each item is in).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { importDoc } from "../../src/lib/doc-import";
import { directEdits } from "../../src/lib/doc-model";
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
