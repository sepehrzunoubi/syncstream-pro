import { NextRequest, NextResponse } from "next/server";
import {
  getDocEndIndex,
  insertAtIndex,
  deleteRange,
  refreshAccessToken,
} from "@/lib/google";
import { getJob, setJob, setPayload, type SyncJob, type SyncJobPayload } from "@/lib/sync-store";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max on Vercel Pro

export async function POST(req: NextRequest) {
  const payload: SyncJobPayload = await req.json();
  const {
    jobId,
    refreshToken,
    documentId,
    actions,
    totalChars,
    totalMinutes,
    startTime,
  } = payload;
  let { accessToken, currentAction, charsSent } = payload;
  let resumeRemainingDelayMs = payload.remainingDelayMs ?? 0;

  const totalActions = actions.length;

  // Helper: save current position + remaining delay for resume
  async function savePosition(remainingDelayMs = 0) {
    await setPayload({
      jobId, accessToken, refreshToken, documentId,
      actions, currentAction, charsSent, totalChars, totalMinutes, startTime,
      remainingDelayMs,
    });
  }

  // Helper: check if paused/cancelled, save position if paused
  async function checkPaused(remainingDelayMs = 0): Promise<boolean> {
    const job = await getJob(jobId);
    if (job && (job.status === "cancelled" || job.status === "paused")) {
      if (job.status === "paused") await savePosition(remainingDelayMs);
      return true;
    }
    return false;
  }

  // Check if job was cancelled
  const existingJob = await getJob(jobId);
  if (existingJob && (existingJob.status === "cancelled" || existingJob.status === "paused")) {
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
  function calcEta(fromIdx: number): number {
    let sum = 0;
    for (let j = fromIdx; j < totalActions; j++) {
      sum += actions[j].delayMs;
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
      activity: currentAction < totalActions ? actions[currentAction].activity : "Done",
      nextDelayMs: currentAction < totalActions ? actions[currentAction].delayMs : 0,
      nextTypoAction: getNextTypoAction(currentAction),
      startTime,
      lastUpdate: Date.now(),
      ...overrides,
    };
    await setJob(job);
  }

  // Mark as running
  await updateJobStore();

  const invocationStart = Date.now();
  const SAFETY_MARGIN_MS = 30_000; // self-chain 30s before timeout

  // ── Main processing loop ────────────────────────────────────────────────
  try {
    while (currentAction < totalActions) {
      // Check cancellation/pause
      if (await checkPaused()) {
        return NextResponse.json({ status: "paused" });
      }

      // Check if we need to self-chain before timeout
      const elapsed = Date.now() - invocationStart;
      if (elapsed > (maxDuration * 1000) - SAFETY_MARGIN_MS) {
        await updateJobStore({ activity: "Chaining…" });
        await selfChain(req, {
          jobId, accessToken, refreshToken, documentId,
          actions, currentAction, charsSent, totalChars, totalMinutes, startTime,
          remainingDelayMs: resumeRemainingDelayMs,
        });
        return NextResponse.json({ status: "chained", currentAction });
      }

      const action = actions[currentAction];

      // Wait for delay (skip pre-delay for typo actions)
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
            await updateJobStore({ activity: "Chaining…" });
            await selfChain(req, {
              jobId, accessToken, refreshToken, documentId,
              actions, currentAction, charsSent, totalChars, totalMinutes, startTime,
              remainingDelayMs: remaining,
            });
            return NextResponse.json({ status: "chained", currentAction });
          }

          await updateJobStore({ activity: action.activity });
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

        // Step 1: Insert wrong characters
        if (await checkPaused()) return NextResponse.json({ status: "paused" });
        const endIdx = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
        await withTokenRefresh((t) => insertAtIndex(t, documentId, typoText, endIdx - 1));
        await updateJobStore({ activity: "Correcting typo…" });

        // Step 2: Pause to simulate noticing the typo (with pause checks)
        {
          let typoRemaining = action.delayMs;
          while (typoRemaining > 0) {
            const chunk = Math.min(typoRemaining, 1000);
            await sleep(chunk);
            typoRemaining -= chunk;
            if (await checkPaused()) return NextResponse.json({ status: "paused" });
          }
        }

        // Step 3: Delete the wrong characters
        if (await checkPaused()) return NextResponse.json({ status: "paused" });
        const endIdx2 = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
        const deleteEnd = endIdx2 - 1;
        const deleteStart = Math.max(1, deleteEnd - typoText.length);
        if (deleteStart < deleteEnd) {
          await withTokenRefresh((t) => deleteRange(t, documentId, deleteStart, deleteEnd));
        }

        // Step 4: Insert correct text
        if (action.text.length > 0) {
          if (await checkPaused()) return NextResponse.json({ status: "paused" });
          const endIdx3 = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
          await withTokenRefresh((t) => insertAtIndex(t, documentId, action.text, endIdx3 - 1));
          charsSent += action.text.length;
        }

        await updateJobStore({ activity: "Typing…" });
      }
      // pause/heartbeat actions just consumed their delay above

      currentAction++;
      await updateJobStore();
    }

    // All actions complete
    await updateJobStore({ status: "done", activity: "Done" });
    return NextResponse.json({ status: "done", charsSent });

  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Sync job ${jobId} error at action ${currentAction}:`, message);
    await updateJobStore({ status: "error", error: message, activity: "Error" });
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function selfChain(req: NextRequest, payload: SyncJobPayload) {
  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  try {
    fetch(`${origin}/api/sync/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Best effort — if this fails, the job stalls and client can restart
  }
}
