import { NextRequest, NextResponse } from "next/server";
import { applyAuthCookies, resolveUser, unauthorized, type SessionUser } from "./auth";
import { getStore, toPublicJob, type ControlCommand, type SyncJob } from "./sync-store";
import { applyControl } from "./sync-runner";

/** Resolve the signed-in user and the job they asked for, enforcing ownership. */
export async function loadOwnedJob(
  req: NextRequest,
  jobId: string | null
): Promise<{ user: SessionUser; job: SyncJob } | NextResponse> {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  const job = await getStore().getJob(jobId);
  if (!job || job.userId !== user.userId) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  return { user, job };
}

export async function readJobId(req: NextRequest): Promise<string | null> {
  if (req.method === "GET") return req.nextUrl.searchParams.get("jobId");
  try {
    const body = await req.json();
    return typeof body?.jobId === "string" ? body.jobId : null;
  } catch {
    return null;
  }
}

export function jobResponse(user: SessionUser, job: SyncJob, extra: Record<string, unknown> = {}): NextResponse {
  return applyAuthCookies(user === undefined ? NextResponse.json({}) : NextResponse.json({ job: toPublicJob(job), ...extra }), user);
}

const LOCK_SPIN_MS = 3_000;
const LOCK_POLL_MS = 150;

/**
 * Run `mutate` on a fresh copy of the job while holding its lock, so it can
 * never race the worker. If the worker keeps the lock for too long, fall back
 * to leaving a control intent (pause/cancel) that the worker applies within a
 * few seconds, and return the job as it will look once applied.
 */
export async function mutateJob(
  jobId: string,
  mutate: (fresh: SyncJob) => SyncJob | NextResponse,
  intent?: ControlCommand
): Promise<SyncJob | NextResponse> {
  const store = getStore();
  const deadline = Date.now() + LOCK_SPIN_MS;
  let locked = await store.acquireLock(jobId, 10);
  while (!locked && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    locked = await store.acquireLock(jobId, 10);
  }
  if (locked) {
    try {
      const fresh = await store.getJob(jobId);
      if (!fresh) return NextResponse.json({ error: "Job not found" }, { status: 404 });
      const pending = await store.getControl(jobId);
      const base = pending && fresh.status !== "paused" && fresh.status !== "cancelled" && fresh.status !== "done" && fresh.status !== "error"
        ? await applyControl(store, fresh, pending, Date.now)
        : fresh;
      const result = mutate(base);
      if (result instanceof NextResponse) return result;
      result.lastUpdate = Date.now();
      await store.setJob(result);
      return result;
    } finally {
      await store.releaseLock(jobId);
    }
  }
  if (!intent) {
    return NextResponse.json({ error: "The sync is busy right now, try again in a moment" }, { status: 409 });
  }
  const current = await store.getJob(jobId);
  if (!current) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  await store.setControl(jobId, intent);
  const t = Date.now();
  return intent === "pause"
    ? { ...current, status: "paused", activity: "Pausing", pausedAt: t, lastUpdate: t }
    : { ...current, status: "cancelled", activity: "Cancelling", finishedAt: t, lastUpdate: t };
}
