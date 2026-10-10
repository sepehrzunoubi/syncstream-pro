import { test } from "node:test";
import assert from "node:assert/strict";
import { errorFields, formatLine, log, makeRecord, redact, setLogSink, startTimer, timed, uidTag, type LogRecord } from "./log";

function capture(): { records: LogRecord[]; lines: string[]; stop: () => void } {
  const records: LogRecord[] = [];
  const lines: string[] = [];
  setLogSink((rec, line) => { records.push(rec); lines.push(line); });
  return { records, lines, stop: () => setLogSink(null) };
}

test("a log call is one JSON line with ts, level, event and the fields", () => {
  const cap = capture();
  try {
    log.info("sync.started", { job: "sync_1", chars: 42 });
    assert.equal(cap.records.length, 1);
    const rec = cap.records[0];
    assert.equal(rec.level, "info");
    assert.equal(rec.event, "sync.started");
    assert.equal(rec.job, "sync_1");
    assert.equal(rec.chars, 42);
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const json = formatLine(rec, true);
    assert.equal(json.includes("\n"), false);
    const parsed = JSON.parse(json);
    assert.deepEqual(Object.keys(parsed).slice(0, 3), ["ts", "level", "event"]);
    assert.equal(parsed.chars, 42);
  } finally {
    cap.stop();
  }
});

test("the development format is one readable line", () => {
  const rec = makeRecord("warn", "route.failed", { route: "/api/x", ms: 12, msg: "two words" });
  const line = formatLine(rec, false);
  assert.equal(line.includes("\n"), false);
  assert.match(line, /WARN\s+route\.failed route=\/api\/x ms=12 msg="two words"/);
});

test("secret-looking fields, emails and whole documents never reach the line", () => {
  const rec = makeRecord("info", "x", {
    accessToken: "ya29.secret",
    cookie: "a=b",
    email: "someone@example.com",
    note: "contact someone@example.com today",
    text: "x".repeat(5000),
    nested: { refreshToken: "r", ok: 1, who: "a.b@c.io" },
    list: ["p@q.org", 3],
  });
  const line = formatLine(rec, true);
  assert.equal(line.includes("ya29"), false);
  assert.equal(line.includes("a=b"), false);
  assert.equal(line.includes("example.com"), false);
  assert.equal(line.includes("c.io"), false);
  assert.equal(line.includes("q.org"), false);
  assert.equal(rec.accessToken, "[redacted]");
  assert.equal(rec.email, "[redacted]");
  assert.equal(rec.note, "contact [email] today");
  assert.ok((rec.text as string).length < 500, "long strings are cut");
  assert.match(rec.text as string, /…\(5000 chars\)$/);
  assert.deepEqual(rec.nested, { refreshToken: "[redacted]", ok: 1, who: "[email]" });
  assert.deepEqual(rec.list, ["[email]", 3]);
});

test("redact leaves undefined out and keeps numbers, booleans and dates", () => {
  const d = new Date("2026-01-02T03:04:05.000Z");
  assert.deepEqual(redact({ a: undefined, n: 1, b: false, d }), { n: 1, b: false, d: "2026-01-02T03:04:05.000Z" });
});

test("uidTag is a short stable sha256 prefix and never the id itself", () => {
  const a = uidTag("1234567890");
  assert.equal(a.length, 10);
  assert.equal(a, uidTag("1234567890"));
  assert.notEqual(a, uidTag("1234567891"));
  assert.equal(a.includes("1234567890"), false);
  assert.equal(uidTag(""), "anon");
  assert.equal(uidTag(undefined), "anon");
  assert.equal(uidTag("x", 16).length, 16);
});

test("errors become name, message, code and a bounded stack", () => {
  const err = Object.assign(new Error("boom for bob@example.com"), { code: 429 });
  const f = errorFields(err);
  assert.equal(f.name, "Error");
  assert.equal(f.message, "boom for [email]");
  assert.equal(f.code, 429);
  assert.ok(typeof f.stack === "string" && (f.stack as string).length <= 2000);
  assert.equal(errorFields(err, false).stack, undefined);
  assert.deepEqual(errorFields("plain"), { message: "plain" });
  const cap = capture();
  try {
    log.error("x", { err });
    assert.equal((cap.records[0].err as { message: string }).message, "boom for [email]");
  } finally {
    cap.stop();
  }
});

test("startTimer and timed measure durations and keep the error", async () => {
  let t = 1000;
  const done = startTimer(() => t);
  t = 1234.6;
  assert.equal(done(), 235);

  const cap = capture();
  try {
    const v = await timed("op", async () => 7, { job: "j" });
    assert.equal(v, 7);
    assert.equal(cap.records[0].event, "op");
    assert.equal(cap.records[0].level, "info");
    assert.equal(typeof cap.records[0].ms, "number");
    await assert.rejects(timed("op2", async () => { throw new Error("nope"); }), /nope/);
    assert.equal(cap.records[1].level, "error");
    assert.equal((cap.records[1].err as { message: string }).message, "nope");
  } finally {
    cap.stop();
  }
});

test("LOG_LEVEL hides records below it", () => {
  const cap = capture();
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  try {
    log.info("hidden");
    log.debug("hidden");
    log.warn("shown");
    assert.deepEqual(cap.records.map((r) => r.event), ["shown"]);
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev;
    cap.stop();
  }
});
