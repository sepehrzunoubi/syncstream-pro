import { NextRequest, NextResponse } from "next/server";
import { llmStatus } from "@/lib/llm";
import { resolveUser, unauthorized } from "@/lib/auth";
import { compiledStyle, styleReady } from "@/lib/style-spec";

export const dynamic = "force-dynamic";

/** Whether the Style engine can run on this deployment: the model server and the compiled style */
export async function GET(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const llm = await llmStatus();
  const style = compiledStyle();
  return NextResponse.json({
    llm: { provider: llm.provider, model: llm.model, configured: llm.configured, reachable: llm.reachable, detail: llm.detail },
    style: {
      ready: styleReady(),
      name: style.name,
      samples: style.exemplars.length,
      candidateId: style.candidateId,
      builtAt: style.builtAt,
      evaluation: style.evaluation,
    },
  });
}
