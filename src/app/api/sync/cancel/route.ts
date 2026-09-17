import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse, mutateJob } from "@/lib/sync-api";
import { getStore, isTerminal } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;

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
  if (result.status === "cancelled") await getStore().removeActiveJob(job.id);
  return jobResponse(user, result);
}
