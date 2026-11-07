import { NextRequest, NextResponse } from "next/server";
import {
  buildDripPlan,
  MAX_BREAK_MINUTES,
  MAX_CUSTOM_BREAKS,
  MAX_TARGET_MINUTES,
  MIN_TARGET_MINUTES,
} from "@/lib/drip-engine";
import { createJobId, getStore, hasRedis, toPublicJob, type SpotState, type SyncContext } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";
import { getDocument, snapshotOf, TabGoneError } from "@/lib/google";
import { isTabId } from "@/lib/doc-tabs";
import { applyAuthCookies, resolveUser, tooLarge, unauthorized, withGoogleToken } from "@/lib/auth";
import { normalizeText, parseFormat } from "@/lib/rich-text";
import { buildSyncRecords, parseSegments, segmentBoundaries, spotsFor, type SegmentInput } from "@/lib/sync-plan";
import { parseAnchors, withAnchors, type BreakAnchor } from "@/lib/breaks";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, startTimer, uidTag } from "@/lib/log";
import { reportError } from "@/lib/monitor";

export const dynamic = "force-dynamic";

const MAX_TEXT_CHARS = 1_000_000;
const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;

interface StartBody {
  text?: unknown;
  format?: unknown;
  documentId?: unknown;
  documentName?: unknown;
  /** The tab to type into (none: the first) */
  tabId?: unknown;
  targetMinutes?: unknown;
  breaks?: unknown;
  typoFrequency?: unknown;
  seed?: unknown;
  startInMinutes?: unknown;
  /** Additions to an existing document: [{ at, mode, text, format }] in document order */
  segments?: unknown;
  /** Revision of the document the segments' indices refer to */
  revisionId?: unknown;
  /** What the running view shows */
  context?: unknown;
}

const MAX_CONTEXT_JSON = 400_000;
/** What /api/sync/source sends back in one body (text, formatting and view), in bytes */
const MAX_SOURCE_REPLY_BYTES = 4_000_000;
const DOC_CHANGED = "This document changed in Google Docs. SyncStream reloaded it with your additions in place. Check them, then start again.";

export const POST = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "sync.start", { max: 10, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;

  if (process.env.VERCEL && !hasRedis()) {
    return NextResponse.json(
      { error: "Upstash Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel project's environment variables and redeploy." },
      { status: 500 }
    );
  }

  const done = startTimer();
  const big = tooLarge(req, 6_000_000);
  if (big) return big;
  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Additions to an existing document come as segments; their text is the source, back to back
  let segments: SegmentInput[] | null = null;
  if (body.segments != null) {
    const parsed = parseSegments(body.segments);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    segments = parsed.segments;
    body.text = segments.map((x) => x.text).join("");
    body.format = null;
  }

  const rawText = typeof body.text === "string" ? body.text : "";
  // Formatted text must already be normalized by the client (offsets depend on it).
  const text = body.format != null ? rawText : normalizeText(rawText);
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  const documentName = typeof body.documentName === "string" && body.documentName.trim() ? body.documentName.trim().slice(0, 200) : "Untitled document";
  if (body.tabId != null && !isTabId(body.tabId)) return NextResponse.json({ error: "Invalid tab" }, { status: 400 });
  const tabId = typeof body.tabId === "string" && body.tabId ? body.tabId : null;
  if (!text.trim() || !documentId) {
    return NextResponse.json({ error: "Missing text or documentId" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json({ error: `Text exceeds ${MAX_TEXT_CHARS.toLocaleString()} characters` }, { status: 400 });
  }

  if (body.format != null && normalizeText(text) !== text) {
    return NextResponse.json({ error: "Text contains characters Google Docs would remove" }, { status: 400 });
  }
  const parsedFormat = parseFormat(text, body.format);
  if (!parsedFormat.ok) {
    return NextResponse.json({ error: `Invalid formatting: ${parsedFormat.error}` }, { status: 400 });
  }

  let targetMinutes: number | null = null;
  if (body.targetMinutes != null) {
    if (typeof body.targetMinutes !== "number" || !Number.isFinite(body.targetMinutes) || body.targetMinutes < MIN_TARGET_MINUTES || body.targetMinutes > MAX_TARGET_MINUTES) {
      return NextResponse.json({ error: `Duration must be between ${MIN_TARGET_MINUTES} minute and 7 days` }, { status: 400 });
    }
    targetMinutes = body.targetMinutes;
  }

  let breaks: "auto" | number[] = "auto";
  // Manual: breaks after the words the user picked, [{ at, minutes }], typed at a natural pace
  let anchors: BreakAnchor[] | null = null;
  const boundaries = segments ? segmentBoundaries(segments) : [];
  if (Array.isArray(body.breaks) && body.breaks.length > 0 && body.breaks.every((b) => b !== null && typeof b === "object")) {
    const parsed = parseAnchors(body.breaks, text, { ends: boundaries });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    anchors = parsed.anchors;
    breaks = [];
    targetMinutes = null;
  } else if (Array.isArray(body.breaks)) {
    if (body.breaks.length > MAX_CUSTOM_BREAKS) {
      return NextResponse.json({ error: `At most ${MAX_CUSTOM_BREAKS} breaks` }, { status: 400 });
    }
    for (const b of body.breaks) {
      if (typeof b !== "number" || !Number.isFinite(b) || b < 1 || b > MAX_BREAK_MINUTES) {
        return NextResponse.json({ error: `Each break must be 1–${MAX_BREAK_MINUTES} minutes` }, { status: 400 });
      }
    }
    breaks = body.breaks as number[];
  } else if (body.breaks !== undefined && body.breaks !== "auto") {
    return NextResponse.json({ error: "breaks must be \"auto\" or a list of minutes" }, { status: 400 });
  }

  const typoFrequency = typeof body.typoFrequency === "number" ? Math.max(0, Math.min(1, body.typoFrequency)) : 0.5;
  const seed = typeof body.seed === "number" && Number.isInteger(body.seed) && body.seed >= 0 ? body.seed >>> 0 : undefined;

  let startInMinutes = 0;
  if (body.startInMinutes != null) {
    if (typeof body.startInMinutes !== "number" || !Number.isFinite(body.startInMinutes) || body.startInMinutes < 0 || body.startInMinutes > MAX_SCHEDULE_MINUTES) {
      return NextResponse.json({ error: "startInMinutes must be between 0 and 7 days" }, { status: 400 });
    }
    startInMinutes = body.startInMinutes;
  }

  const drip = buildDripPlan(text, { targetMinutes, breaks, typoFrequency, seed, ...(boundaries.length ? { boundaries } : {}) });
  const plan = anchors ? withAnchors(drip, anchors) : drip;
  if (plan.actions.length === 0) {
    return NextResponse.json({ error: "Nothing to type" }, { status: 400 });
  }

  // Read the target doc: baseline word count, proof we can open it, and where additions go
  let baselineWordCount = 0;
  let spots: SpotState[] | undefined;
  // The tab it types into, kept by id: it stays that tab's if the tabs are reordered
  let tab: { id: string; title: string } | null = null;
  try {
    const open = await withGoogleToken(user, (t) => getDocument(t, documentId, tabId));
    const doc = open.doc;
    // (named only in a document with more than one, where the running view shows it)
    if (open.tabId) tab = { id: open.tabId, title: open.tabs.length > 1 ? open.tabs.find((x) => x.id === open.tabId)?.title ?? "" : "" };
    const snap = snapshotOf(doc);
    baselineWordCount = snap.wordCount;
    if (segments) {
      if (typeof body.revisionId === "string" && body.revisionId && body.revisionId !== snap.revisionId) {
        return NextResponse.json({ error: DOC_CHANGED, code: "doc_changed" }, { status: 409 });
      }
      const found = spotsFor(doc, snap.chars, segments);
      if (!found) return NextResponse.json({ error: DOC_CHANGED, code: "doc_changed" }, { status: 409 });
      spots = found;
    }
  } catch (err) {
    if (err instanceof TabGoneError) {
      return NextResponse.json({ error: "That tab of the document is gone. SyncStream reloaded the document: pick a tab and start again.", code: "tab_gone" }, { status: 409 });
    }
    const code = (err as { code?: number })?.code;
    if (code === 403 || code === 404) {
      return NextResponse.json(
        { error: code === 404 ? "That document could not be found." : "SyncStream is not allowed to edit that document. Re-authenticate to grant access." },
        { status: 400 }
      );
    }
    // Typing inside a document needs its current text
    if (segments) return NextResponse.json({ error: "Couldn't read the document. Try again." }, { status: 502 });
  }
  // Unread (appending at the end), it still types into the tab asked for
  if (!tab && tabId) tab = { id: tabId, title: "" };

  let context: SyncContext | null = null;
  if (segments && body.context && typeof body.context === "object") {
    const c = body.context as { doc?: unknown; ranges?: unknown };
    const okRanges = Array.isArray(c.ranges) && c.ranges.length === segments.length && c.ranges.every((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isInteger));
    if (c.doc && typeof c.doc === "object" && okRanges && JSON.stringify(c).length <= MAX_CONTEXT_JSON) {
      context = { doc: c.doc, ranges: c.ranges as [number, number][] };
    }
  }
  // The live page gets the text, its formatting and this view in one reply, which must stay under
  // Vercel's 4.5 MB even unpacked (text in other alphabets takes 2 to 3 bytes a letter): past that,
  // the sync runs without the view, as one too big to store does
  if (context && Buffer.byteLength(JSON.stringify({ sourceText: text, format: parsedFormat.format, context })) > MAX_SOURCE_REPLY_BYTES) context = null;
  const now = Date.now();
  const id = createJobId();
  const { plan: syncPlan, job } = buildSyncRecords({
    id,
    userId: user.userId,
    documentId,
    documentName,
    tab,
    plan,
    format: parsedFormat.format,
    segments,
    spots,
    startInMinutes,
    now,
    accessToken: user.accessToken,
    refreshToken: user.refreshToken,
    baselineWordCount,
  });

  const store = getStore();
  try {
    await store.setPlan(syncPlan);
    if (context) await store.setContext(id, context);
    await store.setJob(job);
    await store.addUserJob(user.userId, id);
    await store.addActiveJob(id);
    await enqueueProcess(id, 0, Math.ceil(startInMinutes * 60));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportError(err, { event: "sync.start_failed", route: "/api/sync/start", method: "POST", uid: uidTag(user.userId), jobId: id, ms: done() });
    await store.deleteJob(id).catch(() => {});
    await store.removeUserJob(user.userId, id).catch(() => {});
    await store.removeActiveJob(id).catch(() => {});
    return NextResponse.json({ error: `Failed to start sync: ${message}` }, { status: 500 });
  }

  log.info("sync.start", { job: id, uid: uidTag(user.userId), chars: plan.totalChars, actions: plan.actions.length, segments: segments?.length ?? 0, totalMin: Math.round(plan.totalMs / 60_000), startInMin: startInMinutes, ms: done() });
  return applyAuthCookies(
    NextResponse.json({ job: toPublicJob(job), totalMs: plan.totalMs, breaks: plan.breaks, seed: plan.seed }),
    user
  );
});
