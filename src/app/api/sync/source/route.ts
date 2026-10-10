import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId } from "@/lib/sync-api";
import { applyAuthCookies } from "@/lib/auth";
import { getStore } from "@/lib/sync-store";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The original source text of a job, rebuilt from its plan. */
export const GET = withRoute(async (req: NextRequest) => {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  const limited = await rateLimited(req, "sync.read", { max: 240, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;

  const plan = await getStore().getPlan(job.id);
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  let sourceText = "";
  for (const action of plan.actions) {
    if (action.kind !== "pause") sourceText += action.text;
  }
  const context = await getStore().getContext(job.id);
  return applyAuthCookies(NextResponse.json({ sourceText, format: plan.format ?? null, context, breaks: plan.breaks, totalMs: plan.totalMs }), user);
});
