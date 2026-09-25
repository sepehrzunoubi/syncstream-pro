/**
 * Queue-driven job runner.
 *
 * Every invocation does a short, bounded amount of work (WINDOW_MS) and then
 * hands the job back to the queue with the exact delay until the next action.
 * Long waits therefore live in QStash, not inside a serverless function, so
 * the function never runs into a platform or queue timeout and the job keeps
 * going with no browser tab open.
 *
 * Safety properties:
 *  - A Redis lock makes concurrent deliveries of the same job harmless.
 *  - An in-flight marker plus a check of the document's tail makes every
 *    Docs write idempotent, so a retry after a crash never types text twice.
 *  - Transient failures are retried with backoff before the job is failed.
 *  - Pause, resume and cancel are honoured between actions and during waits.
 */

import type { DripAction } from "./drip-engine";
import type { DocSnapshot } from "./google";
import { FormatIndex } from "./rich-text";
import { isTerminal, type PublicJob, type SyncJob, type SyncPlan, type SyncStore, toPublicJob } from "./sync-store";

export interface DocsApi {
  snapshot(accessToken: string, documentId: string): Promise<DocSnapshot>;
  insert(accessToken: string, documentId: string, text: string, index: number, extraRequests?: object[]): Promise<unknown>;
  deleteRange(accessToken: string, documentId: string, startIndex: number, endIndex: number): Promise<unknown>;
}

export interface RunnerDeps {
  store: SyncStore;
  docs: DocsApi;
  refresh(refreshToken: string): Promise<{ access_token: string } | null>;
  enqueue(jobId: string, generation: number, delaySec: number): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long one invocation may work before handing off. Default 20s. */
  windowMs?: number;
  /** Lock TTL; also the re-kick delay when a delivery finds the job busy. Default 60s. */
  lockTtlSec?: number;
  log?: (message: string) => void;
}

export type RunOutcome =
  | "busy"
  | "not_found"
  | "stale"
  | "waiting"
  | "chained"
  | "paused"
  | "cancelled"
  | "done"
  | "already_finished"
  | "retry"
  | "error";

export interface RunResult {
  outcome: RunOutcome;
  job?: PublicJob;
}

const MAX_FAILURES = 3;
const PAUSE_CHECK_MS = 3_000;
/** How soon a delivery that found the job busy asks for another go */
const BUSY_RETRY_SEC = 25;
const CONTEXT_CHARS = 60;

class Interrupted extends Error {
  constructor(public readonly outcome: RunOutcome, public readonly job: SyncJob) {
    super(`interrupted: ${outcome}`);
  }
}

export async function runJobWindow(
  jobId: string,
  generation: number | undefined,
  deps: RunnerDeps
): Promise<RunResult> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const windowMs = deps.windowMs ?? 20_000;
  const lockTtlSec = deps.lockTtlSec ?? 60;
  const log = deps.log ?? (() => {});

  if (!(await store.acquireLock(jobId, lockTtlSec))) {
    // Someone else is working on this job. If that worker died, the lock
    // expires; make sure exactly one re-kick is waiting for that moment.
    if (await store.tryScheduleKick(jobId, BUSY_RETRY_SEC)) {
      const j = await store.getJob(jobId);
      if (j && !isTerminal(j.status)) await deps.enqueue(jobId, j.generation, BUSY_RETRY_SEC);
    }
    return { outcome: "busy" };
  }

  let job: SyncJob | null = null;
  let handedOff = false;
  try {
    job = await store.getJob(jobId);
    const plan = job ? await store.getPlan(jobId) : null;
    if (!job || !plan) {
      await store.removeActiveJob(jobId);
      return { outcome: "not_found" };
    }

    if (generation != null && generation !== job.generation) return { outcome: "stale", job: toPublicJob(job) };
    const pending = await store.getControl(jobId);
    if (pending && !isTerminal(job.status)) {
      const applied = await applyControl(store, job, pending, now);
      return { outcome: applied.status === "paused" ? "paused" : "cancelled", job: toPublicJob(applied) };
    }
    if (isTerminal(job.status)) {
      await store.removeActiveJob(jobId);
      return { outcome: "already_finished", job: toPublicJob(job) };
    }
    if (job.status === "paused") return { outcome: "paused", job: toPublicJob(job) };

    if (job.status === "scheduled") {
      const untilStart = job.startAt - now();
      if (untilStart > 1_000) {
        await deps.enqueue(jobId, job.generation, Math.ceil(untilStart / 1000));
        return { outcome: "waiting", job: toPublicJob(job) };
      }
    }
    if (job.status === "scheduled" || job.status === "pending") {
      job.status = "running";
      job.startedAt = now();
      job.activity = "Starting";
    }

    const ctx = new Context(job, plan, deps, now, sleep, log);
    const windowStart = now();
    const handOff = async (delaySec: number) => {
      handedOff = true;
      await store.releaseLock(jobId);
      await deps.enqueue(jobId, ctx.job.generation, delaySec);
    };

    while (ctx.job.currentAction < plan.actions.length) {
      const action = plan.actions[ctx.job.currentAction];

      if (ctx.job.nextActionAt == null) {
        const delay = ctx.job.typoSubStep === 1 ? action.holdMs ?? 1_000 : action.delayMs;
        ctx.job.nextActionAt = now() + delay;
        ctx.job.activity = ctx.job.typoSubStep === 1 ? "Fixing a typo" : action.activity;
        ctx.refreshEstimates();
      }

      const wait = ctx.job.nextActionAt - now();
      const windowLeft = windowMs - (now() - windowStart);
      if (wait > windowLeft) {
        await ctx.persist();
        await handOff(Math.ceil(wait / 1000));
        return { outcome: "waiting", job: toPublicJob(ctx.job) };
      }
      if (wait > 0) await ctx.waitUntil(ctx.job.nextActionAt);

      await ctx.execute(action);

      ctx.job.currentAction++;
      ctx.job.nextActionAt = undefined;
      ctx.job.typoSubStep = 0;
      ctx.job.typoCharsInDoc = 0;
      ctx.job.failures = 0;
      ctx.job.activity = "Typing";
      ctx.refreshEstimates();
      await ctx.persist();

      if (now() - windowStart > windowMs && ctx.job.currentAction < plan.actions.length) {
        await handOff(0);
        return { outcome: "chained", job: toPublicJob(ctx.job) };
      }
    }

    ctx.job.status = "done";
    ctx.job.finishedAt = now();
    ctx.job.activity = "Done";
    ctx.job.etaTargetAt = now();
    ctx.job.nextBreakAction = undefined;
    ctx.job.nextBreakAt = undefined;
    await ctx.persist();
    await store.removeActiveJob(jobId);
    return { outcome: "done", job: toPublicJob(ctx.job) };
  } catch (err) {
    if (err instanceof Interrupted) {
      return { outcome: err.outcome, job: toPublicJob(err.job) };
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`job ${jobId} failed at action ${job?.currentAction}: ${message}`);
    const latest = await store.getJob(jobId);
    if (!latest) return { outcome: "not_found" };
    if (latest.status === "paused" || latest.status === "cancelled" || isTerminal(latest.status)) {
      return { outcome: latest.status === "paused" ? "paused" : latest.status === "cancelled" ? "cancelled" : "already_finished", job: toPublicJob(latest) };
    }
    // Keep our cursor (job) but honour the latest generation.
    const merged: SyncJob = { ...latest, ...(job ?? {}), generation: latest.generation, status: latest.status };
    merged.failures = (merged.failures ?? 0) + 1;
    merged.lastUpdate = now();
    if (merged.failures <= MAX_FAILURES) {
      const delaySec = 15 * merged.failures;
      merged.activity = `Retrying after a Google Docs error (attempt ${merged.failures} of ${MAX_FAILURES})`;
      merged.nextActionAt = undefined;
      await store.setJob(merged);
      handedOff = true;
      await store.releaseLock(jobId);
      await deps.enqueue(jobId, merged.generation, delaySec);
      return { outcome: "retry", job: toPublicJob(merged) };
    }
    merged.status = "error";
    merged.error = message;
    merged.activity = "Error";
    merged.finishedAt = now();
    await store.setJob(merged);
    await store.removeActiveJob(jobId);
    return { outcome: "error", job: toPublicJob(merged) };
  } finally {
    if (!handedOff) await store.releaseLock(jobId);
  }
}

/** Per-invocation working state around a job. */
class Context {
  private formatIndex: FormatIndex | null | undefined;

  constructor(
    public job: SyncJob,
    private readonly plan: SyncPlan,
    private readonly deps: RunnerDeps,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly log: (m: string) => void
  ) {}

  /**
   * Stop if someone paused, cancelled or resumed the job underneath us.
   * While we hold the lock the control routes leave an intent instead of
   * writing the job, so we apply it here with our up-to-date cursor.
   */
  private async checkInterrupt(): Promise<void> {
    const store = this.deps.store;
    const latest = await store.getJob(this.job.id);
    if (!latest) throw new Interrupted("not_found", this.job);
    if (latest.generation !== this.job.generation) throw new Interrupted("stale", latest);
    if (latest.status === "paused") throw new Interrupted("paused", latest);
    if (latest.status === "cancelled") throw new Interrupted("cancelled", latest);
    const control = await store.getControl(this.job.id);
    if (control) {
      const applied = await applyControl(store, this.job, control, this.now);
      throw new Interrupted(applied.status === "paused" ? "paused" : "cancelled", applied);
    }
  }

  /** Write the job, unless pause/cancel/resume happened underneath us. */
  async persist(): Promise<void> {
    await this.checkInterrupt();
    this.job.lastUpdate = this.now();
    await this.deps.store.setJob(this.job);
  }

  async waitUntil(target: number): Promise<void> {
    let left = target - this.now();
    while (left > 0) {
      await this.sleep(Math.min(PAUSE_CHECK_MS, left));
      await this.checkInterrupt();
      left = target - this.now();
    }
  }

  async execute(action: DripAction): Promise<void> {
    if (action.kind === "pause") {
      if (action.breakIndex != null && !this.job.completedBreaks.includes(action.breakIndex)) {
        this.job.completedBreaks = [...this.job.completedBreaks, action.breakIndex];
      }
      return;
    }
    if (action.kind === "insert") {
      await this.write(action.text, 0, true);
      return;
    }
    // typo: wrong chars → hold → delete → correct text
    const wrong = action.typoChars ?? "";
    if (this.job.typoSubStep === 0) {
      await this.write(wrong, 0, false);
      this.job.typoSubStep = 1;
      this.job.typoCharsInDoc = wrong.length;
      this.job.nextActionAt = this.now() + (action.holdMs ?? 1_000);
      this.job.activity = "Fixing a typo";
      this.refreshEstimates();
      await this.persist();
      await this.waitUntil(this.job.nextActionAt);
    }
    if (this.job.typoSubStep === 1) {
      await this.erase(wrong);
      this.job.typoSubStep = 2;
      this.job.typoCharsInDoc = 0;
      this.job.activity = "Fixing a typo";
      await this.persist();
    }
    if (this.job.typoSubStep === 2) {
      await this.write(action.text, 2, true);
    }
  }

  /** Text this job has already committed to the doc, for tail checks. */
  private sentContext(): string {
    let s = "";
    for (let i = this.job.currentAction - 1; i >= 0 && s.length < CONTEXT_CHARS; i--) {
      const a = this.plan.actions[i];
      if (a.kind !== "pause") s = a.text + s;
    }
    return s.slice(-CONTEXT_CHARS);
  }

  /** Formatting lookups for this plan, or null for plans without formatting. */
  private formats(): FormatIndex | null {
    if (this.formatIndex !== undefined) return this.formatIndex;
    const format = this.plan.format;
    if (!format) return (this.formatIndex = null);
    let source = "";
    for (const a of this.plan.actions) if (a.kind !== "pause") source += a.text;
    return (this.formatIndex = new FormatIndex(source, format));
  }

  /**
   * Append `text` to the document. `isSource` is true when the text is the
   * next slice of the source (it is styled range by range); a typo's wrong
   * characters take the style of the source character they stand in for.
   */
  private async write(text: string, step: number, isSource: boolean): Promise<void> {
    if (text.length === 0) return;
    const snap = await this.withToken((t) => this.deps.docs.snapshot(t, this.job.documentId));
    const marker = this.job.inFlight;
    const alreadyLanded =
      marker != null &&
      marker.action === this.job.currentAction &&
      marker.step === step &&
      marker.text === text &&
      snap.tail.endsWith(this.sentContext() + text);
    if (alreadyLanded) {
      this.log(`job ${this.job.id}: write for action ${this.job.currentAction} already landed, skipping`);
      this.job.liveWordCount = snap.wordCount;
    } else {
      this.job.inFlight = { action: this.job.currentAction, step, text };
      await this.persist();
      const index = snap.endIndex - 1;
      const fx = this.formats();
      const offset = this.job.charsSent;
      const styles = fx
        ? isSource
          ? fx.styleRequests(offset, offset + text.length, index)
          : fx.uniformStyleRequests(offset, text.length, index)
        : [];
      await this.withToken((t) => this.deps.docs.insert(t, this.job.documentId, text, index, styles));
      this.job.liveWordCount = snap.wordCount + countWords(text, snap.tail);
    }
    this.job.inFlight = undefined;
    if (isSource) this.job.charsSent += text.length;
  }

  private async erase(wrong: string): Promise<void> {
    if (wrong.length === 0) return;
    const snap = await this.withToken((t) => this.deps.docs.snapshot(t, this.job.documentId));
    if (!snap.tail.endsWith(wrong)) return; // already deleted by an earlier attempt
    const end = snap.endIndex - 1;
    const start = Math.max(1, end - wrong.length);
    if (start < end) {
      await this.withToken((t) => this.deps.docs.deleteRange(t, this.job.documentId, start, end));
    }
  }

  private async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(this.job.accessToken);
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code ?? (err as { status?: number })?.status;
      if ((code === 401 || code === 403) && this.job.refreshToken) {
        const refreshed = await this.deps.refresh(this.job.refreshToken);
        if (refreshed) {
          this.job.accessToken = refreshed.access_token;
          return await fn(this.job.accessToken);
        }
      }
      throw err;
    }
  }

  refreshEstimates(): void {
    const { actions } = this.plan;
    const job = this.job;
    const idx = job.currentAction;
    const anchor = job.nextActionAt ?? this.now();
    // Time still ahead for the current action after its wait ends
    const current = actions[idx];
    const aheadForCurrent = current && current.kind === "typo" && job.typoSubStep === 0 ? current.holdMs ?? 0 : 0;
    let after = 0;
    for (let i = idx + 1; i < actions.length; i++) after += actions[i].delayMs + (actions[i].holdMs ?? 0);
    job.etaTargetAt = anchor + aheadForCurrent + after;

    // Next break: the current action if it is a break, else the next pause action
    let nextBreak: number | undefined;
    let until = 0;
    if (current?.kind === "pause") {
      nextBreak = idx;
      until = 0;
    } else {
      until = aheadForCurrent;
      for (let i = idx + 1; i < actions.length; i++) {
        if (actions[i].kind === "pause") { nextBreak = i; break; }
        until += actions[i].delayMs + (actions[i].holdMs ?? 0);
      }
    }
    job.nextBreakAction = nextBreak;
    job.nextBreakAt = nextBreak != null ? (current?.kind === "pause" ? anchor - current.delayMs : anchor + until) : undefined;

    const elapsedMin = job.startedAt ? Math.max(0.05, (this.now() - job.startedAt) / 60_000) : 0.05;
    job.wpm = job.charsSent > 0 ? Math.round(job.charsSent / 5 / elapsedMin) : 0;
  }
}

/** Apply a pause/cancel request to a job we are allowed to write, and clear it. */
export async function applyControl(
  store: SyncStore,
  job: SyncJob,
  command: "pause" | "cancel",
  now: () => number
): Promise<SyncJob> {
  const t = now();
  const next: SyncJob =
    command === "pause"
      ? { ...job, status: "paused", activity: "Paused", pausedAt: t, lastUpdate: t, nextActionAt: undefined }
      : { ...job, status: "cancelled", activity: "Cancelled", finishedAt: t, lastUpdate: t, nextActionAt: undefined };
  await store.setJob(next);
  await store.clearControl(job.id);
  if (command === "cancel") await store.removeActiveJob(job.id);
  return next;
}

/** Words added by appending `text` to a document whose tail is `tail`. */
function countWords(text: string, tail: string): number {
  const joined = tail.slice(-1) + text;
  const words = joined.trim() ? joined.trim().split(/\s+/).length : 0;
  const tailWord = tail.slice(-1).trim() ? 1 : 0;
  return Math.max(0, words - tailWord);
}
