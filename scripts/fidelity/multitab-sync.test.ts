/**
 * One sync typing into several tabs, through the code that calls Google (src/lib/google.ts) over a
 * tabbed stub document: tabs it has and a tab it makes, each typed top to bottom in its turn, with
 * typos or without; paused and resumed between two tabs; with a collaborator editing other tabs
 * (Google refuses the batch read before their edit, and the sync reads again); stopping clearly
 * when a tab is deleted or its text rewritten. A one-tab sync is as it was. Also the stub's models
 * of what Compare & Sync makes when it starts (tabs, images, footnotes, headers, page style).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { google } from "googleapis";
import { importDoc } from "../../src/lib/doc-import";
import { additions, PENDING_MARK } from "../../src/lib/doc-model";
import { docTabs, openTab } from "../../src/lib/doc-tabs";
import { buildDripPlan } from "../../src/lib/drip-engine";
import { batchUpdate, batchUpdateWithReplies, canEditDocument, createTab, deleteRange, getDocName, getDocSnapshot, getRawDocument, listRecentDocs, renameTab, snapshotOf, wordsInTabs } from "../../src/lib/google";
import type { EditorNode } from "../../src/lib/rich-text";
import { buildSyncRecords, MAX_COMPARE_SEGMENTS, parseSegments, segmentBoundaries, spotsFor, spotsForTabs, tabsOfSegments, type SegmentInput } from "../../src/lib/sync-plan";
import { applyControl, runJobWindow, type RunnerDeps } from "../../src/lib/sync-runner";
import { createMemoryStore, type SyncJob } from "../../src/lib/sync-store";
import { DocsApiError, StubDocument } from "../e2e-live/stub-docs";
import { stubDocsClient, TabbedStub } from "../e2e-live/stub-tabs";
import { StrictStubDocument } from "./strict-stub";

const docs = new Map<string, TabbedStub>();
(google as unknown as { docs: () => unknown }).docs = () => stubDocsClient(docs);

function fieldNotes(id: string, make?: (documentId: string, title: string) => StubDocument) {
  const d = new TabbedStub(id, "Field notes", [
    { id: "t.0", title: "Research" },
    { id: "t.web", title: "Web", children: [{ id: "t.kid", title: "Sources" }] },
  ], make);
  d.tab("t.0").batchUpdate([{ insertText: { location: { index: 1 }, text: "First tab intro\nFirst tab end" } }]);
  d.tab("t.web").batchUpdate([{ insertText: { location: { index: 1 }, text: "Agent payments\nWeb tab end" } }]);
  d.tab("t.kid").batchUpdate([{ insertText: { location: { index: 1 }, text: "A source" } }]);
  docs.set(id, d);
  return d;
}

const plain = (d: TabbedStub, tab: string) => d.tab(tab).text().replace(/^\0/, "").replace(/\n$/, "");
const plainOf = (doc: EditorNode) => (doc.content ?? []).map((p) => (p.content ?? []).map((c) => (c.type === "image" ? "￼" : c.text ?? "")).join("")).join("\n");
const add = (text: string): EditorNode => ({ type: "text", text, marks: [{ type: PENDING_MARK }] });
/** `base` with a new paragraph after paragraph i */
const paragraphAfter = (i: number, text: string) => (base: EditorNode): EditorNode => {
  const t = structuredClone(base);
  t.content!.splice(i + 1, 0, { type: "paragraph", attrs: { ...base.content![i].attrs }, content: [add(text)] });
  return t;
};
/** `base` with text added at the end of paragraph i */
const appended = (i: number, text: string) => (base: EditorNode): EditorNode => {
  const t = structuredClone(base);
  t.content![i].content = [...(t.content![i].content ?? []), add(text)];
  return t;
};
const both = (...edits: ((d: EditorNode) => EditorNode)[]) => (base: EditorNode) => edits.reduce((d, e) => e(d), base);
const words = (s: string) => (s.replace(/[\0￼]/g, " ").trim() ? s.replace(/[\0￼]/g, " ").trim().split(/\s+/).length : 0);

interface Hooks {
  /** After each snapshot the runner reads */
  snapshot?(n: number, tabId: string | null | undefined): void;
  /** After each batch that landed */
  batch?(n: number, tabId: string | null | undefined): void;
}

/**
 * A sync of each tab's edits, built as POST /api/compare/start builds one (or, `oneTab`, one tab's
 * as POST /api/sync/start does), and the runner that types it
 */
async function startSync(documentId: string, edits: { tabId: string; edit: (base: EditorNode) => EditorNode }[], opts: { seed?: number; typos?: number; windowMs?: number; hooks?: Hooks; oneTab?: boolean } = {}) {
  const raw = await getRawDocument("t", documentId);
  const targets = new Map<string, EditorNode>();
  const segments: SegmentInput[] = [];
  for (const { tabId, edit } of edits) {
    const base: EditorNode = { type: "doc", content: importDoc(openTab(raw, tabId)!.doc).nodes };
    const target = edit(base);
    targets.set(tabId, target);
    segments.push(...additions(base, target).segments.map(({ at, mode, text, format }) => ({ at, mode, text, format, ...(opts.oneTab ? {} : { tabId }) })));
  }
  const parsed = parseSegments(JSON.parse(JSON.stringify(segments)), { maxSegments: MAX_COMPARE_SEGMENTS });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const text = parsed.segments.map((s) => s.text).join("");
  const drip = buildDripPlan(text, { seed: opts.seed ?? 3, breaks: [], typoFrequency: opts.typos ?? 0.5, boundaries: segmentBoundaries(parsed.segments) });
  const one = opts.oneTab ? openTab(raw, edits[0].tabId)!.doc : null;
  const spots = one ? spotsFor(one, snapshotOf(one).chars, parsed.segments) : spotsForTabs(raw, parsed.segments);
  assert.ok(spots, "every addition has its place in its tab");
  const tabIds = tabsOfSegments(parsed.segments).map((t) => t.id);
  let t = 1_000_000;
  const now = () => t;
  const store = createMemoryStore(now);
  const { plan, job } = buildSyncRecords({
    id: `job_${documentId}`, userId: "u", documentId, documentName: "Field notes", tabs: docTabs(raw),
    ...(one ? { tab: { id: edits[0].tabId, title: docTabs(raw).find((x) => x.id === edits[0].tabId)!.title } } : {}),
    plan: drip, format: { paragraphs: [], runs: [] } as never, segments: parsed.segments, spots, now: t,
    accessToken: "a", refreshToken: "r", baselineWordCount: one ? snapshotOf(one).wordCount : wordsInTabs(raw, tabIds),
  });
  await store.setPlan(plan);
  await store.setJob(job);
  await store.addActiveJob(job.id);
  const queue: { generation: number; delaySec: number; tick?: number }[] = [];
  const seen = { snapshots: [] as (string | null | undefined)[], counted: [] as (readonly string[] | null | undefined)[], batches: [] as (string | null | undefined)[], erased: [] as (string | null | undefined)[], refused: 0 };
  const deps: RunnerDeps = {
    store,
    // As the worker route passes them
    docs: {
      snapshot: async (...a: Parameters<typeof getDocSnapshot>) => {
        const snap = await getDocSnapshot(...a);
        seen.snapshots.push(a[2]);
        seen.counted.push(a[3]);
        opts.hooks?.snapshot?.(seen.snapshots.length, a[2]);
        return snap;
      },
      batch: async (...a: Parameters<typeof batchUpdate>) => {
        try {
          await batchUpdate(...a);
        } catch (err) {
          if (/modified since/.test(String(err))) seen.refused++;
          throw err;
        }
        seen.batches.push(a[4]);
        opts.hooks?.batch?.(seen.batches.length, a[4]);
      },
      deleteRange: async (...a: Parameters<typeof deleteRange>) => {
        await deleteRange(...a);
        seen.erased.push(a[5]);
      },
    },
    refresh: async () => ({ access_token: "a" }),
    enqueue: async (_id, generation, delaySec, tick) => { queue.push({ generation, delaySec, tick }); },
    now,
    sleep: async (ms) => { t += ms; },
    ...(opts.windowMs != null ? { windowMs: opts.windowMs } : {}),
  };
  let msg: { generation: number; delaySec: number; tick?: number } = { generation: 0, delaySec: 0 };
  /** Deliver the next queued message; false when nothing is queued */
  const step = async () => {
    const r = await runJobWindow(job.id, msg.generation, { ...deps, tick: msg.tick });
    const next = queue.shift();
    if (!next) return { r, more: false };
    t += next.delaySec * 1000;
    msg = next;
    return { r, more: true };
  };
  const finish = async (): Promise<SyncJob> => {
    for (let n = 0; n < 50_000; n++) {
      const { r, more } = await step();
      if (r.outcome === "done" || r.outcome === "error" || !more) return (await store.getJob(job.id))!;
    }
    throw new Error("the sync did not finish");
  };
  return { job, plan, targets, segments: parsed.segments, store, seen, step, finish, queue, resumeWith: (m: typeof msg) => { msg = m; }, now };
}

const EDITS = (newTab: string) => [
  { tabId: "t.0", edit: both(paragraphAfter(0, "Typed under the intro."), appended(1, " and more")) },
  { tabId: "t.web", edit: paragraphAfter(0, "Payments typed into the web tab.") },
  { tabId: newTab, edit: (base: EditorNode) => ({ type: "doc", content: [
    { type: "paragraph", attrs: { ...base.content![0].attrs }, content: [add("Appendix heading")] },
    { type: "paragraph", attrs: { ...base.content![0].attrs }, content: [add("Its first line, "), { type: "image", attrs: { src: "https://images.example.com/chart.png", width: 200, height: 100 }, marks: [{ type: PENDING_MARK }] }, add(" then the rest.")] },
  ] }) },
];

test("one sync types into two tabs it has and one it made, each ending with exactly its text, the others untouched", async () => {
  for (const [seed, typos] of [[1, 0], [2, 1], [5, 0.5]] as const) {
    const id = `doc-multi-${seed}`;
    const d = fieldNotes(id);
    const appendix = await createTab("t", id, { title: "Appendix" });
    assert.equal(d.tab(appendix).text(), "\0\n", "a new tab is blank");
    const s = await startSync(id, EDITS(appendix), { seed, typos });
    const job = await s.finish();
    assert.equal(job.status, "done", job.error);
    for (const [tabId, target] of s.targets) assert.equal(plain(d, tabId), plainOf(target), `seed ${seed}: tab ${tabId}`);
    assert.equal(plain(d, "t.kid"), "A source", "a tab the sync doesn't type into is untouched");
    assert.equal(d.sent.get("t.kid"), undefined, "and never written to");
    // Typed in its order, tab by tab: never back to a tab it finished
    const order = s.seen.batches.filter((x, i, all) => i === 0 || all[i - 1] !== x);
    assert.deepEqual(order, ["t.0", "t.web", appendix]);
    assert.deepEqual(job.tabs, [{ id: "t.0", title: "Research" }, { id: "t.web", title: "Web" }, { id: appendix, title: "Appendix" }]);
    assert.equal(job.tabId, "t.0");
    assert.ok(s.seen.counted.some((c) => c) && s.seen.counted.every((c) => !c || c.length === 3), "a read for a write counts the words of every tab it types into");
    // Typos are erased in the tab they were made in
    if (typos === 1) assert.ok(s.seen.erased.length > 0, `seed ${seed}: typos were made`);
    if (typos) assert.ok(s.seen.erased.every((x) => x && x !== "t.kid"), `seed ${seed}: ${s.seen.erased}`);
    else assert.equal(s.seen.erased.length, 0);
    // Words added: across every tab it typed into
    const added = [...s.targets.values()].reduce((n, target) => n + words(plainOf(target)), 0) - job.baselineWordCount;
    assert.equal(job.liveWordCount! - job.baselineWordCount, added);
    // The image went in where it was, at its size
    const raw = await getRawDocument("t", id);
    const objects = openTab(raw, appendix)!.doc.inlineObjects ?? {};
    assert.deepEqual(Object.values(objects).map((o) => o.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri), ["https://images.example.com/chart.png"]);
  }
});

test("pausing between two tabs and resuming carries on at the top of the next tab", async () => {
  const d = fieldNotes("doc-pause-1234");
  // One action per delivery, so the pause lands exactly between the tabs
  const s = await startSync("doc-pause-1234", EDITS("t.0").slice(0, 2), { seed: 4, typos: 1, windowMs: 0 });
  const firstTabEnd = s.segments.filter((x) => x.tabId === "t.0").reduce((n, x) => n + x.text.length, 0);
  let job = (await s.store.getJob(s.job.id))!;
  for (let n = 0; job.charsSent < firstTabEnd || job.typoSubStep; n++) {
    assert.ok(n < 5000, "never reached the end of the first tab");
    await s.step();
    job = (await s.store.getJob(s.job.id))!;
  }
  assert.equal(job.charsSent, firstTabEnd);
  assert.equal(plain(d, "t.0"), plainOf(s.targets.get("t.0")!), "the first tab is done");
  assert.equal(plain(d, "t.web"), "Agent payments\nWeb tab end", "the next one not started");
  // As the pause and resume routes do
  const paused = await applyControl(s.store, job, "pause", s.now);
  assert.equal((await runJobWindow(s.job.id, paused.generation, { store: s.store, docs: {} as never, refresh: async () => null, enqueue: async () => {} })).outcome, "paused");
  await s.store.setJob({ ...paused, status: "running", pausedAt: undefined, nextActionAt: undefined, lastDueAt: undefined, generation: paused.generation + 1 });
  s.queue.length = 0;
  s.resumeWith({ generation: paused.generation + 1, delaySec: 0 });
  const done = await s.finish();
  assert.equal(done.status, "done", done.error);
  assert.equal(plain(d, "t.0"), plainOf(s.targets.get("t.0")!));
  assert.equal(plain(d, "t.web"), plainOf(s.targets.get("t.web")!));
});

test("collaborators editing other tabs mid-sync: the batch Google refuses is read again and typed where it goes", async () => {
  const d = fieldNotes("doc-collab-1234");
  const s = await startSync("doc-collab-1234", EDITS("t.0").slice(0, 2), {
    seed: 6,
    typos: 1,
    hooks: {
      // Between a read and its write, someone types in a tab the sync doesn't touch
      snapshot: (n) => { if (n === 3) d.batchUpdate([{ insertText: { location: { index: 1, tabId: "t.kid" }, text: "Note. " } }]); },
      // And at the top of the tab it types into next, before it gets there
      batch: (n, tabId) => { if (n === 2 && tabId === "t.0") d.batchUpdate([{ insertText: { location: { index: 1, tabId: "t.web" }, text: "Hi. " } }]); },
    },
  });
  const job = await s.finish();
  assert.equal(job.status, "done", job.error);
  assert.ok(s.seen.refused >= 1, "Google refused a batch read before the collaborator's edit");
  assert.equal(plain(d, "t.kid"), "Note. A source");
  assert.equal(plain(d, "t.0"), plainOf(s.targets.get("t.0")!));
  assert.equal(plain(d, "t.web"), "Hi. " + plainOf(s.targets.get("t.web")!));
});

test("a tab deleted mid-sync stops it, naming that tab; the tabs before it keep what was typed", async () => {
  const d = fieldNotes("doc-gone-multi");
  const s = await startSync("doc-gone-multi", EDITS("t.0").slice(0, 2), { seed: 2, typos: 0, hooks: { batch: (_n, tabId) => { if (tabId === "t.web") d.removeTab("t.web"); } } });
  const job = await s.finish();
  assert.equal(job.status, "error");
  assert.equal(job.error, 'The tab "Web" this sync types into was deleted.');
  assert.equal(plain(d, "t.0"), plainOf(s.targets.get("t.0")!));
});

test("losing its place in one of its tabs names that tab", async () => {
  const d = fieldNotes("doc-lost-multi");
  const s = await startSync("doc-lost-multi", EDITS("t.0").slice(0, 2), {
    seed: 2,
    typos: 0,
    hooks: { batch: (_n, tabId) => { if (tabId === "t.web") d.batchUpdate([{ deleteContentRange: { range: { startIndex: 1, endIndex: d.tab("t.web").items.length - 1, tabId: "t.web" } } }, { insertText: { location: { index: 1, tabId: "t.web" }, text: "Rewritten" } }]); } },
  });
  const job = await s.finish();
  assert.equal(job.status, "error");
  assert.match(job.error ?? "", /^Couldn't find where this sync was typing in the tab "Web"\./);
});

test("a one-tab sync is as it was: no tabs on the job, each read of its own tab only", async () => {
  const d = fieldNotes("doc-one-1234");
  const s = await startSync("doc-one-1234", [{ tabId: "t.web", edit: both(paragraphAfter(0, "Only the web tab."), appended(1, " for now")) }], { seed: 7, typos: 1, oneTab: true });
  assert.equal(s.segments.some((x) => x.tabId), false);
  const job = await s.finish();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.tabs, undefined);
  assert.equal(job.tabId, "t.web");
  assert.ok(s.seen.snapshots.every((x) => x === "t.web") && s.seen.batches.every((x) => x === "t.web") && s.seen.erased.every((x) => x === "t.web"));
  assert.ok(s.seen.counted.every((c) => c == null), "no other tab's words are asked for");
  assert.equal(plain(d, "t.web"), plainOf(s.targets.get("t.web")!));
  assert.equal(plain(d, "t.0"), "First tab intro\nFirst tab end");
  assert.equal(job.liveWordCount! - job.baselineWordCount, words(plainOf(s.targets.get("t.web")!)) - words("Agent payments Web tab end"));
});

// ── The Google calls Compare & Sync makes at the start ────────────────────────

test("tabs are made where they are asked for, renamed, and given back with the document", async () => {
  const d = fieldNotes("doc-make-1234");
  const child = await createTab("t", "doc-make-1234", { title: "  Notes  ", parentTabId: "t.web", index: 0, iconEmoji: "📎" });
  const top = await createTab("t", "doc-make-1234", { title: "Last" });
  await renameTab("t", "doc-make-1234", "t.0", "Research (2026)");
  const raw = await getRawDocument("t", "doc-make-1234");
  assert.deepEqual(docTabs(raw).map(({ id, title, level, parentId, emoji }) => ({ id, title, level, parentId, emoji })), [
    { id: "t.0", title: "Research (2026)", level: 0, parentId: undefined, emoji: undefined },
    { id: "t.web", title: "Web", level: 0, parentId: undefined, emoji: undefined },
    { id: child, title: "Notes", level: 1, parentId: "t.web", emoji: "📎" },
    { id: "t.kid", title: "Sources", level: 1, parentId: "t.web", emoji: undefined },
    { id: top, title: "Last", level: 0, parentId: undefined, emoji: undefined },
  ]);
  const made = openTab(raw, child)!.doc;
  assert.deepEqual(importDoc(made).nodes.map((n) => n.content ?? []), [[]], "blank");
  assert.ok(made.namedStyles?.styles?.length, "with Google's default named styles");
  // Nested three deep at most
  const deep = await createTab("t", "doc-make-1234", { title: "Deep", parentTabId: "t.kid" });
  await assert.rejects(createTab("t", "doc-make-1234", { title: "Too deep", parentTabId: deep }), (e: DocsApiError) => e.code === 400);
  await assert.rejects(createTab("t", "doc-make-1234", { title: "Nowhere", parentTabId: "t.gone" }), (e: DocsApiError) => e.code === 400);
  assert.equal(d.all().length, 6);
});

test("a batch's replies carry what it made; a refused batch makes nothing, in any tab", async () => {
  const d = fieldNotes("doc-replies-1234");
  const before = d.revisionId;
  const replies = await batchUpdateWithReplies("t", "doc-replies-1234", [
    { insertInlineImage: { location: { index: 1 }, uri: "https://img.example.com/x.png", objectSize: { width: { magnitude: 50, unit: "PT" } } } },
    { createFootnote: { location: { index: 3 } } },
  ], { tabId: "t.web", requiredRevisionId: before });
  assert.match((replies[0] as { insertInlineImage: { objectId: string } }).insertInlineImage.objectId, /^kix\./);
  const footnoteId = (replies[1] as { createFootnote: { footnoteId: string } }).createFootnote.footnoteId;
  assert.ok(footnoteId);
  assert.notEqual(d.revisionId, before);
  // The footnote's text, written into it by its id (it starts as a space and a newline)
  await batchUpdateWithReplies("t", "doc-replies-1234", [{ insertText: { location: { segmentId: footnoteId, index: 1 }, text: "Source: field notes." } }], { tabId: "t.web" });
  assert.equal(d.tab("t.web").segmentText(footnoteId), " Source: field notes.\n");
  const web = openTab(await getRawDocument("t", "doc-replies-1234"), "t.web")!.doc;
  assert.equal(web.footnotes?.[footnoteId]?.content?.[0].paragraph?.elements?.[0].textRun?.content, " Source: field notes.\n");
  assert.equal(importDoc(web).nodes[0].content?.filter((n) => n.type === "footnoteRef").length, 1);
  // All or nothing: a new tab and an edit in another are undone with the request Google refuses
  const tabs = d.all().length;
  const text = plain(d, "t.0");
  await assert.rejects(batchUpdateWithReplies("t", "doc-replies-1234", [
    { addDocumentTab: { tabProperties: { title: "Half" } } },
    { insertText: { location: { index: 1, tabId: "t.0" }, text: "Lost " } },
    { insertInlineImage: { location: { index: 1, tabId: "t.0" }, uri: "file:///etc/passwd" } },
  ]), (e: DocsApiError) => e.code === 400);
  assert.equal(d.all().length, tabs);
  assert.equal(plain(d, "t.0"), text);
});

test("a new tab's page and header, set up as a start sets them", async () => {
  const d = fieldNotes("doc-setup-1234");
  const tab = await createTab("t", "doc-setup-1234", { title: "Letter" });
  await batchUpdateWithReplies("t", "doc-setup-1234", [{ updateDocumentStyle: { documentStyle: { marginTop: { magnitude: 36, unit: "PT" } }, fields: "marginTop" } }], { tabId: tab });
  const replies = await batchUpdateWithReplies("t", "doc-setup-1234", [{ createHeader: { type: "DEFAULT" } }], { tabId: tab });
  const headerId = (replies[0] as { createHeader: { headerId: string } }).createHeader.headerId;
  await batchUpdateWithReplies("t", "doc-setup-1234", [{ insertText: { location: { segmentId: headerId, index: 0 }, text: "ACME Ltd." } }], { tabId: tab });
  const doc = openTab(await getRawDocument("t", "doc-setup-1234"), tab)!.doc;
  assert.equal(doc.documentStyle?.marginTop?.magnitude, 36);
  assert.equal(doc.documentStyle?.defaultHeaderId, headerId);
  assert.equal(doc.headers?.[headerId]?.content?.[0].paragraph?.elements?.[0].textRun?.content, "ACME Ltd.\n");
  assert.equal(d.tab("t.0").documentStyle.marginTop?.magnitude, 72, "another tab's page is its own");
  await assert.rejects(batchUpdateWithReplies("t", "doc-setup-1234", [{ createHeader: { type: "DEFAULT" } }], { tabId: tab }), (e: DocsApiError) => e.code === 400, "a second header for the same page");
});

test("the document read with every tab names each tab's lists from that tab's export", async () => {
  const d = fieldNotes("doc-names-1234", (id, title) => new StrictStubDocument(id, title, {}));
  // A checklist: the API gives its levels no glyph
  d.batchUpdate([{ createParagraphBullets: { range: { startIndex: 1, endIndex: 3, tabId: "t.web" }, bulletPreset: "BULLET_CHECKBOX" } }]);
  const listId = Object.keys(d.tab("t.web").lists)[0];
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(`<style>.lst-${listId.replace(/\./g, "_")}-0>li:before{content:"\\0025cb  "}</style>`, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    const raw = await getRawDocument("t", "doc-names-1234");
    assert.deepEqual(asked, ["https://docs.google.com/document/d/doc-names-1234/export?format=html&tab=t.web"], "only the tab with such a list is exported");
    const lists = openTab(raw, "t.web")!.doc.lists!;
    assert.equal(lists[listId].listProperties?.nestingLevels?.[0].glyphSymbol, "○");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Drive: edit rights, a document's name, and the user's documents without the trash, searched by name", async () => {
  const asked: { q?: string; fields?: string; fileId?: string }[] = [];
  const realDrive = google.drive;
  (google as unknown as { drive: () => unknown }).drive = () => ({
    files: {
      async get(p: { fileId: string; fields: string }) {
        asked.push(p);
        if (p.fileId === "gone") throw Object.assign(new Error("File not found"), { code: 404 });
        return { data: { name: "Field notes", capabilities: { canEdit: p.fileId === "mine" } } };
      },
      async list(p: { q: string }) {
        asked.push(p);
        return { data: { files: [{ id: "a", name: "It's \\ here", modifiedTime: "2026-11-01T00:00:00Z" }] } };
      },
    },
  });
  try {
    assert.equal(await canEditDocument("t", "mine"), true);
    assert.equal(await canEditDocument("t", "shared-to-view"), false);
    await assert.rejects(canEditDocument("t", "gone"), (e: { code?: number }) => e.code === 404);
    assert.equal(await getDocName("t", "mine"), "Field notes");
    const files = await listRecentDocs("t", 25, " It's \\ here ");
    assert.deepEqual(files, [{ id: "a", name: "It's \\ here", modifiedTime: "2026-11-01T00:00:00Z" }]);
    assert.equal(asked[asked.length - 1].q, "mimeType='application/vnd.google-apps.document' and trashed=false and name contains 'It\\'s \\\\ here'");
    await listRecentDocs("t", 25);
    assert.equal(asked[asked.length - 1].q, "mimeType='application/vnd.google-apps.document' and trashed=false");
  } finally {
    (google as unknown as { drive: typeof realDrive }).drive = realDrive;
  }
});
