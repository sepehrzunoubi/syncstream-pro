/**
 * Calls to the Style engine routes. Replies stream as newline-delimited
 * JSON: {text} chunks, then {done} with usage, or {error}.
 */

import type { StreamEvent } from "@/lib/llm";

export interface StreamUsage { model: string; inputTokens: number; outputTokens: number }

export class StyleApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/**
 * POST a request and feed its streamed text to `onText`. Resolves with the
 * usage when the reply is complete; rejects with a StyleApiError (status
 * 0 for a mid-stream failure) after whatever text already arrived.
 */
export async function streamStyle(url: string, body: unknown, onText: (chunk: string) => void, signal?: AbortSignal): Promise<StreamUsage> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    let message = `Request failed (HTTP ${res.status})`;
    try { message = ((await res.json()) as { error?: string }).error || message; } catch { /* no body */ }
    throw new StyleApiError(message, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: StreamUsage | null = null;
  let failure: string | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    let event: StreamEvent;
    try { event = JSON.parse(line) as StreamEvent; } catch { return; }
    if ("text" in event) onText(event.text);
    else if ("error" in event) failure = event.error;
    else if ("done" in event) usage = { model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens };
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  handle(buffer);
  if (failure) throw new StyleApiError(failure, 0);
  if (!usage) throw new StyleApiError("The connection closed before the reply finished.", 0);
  return usage;
}

export interface StyleStatus {
  llm: { provider: string; model: string; configured: boolean; reachable: boolean | null; detail: string };
  style: { ready: boolean; name: string; samples: number; candidateId: string; builtAt: string | null; evaluation: { run: string; score: number; samples: number; model: string } | null };
}

export async function fetchStyleStatus(): Promise<StyleStatus | null> {
  try {
    const res = await fetch("/api/style/status");
    return res.ok ? ((await res.json()) as StyleStatus) : null;
  } catch { return null; }
}
