import { NextRequest, NextResponse } from "next/server";
import { resolveUser, unauthorized } from "@/lib/auth";
import { anthropicConfigured, streamReply } from "@/lib/anthropic";
import { analysisPrompt, cleanInstructions, SYSTEM_PROMPT, validatePairs, type Effort } from "@/lib/style-engine";

export const dynamic = "force-dynamic";
/** Analysis of a dozen long pairs can take a few minutes; lower this if your plan caps function duration */
export const maxDuration = 300;

const EFFORTS: Effort[] = ["medium", "high", "max"];

/**
 * Stage 1: compare the input/output pairs and stream back the
 * Transformation Profile as newline-delimited JSON events.
 */
export async function POST(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  if (!anthropicConfigured()) {
    return NextResponse.json({ error: "The Style engine isn't set up on this server: ANTHROPIC_API_KEY is missing." }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { pairs?: unknown; instructions?: unknown; effort?: unknown };
  const { pairs, error } = validatePairs(body.pairs);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const effort = EFFORTS.includes(body.effort as Effort) ? (body.effort as Effort) : "high";

  return streamReply({
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    user: analysisPrompt(pairs, cleanInstructions(body.instructions)),
    maxTokens: 32_000,
    effort,
  });
}
