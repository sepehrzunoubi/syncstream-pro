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

  async snapshot(token: string) {
    this.tokensSeen.add(token);
    this.calls.snapshot++;
    const trimmed = this.text.trim();
    return {
      endIndex: this.text.length + 2,
      tail: this.text.slice(-400),
      wordCount: trimmed ? trimmed.split(/\s+/).length : 0,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async insert(token: string, _doc: string, text: string, index: number, _extra?: object[]) {
    if (token === "expired") { const e = new Error("unauthorized") as Error & { code: number }; e.code = 401; throw e; }
    this.calls.insert++;
    if (this.failNextInsertBeforeWrite) { this.failNextInsertBeforeWrite = false; throw new Error("network down"); }
    assert.equal(index, this.text.length + 1, "runner must append at the end");
    this.text += text;
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

async function makeHarness(text: string, opts: { seed?: number; actions?: DripAction[]; startInMs?: number; windowMs?: number } = {}): Promise<Harness> {
  const clock = new FakeClock();
  const store = createMemoryStore(clock.now);
  const doc = new FakeDoc();
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
  h.doc.insert = async () => { throw new Error("quota exceeded"); };
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
  const origInsert = h.doc.insert.bind(h.doc);
  h.doc.insert = async (...args) => { await origInsert(...args); seen.push(h.doc.text); };
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

test("formatted plans send styling in the same call as each insert, at the right indices", async () => {
  const { richFromEditorJSON } = await import("./rich-text");
  const { text, format } = richFromEditorJSON({
    type: "doc",
    content: [
      { type: "paragraph", attrs: { styleName: "h1" }, content: [{ type: "text", text: "Big" }] },
      { type: "paragraph", attrs: { firstLine: true }, content: [{ type: "text", text: "said ", marks: [{ type: "italic" }] }, { type: "text", text: "hi" }] },
    ],
  });
  assert.equal(text, "Big\nsaid hi");
  const actions: DripAction[] = [
    { kind: "insert", text: "Big\n", delayMs: 0, activity: "Typing…" },
    { kind: "typo", text: "said ", typoChars: "siad", delayMs: 500, holdMs: 500, activity: "Correcting a typo…" },
    { kind: "insert", text: "hi", delayMs: 500, activity: "Typing…" },
  ];
  const h = await makeHarness(text, { actions });
  const plan = (await h.store.getPlan(h.jobId))!;
  await h.store.setPlan({ ...plan, format });
  const calls: { text: string; index: number; extra: Record<string, { range: { startIndex: number; endIndex: number }; textStyle?: Record<string, unknown>; paragraphStyle?: Record<string, unknown> }>[] }[] = [];
  const orig = h.doc.insert.bind(h.doc);
  h.doc.insert = async (tok, d, tx, index, extra) => {
    calls.push({ text: tx, index, extra: (extra ?? []) as typeof calls[number]["extra"] });
    return orig(tok, d, tx, index);
  };
  await runJobWindow(h.jobId, 0, h.deps);
  await drain(h);
  assert.equal(h.doc.text, text);
  assert.deepEqual(calls.map((c) => c.text), ["Big\n", "siad", "said ", "hi"]);

  // "Big\n" at index 1: H1 paragraph + 20pt text
  const [c0, c1, c2, c3] = calls;
  assert.equal(c0.index, 1);
  assert.equal(c0.extra[0].updateParagraphStyle.paragraphStyle!.namedStyleType, "HEADING_1");
  assert.deepEqual(c0.extra[1].updateTextStyle.range, { startIndex: 1, endIndex: 5 });
  assert.deepEqual((c0.extra[1].updateTextStyle.textStyle!.fontSize as { magnitude: number }).magnitude, 20);
  // Typo at the start of paragraph 2: paragraph style (first-line indent) + italic text style
  assert.equal(c1.index, 5);
  assert.equal((c1.extra[0].updateParagraphStyle.paragraphStyle!.indentFirstLine as { magnitude: number }).magnitude, 36);
  assert.equal(c1.extra[1].updateTextStyle.textStyle!.italic, true);
  assert.deepEqual(c1.extra[1].updateTextStyle.range, { startIndex: 5, endIndex: 9 });
  // Correct text after deleting the typo lands at the same place
  assert.equal(c2.index, 5);
  assert.equal(c2.extra[1].updateTextStyle.textStyle!.italic, true);
  // "hi" continues the paragraph: no paragraph restyle, plain text
  assert.equal(c3.index, 10);
  assert.equal(c3.extra.length, 1);
  assert.equal(c3.extra[0].updateTextStyle.textStyle!.italic, false);
});
