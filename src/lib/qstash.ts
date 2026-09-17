import { Client, Receiver } from "@upstash/qstash";
import { getBaseUrl } from "./base-url";

// ── QStash client (guaranteed-delivery message queue) ───────────────────────
// Used to reliably chain process invocations and schedule delayed wakeups
// for long pauses. Replaces the fragile HTTP self-chain pattern.

let _client: Client | null = null;

/**
 * QStash is multi-region. Accounts outside eu-central-1 must talk to their
 * region's endpoint (e.g. https://qstash-us-east-1.upstash.io), which the
 * Upstash console shows as QSTASH_URL next to the token.
 */
export function getQStashBaseUrl(): string | undefined {
  const url = process.env.QSTASH_URL?.trim().replace(/\/+$/, "");
  return url || undefined;
}

export function getQStashClient(): Client | null {
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) return null;
  if (!_client) {
    _client = new Client({ token, ...(getQStashBaseUrl() ? { baseUrl: getQStashBaseUrl() } : {}) });
  }
  return _client;
}

let _receiver: Receiver | null = null;

export function getQStashReceiver(): Receiver | null {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!currentSigningKey || !nextSigningKey) {
    return null;
  }
  if (!_receiver) {
    _receiver = new Receiver({ currentSigningKey, nextSigningKey });
  }
  return _receiver;
}

/**
 * Resolve the app's public URL for QStash callbacks.
 * Production: NEXT_PUBLIC_BASE_URL (or Vercel's deployment URL as a fallback).
 * Local dev:  localhost (QStash can't reach localhost — the direct HTTP
 *             fallback below is used in that case).
 */
function getOrigin(): string {
  return getBaseUrl();
}

/**
 * Enqueue a process invocation with guaranteed delivery.
 *
 * @param jobId       The sync job to process
 * @param generation  The job generation this message belongs to (stale ones are ignored)
 * @param delaySec    Seconds to wait before delivery
 */
export async function enqueueProcess(jobId: string, generation: number, delaySec = 0): Promise<void> {
  const client = getQStashClient();
  const url = `${getOrigin()}/api/sync/process`;
  const body = { jobId, generation };

  if (client) {
    try {
      await client.publishJSON({
        url,
        body,
        retries: 3,
        ...(delaySec > 0 ? { delay: Math.ceil(delaySec) } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const hint = /authenticate|invalid token|401/i.test(detail)
        ? "QStash rejected QSTASH_TOKEN. In Upstash → QStash, copy the value labelled QSTASH_TOKEN (starts with \"eyJ\"), not a signing key (starts with \"sig_\"), set it in Vercel and redeploy."
        : /not found in this region|correct endpoint/i.test(detail)
          ? "QStash region mismatch. In Upstash → QStash, copy the value labelled QSTASH_URL (e.g. https://qstash-us-east-1.upstash.io) into a QSTASH_URL environment variable in Vercel and redeploy."
          : "QStash publish failed.";
      throw new Error(`${hint} (${detail})`);
    }
    return;
  }

  // Local development without QStash: call ourselves after the delay.
  // This does not survive a server restart; production must use QStash.
  const fire = () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-syncstream-internal": "1" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  };
  if (delaySec > 0) setTimeout(fire, delaySec * 1000);
  else fire();
}
