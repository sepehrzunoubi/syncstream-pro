import { Redis } from "@upstash/redis";
import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { seal, unseal } from "./secret";
import type { DripAction, StreamEvent } from "./drip-engine";
import type { DocListState, RichFormat } from "./rich-text";
import type { BreakEdit } from "./breaks";
import type { Workbook } from "./sheets/model";
import type { PlanSection } from "./sheets/order";
import type { Step } from "./sheets/steps";

// ── Types ──────────────────────────────────────────────────────────────────

export type JobStatus = "scheduled" | "pending" | "running" | "paused" | "done" | "error" | "cancelled";

/** Description of a sync, written at start; only its breaks change after (see breaks.ts) */
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
  /**
   * Additions to an existing document: the source text is these segments
   * back to back, each typed at its own spot, top to bottom.
   */
  segments?: PlanSegment[];
  /**
   * A spreadsheet sync: the workbook being built in the Google Sheet and its steps, one per action
   * (an action's text is empty; what a step counts for in the progress is in `units`).
   */
  sheet?: SheetPlanData;
}

export interface SheetPlanData {
  workbook: Workbook;
  steps: Step[];
  units: number[];
  sections: PlanSection[];
  /** Compare & Sync: the spreadsheet held everything no step sets before the sync began */
  baseline?: true;
}

export interface PlanSegment {
  /** Source offsets [start, end) */
  start: number;
  end: number;
  /** "inline": typed where it goes. "before": a new paragraph is opened there first. */
  mode: "inline" | "before";
  /** Formatting of this segment's text: line k is paragraph k */
  format: RichFormat;
  /** The tab it is typed into (a job typing into several tabs; absent: the job's tab) */
  tabId?: string;
}

/** Where a segment is being typed: found again from the text before it on every write */
export interface SpotState {
  /** Document text just before the spot, as it will be once earlier segments are typed */
  ctx: string;
  /** Expected index of the next character */
  cursor: number;
  opened: boolean;
  /** List state of the paragraph being typed into */
  docList?: DocListState;
  /** Character styles of the text already typed here have been checked (see the runner) */
  restyled?: boolean;
  /** The tab the spot is in (a job typing into several tabs) */
  tabId?: string;
}

/** Small mutable state, rewritten as the job progresses. */
export interface SyncJob {
  id: string;
  userId: string;
  documentId: string;
  documentName: string;
  /** "sheet": a spreadsheet built in a Google Sheet (`documentId` is the spreadsheet's). Absent: text typed into a Google Doc */
  kind?: "sheet";
  /** The tab typed into, and its name (absent: a document read without its tabs, or an older job) */
  tabId?: string;
  tabTitle?: string;
  /**
   * A job typing into several tabs: each of them, in the order they are typed. Each segment names
   * its own tab; `tabId` is the first.
   */
  tabs?: { id: string; title: string }[];
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
  /** Paused: what was left of the current action's wait, so resuming continues it */
  waitLeftMs?: number;
  /** typo sub-step: 0 = nothing typed, 1 = wrong chars in doc, 2 = wrong chars deleted */
  typoSubStep: number;
  typoCharsInDoc: number;
  /** Idempotency marker for the Docs write that may or may not have landed */
  inFlight?: { action: number; step: number; text: string };
  /** Bumped on resume so stale queue messages are ignored */
  generation: number;
  /** List state of the paragraph being typed into (formatted plans only) */
  docList?: DocListState;
  /** Where a sync into an existing document types. Absent: it appends at the end. */
  anchor?: JobAnchor;
  /** Per-segment typing positions, for plans with segments */
  spots?: SpotState[];
  failures: number;
  /** Consecutive quota waits (429), separate from failures */
  quotaWaits?: number;
  /** When the last action was due: the schedule is anchored here, not on the clock */
  lastDueAt?: number;
  /** Counts hand-offs; a delivery made for an older tick is a duplicate */
  tick?: number;

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
  /** Where each of `breaks` starts, in source characters typed before it (absent on older jobs) */
  breakAt?: number[];
  /** Counts changes to the breaks, so two open tabs can't overwrite each other's */
  breaksVersion?: number;
  /** Breaks can be added, changed or removed from this many source characters on */
  editableFrom?: number;
  completedBreaks: number[];
  nextBreakAction?: number;
  nextBreakAt?: number;
  lastUpdate: number;
  error?: string;
  /**
   * A spreadsheet sync: edits Google Sheets refused (a number format it doesn't take, say). Each was
   * left out and the sync went on; `notes` says what the first few were.
   */
  refused?: { count: number; notes: string[] };
}

/** What the dashboard sees: a job without credentials. */
/**
 * A typing position inside an existing document. The first write opens a new
 * paragraph there ("before": at the start of the paragraph at the position,
 * "after": after the paragraph that ends there). Later writes find their
 * place again from the text just before it, so edits elsewhere in the doc
 * while the sync runs do not throw it off.
 */
export interface JobAnchor {
  mode: "before" | "after";
  /** Document text just before the typing position when the sync started */
  ctx: string;
  /** Expected index of the next character, used to pick between repeated matches */
  cursor: number;
  /** True once the new paragraph exists */
  opened: boolean;
}

/** What the running view shows around the sync: the document's paragraphs before and after it */
export interface SyncContext {
  /** The editor document at start, additions marked */
  doc?: unknown;
  /** For each segment, the editor tokens its text came from */
  ranges?: [number, number][];
  /**
   * A job typing into several tabs: each tab's editor document, in typing order. `first` is the
   * index of the tab's first segment; `ranges` are its segments' tokens in its `doc`.
   */
  tabs?: { tabId: string; title: string; first: number; doc: unknown; ranges: [number, number][] }[];
  /** Older syncs: the document's paragraphs before and after the text */
  before?: unknown[];
  after?: unknown[];
}

export type PublicJob = Omit<SyncJob, "accessToken" | "refreshToken" | "inFlight" | "docList" | "anchor" | "spots">;

export function toPublicJob(job: SyncJob): PublicJob {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { accessToken, refreshToken, inFlight, docList, anchor, spots, ...rest } = job;
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

/** One line of the sync history: a sync as it was last heard of, kept after the sync itself is gone */
export interface HistoryEntry {
  id: string;
  kind: "doc" | "sheet";
  documentId: string;
  documentName: string;
  tabId?: string;
  tabTitle?: string;
  status: JobStatus;
  createdAt: number;
  startAt: number;
  startedAt?: number;
  finishedAt?: number;
  totalChars: number;
  charsSent: number;
  /** Words in the document when it started and when last counted (documents only) */
  words?: number;
  error?: string;
}

export function historyOf(job: SyncJob | PublicJob): HistoryEntry {
  const words = job.liveWordCount != null ? Math.max(0, job.liveWordCount - job.baselineWordCount) : undefined;
  return {
    id: job.id, kind: job.kind === "sheet" ? "sheet" : "doc", documentId: job.documentId, documentName: job.documentName,
    ...(job.tabId ? { tabId: job.tabId } : {}), ...(job.tabTitle ? { tabTitle: job.tabTitle } : {}),
    status: job.status, createdAt: job.createdAt, startAt: job.startAt,
    ...(job.startedAt != null ? { startedAt: job.startedAt } : {}), ...(job.finishedAt != null ? { finishedAt: job.finishedAt } : {}),
    totalChars: job.totalChars, charsSent: job.charsSent,
    ...(words != null && job.kind !== "sheet" ? { words } : {}), ...(job.error ? { error: job.error.slice(0, 300) } : {}),
  };
}

/** Syncs the history keeps for one person; the oldest go first */
export const MAX_HISTORY = 500;

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
const CONTEXT_PREFIX = "syncctx:";
const USER_JOBS_PREFIX = "userjobs:";
const LOCK_PREFIX = "synclock:";
const KICK_PREFIX = "synckick:";
const CONTROL_PREFIX = "syncctl:";
const BREAKS_PREFIX = "syncbrk:";
const HISTORY_PREFIX = "synchistory:";

export type ControlCommand = "pause" | "cancel";
const ACTIVE_JOBS_KEY = "syncjobs:active";

export interface SyncStore {
  getJob(id: string): Promise<SyncJob | null>;
  setJob(job: SyncJob): Promise<void>;
  getPlan(id: string): Promise<SyncPlan | null>;
  setPlan(plan: SyncPlan): Promise<void>;
  getContext(id: string): Promise<SyncContext | null>;
  setContext(id: string, context: SyncContext): Promise<void>;
  deleteJob(id: string): Promise<void>;
  addUserJob(userId: string, id: string): Promise<void>;
  removeUserJob(userId: string, id: string): Promise<void>;
  listUserJobIds(userId: string): Promise<string[]>;
  addActiveJob(id: string): Promise<void>;
  removeActiveJob(id: string): Promise<void>;
  getActiveJobIds(): Promise<string[]>;
  /** SET NX EX: the lock's token when this caller now owns it, else null */
  acquireLock(id: string, ttlSeconds: number): Promise<string | null>;
  /** Releases the lock only while `token` still owns it */
  releaseLock(id: string, token: string): Promise<void>;
  /** Keeps the lock alive while `token` still owns it; false when it was lost */
  extendLock(id: string, ttlSeconds: number, token: string): Promise<boolean>;
  /** True at most once per ttl window, used to avoid scheduling duplicate re-kicks */
  tryScheduleKick(id: string, ttlSeconds: number): Promise<boolean>;
  /** A pause/cancel request left for the running worker to apply (it is the only writer while locked) */
  setControl(id: string, command: ControlCommand): Promise<void>;
  getControl(id: string): Promise<ControlCommand | null>;
  clearControl(id: string): Promise<void>;
  /** A change to the breaks left for the running worker to apply, like a control request */
  setBreakEdit(id: string, edit: BreakEdit): Promise<void>;
  getBreakEdit(id: string): Promise<BreakEdit | null>;
  clearBreakEdit(id: string): Promise<void>;
  /** The sync history: kept for good (no expiry), one entry per sync */
  putHistory(userId: string, entry: HistoryEntry): Promise<void>;
  listHistory(userId: string): Promise<HistoryEntry[]>;
  /** Forget these syncs (all of them when no ids are given) */
  removeHistory(userId: string, ids?: string[]): Promise<void>;
}

/**
 * Upstash takes at most 1 MB in one request, and a plan or context is stored in one. They are
 * stored packed (gzip, then base64, under `z`): a sync's actions and text shrink 3 to 5 times.
 */
export const MAX_STORED_JSON = 950_000;
interface Packed { z: string }

export function packValue(value: unknown): Packed {
  return { z: gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64") };
}

/** A stored value as it was written: packed, or plain (stored before packing) */
export function unpackValue<T>(stored: unknown): T | null {
  if (stored == null) return null;
  const z = (stored as Partial<Packed>).z;
  if (typeof z === "string" && Object.keys(stored as object).length === 1) return JSON.parse(gunzipSync(Buffer.from(z, "base64")).toString("utf8")) as T;
  return stored as T;
}

/** What a value takes in its one request to Redis, packed */
export const storedSize = (value: unknown): number => JSON.stringify(packValue(value)).length;

function createRedisStore(redis: Redis): SyncStore {
  return {
    async getJob(id) {
      const job = await redis.get<SyncJob>(JOB_PREFIX + id);
      // Google tokens are sealed at rest
      return job ? { ...job, accessToken: unseal(job.accessToken), refreshToken: unseal(job.refreshToken) } : null;
    },
    async setJob(job) {
      await redis.set(JOB_PREFIX + job.id, { ...job, accessToken: seal(job.accessToken), refreshToken: seal(job.refreshToken) }, { ex: TTL_SECONDS });
      // The plan and context live as long as the job does
      await Promise.all([redis.expire(PLAN_PREFIX + job.id, TTL_SECONDS), redis.expire(CONTEXT_PREFIX + job.id, TTL_SECONDS)]);
    },
    async getPlan(id) {
      return unpackValue<SyncPlan>(await redis.get(PLAN_PREFIX + id));
    },
    async setPlan(plan) {
      await redis.set(PLAN_PREFIX + plan.id, packValue(plan), { ex: TTL_SECONDS });
    },
    async getContext(id) {
      return unpackValue<SyncContext>(await redis.get(CONTEXT_PREFIX + id));
    },
    async setContext(id, context) {
      await redis.set(CONTEXT_PREFIX + id, packValue(context), { ex: TTL_SECONDS });
    },
    async deleteJob(id) {
      await redis.del(JOB_PREFIX + id, PLAN_PREFIX + id, CONTEXT_PREFIX + id, LOCK_PREFIX + id, KICK_PREFIX + id, CONTROL_PREFIX + id, BREAKS_PREFIX + id);
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
      const token = randomBytes(12).toString("base64url");
      const res = await redis.set(LOCK_PREFIX + id, token, { nx: true, ex: ttlSeconds });
      return res === "OK" ? token : null;
    },
    async releaseLock(id, token) {
      // Compare and delete: never release a lock another worker took after ours expired
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", [LOCK_PREFIX + id], [token]);
    },
    async extendLock(id, ttlSeconds, token) {
      const res = await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) end return 0", [LOCK_PREFIX + id], [token, String(ttlSeconds)]);
      return res === 1;
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
    async setBreakEdit(id, edit) {
      await redis.set(BREAKS_PREFIX + id, edit, { ex: 3600 });
    },
    async getBreakEdit(id) {
      return (await redis.get<BreakEdit>(BREAKS_PREFIX + id)) ?? null;
    },
    async clearBreakEdit(id) {
      await redis.del(BREAKS_PREFIX + id);
    },
    async putHistory(userId, entry) {
      await redis.hset(HISTORY_PREFIX + userId, { [entry.id]: entry });
    },
    async listHistory(userId) {
      const all = (await redis.hgetall<Record<string, HistoryEntry>>(HISTORY_PREFIX + userId)) ?? {};
      return Object.values(all).filter((e): e is HistoryEntry => !!e && typeof e === "object" && typeof e.id === "string");
    },
    async removeHistory(userId, ids) {
      if (!ids) await redis.del(HISTORY_PREFIX + userId);
      else if (ids.length) await redis.hdel(HISTORY_PREFIX + userId, ...ids);
    },
  };
}

export function createMemoryStore(now: () => number = Date.now): SyncStore {
  let lockSeq = 0;
  const lockOwner = new Map<string, string>();
  const jobs = new Map<string, SyncJob>();
  const plans = new Map<string, SyncPlan>();
  const contexts = new Map<string, SyncContext>();
  const userJobs = new Map<string, Set<string>>();
  const active = new Set<string>();
  const expiring = new Map<string, number>(); // key → expiry ms
  const controls = new Map<string, ControlCommand>();
  const breakEdits = new Map<string, BreakEdit>();
  const history = new Map<string, Map<string, HistoryEntry>>();
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
    async getContext(id) { return structuredClone(contexts.get(id) ?? null); },
    async setContext(id, context) { contexts.set(id, structuredClone(context)); },
    async deleteJob(id) { jobs.delete(id); plans.delete(id); contexts.delete(id); expiring.delete(LOCK_PREFIX + id); expiring.delete(KICK_PREFIX + id); controls.delete(id); breakEdits.delete(id); },
    async addUserJob(userId, id) { (userJobs.get(userId) ?? userJobs.set(userId, new Set()).get(userId)!).add(id); },
    async removeUserJob(userId, id) { userJobs.get(userId)?.delete(id); },
    async listUserJobIds(userId) { return Array.from(userJobs.get(userId) ?? []); },
    async addActiveJob(id) { active.add(id); },
    async removeActiveJob(id) { active.delete(id); },
    async getActiveJobIds() { return Array.from(active); },
    async acquireLock(id, ttl) {
      if (live(LOCK_PREFIX + id)) return null;
      expiring.set(LOCK_PREFIX + id, now() + ttl * 1000);
      const token = `t${++lockSeq}`;
      lockOwner.set(id, token);
      return token;
    },
    async releaseLock(id, token) {
      // Only the current owner releases; a worker whose lock expired and was taken over leaves it alone
      if (lockOwner.get(id) !== token) return;
      expiring.delete(LOCK_PREFIX + id);
      lockOwner.delete(id);
    },
    async extendLock(id, ttl, token) {
      if (!live(LOCK_PREFIX + id) || lockOwner.get(id) !== token) return false;
      expiring.set(LOCK_PREFIX + id, now() + ttl * 1000);
      return true;
    },
    async tryScheduleKick(id, ttl) {
      if (live(KICK_PREFIX + id)) return false;
      expiring.set(KICK_PREFIX + id, now() + ttl * 1000);
      return true;
    },
    async setControl(id, command) { controls.set(id, command); },
    async getControl(id) { return controls.get(id) ?? null; },
    async clearControl(id) { controls.delete(id); },
    async setBreakEdit(id, edit) { breakEdits.set(id, structuredClone(edit)); },
    async getBreakEdit(id) { return structuredClone(breakEdits.get(id) ?? null); },
    async clearBreakEdit(id) { breakEdits.delete(id); },
    async putHistory(userId, entry) { (history.get(userId) ?? history.set(userId, new Map()).get(userId)!).set(entry.id, structuredClone(entry)); },
    async listHistory(userId) { return Array.from(history.get(userId)?.values() ?? []).map((e) => structuredClone(e)); },
    async removeHistory(userId, ids) { if (!ids) history.delete(userId); else for (const id of ids) history.get(userId)?.delete(id); },
  };
}

/** Whether a job, as it is being written, is worth a line in the history: a start, a pause, or its end */
export function recordsHistory(job: SyncJob): boolean {
  return isTerminal(job.status) || job.status === "paused" || ((job.status === "pending" || job.status === "scheduled") && job.currentAction === 0);
}

/**
 * The store, keeping the sync history as jobs are written: a line when a sync starts and when it
 * pauses or ends. A history that can't be written never fails the sync.
 */
export function withHistory(store: SyncStore): SyncStore {
  return {
    ...store,
    async setJob(job) {
      await store.setJob(job);
      if (recordsHistory(job)) { try { await store.putHistory(job.userId, historyOf(job)); } catch { /* the job itself is saved */ } }
    },
  };
}

let _store: SyncStore | null = null;

/** The process-wide store: Redis when configured, otherwise memory. */
export function getStore(): SyncStore {
  if (_store) return _store;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  _store = withHistory(url && token ? createRedisStore(new Redis({ url, token })) : createMemoryStore());
  return _store;
}

export function hasRedis(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

export function createJobId(): string {
  return `sync_${randomBytes(12).toString("base64url")}`;
}
