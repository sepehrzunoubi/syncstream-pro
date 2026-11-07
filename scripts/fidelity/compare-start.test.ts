/**
 * POST /api/compare/start's work, offline, through the code that calls Google (src/lib/google.ts)
 * over tabbed stub documents: both documents read again, the reference's missing tabs made (nested
 * where it has them), a blank "Tab 1" renamed, footnotes made with the reference's text, then one
 * sync typing the rest tab by tab. Each tab of LEFT must end up reading as the reference's does, and
 * a change to either document since the review must stop the start.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { google } from "googleapis";
import { compareDocs } from "../../src/lib/compare";
import { buildCompareJob, buildSides, CompareChangedError, prepareCompare, rawTabs, type CompareGoogle } from "../../src/lib/compare-server";
import type { CompareBreak } from "../../src/lib/compare-types";
import { tokenize } from "../../src/lib/doc-model";
import { batchUpdate, batchUpdateWithReplies, createTab, deleteRange, getDocSnapshot, getRawDocument, renameTab } from "../../src/lib/google";
import { runJobWindow, type RunnerDeps } from "../../src/lib/sync-runner";
import { createMemoryStore } from "../../src/lib/sync-store";
import { stubDocsClient, TabbedStub } from "../e2e-live/stub-tabs";

const docs = new Map<string, TabbedStub>();
(google as unknown as { docs: () => unknown }).docs = () => stubDocsClient(docs);

const g: CompareGoogle = {
  read: (id) => getRawDocument("t", id),
  batch: (id, requests, tabId) => batchUpdateWithReplies("t", id, requests, { tabId }) as Promise<Record<string, unknown>[]>,
  createTab: (id, props) => createTab("t", id, props),
  renameTab: (id, tabId, title) => renameTab("t", id, tabId, title),
  rehost: async (url) => url,
};

const plain = (d: TabbedStub, tab: string) => d.tab(tab).text().replace(/^\0/, "").replace(/\n$/, "");

function stub(id: string, title: string, tabs: { id: string; title: string; text?: string; children?: { id: string; title: string; text?: string }[] }[]) {
  const d = new TabbedStub(id, title, tabs.map((t) => ({ id: t.id, title: t.title, children: (t.children ?? []).map((c) => ({ id: c.id, title: c.title })) })));
  for (const t of [...tabs, ...tabs.flatMap((x) => x.children ?? [])]) if (t.text) d.tab(t.id).batchUpdate([{ insertText: { location: { index: 1 }, text: t.text } }]);
  docs.set(id, d);
  return d;
}

/** Start as the route does, then run the sync to the end */
async function start(leftId: string, rightId: string, opts: { breaks?: CompareBreak[]; skip?: string[]; typos?: number; seed?: number } = {}) {
  const [l, r] = await Promise.all([getRawDocument("t", leftId), getRawDocument("t", rightId)]);
  const prepared = await prepareCompare(g, { leftId, rightId, leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: {}, skip: opts.skip ?? [], breaks: opts.breaks ?? [] });
  let t = 1_000_000;
  const now = () => t;
  const built = buildCompareJob(prepared, { id: `job_${leftId}`, userId: "u", documentId: leftId, documentName: "", breaksMode: opts.breaks?.length ? "manual" : "none", targetMinutes: null, typoFrequency: opts.typos ?? 0, seed: opts.seed ?? 7, startInMinutes: 0, now: t, accessToken: "a", refreshToken: "r" });
  assert.ok(built.ok, built.ok ? "" : built.error);
  if (!built.ok) throw new Error("unreachable");
  const store = createMemoryStore(now);
  await store.setPlan(built.plan);
  await store.setJob(built.job);
  await store.addActiveJob(built.job.id);
  const queue: { generation: number; delaySec: number; tick?: number }[] = [];
  const deps: RunnerDeps = {
    store,
    docs: { snapshot: getDocSnapshot, batch: batchUpdate, deleteRange },
    refresh: async () => ({ access_token: "a" }),
    enqueue: async (_id, generation, delaySec, tick) => { queue.push({ generation, delaySec, tick }); },
    now,
    sleep: async (ms) => { t += ms; },
  };
  let msg: { generation: number; delaySec: number; tick?: number } = { generation: 0, delaySec: 0 };
  for (let n = 0; n < 50_000; n++) {
    const res = await runJobWindow(built.job.id, msg.generation, { ...deps, tick: msg.tick });
    if (res.outcome === "done" || res.outcome === "error") {
      const job = (await store.getJob(built.job.id))!;
      assert.equal(job.status, "done", job.error);
      return { prepared, built, job };
    }
    const next = queue.shift();
    if (!next) throw new Error(`the runner stopped with ${res.outcome}`);
    t += next.delaySec * 1000;
    msg = next;
  }
  throw new Error("the sync did not finish");
}

test("missing paragraphs typed into the tab LEFT has; the reference's other tabs made, nested as it has them, and typed", async () => {
  const left = stub("left-doc-0000001", "My notes", [{ id: "t.0", title: "Research", text: "Intro line\nClosing line" }]);
  const right = stub("right-doc-000001", "Reference", [
    { id: "t.0", title: "Research", text: "Intro line\nA middle paragraph, missing from mine.\nClosing line" },
    { id: "t.web", title: "Web", text: "Agent payments\nSecond line of web", children: [{ id: "t.kid", title: "Sources", text: "A source" }] },
  ]);
  const before = right.revisionId;
  const { job } = await start("left-doc-0000001", "right-doc-000001", { typos: 0.5, seed: 3 });
  assert.equal(right.revisionId, before, "the reference is never written to");
  assert.equal(plain(left, "t.0"), "Intro line\nA middle paragraph, missing from mine.\nClosing line");
  const tabs = rawTabs(await getRawDocument("t", "left-doc-0000001"));
  assert.deepEqual(tabs.map((x) => [x.title, x.level]), [["Research", 0], ["Web", 0], ["Sources", 1]]);
  const web = tabs.find((x) => x.title === "Web")!;
  const kid = tabs.find((x) => x.title === "Sources")!;
  assert.equal(kid.parentId, web.id, "nested under the tab made for its parent");
  assert.equal(plain(left, web.id), "Agent payments\nSecond line of web");
  assert.equal(plain(left, kid.id), "A source");
  assert.deepEqual(job.tabs?.map((x) => x.title), ["Research", "Web", "Sources"], "typed in the reference's order");
});

test("a blank Tab 1 takes the reference's title and everything in it, footnote text included", async () => {
  const left = stub("left-doc-0000002", "Blank", [{ id: "t.0", title: "Tab 1" }]);
  const right = stub("right-doc-000002", "Essay", [{ id: "t.0", title: "Essay", text: "Title line\nA paragraph with a note\nLast words" }]);
  // A footnote after "note"
  const at = "Title line\nA paragraph with a note".length + 1;
  const reply = right.tab("t.0").batchUpdate([{ createFootnote: { location: { index: at } } }]) as { createFootnote?: { footnoteId: string } }[];
  const fid = reply[0].createFootnote!.footnoteId;
  right.tab("t.0").batchUpdate([{ insertText: { location: { segmentId: fid, index: 0 }, text: "The source of it." } }]);
  await start("left-doc-0000002", "right-doc-000002");
  const raw = await getRawDocument("t", "left-doc-0000002");
  assert.deepEqual(rawTabs(raw).map((x) => x.title), ["Essay"], "renamed, not added to");
  assert.equal(plain(left, "t.0").replace(/\0/g, ""), "Title line\nA paragraph with a note\nLast words");
  const notes = Object.values(raw.tabs![0].documentTab!.footnotes ?? {});
  assert.equal(notes.length, 1, "the footnote made once");
  const noteText = (notes[0].content ?? []).flatMap((e) => e.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
  assert.equal(noteText.trim(), "The source of it.");
});

test("a change to either document since the review stops the start, before anything is written", async () => {
  const left = stub("left-doc-0000003", "Mine", [{ id: "t.0", title: "Tab 1", text: "One" }]);
  const right = stub("right-doc-000003", "Ref", [{ id: "t.0", title: "Tab 1", text: "One\nTwo" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000003"), getRawDocument("t", "right-doc-000003")]);
  right.tab("t.0").batchUpdate([{ insertText: { location: { index: 1 }, text: "Zero\n" } }]);
  right.revision++;
  const sentBefore = left.sent.get("t.0")?.length ?? 0;
  await assert.rejects(prepareCompare(g, { leftId: "left-doc-0000003", rightId: "right-doc-000003", leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: {}, skip: [], breaks: [] }), CompareChangedError);
  assert.equal(left.sent.get("t.0")?.length ?? 0, sentBefore, "nothing written to LEFT");
});

test("a manual break placed on a copied word pauses the sync right after it", async () => {
  const left = stub("left-doc-0000004", "Mine", [{ id: "t.0", title: "Notes", text: "Alpha\nOmega" }]);
  stub("right-doc-000004", "Ref", [{ id: "t.0", title: "Notes", text: "Alpha\nBeta gamma delta\nMiddle two\nOmega" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000004"), getRawDocument("t", "right-doc-000004")]);
  const sides = buildSides(l, "left-doc-0000004", r, "right-doc-000004");
  const result = compareDocs(sides.left, sides.right, { tabMap: sides.tabMap });
  const tab = result.tabs[0];
  // The reference token ending "gamma"
  const rightToks = tokenize({ type: "doc", content: sides.right.tabs[0].doc.nodes });
  const text = rightToks.map((x) => (x.k === "c" ? x.c : x.k === "nl" ? "\n" : "\0")).join("");
  const gamma = text.indexOf("gamma") + "gamma".length - 1;
  assert.ok(tab.changes.length >= 1);
  const { built } = await start("left-doc-0000004", "right-doc-000004", { breaks: [{ rightTabId: "t.0", rightToken: gamma, minutes: 5 }] });
  const pause = built.ok ? built.plan.actions.findIndex((a) => a.kind === "pause" && a.activity !== undefined && (a.delayMs ?? 0) >= 5 * 60_000 - 1) : -1;
  assert.ok(pause > 0, "a five-minute pause is in the plan");
  const typedBefore = built.ok ? built.plan.actions.slice(0, pause).filter((a) => a.kind === "insert" || a.kind === "typo").map((a) => a.text).join("") : "";
  assert.ok(typedBefore.endsWith("gamma ") || typedBefore.endsWith("gamma"), `the break follows "gamma": …${typedBefore.slice(-20)}`);
  assert.equal(plain(left, "t.0"), "Alpha\nBeta gamma delta\nMiddle two\nOmega");
});

test("a skipped change isn't typed; the rest are", async () => {
  const left = stub("left-doc-0000005", "Mine", [{ id: "t.0", title: "Notes", text: "Alpha\nOmega" }]);
  stub("right-doc-000005", "Ref", [{ id: "t.0", title: "Notes", text: "Alpha\nBeta here\nOmega\nAfter omega" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000005"), getRawDocument("t", "right-doc-000005")]);
  const sides = buildSides(l, "left-doc-0000005", r, "right-doc-000005");
  const tab = compareDocs(sides.left, sides.right, { tabMap: sides.tabMap }).tabs[0];
  const last = tab.changes.find((c) => c.preview.includes("After omega"));
  assert.ok(last, JSON.stringify(tab.changes.map((c) => c.preview)));
  await start("left-doc-0000005", "right-doc-000005", { skip: [last.id] });
  assert.equal(plain(left, "t.0"), "Alpha\nBeta here\nOmega");
});

test("a table the reference has: its structure made at the start, its cells typed, in the tab it goes into", async () => {
  const left = stub("left-doc-0000006", "Mine", [{ id: "t.0", title: "Team", text: "Team\nAfter the table." }]);
  const right = stub("right-doc-000006", "Ref", [{ id: "t.0", title: "Team", text: "Team\nAfter the table." }]);
  const rd = right.tab("t.0");
  rd.batchUpdate([{ insertTable: { rows: 2, columns: 2, location: { index: 6 } } }]);
  const starts: number[] = [];
  const raw = await getRawDocument("t", "right-doc-000006");
  for (const el of raw.tabs![0].documentTab!.body!.content ?? []) if (el.table) for (const row of el.table.tableRows ?? []) for (const c of row.tableCells ?? []) starts.push(c.content![0].startIndex!);
  rd.batchUpdate(starts.map((at, k) => ({ insertText: { location: { index: at }, text: ["Name", "Role", "Ada", "Engineer"][k] } })).reverse());
  await start("left-doc-0000006", "right-doc-000006", { typos: 0.5 });
  assert.equal(plain(left, "t.0"), plain(right, "t.0"));
  const out = await getRawDocument("t", "left-doc-0000006");
  const tables = (out.tabs![0].documentTab!.body!.content ?? []).filter((e) => e.table);
  assert.equal(tables.length, 1, "one table, made once");
  assert.equal(tables[0].table!.rows, 2);
});
