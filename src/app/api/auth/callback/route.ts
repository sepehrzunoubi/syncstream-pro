import { NextRequest, NextResponse } from "next/server";
import { getTokensFromCode, getUserInfo } from "@/lib/google";
import { setGoogleIdCookie } from "@/lib/key-cookie";

export async function GET(req: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  // Handle user denying consent
  if (error) {
    console.error("OAuth error from Google:", error);
    return NextResponse.redirect(new URL(`/?error=${error}`, baseUrl));
  }

  if (!code) {
    return NextResponse.redirect(new URL("/?error=no_code", baseUrl));
  }

  try {
    const redirectUri = `${baseUrl}/api/auth/callback`;
    const tokens = await getTokensFromCode(code, redirectUri);

    if (!tokens.access_token) {
      return NextResponse.redirect(new URL("/?error=no_access_token", baseUrl));
    }

    const response = NextResponse.redirect(new URL("/dashboard", baseUrl));

    response.cookies.set("google_access_token", tokens.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: tokens.expiry_date
        ? Math.floor((tokens.expiry_date - Date.now()) / 1000)
        : 3600,
      path: "/",
    });

    if (tokens.refresh_token) {
      response.cookies.set("google_refresh_token", tokens.refresh_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 30, // 30 days
        path: "/",
      });
    }

    // Store the Google user ID in an httpOnly cookie so the middleware can
    // cross-check that the syncstream_licensed cookie belongs to this user.
    try {
      const user = await getUserInfo(tokens.access_token);
      if (user?.id) {
        setGoogleIdCookie(response, user.id);
      }
    } catch {
      // Best effort — /api/auth/me will also set this cookie on next load
    }

    return response;
  } catch (error) {
    console.error("OAuth callback error:", error);
    return NextResponse.redirect(new URL("/?error=auth_failed", baseUrl));
  }
}
