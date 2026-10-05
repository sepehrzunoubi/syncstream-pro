import { NextRequest, NextResponse } from "next/server";
import { anthropicConfigured, styleModel } from "@/lib/anthropic";
import { resolveUser, unauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Whether the Style engine can run on this deployment, and with which model */
export async function GET(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  return NextResponse.json({ configured: anthropicConfigured(), model: styleModel() });
}
