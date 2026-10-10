import { createHash } from "node:crypto";

/**
 * Structured logging: one JSON line per call, `{ts, level, event, ...fields}`.
 * info/debug go to stdout, warn/error to stderr, so a log shipper can split
 * them. In development (and when LOG_PRETTY=1) the same record is printed as
 * one readable line instead.
 *
 * Never log tokens, cookies, email addresses or whole documents: field names
 * that look like secrets are redacted, strings that look like email addresses
 * are masked, and long strings are cut. Identify users with `uidTag()`.
 *
 * Server-only (node:crypto): do not import from client components.
 */

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface LogRecord extends Fields {
  ts: string;
  level: Level;
  event: string;
}

export type LogSink = (record: LogRecord, line: string) => void;

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Field names whose values must never appear in a log */
const SECRET_KEY = /(token|cookie|secret|password|passwd|authorization|api[-_]?key|signature|email|refresh|credential)/i;
/** Email-shaped substrings inside any string value */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_STRING = 400;
const MAX_STACK = 2000;
const MAX_DEPTH = 4;

function minLevel(): number {
  const env = process.env.LOG_LEVEL?.trim().toLowerCase() as Level | undefined;
  return env && env in LEVEL_RANK ? LEVEL_RANK[env] : LEVEL_RANK.info;
}

function pretty(): boolean {
  if (process.env.LOG_PRETTY === "1") return true;
  if (process.env.LOG_PRETTY === "0" || process.env.LOG_JSON === "1") return false;
  return process.env.NODE_ENV !== "production";
}

/** Short, stable, non-reversible tag for a user id (sha256 prefix). */
export function uidTag(userId: string | null | undefined, length = 10): string {
  if (!userId) return "anon";
  return createHash("sha256").update(String(userId)).digest("hex").slice(0, length);
}

/** An Error as plain fields; the stack only when asked for. */
export function errorFields(err: unknown, withStack = true): Fields {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; status?: unknown };
    const out: Fields = { name: err.name, message: redactString(err.message) };
    if (e.code !== undefined) out.code = e.code;
    if (e.status !== undefined) out.status = e.status;
    if (withStack && err.stack) out.stack = redactString(err.stack).slice(0, MAX_STACK);
    return out;
  }
  return { message: redactString(typeof err === "string" ? err : safeStringify(err)) };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function redactString(s: string): string {
  const masked = s.replace(EMAIL, "[email]");
  return masked.length > MAX_STRING + MAX_STACK ? masked.slice(0, MAX_STRING + MAX_STACK) + "…" : masked;
}

/** Copy `fields` with secrets removed and strings bounded. */
export function redact(fields: Fields, depth = 0): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactValue(value, depth, key === "stack" || key === "err");
  }
  return out;
}

function redactValue(value: unknown, depth: number, allowLong: boolean): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    const masked = value.replace(EMAIL, "[email]");
    const max = allowLong ? MAX_STACK : MAX_STRING;
    return masked.length > max ? masked.slice(0, max) + `…(${masked.length} chars)` : masked;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return redact(errorFields(value), depth + 1);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1, false));
  if (typeof value === "object") return redact(value as Fields, depth + 1);
  return String(value);
}

function formatPretty(rec: LogRecord): string {
  const { ts, level, event, ...rest } = rec;
  const parts = [ts.slice(11, 23), level.toUpperCase().padEnd(5), event];
  for (const [k, v] of Object.entries(rest)) {
    parts.push(`${k}=${typeof v === "string" ? (/[\s"=]/.test(v) ? JSON.stringify(v) : v) : safeStringify(v)}`);
  }
  return parts.join(" ");
}

/** The record as it is written: a JSON line, or one readable line in development. */
export function formatLine(rec: LogRecord, asJson = !pretty()): string {
  return asJson ? JSON.stringify(rec) : formatPretty(rec);
}

function defaultSink(rec: LogRecord, line: string): void {
  // Test runners parse the child's stdout; stay quiet there unless asked to
  if (process.env.NODE_TEST_CONTEXT && process.env.LOG_IN_TESTS !== "1") return;
  const out = rec.level === "warn" || rec.level === "error" ? process.stderr : process.stdout;
  out.write(line + "\n");
}

let sink: LogSink = defaultSink;

/** Replace where log lines go (tests); `null` restores the default. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? defaultSink;
}

export function makeRecord(level: Level, event: string, fields: Fields = {}): LogRecord {
  const clean = redact(fields);
  if (clean.err !== undefined && typeof clean.err !== "object") clean.err = { message: String(clean.err) };
  return { ts: new Date().toISOString(), level, event, ...clean };
}

function emit(level: Level, event: string, fields?: Fields): void {
  if (LEVEL_RANK[level] < minLevel()) return;
  const rec = makeRecord(level, event, fields);
  try {
    sink(rec, formatLine(rec));
  } catch {
    // Logging must never take the request down
  }
}

export const log = {
  debug: (event: string, fields?: Fields) => emit("debug", event, fields),
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};

/** `const done = startTimer(); … done()` gives the elapsed milliseconds (integer). */
export function startTimer(now: () => number = Date.now): () => number {
  const t0 = now();
  return () => Math.max(0, Math.round(now() - t0));
}

/** Run `fn`, then log `event` with its duration; a failure is logged at error level and rethrown. */
export async function timed<T>(event: string, fn: () => Promise<T>, fields: Fields = {}): Promise<T> {
  const done = startTimer();
  try {
    const result = await fn();
    log.info(event, { ...fields, ms: done() });
    return result;
  } catch (err) {
    log.error(event, { ...fields, ms: done(), err: errorFields(err, false) });
    throw err;
  }
}
