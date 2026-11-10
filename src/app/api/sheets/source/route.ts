import { NextRequest, NextResponse } from "next/server";
import { loadOwnedJob, readJobId } from "@/lib/sync-api";
import { applyAuthCookies } from "@/lib/auth";
import { getStore } from "@/lib/sync-store";
import { jsonReply } from "@/lib/json-response";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** What a spreadsheet sync is building: its workbook and steps, for the page that follows it live */
export const GET = withRoute(async (req: NextRequest) => {
  const loaded = await loadOwnedJob(req, await readJobId(req));
  if (loaded instanceof NextResponse) return loaded;
  const { user, job } = loaded;
  const limited = await rateLimited(req, "sync.read", { max: 240, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const plan = await getStore().getPlan(job.id);
  if (!plan?.sheet) return NextResponse.json({ error: "This sync's spreadsheet is no longer stored." }, { status: 404 });
  const { workbook, steps, units, sections, baseline } = plan.sheet;
  return applyAuthCookies(jsonReply(req, { workbook, steps, units, sections, ...(baseline ? { baseline } : {}), delays: plan.actions.map((a) => a.delayMs), totalMs: plan.totalMs }), user);
});
