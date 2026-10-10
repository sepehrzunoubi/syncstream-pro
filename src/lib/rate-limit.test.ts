import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clientIp,
  clientKey,
  createLimiter,
  createMemoryLimitStore,
  createRedisLimitStore,
  limit,
  rateLimited,
  rateLimitHeaders,
  type LimitStore,
} from "./rate-limit";
import { setLogSink, type LogRecord } from "./log";

const headers = (h: Record<string, string> = {}) => ({ headers: new Headers(h) });

test("fixed window: the budget runs out, then rolls over when the window ends", async () => {
  let t = 1_000_000;
  const limiter = createLimiter(createMemoryLimitStore(), () => t);
  const opts = { max: 3, windowMs: 60_000 };
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await limiter.limit("a", opts));
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
  assert.deepEqual(results.map((r) => r.remaining), [2, 1, 0, 0]);
  assert.equal(results[3].resetAt, 1_060_000);
  assert.equal(results[3].limit, 3);

  t = 1_059_999;
  assert.equal((await limiter.limit("a", opts)).ok, false);
  t = 1_060_000;
  const fresh = await limiter.limit("a", opts);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.remaining, 2);
  assert.equal(fresh.resetAt, 1_120_000);
});

test("keys are isolated from each other", async () => {
  const limiter = createLimiter(createMemoryLimitStore(), () => 5_000);
  const opts = { max: 1, windowMs: 1000 };
  assert.equal((await limiter.limit("x", opts)).ok, true);
  assert.equal((await limiter.limit("x", opts)).ok, false);
  assert.equal((await limiter.limit("y", opts)).ok, true);
});

test("the memory store stays bounded and sweeps expired windows", async () => {
  let t = 0;
  const store = createMemoryLimitStore(5);
  for (let i = 0; i < 5; i++) await store.hit(`k${i}`, 1000, t);
  // Full: a sixth key evicts the oldest (k0) rather than growing
  await store.hit("k5", 1000, t);
  assert.equal((await store.hit("k0", 1000, t)).count, 1, "k0 was evicted and starts again");
  // Expired windows go away on the periodic sweep
  t = 100_000;
  assert.equal((await store.hit("k5", 1000, t)).count, 1);
  assert.equal((await store.hit("k5", 1000, t)).count, 2);
});

test("a failing store fails open and logs a warning", async () => {
  const records: LogRecord[] = [];
  setLogSink((rec) => records.push(rec));
  try {
    const broken: LimitStore = { async hit() { throw new Error("redis down"); } };
    const limiter = createLimiter(broken, () => 10);
    const r = await limiter.limit("docs.edit:u:abc", { max: 5, windowMs: 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.remaining, 5);
    assert.equal(records.length, 1);
    assert.equal(records[0].level, "warn");
    assert.equal(records[0].event, "rate_limit.store_error");
    assert.deepEqual(records[0].err, { message: "redis down" });
  } finally {
    setLogSink(null);
  }
});

test("the Redis store makes one eval per hit and reads count and ttl from it", async () => {
  const calls: unknown[][] = [];
  const fakeRedis = {
    async eval(script: string, keys: string[], args: string[]) {
      calls.push([script, keys, args]);
      return [calls.length, 500];
    },
  };
  const store = createRedisLimitStore(fakeRedis as never);
  const r1 = await store.hit("b:u:1", 60_000, 1_000);
  assert.deepEqual(r1, { count: 1, resetAt: 1_500 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ["rl:b:u:1"]);
  assert.deepEqual(calls[0][2], ["60000"]);
  assert.match(calls[0][0] as string, /INCR[\s\S]*PEXPIRE[\s\S]*PTTL/);
  const r2 = await store.hit("b:u:1", 60_000, 1_000);
  assert.equal(r2.count, 2);
});

test("client key: user id when signed in (hashed), else the first forwarded hop, else x-real-ip", () => {
  assert.equal(clientIp(headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIp(headers({ "x-real-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(headers()), "unknown");
  const k = clientKey(headers({ "x-forwarded-for": "203.0.113.9" }), "1234567890");
  assert.match(k, /^u:[0-9a-f]{16}$/);
  assert.equal(k.includes("1234567890"), false);
  assert.equal(clientKey(headers({ "x-forwarded-for": "203.0.113.9" })), "ip:203.0.113.9");
});

test("rateLimited answers null within budget and a 429 with Retry-After and X-RateLimit headers over it", async () => {
  const prev = process.env.RATE_LIMIT_DISABLED;
  delete process.env.RATE_LIMIT_DISABLED;
  setLogSink(() => {});
  try {
    const req = headers({ "x-forwarded-for": "192.0.2.77" });
    const bucket = `test.bucket.${Date.now()}`;
    const opts = { max: 2, windowMs: 60_000 };
    assert.equal(await rateLimited(req, bucket, opts), null);
    assert.equal(await rateLimited(req, bucket, opts), null);
    const res = await rateLimited(req, bucket, opts);
    assert.ok(res, "third request is refused");
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.code, "rate_limited");
    assert.match(body.error, /Too many requests/);
    assert.equal(res.headers.get("X-RateLimit-Limit"), "2");
    assert.equal(res.headers.get("X-RateLimit-Remaining"), "0");
    const retry = Number(res.headers.get("Retry-After"));
    assert.ok(retry >= 1 && retry <= 60, `Retry-After ${retry}`);
    assert.ok(Number(res.headers.get("X-RateLimit-Reset")) > Date.now() / 1000 - 1);
    // Another client is not affected
    assert.equal(await rateLimited(headers({ "x-forwarded-for": "192.0.2.78" }), bucket, opts), null);
    // A signed-in user is keyed by id, not address
    assert.equal(await rateLimited(req, bucket, { ...opts, userId: "user-1" }), null);
  } finally {
    setLogSink(null);
    if (prev === undefined) delete process.env.RATE_LIMIT_DISABLED; else process.env.RATE_LIMIT_DISABLED = prev;
  }
});

test("RATE_LIMIT_DISABLED=1 passes everything", async () => {
  const prev = process.env.RATE_LIMIT_DISABLED;
  process.env.RATE_LIMIT_DISABLED = "1";
  try {
    for (let i = 0; i < 5; i++) assert.equal((await limit("off:k", { max: 1, windowMs: 1000 })).ok, true);
  } finally {
    if (prev === undefined) delete process.env.RATE_LIMIT_DISABLED; else process.env.RATE_LIMIT_DISABLED = prev;
  }
});

test("rateLimitHeaders only carries Retry-After when refused", () => {
  const ok = rateLimitHeaders({ ok: true, limit: 5, remaining: 4, resetAt: Date.now() + 10_000 });
  assert.equal(ok["Retry-After"], undefined);
  assert.equal(ok["X-RateLimit-Remaining"], "4");
  const no = rateLimitHeaders({ ok: false, limit: 5, remaining: 0, resetAt: Date.now() + 10_000 });
  assert.equal(no["Retry-After"], "10");
});
