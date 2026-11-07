import { NextRequest, NextResponse } from "next/server";
import { jobResponse, loadOwnedJob } from "@/lib/sync-api";
import { getStore } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";
import { changeBreaks, parseBreakEdit } from "@/lib/live-breaks";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { tooLarge } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Change the breaks still ahead of a sync: `breaks` is every break after what it is typing now,
 * [{ at, minutes }]; `current` ends the break it is on ({ end: true }) or gives it another length
 * ({ minutes }); `version` is the job's breaksVersion the change was made against.
 */
export const POST = withRoute(async (req: NextRequest) => {
  const big = tooLarge(req, 100_000);
  if (big) return big;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const loaded = await loadOwnedJob(req, typeof body.jobId === "string" ? body.jobId : null);
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  const limited = await rateLimited(req, "sync.breaks", { max: 120, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;

  const plan = await getStore().getPlan(job.id);
  if (!plan) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  let source = "";
  for (const a of plan.actions) if (a.kind !== "pause") source += a.text;
  const ends = (plan.segments ?? []).map((s) => s.end);
  const parsed = parseBreakEdit(body, source, ends);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = await changeBreaks(job.id, parsed.edit, { store: getStore(), enqueue: enqueueProcess });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.job ? { breaksVersion: result.job.breaksVersion ?? 0 } : {}) }, { status: result.status });
  }
  return jobResponse(user, result.job, { applied: result.applied });
});
