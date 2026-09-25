import { Redis } from "@upstash/redis";
import type { DripAction, StreamEvent } from "./drip-engine";
import type { DocListState, RichFormat } from "./rich-text";

// ── Types ──────────────────────────────────────────────────────────────────

export type JobStatus = "scheduled" | "pending" | "running" | "paused" | "done" | "error" | "cancelled";

/** Immutable description of a sync, written once at start. */
export interface SyncPlan {
  id: string;
  userId: string;
  documentId: string;
  actions: DripAction[];
  totalChars: number;
  totalMs: number;
  breaks: number[];
  seed: number;
  createdAt: number;
  /** Character and paragraph formatting of the source text (absent on older plans) */
  format?: RichFormat;
}

/** Small mutable state, rewritten as the job progresses. */
export interface SyncJob {
  id: string;
  userId: string;
  documentId: string;
  documentName: string;
  status: JobStatus;
  createdAt: number;
  /** When the job is allowed to start typing */
  startAt: number;
  startedAt?: number;
  finishedAt?: number;
  pausedAt?: number;

  // Cursor
  currentAction: number;
  totalActions: number;
  charsSent: number;
  totalChars: number;
  /** Wall-clock time when the current action's wait ends */
  nextActionAt?: number;
  /** typo sub-step: 0 = nothing typed, 1 = wrong chars in doc, 2 = wrong chars deleted */
  typoSubStep: number;
  typoCharsInDoc: number;
  /** Idempotency marker for the Docs write that may or may not have landed */
  inFlight?: { action: number; step: number; text: string };
  /** Bumped on resume so stale queue messages are ignored */
  generation: number;
  /** List state of the paragraph being typed into (formatted plans only) */
  docList?: DocListState;
  failures: number;

  // Credentials for the Docs API
  accessToken: string;
  refreshToken: string;

  // Display
  activity: string;
  etaTargetAt?: number;
  wpm: number;
  baselineWordCount: number;
  liveWordCount?: number;
  breaks: number[];
  completedBreaks: number[];
  nextBreakAction?: number;
  nextBreakAt?: number;
  lastUpdate: number;
  error?: string;
}

/** What the dashboard sees: a job without credentials. */
export type PublicJob = Omit<SyncJob, "accessToken" | "refreshToken" | "inFlight">;

export function toPublicJob(job: SyncJob): PublicJob {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { accessToken, refreshToken, inFlight, docList, ...rest } = job;
  return rest;
}

export function jobToEvent(job: SyncJob | PublicJob): StreamEvent {
  return {
    type: job.status === "done" ? "done" : job.status === "error" ? "error" : "progress",
    actionIndex: job.currentAction,
    totalActions: job.totalActions,
    charsSent: job.charsSent,
    totalChars: job.totalChars,
    nextActionAt: job.nextActionAt,
    etaTargetAt: job.etaTargetAt,
    wpm: job.wpm,
    activity: job.activity,
    status: `Action ${Math.min(job.currentAction + 1, job.totalActions)}/${job.totalActions}`,
    error: job.error,
    nextBreakAction: job.nextBreakAction,
    nextBreakAt: job.nextBreakAt,
    breaks: job.breaks,
    completedBreaks: job.completedBreaks,
    lastUpdate: job.lastUpdate,
    baselineWordCount: job.baselineWordCount,
    liveWordCount: job.liveWordCount,
  };
}

export const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "error", "cancelled"]);
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

// ── Storage ────────────────────────────────────────────────────────────────
// Upstash Redis in production; an in-memory map for local dev and tests.
// Jobs and plans expire a week after their last write.

const TTL_SECONDS = 7 * 24 * 3600;
const JOB_PREFIX = "syncjob:";
const PLAN_PREFIX = "syncplan:";
const USER_JOBS_PREFIX = "userjobs:";
const LOCK_PREFIX = "synclock:";
const KICK_PREFIX = "synckick:";
const CONTROL_PREFIX = "syncctl:";

export type ControlCommand = "pause" | "cancel";
const ACTIVE_JOBS_KEY = "syncjobs:active";

export interface SyncStore {
  getJob(id: string): Promise<SyncJob | null>;
  setJob(job: SyncJob): Promise<void>;
  getPlan(id: string): Promise<SyncPlan | null>;
  setPlan(plan: SyncPlan): Promise<void>;
  deleteJob(id: string): Promise<void>;
  addUserJob(userId: string, id: string): Promise<void>;
  removeUserJob(userId: string, id: string): Promise<void>;
  listUserJobIds(userId: string): Promise<string[]>;
  addActiveJob(id: string): Promise<void>;
  removeActiveJob(id: string): Promise<void>;
  getActiveJobIds(): Promise<string[]>;
  /** SET NX EX: true when this caller now owns the lock */
  acquireLock(id: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(id: string): Promise<void>;
  /** True at most once per ttl window, used to avoid scheduling duplicate re-kicks */
  tryScheduleKick(id: string, ttlSeconds: number): Promise<boolean>;
  /** A pause/cancel request left for the running worker to apply (it is the only writer while locked) */
  setControl(id: string, command: ControlCommand): Promise<void>;
  getControl(id: string): Promise<ControlCommand | null>;
  clearControl(id: string): Promise<void>;
}

function createRedisStore(redis: Redis): SyncStore {
  return {
    async getJob(id) {
      return (await redis.get<SyncJob>(JOB_PREFIX + id)) ?? null;
    },
    async setJob(job) {
      await redis.set(JOB_PREFIX + job.id, job, { ex: TTL_SECONDS });
    },
    async getPlan(id) {
      return (await redis.get<SyncPlan>(PLAN_PREFIX + id)) ?? null;
    },
    async setPlan(plan) {
      await redis.set(PLAN_PREFIX + plan.id, plan, { ex: TTL_SECONDS });
    },
    async deleteJob(id) {
      await redis.del(JOB_PREFIX + id, PLAN_PREFIX + id, LOCK_PREFIX + id, KICK_PREFIX + id, CONTROL_PREFIX + id);
    },
    async addUserJob(userId, id) {
      await redis.sadd(USER_JOBS_PREFIX + userId, id);
      await redis.expire(USER_JOBS_PREFIX + userId, TTL_SECONDS);
    },
    async removeUserJob(userId, id) {
      await redis.srem(USER_JOBS_PREFIX + userId, id);
    },
    async listUserJobIds(userId) {
      return (await redis.smembers(USER_JOBS_PREFIX + userId)) as string[];
    },
    async addActiveJob(id) {
      await redis.sadd(ACTIVE_JOBS_KEY, id);
    },
    async removeActiveJob(id) {
      await redis.srem(ACTIVE_JOBS_KEY, id);
    },
    async getActiveJobIds() {
      return (await redis.smembers(ACTIVE_JOBS_KEY)) as string[];
    },
    async acquireLock(id, ttlSeconds) {
      const res = await redis.set(LOCK_PREFIX + id, "1", { nx: true, ex: ttlSeconds });
      return res === "OK";
    },
    async releaseLock(id) {
      await redis.del(LOCK_PREFIX + id);
    },
    async tryScheduleKick(id, ttlSeconds) {
      const res = await redis.set(KICK_PREFIX + id, "1", { nx: true, ex: ttlSeconds });
      return res === "OK";
    },
    async setControl(id, command) {
      await redis.set(CONTROL_PREFIX + id, command, { ex: 3600 });
    },
    async getControl(id) {
      const v = await redis.get<string>(CONTROL_PREFIX + id);
      return v === "pause" || v === "cancel" ? v : null;
    },
    async clearControl(id) {
      await redis.del(CONTROL_PREFIX + id);
    },
  };
}

export function createMemoryStore(now: () => number = Date.now): SyncStore {
  const jobs = new Map<string, SyncJob>();
  const plans = new Map<string, SyncPlan>();
  const userJobs = new Map<string, Set<string>>();
  const active = new Set<string>();
  const expiring = new Map<string, number>(); // key → expiry ms
  const controls = new Map<string, ControlCommand>();
  const live = (key: string) => {
    const exp = expiring.get(key);
    if (exp != null && exp <= now()) expiring.delete(key);
    return expiring.has(key);
  };
  return {
    async getJob(id) { return structuredClone(jobs.get(id) ?? null); },
    async setJob(job) { jobs.set(job.id, structuredClone(job)); },
    async getPlan(id) { return structuredClone(plans.get(id) ?? null); },
    async setPlan(plan) { plans.set(plan.id, structuredClone(plan)); },
    async deleteJob(id) { jobs.delete(id); plans.delete(id); expiring.delete(LOCK_PREFIX + id); expiring.delete(KICK_PREFIX + id); controls.delete(id); },
    async addUserJob(userId, id) { (userJobs.get(userId) ?? userJobs.set(userId, new Set()).get(userId)!).add(id); },
    async removeUserJob(userId, id) { userJobs.get(userId)?.delete(id); },
    async listUserJobIds(userId) { return Array.from(userJobs.get(userId) ?? []); },
    async addActiveJob(id) { active.add(id); },
    async removeActiveJob(id) { active.delete(id); },
    async getActiveJobIds() { return Array.from(active); },
    async acquireLock(id, ttl) {
      if (live(LOCK_PREFIX + id)) return false;
      expiring.set(LOCK_PREFIX + id, now() + ttl * 1000);
      return true;
    },
    async releaseLock(id) { expiring.delete(LOCK_PREFIX + id); },
    async tryScheduleKick(id, ttl) {
      if (live(KICK_PREFIX + id)) return false;
      expiring.set(KICK_PREFIX + id, now() + ttl * 1000);
      return true;
    },
    async setControl(id, command) { controls.set(id, command); },
    async getControl(id) { return controls.get(id) ?? null; },
    async clearControl(id) { controls.delete(id); },
  };
}

let _store: SyncStore | null = null;

/** The process-wide store: Redis when configured, otherwise memory. */
export function getStore(): SyncStore {
  if (_store) return _store;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  _store = url && token ? createRedisStore(new Redis({ url, token })) : createMemoryStore();
  return _store;
}

export function hasRedis(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

export function createJobId(): string {
  return `sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
