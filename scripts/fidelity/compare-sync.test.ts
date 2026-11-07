/**
 * Compare & Sync end to end, offline: LEFT and the reference made in the strict stub, compared by the
 * engine, the structure the sync can't type saved as autosave saves it, the rest typed by the real
 * runner (on a virtual clock), and LEFT read back. It must then read exactly as the reference does,
 * every copied character in the reference's look, with every one of LEFT's own characters untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { docs_v1 } from "googleapis";
import { compareDocs } from "../../src/lib/compare";
import type { CompareSide } from "../../src/lib/compare-types";
import { importDoc, type ImportedDoc } from "../../src/lib/doc-import";
import { additions, adoptStructure, directEdits, tokenize, type Tok } from "../../src/lib/doc-model";
import { buildDripPlan } from "../../src/lib/drip-engine";
import { snapshotOf } from "../../src/lib/google";
import { plainFormat, type EditorNode } from "../../src/lib/rich-text";
import { buildSyncRecords, parseSegments, segmentBoundaries, spotsFor } from "../../src/lib/sync-plan";
import { runJobWindow, type RunnerDeps } from "../../src/lib/sync-runner";
import { createMemoryStore } from "../../src/lib/sync-store";
import { FastClock } from "../e2e-live/clock";
import { diffShapes, plainTextOf, shapeOf } from "../e2e-live/compare";
import { runnerDocsApi, type E2EDocs } from "../e2e-live/docs-client";
import { differences, STRICT } from "./fidelity";
import { createStrictStubDocs } from "./strict-stub";

type Docs = E2EDocs & { batches: object[][] };

const sideOf = (documentId: string, doc: ImportedDoc): CompareSide => ({ documentId, name: documentId, revisionId: doc.revisionId, tabs: [{ id: "t.0", title: "Tab 1", level: 0, parentId: null, index: 0, doc }] });
const bodyOf = (doc: docs_v1.Schema$Document): EditorNode => ({ type: "doc", content: importDoc(doc).nodes });

/** The sync of `target` into document `id`, as the start route and the worker run it */
async function runSync(docs: Docs, id: string, base: EditorNode, target: EditorNode, opts: { seed: number; typos: number }) {
  const { segments } = additions(base, target);
  const parsed = parseSegments(JSON.parse(JSON.stringify(segments.map(({ at, mode, text, format }) => ({ at, mode, text, format })))));
  if (!parsed.ok) throw new Error(parsed.error);
  const text = parsed.segments.map((s) => s.text).join("");
  const boundaries = segmentBoundaries(parsed.segments);
  const plan = buildDripPlan(text, { seed: opts.seed, breaks: [], typoFrequency: opts.typos, ...(boundaries.length ? { boundaries } : {}) });
  const current = await docs.get(id);
  const spots = spotsFor(current, snapshotOf(current).chars, parsed.segments);
  assert.ok(spots, "every addition has its spot in the document");
  const clock = new FastClock();
  const store = createMemoryStore(clock.now);
  const { plan: syncPlan, job } = buildSyncRecords({ id: "job1", userId: "u", documentId: id, documentName: "left", plan, format: plainFormat(text), segments: parsed.segments, spots, now: clock.now(), accessToken: "a", refreshToken: "r", baselineWordCount: 0 });
  await store.setPlan(syncPlan);
  await store.setJob(job);
  await store.addActiveJob("job1");
  const queue: { generation: number; delaySec: number; tick?: number }[] = [];
  const deps: RunnerDeps = { store, docs: runnerDocsApi(docs), refresh: async () => ({ access_token: "a" }), enqueue: async (_i, generation, delaySec, tick) => { queue.push({ generation, delaySec, tick }); }, now: clock.now, sleep: clock.sleep };
  const before = docs.batches.length;
  let msg: { generation: number; delaySec: number; tick?: number } = { generation: 0, delaySec: 0 };
  for (;;) {
    const r = await runJobWindow("job1", msg.generation, { ...deps, tick: msg.tick });
    if (["done", "error", "cancelled", "paused", "not_found", "already_finished"].includes(r.outcome)) {
      assert.equal(r.outcome, "done", r.job?.error);
      return { segments: parsed.segments.length, batches: docs.batches.slice(before) };
    }
    const next = queue.shift();
    if (!next) throw new Error(`The runner stopped with ${r.outcome} and nothing queued`);
    clock.advance(next.delaySec * 1000);
    msg = next;
  }
}

/** Whether LEFT's characters are all still there, in order, each with its look */
function keepsAll(left: EditorNode, after: EditorNode): boolean {
  const key = (t: Tok) => (t.k === "c" ? `${t.c}${JSON.stringify(t.marks)}` : null);
  const mine = tokenize(left).map(key).filter((k): k is string => k != null);
  const out = tokenize(after).map(key);
  let i = 0;
  for (const k of out) if (i < mine.length && k === mine[i]) i++;
  return i === mine.length;
}

/** LEFT and the reference, compared and synced: LEFT read back */
async function compareAndSync(left: object[], right: object[], opts: { seed?: number; typos?: number } = {}) {
  const docs = createStrictStubDocs({ ...STRICT });
  const lid = await docs.create("left");
  const rid = await docs.create("right");
  if (left.length) await docs.batchUpdate(lid, left);
  await docs.batchUpdate(rid, right);
  const leftDoc = importDoc(await docs.get(lid));
  const rightRaw = await docs.get(rid);
  // The reference is read against the named styles of the tab it goes into, as the load route reads it
  const result = compareDocs(sideOf(lid, leftDoc), sideOf(rid, importDoc(rightRaw, { defaults: leftDoc.defaults })));
  const tab = result.tabs[0];
  // Autosave: the structure the sync can't type (tables, rows), read back and adopted, as the start does
  let base = tab.base;
  let target = tab.merged;
  const saved: object[][] = [];
  for (let round = 0; round < 5; round++) {
    const out = directEdits(base, target);
    if (!out.requests.length) break;
    saved.push(out.requests);
    await docs.batchUpdate(lid, out.requests);
    if (out.structural) { base = bodyOf(await docs.get(lid)); target = adoptStructure(base, target); }
    else base = out.saved;
  }
  const sync = await runSync(docs, lid, base, target, { seed: opts.seed ?? 3, typos: opts.typos ?? 0 });
  const out = await docs.get(lid);
  return { tab, result, left: { type: "doc", content: leftDoc.nodes } as EditorNode, right: bodyOf(rightRaw), rightRaw, out, saved, sync };
}

const ins = (text: string, index = 1) => ({ insertText: { location: { index }, text } });
const named = (start: number, end: number, namedStyleType: string) => ({ updateParagraphStyle: { range: { startIndex: start, endIndex: end }, paragraphStyle: { namedStyleType }, fields: "namedStyleType" } });
const styled = (start: number, end: number, textStyle: docs_v1.Schema$TextStyle, fields: string) => ({ updateTextStyle: { range: { startIndex: start, endIndex: end }, textStyle, fields } });
const bullets = (start: number, end: number, bulletPreset = "BULLET_DISC_CIRCLE_SQUARE") => ({ createParagraphBullets: { range: { startIndex: start, endIndex: end }, bulletPreset } });
const red = { foregroundColor: { color: { rgbColor: { red: 0.8, green: 0, blue: 0 } } } };

/** The checks every scenario makes: the reference's text exactly, its look, LEFT's text untouched */
function assertSameAsReference(r: Awaited<ReturnType<typeof compareAndSync>>) {
  assert.equal(plainTextOf(shapeOf(importDoc(r.out).nodes)), plainTextOf(shapeOf(r.right.content ?? [])), "LEFT reads as the reference");
  assert.deepEqual(diffShapes(shapeOf(r.right.content ?? []), shapeOf(importDoc(r.out).nodes)), []);
  assert.deepEqual(differences(r.right, r.out), [], "every character and paragraph looks as the reference has it");
  assert.ok(keepsAll(r.left, bodyOf(r.out)), "LEFT's own characters are all there, as they were");
}

test("a missing sentence is typed into the middle of LEFT's paragraph", async () => {
  const r = await compareAndSync(
    [ins("Opening line.\nWe met on Monday. Work starts next week.\nClosing line.")],
    [ins("Opening line.\nWe met on Monday. The budget was approved without changes. Work starts next week.\nClosing line.")],
  );
  assertSameAsReference(r);
  assert.equal(r.sync.segments, 1);
  assert.deepEqual(r.saved, [], "nothing saved directly");
});

test("missing paragraphs in the middle and at the end, a heading among them", async () => {
  const right = "Title here\nIntro paragraph.\nResults\nThe numbers went up.\nClosing line.\nA last word.";
  const r = await compareAndSync(
    [ins("Title here\nIntro paragraph.\nClosing line."), named(1, 11, "HEADING_1")],
    [ins(right), named(1, 11, "HEADING_1"), named(29, 37, "HEADING_2")],
  );
  assertSameAsReference(r);
  assert.equal(r.sync.segments, 2);
});

test("missing list items join LEFT's list", async () => {
  const r = await compareAndSync(
    [ins("Shopping:\nApples\nCheese\nThat's all."), bullets(11, 25)],
    [ins("Shopping:\nApples\nBread\nButter\nCheese\nThat's all."), bullets(11, 38)],
  );
  assertSameAsReference(r);
});

test("a blank document gets the whole styled reference", async () => {
  const text = "Quarterly plan\nThe plan has three parts, in red.\nFirst part\nSecond part\nThird part\nRead the notes first.\nClosing line.";
  const r = await compareAndSync([], [
    ins(text),
    named(1, 16, "HEADING_1"),
    styled(30, 35, { bold: true }, "bold"),
    styled(44, 47, red, "foregroundColor"),
    bullets(50, 82),
    styled(91, 100, { link: { url: "https://example.com/notes" } }, "link"),
  ], { typos: 0.7, seed: 5 });
  assertSameAsReference(r);
  assert.equal(r.tab.stats.presentPct, 0);
  assert.equal(r.sync.segments, 1, "typed top to bottom in one go");
});

test("words into LEFT's paragraphs and whole new paragraphs, typed in one sync", async () => {
  const r = await compareAndSync(
    [ins("Weekly report\nSales grew this week.\nNext steps are below.\nThanks.")],
    [ins("Weekly report\nSales grew by 12 percent this week, ahead of plan.\nCosts stayed flat.\nNext steps are below.\nHire two engineers.\nThanks."), styled(29, 39, { bold: true }, "bold")],
    { typos: 0.5, seed: 9 },
  );
  assertSameAsReference(r);
  assert.ok(r.tab.changes.some((c) => c.kind === "text") && r.tab.changes.some((c) => c.kind === "paragraph"));
});

test("missing text in the cells of a table both have", async () => {
  const docs = createStrictStubDocs({ ...STRICT });
  // Both start as the same 2x2 table after a paragraph; the reference has all four cells filled
  const make = async (cells: string[]) => {
    const id = await docs.create("t");
    await docs.batchUpdate(id, [ins("Team\nAfter")]);
    await docs.batchUpdate(id, [{ insertTable: { rows: 2, columns: 2, location: { index: 6 } } }]);
    const d = await docs.get(id);
    const starts: number[] = [];
    for (const el of d.body?.content ?? []) if (el.table) for (const row of el.table.tableRows ?? []) for (const c of row.tableCells ?? []) starts.push(c.content![0].startIndex!);
    const reqs = starts.map((at, k) => ({ at, text: cells[k] })).filter((x) => x.text).reverse().map((x) => ins(x.text, x.at));
    if (reqs.length) await docs.batchUpdate(id, reqs);
    return id;
  };
  const lid = await make(["Name", "", "Ada", ""]);
  const rid = await make(["Name", "Role", "Ada", "Engineer"]);
  const leftDoc = importDoc(await docs.get(lid));
  const rightRaw = await docs.get(rid);
  const tab = compareDocs(sideOf(lid, leftDoc), sideOf(rid, importDoc(rightRaw, { defaults: leftDoc.defaults }))).tabs[0];
  assert.deepEqual(tab.changes.map((c) => c.kind), ["cell", "cell"]);
  assert.deepEqual(directEdits(tab.base, tab.merged).requests, [], "the cells are typed into, nothing made");
  const sync = await runSync(docs, lid, tab.base, tab.merged, { seed: 4, typos: 0.6 });
  assert.equal(sync.segments, 2);
  const out = await docs.get(lid);
  assert.deepEqual(diffShapes(shapeOf(bodyOf(rightRaw).content ?? []), shapeOf(importDoc(out).nodes)), []);
  assert.equal(plainTextOf(shapeOf(importDoc(out).nodes)), plainTextOf(shapeOf(bodyOf(rightRaw).content ?? [])));
  assert.ok(keepsAll({ type: "doc", content: leftDoc.nodes }, bodyOf(out)));
});

test("a missing table: its structure made first, then its cells typed", async () => {
  const docs = createStrictStubDocs({ ...STRICT });
  const lid = await docs.create("left");
  await docs.batchUpdate(lid, [ins("Team\nAfter the table.")]);
  const rid = await docs.create("right");
  await docs.batchUpdate(rid, [ins("Team\nAfter the table.")]);
  await docs.batchUpdate(rid, [{ insertTable: { rows: 2, columns: 2, location: { index: 6 } } }]);
  const d = await docs.get(rid);
  const starts: number[] = [];
  for (const el of d.body?.content ?? []) if (el.table) for (const row of el.table.tableRows ?? []) for (const c of row.tableCells ?? []) starts.push(c.content![0].startIndex!);
  await docs.batchUpdate(rid, starts.map((at, k) => ins(["Name", "Role", "Ada", "Engineer"][k], at)).reverse());
  const leftDoc = importDoc(await docs.get(lid));
  const rightRaw = await docs.get(rid);
  const tab = compareDocs(sideOf(lid, leftDoc), sideOf(rid, importDoc(rightRaw, { defaults: leftDoc.defaults }))).tabs[0];
  assert.deepEqual(tab.changes.map((c) => c.kind), ["table"]);
  let base = tab.base;
  let target = tab.merged;
  for (let round = 0; round < 5; round++) {
    const out = directEdits(base, target);
    if (!out.requests.length) break;
    await docs.batchUpdate(lid, out.requests);
    if (out.structural) { base = bodyOf(await docs.get(lid)); target = adoptStructure(base, target); }
    else base = out.saved;
  }
  await runSync(docs, lid, base, target, { seed: 2, typos: 0 });
  const out = await docs.get(lid);
  assert.deepEqual(diffShapes(shapeOf(bodyOf(rightRaw).content ?? []), shapeOf(importDoc(out).nodes)), []);
  assert.ok(keepsAll({ type: "doc", content: leftDoc.nodes }, bodyOf(out)));
});

test("a large blank-document copy stays exact (past the old diff limit)", async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} with enough words to make a long document grow past four thousand characters overall.`);
  const r = await compareAndSync([ins("Kept intro.\nKept ending.")], [ins(["Kept intro.", ...lines.slice(0, 30), "Kept ending.", ...lines.slice(30)].join("\n"))]);
  assertSameAsReference(r);
  assert.deepEqual(r.saved, [], "nothing of LEFT saved over");
});

test("missing list items with a highlight and a link, and a missing sub-item, typed as the reference has them", async () => {
  const hl = { backgroundColor: { color: { rgbColor: { red: 0.96, green: 0.8, blue: 0.8 } } } };
  // Leading tabs nest an item when its bullets are made
  const right = "Head\nAlpha item\n\tAlpha one\n\tAlpha two\n\tAlpha three\nBravo item\nCharlie item\nAfter";
  const left = "Head\nAlpha item\n\tAlpha one\n\tAlpha three\nCharlie item\nAfter";
  // "Bravo item" once the bullets have taken the three tabs before it
  const bravo = right.indexOf("Bravo") + 1 - 3;
  const r = await compareAndSync(
    [ins(left), bullets(6, left.length - 5)],
    [ins(right), bullets(6, right.length - 5), styled(bravo, bravo + 5, hl, "backgroundColor"), styled(bravo + 6, bravo + 10, { link: { url: "https://b.example" } }, "link")],
  );
  assertSameAsReference(r);
  const item = importDoc(r.out).nodes.find((n) => n.content?.[0]?.text?.startsWith("Bravo"))!;
  assert.deepEqual(item.content!.map((c) => [c.text, c.marks?.some((m) => m.type === "highlight") ?? false, c.marks?.some((m) => m.type === "link") ?? false]), [["Bravo", true, false], [" ", false, false], ["item", false, true]]);
});

test("Chinese and Japanese text: the missing characters are typed in place, without spaces", async () => {
  const r = await compareAndSync([ins("日本語のテキストです。\n这是一个句子。")], [ins("日本語の長いテキストです。\n这是一个很长的句子。")]);
  assertSameAsReference(r);
  assert.equal(r.sync.segments, 2);
});

// Needs doc-model's directEdits to leave a paragraph's style to the addition when the paragraph is an
// empty line the addition brings (see paragraphHasPending): today the start restyles LEFT's heading
// (or takes its bullet away) until the sync has typed past it
test("a heading whose section LEFT lacks keeps its style while the section is typed", async () => {
  const r = await compareAndSync(
    [ins("Heading A\nHeading B\nBody B."), named(1, 10, "HEADING_1"), named(11, 20, "HEADING_1")],
    [ins("Heading A\nIntro text here.\nMore.\n\nHeading B\nBody B."), named(1, 10, "HEADING_1"), named(35, 44, "HEADING_1")],
  );
  assert.deepEqual(r.saved, [], "nothing of LEFT is set before the sync types");
  assertSameAsReference(r);
});
