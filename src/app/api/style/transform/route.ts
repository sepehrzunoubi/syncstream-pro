import { NextRequest, NextResponse } from "next/server";
import { resolveUser, unauthorized } from "@/lib/auth";
import { anthropicConfigured, streamReply } from "@/lib/anthropic";
import { cleanInstructions, MAX_TEXT_CHARS, SYSTEM_PROMPT, transformPrompt, transformSystem, validatePairs, type Effort } from "@/lib/style-engine";

export const dynamic = "force-dynamic";
/** A long text at full effort can take a few minutes; lower this if your plan caps function duration */
export const maxDuration = 300;

const EFFORTS: Effort[] = ["medium", "high", "max"];

/**
 * Stage 2: apply a Transformation Profile to new text and stream the
 * result back as newline-delimited JSON events. The dataset and profile go
 * in the system prompt with a cache breakpoint, so transforming several
 * texts with the same profile reuses the cached prefix.
 */
export async function POST(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  if (!anthropicConfigured()) {
    return NextResponse.json({ error: "The Style engine isn't set up on this server: ANTHROPIC_API_KEY is missing." }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { pairs?: unknown; analysis?: unknown; instructions?: unknown; text?: unknown; effort?: unknown };
  const { pairs, error } = validatePairs(body.pairs);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const analysis = typeof body.analysis === "string" ? body.analysis.trim() : "";
  if (!analysis) return NextResponse.json({ error: "Analyze the pairs first so there is a Transformation Profile to apply." }, { status: 400 });
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "Paste the text you want transformed." }, { status: 400 });
  if (text.length > MAX_TEXT_CHARS) return NextResponse.json({ error: `The text can be at most ${MAX_TEXT_CHARS.toLocaleString()} characters.` }, { status: 400 });
  const effort = EFFORTS.includes(body.effort as Effort) ? (body.effort as Effort) : "high";

  return streamReply({
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      { type: "text", text: transformSystem(pairs, analysis, cleanInstructions(body.instructions)), cache_control: { type: "ephemeral" } },
    ],
    user: transformPrompt(text),
    maxTokens: 32_000,
    effort,
  });
}
