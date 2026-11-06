/**
 * Edits saved straight to the document (directEdits, the autosave of a Docs-backed document) make the
 * Google Doc what the editor shows: each edit is applied to a document in the strict stub, which is
 * then read back and compared with the editor (text, list labels and which list each item is in).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
