import { NextRequest, NextResponse } from "next/server";
import { getTokensFromCode, getUserInfo } from "@/lib/google";
import { getBaseUrl } from "@/lib/base-url";
import { OAUTH_STATE_COOKIE, setAccessCookie, setRefreshCookie, setUidCookie } from "@/lib/auth";
import { secretEquals } from "@/lib/secret";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const baseUrl = getBaseUrl(req);
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    console.error("OAuth error from Google:", error);
    return NextResponse.redirect(new URL(`/?error=${error}`, baseUrl));
  }
  if (!code) {
    return NextResponse.redirect(new URL("/?error=no_code", baseUrl));
  }
  // The state must be the one this browser started with: stops login CSRF
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!secretEquals(state, expected)) {
    return NextResponse.redirect(new URL("/?error=state_mismatch", baseUrl));
  }

  try {
    const tokens = await getTokensFromCode(code, `${baseUrl}/api/auth/callback`);
    if (!tokens.access_token) {
      return NextResponse.redirect(new URL("/?error=no_access_token", baseUrl));
    }

    const response = NextResponse.redirect(new URL("/dashboard", baseUrl));
    response.cookies.set(OAUTH_STATE_COOKIE, "", { maxAge: 0, path: "/api/auth" });
    setAccessCookie(response, tokens.access_token, tokens.expiry_date);
    if (tokens.refresh_token) setRefreshCookie(response, tokens.refresh_token);

    try {
      const user = await getUserInfo(tokens.access_token);
      if (user.id) setUidCookie(response, user.id);
    } catch {
      // /api/auth/me sets it on the next load
    }
    return response;
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(new URL("/?error=auth_failed", baseUrl));
  }
}
