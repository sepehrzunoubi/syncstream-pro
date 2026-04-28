import { NextRequest, NextResponse } from "next/server";
import { getJob, getPayload, setJob, type SyncJobPayload } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { jobId } = await req.json();

  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status !== "paused") {
    return NextResponse.json({ error: "Job is not paused" }, { status: 400 });
  }

  // Get the saved payload with the original plan + current position
  const savedPayload = await getPayload(jobId);
  if (!savedPayload) {
    return NextResponse.json({ error: "Job payload not found — cannot resume" }, { status: 404 });
  }

  // Refresh tokens from cookies (they may have been refreshed since pause)
  const token = req.cookies.get("google_access_token")?.value;
  const refreshToken = req.cookies.get("google_refresh_token")?.value;

  const payload: SyncJobPayload = {
    ...savedPayload,
    accessToken: token || savedPayload.accessToken,
    refreshToken: refreshToken || savedPayload.refreshToken,
  };

  // Bump generation so any stale process loops self-terminate
  const nextGen = (job.generation ?? 0) + 1;

  // Recompute the absolute eta + next-action targets from the FULL remaining
  // plan (pause cleared remainingDelayMs, so the current action restarts at its
  // original delayMs). The dashboard's first poll after resume will see the
  // corrected wall-clock targets immediately, no stale data window.
  const now = Date.now();
  const actions = savedPayload.actions;
  const fromIdx = savedPayload.currentAction;
  let remainingPlanMs = 0;
  for (let i = fromIdx; i < actions.length; i++) remainingPlanMs += actions[i].delayMs;
  const currentDelayMs = fromIdx < actions.length ? actions[fromIdx].delayMs : 0;

  // Mark job as running again with new generation + fresh wall-clock targets
  await setJob({
    ...job,
    status: "running",
    activity: "Resuming…",
    lastUpdate: now,
    pausedAt: undefined,
    generation: nextGen,
    eta: remainingPlanMs,
    etaTargetAt: now + remainingPlanMs,
    nextActionAt: currentDelayMs > 0 ? now + currentDelayMs : undefined,
    nextDelayMs: currentDelayMs,
    currentPauseDelayMs: 0,
  });

  // Pass generation to the process loop so it can verify it's still current
  const payloadWithGen = { ...payload, generation: nextGen };

  // Kick off background processing — await with timeout to ensure request is sent
  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    await fetch(`${origin}/api/sync/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWithGen),
      signal: controller.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch {
    // AbortError expected — the process invocation runs for minutes
  }

  return NextResponse.json({ jobId, resumed: true });
}
