import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId, jobResponse, mutateJob } from "@/lib/sync-api";
import { getStore } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;

  const result = await mutateJob(job.id, (fresh) => {
    if (fresh.status !== "paused") {
      return NextResponse.json({ error: "Job is not paused" }, { status: 400 });
    }
    return {
      ...fresh,
      status: "running",
      activity: "Resuming…",
      pausedAt: undefined,
      nextActionAt: undefined,
      generation: fresh.generation + 1,
      failures: 0,
      // Fresh tokens from this browser, in case they were refreshed since the job started
      accessToken: req.cookies.get(ACCESS_COOKIE)?.value || user.accessToken || fresh.accessToken,
      refreshToken: req.cookies.get(REFRESH_COOKIE)?.value || fresh.refreshToken,
    };
  });
  if (result instanceof NextResponse) return result;

  await getStore().addActiveJob(job.id);
  try {
    await enqueueProcess(job.id, result.generation, 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to resume: ${message}` }, { status: 500 });
  }
  return jobResponse(user, result);
}
