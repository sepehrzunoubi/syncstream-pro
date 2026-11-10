import { NextRequest, NextResponse } from "next/server";
import { applyAuthCookies, resolveUser, unauthorized } from "@/lib/auth";
import { getStore, historyOf, MAX_HISTORY, type HistoryEntry } from "@/lib/sync-store";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The signed-in person's sync history, newest first: every sync they started, on any device, kept
 * after the sync itself has expired or been removed from the list. A sync that still exists shows
 * as it is now; `live` says so (it can be opened and followed).
 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "history.read", { max: 60, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const store = getStore();
  const [stored, ids] = await Promise.all([store.listHistory(user.userId), store.listUserJobIds(user.userId)]);
  const byId = new Map<string, HistoryEntry & { live?: boolean }>(stored.map((e) => [e.id, e]));
  const jobs = await Promise.all(ids.map((id) => store.getJob(id)));
  for (const job of jobs) if (job && job.userId === user.userId) byId.set(job.id, { ...historyOf(job), live: true });
  const entries = Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
  // The oldest make room once there are too many
  if (stored.length > MAX_HISTORY) {
    const keep = new Set(entries.slice(0, MAX_HISTORY).map((e) => e.id));
    await store.removeHistory(user.userId, stored.filter((e) => !keep.has(e.id)).map((e) => e.id)).catch(() => {});
  }
  return applyAuthCookies(NextResponse.json({ entries: entries.slice(0, MAX_HISTORY), now: Date.now() }), user);
});

/** Forget one sync ({ id }) or the whole history ({ all: true }). Syncs still running are untouched. */
export const DELETE = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "history.write", { max: 30, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; all?: unknown };
  const store = getStore();
  if (body.all === true) await store.removeHistory(user.userId);
  else if (typeof body.id === "string" && body.id.length <= 100) await store.removeHistory(user.userId, [body.id]);
  else return NextResponse.json({ error: "Missing id" }, { status: 400 });
  return applyAuthCookies(NextResponse.json({ ok: true }), user);
});
