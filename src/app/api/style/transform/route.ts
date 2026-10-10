import { NextRequest, NextResponse } from "next/server";
import { resolveUser, unauthorized } from "@/lib/auth";
import { llmConfig, streamChat } from "@/lib/llm";
import { MAX_TEXT_CHARS } from "@/lib/style-engine";
import { buildRequest, buildRevision, styleReady } from "@/lib/style-spec";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
/** A long text on a small local model can take minutes; lower this if your plan caps function duration */
export const maxDuration = 300;

/**
 * Rewrite the user's text in the compiled style and stream the reply as
 * newline-delimited JSON events. With `draft`, revise that earlier reply
 * toward the fingerprint instead.
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "style.transform", { max: 6, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const cfg = llmConfig();
  if (!cfg.configured) return NextResponse.json({ error: `The Style engine isn't set up on this server: ${cfg.detail}.` }, { status: 503 });
  if (!styleReady()) return NextResponse.json({ error: "No style has been compiled yet. The developer runs the style lab and ships the result." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { text?: unknown; draft?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "Paste the text you want rewritten." }, { status: 400 });
  if (text.length > MAX_TEXT_CHARS) return NextResponse.json({ error: `The text can be at most ${MAX_TEXT_CHARS.toLocaleString()} characters.` }, { status: 400 });
  const draft = typeof body.draft === "string" ? body.draft.trim() : "";

  const built = draft ? buildRevision(text, draft) : buildRequest(text);
  if (!built) return NextResponse.json({ error: "The draft already matches the style. Nothing to revise." }, { status: 400 });
  return streamChat({ messages: built.messages, maxTokens: built.maxTokens, temperature: built.temperature, signal: req.signal });
});
