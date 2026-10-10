import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse, mutateJob } from "@/lib/sync-api";
import { getStore, isTerminal } from "@/lib/sync-store";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const POST = withRoute(async (req: NextRequest) => {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  const limited = await rateLimited(req, "sync.control", { max: 60, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;

  if (isTerminal(job.status)) return jobResponse(user, job);

  const result = await mutateJob(
    job.id,
    (fresh) => {
      if (isTerminal(fresh.status)) return fresh;
      return { ...fresh, status: "cancelled", activity: "Cancelled", finishedAt: Date.now(), nextActionAt: undefined };
    },
    "cancel"
  );
  if (result instanceof NextResponse) return result;
  // Only a cancel that was applied leaves the active set; an intent is applied by the worker
  if (result.status === "cancelled" && result.activity === "Cancelled") await getStore().removeActiveJob(job.id);
  return jobResponse(user, result);
});
