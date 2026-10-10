import { errorFields, log, redact, type Fields } from "./log";

/**
 * Error reporting for operators. `reportError` always writes a structured
 * log line; when ERROR_WEBHOOK_URL is set it also POSTs a compact JSON
 * payload there (3s timeout, never throws). The payload carries `text` (a
 * one-line summary, which Slack- and Discord-style incoming webhooks render)
 * next to the structured fields for generic receivers.
 *
 * The same message on the same route is sent at most once a minute per
 * process, so an error storm is one notification, not thousands.
 */

export interface ReportContext extends Fields {
  /** Log event name; default "error" */
  event?: string;
  route?: string;
  method?: string;
  /** uidTag() of the user involved, never the raw id */
  uid?: string;
  jobId?: string;
}

export interface WebhookPayload {
  text: string;
  service: "syncstream";
  env: string;
  event: string;
  message: string;
  stack?: string;
  context: Fields;
  ts: string;
}

export interface MonitorDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Overrides ERROR_WEBHOOK_URL */
  webhookUrl?: string | null;
  dedupeMs?: number;
  timeoutMs?: number;
}

const DEDUPE_MS = 60_000;
const TIMEOUT_MS = 3_000;
const MAX_STACK = 1_500;
const MAX_RECENT = 500;

function envName(): string {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || "development";
}

export function createMonitor(deps: MonitorDeps = {}) {
  const now = deps.now ?? Date.now;
  const dedupeMs = deps.dedupeMs ?? DEDUPE_MS;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const recent = new Map<string, number>();

  /** True when this message+route was already sent within the window */
  function seenRecently(key: string, t: number): boolean {
    const last = recent.get(key);
    if (last != null && t - last < dedupeMs) return true;
    if (recent.size >= MAX_RECENT) {
      for (const [k, v] of Array.from(recent)) if (t - v >= dedupeMs) recent.delete(k);
      if (recent.size >= MAX_RECENT) recent.delete(recent.keys().next().value as string);
    }
    recent.set(key, t);
    return false;
  }

  async function post(url: string, payload: WebhookPayload): Promise<boolean> {
    const doFetch = deps.fetch ?? globalThis.fetch;
    if (typeof doFetch !== "function") return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) log.warn("monitor.webhook_rejected", { status: res.status });
      return res.ok;
    } catch (err) {
      log.warn("monitor.webhook_failed", { err: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Log the error and notify the webhook. Resolves to true when a webhook
   * message went out (false when none is configured, deduplicated or failed).
   * Callers may ignore the promise; it never rejects.
   */
  async function reportError(err: unknown, context: ReportContext = {}): Promise<boolean> {
    const { event = "error", ...ctx } = context;
    const fields = errorFields(err, true);
    log.error(event, { ...ctx, err: fields });

    const url = (deps.webhookUrl === undefined ? process.env.ERROR_WEBHOOK_URL : deps.webhookUrl)?.trim();
    if (!url) return false;
    const message = String(fields.message ?? "");
    const key = `${ctx.route ?? event}|${message}`;
    const t = now();
    if (seenRecently(key, t)) return false;

    const where = [ctx.method, ctx.route].filter(Boolean).join(" ");
    const payload: WebhookPayload = {
      text: `[syncstream ${envName()}] ${event}${where ? ` at ${where}` : ""}: ${message}`.slice(0, 1000),
      service: "syncstream",
      env: envName(),
      event,
      message: message.slice(0, 500),
      ...(typeof fields.stack === "string" ? { stack: fields.stack.slice(0, MAX_STACK) } : {}),
      context: redact(ctx),
      ts: new Date(t).toISOString(),
    };
    return post(url, payload);
  }

  return { reportError, _recent: recent };
}

const defaultMonitor = createMonitor();

/** Log an error for operators and notify ERROR_WEBHOOK_URL (deduplicated, 3s cap, never throws). */
export const reportError = defaultMonitor.reportError;
