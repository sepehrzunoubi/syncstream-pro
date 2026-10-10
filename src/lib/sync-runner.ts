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
import { FormatIndex, OBJ, SegmentFormat, type DocListState, type DocsRequest, type ImageRef } from "./rich-text";
import { isTerminal, type JobAnchor, type PublicJob, type SyncJob, type SyncPlan, type SyncStore, toPublicJob } from "./sync-store";
import { errorFields, log, startTimer, uidTag, type Fields } from "./log";
import { reportError } from "./monitor";

export interface DocsApi {
  snapshot(accessToken: string, documentId: string): Promise<DocSnapshot>;
  /** One atomic batchUpdate; refused by Google when the document moved past `requiredRevisionId` */
  batch(accessToken: string, documentId: string, requests: object[], requiredRevisionId?: string): Promise<unknown>;
  deleteRange(accessToken: string, documentId: string, startIndex: number, endIndex: number, requiredRevisionId?: string): Promise<unknown>;
}

/** HTTP status of a Google API error */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const code = typeof e?.code === "number" ? e.code : undefined;
  return code ?? e?.status ?? e?.response?.status;
}

/** Google refused a batch because the document changed since it was read */
const isStaleRevision = (err: unknown) => errorStatus(err) === 400 && /revision/i.test(err instanceof Error ? err.message : String(err));

export interface RunnerDeps {
  store: SyncStore;
  docs: DocsApi;
  refresh(refreshToken: string): Promise<{ access_token: string } | null>;
  enqueue(jobId: string, generation: number, delaySec: number, tick?: number): Promise<void>;
  /** The hand-off this delivery was made for; an older one than the job's is a duplicate */
  tick?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long one invocation may work before handing off. Default 20s. */
  windowMs?: number;
  /** Lock TTL; also the re-kick delay when a delivery finds the job busy. Default 60s. */
  lockTtlSec?: number;
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
/** 429s tolerated before the job gives up */
const MAX_QUOTA_WAITS = 10;
/** How far behind schedule a job may be before it simply runs late */
const MAX_CATCHUP_MS = 30_000;
/** Immediate re-reads after Google refused a batch for a stale revision */
const STALE_RETRIES = 4;
const PAUSE_CHECK_MS = 3_000;
/** How soon a delivery that found the job busy asks for another go */
const BUSY_RETRY_SEC = 25;
const CONTEXT_CHARS = 60;
const LOST_PLACE = "Couldn't find where this sync was typing. The text around it may have been changed or deleted in the document.";

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
  /** Fields every line about this job carries */
  let tag: Fields = { job: jobId };

  const lock = await store.acquireLock(jobId, lockTtlSec);
  if (!lock) {
    // Someone else is working on this job. If that worker died, the lock
    // expires; make sure exactly one re-kick is waiting for that moment.
    const rekick = await store.tryScheduleKick(jobId, BUSY_RETRY_SEC);
    log.info("sync.busy", { ...tag, rekick });
    if (rekick) {
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
    if (job) tag = { job: jobId, uid: uidTag(job.userId) };
    if (!job || !plan) {
      if (job && !isTerminal(job.status)) {
        log.warn("sync.expired", { ...tag, action: job.currentAction });
        // The plan expired before the job finished: say so instead of leaving it "running"
        const expired: SyncJob = { ...job, status: "error", error: "This sync expired before it could finish.", activity: "Error", finishedAt: now(), lastUpdate: now(), accessToken: "", refreshToken: "" };
        await store.setJob(expired);
      }
      await store.removeActiveJob(jobId);
      return { outcome: "not_found" };
    }

    if (generation != null && generation !== job.generation) {
      log.debug("sync.stale_delivery", { ...tag, generation, current: job.generation });
      return { outcome: "stale", job: toPublicJob(job) };
    }
    if (deps.tick != null && job.tick != null && deps.tick < job.tick) {
      log.debug("sync.stale_delivery", { ...tag, tick: deps.tick, current: job.tick });
      return { outcome: "stale", job: toPublicJob(job) };
    }
    const pending = await store.getControl(jobId);
    if (pending && !isTerminal(job.status)) {
      log.info("sync.control", { ...tag, command: pending, action: job.currentAction });
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
        log.info("sync.waiting", { ...tag, untilStartSec: Math.ceil(untilStart / 1000) });
        await deps.enqueue(jobId, job.generation, Math.ceil(untilStart / 1000));
        return { outcome: "waiting", job: toPublicJob(job) };
      }
    }
    if (job.status === "scheduled" || job.status === "pending") {
      log.info("sync.started", { ...tag, scheduled: job.status === "scheduled", totalActions: job.totalActions, totalChars: job.totalChars, lateSec: Math.max(0, Math.round((now() - job.startAt) / 1000)) });
      job.status = "running";
      job.startedAt = now();
      job.activity = "Starting";
    }
    job.startedAt ??= now();

    const ctx = new Context(job, plan, deps, now, sleep, lock);
    const windowStart = now();
    const handOff = async (delaySec: number) => {
      // A pause or cancel asked for since the last check is applied now, not a delivery later
      const control = await store.getControl(jobId);
      if (control && ctx.job.currentAction < plan.actions.length) {
        log.info("sync.control", { ...tag, command: control, action: ctx.job.currentAction });
        const applied = await applyControl(store, ctx.job, control, now);
        throw new Interrupted(applied.status === "paused" ? "paused" : "cancelled", applied);
      }
      handedOff = true;
      ctx.job.tick = (ctx.job.tick ?? 0) + 1;
      await store.setJob(ctx.job);
      await store.releaseLock(jobId, lock);
      log.info("sync.handoff", { ...tag, action: ctx.job.currentAction, totalActions: plan.actions.length, delaySec, tick: ctx.job.tick, windowMs: now() - windowStart, charsSent: ctx.job.charsSent });
      await deps.enqueue(jobId, ctx.job.generation, delaySec, ctx.job.tick);
    };

    while (ctx.job.currentAction < plan.actions.length) {
      const action = plan.actions[ctx.job.currentAction];
      if (!(await store.extendLock(jobId, lockTtlSec, lock))) {
        log.warn("sync.lock_lost", { ...tag, action: ctx.job.currentAction });
        throw new Interrupted("busy", ctx.job);
      }

      if (ctx.job.nextActionAt == null) {
        const delay = ctx.job.typoSubStep === 1 ? action.holdMs ?? 1_000 : action.delayMs;
        // Anchored on when the last action was due, so Google round trips and late deliveries
        // do not stretch the plan; a backlog is caught up by at most a little
        const due = ctx.job.lastDueAt != null ? ctx.job.lastDueAt + delay : now() + delay;
        ctx.job.nextActionAt = Math.max(due, now() - MAX_CATCHUP_MS);
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

      ctx.job.lastDueAt = ctx.job.nextActionAt;
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
    // A finished job keeps no credentials
    ctx.job.accessToken = "";
    ctx.job.refreshToken = "";
    await ctx.persist();
    await store.removeActiveJob(jobId);
    log.info("sync.done", { ...tag, chars: ctx.job.charsSent, actions: plan.actions.length, elapsedMs: ctx.job.startedAt ? now() - ctx.job.startedAt : undefined, wpm: ctx.job.wpm });
    return { outcome: "done", job: toPublicJob(ctx.job) };
  } catch (err) {
    if (err instanceof Interrupted) {
      log.info("sync.interrupted", { ...tag, outcome: err.outcome, action: err.job.currentAction });
      return { outcome: err.outcome, job: toPublicJob(err.job) };
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = errorStatus(err);
    const kind = status === 401 || status === 403 ? "auth" : status === 404 ? "not_found" : status === 429 ? "quota" : status === 400 ? "rejected" : "transient";
    log.error("sync.failed", { ...tag, action: job?.currentAction, status, kind, err: errorFields(err, kind === "transient") });
    const latest = await store.getJob(jobId);
    if (!latest) return { outcome: "not_found" };
    if (latest.status === "paused" || latest.status === "cancelled" || isTerminal(latest.status)) {
      return { outcome: latest.status === "paused" ? "paused" : latest.status === "cancelled" ? "cancelled" : "already_finished", job: toPublicJob(latest) };
    }
    // Keep our cursor (job) but honour the latest generation.
    const merged: SyncJob = { ...latest, ...(job ?? {}), generation: latest.generation, status: latest.status };
    merged.lastUpdate = now();
    merged.nextActionAt = undefined;
    if (status === 401 || status === 403) {
      // Access is gone: park the job so that signing in again and resuming continues it
      merged.status = "paused";
      merged.pausedAt = now();
      merged.error = "SyncStream lost access to your Google account. Sign in again, then resume this sync.";
      merged.activity = "Paused: sign in again";
      await store.setJob(merged);
      log.warn("sync.paused_auth", { ...tag, action: merged.currentAction, status });
      return { outcome: "paused", job: toPublicJob(merged) };
    }
    if (status === 404) {
      merged.status = "error";
      merged.error = "The document was deleted or is no longer shared with you.";
      merged.activity = "Error";
      merged.finishedAt = now();
      merged.accessToken = "";
      merged.refreshToken = "";
      await store.setJob(merged);
      await store.removeActiveJob(jobId);
      log.warn("sync.error", { ...tag, action: merged.currentAction, status, kind });
      return { outcome: "error", job: toPublicJob(merged) };
    }
    if (status === 429) {
      // Quota: wait longer each time, without using up the failure budget
      merged.quotaWaits = (merged.quotaWaits ?? 0) + 1;
      if (merged.quotaWaits <= MAX_QUOTA_WAITS) {
        const delaySec = 60 * Math.min(merged.quotaWaits, 5);
        merged.activity = "Waiting for Google Docs quota";
        log.warn("sync.quota_wait", { ...tag, action: merged.currentAction, waits: merged.quotaWaits, maxWaits: MAX_QUOTA_WAITS, delaySec });
        await store.setJob(merged);
        handedOff = true;
        await store.releaseLock(jobId, lock);
        await deps.enqueue(jobId, merged.generation, delaySec);
        return { outcome: "retry", job: toPublicJob(merged) };
      }
    }
    merged.failures = (merged.failures ?? 0) + 1;
    if (merged.failures <= MAX_FAILURES) {
      const delaySec = 15 * merged.failures;
      merged.activity = `Retrying after a Google Docs error (attempt ${merged.failures} of ${MAX_FAILURES})`;
      merged.nextActionAt = undefined;
      log.warn("sync.retry", { ...tag, action: merged.currentAction, failures: merged.failures, maxFailures: MAX_FAILURES, delaySec, status, kind });
      await store.setJob(merged);
      handedOff = true;
      await store.releaseLock(jobId, lock);
      await deps.enqueue(jobId, merged.generation, delaySec);
      return { outcome: "retry", job: toPublicJob(merged) };
    }
    merged.status = "error";
    merged.error = status === 429 ? "Google Docs kept refusing because of its usage quota. Resume the sync later." : status === 400 ? "Google Docs rejected an edit. Resume to try again from where it stopped." : message;
    merged.activity = "Error";
    merged.finishedAt = now();
    merged.accessToken = "";
    merged.refreshToken = "";
    await store.setJob(merged);
    await store.removeActiveJob(jobId);
    // A job that gave up is something the operator should hear about
    await reportError(err, { event: "sync.error", route: "/api/sync/process", ...tag, action: merged.currentAction, status, kind, failures: merged.failures, quotaWaits: merged.quotaWaits });
    return { outcome: "error", job: toPublicJob(merged) };
  } finally {
    if (!handedOff) {
      try {
        await store.releaseLock(jobId, lock);
      } catch (err) {
        // The lock expires on its own; a failed release only delays the next delivery
        log.warn("sync.lock_release_failed", { ...tag, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

/** Formatting lookups used while typing */
interface Formats {
  writeRequests(start: number, end: number, docIndex: number, list: DocListState): { requests: DocsRequest[]; docList: DocListState };
  uniformStyleRequests(offset: number, length: number, docIndex: number): DocsRequest[];
  imageAt(at: number): ImageRef | undefined;
}

/** A typing position inside the document, and what goes with it */
interface Place {
  state: { ctx: string; cursor: number; opened: boolean };
  /** Source text already typed at this place */
  typed: string;
  /** Index for the newline that opens the paragraph to type into, or null when nothing needs opening */
  openAt: ((at: number) => number) | null;
  fx: Formats | null;
  /** Offset of the next character in fx's terms */
  offset: number;
  list: DocListState;
  setList(list: DocListState): void;
  /**
   * Re-apply the character styles of what this place already typed, once.
   * Syncs started before paragraph styles were sent only on change could
   * have had their earlier text reset to the paragraph's default font.
   */
  repair: ((index: number) => DocsRequest[]) | null;
  /** Called once the repair's requests have landed */
  repaired(): void;
}

/** Per-invocation working state around a job. */
class Context {
  private formatIndex: FormatIndex | null | undefined;
  private sourceText: string | undefined;
  private segmentFormats = new Map<number, SegmentFormat>();
  /** Fields every line about this job carries */
  private readonly tag: Fields;

  constructor(
    public job: SyncJob,
    private readonly plan: SyncPlan,
    private readonly deps: RunnerDeps,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly lock: string
  ) {
    this.tag = { job: job.id, uid: uidTag(job.userId) };
  }

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
      if (this.job.currentAction >= this.plan.actions.length) {
        // Everything is typed: a pause or cancel now would only mislabel a finished sync
        await store.clearControl(this.job.id);
        return;
      }
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
      if (!(await this.deps.store.extendLock(this.job.id, this.deps.lockTtlSec ?? 60, this.lock))) {
        log.warn("sync.lock_lost", { ...this.tag, action: this.job.currentAction, during: "wait" });
        throw new Interrupted("busy", this.job);
      }
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

  private source(): string {
    if (this.sourceText !== undefined) return this.sourceText;
    let source = "";
    for (const a of this.plan.actions) if (a.kind !== "pause") source += a.text;
    return (this.sourceText = source);
  }

  /** Where the next character goes, for jobs typing inside the document (null: append at the end) */
  private place(): Place | null {
    const segments = this.plan.segments;
    const spots = this.job.spots;
    const offset = this.job.charsSent;
    if (segments?.length && spots?.length === segments.length) {
      let j = segments.findIndex((s) => offset >= s.start && offset < s.end);
      if (j < 0) j = segments.length - 1;
      const seg = segments[j];
      const spot = spots[j];
      let fx = this.segmentFormats.get(j);
      if (!fx) {
        fx = new SegmentFormat(this.source().slice(seg.start, seg.end), seg.format);
        this.segmentFormats.set(j, fx);
      }
      return {
        state: spot,
        typed: this.source().slice(seg.start, offset),
        openAt: seg.mode === "before" ? (at) => at : null,
        fx,
        offset: offset - seg.start,
        list: spot.docList ?? null,
        setList: (list) => { spot.docList = list; },
        repair: spot.restyled
          ? null
          : (index) => {
              const typed = offset - seg.start;
              return typed > 0 ? fx!.textRequests(0, typed, index - typed) : [];
            },
        repaired: () => { spot.restyled = true; },
      };
    }
    const anchor: JobAnchor | undefined = this.job.anchor;
    if (anchor) {
      return {
        state: anchor,
        typed: this.sentContext(),
        openAt: (at) => (anchor.mode === "after" ? at - 1 : at),
        fx: this.formats(),
        offset,
        list: this.job.docList ?? null,
        setList: (list) => { this.job.docList = list; },
        repair: null,
        repaired: () => {},
      };
    }
    return null;
  }

  /** Formatting lookups for this plan, or null for plans without formatting. */
  private formats(): FormatIndex | null {
    if (this.formatIndex !== undefined) return this.formatIndex;
    const format = this.plan.format;
    if (!format) return (this.formatIndex = null);
    return (this.formatIndex = new FormatIndex(this.source(), format));
  }

  /**
   * Type `text` at the job's position: the end of the document, or its
   * anchor inside it. `isSource` is true when the text is the
   * next slice of the source (it is styled range by range); a typo's wrong
   * characters take the style of the source character they stand in for.
   */
  private async write(text: string, step: number, isSource: boolean): Promise<void> {
    if (text.length === 0) return;
    // Indices come from one read of the document; the batch is only applied to that revision.
    // When a collaborator's edit lands in between, Google refuses it and the place is found again.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.writeOnce(text, step, isSource);
        return;
      } catch (err) {
        if (!isStaleRevision(err) || attempt >= STALE_RETRIES) throw err;
        log.warn("sync.stale_revision", { ...this.tag, action: this.job.currentAction, step, attempt: attempt + 1, maxAttempts: STALE_RETRIES });
      }
    }
  }

  private async writeOnce(text: string, step: number, isSource: boolean): Promise<void> {
    const snapTimer = startTimer(this.now);
    const snap = await this.withToken((t) => this.deps.docs.snapshot(t, this.job.documentId));
    const snapshotMs = snapTimer();
    const marker = this.job.inFlight;
    const markerMatches =
      marker != null &&
      marker.action === this.job.currentAction &&
      marker.step === step &&
      marker.text === text;
    const place = this.place();
    let alreadyLanded: boolean;
    let index: number;
    /** Opens the new paragraph at the place, in the same batch as the first text */
    const open: DocsRequest[] = [];
    if (!place) {
      alreadyLanded = markerMatches && snap.tail.endsWith(this.sentContext() + text);
      index = snap.endIndex - 1;
    } else {
      const before = (place.state.ctx + place.typed).slice(-CONTEXT_CHARS);
      const landedAt = markerMatches ? locate(snap.chars, before + text, place.state.cursor + text.length) : null;
      alreadyLanded = landedAt != null;
      if (landedAt != null) {
        index = landedAt - text.length;
      } else {
        const at = relocate(snap.chars, before, place.state.cursor);
        if (at == null) throw new Error(LOST_PLACE);
        index = at;
        if (!place.state.opened && place.openAt) open.push({ insertText: { location: { index: place.openAt(at) }, text: "\n" } });
      }
    }
    if (alreadyLanded) {
      log.info("sync.write_skipped", { ...this.tag, action: this.job.currentAction, step, chars: text.length, snapshotMs });
      this.job.liveWordCount = snap.wordCount;
    } else {
      this.job.inFlight = { action: this.job.currentAction, step, text };
      await this.persist();
    }
    const fx: Formats | null = place ? place.fx : this.formats();
    const offset = place ? place.offset : this.job.charsSent;
    const list = place ? place.list : this.job.docList ?? null;
    let nextList = list;
    if (!alreadyLanded) {
      const requests: DocsRequest[] = [...open, ...this.contentRequests(text, index, isSource ? offset : null, fx)];
      if (isSource && place?.repair) requests.push(...place.repair(index));
      if (fx) {
        if (isSource) {
          const r = fx.writeRequests(offset, offset + text.length, index, list);
          requests.push(...r.requests);
          nextList = r.docList;
        } else {
          requests.push(...fx.uniformStyleRequests(offset, text.length, index));
        }
      }
      const batchTimer = startTimer(this.now);
      await this.withToken((t) => this.deps.docs.batch(t, this.job.documentId, requests, snap.revisionId || undefined));
      log.info("sync.write", { ...this.tag, action: this.job.currentAction, step, chars: text.length, requests: requests.length, docsMs: batchTimer(), snapshotMs, opened: open.length > 0, inPlace: !!place, charsSent: this.job.charsSent + (isSource ? text.length : 0), totalChars: this.job.totalChars });
      if (isSource && place?.repair) place.repaired();
      this.job.liveWordCount = snap.wordCount + countWords(text, place ? snap.chars.slice(Math.max(0, index - 1), index).replace(/\0/g, " ") : snap.tail);
    } else if (fx && isSource) {
      // The earlier attempt's requests landed with the text, so its list state did too
      nextList = fx.writeRequests(offset, offset + text.length, index, list).docList;
    }
    if (isSource && fx) {
      if (place) place.setList(nextList);
      else this.job.docList = nextList;
    }
    if (place) {
      place.state.opened = true;
      place.state.cursor = index + text.length;
    }
    this.job.inFlight = undefined;
    if (isSource) this.job.charsSent += text.length;
  }

  /** insertText for text, insertInlineImage for each image placeholder, in order */
  private contentRequests(text: string, index: number, sourceOffset: number | null, fx: Formats | null): DocsRequest[] {
    const requests: DocsRequest[] = [];
    let pos = index;
    let buf = "";
    const flush = () => {
      if (buf) requests.push({ insertText: { location: { index: pos }, text: buf } });
      pos += buf.length;
      buf = "";
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\u000C") {
        // A page break and the newline Docs inserts with it (the source has both)
        flush();
        requests.push({ insertPageBreak: { location: { index: pos } } });
        pos += 2;
        if (text[i + 1] === "\n") i++;
        continue;
      }
      const image = ch === OBJ && sourceOffset != null && fx ? fx.imageAt(sourceOffset + i) : undefined;
      if (!image) { buf += ch; continue; }
      flush();
      const size: Record<string, unknown> = {};
      if (image.w > 0) size.width = { magnitude: image.w, unit: "PT" };
      if (image.h > 0) size.height = { magnitude: image.h, unit: "PT" };
      requests.push({ insertInlineImage: { location: { index: pos }, uri: image.src, ...(Object.keys(size).length ? { objectSize: size } : {}) } });
      pos += 1;
    }
    flush();
    return requests;
  }

  private async erase(wrong: string): Promise<void> {
    if (wrong.length === 0) return;
    const snap = await this.withToken((t) => this.deps.docs.snapshot(t, this.job.documentId));
    const place = this.place();
    if (place) {
      const before = (place.state.ctx + place.typed).slice(-CONTEXT_CHARS);
      const end = relocate(snap.chars, before + wrong, place.state.cursor, wrong.length);
      if (end == null) {
        // Already deleted by an earlier attempt?
        const at = relocate(snap.chars, before, place.state.cursor - wrong.length);
        if (at == null) throw new Error(LOST_PLACE);
        place.state.cursor = at;
        return;
      }
      const eraseTimer = startTimer(this.now);
      await this.withToken((t) => this.deps.docs.deleteRange(t, this.job.documentId, end - wrong.length, end));
      log.info("sync.erase", { ...this.tag, action: this.job.currentAction, chars: wrong.length, docsMs: eraseTimer(), inPlace: true });
      place.state.cursor = end - wrong.length;
      return;
    }
    if (!snap.tail.endsWith(wrong)) return; // already deleted by an earlier attempt
    const end = snap.endIndex - 1;
    const start = Math.max(1, end - wrong.length);
    if (start < end) {
      const eraseTimer = startTimer(this.now);
      await this.withToken((t) => this.deps.docs.deleteRange(t, this.job.documentId, start, end));
      log.info("sync.erase", { ...this.tag, action: this.job.currentAction, chars: wrong.length, docsMs: eraseTimer(), inPlace: false });
    }
  }

  private async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    // The lock outlives every Google call made while it is held
    if (!(await this.deps.store.extendLock(this.job.id, this.deps.lockTtlSec ?? 60, this.lock))) {
      log.warn("sync.lock_extend_failed", { ...this.tag, action: this.job.currentAction });
    }
    try {
      return await fn(this.job.accessToken);
    } catch (err: unknown) {
      const code = errorStatus(err);
      if (code === 401 && this.job.refreshToken) {
        const refreshed = await this.deps.refresh(this.job.refreshToken);
        if (refreshed) {
          log.info("sync.token_refreshed", { ...this.tag, action: this.job.currentAction });
          this.job.accessToken = refreshed.access_token;
          return await fn(this.job.accessToken);
        }
        log.warn("sync.token_refresh_failed", { ...this.tag, action: this.job.currentAction });
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
  text = text.replace(/\uFFFC/g, " ");
  tail = tail.replace(/\uFFFC/g, " ");
  const joined = tail.slice(-1) + text;
  const words = joined.trim() ? joined.trim().split(/\s+/).length : 0;
  const tailWord = tail.slice(-1).trim() ? 1 : 0;
  return Math.max(0, words - tailWord);
}

/**
 * Index just past the occurrence of `context` in the index-aligned document
 * text that ends closest to `hint`, or null when it does not occur.
 */
export function locate(chars: string, context: string, hint: number): number | null {
  if (!context) return hint >= 1 && hint < chars.length ? hint : null;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let i = chars.indexOf(context); i !== -1; i = chars.indexOf(context, i + 1)) {
    const end = i + context.length;
    const distance = Math.abs(end - hint);
    if (distance < bestDistance) {
      best = end;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Find the typing position again from the text before it. Edits close
 * above the position can change the start of that text, so shorter endings
 * of it are tried before giving up; the one nearest the expected index wins.
 * `keep` characters at the end are always part of the search.
 */
export function relocate(chars: string, context: string, hint: number, keep = 0): number | null {
  for (const extra of [Infinity, 24, 10]) {
    const len = Math.min(context.length, keep + extra);
    if (extra !== Infinity && len === context.length) continue; // already tried in full
    const found = locate(chars, context.slice(context.length - len), hint);
    if (found != null) return found;
  }
  return null;
}
