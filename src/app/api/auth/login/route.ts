import { NextRequest, NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/callback`;
  const url = getAuthUrl(redirectUri);
  return NextResponse.redirect(url);
}
