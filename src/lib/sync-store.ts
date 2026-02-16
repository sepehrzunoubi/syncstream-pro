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
  error?: string;
  startTime: number;
  lastUpdate: number;
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

// Fallback in-memory store for local dev without Redis
const localJobs = new Map<string, SyncJob>();

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
  } else {
    localJobs.delete(id);
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
    eta: job.eta,
    wpm: job.wpm,
    activity: job.activity,
    status: `Action ${job.currentAction + 1}/${job.totalActions}`,
    nextTypoAction: job.nextTypoAction,
    error: job.error,
  };
}
