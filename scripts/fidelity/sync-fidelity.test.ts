/**
 * Sync fidelity: what the editor shows is what the Google Doc ends up with. Each scenario (and each
 * real Docs clipboard capture, pasted with the editor's own paste code) is typed into the strict stub
 * Google Doc by the real runner, typos and all, then read back and compared with the editor: paragraph
 * styles, where each line sits, list numbers and glyphs, and every character's look.
 *
 * A scenario marked known is one the Docs API can't make exactly; for those only a list glyph's shape
 * may differ, never the text, its look or where it sits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { asAdded, differences, docsCopy, labelsOf, newlineSizesOf, pasteCapture, pasteSlice, SCENARIOS, STRICT, syncInto, type Scenario } from "./fidelity";
import { createStrictStubDocs } from "./strict-stub";
import { importDoc } from "../../src/lib/doc-import";

const FIXTURES = path.join(__dirname, "..", "..", "fixtures", "clipboard");
const CORPUS = path.join(FIXTURES, "corpus");

/** Known differences, each a list glyph's shape */
const onlyGlyphs = (diffs: string[]) => diffs.filter((d) => !/^P\d+ list label: /.test(d));

for (const s of SCENARIOS) {
  test(`${s.name}: ${s.what}`, async () => {
    const r = await syncInto(s);
    assert.equal(r.outcome, "done", r.error);
    const diffs = differences(r.target, r.doc);
    if (s.known) assert.deepEqual(onlyGlyphs(diffs), [], `${s.known}\n${diffs.join("\n")}`);
    else assert.deepEqual(diffs, []);
    if (s.labels) assert.deepEqual(labelsOf(r.target.content ?? []), s.labels, "the labels Docs shows");
    if (s.newlines) assert.deepEqual(newlineSizesOf(r.target.content ?? []), s.newlines, "the sizes Docs draws the empty lines in");
  });
}

test("the stub answers as Google Docs did when asked: a styled word's newline, bullets and the spacing mode, a list joined after a nested item", async () => {
  const docs = createStrictStubDocs({ ...STRICT });
  const id = await docs.create("answers");
  const para = (i: number) => importDoc(docs.docs.get(id)!.toDocument()).nodes[i];
  // A text style up to a paragraph's newline styles that newline; the newline before the range is left alone
  await docs.batchUpdate(id, [
    { insertText: { location: { index: 1 }, text: "Big\nNext\n" } },
    { updateTextStyle: { range: { startIndex: 5, endIndex: 9 }, textStyle: { bold: true }, fields: "bold" } },
  ]);
  const runs = (docs.docs.get(id)!.toDocument().body?.content ?? []).flatMap((b) => b.paragraph?.elements ?? []).map((e) => [e.textRun?.content, !!e.textRun?.textStyle?.bold]);
  assert.deepEqual(runs, [["Big\n", false], ["Next\n", true], ["\n", false]]);
  // Bullets made or removed drop the spacing mode; one set after them stays
  await docs.batchUpdate(id, [
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 9 }, paragraphStyle: { spacingMode: "NEVER_COLLAPSE" }, fields: "spacingMode" } },
    { createParagraphBullets: { range: { startIndex: 1, endIndex: 9 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
  ]);
  assert.equal(para(0).attrs?.spacingMode ?? null, null, "after createParagraphBullets");
  await docs.batchUpdate(id, [
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 9 }, paragraphStyle: { spacingMode: "NEVER_COLLAPSE" }, fields: "spacingMode" } },
    { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 4 } } },
  ]);
  assert.equal(para(0).attrs?.spacingMode ?? null, null, "after deleteParagraphBullets");
  assert.equal(para(1).attrs?.spacingMode, "NEVER_COLLAPSE", "the item that kept its bullet");
  // A paragraph bulleted right after a nested item joins its list at that item's level
  const id2 = await docs.create("levels");
  await docs.batchUpdate(id2, [
    { insertText: { location: { index: 1 }, text: "One\n\tTwo\nThree\n" } },
    { createParagraphBullets: { range: { startIndex: 1, endIndex: 10 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
    { createParagraphBullets: { range: { startIndex: 9, endIndex: 15 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
  ]);
  assert.deepEqual(labelsOf(importDoc(docs.docs.get(id2)!.toDocument()).nodes), ["1.", "a.", "b."]);
});

test("a list whose items are spaced apart keeps its spacing mode through every way its bullets are made", async () => {
  // Typed as its own sync, appended as one text, and with a next line between the items
  const spaced = SCENARIOS.filter((s) => ["list-spacing-modes", "soft-break-spaced-items"].includes(s.name));
  assert.equal(spaced.length, 2);
  for (const s of spaced) for (const append of [false, true]) {
    const r = await syncInto(s, { append });
    assert.equal(r.outcome, "done", r.error);
    const modes = (r.doc.body?.content ?? []).map((b) => b.paragraph?.paragraphStyle?.spacingMode ?? null).filter(Boolean);
    assert.ok(modes.length >= 2, `${s.name}: ${JSON.stringify(modes)}`);
    assert.deepEqual(differences(r.target, r.doc), [], s.name);
  }
});

test("the dashboard's path, the whole page typed as one text, gives the same documents", async () => {
  for (const s of SCENARIOS.filter((x) => !x.setup && !x.known)) {
    const r = await syncInto(s, { append: true });
    assert.equal(r.outcome, "done", `${s.name}: ${r.error}`);
    assert.deepEqual(differences(r.target, r.doc), [], s.name);
  }
});

test("numbered questions with answers between them take requests in proportion to their number, not its square", async () => {
  // Each question after an answer joins the list from the answers before it, not by re-making the list
  const paras: { text: string; level?: number }[] = [];
  for (let k = 1; k <= 30; k++) paras.push({ text: `Question number ${k} goes here`, level: 0 }, { text: `The answer to question ${k} is this` });
  paras.push({ text: "End" });
  for (const append of [false, true]) {
    const r = await syncInto({ target: (base) => asAdded(pasteSlice(docsCopy(paras), base)) }, { append });
    assert.equal(r.outcome, "done", r.error);
    assert.deepEqual(differences(r.target, r.doc), [], append ? "whole page" : "segments");
    const sizes = r.batches.map((b) => b.length);
    assert.ok(Math.max(...sizes) <= 12, `largest batch ${Math.max(...sizes)} (${append ? "whole page" : "segments"})`);
    assert.ok(sizes.reduce((a, b) => a + b, 0) <= 30 * 30, `${sizes.reduce((a, b) => a + b, 0)} requests (${append ? "whole page" : "segments"})`);
  }
});

const capture = (file: string, known?: string[]): Scenario & { expect: string[] } => ({
  name: path.relative(FIXTURES, file),
  what: "a Docs clipboard capture pasted into an empty document",
  target: (base) => {
    const pasted = pasteCapture(file, base);
    assert.ok(pasted, `${file}: read as HTML`);
    return asAdded(pasted);
  },
  expect: known ?? [],
});

const CAPTURES = [
  capture(path.join(FIXTURES, "web-structured-data.slice.json")),
  ...["lists", "inline", "reference"].flatMap((doc) => ["full", "partial-a", "partial-b", "partial-c", "partial-d"]
    .filter((k) => !(doc === "reference" && k === "full"))
    .map((k) => capture(path.join(CORPUS, doc, `${k}-slice.json`),
      // A copy that starts inside a level-2 bullet: Docs makes a lone bullet at level 0 (live recipe Q4, Q13);
      // the item sits where level 2 does, drawn with level 0's glyph
      doc === "reference" && k === "partial-b" ? ['P0 list label: editor "■", doc "●"'] : undefined))),
];

for (const c of CAPTURES) {
  test(`${c.name}, pasted and synced, comes out as the editor shows it`, async () => {
    const r = await syncInto(c);
    assert.equal(r.outcome, "done", r.error);
    assert.deepEqual(differences(r.target, r.doc), c.expect);
  });
}

test("the reference document comes out the same whatever typos the sync makes and fixes", async () => {
  const doc = CAPTURES[0];
  for (const seed of [1, 2, 3]) {
    const r = await syncInto(doc, { seed, typos: 1 });
    assert.equal(r.outcome, "done", `seed ${seed}: ${r.error}`);
    assert.deepEqual(differences(r.target, r.doc), [], `seed ${seed}`);
  }
});
