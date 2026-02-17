import { Redis } from "@upstash/redis";
import type { DripAction, StreamEvent } from "./drip-engine";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SyncJob {
  id: string;
  status: "pending" | "running" | "done" | "error" | "cancelled" | "paused";
  currentAction: number;
  totalActions: number;
  charsSent: number;
  totalChars: number;
  totalMinutes: number;
  wpm: number;
  eta: number;
  activity: string;
  nextTypoAction?: number;
  nextDelayMs: number;
  /** Absolute timestamp when the current delay ends — survives tab close */
  nextActionAt?: number;
  error?: string;
  startTime: number;
  lastUpdate: number;
  /** Monotonically increasing counter — incremented on each resume to kill stale loops */
  generation?: number;
  /** Baseline word count in target doc before sync started (for accurate word count display) */
  baselineWordCount?: number;
  /** V2 burst: mandatory pause durations in minutes (in execution order) */
  mandatoryPauses?: number[];
  /** V2 burst: indices of completed mandatory pauses */
  completedPauses?: number[];
  /** Index of next significant pause action (burst modes) */
  nextPauseAction?: number;
}

export interface SyncJobPayload {
  jobId: string;
  accessToken: string;
  refreshToken: string;
  documentId: string;
  actions: DripAction[];
  currentAction: number;
  charsSent: number;
  totalChars: number;
  totalMinutes: number;
  startTime: number;
  /** Remaining delay for current action when paused mid-delay */
  remainingDelayMs?: number;
  /** Generation counter — process loop exits if it doesn't match the job's generation */
  generation?: number;
  /**
   * Typo sub-step tracking for atomic typo handling.
   * 0 = not in typo, 1 = wrong chars inserted (need delete + correct),
   * 2 = wrong chars deleted (need correct insert), 3 = complete
   */
  typoSubStep?: number;
  /** Length of typo chars currently in the document (for cleanup on resume) */
  typoCharsInDoc?: number;
}

// ── Upstash Redis store ────────────────────────────────────────────────────
// Persistent across all Vercel serverless instances.
// Jobs auto-expire after 24 hours to prevent stale data.

const JOB_TTL_SECONDS = 86400; // 24 hours
const KEY_PREFIX = "syncjob:";

function getRedis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

const PAYLOAD_PREFIX = "syncpayload:";

// Fallback in-memory store for local dev without Redis
const localJobs = new Map<string, SyncJob>();
const localPayloads = new Map<string, SyncJobPayload>();

export async function getJob(id: string): Promise<SyncJob | null> {
  const redis = getRedis();
  if (redis) {
    const data = await redis.get<SyncJob>(`${KEY_PREFIX}${id}`);
    return data ?? null;
  }
  return localJobs.get(id) ?? null;
}

export async function setJob(job: SyncJob): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(`${KEY_PREFIX}${job.id}`, job, { ex: JOB_TTL_SECONDS });
  } else {
    localJobs.set(job.id, job);
  }
}

export async function deleteJob(id: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.del(`${KEY_PREFIX}${id}`);
    await redis.del(`${PAYLOAD_PREFIX}${id}`);
  } else {
    localJobs.delete(id);
    localPayloads.delete(id);
  }
}

export async function getPayload(id: string): Promise<SyncJobPayload | null> {
  const redis = getRedis();
  if (redis) {
    const data = await redis.get<SyncJobPayload>(`${PAYLOAD_PREFIX}${id}`);
    return data ?? null;
  }
  return localPayloads.get(id) ?? null;
}

export async function setPayload(payload: SyncJobPayload): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(`${PAYLOAD_PREFIX}${payload.jobId}`, payload, { ex: JOB_TTL_SECONDS });
  } else {
    localPayloads.set(payload.jobId, payload);
  }
}

export function createJobId(): string {
  return `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function jobToEvent(job: SyncJob): StreamEvent {
  return {
    type: job.status === "done" ? "done" : job.status === "error" ? "error" : "progress",
    actionIndex: job.currentAction,
    totalActions: job.totalActions,
    charsSent: job.charsSent,
    totalChars: job.totalChars,
    nextDelayMs: job.nextDelayMs,
    nextActionAt: job.nextActionAt,
    eta: job.eta,
    wpm: job.wpm,
    activity: job.activity,
    status: `Action ${job.currentAction + 1}/${job.totalActions}`,
    nextTypoAction: job.nextTypoAction,
    nextPauseAction: job.nextPauseAction,
    mandatoryPauses: job.mandatoryPauses,
    completedPauses: job.completedPauses,
    error: job.error,
    lastUpdate: job.lastUpdate,
  };
}
