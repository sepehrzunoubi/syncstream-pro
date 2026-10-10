import { NextRequest, NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google";
import { getBaseUrl } from "@/lib/base-url";
import { setOAuthStateCookie } from "@/lib/auth";
import { randomToken } from "@/lib/secret";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (req: NextRequest) => {
  const limited = await rateLimited(req, "auth.login", { max: 20, windowMs: 60_000 });
  if (limited) return limited;
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
});
