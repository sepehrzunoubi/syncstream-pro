import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { hasRedis } from "./sync-store";
import { log, uidTag } from "./log";

/**
 * Fixed-window rate limiting keyed by a string: the signed-in user's id when
 * there is one, else the client IP. Upstash Redis in production (one Lua
 * round trip per check), a bounded in-memory map otherwise. A failing store
 * never blocks a request: the limiter fails open and logs the error.
 *
 * RATE_LIMIT_DISABLED=1 turns every check into a pass (local dev, tests).
 */

export interface LimitOptions {
  /** Requests allowed per window */
  max: number;
  windowMs: number;
}

export interface LimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Wall-clock ms when the window ends and the budget is whole again */
  resetAt: number;
}

export interface LimitStore {
  /** Count one hit on `key`; the count and when its window ends */
  hit(key: string, windowMs: number, now: number): Promise<{ count: number; resetAt: number }>;
}

const KEY_PREFIX = "rl:";
/** INCR + PEXPIRE on first hit + PTTL, in one round trip */
const HIT_SCRIPT =
  "local c = redis.call('INCR', KEYS[1]) " +
  "if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end " +
  "local ttl = redis.call('PTTL', KEYS[1]) " +
  "if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end " +
  "return {c, ttl}";

export function createRedisLimitStore(redis: Redis): LimitStore {
  return {
    async hit(key, windowMs, now) {
      const res = (await redis.eval(HIT_SCRIPT, [KEY_PREFIX + key], [String(windowMs)])) as [number, number] | number[];
      const count = Number(res[0]);
      const ttl = Number(res[1]);
      return { count, resetAt: now + (ttl > 0 ? ttl : windowMs) };
    },
  };
}

/** How many keys the memory store keeps before it evicts the oldest */
export const MEMORY_MAX_KEYS = 10_000;
const SWEEP_EVERY_MS = 60_000;

export function createMemoryLimitStore(maxKeys = MEMORY_MAX_KEYS): LimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;
  const sweep = (now: number) => {
    lastSweep = now;
    for (const [k, w] of Array.from(windows)) if (w.resetAt <= now) windows.delete(k);
  };
  return {
    async hit(key, windowMs, now) {
      if (now - lastSweep >= SWEEP_EVERY_MS) sweep(now);
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        if (!w && windows.size >= maxKeys) {
          sweep(now);
          // Still full: drop the oldest entries (Map iterates in insertion order)
          for (const k of Array.from(windows.keys())) {
            if (windows.size < maxKeys) break;
            windows.delete(k);
          }
        }
        if (w) windows.delete(key); // re-insert so it moves to the young end
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      w.count++;
      return { count: w.count, resetAt: w.resetAt };
    },
  };
}

export interface Limiter {
  limit(key: string, opts: LimitOptions): Promise<LimitResult>;
}

export function createLimiter(store: LimitStore, now: () => number = Date.now): Limiter {
  return {
    async limit(key, { max, windowMs }) {
      try {
        const { count, resetAt } = await store.hit(key, windowMs, now());
        return { ok: count <= max, limit: max, remaining: Math.max(0, max - count), resetAt };
      } catch (err) {
        // Fail open: a broken limiter must not take the product down
        log.warn("rate_limit.store_error", { key: key.split(":")[0], err: err instanceof Error ? err.message : String(err) });
        return { ok: true, limit: max, remaining: max, resetAt: now() + windowMs };
      }
    },
  };
}

let _limiter: Limiter | null = null;

/** The process-wide limiter: Redis when configured, otherwise memory. */
export function getLimiter(): Limiter {
  if (_limiter) return _limiter;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  _limiter = createLimiter(hasRedis() && url && token ? createRedisLimitStore(new Redis({ url, token })) : createMemoryLimitStore());
  return _limiter;
}

export function rateLimitDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === "1";
}

/** Count one request against `key` and say whether it is still within budget. */
export async function limit(key: string, opts: LimitOptions): Promise<LimitResult> {
  if (rateLimitDisabled()) return { ok: true, limit: opts.max, remaining: opts.max, resetAt: Date.now() + opts.windowMs };
  return getLimiter().limit(key, opts);
}

/** The first hop of x-forwarded-for, else x-real-ip, else "unknown". */
export function clientIp(req: { headers: Headers }): string {
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = req.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : "unknown";
}

/** `u:<uid tag>` for a signed-in user, else `ip:<address>` */
export function clientKey(req: { headers: Headers }, userId?: string | null): string {
  return userId ? `u:${uidTag(userId, 16)}` : `ip:${clientIp(req)}`;
}

export interface RouteLimit extends LimitOptions {
  /** Limit per user when given, per client IP otherwise */
  userId?: string | null;
}

export function rateLimitHeaders(r: LimitResult): Record<string, string> {
  const retryAfter = Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000));
  return {
    "X-RateLimit-Limit": String(r.limit),
    "X-RateLimit-Remaining": String(r.remaining),
    "X-RateLimit-Reset": String(Math.ceil(r.resetAt / 1000)),
    ...(r.ok ? {} : { "Retry-After": String(retryAfter) }),
  };
}

/**
 * The 429 response when the caller is over `bucket`'s budget, else null.
 *
 *   const limited = await rateLimited(req, "docs.edit", { max: 120, windowMs: 60_000, userId: user.userId });
 *   if (limited) return limited;
 */
export async function rateLimited(req: { headers: Headers }, bucket: string, opts: RouteLimit): Promise<NextResponse | null> {
  const key = `${bucket}:${clientKey(req, opts.userId)}`;
  const result = await limit(key, opts);
  if (result.ok) return null;
  const seconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  log.warn("rate_limit.hit", { bucket, key: key.slice(bucket.length + 1), limit: result.limit, retryAfterSec: seconds });
  return NextResponse.json(
    { error: `Too many requests. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`, code: "rate_limited" },
    { status: 429, headers: rateLimitHeaders(result) }
  );
}
