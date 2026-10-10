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
import { getDocument, snapshotOf } from "@/lib/google";
import { applyAuthCookies, resolveUser, tooLarge, unauthorized, withGoogleToken } from "@/lib/auth";
import { normalizeText, parseFormat } from "@/lib/rich-text";
import { buildSyncRecords, parseSegments, segmentBoundaries, spotsFor, type SegmentInput } from "@/lib/sync-plan";

export const dynamic = "force-dynamic";

const MAX_TEXT_CHARS = 1_000_000;
const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;

interface StartBody {
  text?: unknown;
  format?: unknown;
  documentId?: unknown;
  documentName?: unknown;
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
const DOC_CHANGED = "This document changed in Google Docs. SyncStream reloaded it with your additions in place. Check them, then start again.";

export async function POST(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();

  if (process.env.VERCEL && !hasRedis()) {
    return NextResponse.json(
      { error: "Upstash Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel project's environment variables and redeploy." },
      { status: 500 }
    );
  }

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
  if (Array.isArray(body.breaks)) {
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

  const boundaries = segments ? segmentBoundaries(segments) : [];
  const plan = buildDripPlan(text, { targetMinutes, breaks, typoFrequency, seed, ...(boundaries.length ? { boundaries } : {}) });
  if (plan.actions.length === 0) {
    return NextResponse.json({ error: "Nothing to type" }, { status: 400 });
  }

  // Read the target doc: baseline word count, proof we can open it, and where additions go
  let baselineWordCount = 0;
  let spots: SpotState[] | undefined;
  try {
    const doc = await withGoogleToken(user, (t) => getDocument(t, documentId));
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

  let context: SyncContext | null = null;
  if (segments && body.context && typeof body.context === "object") {
    const c = body.context as { doc?: unknown; ranges?: unknown };
    const okRanges = Array.isArray(c.ranges) && c.ranges.length === segments.length && c.ranges.every((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isInteger));
    if (c.doc && typeof c.doc === "object" && okRanges && JSON.stringify(c).length <= MAX_CONTEXT_JSON) {
      context = { doc: c.doc, ranges: c.ranges as [number, number][] };
    }
  }
  const now = Date.now();
  const id = createJobId();
  const { plan: syncPlan, job } = buildSyncRecords({
    id,
    userId: user.userId,
    documentId,
    documentName,
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
    console.error("Sync start failed:", err);
    await store.deleteJob(id).catch(() => {});
    await store.removeUserJob(user.userId, id).catch(() => {});
    await store.removeActiveJob(id).catch(() => {});
    return NextResponse.json({ error: `Failed to start sync: ${message}` }, { status: 500 });
  }

  return applyAuthCookies(
    NextResponse.json({ job: toPublicJob(job), totalMs: plan.totalMs, breaks: plan.breaks, seed: plan.seed }),
    user
  );
}
