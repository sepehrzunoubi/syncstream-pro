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
import { asAdded, differences, docsCopy, labelsOf, newlineSizesOf, pasteCapture, pasteSlice, SCENARIOS, syncInto, type Scenario } from "./fidelity";

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
