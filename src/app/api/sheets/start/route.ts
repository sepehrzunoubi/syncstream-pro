import { NextRequest, NextResponse } from "next/server";
import { applyAuthCookies, googleStatus, resolveUser, tooLarge, unauthorized, withGoogleToken } from "@/lib/auth";
import { createSpreadsheet, isSheetsApiDisabled } from "@/lib/google";
import { enqueueProcess } from "@/lib/qstash";
import { createJobId, getStore, hasRedis, MAX_STORED_JSON, storedSize, toPublicJob, type SyncJob, type SyncPlan } from "@/lib/sync-store";
import { buildSheetPlan, MAX_SHEET_TARGET_MINUTES, MIN_SHEET_TARGET_MINUTES, parseSheetBreaks } from "@/lib/sheets/plan";
import { planSteps } from "@/lib/sheets/order";
import { parseWorkbook } from "@/lib/sheets/validate";
import { workbookStats } from "@/lib/sheets/model";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, startTimer, uidTag } from "@/lib/log";
import { reportError } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A workbook as the page sends it: under what a function on Vercel takes (4.5 MB) */
const MAX_BODY = 4_300_000;
const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;
const TOO_BIG = "This workbook is too large to sync in one go. Sync fewer sheets at a time, or a smaller workbook.";

interface StartBody {
  workbook?: unknown;
  /** The new Google Sheet's name (the file's, unless changed) */
  name?: unknown;
  targetMinutes?: unknown;
  seed?: unknown;
  startInMinutes?: unknown;
  /** The browser's time zone, for the new spreadsheet (TODAY() and NOW() follow it) */
  timeZone?: unknown;
  /** Breaks placed by hand: [{ section, minutes }], each before that section of the build */
  breaks?: unknown;
}

/**
 * Start a spreadsheet sync: the workbook the page read from an .xlsx file is checked, planned from
 * the same seed as the page's preview, a new Google Sheet is made for it, and the job is queued.
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "sync.start", { max: 10, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  if (process.env.VERCEL && !hasRedis()) {
    return NextResponse.json({ error: "Upstash Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel project's environment variables and redeploy." }, { status: 500 });
  }
  const done = startTimer();
  const big = tooLarge(req, MAX_BODY);
  if (big) return NextResponse.json({ error: TOO_BIG, code: "too_large" }, { status: 413 });
  let body: StartBody;
  try { body = (await req.json()) as StartBody; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const parsed = parseWorkbook(body.workbook);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const workbook = parsed.workbook;
  const stats = workbookStats(workbook);
  if (!workbook.sheets.some((s) => s.cells.length)) return NextResponse.json({ error: "This workbook has nothing to sync." }, { status: 400 });
  if (typeof body.name === "string" && body.name.trim()) workbook.name = body.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);

  let targetMinutes: number | null = null;
  if (body.targetMinutes != null) {
    if (typeof body.targetMinutes !== "number" || !Number.isFinite(body.targetMinutes) || body.targetMinutes < MIN_SHEET_TARGET_MINUTES || body.targetMinutes > MAX_SHEET_TARGET_MINUTES) {
      return NextResponse.json({ error: "Duration must be between 1 minute and 7 days" }, { status: 400 });
    }
    targetMinutes = body.targetMinutes;
  }
  const seed = typeof body.seed === "number" && Number.isInteger(body.seed) && body.seed >= 0 ? body.seed >>> 0 : undefined;
  let startInMinutes = 0;
  if (body.startInMinutes != null) {
    if (typeof body.startInMinutes !== "number" || !Number.isFinite(body.startInMinutes) || body.startInMinutes < 0 || body.startInMinutes > MAX_SCHEDULE_MINUTES) {
      return NextResponse.json({ error: "startInMinutes must be between 0 and 7 days" }, { status: 400 });
    }
    startInMinutes = body.startInMinutes;
  }
  const timeZone = typeof body.timeZone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(body.timeZone) ? body.timeZone : null;

  const breaks = parseSheetBreaks(body.breaks, planSteps(workbook).sections.length);
  if (!breaks) return NextResponse.json({ error: "Those breaks don't fit this workbook. Place them again." }, { status: 400 });
  const plan = buildSheetPlan(workbook, { targetMinutes, seed, breaks });
  if (!plan.steps.length) return NextResponse.json({ error: "This workbook has nothing to sync." }, { status: 400 });
  const now = Date.now();
  const id = createJobId();
  const syncPlan: SyncPlan = {
    id, userId: user.userId, documentId: "", actions: plan.actions, totalChars: plan.totalUnits, totalMs: plan.totalMs, breaks: [], seed: plan.seed, createdAt: now,
    sheet: { workbook, steps: plan.steps, units: plan.units, sections: plan.sections },
  };
  // (checked before the spreadsheet is made: a plan that can't be stored leaves nothing behind)
  if (storedSize(syncPlan) > MAX_STORED_JSON) return NextResponse.json({ error: TOO_BIG, code: "too_large" }, { status: 413 });

  let sheet: { id: string; name: string };
  try {
    sheet = await withGoogleToken(user, (t) => createSpreadsheet(t, workbook.name, timeZone));
  } catch (err) {
    const status = googleStatus(err);
    log.error("sheets.create_failed", { uid: uidTag(user.userId), status, err });
    if (status === 401) return unauthorized();
    if (status === 403 && isSheetsApiDisabled(err)) {
      return NextResponse.json({ error: "The Google Sheets API is turned off for this SyncStream deployment. In the Google Cloud console, open the project the OAuth client belongs to, enable \"Google Sheets API\", wait a minute, and start again.", code: "sheets_api_disabled" }, { status: 503 });
    }
    if (status === 403) return NextResponse.json({ error: "Google didn't allow SyncStream to create a spreadsheet. Reconnect your Google account from the account menu, then start again.", code: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Google didn't confirm the new spreadsheet. If one was made, it is in your Drive: check there before starting again." }, { status: 502 });
  }
  syncPlan.documentId = sheet.id;

  const startAt = now + Math.round(startInMinutes * 60_000);
  const job: SyncJob = {
    id, userId: user.userId, documentId: sheet.id, documentName: sheet.name, kind: "sheet",
    status: startInMinutes > 0 ? "scheduled" : "pending", createdAt: now, startAt,
    currentAction: 0, totalActions: plan.actions.length, charsSent: 0, totalChars: plan.totalUnits,
    typoSubStep: 0, typoCharsInDoc: 0, generation: 0, failures: 0,
    accessToken: user.accessToken, refreshToken: user.refreshToken,
    activity: startInMinutes > 0 ? "Scheduled" : "Queued", etaTargetAt: startAt + plan.totalMs, wpm: 0, baselineWordCount: 0,
    breaks: breaks.map((b) => b.minutes), breakAt: [], breaksVersion: 0, editableFrom: 0, completedBreaks: [], lastUpdate: now,
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
    await reportError(err, { event: "sync.start_failed", route: "/api/sheets/start", method: "POST", uid: uidTag(user.userId), jobId: id, ms: done() });
    await store.deleteJob(id).catch(() => {});
    await store.removeUserJob(user.userId, id).catch(() => {});
    await store.removeActiveJob(id).catch(() => {});
    await store.removeHistory(user.userId, [id]).catch(() => {});
    return NextResponse.json({ error: `Failed to start sync: ${message}` }, { status: 500 });
  }

  log.info("sheets.start", { job: id, uid: uidTag(user.userId), sheets: stats.sheets, cells: stats.cells, formulas: stats.formulas, steps: plan.steps.length, totalMin: Math.round(plan.totalMs / 60_000), startInMin: startInMinutes, ms: done() });
  return applyAuthCookies(NextResponse.json({ job: toPublicJob(job), totalMs: plan.totalMs, seed: plan.seed, fitsTarget: plan.fitsTarget }), user);
});
