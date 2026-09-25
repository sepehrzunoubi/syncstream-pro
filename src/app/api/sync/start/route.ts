import { NextRequest, NextResponse } from "next/server";
import {
  buildDripPlan,
  MAX_BREAK_MINUTES,
  MAX_CUSTOM_BREAKS,
  MAX_TARGET_MINUTES,
  MIN_TARGET_MINUTES,
} from "@/lib/drip-engine";
import { createJobId, getStore, hasRedis, toPublicJob, type SyncJob, type SyncPlan } from "@/lib/sync-store";
import { enqueueProcess } from "@/lib/qstash";
import { getDocSnapshot } from "@/lib/google";
import { applyAuthCookies, resolveUser, unauthorized } from "@/lib/auth";
import { normalizeText, parseFormat } from "@/lib/rich-text";

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
}

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

  // Baseline word count of the target doc (best effort; also proves we can read it)
  let baselineWordCount = 0;
  try {
    baselineWordCount = (await getDocSnapshot(user.accessToken, documentId)).wordCount;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 403 || code === 404) {
      return NextResponse.json(
        { error: code === 404 ? "That document could not be found." : "SyncStream is not allowed to edit that document. Re-authenticate to grant access." },
        { status: 400 }
      );
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
    breaks: plan.breaks,
    completedBreaks: [],
    lastUpdate: now,
  };

  const store = getStore();
  try {
    await store.setPlan(syncPlan);
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
