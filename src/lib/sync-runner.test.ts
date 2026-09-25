import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDripPlan, type DripAction } from "./drip-engine";
import { createMemoryStore, type SyncJob, type SyncPlan, type SyncStore } from "./sync-store";
import { runJobWindow, type DocsApi, type RunnerDeps } from "./sync-runner";

// ── Fakes ──────────────────────────────────────────────────────────────────

class FakeClock {
  t = 1_000_000;
  now = () => this.t;
  sleep = async (ms: number) => { this.t += ms; };
}

/** A Google Doc: user text, Docs-style indices (body starts at 1, trailing newline). */
class FakeDoc implements DocsApi {
  text = "";
  calls = { snapshot: 0, insert: 0, delete: 0 };
  /** When set, the next insert applies the write but then throws (response lost). */
  failNextInsertAfterWrite = false;
  /** When set, the next insert throws before writing. */
  failNextInsertBeforeWrite = false;
  tokensSeen = new Set<string>();
  /** Accept inserts anywhere (syncs into an existing document) */
  anywhere = false;

  async snapshot(token: string) {
    this.tokensSeen.add(token);
    this.calls.snapshot++;
    const trimmed = this.text.trim();
    return {
      endIndex: this.text.length + 2,
      tail: this.text.slice(-400),
      wordCount: trimmed ? trimmed.split(/\s+/).length : 0,
      // Index 0 is the section break; the body ends with its own newline
      chars: "\0" + this.text + "\n",
      revisionId: "r1",
    };
  }
  /** Every non-content request the runner sent, in order */
  styling: Record<string, unknown>[] = [];
  /** Hook to observe the text after each batch */
  onBatch?: (text: string) => void;
  failNextBatch?: Error;

  async batch(token: string, _doc: string, requests: object[]) {
    if (token === "expired") { const e = new Error("unauthorized") as Error & { code: number }; e.code = 401; throw e; }
    if (this.failNextBatch) { const e = this.failNextBatch; this.failNextBatch = undefined; throw e; }
    this.calls.insert++;
    if (this.failNextInsertBeforeWrite) { this.failNextInsertBeforeWrite = false; throw new Error("network down"); }
    let first = true;
    for (const r of requests as Record<string, { location?: { index: number }; text?: string; uri?: string }>[]) {
      const ins = r.insertText ?? r.insertInlineImage;
      if (!ins) { this.styling.push(r); continue; }
      const index = ins.location!.index;
      if (first && !this.anywhere) assert.equal(index, this.text.length + 1, "runner must append at the end");
      first = false;
      const piece = r.insertText ? ins.text! : "\uFFFC";
      this.text = this.text.slice(0, index - 1) + piece + this.text.slice(index - 1);
    }
    this.onBatch?.(this.text);
    if (this.failNextInsertAfterWrite) { this.failNextInsertAfterWrite = false; throw new Error("socket hang up"); }
  }
  async deleteRange(_t: string, _d: string, start: number, end: number) {
    this.calls.delete++;
    this.text = this.text.slice(0, start - 1) + this.text.slice(end - 1);
  }
}

interface Harness {
  store: SyncStore;
  doc: FakeDoc;
  clock: FakeClock;
  queue: { jobId: string; generation: number; delaySec: number }[];
  deps: RunnerDeps;
  jobId: string;
}

async function makeHarness(text: string, opts: { seed?: number; actions?: DripAction[]; startInMs?: number; windowMs?: number; existing?: string; anchor?: { mode: "before" | "after"; at: number } } = {}): Promise<Harness> {
  const clock = new FakeClock();
  const store = createMemoryStore(clock.now);
  const doc = new FakeDoc();
  if (opts.existing != null) {
    doc.text = opts.existing;
    doc.anywhere = true;
  }
  const queue: Harness["queue"] = [];
  const plan = buildDripPlan(text, { seed: opts.seed ?? 1, breaks: [] });
  const actions = opts.actions ?? plan.actions;
  const jobId = "job1";
  const syncPlan: SyncPlan = { id: jobId, userId: "u1", documentId: "d1", actions, totalChars: text.length, totalMs: plan.totalMs, breaks: [], seed: plan.seed, createdAt: clock.now() };
  const job: SyncJob = {
    id: jobId, userId: "u1", documentId: "d1", documentName: "Doc", status: opts.startInMs ? "scheduled" : "pending",
    createdAt: clock.now(), startAt: clock.now() + (opts.startInMs ?? 0),
    currentAction: 0, totalActions: actions.length, charsSent: 0, totalChars: text.length,
    typoSubStep: 0, typoCharsInDoc: 0, generation: 0, failures: 0,
    accessToken: "tok", refreshToken: "ref", activity: "Queued", wpm: 0, baselineWordCount: 0,
    breaks: [], completedBreaks: [], lastUpdate: clock.now(),
  };
  if (opts.anchor) {
    // As the start route does: the doc text just before the typing position
    const chars = "\0" + doc.text + "\n";
    job.anchor = { mode: opts.anchor.mode, ctx: chars.slice(Math.max(0, opts.anchor.at - 40), opts.anchor.at), cursor: opts.anchor.at, opened: false };
  }
  await store.setPlan(syncPlan);
  await store.setJob(job);
  await store.addActiveJob(jobId);
  const deps: RunnerDeps = {
    store, docs: doc, now: clock.now, sleep: clock.sleep, windowMs: opts.windowMs ?? 20_000,
    refresh: async () => ({ access_token: "fresh" }),
    enqueue: async (id, generation, delaySec) => { queue.push({ jobId: id, generation, delaySec }); },
  };
  return { store, doc, clock, queue, deps, jobId };
}

/** Deliver queued messages like QStash would, until nothing is queued. */
async function drain(h: Harness, maxSteps = 5000): Promise<string[]> {
  const outcomes: string[] = [];
  let steps = 0;
  while (h.queue.length > 0 && steps++ < maxSteps) {
    const msg = h.queue.shift()!;
    h.clock.t += msg.delaySec * 1000;
    const r = await runJobWindow(msg.jobId, msg.generation, h.deps);
    outcomes.push(r.outcome);
  }
  assert.ok(steps < maxSteps, "queue never drained");
  return outcomes;
}

const TEXT = "The quick brown fox jumps over the lazy dog. It was a sunny day!\n\nSecond paragraph here, with more words to type out slowly.";

// ── Tests ──────────────────────────────────────────────────────────────────

test("runs a whole plan through the queue and reproduces the text exactly", async () => {
  const h = await makeHarness(TEXT, { seed: 3 });
  const first = await runJobWindow(h.jobId, 0, h.deps);
  assert.ok(["waiting", "chained"].includes(first.outcome), first.outcome);
  const outcomes = await drain(h);
  assert.equal(outcomes[outcomes.length - 1], "done");
  assert.equal(h.doc.text, TEXT);
  const job = (await h.store.getJob(h.jobId))!;
  assert.equal(job.status, "done");
  assert.equal(job.charsSent, TEXT.length);
  assert.deepEqual(await h.store.getActiveJobIds(), []);
  // Every invocation stayed inside its window: waits longer than the window went to the queue
  assert.ok(outcomes.filter((o) => o === "waiting").length > 0);
});

test("long waits are handed to the queue with the exact delay, not slept in the function", async () => {
  const actions: DripAction[] = [
    { kind: "insert", text: "a ", delayMs: 0, activity: "Typing…" },
    { kind: "pause", text: "", delayMs: 10 * 60_000, activity: "Break", breakIndex: 0 },
    { kind: "insert", text: "b", delayMs: 500, activity: "Typing…" },
  ];
  const h = await makeHarness("a b", { actions });
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "waiting");
  assert.equal(h.queue.length, 1);
  assert.equal(h.queue[0].delaySec, 600);
  const job = (await h.store.getJob(h.jobId))!;
  assert.equal(job.nextBreakAction, 1);
  assert.equal(job.etaTargetAt, job.nextActionAt! + 500);
  await drain(h);
  assert.equal(h.doc.text, "a b");
  assert.deepEqual((await h.store.getJob(h.jobId))!.completedBreaks, [0]);
});

test("a second delivery while the job is locked is rejected and schedules one re-kick", async () => {
  const h = await makeHarness(TEXT);
  assert.equal(await h.store.acquireLock(h.jobId, 60), true);
  const r1 = await runJobWindow(h.jobId, 0, h.deps);
  const r2 = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r1.outcome, "busy");
  assert.equal(r2.outcome, "busy");
  assert.equal(h.queue.length, 1, "only one re-kick should be queued");
  assert.equal(h.queue[0].delaySec, 25);
  assert.equal(h.doc.text, "");
});

test("a write whose response was lost is not repeated after the retry", async () => {
  const actions: DripAction[] = [
    { kind: "insert", text: "Hello ", delayMs: 0, activity: "Typing…" },
    { kind: "insert", text: "world", delayMs: 500, activity: "Typing…" },
    { kind: "insert", text: "!", delayMs: 500, activity: "Typing…" },
  ];
  const h = await makeHarness("Hello world!", { actions });
  h.doc.failNextInsertAfterWrite = true; // first write lands, response is lost
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "retry");
  assert.equal(h.doc.text, "Hello ");
  const outcomes = await drain(h);
  assert.equal(outcomes[outcomes.length - 1], "done");
  assert.equal(h.doc.text, "Hello world!");
  assert.equal(h.doc.calls.insert, 3, "no duplicate insert");
});

test("a failure before the write is retried and then succeeds", async () => {
  const h = await makeHarness("abc def", { actions: [
    { kind: "insert", text: "abc ", delayMs: 0, activity: "Typing…" },
    { kind: "insert", text: "def", delayMs: 500, activity: "Typing…" },
  ] });
  h.doc.failNextInsertBeforeWrite = true;
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "retry");
  assert.equal(h.queue[0].delaySec, 15);
  await drain(h);
  assert.equal(h.doc.text, "abc def");
});

test("repeated failures end the job with an error", async () => {
  const h = await makeHarness("x", { actions: [{ kind: "insert", text: "x", delayMs: 0, activity: "Typing…" }] });
  h.doc.batch = async () => { throw new Error("quota exceeded"); };
  let last = await runJobWindow(h.jobId, 0, h.deps);
  while (last.outcome === "retry") {
    const msg = h.queue.shift()!;
    h.clock.t += msg.delaySec * 1000;
    last = await runJobWindow(msg.jobId, msg.generation, h.deps);
  }
  assert.equal(last.outcome, "error");
  const job = (await h.store.getJob(h.jobId))!;
  assert.equal(job.status, "error");
  assert.match(job.error!, /quota exceeded/);
  assert.equal(h.queue.length, 0);
});

test("typos type the wrong text, hold, delete it and type the right text", async () => {
  const actions: DripAction[] = [
    { kind: "insert", text: "I ", delayMs: 0, activity: "Typing…" },
    { kind: "typo", text: "think ", typoChars: "thnik", delayMs: 500, holdMs: 800, activity: "Correcting a typo…" },
    { kind: "insert", text: "so.", delayMs: 500, activity: "Typing…" },
  ];
  const h = await makeHarness("I think so.", { actions });
  const seen: string[] = [];
  h.doc.onBatch = (text) => seen.push(text);
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  assert.equal(h.doc.text, "I think so.");
  assert.ok(seen.includes("I thnik"), "wrong characters were typed first");
  assert.equal(h.doc.calls.delete, 1);
  assert.equal((await h.store.getJob(h.jobId))!.charsSent, "I think so.".length);
});

test("pause during a wait stops the run; resume with a new generation continues; the old message is stale", async () => {
  const h = await makeHarness(TEXT, { seed: 5, windowMs: 60_000 });
  let paused = false;
  const realSleep = h.deps.sleep!;
  h.deps.sleep = async (ms) => {
    await realSleep(ms);
    if (!paused) {
      paused = true;
      const j = (await h.store.getJob(h.jobId))!;
      await h.store.setJob({ ...j, status: "paused", pausedAt: h.clock.now() });
    }
  };
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "paused");
  const before = h.doc.text;
  assert.ok(before.length > 0 && before.length < TEXT.length);

  // Old queued message must be ignored while paused
  assert.equal((await runJobWindow(h.jobId, 0, h.deps)).outcome, "paused");

  // Resume: bump generation, clear the wait so the current action restarts its delay
  const j = (await h.store.getJob(h.jobId))!;
  await h.store.setJob({ ...j, status: "running", generation: j.generation + 1, nextActionAt: undefined, pausedAt: undefined });
  assert.equal((await runJobWindow(h.jobId, 0, h.deps)).outcome, "stale");
  h.queue.push({ jobId: h.jobId, generation: 1, delaySec: 0 });
  h.deps.sleep = realSleep;
  const outcomes = await drain(h);
  assert.equal(outcomes[outcomes.length - 1], "done");
  assert.equal(h.doc.text, TEXT);
});

test("cancel is honoured between actions and the lock is released", async () => {
  const h = await makeHarness(TEXT, { seed: 6, windowMs: 60_000 });
  let cancelled = false;
  const realSleep = h.deps.sleep!;
  h.deps.sleep = async (ms) => {
    await realSleep(ms);
    if (!cancelled) {
      cancelled = true;
      const j = (await h.store.getJob(h.jobId))!;
      await h.store.setJob({ ...j, status: "cancelled" });
    }
  };
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "cancelled");
  assert.equal(await h.store.acquireLock(h.jobId, 1), true, "lock must be released");
});

test("scheduled jobs wait in the queue until their start time", async () => {
  const h = await makeHarness("hi there", { startInMs: 30 * 60_000, actions: [
    { kind: "insert", text: "hi ", delayMs: 0, activity: "Typing…" },
    { kind: "insert", text: "there", delayMs: 400, activity: "Typing…" },
  ] });
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "waiting");
  assert.equal(h.queue[0].delaySec, 1800);
  assert.equal((await h.store.getJob(h.jobId))!.status, "scheduled");
  await drain(h);
  assert.equal(h.doc.text, "hi there");
  assert.equal((await h.store.getJob(h.jobId))!.status, "done");
});

test("an expired access token is refreshed and the write retried", async () => {
  const h = await makeHarness("ok", { actions: [{ kind: "insert", text: "ok", delayMs: 0, activity: "Typing…" }] });
  const j = (await h.store.getJob(h.jobId))!;
  await h.store.setJob({ ...j, accessToken: "expired" });
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "done");
  assert.equal(h.doc.text, "ok");
  assert.equal((await h.store.getJob(h.jobId))!.accessToken, "fresh");
});

test("finished jobs are not re-run by late deliveries", async () => {
  const h = await makeHarness("z", { actions: [{ kind: "insert", text: "z", delayMs: 0, activity: "Typing…" }] });
  assert.equal((await runJobWindow(h.jobId, 0, h.deps)).outcome, "done");
  assert.equal((await runJobWindow(h.jobId, 0, h.deps)).outcome, "already_finished");
  assert.equal(h.doc.text, "z");
});

test("a pause intent left while the worker holds the lock is applied without losing progress", async () => {
  const h = await makeHarness(TEXT, { seed: 12, windowMs: 60_000 });
  let armed = false;
  const realSleep = h.deps.sleep!;
  h.deps.sleep = async (ms) => {
    await realSleep(ms);
    if (!armed) { armed = true; await h.store.setControl(h.jobId, "pause"); }
  };
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "paused");
  const job = (await h.store.getJob(h.jobId))!;
  assert.equal(job.status, "paused");
  assert.equal(await h.store.getControl(h.jobId), null, "intent is consumed");
  assert.equal(job.charsSent, h.doc.text.length, "cursor matches what was typed");
  // Resume and finish
  await h.store.setJob({ ...job, status: "running", generation: job.generation + 1, nextActionAt: undefined, pausedAt: undefined });
  h.deps.sleep = realSleep;
  h.queue.push({ jobId: h.jobId, generation: job.generation + 1, delaySec: 0 });
  await drain(h);
  assert.equal(h.doc.text, TEXT);
});

test("a cancel intent waiting when a delivery arrives cancels before any typing", async () => {
  const h = await makeHarness(TEXT, { seed: 13 });
  await h.store.setControl(h.jobId, "cancel");
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "cancelled");
  assert.equal(h.doc.text, "");
  assert.deepEqual(await h.store.getActiveJobIds(), []);
});

type Req = Record<string, { range: { startIndex: number; endIndex: number }; textStyle?: Record<string, unknown>; paragraphStyle?: Record<string, unknown>; bulletPreset?: string }>;

async function formattedHarness(content: Record<string, unknown>[], actions: DripAction[]) {
  const { richFromEditorJSON } = await import("./rich-text");
  const { text, format } = richFromEditorJSON({ type: "doc", content });
  const h = await makeHarness(text, { actions });
  const plan = (await h.store.getPlan(h.jobId))!;
  await h.store.setPlan({ ...plan, format });
  const batches: { text: string; reqs: Req[] }[] = [];
  const origBatch = h.doc.batch.bind(h.doc);
  h.doc.batch = async (tok, d, requests) => {
    const n = h.doc.styling.length;
    await origBatch(tok, d, requests);
    const inserted = (requests as Record<string, { text?: string }>[])
      .map((r) => (r.insertText ? r.insertText.text : r.insertInlineImage ? "\uFFFC" : ""))
      .join("");
    batches.push({ text: inserted, reqs: h.doc.styling.slice(n) as Req[] });
  };
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  return { h, text, batches };
}

test("formatted plans send styling in the same batch as each insert, at the right indices", async () => {
  const { h, text, batches } = await formattedHarness(
    [
      { type: "paragraph", attrs: { styleName: "h1" }, content: [{ type: "text", text: "Big" }] },
      { type: "paragraph", attrs: { firstLine: true }, content: [{ type: "text", text: "said ", marks: [{ type: "italic" }] }, { type: "text", text: "hi" }] },
    ],
    [
      { kind: "insert", text: "Big\n", delayMs: 0, activity: "Typing" },
      { kind: "typo", text: "said ", typoChars: "siad", delayMs: 500, holdMs: 500, activity: "Fixing a typo" },
      { kind: "insert", text: "hi", delayMs: 500, activity: "Typing" },
    ]
  );
  assert.equal(h.doc.text, text);
  assert.deepEqual(batches.map((b) => b.text), ["Big\n", "siad", "said ", "hi"]);
  const [b0, b1, b2, b3] = batches;
  assert.equal(b0.reqs[0].updateParagraphStyle.paragraphStyle!.namedStyleType, "HEADING_1");
  assert.deepEqual(b0.reqs[1].updateTextStyle.range, { startIndex: 1, endIndex: 5 });
  assert.equal((b0.reqs[1].updateTextStyle.textStyle!.fontSize as { magnitude: number }).magnitude, 20);
  // The typo's wrong characters only get character styling
  assert.equal(b1.reqs.length, 1);
  assert.equal(b1.reqs[0].updateTextStyle.textStyle!.italic, true);
  assert.deepEqual(b1.reqs[0].updateTextStyle.range, { startIndex: 5, endIndex: 9 });
  // The correct text sets the paragraph (first-line indent) and italic
  assert.equal((b2.reqs[0].updateParagraphStyle.paragraphStyle!.indentFirstLine as { magnitude: number }).magnitude, 36);
  assert.equal(b2.reqs[1].updateTextStyle.textStyle!.italic, true);
  // "hi" continues the paragraph: plain text, no paragraph request
  assert.equal(b3.reqs.length, 1);
  assert.equal(b3.reqs[0].updateTextStyle.textStyle!.italic, false);
});

test("lists: bullets start once, items join the same list across writes, and plain paragraphs leave it", async () => {
  const item = (t: string, list: string | null) => ({ type: "paragraph", attrs: { list }, content: [{ type: "text", text: t }] });
  const { h, text, batches } = await formattedHarness(
    [item("Intro", null), item("one", "ordered"), item("two", "ordered"), item("three", "ordered"), item("After", null)],
    [
      { kind: "insert", text: "Intro\n", delayMs: 0, activity: "Typing" },
      { kind: "insert", text: "one\ntwo\n", delayMs: 400, activity: "Typing" },
      { kind: "insert", text: "thr", delayMs: 400, activity: "Typing" },
      { kind: "insert", text: "ee\n", delayMs: 400, activity: "Typing" },
      { kind: "insert", text: "After", delayMs: 400, activity: "Typing" },
    ]
  );
  assert.equal(h.doc.text, text);
  const creates = batches.map((b) => b.reqs.filter((r) => r.createParagraphBullets).map((r) => r.createParagraphBullets));
  const deletes = batches.map((b) => b.reqs.filter((r) => r.deleteParagraphBullets).length);
  // Batch 1 (Intro): not a list, nothing to delete (nothing inherited)
  assert.deepEqual(creates[0], []);
  assert.equal(deletes[0], 0);
  // Batch 2 starts the numbered list at "one" (doc index 7) and covers "two" in the same list
  assert.equal(creates[1].length, 2);
  assert.deepEqual(creates[1][1].range, { startIndex: 7, endIndex: 15 });
  assert.equal(creates[1][1].bulletPreset, "NUMBERED_DECIMAL_ALPHA_ROMAN");
  // Batch 3: "three" was created by a newline typed in "two", which was not a list yet
  // at that moment, so it re-creates the list from "one" to keep numbering continuous
  assert.equal(creates[2].length, 1);
  assert.deepEqual(creates[2][0].range, { startIndex: 7, endIndex: 18 });
  // Batch 4 finishes "three"; its newline is typed inside a list item, so the next line inherits the list
  assert.deepEqual(creates[3], []);
  // Batch 5: "After" leaves the inherited list
  assert.equal(deletes[4], 1);
  assert.deepEqual(creates[4], []);
  const job = (await h.store.getJob(h.jobId))!;
  assert.equal(job.docList ?? null, null);
});

test("images are inserted inline in the same batch, and links get Docs' link colour", async () => {
  const { h, batches } = await formattedHarness(
    [{ type: "paragraph", content: [
      { type: "text", text: "See " },
      { type: "image", attrs: { src: "https://example.com/a.png", width: 200, height: 100 } },
      { type: "text", text: " site", marks: [{ type: "link", attrs: { href: "example.com" } }] },
    ] }],
    [
      { kind: "insert", text: "See \uFFFC", delayMs: 0, activity: "Typing" },
      { kind: "insert", text: " site", delayMs: 400, activity: "Typing" },
    ]
  );
  assert.equal(h.doc.text, "See \uFFFC site");
  const linkReq = batches[1].reqs.find((r) => r.updateTextStyle && (r.updateTextStyle.textStyle as { link?: unknown }).link)!;
  const ts = linkReq.updateTextStyle.textStyle as { link: { url: string }; underline: boolean; foregroundColor: { color: { rgbColor: { blue: number } } } };
  assert.equal(ts.link.url, "https://example.com");
  assert.equal(ts.underline, true);
  assert.ok(ts.foregroundColor.color.rgbColor.blue > 0.7);
});

test("image batches carry insertInlineImage with the image address and size", async () => {
  const { richFromEditorJSON } = await import("./rich-text");
  const { text, format } = richFromEditorJSON({ type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "A" }, { type: "image", attrs: { src: "https://example.com/b.jpg", width: 400, height: 300 } }, { type: "text", text: "B" },
  ] }] });
  const h = await makeHarness(text, { actions: [{ kind: "insert", text, delayMs: 0, activity: "Typing" }] });
  const plan = (await h.store.getPlan(h.jobId))!;
  await h.store.setPlan({ ...plan, format });
  let seen: object[] = [];
  const orig = h.doc.batch.bind(h.doc);
  h.doc.batch = async (tok, d, requests) => { seen = requests; return orig(tok, d, requests); };
  await runJobWindow(h.jobId, 0, h.deps);
  const kinds = seen.map((r) => Object.keys(r)[0]);
  assert.deepEqual(kinds.slice(0, 3), ["insertText", "insertInlineImage", "insertText"]);
  const img = (seen[1] as { insertInlineImage: { location: { index: number }; uri: string; objectSize: { width: { magnitude: number } } } }).insertInlineImage;
  assert.equal(img.location.index, 2);
  assert.equal(img.uri, "https://example.com/b.jpg");
  assert.equal(img.objectSize.width.magnitude, 300);
  assert.equal(h.doc.text, "A\uFFFCB");
});

// ── Syncing into an existing document ─────────────────────────────────────

const EXISTING = "Why do you want to join?\nBecause.\nWhat else?\nNothing.";

test("types after a chosen paragraph inside an existing document", async () => {
  // "Because.\n" ends at doc index 35, and "What else?" starts there
  const h = await makeHarness(TEXT, { seed: 5, existing: EXISTING, anchor: { mode: "after", at: 35 } });
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  assert.equal(h.doc.text, "Why do you want to join?\nBecause.\n" + TEXT + "\nWhat else?\nNothing.");
  assert.equal((await h.store.getJob(h.jobId))!.status, "done");
});

test("types before the first paragraph", async () => {
  const h = await makeHarness(TEXT, { seed: 6, existing: EXISTING, anchor: { mode: "before", at: 1 } });
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  assert.equal(h.doc.text, TEXT + "\n" + EXISTING);
});

test("keeps its place when the document is edited above it during the sync", async () => {
  const h = await makeHarness(TEXT, { seed: 7, existing: EXISTING, anchor: { mode: "after", at: 35 } });
  let edits = 0;
  h.doc.onBatch = () => {
    // Someone types at the top of the doc in Google Docs between our writes
    if (edits++ % 3 === 0) h.doc.text = "Note. " + h.doc.text;
  };
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  const notes = "Note. ".repeat(Math.ceil(edits / 3));
  assert.equal(h.doc.text, notes + "Why do you want to join?\nBecause.\n" + TEXT + "\nWhat else?\nNothing.");
});

test("a lost response on the first write does not open a second paragraph", async () => {
  const actions: DripAction[] = [
    { kind: "insert", text: "Hello ", delayMs: 0, activity: "Typing" },
    { kind: "insert", text: "world", delayMs: 500, activity: "Typing" },
  ];
  const h = await makeHarness("Hello world", { actions, existing: EXISTING, anchor: { mode: "after", at: 35 } });
  h.doc.failNextInsertAfterWrite = true;
  const r = await runJobWindow(h.jobId, 0, h.deps);
  assert.equal(r.outcome, "retry");
  await drain(h);
  assert.equal(h.doc.text, "Why do you want to join?\nBecause.\nHello world\nWhat else?\nNothing.");
});

test("typos inside an existing document are erased at the right place", async () => {
  const actions: DripAction[] = [
    { kind: "insert", text: "Good ", delayMs: 0, activity: "Typing" },
    { kind: "typo", text: "answer", typoChars: "anwser", holdMs: 800, delayMs: 300, activity: "Typing" },
  ];
  const h = await makeHarness("Good answer", { actions, existing: EXISTING, anchor: { mode: "before", at: 35 } });
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  assert.equal(h.doc.text, "Why do you want to join?\nBecause.\nGood answer\nWhat else?\nNothing.");
  assert.equal(h.doc.calls.delete, 1);
});

test("fails clearly when the text around the sync was deleted", async () => {
  const actions: DripAction[] = [
    { kind: "insert", text: "One ", delayMs: 0, activity: "Typing" },
    { kind: "insert", text: "two", delayMs: 500, activity: "Typing" },
  ];
  const h = await makeHarness("One two", { actions, existing: EXISTING, anchor: { mode: "after", at: 35 } });
  h.doc.onBatch = () => { h.doc.text = "Rewritten"; };
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  const job = (await h.store.getJob(h.jobId))!;
  assert.equal(job.status, "error");
  assert.match(job.error ?? "", /Couldn't find where this sync was typing/);
});

test("a paragraph opened from a bulleted one leaves that list", async () => {
  const { richFromEditorJSON } = await import("./rich-text");
  const { text, format } = richFromEditorJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plain answer" }] }] });
  const h = await makeHarness(text, { actions: [{ kind: "insert", text, delayMs: 0, activity: "Typing" }], existing: EXISTING, anchor: { mode: "after", at: 26 } });
  const plan = (await h.store.getPlan(h.jobId))!;
  await h.store.setPlan({ ...plan, format });
  const job = (await h.store.getJob(h.jobId))!;
  await h.store.setJob({ ...job, docList: { type: "bullet", start: -1 } });
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  assert.equal(h.doc.text, "Why do you want to join?\nPlain answer\nBecause.\nWhat else?\nNothing.");
  const del = h.doc.styling.find((r) => r.deleteParagraphBullets) as { deleteParagraphBullets: { range: { startIndex: number } } } | undefined;
  assert.ok(del, "bullets inherited from the list item are removed");
  assert.equal(del!.deleteParagraphBullets.range.startIndex, 26);
});

// ── Additions in several places ───────────────────────────────────────────

import { additions, PENDING_MARK } from "./doc-model";
import { planSpots } from "./spots";
import type { EditorNode } from "./rich-text";

const plainOf = (d: EditorNode) => (d.content ?? []).map((n) => (n.content ?? []).map((c) => c.text ?? "").join("")).join("\n");

async function additionsHarness(base: EditorNode, target: EditorNode, seed: number) {
  const { segments, text, boundaries } = additions(base, target);
  const plan = buildDripPlan(text, { seed, boundaries, breaks: [], typoFrequency: 1 });
  const existing = plainOf(base);
  const h = await makeHarness(text, { actions: plan.actions, existing });
  const stored = (await h.store.getPlan(h.jobId))!;
  let start = 0;
  const planSegments = segments.map((s) => {
    const seg = { start, end: start + s.text.length, mode: s.mode, format: s.format };
    start += s.text.length;
    return seg;
  });
  await h.store.setPlan({ ...stored, segments: planSegments });
  const job = (await h.store.getJob(h.jobId))!;
  await h.store.setJob({ ...job, spots: planSpots("\0" + existing + "\n", segments) });
  return h;
}

const para = (...pieces: (string | { add: string })[]): EditorNode => ({
  type: "paragraph",
  content: pieces.map((x) => (typeof x === "string" ? { type: "text", text: x } : { type: "text", text: x.add, marks: [{ type: PENDING_MARK }] })),
});

test("additions in several places are typed at each spot, top to bottom, typos and all", async () => {
  const base: EditorNode = { type: "doc", content: [para("Logistics:"), para("What is your phone number?"), para("Where will you be?"), para("Why join?"), para("")] };
  const target: EditorNode = {
    type: "doc",
    content: [
      para({ add: "Application" }),
      para("Logistics:"),
      para("What is your phone number?"),
      para({ add: "845-555-0100" }),
      para("Where will you be", { add: " this fall" }, "?"),
      para({ add: "In New York City, near campus." }),
      para("Why join?"),
      para({ add: "Because I love building things with other people." }),
      para({ add: "And learning from them." }),
      para(""),
    ],
  };
  for (const seed of [1, 2, 3]) {
    const h = await additionsHarness(base, target, seed);
    await runJobWindow(h.jobId, 0, h.deps);
    await drain(h);
    assert.equal(h.doc.text, plainOf(target), `seed ${seed}`);
    assert.equal((await h.store.getJob(h.jobId))!.status, "done");
  }
});

test("additions keep their places when the document is edited above them mid-sync", async () => {
  const base: EditorNode = { type: "doc", content: [para("Question one?"), para("Question two?")] };
  const target: EditorNode = { type: "doc", content: [para("Question one?"), para({ add: "Answer one." }), para("Question two?"), para({ add: "Answer two." })] };
  const h = await additionsHarness(base, target, 4);
  let n = 0;
  h.doc.onBatch = () => { if (n++ % 2 === 0) h.doc.text = "Hi. " + h.doc.text; };
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  assert.equal(h.doc.text.replace(/^(Hi\. )+/, ""), plainOf(target));
});
