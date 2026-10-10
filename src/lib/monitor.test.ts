import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitor, type WebhookPayload } from "./monitor";
import { setLogSink, type LogRecord } from "./log";

function fakeFetch(status = 200) {
  const calls: { url: string; payload: WebhookPayload; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), payload: JSON.parse(String(init?.body)), init: init ?? {} });
    return new Response("ok", { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

test("reportError always logs a structured error line, with or without a webhook", async () => {
  const records: LogRecord[] = [];
  setLogSink((rec) => records.push(rec));
  try {
    const monitor = createMonitor({ webhookUrl: null });
    const sent = await monitor.reportError(new Error("db down"), { event: "route.failed", route: "/api/x", method: "GET", uid: "abc" });
    assert.equal(sent, false);
    assert.equal(records.length, 1);
    assert.equal(records[0].level, "error");
    assert.equal(records[0].event, "route.failed");
    assert.equal(records[0].route, "/api/x");
    assert.equal(records[0].uid, "abc");
    assert.equal((records[0].err as { message: string }).message, "db down");
  } finally {
    setLogSink(null);
  }
});

test("the webhook gets a compact payload with text plus structured fields", async () => {
  setLogSink(() => {});
  try {
    const { calls, fetchFn } = fakeFetch();
    const monitor = createMonitor({ fetch: fetchFn, webhookUrl: "https://hooks.example.test/abc", now: () => 1_700_000_000_000 });
    const err = new Error("Google said no for bob@example.com");
    const sent = await monitor.reportError(err, { event: "sync.failed", route: "/api/sync/process", method: "POST", jobId: "sync_1", accessToken: "secret" });
    assert.equal(sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hooks.example.test/abc");
    assert.equal(calls[0].init.method, "POST");
    assert.ok(calls[0].init.signal instanceof AbortSignal, "has a timeout signal");
    const p = calls[0].payload;
    assert.equal(p.service, "syncstream");
    assert.equal(p.event, "sync.failed");
    assert.equal(p.message, "Google said no for [email]");
    assert.match(p.text, /^\[syncstream \w+\] sync\.failed at POST \/api\/sync\/process: Google said no for \[email\]$/);
    assert.equal(typeof p.env, "string");
    assert.ok(typeof p.stack === "string" && p.stack.length <= 1500);
    assert.equal(p.context.jobId, "sync_1");
    assert.equal(p.context.accessToken, "[redacted]");
    assert.equal(p.ts, "2023-11-14T22:13:20.000Z");
    assert.equal(JSON.stringify(p).includes("secret"), false);
  } finally {
    setLogSink(null);
  }
});

test("the same message on the same route is sent once a minute; other errors still go out", async () => {
  setLogSink(() => {});
  try {
    let t = 0;
    const { calls, fetchFn } = fakeFetch();
    const monitor = createMonitor({ fetch: fetchFn, webhookUrl: "https://hooks.example.test/x", now: () => t });
    const ctx = { route: "/api/docs/edit" };
    assert.equal(await monitor.reportError(new Error("boom"), ctx), true);
    for (let i = 0; i < 50; i++) {
      t += 100;
      assert.equal(await monitor.reportError(new Error("boom"), ctx), false);
    }
    assert.equal(calls.length, 1);
    // A different message, or the same message elsewhere, is new
    assert.equal(await monitor.reportError(new Error("other"), ctx), true);
    assert.equal(await monitor.reportError(new Error("boom"), { route: "/api/docs/pages" }), true);
    assert.equal(calls.length, 3);
    // After the window the first one may be sent again
    t += 60_000;
    assert.equal(await monitor.reportError(new Error("boom"), ctx), true);
    assert.equal(calls.length, 4);
  } finally {
    setLogSink(null);
  }
});

test("a failing or rejecting webhook never throws and is logged as a warning", async () => {
  const records: LogRecord[] = [];
  setLogSink((rec) => records.push(rec));
  try {
    const throwing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const m1 = createMonitor({ fetch: throwing, webhookUrl: "https://hooks.example.test/y" });
    assert.equal(await m1.reportError(new Error("x"), {}), false);
    assert.ok(records.some((r) => r.event === "monitor.webhook_failed" && r.level === "warn"));

    const { fetchFn } = fakeFetch(500);
    const m2 = createMonitor({ fetch: fetchFn, webhookUrl: "https://hooks.example.test/z" });
    assert.equal(await m2.reportError(new Error("y"), {}), false);
    assert.ok(records.some((r) => r.event === "monitor.webhook_rejected" && r.status === 500));
  } finally {
    setLogSink(null);
  }
});

test("a slow webhook is abandoned after the timeout", async () => {
  setLogSink(() => {});
  try {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const monitor = createMonitor({ fetch: hanging, webhookUrl: "https://hooks.example.test/slow", timeoutMs: 20 });
    const t0 = Date.now();
    assert.equal(await monitor.reportError(new Error("slow"), {}), false);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    setLogSink(null);
  }
});

test("non-Error values are reported too", async () => {
  setLogSink(() => {});
  try {
    const { calls, fetchFn } = fakeFetch();
    const monitor = createMonitor({ fetch: fetchFn, webhookUrl: "https://hooks.example.test/s" });
    await monitor.reportError("just a string", { route: "/r" });
    await monitor.reportError({ code: 7 }, { route: "/r" });
    assert.equal(calls[0].payload.message, "just a string");
    assert.equal(calls[1].payload.message, '{"code":7}');
    assert.equal(calls[1].payload.stack, undefined);
  } finally {
    setLogSink(null);
  }
});
