import { NextRequest, NextResponse } from "next/server";
import { llmStatus } from "@/lib/llm";
import { resolveUser, unauthorized } from "@/lib/auth";
import { compiledStyle, styleReady } from "@/lib/style-spec";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Whether the Style engine can run on this deployment: the model server and the compiled style */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "style.status", { max: 60, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
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
});
