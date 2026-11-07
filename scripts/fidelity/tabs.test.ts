/**
 * Document tabs, through the code that calls Google (src/lib/google.ts) over a tabbed stub
 * document: a tab is read as itself, an edit saved to it and a sync typed into it land there and
 * nowhere else, a sync keeps to its tab when the tabs are reordered, and one whose tab is deleted
 * stops saying so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { google } from "googleapis";
import { importDoc } from "../../src/lib/doc-import";
import { directEdits, PENDING_MARK } from "../../src/lib/doc-model";
import { buildDripPlan } from "../../src/lib/drip-engine";
import { batchUpdate, deleteRange, editDocumentWithReplies, getDocSnapshot, getDocument, snapshotOf } from "../../src/lib/google";
import type { EditorNode } from "../../src/lib/rich-text";
import { buildSyncRecords, parseSegments, segmentBoundaries, spotsFor } from "../../src/lib/sync-plan";
import { runJobWindow, type RunnerDeps } from "../../src/lib/sync-runner";
import { createMemoryStore } from "../../src/lib/sync-store";
import { additions } from "../../src/lib/doc-model";
import { stubDocsClient, TabbedStub } from "../e2e-live/stub-tabs";

const docs = new Map<string, TabbedStub>();
(google as unknown as { docs: () => unknown }).docs = () => stubDocsClient(docs);

function tabbed(id: string) {
  const d = new TabbedStub(id, "Field notes", [
    { id: "t.0", title: "Research" },
    { id: "t.web", title: "Web Structured Data", children: [{ id: "t.kid", title: "Sources" }] },
  ]);
  d.tab("t.0").batchUpdate([{ insertText: { location: { index: 1 }, text: "First tab intro\nFirst tab end" } }]);
  d.tab("t.web").batchUpdate([{ insertText: { location: { index: 1 }, text: "Agent payments\nWeb tab end" } }]);
  d.tab("t.kid").batchUpdate([{ insertText: { location: { index: 1 }, text: "A source" } }]);
  docs.set(id, d);
  return d;
}

const plain = (d: TabbedStub, tab: string) => d.tab(tab).text().replace(/^\0/, "").replace(/\n$/, "");
const nodesText = (nodes: EditorNode[]) => nodes.map((n) => (n.content ?? []).map((c) => c.text ?? "").join(""));

test("a tab is read as itself, with the document's tabs in Docs' order and nesting", async () => {
  tabbed("doc-read-1234");
  const first = await getDocument("t", "doc-read-1234");
  assert.equal(first.tabId, "t.0");
  assert.equal(first.first, true);
  assert.deepEqual(first.tabs, [
    { id: "t.0", title: "Research", level: 0 },
    { id: "t.web", title: "Web Structured Data", level: 0 },
    { id: "t.kid", title: "Sources", level: 1, parentId: "t.web" },
  ]);
  assert.deepEqual(nodesText(importDoc(first.doc).nodes), ["First tab intro", "First tab end"]);
  const web = await getDocument("t", "doc-read-1234", "t.web");
  assert.equal(web.first, false);
  assert.deepEqual(nodesText(importDoc(web.doc).nodes), ["Agent payments", "Web tab end"]);
  assert.equal(web.doc.tabs, undefined, "only the tab's own content goes on");
  const kid = await getDocument("t", "doc-read-1234", "t.kid");
  assert.deepEqual(nodesText(importDoc(kid.doc).nodes), ["A source"]);
  await assert.rejects(getDocument("t", "doc-read-1234", "t.gone"), (e: { code?: number }) => e.code === 404);
});

test("an edit saved to a tab changes that tab and no other", async () => {
  const d = tabbed("doc-edit-1234");
  const { doc } = await getDocument("t", "doc-edit-1234", "t.web");
  const base: EditorNode = { type: "doc", content: importDoc(doc).nodes };
  const target = structuredClone(base);
  target.content![0].content = [{ type: "text", text: "Agent payments", marks: [{ type: "bold" }] }];
  target.content!.splice(1, 1);
  const { requests } = directEdits(base, target);
  assert.ok(requests.length > 0);
  await editDocumentWithReplies("t", "doc-edit-1234", requests, undefined, { id: "t.web", first: false });
  assert.equal(plain(d, "t.web"), "Agent payments");
  assert.equal(plain(d, "t.0"), "First tab intro\nFirst tab end", "the first tab is untouched");
  const after = importDoc((await getDocument("t", "doc-edit-1234", "t.web")).doc).nodes;
  assert.ok(after[0].content?.[0].marks?.some((m) => m.type === "bold"));
  assert.ok(d.sent.get("t.web")!.every((r) => JSON.stringify(r).includes('"tabId":"t.web"')), "every request names the tab");
  // A document's first tab is reached by its id as well
  await editDocumentWithReplies("t", "doc-edit-1234", [{ insertText: { location: { index: 1 }, text: "> " } }], undefined, { id: "t.0", first: true });
  assert.equal(plain(d, "t.0"), "> First tab intro\nFirst tab end");
  assert.equal(plain(d, "t.web"), "Agent payments");
});

/** A sync of `typed` added after the tab's first paragraph, built as POST /api/sync/start builds it, run to its end */
async function syncInto(documentId: string, tabId: string, typed: string, during?: (writes: number) => void) {
  const open = await getDocument("t", documentId, tabId);
  const base: EditorNode = { type: "doc", content: importDoc(open.doc).nodes };
  const target = structuredClone(base);
  target.content!.splice(1, 0, { type: "paragraph", attrs: { ...base.content![0].attrs }, content: [{ type: "text", text: typed, marks: [{ type: PENDING_MARK }] }] });
  const { segments, boundaries } = additions(base, target);
  const parsed = parseSegments(JSON.parse(JSON.stringify(segments.map(({ at, mode, text, format }) => ({ at, mode, text, format })))));
  assert.ok(parsed.ok);
  const text = parsed.segments.map((s) => s.text).join("");
  const plan = buildDripPlan(text, { seed: 3, breaks: [], typoFrequency: 0.5, ...(boundaries.length ? { boundaries } : { boundaries: segmentBoundaries(parsed.segments) }) });
  const snap = snapshotOf(open.doc);
  const spots = spotsFor(open.doc, snap.chars, parsed.segments);
  assert.ok(spots, "the additions have their place in the tab");
  let t = 1_000_000;
  const now = () => t;
  const store = createMemoryStore(now);
  const { plan: syncPlan, job } = buildSyncRecords({
    id: `job_${documentId}`, userId: "u", documentId, documentName: "Field notes", tab: { id: open.tabId!, title: "Web Structured Data" },
    plan, format: { paragraphs: [], runs: [] } as never, segments: parsed.segments, spots: spots!, now: t,
    accessToken: "a", refreshToken: "r", baselineWordCount: snap.wordCount,
  });
  await store.setPlan(syncPlan);
  await store.setJob(job);
  await store.addActiveJob(job.id);
  const queue: { generation: number; delaySec: number; tick?: number }[] = [];
  let writes = 0;
  const deps: RunnerDeps = {
    store,
    // As the worker route passes them
    docs: {
      snapshot: getDocSnapshot,
      batch: async (...a: Parameters<typeof batchUpdate>) => { await batchUpdate(...a); during?.(++writes); },
      deleteRange: async (...a: Parameters<typeof deleteRange>) => { await deleteRange(...a); during?.(++writes); },
    },
    refresh: async () => ({ access_token: "a" }),
    enqueue: async (_id, generation, delaySec, tick) => { queue.push({ generation, delaySec, tick }); },
    now,
    sleep: async (ms) => { t += ms; },
  };
  let msg = { generation: 0, delaySec: 0, tick: undefined as number | undefined };
  for (let step = 0; step < 50_000; step++) {
    const r = await runJobWindow(job.id, msg.generation, { ...deps, tick: msg.tick });
    if (r.outcome === "done" || r.outcome === "error") return (await store.getJob(job.id))!;
    const next = queue.shift();
    if (!next) throw new Error(`runner returned ${r.outcome} with nothing queued`);
    t += next.delaySec * 1000;
    msg = { ...next, tick: next.tick };
  }
  throw new Error("the sync did not finish");
}

test("a sync into a tab types there, and the first tab is left alone", async () => {
  const d = tabbed("doc-sync-1234");
  const job = await syncInto("doc-sync-1234", "t.web", "Typed into the web tab.");
  assert.equal(job.status, "done", job.error);
  assert.equal(job.tabId, "t.web");
  assert.equal(job.tabTitle, "Web Structured Data");
  assert.equal(plain(d, "t.web"), "Agent payments\nTyped into the web tab.\nWeb tab end");
  assert.equal(plain(d, "t.0"), "First tab intro\nFirst tab end");
  assert.equal(plain(d, "t.kid"), "A source");
});

test("a sync keeps to its tab when that tab is dragged to the front mid-sync", async () => {
  const d = tabbed("doc-move-1234");
  const job = await syncInto("doc-move-1234", "t.web", "Still the web tab.", (n) => { if (n === 3) d.moveFirst("t.web"); });
  assert.equal(job.status, "done", job.error);
  assert.equal(d.roots[0].id, "t.web");
  assert.equal(plain(d, "t.web"), "Agent payments\nStill the web tab.\nWeb tab end");
  assert.equal(plain(d, "t.0"), "First tab intro\nFirst tab end");
});

test("a sync whose tab is deleted mid-sync stops, naming the tab, and types nowhere else", async () => {
  const d = tabbed("doc-gone-1234");
  const job = await syncInto("doc-gone-1234", "t.web", "This tab is about to go.", (n) => { if (n === 2) d.removeTab("t.web"); });
  assert.equal(job.status, "error");
  assert.match(job.error ?? "", /The tab "Web Structured Data" this sync types into was deleted/);
  assert.equal(plain(d, "t.0"), "First tab intro\nFirst tab end");
});
