/**
 * The language model behind the Style engine, behind one small interface.
 *
 * Providers:
 *   ollama     a local Ollama server (default)          LLM_BASE_URL, LLM_MODEL
 *   openai     any OpenAI-compatible server             LLM_BASE_URL, LLM_MODEL, LLM_API_KEY
 *              (llama.cpp server, vLLM, LM Studio, ...)
 *   anthropic  Claude, for testing prompts in the cloud ANTHROPIC_API_KEY, LLM_MODEL
 *
 * `complete` returns the whole reply (the style lab uses it); `streamChat`
 * streams it to the browser as newline-delimited JSON (the app uses it).
 */

import Anthropic from "@anthropic-ai/sdk";

export type Role = "system" | "user" | "assistant";
export interface ChatMessage { role: Role; content: string }

export type Provider = "ollama" | "openai" | "anthropic";

export interface LlmConfig {
  provider: Provider;
  model: string;
  baseUrl: string;
  /** Whether the settings are complete enough to try a request */
  configured: boolean;
  detail: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** Override the configured model (the lab compares models) */
  model?: string;
  signal?: AbortSignal;
}

export interface Completion {
  text: string;
  model: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock milliseconds */
  ms: number;
}

const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "llama3.1" },
  openai: { baseUrl: "http://127.0.0.1:8080", model: "llama" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
};

export function llmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const raw = (env.LLM_PROVIDER ?? "ollama").trim().toLowerCase();
  const provider: Provider = raw === "openai" || raw === "anthropic" ? raw : "ollama";
  const d = DEFAULTS[provider];
  const baseUrl = (env.LLM_BASE_URL?.trim() || d.baseUrl).replace(/\/+$/, "");
  const model = env.LLM_MODEL?.trim() || d.model;
  if (provider === "anthropic") {
    const ok = !!env.ANTHROPIC_API_KEY?.trim();
    return { provider, model, baseUrl, configured: ok, detail: ok ? `Claude ${model}` : "ANTHROPIC_API_KEY is not set" };
  }
  return { provider, model, baseUrl, configured: true, detail: `${provider === "ollama" ? "Ollama" : "OpenAI-compatible server"} at ${baseUrl}, model ${model}` };
}

export interface LlmStatus extends LlmConfig {
  /** null when not checked (cloud provider) */
  reachable: boolean | null;
  /** Models the server reports, when it does */
  models?: string[];
}

/** Is the server up, and does it have the model? */
export async function llmStatus(env: NodeJS.ProcessEnv = process.env): Promise<LlmStatus> {
  const cfg = llmConfig(env);
  if (cfg.provider === "anthropic") return { ...cfg, reachable: null };
  try {
    const url = cfg.provider === "ollama" ? `${cfg.baseUrl}/api/tags` : `${cfg.baseUrl}/v1/models`;
    const res = await fetch(url, { headers: headersFor(cfg, env), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ...cfg, reachable: false, detail: `${cfg.detail}: HTTP ${res.status}` };
    const data = (await res.json()) as { models?: { name: string }[]; data?: { id: string }[] };
    const models = cfg.provider === "ollama" ? (data.models ?? []).map((m) => m.name) : (data.data ?? []).map((m) => m.id);
    const has = models.some((m) => m === cfg.model || m.split(":")[0] === cfg.model || m === `${cfg.model}:latest`);
    return {
      ...cfg,
      reachable: true,
      models,
      detail: has || !models.length ? cfg.detail : `${cfg.detail} (the server does not list this model; it has: ${models.slice(0, 8).join(", ")})`,
    };
  } catch (err) {
    return { ...cfg, reachable: false, detail: `${cfg.detail}: ${err instanceof Error ? err.message : "unreachable"}` };
  }
}

function headersFor(cfg: LlmConfig, env: NodeJS.ProcessEnv): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = env.LLM_API_KEY?.trim();
  if (cfg.provider === "openai" && key) h.Authorization = `Bearer ${key}`;
  return h;
}

/** A user-facing message for a failed call. Never includes a key. */
export function describeLlmError(err: unknown, cfg = llmConfig()): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Claude API key was rejected. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.NotFoundError) return `The model "${cfg.model}" wasn't found. Check LLM_MODEL.`;
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limiting this app right now. Try again in a minute.";
  if (err instanceof Anthropic.APIError) return `Claude returned an error (HTTP ${err.status ?? "?"}): ${err.message}`;
  if (err instanceof DOMException && err.name === "TimeoutError") return "The model took too long to answer.";
  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND/.test(err.message)) {
    return `Couldn't reach the ${cfg.provider === "ollama" ? "Ollama" : "model"} server at ${cfg.baseUrl}. Is it running, and is LLM_BASE_URL right?`;
  }
  return err instanceof Error ? err.message : "Something went wrong talking to the model.";
}

// ── Streaming core ──────────────────────────────────────────────────────

interface Delta { text?: string; done?: { model: string; stopReason: string | null; inputTokens: number; outputTokens: number } }

/** Run a chat request against the configured provider, yielding text deltas then a final summary */
async function* chat(req: ChatRequest, cfg: LlmConfig, env: NodeJS.ProcessEnv): AsyncGenerator<Delta> {
  const model = req.model || cfg.model;
  const timeout = 10 * 60_000;
  const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);

  if (cfg.provider === "ollama") {
    const res = await fetch(`${cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: headersFor(cfg, env),
      body: JSON.stringify({ model, messages: req.messages, stream: true, options: { temperature: req.temperature, num_predict: req.maxTokens, num_ctx: contextFor(req) } }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Ollama answered HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    for await (const line of lines(res.body)) {
      const ev = JSON.parse(line) as { message?: { content?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string };
      if (ev.error) throw new Error(ev.error);
      if (ev.message?.content) yield { text: ev.message.content };
      if (ev.done) yield { done: { model, stopReason: ev.done_reason ?? null, inputTokens: ev.prompt_eval_count ?? 0, outputTokens: ev.eval_count ?? 0 } };
    }
    return;
  }

  if (cfg.provider === "openai") {
    const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headersFor(cfg, env),
      body: JSON.stringify({ model, messages: req.messages, stream: true, temperature: req.temperature, max_tokens: req.maxTokens, stream_options: { include_usage: true } }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`The model server answered HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stop: string | null = null;
    for await (const line of lines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      const ev = JSON.parse(payload) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const choice = ev.choices?.[0];
      if (choice?.delta?.content) yield { text: choice.delta.content };
      if (choice?.finish_reason) stop = choice.finish_reason;
      if (ev.usage) usage = { inputTokens: ev.usage.prompt_tokens ?? 0, outputTokens: ev.usage.completion_tokens ?? 0 };
    }
    yield { done: { model, stopReason: stop, ...usage } };
    return;
  }

  // Anthropic: system messages become the system prompt, the rest alternate
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY?.trim(), maxRetries: 2, timeout });
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const stream = client.messages.stream({
    model,
    max_tokens: req.maxTokens,
    ...(system ? { system } : {}),
    messages: turns,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  }, { signal });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { text: event.delta.text };
  }
  const final = await stream.finalMessage();
  yield { done: { model: final.model, stopReason: final.stop_reason, inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens } };
}

/**
 * Ollama's default context is 4,096 tokens and it silently drops the oldest
 * part of a longer prompt (the rules and examples). Ask for room for the
 * prompt and the reply, in 2k steps, between 8k and 32k.
 */
export function contextFor(req: ChatRequest): number {
  const chars = req.messages.reduce((a, m) => a + m.content.length, 0);
  const promptTokens = Math.ceil(chars / 3.2);
  const need = promptTokens + req.maxTokens + 512;
  return Math.min(32768, Math.max(8192, Math.ceil(need / 2048) * 2048));
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

/** The whole reply at once */
export async function complete(req: ChatRequest, env: NodeJS.ProcessEnv = process.env): Promise<Completion> {
  const cfg = llmConfig(env);
  const started = Date.now();
  let text = "";
  let done: Delta["done"] | undefined;
  for await (const d of chat(req, cfg, env)) {
    if (d.text) text += d.text;
    if (d.done) done = d.done;
  }
  return { text, model: done?.model ?? req.model ?? cfg.model, stopReason: done?.stopReason ?? null, inputTokens: done?.inputTokens ?? 0, outputTokens: done?.outputTokens ?? 0, ms: Date.now() - started };
}

/** One line of the stream the browser reads */
export type StreamEvent =
  | { text: string }
  | { done: true; stopReason: string | null; model: string; inputTokens: number; outputTokens: number }
  | { error: string };

/** The reply as an HTTP response of newline-delimited JSON events */
export function streamChat(req: ChatRequest, env: NodeJS.ProcessEnv = process.env): Response {
  const encoder = new TextEncoder();
  const cfg = llmConfig(env);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        let finished = false;
        for await (const d of chat(req, cfg, env)) {
          if (d.text) send({ text: d.text });
          if (d.done) {
            finished = true;
            if (d.done.stopReason === "length" || d.done.stopReason === "max_tokens") send({ error: "The reply was cut off because it got too long. Try a shorter text." });
            send({ done: true, ...d.done });
          }
        }
        if (!finished) send({ error: "The model closed the connection before finishing." });
      } catch (err) {
        if (!(req.signal?.aborted)) console.error("Style engine request failed:", err);
        send({ error: describeLlmError(err, cfg) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
