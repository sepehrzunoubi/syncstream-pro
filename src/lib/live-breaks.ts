/**
 * Changing a running sync's breaks. The worker typing the sync is the only writer of its job while
 * it holds the job's lock, so a change is applied under that lock when it can be had quickly, and
 * otherwise left for the worker, which applies it between actions or within seconds of a wait.
 */

import { applyBreakEdit, MAX_ANCHORED_MINUTES, parseAnchors, type BreakEdit } from "./breaks";
import { estimateJob } from "./sync-runner";
import { isTerminal, type SyncJob, type SyncStore } from "./sync-store";

export interface LiveBreakDeps {
  store: SyncStore;
  enqueue(jobId: string, generation: number, delaySec: number, tick?: number): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to try for the lock before leaving the change for the worker. Default 3s. */
  spinMs?: number;
}

export type LiveBreakResult =
  | { ok: true; job: SyncJob; applied: boolean }
  | { ok: false; status: number; error: string; job?: SyncJob };

/** Check a request body's breaks against the plan's text; the job's own limits are checked when applied */
export function parseBreakEdit(body: Record<string, unknown>, sourceText: string, ends: number[]): { ok: true; edit: BreakEdit } | { ok: false; error: string } {
  const parsed = parseAnchors(body.breaks ?? [], sourceText, { ends });
  if (!parsed.ok) return parsed;
  const edit: BreakEdit = { breaks: parsed.anchors };
  const current = body.current as Record<string, unknown> | undefined;
  if (current != null) {
    if (current.end === true) edit.current = { end: true };
    else if (typeof current.minutes === "number" && Number.isInteger(current.minutes) && current.minutes >= 1 && current.minutes <= MAX_ANCHORED_MINUTES) edit.current = { minutes: current.minutes };
    else return { ok: false, error: "Invalid change to the current break" };
  }
  if (body.version != null) {
    if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 0) return { ok: false, error: "Invalid version" };
    edit.version = body.version;
  }
  return { ok: true, edit };
}

const LOCK_POLL_MS = 150;

export async function changeBreaks(jobId: string, edit: BreakEdit, deps: LiveBreakDeps): Promise<LiveBreakResult> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (deps.spinMs ?? 3_000);
  let lock = await store.acquireLock(jobId, 10);
  while (!lock && now() < deadline) {
    await sleep(LOCK_POLL_MS);
    lock = await store.acquireLock(jobId, 10);
  }

  if (!lock) {
    // The worker is busy with this sync: leave the change for it, checked against what it will see
    const job = await store.getJob(jobId);
    if (!job) return { ok: false, status: 404, error: "Job not found" };
    if (isTerminal(job.status)) return { ok: false, status: 409, error: "This sync has finished", job };
    // A change still waiting for the worker was made against the same version: this one, a full
    // list of the breaks ahead, takes its place (keeping what it did to the current break)
    const queued = await store.getBreakEdit(jobId);
    const version = job.breaksVersion ?? 0;
    if (edit.version != null && edit.version !== version) return { ok: false, status: 409, error: "The breaks were changed somewhere else. Check them and try again.", job };
    await store.setBreakEdit(jobId, { ...edit, current: edit.current ?? queued?.current, version });
    try { await deps.enqueue(jobId, job.generation, 2); } catch { /* the worker applies it at its next check anyway */ }
    return { ok: true, job, applied: false };
  }

  try {
    const job = await store.getJob(jobId);
    const plan = job ? await store.getPlan(jobId) : null;
    if (!job || !plan) return { ok: false, status: 404, error: "Job not found" };
    if (isTerminal(job.status)) return { ok: false, status: 409, error: "This sync has finished", job };
    // A change left for the worker and not applied yet was made against the same version as this
    // one, which replaces it (keeping what it did to the current break)
    const queued = await store.getBreakEdit(jobId);
    if (queued) await store.clearBreakEdit(jobId);
    const result = applyBreakEdit(plan, job, queued ? { ...edit, current: edit.current ?? queued.current } : edit, now());
    if (!result.ok) {
      if (queued) await store.setBreakEdit(jobId, queued);
      return { ok: false, status: result.conflict ? 409 : 400, error: result.error, job };
    }
    estimateJob(job, plan.actions, now());
    job.lastUpdate = now();
    // The wait ends sooner than the delivery already queued: queue one for the new time. The tick
    // makes the old delivery a duplicate when it arrives.
    const handOff = result.sooner && job.status === "running" && job.nextActionAt != null;
    if (handOff) job.tick = (job.tick ?? 0) + 1;
    await store.setPlan(plan);
    await store.setJob(job);
    if (handOff) await deps.enqueue(jobId, job.generation, Math.max(0, Math.ceil((job.nextActionAt! - now()) / 1000)), job.tick);
    return { ok: true, job, applied: true };
  } finally {
    await store.releaseLock(jobId, lock);
  }
}
