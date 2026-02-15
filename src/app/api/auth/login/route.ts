import { NextRequest, NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google";

export const dynamic = "force-dynamic";

function getBaseUrl(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/api/auth/callback`;
  const url = getAuthUrl(redirectUri);
  return NextResponse.redirect(url);
}
