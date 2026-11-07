import { NextRequest, NextResponse } from "next/server";
import { batchUpdateWithReplies, createTab, getRawDocument, renameTab, snapshotOf } from "@/lib/google";
import { openTab } from "@/lib/doc-tabs";
import { importImageFromUrl } from "@/lib/image-store";
import { CompareChangedError, prepareCompare, type CompareGoogle } from "@/lib/compare-server";
import type { CompareBreak, CompareStartBody } from "@/lib/compare-types";
import { createJobId, getStore, hasRedis, isTerminal, toPublicJob, type SyncContext } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";
import { buildSyncRecords, parseSegments, segmentBoundaries, spotsForTabs, type SegmentInput } from "@/lib/sync-plan";
import { buildDripPlan, MAX_TARGET_MINUTES, MIN_TARGET_MINUTES } from "@/lib/drip-engine";
import { parseAnchors, withAnchors } from "@/lib/breaks";
import { applyAuthCookies, googleStatus, resolveUser, tooLarge, unauthorized, withGoogleToken } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, startTimer, uidTag } from "@/lib/log";
import { reportError } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A compare sync may type into many places in many tabs */
const MAX_COMPARE_SEGMENTS = 2000;
const MAX_CONTEXT_JSON = 900_000;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;
const CHANGED = "One of the documents changed since you compared them. Here's the comparison again.";

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
        rehost: async (url) => (await importImageFromUrl(url))?.url ?? null,
      };
      return prepareCompare(g, { leftId, rightId, leftRevision: body.leftRevision!, rightRevision: body.rightRevision!, tabMap: body.tabMap, skip, breaks: manualBreaks });
    });
    if (!prepared.tabs.length) return NextResponse.json({ error: "Your document already has everything in the reference.", code: "nothing" }, { status: 400 });

    // The additions, tab by tab, as one source; manual breaks moved to their place in it
    const raw: SegmentInput[] = [];
    const anchors: { at: number; minutes: number }[] = [];
    let offset = 0;
    for (const t of prepared.tabs) {
      for (const a of t.anchors) anchors.push({ at: a.at + offset, minutes: a.minutes });
      for (const s of t.segments) {
        raw.push({ at: s.at, mode: s.mode, text: s.text, format: s.format, tabId: t.tabId });
        offset += s.text.length;
      }
    }
    const parsed = parseSegments(raw, { maxSegments: MAX_COMPARE_SEGMENTS });
    if (!parsed.ok) return NextResponse.json({ error: `This comparison can't be typed: ${parsed.error}` }, { status: 400 });
    const segments = parsed.segments;
    const text = segments.map((s) => s.text).join("");
    if (!text.trim()) return NextResponse.json({ error: "Your document already has everything in the reference.", code: "nothing" }, { status: 400 });
    if (text.length > MAX_TEXT_CHARS) return NextResponse.json({ error: `That's more than ${MAX_TEXT_CHARS.toLocaleString()} characters to copy in one sync.` }, { status: 400 });
    const boundaries = segmentBoundaries(segments);
    let anchorList = null;
    if (breaksMode === "manual" && anchors.length) {
      const a = parseAnchors(anchors, text, { ends: boundaries });
      if (!a.ok) return NextResponse.json({ error: a.error }, { status: 400 });
      anchorList = a.anchors;
    }
    const drip = buildDripPlan(text, { targetMinutes: breaksMode === "manual" ? null : targetMinutes, breaks: breaksMode === "auto" ? "auto" : [], typoFrequency, seed, ...(boundaries.length ? { boundaries } : {}) });
    const plan = anchorList ? withAnchors(drip, anchorList) : drip;
    if (!plan.actions.length) return NextResponse.json({ error: "Nothing to type" }, { status: 400 });

    const spots = spotsForTabs(prepared.leftDoc, segments);
    if (!spots) return NextResponse.json({ error: CHANGED, code: "changed" }, { status: 409 });
    let baselineWordCount = 0;
    for (const t of prepared.tabs) {
      const open = openTab(prepared.leftDoc, t.tabId);
      if (open) baselineWordCount += snapshotOf(open.doc).wordCount;
    }

    // What the running view shows: each tab as it will be, with where each segment's text came from
    let first = 0;
    const tabs = prepared.tabs.map((t) => {
      const entry = { tabId: t.tabId, title: t.title, first, doc: t.target, ranges: t.segments.map((s) => s.tokens) };
      first += t.segments.length;
      return entry;
    });
    const lead = tabs[0];
    let context: SyncContext | null = { doc: lead.doc, ranges: lead.ranges, tabs };
    if (JSON.stringify(context).length > MAX_CONTEXT_JSON) context = null;

    const now = Date.now();
    const id = createJobId();
    const { plan: syncPlan, job } = buildSyncRecords({
      id,
      userId: user.userId,
      documentId: leftId,
      documentName: (prepared.leftDoc.title || (typeof body.documentName === "string" ? body.documentName : "") || "Untitled document").trim().slice(0, 200),
      tab: { id: lead.tabId, title: prepared.tabs.length > 1 || (prepared.leftDoc.tabs?.length ?? 0) > 1 ? lead.title : "" },
      tabs: prepared.tabs.map((t) => ({ id: t.tabId, title: t.title })),
      plan,
      format: { v: 1, paragraphs: [{}], runs: [] },
      segments,
      spots,
      startInMinutes,
      now,
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
      baselineWordCount,
    });
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
    log.info("compare.start", { job: id, uid: uidTag(user.userId), tabs: prepared.tabs.length, segments: segments.length, chars: plan.totalChars, droppedImages: prepared.droppedImages, ms: done() });
    return applyAuthCookies(NextResponse.json({ job: toPublicJob(job), totalMs: plan.totalMs, droppedImages: prepared.droppedImages }), user);
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
