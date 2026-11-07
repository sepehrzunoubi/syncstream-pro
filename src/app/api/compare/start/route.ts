import { NextRequest, NextResponse } from "next/server";
import { batchUpdateWithReplies, createTab, getRawDocument, renameTab } from "@/lib/google";
import { importImageFromUrl } from "@/lib/image-store";
import { buildCompareJob, COMPARE_CHANGED, CompareChangedError, prepareCompare, type CompareGoogle } from "@/lib/compare-server";
import type { CompareBreak, CompareStartBody } from "@/lib/compare-types";
import { createJobId, getStore, hasRedis, isTerminal, toPublicJob } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";
import { getBaseUrl } from "@/lib/base-url";
import { MAX_TARGET_MINUTES, MIN_TARGET_MINUTES } from "@/lib/drip-engine";
import { applyAuthCookies, googleStatus, resolveUser, tooLarge, unauthorized, withGoogleToken } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, startTimer, uidTag } from "@/lib/log";
import { reportError } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;
const CHANGED = COMPARE_CHANGED;

const isDocId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(v);

function parseBreaks(raw: unknown): CompareBreak[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 200) return null;
  const out: CompareBreak[] = [];
  for (const b of raw as Record<string, unknown>[]) {
    if (!b || typeof b.rightTabId !== "string" || !Number.isInteger(b.rightToken) || typeof b.minutes !== "number" || !Number.isFinite(b.minutes)) return null;
    out.push({ rightTabId: b.rightTabId, rightToken: b.rightToken as number, minutes: b.minutes });
  }
  return out;
}

/**
 * Start a Compare & Sync: read both documents again (a change since the review gives 409), set up
 * what the sync can't type, and start one sync that types the rest, tab by tab, top to bottom.
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "sync.start", { max: 10, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  if (process.env.VERCEL && !hasRedis()) return NextResponse.json({ error: "Upstash Redis is not configured." }, { status: 500 });
  const big = tooLarge(req, 200_000);
  if (big) return big;
  const done = startTimer();
  let body: Partial<CompareStartBody>;
  try { body = (await req.json()) as Partial<CompareStartBody>; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { leftId, rightId } = body;
  if (!isDocId(leftId) || !isDocId(rightId)) return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  if (leftId === rightId) return NextResponse.json({ error: "Pick two different documents to compare." }, { status: 400 });
  if (typeof body.leftRevision !== "string" || typeof body.rightRevision !== "string") return NextResponse.json({ error: "Missing revisions" }, { status: 400 });
  const skip = Array.isArray(body.skip) ? body.skip.filter((x): x is string => typeof x === "string").slice(0, 5000) : [];
  const breaksMode = body.breaksMode === "none" || body.breaksMode === "manual" ? body.breaksMode : "auto";
  const manualBreaks = breaksMode === "manual" ? parseBreaks(body.breaks) : [];
  if (!manualBreaks) return NextResponse.json({ error: "Invalid breaks" }, { status: 400 });
  let targetMinutes: number | null = null;
  if (breaksMode !== "manual" && body.targetMinutes != null) {
    const m = body.targetMinutes;
    if (typeof m !== "number" || !Number.isFinite(m) || m < MIN_TARGET_MINUTES || m > MAX_TARGET_MINUTES) return NextResponse.json({ error: "Duration must be between 1 minute and 7 days" }, { status: 400 });
    targetMinutes = m;
  }
  const typoFrequency = typeof body.typoFrequency === "number" ? Math.max(0, Math.min(1, body.typoFrequency)) : 0.5;
  const seed = typeof body.seed === "number" && Number.isInteger(body.seed) && body.seed >= 0 ? body.seed >>> 0 : undefined;
  const startInMinutes = typeof body.startInMinutes === "number" && Number.isFinite(body.startInMinutes) ? Math.max(0, Math.min(MAX_SCHEDULE_MINUTES, body.startInMinutes)) : 0;

  // One sync at a time per document: a second would fight the first over every write
  const store = getStore();
  const ids = await store.listUserJobIds(user.userId).catch(() => [] as string[]);
  const mine = await Promise.all(ids.map((id) => store.getJob(id).catch(() => null)));
  if (mine.some((j) => j && j.documentId === leftId && !isTerminal(j.status))) {
    return NextResponse.json({ error: "A sync is already typing into your document. Wait for it to finish, or cancel it, first.", code: "busy" }, { status: 409 });
  }

  try {
    const prepared = await withGoogleToken(user, async (token) => {
      const g: CompareGoogle = {
        read: (id) => getRawDocument(token, id),
        batch: async (id, requests, tabId) => (await batchUpdateWithReplies(token, id, requests, { tabId })) ?? [],
        createTab: (id, props) => createTab(token, id, props),
        renameTab: (id, tabId, title) => renameTab(token, id, tabId, title),
        rehost: async (url) => (await importImageFromUrl(url, { baseUrl: getBaseUrl(req), accessToken: token }))?.url ?? null,
      };
      return prepareCompare(g, { leftId, rightId, leftRevision: body.leftRevision!, rightRevision: body.rightRevision!, tabMap: body.tabMap, skip, breaks: manualBreaks });
    });
    const now = Date.now();
    const id = createJobId();
    const built = buildCompareJob(prepared, {
      id,
      userId: user.userId,
      documentId: leftId,
      documentName: typeof body.documentName === "string" ? body.documentName : "",
      breaksMode,
      targetMinutes,
      typoFrequency,
      seed,
      startInMinutes,
      now,
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
    });
    if (!built.ok) return NextResponse.json({ error: built.error, ...(built.code ? { code: built.code } : {}) }, { status: built.status });
    const { plan: syncPlan, job, context } = built;
    try {
      await store.setPlan(syncPlan);
      if (context) await store.setContext(id, context);
      await store.setJob(job);
      await store.addUserJob(user.userId, id);
      await store.addActiveJob(id);
      await enqueueProcess(id, 0, Math.ceil(startInMinutes * 60));
    } catch (err) {
      await reportError(err, { event: "compare.start_failed", route: "/api/compare/start", method: "POST", uid: uidTag(user.userId), jobId: id, ms: done() });
      await store.deleteJob(id).catch(() => {});
      await store.removeUserJob(user.userId, id).catch(() => {});
      await store.removeActiveJob(id).catch(() => {});
      return NextResponse.json({ error: "Couldn't start the sync. Try again." }, { status: 500 });
    }
    log.info("compare.start", { job: id, uid: uidTag(user.userId), tabs: prepared.tabs.length, segments: syncPlan.segments?.length ?? 0, chars: syncPlan.totalChars, droppedImages: prepared.droppedImages, ms: done() });
    return applyAuthCookies(NextResponse.json({ job: toPublicJob(job), totalMs: syncPlan.totalMs, droppedImages: prepared.droppedImages }), user);
  } catch (error) {
    if (error instanceof CompareChangedError) return NextResponse.json({ error: CHANGED, code: "changed" }, { status: 409 });
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    if (status === 403) return NextResponse.json({ error: "SyncStream isn't allowed to edit your document. Check that your Google account can edit it." }, { status: 403 });
    if (status === 404) return NextResponse.json({ error: "One of the documents can't be found anymore." }, { status: 404 });
    await reportError(error, { event: "compare.start_failed", route: "/api/compare/start", method: "POST", uid: uidTag(user.userId), ms: done() });
    return NextResponse.json({ error: "Couldn't start the sync. Try again." }, { status: 502 });
  }
});
