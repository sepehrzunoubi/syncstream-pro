import { NextRequest, NextResponse } from "next/server";
import { getJob, getPayload, setJob, setPayload } from "@/lib/sync-store";

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

  if (job.status !== "running" && job.status !== "pending") {
    return NextResponse.json({ status: job.status, message: "Job is not running" });
  }

  const now = Date.now();
  await setJob({
    ...job,
    status: "paused",
    activity: "Paused",
    lastUpdate: now,
    pausedAt: now,
    // Clear next-action timer so the UI freezes cleanly
    nextActionAt: undefined,
    currentPauseDelayMs: 0,
  });

  // Clear remainingDelayMs in the saved payload so resume restarts the
  // current action's delay from its FULL original duration (per spec:
  // "if there's syncing in 12.3s, pause+resume should count down from 12.3s again").
  const payload = await getPayload(jobId);
  if (payload && (payload.remainingDelayMs ?? 0) > 0) {
    await setPayload({ ...payload, remainingDelayMs: 0 });
  }

  return NextResponse.json({ status: "paused" });
}
