/**
 * Offline checks for the live end-to-end test: everything but Google.
 *
 * The stub document model is checked against the Docs behaviours the app
 * relies on, the shape comparison against documents that should and should
 * not match, and then the whole run (scenarios A, B and C) is driven against
 * the stub. When this passes, the only new variable in a live run is Google.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { importDoc, indexedText } from "../../src/lib/doc-import";
import { directEdits } from "../../src/lib/doc-model";
import { extractCode } from "./authorize";
import { FastClock, pacer } from "./clock";
import { compareShapes, diffShapes, plainTextOf, Report, shapeOf } from "./compare";
import { runnerDocsApi } from "./docs-client";
import { parseEnv } from "./env";
import { parseArgs } from "./run";
import { runE2E } from "./scenarios";
import { createStubDocs, StubDocument } from "./stub-docs";

// ── Small helpers ───────────────────────────────────────────────────────────

test("the .env loader reads KEY=VALUE lines, quotes and comments, nothing else", () => {
  const env = parseEnv(['# comment', 'A=1', 'B="two words"', "C='x' ", 'D=plain # trailing comment', 'export E=5', 'not a line', '', 'URL=https://x.y/z?a=b#frag'].join("\n"));
  assert.deepEqual(env, { A: "1", B: "two words", C: "x", D: "plain", E: "5", URL: "https://x.y/z?a=b#frag" });
});

test("the fast clock skips waits instead of sleeping, and the pacer spaces real calls", async () => {
  let real = 1000;
  const clock = new FastClock(() => real);
  assert.equal(clock.now(), 1000);
  await clock.sleep(60_000);
  assert.equal(clock.now(), 61_000);
  real += 5;
  clock.advance(1_000);
  assert.equal(clock.now(), 62_005);
  assert.equal(clock.skippedMs, 61_000);

  const slept: number[] = [];
  let t = 0;
  const pace = pacer(700, async (ms) => { slept.push(ms); t += ms; }, () => t);
  await pace();
  t += 100;
  await pace();
  await pace();
  assert.deepEqual(slept, [600, 700]);
});

test("the authorize helper takes a bare code or the redirected URL", () => {
  assert.equal(extractCode("  4/0AbC-dEf_g.h  "), "4/0AbC-dEf_g.h");
  assert.equal(extractCode("http://localhost:3000/api/auth/callback?state=x&code=4%2FxyZ&scope=email"), "4/xyZ");
  assert.equal(extractCode(""), null);
  assert.equal(extractCode("<script>"), null);
});

test("run.ts options parse", () => {
  const a = parseArgs(["--keep", "--dry-run", "--seed", "42", "--typos=0.2", "--pace-ms", "0", "--collab-after", "3"]);
  assert.deepEqual(a, { keep: true, dryRun: true, verbose: false, seed: 42, typos: 0.2, paceMs: 0, collabAfter: 3 });
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
});

// ── The stub behaves like the Docs API where the app depends on it ──────────

const docOf = (d: StubDocument) => d.toDocument();

test("stub: a new document is one empty paragraph after the section break, indexed like Docs", () => {
  const d = new StubDocument("d", "t");
  assert.equal(indexedText(docOf(d)), "\0\n");
  d.batchUpdate([{ insertText: { location: { index: 1 }, text: "Hello world" } }]);
  assert.equal(indexedText(docOf(d)), "\0Hello world\n");
  assert.equal(docOf(d).body?.content?.[1].endIndex, 13);
  assert.equal(d.revisionId, "rev2");
});

test("stub: a typed newline copies the paragraph's style and bullet; inserted text takes its neighbour's style", () => {
  const d = new StubDocument("d", "t");
  d.batchUpdate([
    { insertText: { location: { index: 1 }, text: "Heading" } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 8 }, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } },
    { updateTextStyle: { range: { startIndex: 1, endIndex: 8 }, textStyle: { bold: true }, fields: "bold" } },
  ]);
  d.batchUpdate([{ insertText: { location: { index: 8 }, text: " more\nNext" } }]);
  const imported = importDoc(docOf(d));
  assert.equal(imported.nodes.length, 2);
  assert.equal(imported.nodes[0].attrs?.styleName, "h1");
  assert.equal(imported.nodes[1].attrs?.styleName, "h1", "the new paragraph copies the style");
  assert.deepEqual(imported.nodes[0].content, [{ type: "text", text: "Heading more", marks: [{ type: "bold" }] }], "inserted text inherits bold");
});

test("stub: leading tabs set bullet levels and are removed; removing bullets keeps the paragraph", () => {
  const d = new StubDocument("d", "t");
  d.batchUpdate([{ insertText: { location: { index: 1 }, text: "one\n\ttwo\n\t\tthree" } }]);
  d.batchUpdate([{ createParagraphBullets: { range: { startIndex: 1, endIndex: 1 + "one\n\ttwo\n\t\tthree".length }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } }]);
  assert.equal(indexedText(docOf(d)), "\0one\ntwo\nthree\n", "no tab survives");
  const imported = importDoc(docOf(d));
  assert.deepEqual(imported.nodes.map((n) => [n.attrs?.list, n.attrs?.level]), [["bullet", 0], ["bullet", 1], ["bullet", 2]]);
  d.batchUpdate([{ deleteParagraphBullets: { range: { startIndex: 5, endIndex: 6 } } }]);
  assert.deepEqual(importDoc(docOf(d)).nodes.map((n) => n.attrs?.list), ["bullet", null, "bullet"]);
  const numbered = new StubDocument("n", "t");
  numbered.batchUpdate([{ insertText: { location: { index: 1 }, text: "a\nb" } }, { createParagraphBullets: { range: { startIndex: 1, endIndex: 4 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } }]);
  assert.deepEqual(importDoc(docOf(numbered)).nodes.map((n) => n.attrs?.list), ["ordered", "ordered"]);
});

test("stub: a page break brings its own newline, and the final newline cannot be deleted", () => {
  const d = new StubDocument("d", "t");
  d.batchUpdate([{ insertText: { location: { index: 1 }, text: "one two" } }, { insertPageBreak: { location: { index: 4 } } }]);
  assert.equal(indexedText(docOf(d)), "\0one\u000C\n two\n");
  const imported = importDoc(docOf(d));
  assert.deepEqual(imported.nodes[0].content, [{ type: "text", text: "one" }, { type: "pageBreak" }]);
  // "one" 1-3, the break 4, its newline 5, " two" 6-9, the body's final newline 10
  assert.throws(() => d.batchUpdate([{ deleteContentRange: { range: { startIndex: 10, endIndex: 11 } } }]), /final newline/);
  assert.equal(indexedText(docOf(d)), "\0one\u000C\n two\n", "a refused batch changes nothing");
});

test("stub: a table is preceded by a newline, reads back with Docs' indices, and the newline before it cannot be deleted alone", () => {
  const d = new StubDocument("d", "t");
  d.batchUpdate([{ insertText: { location: { index: 1 }, text: "Intro\nAfter" } }]);
  d.batchUpdate([{ insertTable: { rows: 1, columns: 2, location: { index: 7 } } }]);
  // "Intro\n" 1-6, the inserted newline at 7, table 8: row 9, cell 10, "\n" 11, cell 12, "\n" 13, end 14, "After\n" at 15
  assert.equal(indexedText(docOf(d)), "\0Intro\n\n\0\0\0\n\0\n\0After\n");
  const element = docOf(d).body?.content?.[3];
  assert.equal(element?.startIndex, 8);
  assert.equal(element?.endIndex, 15);
  assert.equal(element?.table?.tableRows?.[0].tableCells?.[1].content?.[0].startIndex, 13);
  const imported = importDoc(docOf(d));
  assert.equal(imported.nodes[2].type, "table");
  assert.equal(imported.nodes[2].content?.[0].content?.[0].attrs?.span, 3);
  assert.equal(imported.nodes[2].attrs?.endSpan, 1);
  assert.throws(() => d.batchUpdate([{ deleteContentRange: { range: { startIndex: 7, endIndex: 8 } } }]), /newline before a table/);
  // Deleting the previous paragraph's newline instead leaves the same text with the table right after it
  d.batchUpdate([{ deleteContentRange: { range: { startIndex: 6, endIndex: 7 } } }]);
  assert.equal(indexedText(docOf(d)), "\0Intro\n\0\0\0\n\0\n\0After\n");
  d.batchUpdate([{ insertText: { location: { index: 10 }, text: "A" } }, { insertText: { location: { index: 13 }, text: "B" } }]);
  assert.equal(plainTextOf(shapeOf(importDoc(docOf(d)).nodes)), "Intro\nA\tB\nAfter");
  // The table now starts at 7: part of it cannot go, and nothing can be typed at its boundary
  assert.throws(() => d.batchUpdate([{ deleteContentRange: { range: { startIndex: 7, endIndex: 10 } } }]), /whole/);
  assert.throws(() => d.batchUpdate([{ deleteContentRange: { range: { startIndex: 8, endIndex: 9 } } }]), /rows or cells/);
  assert.throws(() => d.batchUpdate([{ insertText: { location: { index: 7 }, text: "x" } }]), /table boundary/);
});

test("stub: a batch for an old revision is refused and nothing of it is applied", () => {
  const d = new StubDocument("d", "t");
  const rev = d.revisionId;
  d.batchUpdate([{ insertText: { location: { index: 1 }, text: "a" } }]);
  assert.throws(() => d.batchUpdate([{ insertText: { location: { index: 1 }, text: "b" } }], rev), (err: unknown) => /revision/i.test(String((err as Error).message)) && (err as { code: number }).code === 400);
  assert.equal(indexedText(docOf(d)), "\0a\n");
});

test("stub: the editor's table flow converges once the newline before the table is handled", async () => {
  const docs = createStubDocs();
  const id = await docs.create("t");
  await docs.batchUpdate(id, [{ insertText: { location: { index: 1 }, text: "Intro\nAfter" } }]);
  let base = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  const cell = (t: string) => ({ type: "tableCell", attrs: {}, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: t }] }] });
  const target = { type: "doc", content: [base.content[0], { type: "table", attrs: {}, content: [{ type: "tableRow", attrs: {}, content: [cell("A"), cell("B")] }] }, base.content[1]] };
  const first = directEdits(base, target);
  assert.equal(first.structural, true);
  await docs.batchUpdate(id, first.requests);
  base = { type: "doc", content: importDoc(await docs.get(id)).nodes };
  const { adoptStructure } = await import("../../src/lib/doc-model");
  const adopted = adoptStructure(base, target);
  const second = directEdits(base, adopted);
  // The empty paragraph Docs made goes by deleting "Intro"'s newline, not the one before the table
  assert.deepEqual(second.requests.filter((r) => r.deleteContentRange), [{ deleteContentRange: { range: { startIndex: 6, endIndex: 7 } } }]);
  await docs.batchUpdate(id, second.requests);
  const after = importDoc(await docs.get(id));
  assert.equal(plainTextOf(shapeOf(after.nodes)), "Intro\nA\tB\nAfter");
  assert.deepEqual(diffShapes(shapeOf(adopted), shapeOf(after.nodes)), []);
});

// ── Comparing shapes ────────────────────────────────────────────────────────

const p = (text: string, attrs: Record<string, unknown> = {}, marks: { type: string; attrs?: Record<string, unknown> }[] = []) => ({ type: "paragraph", attrs, content: text ? [marks.length ? { type: "text", text, marks } : { type: "text", text }] : [] });

test("shapes ignore how Docs splits runs and what it adds to links, but see every asked-for difference", () => {
  const expected = shapeOf({ type: "doc", content: [p("Title", { styleName: "h1" }), { type: "paragraph", attrs: {}, content: [{ type: "text", text: "a ", marks: [{ type: "syncAdd" }] }, { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://e.com/x" } }, { type: "syncAdd" }] }] }] });
  const actual = shapeOf({ type: "doc", content: [p("Title", { styleName: "h1", box: { start: 0, first: 0, above: null, below: null } }), { type: "paragraph", attrs: {}, content: [{ type: "text", text: "a" }, { type: "text", text: " " }, { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://e.com/x" } }, { type: "underline" }, { type: "textStyle", attrs: { color: "#1155cc" } }] }] }] });
  assert.deepEqual(diffShapes(expected, actual), []);
  const wrong = shapeOf({ type: "doc", content: [p("Title", { styleName: "h2" }), p("a link", {}, [{ type: "bold" }]), p("extra", { list: "bullet", level: 1 })] });
  const diffs = diffShapes(expected, wrong);
  assert.equal(diffs.length, 3, diffs.join("\n"));
  assert.match(diffs[0], /style h2, expected h1/);
  assert.match(diffs[1], /runs/);
  assert.match(diffs[2], /unexpected extra paragraph/);
  const report = new Report(() => {});
  assert.equal(compareShapes(report, "x", expected, actual), true);
  assert.equal(report.failed, 0);
  assert.equal(compareShapes(report, "y", expected, wrong), false);
  assert.ok(report.failed >= 2);
  assert.ok(report.results.some((r) => r.name === "y: named styles (headings) match" && !r.ok));
  assert.ok(report.results.some((r) => r.name === "y: text equals expected" && r.ok === false));
});

test("plain text of a shape puts page breaks and table cells where a reader expects them", () => {
  const blocks = shapeOf({ type: "doc", content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "one" }, { type: "pageBreak" }] }, { type: "table", attrs: {}, content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p("a")] }, { type: "tableCell", content: [p("b")] }] }] }, p("two")] });
  assert.equal(plainTextOf(blocks), "one\u000C\na\tb\ntwo");
});

// ── The whole run, offline ──────────────────────────────────────────────────

test("the runner adapter counts writes and tells hooks about them", async () => {
  const docs = createStubDocs();
  const id = await docs.create("t");
  const seen: number[] = [];
  const api = runnerDocsApi(docs, { afterWrite: async (n) => { seen.push(n); } });
  await api.batch("tok", id, [{ insertText: { location: { index: 1 }, text: "ab" } }]);
  await api.deleteRange("tok", id, 1, 2);
  const snap = await api.snapshot("tok", id);
  assert.equal(snap.chars, "\0b\n");
  assert.equal(snap.endIndex, 3);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(docs.calls, { reads: 1, writes: 3 });
});

test("scenarios A, B and C pass against the stub and the document is deleted afterwards", async () => {
  const docs = createStubDocs();
  const lines: string[] = [];
  const report = new Report((l) => lines.push(l));
  const result = await runE2E(docs, report, { seed: 7, typoFrequency: 0.7, sleep: async () => {}, log: (l) => lines.push(l) });
  const failed = report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail ?? ""}`);
  assert.deepEqual(failed, [], lines.join("\n"));
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(docs.docs.size, 0);
  assert.ok(report.passed >= 30, `${report.passed} checks`);
  // The checks the brief asks for are all there
  for (const name of ["A: named styles (headings) match", "A: bold/italic/underline/link runs match", "A: list items and nesting levels match", "A: page breaks match", "B: tables match", "B: saving converges (nothing left to save)", "C: the collaborator got a turn", "C: whole document matches"]) {
    assert.ok(report.results.some((r) => r.name === name && r.ok), name);
  }
  assert.ok(docs.calls.writes < 400 && docs.calls.reads < 400, `cost: ${JSON.stringify(docs.calls)}`);
});

test("a few more seeds: typos and chunking never change the outcome", async () => {
  for (const seed of [1, 2, 3]) {
    const docs = createStubDocs();
    const report = new Report(() => {});
    const result = await runE2E(docs, report, { seed, typoFrequency: 1, sleep: async () => {} });
    const failed = report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail ?? ""}`);
    assert.deepEqual(failed, [], `seed ${seed}`);
    assert.equal(result.ok, true);
  }
});

test("a failing run keeps the document and says where it is", async () => {
  const docs = createStubDocs();
  // Collaborator never gets a turn: the check fails, so the document must survive for inspection
  const report = new Report(() => {});
  const result = await runE2E(docs, report, { seed: 7, collaboratorAfterWrite: 10_000, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.deleted, false);
  assert.equal(docs.docs.size, 1);
  assert.ok(result.url.includes(result.documentId));
});
