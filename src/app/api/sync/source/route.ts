import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

/**
 * Reconstruct the original source text from the sync plan's actions stored in Redis.
 * This allows the client to restore the text preview even if localStorage was lost.
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");

  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  const payload = await getPayload(jobId);
  if (!payload) {
    return NextResponse.json({ error: "Payload not found" }, { status: 404 });
  }

  // Reconstruct source text by concatenating all insert/typo action texts in order
  let sourceText = "";
  for (const action of payload.actions) {
    if (action.kind === "insert" || action.kind === "typo") {
      sourceText += action.text;
    }
  }

  return NextResponse.json({ sourceText });
}
