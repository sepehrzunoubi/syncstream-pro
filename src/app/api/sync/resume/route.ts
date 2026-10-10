import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse, mutateJob } from "@/lib/sync-api";
import { getStore } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { reportError } from "@/lib/monitor";
import { uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";

export const POST = withRoute(async (req: NextRequest) => {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  const limited = await rateLimited(req, "sync.control", { max: 60, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;

  const result = await mutateJob(job.id, (fresh) => {
    if (fresh.status !== "paused") {
      return NextResponse.json({ error: "Job is not paused" }, { status: 400 });
    }
    // A job paused before its scheduled start waits for that start again
    const notStarted = fresh.startAt > Date.now() && fresh.currentAction === 0 && !fresh.typoSubStep;
    return {
      ...fresh,
      status: notStarted ? "scheduled" : "running",
      activity: notStarted ? "Scheduled" : "Resuming",
      error: undefined,
      pausedAt: undefined,
      nextActionAt: undefined,
      lastDueAt: undefined,
      generation: fresh.generation + 1,
      failures: 0,
      quotaWaits: 0,
      // Fresh tokens from this browser, in case they were refreshed since the job started
      accessToken: req.cookies.get(ACCESS_COOKIE)?.value || user.accessToken || fresh.accessToken,
      refreshToken: req.cookies.get(REFRESH_COOKIE)?.value || fresh.refreshToken,
    };
  });
  if (result instanceof NextResponse) return result;

  await getStore().addActiveJob(job.id);
  try {
    await enqueueProcess(job.id, result.generation, result.status === "scheduled" ? Math.max(0, Math.ceil((result.startAt - Date.now()) / 1000)) : 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportError(err, { event: "sync.resume_failed", route: "/api/sync/resume", method: "POST", uid: uidTag(user.userId), jobId: job.id });
    return NextResponse.json({ error: `Failed to resume: ${message}` }, { status: 500 });
  }
  return jobResponse(user, result);
});
