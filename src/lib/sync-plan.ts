/**
 * Turning a start request into a sync: the additions a client sent, where
 * each goes in the document as read, and the plan and job records the
 * runner works from. Shared by the start route and the live end-to-end test
 * so both build exactly the same job.
 */

import type { docs_v1 } from "googleapis";
import type { DripPlan } from "./drip-engine";
import { normalizeText, parseFormat, type DocListState, type ListType, type RichFormat } from "./rich-text";
import { planSpots } from "./spots";
import type { PlanSegment, SpotState, SyncJob, SyncPlan } from "./sync-store";

/** One addition to an existing document, as the client sends it */
export interface SegmentInput {
  /** Docs index where the text goes */
  at: number;
  /** "inline": typed at `at`. "before": a new paragraph is opened there first. */
  mode: "inline" | "before";
  text: string;
  format: RichFormat;
}

export const MAX_SEGMENTS = 300;

/** Validate the `segments` of a start request. Their text is the sync's source, back to back. */
export function parseSegments(raw: unknown): { ok: true; segments: SegmentInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEGMENTS) return { ok: false, error: "Invalid additions" };
  const segments: SegmentInput[] = [];
  let lastAt = 0;
  for (const item of raw as Record<string, unknown>[]) {
    const at = item?.at;
    const mode = item?.mode;
    const text = item?.text;
    if (typeof at !== "number" || !Number.isInteger(at) || at < 1 || at < lastAt || (mode !== "inline" && mode !== "before") || typeof text !== "string" || !text) {
      return { ok: false, error: "Invalid additions" };
    }
    if (normalizeText(text) !== text) return { ok: false, error: "Text contains characters Google Docs would remove" };
    const parsed = parseFormat(text, item.format);
    if (!parsed.ok) return { ok: false, error: `Invalid formatting: ${parsed.error}` };
    segments.push({ at, mode, text, format: parsed.format });
    lastAt = at;
  }
  return { ok: true, segments };
}

/** Source offsets where one segment's text ends and the next begins (the planner never chunks across them) */
export function segmentBoundaries(segments: { text: string }[]): number[] {
  const boundaries: number[] = [];
  let acc = 0;
  for (const s of segments) {
    if (acc) boundaries.push(acc);
    acc += s.text.length;
  }
  return boundaries;
}

/** The segments' source ranges, as the plan stores them */
export function planSegmentsOf(segments: SegmentInput[]): PlanSegment[] {
  let acc = 0;
  return segments.map((s) => {
    const seg: PlanSegment = { start: acc, end: acc + s.text.length, mode: s.mode, format: s.format };
    acc += s.text.length;
    return seg;
  });
}

/**
 * Where each segment is typed in the document as read (`chars` is its
 * index-aligned text), with the list state of the paragraph it goes into.
 * Null when the document no longer has a paragraph at one of the positions,
 * meaning it changed since the client read it.
 */
export function spotsFor(doc: docs_v1.Schema$Document, chars: string, segments: SegmentInput[]): SpotState[] | null {
  const paragraphs: { start: number; end: number; bullet: docs_v1.Schema$Bullet | undefined }[] = [];
  const collect = (elements: docs_v1.Schema$StructuralElement[]) => {
    for (const el of elements) {
      if (el.paragraph) paragraphs.push({ start: el.startIndex ?? 0, end: el.endIndex ?? 0, bullet: el.paragraph.bullet ?? undefined });
      else if (el.table) for (const row of el.table.tableRows ?? []) for (const cell of row.tableCells ?? []) collect(cell.content ?? []);
    }
  };
  collect(doc.body?.content ?? []);
  const paragraphFor = (at: number, mode: SegmentInput["mode"]) =>
    paragraphs.find((p) => (mode === "before" ? p.start === at : p.start <= at && at < p.end));
  if (segments.some((x) => !paragraphFor(x.at, x.mode))) return null;
  const listType = (bullet: docs_v1.Schema$Bullet): ListType => {
    const level = doc.lists?.[bullet.listId ?? ""]?.listProperties?.nestingLevels?.[bullet.nestingLevel ?? 0];
    if (level?.glyphSymbol) return "bullet";
    return level?.glyphType && level.glyphType !== "GLYPH_TYPE_UNSPECIFIED" && level.glyphType !== "NONE" ? "ordered" : "check";
  };
  return planSpots(chars, segments, (at, mode): DocListState => {
    const bullet = paragraphFor(at, mode)?.bullet;
    // A negative start marks a list that is not ours: new lines continue it
    return bullet ? { type: listType(bullet), start: -1, level: bullet.nestingLevel ?? 0 } : null;
  });
}

export interface SyncRecordsInput {
  id: string;
  userId: string;
  documentId: string;
  documentName: string;
  plan: DripPlan;
  /** Formatting of the whole source (plans without segments) */
  format: RichFormat;
  /** Additions to an existing document, with where each is typed */
  segments?: SegmentInput[] | null;
  spots?: SpotState[];
  startInMinutes?: number;
  now: number;
  accessToken: string;
  refreshToken: string;
  baselineWordCount: number;
}

/** The immutable plan and the mutable job the runner starts from */
export function buildSyncRecords(input: SyncRecordsInput): { plan: SyncPlan; job: SyncJob } {
  const { plan, now, id } = input;
  const startInMinutes = input.startInMinutes ?? 0;
  const startAt = now + Math.round(startInMinutes * 60_000);
  const planSegments = input.segments ? planSegmentsOf(input.segments) : undefined;
  const syncPlan: SyncPlan = {
    id,
    userId: input.userId,
    documentId: input.documentId,
    actions: plan.actions,
    totalChars: plan.totalChars,
    totalMs: plan.totalMs,
    breaks: plan.breaks,
    seed: plan.seed,
    createdAt: now,
    ...(planSegments ? { segments: planSegments } : { format: input.format }),
  };
  const job: SyncJob = {
    id,
    userId: input.userId,
    documentId: input.documentId,
    documentName: input.documentName,
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
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    activity: startInMinutes > 0 ? "Scheduled" : "Queued",
    etaTargetAt: startAt + plan.totalMs,
    wpm: 0,
    baselineWordCount: input.baselineWordCount,
    ...(input.spots ? { spots: input.spots } : {}),
    breaks: plan.breaks,
    completedBreaks: [],
    lastUpdate: now,
  };
  return { plan: syncPlan, job };
}
