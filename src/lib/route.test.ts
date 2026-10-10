import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import { requestUid, withRoute } from "./route";
import { setLogSink, uidTag, type LogRecord } from "./log";
import { sign } from "./secret";
import type { ReportContext } from "./monitor";

test("a handler that returns passes its response through untouched", async () => {
  setLogSink(() => {});
  try {
    const reports: unknown[] = [];
    const GET = withRoute(async () => NextResponse.json({ hi: 1 }, { status: 201 }), { report: async (e) => { reports.push(e); return true; } });
    const res = await GET(new NextRequest("http://localhost/api/thing"), undefined);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { hi: 1 });
    assert.equal(reports.length, 0);
  } finally {
    setLogSink(null);
  }
});

test("an unhandled error becomes a JSON 500 and is reported with route, method and latency", async () => {
  setLogSink(() => {});
  try {
    const reports: { err: unknown; ctx: ReportContext }[] = [];
    const POST = withRoute(
      async () => { throw new Error("kaboom with a token ya29.x"); },
      { report: async (err, ctx) => { reports.push({ err, ctx }); return true; } }
    );
    const res = await POST(new NextRequest("http://localhost/api/docs/edit?x=1", { method: "POST" }), undefined);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal error" });
    assert.equal(reports.length, 1);
    assert.equal((reports[0].err as Error).message, "kaboom with a token ya29.x");
    assert.equal(reports[0].ctx.event, "route.failed");
    assert.equal(reports[0].ctx.route, "/api/docs/edit");
    assert.equal(reports[0].ctx.method, "POST");
    assert.equal(reports[0].ctx.status, 500);
    assert.equal(typeof reports[0].ctx.ms, "number");
    assert.equal(reports[0].ctx.uid, "anon");
  } finally {
    setLogSink(null);
  }
});

test("the default reporter logs a structured error line (no webhook configured)", async () => {
  const records: LogRecord[] = [];
  setLogSink((rec) => records.push(rec));
  const prev = process.env.ERROR_WEBHOOK_URL;
  delete process.env.ERROR_WEBHOOK_URL;
  try {
    const GET = withRoute(async () => { throw new TypeError("bad"); }, { name: "/api/named" });
    const res = await GET(new NextRequest("http://localhost/api/whatever"), undefined);
    assert.equal(res.status, 500);
    const line = records.find((r) => r.event === "route.failed");
    assert.ok(line);
    assert.equal(line.level, "error");
    assert.equal(line.route, "/api/named");
    assert.equal((line.err as { name: string }).name, "TypeError");
  } finally {
    if (prev !== undefined) process.env.ERROR_WEBHOOK_URL = prev;
    setLogSink(null);
  }
});

test("logSuccess writes one route.ok line with status and ms", async () => {
  const records: LogRecord[] = [];
  setLogSink((rec) => records.push(rec));
  try {
    const GET = withRoute(async () => new Response(null, { status: 204 }), { logSuccess: true });
    await GET(new NextRequest("http://localhost/api/sync/start"), undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, "route.ok");
    assert.equal(records[0].route, "/api/sync/start");
    assert.equal(records[0].status, 204);
    assert.equal(typeof records[0].ms, "number");
  } finally {
    setLogSink(null);
  }
});

test("requestUid tags a validly signed uid cookie and ignores a forged or missing one", () => {
  const prev = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-secret";
  try {
    const good = new NextRequest("http://localhost/x", { headers: { cookie: `ss_uid=${sign("1234567890", "uid")}` } });
    assert.equal(requestUid(good), uidTag("1234567890"));
    const forged = new NextRequest("http://localhost/x", { headers: { cookie: "ss_uid=1234567890.notasignature" } });
    assert.equal(requestUid(forged), "anon");
    assert.equal(requestUid(new NextRequest("http://localhost/x")), "anon");
  } finally {
    if (prev === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = prev;
  }
});
