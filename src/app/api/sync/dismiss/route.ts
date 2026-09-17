import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId } from "@/lib/sync-api";
import { applyAuthCookies } from "@/lib/auth";
import { getStore, isTerminal } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

/** Remove a finished job from the user's list (and free its storage). */
export async function POST(req: NextRequest) {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;

  if (!isTerminal(job.status)) {
    return NextResponse.json({ error: "Cancel the job before dismissing it" }, { status: 400 });
  }
  const store = getStore();
  await store.removeUserJob(user.userId, job.id);
  await store.removeActiveJob(job.id);
  await store.deleteJob(job.id);
  return applyAuthCookies(NextResponse.json({ ok: true }), user);
}
