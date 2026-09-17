import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse, mutateJob } from "@/lib/sync-api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;

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
}
