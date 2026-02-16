import { NextRequest, NextResponse } from "next/server";
import {
  getDocEndIndex,
  insertAtIndex,
  deleteRange,
  refreshAccessToken,
} from "@/lib/google";
import { getJob, setJob, type SyncJob, type SyncJobPayload } from "@/lib/sync-store";

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

  const totalActions = actions.length;

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
      // Check cancellation
      const check = await getJob(jobId);
      if (check && (check.status === "cancelled" || check.status === "paused")) {
        return NextResponse.json({ status: check.status });
      }

      // Check if we need to self-chain before timeout
      const elapsed = Date.now() - invocationStart;
      if (elapsed > (maxDuration * 1000) - SAFETY_MARGIN_MS) {
        // Save state and self-chain
        await updateJobStore({ activity: "Chaining…" });
        await selfChain(req, {
          jobId, accessToken, refreshToken, documentId,
          actions, currentAction, charsSent, totalChars, totalMinutes, startTime,
        });
        return NextResponse.json({ status: "chained", currentAction });
      }

      const action = actions[currentAction];

      // Wait for delay (skip pre-delay for typo actions)
      if (action.delayMs > 0 && action.kind !== "typo") {
        // Split long delays into chunks to check for cancellation
        let remaining = action.delayMs;
        while (remaining > 0) {
          const chunk = Math.min(remaining, 5000); // check every 5s
          await sleep(chunk);
          remaining -= chunk;

          // Check cancellation during long waits
          const mid = await getJob(jobId);
          if (mid && (mid.status === "cancelled" || mid.status === "paused")) {
            return NextResponse.json({ status: mid.status });
          }

          // Check timeout during long waits
          const midElapsed = Date.now() - invocationStart;
          if (midElapsed > (maxDuration * 1000) - SAFETY_MARGIN_MS) {
            await updateJobStore({ activity: "Chaining…" });
            await selfChain(req, {
              jobId, accessToken, refreshToken, documentId,
              actions, currentAction, charsSent, totalChars, totalMinutes, startTime,
            });
            return NextResponse.json({ status: "chained", currentAction });
          }

          await updateJobStore({ activity: action.activity });
        }
      }

      // Execute the action
      if (action.kind === "insert" && action.text.length > 0) {
        const endIdx = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
        await withTokenRefresh((t) => insertAtIndex(t, documentId, action.text, endIdx - 1));
        charsSent += action.text.length;
        await updateJobStore({ activity: "Typing…" });

      } else if (action.kind === "typo") {
        // Step 1: Insert wrong characters
        const endIdx = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
        const typoText = action.typoChars || "xxxxx";
        await withTokenRefresh((t) => insertAtIndex(t, documentId, typoText, endIdx - 1));

        await updateJobStore({ activity: "Correcting typo…" });

        // Step 2: Pause to simulate noticing the typo
        await sleep(action.delayMs);

        // Step 3: Delete the wrong characters
        const endIdx2 = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
        const deleteEnd = endIdx2 - 1;
        const deleteStart = Math.max(1, deleteEnd - typoText.length);
        if (deleteStart < deleteEnd) {
          await withTokenRefresh((t) => deleteRange(t, documentId, deleteStart, deleteEnd));
        }

        // Step 4: Insert correct text
        if (action.text.length > 0) {
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
