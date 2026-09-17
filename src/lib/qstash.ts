import { Client, Receiver } from "@upstash/qstash";
import { getBaseUrl } from "./base-url";

// ── QStash client (guaranteed-delivery message queue) ───────────────────────
// Used to reliably chain process invocations and schedule delayed wakeups
// for long pauses. Replaces the fragile HTTP self-chain pattern.

let _client: Client | null = null;

export function getQStashClient(): Client | null {
  if (!process.env.QSTASH_TOKEN) return null;
  if (!_client) {
    _client = new Client({ token: process.env.QSTASH_TOKEN });
  }
  return _client;
}

let _receiver: Receiver | null = null;

export function getQStashReceiver(): Receiver | null {
  if (
    !process.env.QSTASH_CURRENT_SIGNING_KEY ||
    !process.env.QSTASH_NEXT_SIGNING_KEY
  ) {
    return null;
  }
  if (!_receiver) {
    _receiver = new Receiver({
      currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
    });
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
 * Enqueue a process invocation via QStash with guaranteed delivery.
 *
 * @param jobId      The sync job to process
 * @param delaySec   Optional delay in seconds (for mandatory pauses)
 * @param fallbackReq  Optional NextRequest for direct HTTP fallback when QStash is unavailable (local dev)
 */
export async function enqueueProcess(
  jobId: string,
  delaySec = 0,
  fallbackReq?: { nextUrl?: { origin?: string } }
): Promise<void> {
  const client = getQStashClient();
  const origin = getOrigin();
  const url = `${origin}/api/sync/process`;

  if (client) {
    // Production path: guaranteed delivery via QStash
    await client.publishJSON({
      url,
      body: { jobId },
      retries: 3,
      ...(delaySec > 0 ? { delay: delaySec } : {}),
    });
    return;
  }

  // Fallback for local dev (no QStash token): direct HTTP fetch (old behavior)
  const fallbackOrigin =
    fallbackReq?.nextUrl?.origin || origin;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    await fetch(`${fallbackOrigin}/api/sync/process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-syncstream-internal": "1",
      },
      body: JSON.stringify({ jobId }),
      signal: controller.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch {
    // AbortError expected — the process invocation runs for minutes
  }
}
