import { NextRequest, NextResponse } from "next/server";
import { buildDripPlan, type PaceMode } from "@/lib/drip-engine";
import { createJobId, setJob, setPayload, type SyncJob, type SyncJobPayload } from "@/lib/sync-store";
import { getUserInfo, refreshAccessToken, getDocWordCount } from "@/lib/google";
import { verifyKeyAccess } from "@/lib/key-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;
  const refreshToken = req.cookies.get("google_refresh_token")?.value;

  if (!token && !refreshToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve user identity for server-side key verification
  let userId: string | null = null;
  if (token) {
    try {
      const user = await getUserInfo(token);
      userId = user?.id ?? null;
    } catch { /* try refresh below */ }
  }
  if (!userId && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed) {
      try {
        const user = await getUserInfo(refreshed.access_token);
        userId = user?.id ?? null;
      } catch { /* failed */ }
    }
  }
  if (!userId) {
    return NextResponse.json({ error: "Could not verify user identity" }, { status: 401 });
  }

  // Server-side key verification — confirms this user has an active binding in Redis
  const keyCheck = await verifyKeyAccess(userId);
  if (!keyCheck.valid) {
    return NextResponse.json({ error: keyCheck.error || "License key required." }, { status: 403 });
  }

  const body = await req.json();
  const {
    text,
    documentId,
    rhythm: rhythmKey = "human",
    durationMinutes = 30,
    typoFrequency = 0.5,
    pauseVariance = 0.5,
    customPauses = [],
  } = body as {
    text: string;
    documentId: string;
    rhythm: string;
    durationMinutes: number;
    typoFrequency: number;
    pauseVariance: number;
    customPauses?: number[];
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

  const mode: PaceMode =
    rhythmKey === "burst" ? "burst" : rhythmKey === "custom" ? "custom" : "human";

  // Validate custom pauses against the catalog (engine also sanitizes, but reject
  // bad client input with a 400 for clarity).
  const CATALOG = [4, 10, 15, 30, 45, 60, 90, 120, 180];
  let safeCustomPauses: number[] = [];
  if (mode === "custom") {
    if (!Array.isArray(customPauses)) {
      return NextResponse.json({ error: "customPauses must be an array" }, { status: 400 });
    }
    if (customPauses.length > 4) {
      return NextResponse.json({ error: "customPauses cannot exceed 4 entries" }, { status: 400 });
    }
    for (const p of customPauses) {
      if (typeof p !== "number" || !CATALOG.includes(p)) {
        return NextResponse.json({ error: `Invalid custom pause value: ${p}` }, { status: 400 });
      }
    }
    safeCustomPauses = customPauses;
  }

  const plan = buildDripPlan(text, durationMinutes, mode, {
    typoFrequency: clampedTypoFrequency,
    pauseVariance: clampedPauseVariance,
  }, safeCustomPauses);

  const jobId = createJobId();
  const now = Date.now();

  // Capture baseline word count in target doc BEFORE sync starts (server-side, authoritative)
  let baselineWordCount = 0;
  try {
    const effectiveToken = token || (refreshToken ? (await refreshAccessToken(refreshToken))?.access_token : null);
    if (effectiveToken) {
      baselineWordCount = await getDocWordCount(effectiveToken, documentId);
    }
  } catch { /* best effort — default to 0 */ }

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
    etaTargetAt: now + plan.actions.reduce((sum, a) => sum + a.delayMs, 0),
    activity: "Starting…",
    nextDelayMs: 0,
    startTime: now,
    lastUpdate: now,
    mandatoryPauses: plan.mandatoryPauses,
    completedPauses: plan.mandatoryPauses ? [] : undefined,
    baselineWordCount,
  };
  await setJob(job);

  // Build payload for the process endpoint — also persist to Redis for pause/resume
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

  await setPayload(payload);

  // Kick off background processing — await with timeout to ensure request is sent
  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    await fetch(`${origin}/api/sync/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch {
    // AbortError expected — the process invocation runs for minutes
  }

  return NextResponse.json({
    jobId,
    totalActions: plan.actions.length,
    totalChars: plan.totalChars,
    totalMinutes: plan.totalMinutes,
  });
}
