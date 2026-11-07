import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse, mutateJob } from "@/lib/sync-api";
import { withRoute } from "@/lib/route";
import { waitLeft } from "@/lib/sync-runner";
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
      // Resuming goes on with what was left of the current wait (a break keeps its time left)
      return { ...fresh, status: "paused", activity: "Paused", pausedAt: now, nextActionAt: undefined, waitLeftMs: waitLeft(fresh, now) };
    },
    "pause"
  );
  if (result instanceof NextResponse) return result;
  return jobResponse(user, result);
});
