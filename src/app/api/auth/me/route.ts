import { NextRequest, NextResponse } from "next/server";
import { getUserInfo, refreshAccessToken } from "@/lib/google";
import { ACCESS_COOKIE, REFRESH_COOKIE, setAccessCookie, setUidCookie } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (req: NextRequest) => {
  const limited = await rateLimited(req, "auth.me", { max: 120, windowMs: 60_000 });
  if (limited) return limited;
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;

  if (!token && !refreshToken) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  if (token) {
    try {
      const user = await getUserInfo(token);
      const response = NextResponse.json({ authenticated: true, user });
      if (user.id) setUidCookie(response, user.id);
      return response;
    } catch {
      // expired: refresh below
    }
  }

  if (refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed) {
      try {
        const user = await getUserInfo(refreshed.access_token);
        const response = NextResponse.json({ authenticated: true, user });
        setAccessCookie(response, refreshed.access_token, refreshed.expiry_date);
        if (user.id) setUidCookie(response, user.id);
        return response;
      } catch {
        // refresh token revoked
      }
    }
  }

  return NextResponse.json({ authenticated: false }, { status: 401 });
});
