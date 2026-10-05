/**
 * Claude, for the Style engine. One client, one model, and a helper that
 * streams a reply to the browser as newline-delimited JSON so long texts
 * appear as they are written instead of after a timeout.
 */

import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_STYLE_MODEL = "claude-opus-5-5";

export function styleModel(): string {
  return process.env.STYLE_MODEL?.trim() || DEFAULT_STYLE_MODEL;
}

export function anthropicConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

let client: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim(), maxRetries: 2, timeout: 10 * 60_000 });
  return client;
}

/** One line of the stream the browser reads */
export type StreamEvent =
  | { text: string }
  | { done: true; stopReason: string | null; model: string; inputTokens: number; outputTokens: number; cachedTokens: number }
  | { error: string };

export interface StreamRequest {
  system: Anthropic.TextBlockParam[];
  user: string;
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

/** A user-facing message for a failed call. Never leaks the key or the request. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Claude API key was rejected. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use the configured model.";
  if (err instanceof Anthropic.NotFoundError) return `The model "${styleModel()}" wasn't found. Check STYLE_MODEL.`;
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limiting this app right now. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "Claude took too long to answer. Try a shorter text or a lower effort.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude. Check the server's network access.";
  if (err instanceof Anthropic.APIError) return `Claude returned an error (HTTP ${err.status ?? "?"}).`;
  return err instanceof Error ? err.message : "Something went wrong talking to Claude.";
}

/**
 * Stream a single-turn reply. Thinking stays adaptive (the model decides),
 * depth is set with effort, and a safety decline falls back to another
 * model server-side so the user still gets an answer.
 */
export function streamReply(req: StreamRequest): Response {
  const encoder = new TextEncoder();
  const model = styleModel();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        const stream = getAnthropic().beta.messages.stream({
          model,
          max_tokens: req.maxTokens,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: req.effort },
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        });
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") send({ text: event.delta.text });
        }
        const message = await stream.finalMessage();
        if (message.stop_reason === "refusal") {
          send({ error: "Claude declined to work on this text." });
        } else if (message.stop_reason === "max_tokens") {
          send({ error: "The reply was cut off because it got too long. Try a shorter text." });
        }
        send({
          done: true,
          stopReason: message.stop_reason,
          model: message.model,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cachedTokens: message.usage.cache_read_input_tokens ?? 0,
        });
      } catch (err) {
        console.error("Style engine request failed:", err);
        send({ error: describeApiError(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
