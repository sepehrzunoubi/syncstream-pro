import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId } from "@/lib/sync-api";
import { applyAuthCookies } from "@/lib/auth";
import { getStore, isTerminal } from "@/lib/sync-store";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Remove a finished job from the user's list (and free its storage). */
export const POST = withRoute(async (req: NextRequest) => {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  const limited = await rateLimited(req, "sync.control", { max: 60, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;

  if (!isTerminal(job.status)) {
    return NextResponse.json({ error: "Cancel the job before dismissing it" }, { status: 400 });
  }
  const store = getStore();
  await store.removeUserJob(user.userId, job.id);
  await store.removeActiveJob(job.id);
  await store.deleteJob(job.id);
  return applyAuthCookies(NextResponse.json({ ok: true }), user);
});
