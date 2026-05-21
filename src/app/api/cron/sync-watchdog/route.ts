import { NextRequest, NextResponse } from "next/server";
import { getActiveJobIds, getJob, removeActiveJob } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";

export const dynamic = "force-dynamic";

// Stall threshold: if a running job hasn't updated in this long, re-kick it.
// Must be longer than the process route's maxDuration (300s) + safety margin
// so we don't re-kick a healthy chain that's simply mid-invocation.
const STALL_THRESHOLD_MS = 5 * 60 * 1000 + 60_000; // 6 minutes

/**
 * Cron watchdog — runs every 2 minutes via Vercel Cron.
 * Scans the active-jobs set for stalled or terminal jobs and takes action:
 * - Stalled "running" jobs → re-kick via QStash
 * - Terminal jobs (done/error/cancelled) → remove from active set
 */
export async function GET(req: NextRequest) {
  // Verify this is a legitimate cron invocation (Vercel sets this header)
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobIds = await getActiveJobIds();

  let restarted = 0;
  let cleaned = 0;

  for (const jobId of jobIds) {
    const job = await getJob(jobId);

    if (!job) {
      // Job expired from Redis — clean up the active set entry
      await removeActiveJob(jobId);
      cleaned++;
      continue;
    }

    const isTerminal = job.status === "done" || job.status === "error" || job.status === "cancelled";

    if (isTerminal) {
      await removeActiveJob(jobId);
      cleaned++;
      continue;
    }

    // Only re-kick running jobs (not paused — paused jobs wait for user to resume)
    if (job.status !== "running" && job.status !== "pending") {
      continue;
    }

    const staleness = Date.now() - (job.lastUpdate ?? 0);

    if (staleness > STALL_THRESHOLD_MS) {
      console.warn(
        `[sync-watchdog] Job ${jobId} stalled (${Math.round(staleness / 1000)}s since last update) — re-kicking`
      );
      await enqueueProcess(jobId);
      restarted++;
    }
  }

  return NextResponse.json({
    scanned: jobIds.length,
    restarted,
    cleaned,
  });
}
