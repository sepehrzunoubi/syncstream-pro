import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse, mutateJob } from "@/lib/sync-api";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const POST = withRoute(async (req: NextRequest) => {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  const limited = await rateLimited(req, "sync.control", { max: 60, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;

  const result = await mutateJob(
    job.id,
    (fresh) => {
      if (fresh.status !== "running" && fresh.status !== "pending" && fresh.status !== "scheduled") {
        return NextResponse.json({ error: `Job is ${fresh.status}, not running` }, { status: 400 });
      }
      const now = Date.now();
      // The current action restarts its full wait on resume.
      return { ...fresh, status: "paused", activity: "Paused", pausedAt: now, nextActionAt: undefined };
    },
    "pause"
  );
  if (result instanceof NextResponse) return result;
  return jobResponse(user, result);
});
