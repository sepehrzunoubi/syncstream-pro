import { NextRequest, NextResponse } from "next/server";
import {
  getDocEndIndex,
  insertAtIndex,
  deleteRange,
  refreshAccessToken,
} from "@/lib/google";
import { getJob, getPayload, setJob, setPayload, removeActiveJob, type SyncJob } from "@/lib/sync-store";
import { getQStashReceiver, enqueueProcess } from "@/lib/qstash";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max on Vercel Pro

// Delays ≥ this threshold are offloaded to a scheduled QStash message
// instead of sleeping inside the function. Saves compute + reduces chain hops.
const LONG_PAUSE_THRESHOLD_MS = 120_000; // 2 minutes

export async function POST(req: NextRequest) {
  // ── Auth: verify request comes from QStash or internal caller ─────────
  let parsed: { jobId: string };
  const receiver = getQStashReceiver();
  if (receiver) {
    const body = await req.text();
    const signature = req.headers.get("upstash-signature") || "";
    try {
      await receiver.verify({ signature, body });
    } catch {
      // Not from QStash — check for internal auth header (stall-recovery / local dev)
      if (req.headers.get("x-syncstream-internal") !== "1") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
    parsed = JSON.parse(body);
  } else {
    parsed = await req.json();
  }

  const { jobId } = parsed;
  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  // ── Load payload from Redis (single source of truth) ──────────────────
  const payload = await getPayload(jobId);
  if (!payload) {
    return NextResponse.json({ status: "not_found" });
  }

  const {
    refreshToken,
    documentId,
    actions,
    totalChars,
    totalMinutes,
    startTime,
  } = payload;
  let { accessToken, currentAction, charsSent } = payload;
  let resumeRemainingDelayMs = payload.remainingDelayMs ?? 0;
  const myGeneration = payload.generation ?? 0;
  let typoSubStep = payload.typoSubStep ?? 0;
  let typoCharsInDoc = payload.typoCharsInDoc ?? 0;

  const totalActions = actions.length;

  // Read persistent state from the existing job (pauses, baseline word count)
  let mandatoryPauses: number[] | undefined;
  let completedPauses: number[] = [];
  let baselineWordCount: number | undefined;
  {
    const existingJob = await getJob(jobId);
    if (existingJob) {
      mandatoryPauses = existingJob.mandatoryPauses;
      completedPauses = existingJob.completedPauses ?? [];
      baselineWordCount = existingJob.baselineWordCount;
    }
  }

  // Helper: persist payload to Redis so resume/stall-recovery always has fresh state
  async function persistProgress(remainingDelayMs = 0) {
    await setPayload({
      jobId, accessToken, refreshToken, documentId,
      actions, currentAction, charsSent, totalChars, totalMinutes, startTime,
      remainingDelayMs, generation: myGeneration,
      typoSubStep, typoCharsInDoc,
    });
  }

  // Helper: check if paused/cancelled/stale-generation, save position if paused
  async function checkPaused(remainingDelayMs = 0): Promise<boolean> {
    const job = await getJob(jobId);
    if (!job) return true;
    // Stale loop: a newer resume has started — exit silently
    if ((job.generation ?? 0) > myGeneration) return true;
    if (job.status === "cancelled" || job.status === "paused") {
      if (job.status === "paused") await persistProgress(remainingDelayMs);
      return true;
    }
    return false;
  }

  // Check if job was cancelled or a newer generation already took over
  const existingJob = await getJob(jobId);
  if (!existingJob) return NextResponse.json({ status: "not_found" });
  if ((existingJob.generation ?? 0) > myGeneration) {
    return NextResponse.json({ status: "stale" });
  }
  if (existingJob.status === "cancelled" || existingJob.status === "paused") {
    return NextResponse.json({ status: existingJob.status });
  }

  // Token refresh helper
  async function withTokenRefresh<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(accessToken);
    } catch (err: unknown) {
      const status = (err as { code?: number })?.code ?? (err as { status?: number })?.status;
      if ((status === 401 || status === 403) && refreshToken) {
        const refreshed = await refreshAccessToken(refreshToken);
        if (refreshed) {
          accessToken = refreshed.access_token;
          return await fn(accessToken);
        }
      }
      throw err;
    }
  }

  // Pre-compute remaining delay for ETA
  // currentDelayRemaining: if we're mid-delay, pass how much is left instead of the full action delay
  function calcEta(fromIdx: number, currentDelayRemaining?: number): number {
    let sum = 0;
    for (let j = fromIdx; j < totalActions; j++) {
      if (j === fromIdx && currentDelayRemaining !== undefined) {
        sum += currentDelayRemaining;
      } else {
        sum += actions[j].delayMs;
      }
    }
    return sum;
  }

  function calcWpm(): number {
    const elapsedMin = Math.max(0.05, (Date.now() - startTime) / 60_000);
    if (charsSent === 0) return 0;
    return Math.round((charsSent / 5) / elapsedMin);
  }

  // Find next typo action after a given index
  function getNextTypoAction(afterIdx: number): number | undefined {
    for (let t = afterIdx + 1; t < totalActions; t++) {
      if (actions[t].kind === "typo") return t;
    }
    return undefined;
  }

  // Find next pause action (>60s delay or mandatory) after a given index
  function getNextPauseAction(afterIdx: number): number | undefined {
    for (let t = afterIdx + 1; t < totalActions; t++) {
      if (actions[t].mandatoryPauseIndex != null) return t;
      if (actions[t].kind === "pause" && actions[t].delayMs >= 60_000) return t;
      // Also flag inter-burst gaps (non-pause actions with long delays)
      if (actions[t].delayMs >= 60_000) return t;
    }
    return undefined;
  }

  async function updateJobStore(overrides: Partial<SyncJob> = {}) {
    const job: SyncJob = {
      id: jobId,
      status: "running",
      currentAction,
      totalActions,
      charsSent,
      totalChars,
      totalMinutes,
      wpm: calcWpm(),
      eta: currentAction < totalActions ? calcEta(currentAction) : 0,
      etaTargetAt: currentAction < totalActions ? Date.now() + calcEta(currentAction) : Date.now(),
      activity: currentAction < totalActions ? actions[currentAction].activity : "Done",
      nextDelayMs: currentAction < totalActions ? actions[currentAction].delayMs : 0,
      nextActionAt: currentAction < totalActions && actions[currentAction].delayMs > 0
        ? Date.now() + actions[currentAction].delayMs
        : undefined,
      nextTypoAction: getNextTypoAction(currentAction),
      nextPauseAction: getNextPauseAction(currentAction),
      startTime,
      lastUpdate: Date.now(),
      generation: myGeneration,
      mandatoryPauses,
      completedPauses,
      baselineWordCount,
      ...overrides,
    };
    await setJob(job);
  }

  // Mark as running — account for partial delay on resume
  if (resumeRemainingDelayMs > 0 && currentAction < totalActions) {
    const etaMs = calcEta(currentAction, resumeRemainingDelayMs);
    await updateJobStore({
      nextActionAt: Date.now() + resumeRemainingDelayMs,
      eta: etaMs,
      etaTargetAt: Date.now() + etaMs,
    });
  } else {
    await updateJobStore();
  }

  const invocationStart = Date.now();
  const SAFETY_MARGIN_MS = 30_000; // self-chain 30s before timeout

  // ── Main processing loop ────────────────────────────────────────────────
  try {
    while (currentAction < totalActions) {
      // Check cancellation/pause
      if (await checkPaused()) {
        return NextResponse.json({ status: "paused" });
      }

      // Check if we need to chain before timeout
      const elapsed = Date.now() - invocationStart;
      if (elapsed > (maxDuration * 1000) - SAFETY_MARGIN_MS) {
        // Persist to Redis BEFORE chaining so recovery always has fresh state
        await persistProgress(resumeRemainingDelayMs);
        await updateJobStore({ activity: "Chaining…" });
        await enqueueProcess(jobId);
        return NextResponse.json({ status: "chained", currentAction });
      }

      const action = actions[currentAction];

      // ── Long-pause optimization: schedule via QStash instead of sleeping ──
      // For pause-kind actions with delays ≥ threshold, offload the wait to a
      // scheduled QStash message. This frees the serverless function immediately
      // and avoids dozens of fragile self-chain hops for multi-hour pauses.
      if (
        action.kind === "pause" &&
        action.delayMs >= LONG_PAUSE_THRESHOLD_MS &&
        resumeRemainingDelayMs === 0 // don't re-schedule if we're resuming mid-delay
      ) {
        // Mark mandatory pause completed
        if (action.mandatoryPauseIndex != null && !completedPauses.includes(action.mandatoryPauseIndex)) {
          completedPauses = [...completedPauses, action.mandatoryPauseIndex];
        }
        // Advance past the pause action
        currentAction++;
        await persistProgress();

        // Update job store with ETA that includes the scheduled delay
        const remainingAfterPause = calcEta(currentAction);
        const totalRemainingMs = action.delayMs + remainingAfterPause;
        await updateJobStore({
          activity: action.activity,
          eta: totalRemainingMs,
          etaTargetAt: Date.now() + totalRemainingMs,
          nextActionAt: Date.now() + action.delayMs,
          currentPauseDelayMs: action.delayMs,
          completedPauses,
        });

        // Schedule delayed wakeup — QStash guarantees delivery
        const delaySec = Math.ceil(action.delayMs / 1000);
        await enqueueProcess(jobId, delaySec);
        return NextResponse.json({ status: "scheduled", currentAction });
      }

      // Wait for delay (skip pre-delay for typo actions — they handle delays internally)
      if (action.kind !== "typo") {
        // Use saved remaining delay on resume, otherwise full delay
        let remaining = resumeRemainingDelayMs > 0 ? resumeRemainingDelayMs : action.delayMs;
        resumeRemainingDelayMs = 0; // consumed

        while (remaining > 0) {
          const chunk = Math.min(remaining, 3000); // check every 3s
          await sleep(chunk);
          remaining -= chunk;

          // Check pause — save how much delay is left
          if (await checkPaused(remaining > 0 ? remaining : 0)) {
            return NextResponse.json({ status: "paused" });
          }

          // Check timeout during long waits
          const midElapsed = Date.now() - invocationStart;
          if (midElapsed > (maxDuration * 1000) - SAFETY_MARGIN_MS) {
            // Persist to Redis BEFORE chaining
            await persistProgress(remaining);
            await updateJobStore({ activity: "Chaining…" });
            await enqueueProcess(jobId);
            return NextResponse.json({ status: "chained", currentAction });
          }

          // Set currentPauseDelayMs so stall detector knows a long pause is active
          const pauseDelayOverride = action.mandatoryPauseIndex != null ? remaining : 0;
          const etaMs = calcEta(currentAction, remaining);
          await updateJobStore({
            activity: action.activity,
            nextActionAt: Date.now() + remaining,
            eta: etaMs,
            etaTargetAt: Date.now() + etaMs,
            currentPauseDelayMs: pauseDelayOverride,
          });
        }
      } else {
        resumeRemainingDelayMs = 0; // consumed for typo actions too
      }

      // Execute the action
      if (action.kind === "insert" && action.text.length > 0) {
        if (await checkPaused()) return NextResponse.json({ status: "paused" });
        const endIdx = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
        await withTokenRefresh((t) => insertAtIndex(t, documentId, action.text, endIdx - 1));
        charsSent += action.text.length;
        await updateJobStore({ activity: "Typing…" });

      } else if (action.kind === "typo") {
        const typoText = action.typoChars || "xxxxx";

        // Typo is a multi-step atomic operation. typoSubStep tracks where we are:
        // 0 = start (insert wrong chars), 1 = wrong chars in doc (wait + delete), 2 = deleted (insert correct)

        // Step 1: Insert wrong characters (skip if resuming past this step)
        if (typoSubStep <= 0) {
          if (await checkPaused()) return NextResponse.json({ status: "paused" });
          const endIdx = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
          await withTokenRefresh((t) => insertAtIndex(t, documentId, typoText, endIdx - 1));
          typoSubStep = 1;
          typoCharsInDoc = typoText.length;
          await updateJobStore({ activity: "Correcting typo…" });
        }

        // Step 2: Pause to simulate noticing the typo (with pause checks)
        if (typoSubStep <= 1) {
          let typoRemaining = typoSubStep === 1 && resumeRemainingDelayMs > 0
            ? resumeRemainingDelayMs : action.delayMs;
          resumeRemainingDelayMs = 0;
          while (typoRemaining > 0) {
            const chunk = Math.min(typoRemaining, 1000);
            await sleep(chunk);
            typoRemaining -= chunk;
            if (await checkPaused(typoRemaining > 0 ? typoRemaining : 0)) {
              return NextResponse.json({ status: "paused" });
            }
          }

          // Step 3: Delete the wrong characters
          if (await checkPaused()) return NextResponse.json({ status: "paused" });
          const endIdx2 = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
          const deleteEnd = endIdx2 - 1;
          const deleteStart = Math.max(1, deleteEnd - typoCharsInDoc);
          if (deleteStart < deleteEnd) {
            await withTokenRefresh((t) => deleteRange(t, documentId, deleteStart, deleteEnd));
          }
          typoSubStep = 2;
          typoCharsInDoc = 0;
        }

        // Step 4: Insert correct text
        if (typoSubStep <= 2) {
          if (action.text.length > 0) {
            if (await checkPaused()) return NextResponse.json({ status: "paused" });
            const endIdx3 = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
            await withTokenRefresh((t) => insertAtIndex(t, documentId, action.text, endIdx3 - 1));
            charsSent += action.text.length;
          }
        }

        // Reset typo tracking for next action
        typoSubStep = 0;
        typoCharsInDoc = 0;
        await updateJobStore({ activity: "Typing…" });
      }
      // pause/heartbeat actions just consumed their delay above
      // V2 burst: if this was a mandatory pause, mark it completed
      if (action.mandatoryPauseIndex != null && !completedPauses.includes(action.mandatoryPauseIndex)) {
        completedPauses = [...completedPauses, action.mandatoryPauseIndex];
      }

      currentAction++;
      await updateJobStore({ currentPauseDelayMs: 0 });
      // Persist progress to Redis after every action so resume is always fresh
      await persistProgress();
    }

    // All actions complete
    await updateJobStore({ status: "done", activity: "Done" });
    await removeActiveJob(jobId);
    return NextResponse.json({ status: "done", charsSent });

  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Sync job ${jobId} error at action ${currentAction}:`, message);
    await updateJobStore({ status: "error", error: message, activity: "Error" });
    await removeActiveJob(jobId);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
