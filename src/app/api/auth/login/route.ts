import { NextRequest, NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google";
import { getBaseUrl } from "@/lib/base-url";
import { setOAuthStateCookie } from "@/lib/auth";
import { randomToken } from "@/lib/secret";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.json(
      {
        error:
          "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the deployment's environment variables.",
      },
      { status: 500 }
    );
  }

  const redirectUri = `${getBaseUrl(req)}/api/auth/callback`;
  const state = randomToken();
  const res = NextResponse.redirect(getAuthUrl(redirectUri, state));
  setOAuthStateCookie(res, state);
  return res;
}
