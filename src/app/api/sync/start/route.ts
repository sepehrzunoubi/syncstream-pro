import { NextRequest, NextResponse } from "next/server";
import { buildDripPlan, type PaceMode } from "@/lib/drip-engine";
import { createJobId, setJob, type SyncJob, type SyncJobPayload } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;
  const refreshToken = req.cookies.get("google_refresh_token")?.value;

  if (!token && !refreshToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    text,
    documentId,
    rhythm: rhythmKey = "human",
    durationMinutes = 30,
    typoFrequency = 0.5,
    pauseVariance = 0.5,
  } = body as {
    text: string;
    documentId: string;
    rhythm: string;
    durationMinutes: number;
    typoFrequency: number;
    pauseVariance: number;
  };

  if (!text || !documentId) {
    return NextResponse.json({ error: "Missing text or documentId" }, { status: 400 });
  }

  if (text.length > 1_000_000) {
    return NextResponse.json({ error: "Text exceeds maximum length" }, { status: 400 });
  }

  if (typeof durationMinutes !== "number" || durationMinutes < 1 || durationMinutes > 10080) {
    return NextResponse.json({ error: "Duration must be between 1 minute and 7 days" }, { status: 400 });
  }

  const clampedTypoFrequency = Math.max(0, Math.min(1, typoFrequency));
  const clampedPauseVariance = Math.max(0, Math.min(1, pauseVariance));

  const mode: PaceMode = rhythmKey === "burst" ? "burst" : "human";
  const plan = buildDripPlan(text, durationMinutes, mode, {
    typoFrequency: clampedTypoFrequency,
    pauseVariance: clampedPauseVariance,
  });

  const jobId = createJobId();
  const now = Date.now();

  // Store initial job state for status polling
  const job: SyncJob = {
    id: jobId,
    status: "pending",
    currentAction: 0,
    totalActions: plan.actions.length,
    charsSent: 0,
    totalChars: plan.totalChars,
    totalMinutes: plan.totalMinutes,
    wpm: 0,
    eta: plan.actions.reduce((sum, a) => sum + a.delayMs, 0),
    activity: "Starting…",
    nextDelayMs: 0,
    startTime: now,
    lastUpdate: now,
  };
  await setJob(job);

  // Build payload for the process endpoint
  const payload: SyncJobPayload = {
    jobId,
    accessToken: token || "",
    refreshToken: refreshToken || "",
    documentId,
    actions: plan.actions,
    currentAction: 0,
    charsSent: 0,
    totalChars: plan.totalChars,
    totalMinutes: plan.totalMinutes,
    startTime: now,
  };

  // Fire-and-forget: kick off background processing
  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  fetch(`${origin}/api/sync/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error("Failed to kick off sync/process:", err);
  });

  return NextResponse.json({
    jobId,
    totalActions: plan.actions.length,
    totalChars: plan.totalChars,
    totalMinutes: plan.totalMinutes,
  });
}
