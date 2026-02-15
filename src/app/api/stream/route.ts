import { NextRequest } from "next/server";
import {
  getDocEndIndex,
  insertAtIndex,
  deleteRange,
} from "@/lib/google";
import {
  buildDripPlan,
  type PaceMode,
  type StreamEvent,
} from "@/lib/drip-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;

  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await req.json();
  const {
    text,
    documentId,
    rhythm: rhythmKey = "human",
    durationMinutes = 30,
  } = body as {
    text: string;
    documentId: string;
    rhythm: string;
    durationMinutes: number;
  };

  if (!text || !documentId) {
    return new Response("Missing text or documentId", { status: 400 });
  }

  const mode: PaceMode = rhythmKey === "longform" ? "longform" : "human";
  const plan = buildDripPlan(text, durationMinutes, mode);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let charsSent = 0;
      const totalChars = plan.totalChars;
      const totalActions = plan.actions.length;
      const startTime = Date.now();
      const durationMs = durationMinutes * 60 * 1000;

      function calcWpm(): number {
        const elapsedMin = (Date.now() - startTime) / 60_000;
        if (elapsedMin < 0.05) return 0;
        const words = charsSent / 5; // standard 5 chars per word
        return Math.round(words / elapsedMin);
      }

      function emit(event: StreamEvent) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }

      for (let i = 0; i < totalActions; i++) {
        const action = plan.actions[i];

        // Wait for delay
        if (action.delayMs > 0) {
          await new Promise((r) => setTimeout(r, action.delayMs));
        }

        try {
          if (action.kind === "insert" && action.text.length > 0) {
            // Fetch fresh endIndex before each insert
            const endIdx = await getDocEndIndex(token, documentId);
            await insertAtIndex(token, documentId, action.text, endIdx - 1);
            charsSent += action.text.length;

            emit({
              type: "progress",
              actionIndex: i,
              totalActions,
              charsSent,
              totalChars,
              nextDelayMs: i < totalActions - 1 ? plan.actions[i + 1].delayMs : 0,
              eta: Math.max(0, durationMs - (Date.now() - startTime)),
              wpm: calcWpm(),
              activity: action.activity,
              status: `Action ${i + 1}/${totalActions}`,
            });
          } else if (action.kind === "typo") {
            // Step 1: Insert wrong characters
            const endIdx = await getDocEndIndex(token, documentId);
            const typoText = action.typoChars || "xxxxx";
            await insertAtIndex(token, documentId, typoText, endIdx - 1);

            emit({
              type: "heartbeat",
              actionIndex: i,
              totalActions,
              charsSent,
              totalChars,
              nextDelayMs: action.delayMs,
              eta: Math.max(0, durationMs - (Date.now() - startTime)),
              wpm: calcWpm(),
              activity: "Correcting typo\u2026",
              status: `Action ${i + 1}/${totalActions}`,
            });

            // Pause to simulate noticing the typo
            await new Promise((r) => setTimeout(r, action.delayMs));

            // Step 2: Delete the wrong characters
            const endIdx2 = await getDocEndIndex(token, documentId);
            const deleteStart = endIdx2 - 1 - typoText.length;
            const deleteEnd = endIdx2 - 1;
            if (deleteStart >= 1 && deleteEnd > deleteStart) {
              await deleteRange(token, documentId, deleteStart, deleteEnd);
            }

            // Step 3: Insert the correct text
            if (action.text.length > 0) {
              const endIdx3 = await getDocEndIndex(token, documentId);
              await insertAtIndex(token, documentId, action.text, endIdx3 - 1);
              charsSent += action.text.length;
            }

            emit({
              type: "progress",
              actionIndex: i,
              totalActions,
              charsSent,
              totalChars,
              nextDelayMs: i < totalActions - 1 ? plan.actions[i + 1].delayMs : 0,
              eta: Math.max(0, durationMs - (Date.now() - startTime)),
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
              eta: Math.max(0, durationMs - (Date.now() - startTime)),
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
