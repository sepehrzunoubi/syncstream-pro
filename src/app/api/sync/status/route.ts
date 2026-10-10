import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse } from "@/lib/sync-api";
import { jobToEvent } from "@/lib/sync-store";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (req: NextRequest) => {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  const limited = await rateLimited(req, "sync.read", { max: 240, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  return jobResponse(user, job, { jobStatus: job.status, event: jobToEvent(job), now: Date.now() });
});
