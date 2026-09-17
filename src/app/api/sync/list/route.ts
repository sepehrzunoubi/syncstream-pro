import { NextRequest, NextResponse } from "next/server";
import { applyAuthCookies, resolveUser, unauthorized } from "@/lib/auth";
import { getStore, toPublicJob } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

/** All of the signed-in user's jobs, newest first. Vanished ids are pruned. */
export async function GET(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const store = getStore();
  const ids = await store.listUserJobIds(user.userId);
  const jobs = await Promise.all(ids.map((id) => store.getJob(id)));
  const result = [];
  for (let i = 0; i < ids.length; i++) {
    const job = jobs[i];
    if (!job) {
      await store.removeUserJob(user.userId, ids[i]).catch(() => {});
      continue;
    }
    result.push(toPublicJob(job));
  }
  result.sort((a, b) => b.createdAt - a.createdAt);
  return applyAuthCookies(NextResponse.json({ jobs: result, now: Date.now() }), user);
}
