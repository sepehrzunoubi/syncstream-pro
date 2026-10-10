import { NextRequest, NextResponse } from "next/server";
import { getDocSnapshot, batchUpdate, deleteRange, refreshAccessToken } from "@/lib/google";
import { getStore } from "@/lib/sync-store";
import { getQStashReceiver, enqueueProcess } from "@/lib/qstash";
import { runJobWindow } from "@/lib/sync-runner";
import { internalToken, secretEquals } from "@/lib/secret";
import { withRoute } from "@/lib/route";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
// Each invocation works for at most ~20s before handing the job back to the
// queue, so this stays well inside every Vercel plan's function limit.
export const maxDuration = 60;

/**
 * Worker endpoint, called by QStash. Always answers 200 for a handled job so
 * QStash does not retry a delivery we already acted on; the job's own state
 * carries any error. Not rate limited: it is token-protected and internal.
 */
export const POST = withRoute(async (req: NextRequest) => {
  const receiver = getQStashReceiver();
  const rawBody = await req.text();

  if (receiver) {
    const signature = req.headers.get("upstash-signature") || "";
    try {
      await receiver.verify({ signature, body: rawBody });
    } catch {
      log.warn("sync.process_unauthorized", { via: "qstash" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (!secretEquals(req.headers.get("x-syncstream-internal"), internalToken())) {
    // Without QStash the server calls itself with a secret derived from its own configuration
    log.warn("sync.process_unauthorized", { via: "internal" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let jobId: string | undefined;
  let generation: number | undefined;
  let tick: number | undefined;
  try {
    const parsed = JSON.parse(rawBody) as { jobId?: string; generation?: number; tick?: number };
    jobId = parsed.jobId;
    generation = typeof parsed.generation === "number" ? parsed.generation : undefined;
    tick = typeof parsed.tick === "number" ? parsed.tick : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

  const result = await runJobWindow(jobId, generation, {
    store: getStore(),
    docs: { snapshot: getDocSnapshot, batch: batchUpdate, deleteRange },
    refresh: (refreshToken) => refreshAccessToken(refreshToken),
    enqueue: (id, gen, delaySec, t) => enqueueProcess(id, gen, delaySec, t),
    tick,
  });

  return NextResponse.json({ outcome: result.outcome, currentAction: result.job?.currentAction });
});
