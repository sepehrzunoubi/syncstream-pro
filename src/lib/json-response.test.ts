import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { NextRequest } from "next/server";
import { acceptsGzip, GZIP_FROM_BYTES, jsonReply } from "./json-response";
import { applyAuthCookies, UID_COOKIE } from "./auth";
import { sign } from "./secret";
import { buildDripPlan } from "./drip-engine";
import { buildSyncRecords } from "./sync-plan";
import { plainFormat } from "./rich-text";
import { getStore, MAX_STORED_JSON, storedSize } from "./sync-store";

// Cookies are signed with this; the store and the rate limiter are kept in memory (no Redis)
process.env.AUTH_SECRET = "json-response-test-secret";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const asking = (acceptEncoding?: string) => ({ headers: new Headers(acceptEncoding == null ? {} : { "accept-encoding": acceptEncoding }) });
/** A body of about `bytes` bytes of JSON */
const bodyOf = (bytes: number) => ({ text: "Пример текста, который повторяется. ".repeat(Math.ceil(bytes / 66)), n: 1 });

test("a small reply stays plain JSON, with its status and headers", async () => {
  const res = jsonReply(asking("gzip, deflate, br"), { ok: true, name: "Привет" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(res.headers.get("vary"), null);
  assert.equal(await res.text(), JSON.stringify({ ok: true, name: "Привет" }));
});

test("a large reply goes gzipped to a request that takes gzip, and unpacks to the same JSON", async () => {
  const body = bodyOf(3 * GZIP_FROM_BYTES);
  const json = JSON.stringify(body);
  assert.ok(Buffer.byteLength(json) > 3 * GZIP_FROM_BYTES);
  const res = jsonReply(asking("gzip, deflate, br, zstd"), body, { headers: { "Cache-Control": "no-store" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("vary") ?? "", /Accept-Encoding/i);
  const sent = Buffer.from(await res.arrayBuffer());
  assert.ok(sent.length < Buffer.byteLength(json) / 10, `${sent.length} bytes sent`);
  assert.equal(gunzipSync(sent).toString("utf8"), json);
});

test("a large reply stays plain JSON to a request that doesn't take gzip", async () => {
  const body = bodyOf(2 * GZIP_FROM_BYTES);
  for (const header of [undefined, "", "br", "identity", "gzip;q=0", "deflate, gzip;q=0, br"]) {
    const res = jsonReply(asking(header), body);
    assert.equal(res.headers.get("content-encoding"), null, String(header));
    assert.match(res.headers.get("vary") ?? "", /Accept-Encoding/i);
    assert.equal(await res.text(), JSON.stringify(body));
  }
});

test("Accept-Encoding: gzip by name or by *, unless its q is 0", () => {
  for (const yes of ["gzip", "GZIP", "deflate, gzip;q=0.5", "gzip; q=1.0", "*", "br, *;q=0.1", "x-gzip"]) assert.equal(acceptsGzip(yes), true, yes);
  for (const no of [null, undefined, "", "br", "deflate, br", "gzip;q=0", "*;q=0", "gzip;q=0, *", "identity"]) assert.equal(acceptsGzip(no), false, String(no));
});

test("cookies set on a gzipped reply go with it", async () => {
  const res = applyAuthCookies(jsonReply(asking("gzip"), bodyOf(2 * GZIP_FROM_BYTES)), {
    userId: "u1", accessToken: "a", refreshToken: "r",
    refreshed: { access_token: "fresh-token", expiry_date: Date.now() + 3_600_000 },
    uidToSet: "u1",
  });
  assert.equal(res.headers.get("content-encoding"), "gzip");
  const cookies = res.headers.getSetCookie().join("\n");
  assert.match(cookies, /google_access_token=fresh-token/);
  assert.match(cookies, new RegExp(`${UID_COOKIE}=u1\\.`));
});

test("/api/sync/source: a long sync's text and look come back gzipped, well under Vercel's 4.5 MB, and whole", async () => {
  const { GET } = await import("../app/api/sync/source/route");
  // A long list in Cyrillic, as the editor starts it: under a million characters, a plan Redis
  // takes, and over 4.5 MB as plain JSON (each paragraph's look goes with the text)
  const words = "один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать".split(" ");
  const lines = Array.from({ length: 45_000 }, (_, p) => Array.from({ length: 3 }, (_, k) => words[(p * 7 + k * 3) % words.length]).join(" "));
  const text = lines.join("\n");
  assert.ok(text.length < 1_000_000);
  const drip = buildDripPlan(text, { targetMinutes: null, breaks: [], typoFrequency: 0, seed: 1 });
  const { plan, job } = buildSyncRecords({ id: "sync_json_reply", userId: "u2", documentId: "doc-000000001", documentName: "Long", plan: drip, format: plainFormat(text), now: 0, accessToken: "a", refreshToken: "r", baselineWordCount: 0 });
  assert.ok(storedSize(plan) < MAX_STORED_JSON, `plan ${storedSize(plan)} packed`);
  const context = { doc: { type: "doc", content: [] }, ranges: [[0, 3]] as [number, number][] };
  const store = getStore();
  await store.setPlan(plan);
  await store.setJob(job);
  await store.setContext(job.id, context);
  const ask = (acceptEncoding?: string) => GET(new NextRequest(`http://localhost/api/sync/source?jobId=${job.id}`, {
    headers: { cookie: `google_access_token=a; ${UID_COOKIE}=${sign("u2", "uid")}`, ...(acceptEncoding ? { "accept-encoding": acceptEncoding } : {}) },
  }), {});
  const plain = await ask();
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get("content-encoding"), null);
  const plainBytes = Buffer.from(await plain.arrayBuffer());
  assert.ok(plainBytes.length > 4_718_592, `${plainBytes.length} bytes as plain JSON`);
  const packed = await ask("gzip, deflate, br, zstd");
  assert.equal(packed.status, 200);
  assert.equal(packed.headers.get("content-encoding"), "gzip");
  assert.equal(packed.headers.get("content-type"), "application/json");
  const sent = Buffer.from(await packed.arrayBuffer());
  assert.ok(sent.length < 1_000_000, `${sent.length} bytes sent`);
  // (compared as booleans: a failed comparison of texts this long takes minutes to describe)
  assert.ok(gunzipSync(sent).equals(plainBytes), "the same reply, unpacked");
  const got = JSON.parse(plainBytes.toString("utf8"));
  assert.ok(got.sourceText === text, "the whole text");
  assert.ok(JSON.stringify(got.format) === JSON.stringify(plan.format), "its look");
  assert.deepEqual(got.context, context);
  assert.equal(got.totalMs, plan.totalMs);
});
