import { NextRequest, NextResponse } from "next/server";
import { getUserInfo, refreshAccessToken } from "@/lib/google";

export async function GET(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;
  const refreshToken = req.cookies.get("google_refresh_token")?.value;

  if (!token && !refreshToken) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  // Try with current access token first
  if (token) {
    try {
      const user = await getUserInfo(token);
      return NextResponse.json({ authenticated: true, user });
    } catch {
      // Token might be expired, try refreshing below
    }
  }

  // Try refreshing the token
  if (refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed) {
      try {
        const user = await getUserInfo(refreshed.access_token);
        const response = NextResponse.json({ authenticated: true, user });
        response.cookies.set("google_access_token", refreshed.access_token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: refreshed.expiry_date
            ? Math.max(60, Math.floor((refreshed.expiry_date - Date.now()) / 1000))
            : 3600,
          path: "/",
        });
        return response;
      } catch {
        // Refresh token also failed
      }
    }
  }

  return NextResponse.json({ authenticated: false }, { status: 401 });
}
