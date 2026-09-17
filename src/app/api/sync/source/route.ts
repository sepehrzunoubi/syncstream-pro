import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId } from "@/lib/sync-api";
import { applyAuthCookies } from "@/lib/auth";
import { getStore } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

/** The original source text of a job, rebuilt from its plan. */
export async function GET(req: NextRequest) {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;

  const plan = await getStore().getPlan(job.id);
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  let sourceText = "";
  for (const action of plan.actions) {
    if (action.kind !== "pause") sourceText += action.text;
  }
  return applyAuthCookies(NextResponse.json({ sourceText, breaks: plan.breaks, totalMs: plan.totalMs }), user);
}
