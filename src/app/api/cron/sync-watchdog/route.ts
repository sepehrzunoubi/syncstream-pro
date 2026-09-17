import { NextRequest, NextResponse } from "next/server";
import { getStore, isTerminal } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";

export const dynamic = "force-dynamic";

// A job is considered stuck when nothing has touched it for this long AND
// it is not simply waiting for a queued delivery that is still in the future.
const STALL_MS = 10 * 60 * 1000;
const LATE_MS = 2 * 60 * 1000;

/**
 * Safety net for jobs whose queue message was lost. The runner already
 * recovers from crashes on its own (lock expiry + re-kick), so this only
 * needs to run occasionally.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const store = getStore();
  const ids = await store.getActiveJobIds();
  const now = Date.now();
  let restarted = 0;
  let cleaned = 0;

  for (const id of ids) {
    const job = await store.getJob(id);
    if (!job || isTerminal(job.status)) {
      await store.removeActiveJob(id);
      cleaned++;
      continue;
    }
    if (job.status === "paused") continue;

    const idle = now - (job.lastUpdate ?? 0);
    const dueAt = job.status === "scheduled" ? job.startAt : job.nextActionAt ?? job.lastUpdate;
    const overdue = now - dueAt;
    if (idle > STALL_MS && overdue > LATE_MS) {
      if (await store.tryScheduleKick(id, 120)) {
        console.warn(`[sync-watchdog] job ${id} looks stuck (${Math.round(idle / 1000)}s idle) — re-kicking`);
        await enqueueProcess(id, job.generation, 0).catch((err) => console.error("[sync-watchdog] enqueue failed", err));
        restarted++;
      }
    }
  }

  return NextResponse.json({ scanned: ids.length, restarted, cleaned });
}
