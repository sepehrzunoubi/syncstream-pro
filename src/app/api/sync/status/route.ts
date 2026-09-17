import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse } from "@/lib/sync-api";
import { jobToEvent } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  return jobResponse(user, job, { jobStatus: job.status, event: jobToEvent(job), now: Date.now() });
}
