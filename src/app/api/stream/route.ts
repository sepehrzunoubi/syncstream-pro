import { NextRequest } from "next/server";
import {
  getDocEndIndex,
  insertAtIndex,
  deleteRange,
  refreshAccessToken,
} from "@/lib/google";
import {
  buildDripPlan,
  type PaceMode,
  type StreamEvent,
} from "@/lib/drip-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let token = req.cookies.get("google_access_token")?.value;
  const refreshToken = req.cookies.get("google_refresh_token")?.value;

  if (!token && !refreshToken) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Helper: attempt a Google API call, refresh token on 401 and retry once
  async function withTokenRefresh<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      return await fn(token!);
    } catch (err: unknown) {
      const status = (err as { code?: number })?.code ?? (err as { status?: number })?.status;
      if ((status === 401 || status === 403) && refreshToken) {
        const refreshed = await refreshAccessToken(refreshToken);
        if (refreshed) {
          token = refreshed.access_token;
          return await fn(token);
        }
      }
      throw err;
    }
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
    return new Response("Missing text or documentId", { status: 400 });
  }

  if (text.length > 1_000_000) {
    return new Response("Text exceeds maximum length (1M characters)", { status: 400 });
  }

  if (typeof durationMinutes !== "number" || durationMinutes < 1 || durationMinutes > 10080) {
    return new Response("Duration must be between 1 minute and 7 days", { status: 400 });
  }

  const clampedTypoFrequency = Math.max(0, Math.min(1, typoFrequency));
  const clampedPauseVariance = Math.max(0, Math.min(1, pauseVariance));

  const mode: PaceMode = rhythmKey === "burst" ? "burst" : "human";
  const plan = buildDripPlan(text, durationMinutes, mode, {
    typoFrequency: clampedTypoFrequency,
    pauseVariance: clampedPauseVariance,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let charsSent = 0;
      const totalChars = plan.totalChars;
      const totalActions = plan.actions.length;
      const startTime = Date.now();

      // Pre-compute remaining delay from each action index for accurate ETA
      const remainingDelayFromIndex: number[] = new Array(totalActions);
      let cumulative = 0;
      for (let j = totalActions - 1; j >= 0; j--) {
        cumulative += plan.actions[j].delayMs;
        remainingDelayFromIndex[j] = cumulative;
      }

      function calcWpm(): number {
        const elapsedMin = Math.max(0.05, (Date.now() - startTime) / 60_000);
        if (charsSent === 0) return 0;
        const words = charsSent / 5;
        return Math.round(words / elapsedMin);
      }

      function calcEta(actionIdx: number): number {
        // Remaining = sum of delays from current action onward (minus time already spent waiting)
        return actionIdx < totalActions ? remainingDelayFromIndex[actionIdx] : 0;
      }

      function emit(event: StreamEvent) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }

      // Wait for a delay, sending heartbeats every 15s during long waits
      async function waitWithHeartbeats(delayMs: number, actionIdx: number, activity: string) {
        const HEARTBEAT_INTERVAL = 15_000;
        if (delayMs <= HEARTBEAT_INTERVAL) {
          await new Promise((r) => setTimeout(r, delayMs));
          return;
        }
        let waited = 0;
        while (waited < delayMs) {
          const chunk = Math.min(HEARTBEAT_INTERVAL, delayMs - waited);
          await new Promise((r) => setTimeout(r, chunk));
          waited += chunk;
          if (waited < delayMs) {
            emit({
              type: "heartbeat",
              actionIndex: actionIdx,
              totalActions,
              charsSent,
              totalChars,
              nextDelayMs: delayMs - waited,
              eta: Math.max(0, calcEta(actionIdx) - waited),
              wpm: calcWpm(),
              activity,
              status: `Action ${actionIdx + 1}/${totalActions}`,
            });
          }
        }
      }

      for (let i = 0; i < totalActions; i++) {
        const action = plan.actions[i];

        // Wait for delay (with heartbeats for long pauses)
        // Skip pre-delay for typo actions — their delayMs is used internally for the correction pause
        if (action.delayMs > 0 && action.kind !== "typo") {
          await waitWithHeartbeats(action.delayMs, i, action.activity);
        }

        try {
          if (action.kind === "insert" && action.text.length > 0) {
            // Fetch fresh endIndex before each insert
            const endIdx = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
            await withTokenRefresh((t) => insertAtIndex(t, documentId, action.text, endIdx - 1));
            charsSent += action.text.length;

            emit({
              type: "progress",
              actionIndex: i,
              totalActions,
              charsSent,
              totalChars,
              nextDelayMs: i < totalActions - 1 ? plan.actions[i + 1].delayMs : 0,
              eta: i + 1 < totalActions ? calcEta(i + 1) : 0,
              wpm: calcWpm(),
              activity: action.activity,
              status: `Action ${i + 1}/${totalActions}`,
            });
          } else if (action.kind === "typo") {
            // Step 1: Insert wrong characters
            const endIdx = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
            const typoText = action.typoChars || "xxxxx";
            await withTokenRefresh((t) => insertAtIndex(t, documentId, typoText, endIdx - 1));

            emit({
              type: "heartbeat",
              actionIndex: i,
              totalActions,
              charsSent,
              totalChars,
              nextDelayMs: action.delayMs,
              eta: i + 1 < totalActions ? calcEta(i + 1) : 0,
              wpm: calcWpm(),
              activity: "Correcting typo\u2026",
              status: `Action ${i + 1}/${totalActions}`,
            });

            // Pause to simulate noticing the typo
            await new Promise((r) => setTimeout(r, action.delayMs));

            // Step 2: Delete the wrong characters
            const endIdx2 = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
            const deleteEnd = endIdx2 - 1;
            const deleteStart = Math.max(1, deleteEnd - typoText.length);
            if (deleteStart < deleteEnd) {
              await withTokenRefresh((t) => deleteRange(t, documentId, deleteStart, deleteEnd));
            }

            // Step 3: Insert the correct text
            if (action.text.length > 0) {
              const endIdx3 = await withTokenRefresh((t) => getDocEndIndex(t, documentId));
              await withTokenRefresh((t) => insertAtIndex(t, documentId, action.text, endIdx3 - 1));
              charsSent += action.text.length;
            }

            emit({
              type: "progress",
              actionIndex: i,
              totalActions,
              charsSent,
              totalChars,
              nextDelayMs: i < totalActions - 1 ? plan.actions[i + 1].delayMs : 0,
              eta: i + 1 < totalActions ? calcEta(i + 1) : 0,
              wpm: calcWpm(),
              activity: action.activity,
              status: `Action ${i + 1}/${totalActions}`,
            });
          } else if (action.kind === "pause" || action.kind === "heartbeat") {
            // Just send a heartbeat/status update
            emit({
              type: "heartbeat",
              actionIndex: i,
              totalActions,
              charsSent,
              totalChars,
              nextDelayMs: i < totalActions - 1 ? plan.actions[i + 1].delayMs : 0,
              eta: i + 1 < totalActions ? calcEta(i + 1) : 0,
              wpm: calcWpm(),
              activity: action.activity,
              status: `Action ${i + 1}/${totalActions}`,
            });
          }
        } catch (error) {
          emit({
            type: "error",
            actionIndex: i,
            totalActions,
            charsSent,
            totalChars,
            nextDelayMs: 0,
            eta: 0,
            wpm: calcWpm(),
            activity: "Error",
            status: "Error",
            error: error instanceof Error ? error.message : "Unknown error",
          });
          controller.close();
          return;
        }
      }

      // Final "done" event
      emit({
        type: "done",
        actionIndex: totalActions - 1,
        totalActions,
        charsSent,
        totalChars,
        nextDelayMs: 0,
        eta: 0,
        wpm: calcWpm(),
        activity: "Complete",
        status: "Complete",
      });

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
