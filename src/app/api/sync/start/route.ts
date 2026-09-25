import { NextRequest, NextResponse } from "next/server";
import {
  buildDripPlan,
  MAX_BREAK_MINUTES,
  MAX_CUSTOM_BREAKS,
  MAX_TARGET_MINUTES,
  MIN_TARGET_MINUTES,
} from "@/lib/drip-engine";
import { createJobId, getStore, hasRedis, toPublicJob, type JobAnchor, type SyncContext, type SyncJob, type SyncPlan } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";
import { getDocument, snapshotOf } from "@/lib/google";
import { anchorPosition } from "@/lib/doc-import";
import { applyAuthCookies, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";
import { normalizeText, parseFormat, type DocListState } from "@/lib/rich-text";

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
  /** Where to type inside an existing document: { mode: "before" | "after", at } */
  anchor?: unknown;
  /** Revision of the document the anchor was chosen in */
  revisionId?: unknown;
  /** Paragraphs shown around the sync in the running view */
  context?: unknown;
}

const ANCHOR_CONTEXT_CHARS = 40;
const MAX_CONTEXT_JSON = 400_000;
const DOC_CHANGED = "This document changed since it was loaded. It has been reloaded: check where your text goes, then start again.";

export async function POST(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();

  if (process.env.VERCEL && !hasRedis()) {
    return NextResponse.json(
      { error: "Upstash Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel project's environment variables and redeploy." },
      { status: 500 }
    );
  }

  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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

  const plan = buildDripPlan(text, { targetMinutes, breaks, typoFrequency, seed });
  if (plan.actions.length === 0) {
    return NextResponse.json({ error: "Nothing to type" }, { status: 400 });
  }

  let requested: { mode: "before" | "after"; at: number } | null = null;
  if (body.anchor != null) {
    const a = body.anchor as { mode?: unknown; at?: unknown };
    if ((a.mode !== "before" && a.mode !== "after") || typeof a.at !== "number" || !Number.isInteger(a.at)) {
      return NextResponse.json({ error: "Invalid anchor" }, { status: 400 });
    }
    requested = { mode: a.mode, at: a.at };
  }

  // Read the target doc: baseline word count, proof we can open it, and the anchor's surroundings
  let baselineWordCount = 0;
  let anchor: JobAnchor | undefined;
  let docList: DocListState | undefined;
  try {
    const doc = await withGoogleToken(user, (t) => getDocument(t, documentId));
    const snap = snapshotOf(doc);
    baselineWordCount = snap.wordCount;
    if (requested) {
      if (typeof body.revisionId === "string" && body.revisionId && body.revisionId !== snap.revisionId) {
        return NextResponse.json({ error: DOC_CHANGED, code: "doc_changed" }, { status: 409 });
      }
      const pos = anchorPosition(snap.chars, requested);
      if (pos == null) return NextResponse.json({ error: DOC_CHANGED, code: "doc_changed" }, { status: 409 });
      anchor = { mode: requested.mode, ctx: snap.chars.slice(Math.max(0, pos - ANCHOR_CONTEXT_CHARS), pos), cursor: pos, opened: false };
      // The new paragraph copies the style of the one it is opened from, bullets included
      const from = requested.mode === "after" ? pos - 1 : pos;
      const source = (doc.body?.content ?? []).find((el) => el.paragraph && (el.startIndex ?? 0) <= from && from < (el.endIndex ?? 0));
      if (source?.paragraph?.bullet) docList = { type: "bullet", start: -1 };
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
    if (requested) return NextResponse.json({ error: "Couldn't read the document. Try again." }, { status: 502 });
  }

  let context: SyncContext | null = null;
  if (requested && body.context && typeof body.context === "object") {
    const c = body.context as { before?: unknown; after?: unknown };
    if (Array.isArray(c.before) && Array.isArray(c.after) && JSON.stringify(c).length <= MAX_CONTEXT_JSON) {
      context = { before: c.before, after: c.after };
    }
  }

  const now = Date.now();
  const id = createJobId();
  const startAt = now + Math.round(startInMinutes * 60_000);
  const syncPlan: SyncPlan = {
    id,
    userId: user.userId,
    documentId,
    actions: plan.actions,
    totalChars: plan.totalChars,
    totalMs: plan.totalMs,
    breaks: plan.breaks,
    seed: plan.seed,
    createdAt: now,
    format: parsedFormat.format,
  };
  const job: SyncJob = {
    id,
    userId: user.userId,
    documentId,
    documentName,
    status: startInMinutes > 0 ? "scheduled" : "pending",
    createdAt: now,
    startAt,
    currentAction: 0,
    totalActions: plan.actions.length,
    charsSent: 0,
    totalChars: plan.totalChars,
    typoSubStep: 0,
    typoCharsInDoc: 0,
    generation: 0,
    failures: 0,
    accessToken: user.accessToken,
    refreshToken: user.refreshToken,
    activity: startInMinutes > 0 ? "Scheduled" : "Queued",
    etaTargetAt: startAt + plan.totalMs,
    wpm: 0,
    baselineWordCount,
    ...(anchor ? { anchor } : {}),
    ...(docList ? { docList } : {}),
    breaks: plan.breaks,
    completedBreaks: [],
    lastUpdate: now,
  };

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
