import { NextRequest, NextResponse } from "next/server";
import { getUserInfo, refreshAccessToken } from "./google";

export const ACCESS_COOKIE = "google_access_token";
export const REFRESH_COOKIE = "google_refresh_token";
/** Google user id, so job ownership checks do not need a Google API call per request */
export const UID_COOKIE = "ss_uid";

const secure = () => process.env.NODE_ENV === "production";

export interface SessionUser {
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** Set when the access token was refreshed while resolving; write it back with applyAuthCookies */
  refreshed?: { access_token: string; expiry_date: number };
  /** Set when the uid cookie was missing; write it back with applyAuthCookies */
  uidToSet?: string;
}

/**
 * Resolve the signed-in user from cookies. Uses the uid cookie when present
 * and only falls back to Google's userinfo endpoint when it is missing.
 */
export async function resolveUser(req: NextRequest): Promise<SessionUser | null> {
  let accessToken = req.cookies.get(ACCESS_COOKIE)?.value ?? "";
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value ?? "";
  const uid = req.cookies.get(UID_COOKIE)?.value ?? "";
  if (!accessToken && !refreshToken) return null;

  let refreshed: SessionUser["refreshed"];
  if (!accessToken && refreshToken) {
    const r = await refreshAccessToken(refreshToken);
    if (!r) return null;
    accessToken = r.access_token;
    refreshed = r;
  }
  if (uid) return { userId: uid, accessToken, refreshToken, refreshed };

  // No uid cookie: ask Google, refreshing once if the token is stale.
  try {
    const info = await getUserInfo(accessToken);
    if (info.id) return { userId: info.id, accessToken, refreshToken, refreshed, uidToSet: info.id };
  } catch {
    if (refreshToken && !refreshed) {
      const r = await refreshAccessToken(refreshToken);
      if (r) {
        try {
          const info = await getUserInfo(r.access_token);
          if (info.id) return { userId: info.id, accessToken: r.access_token, refreshToken, refreshed: r, uidToSet: info.id };
        } catch { /* fall through */ }
      }
    }
  }
  return null;
}

export function setUidCookie(res: NextResponse, userId: string): void {
  res.cookies.set(UID_COOKIE, userId, {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
}

export function setAccessCookie(res: NextResponse, accessToken: string, expiryDate?: number | null): void {
  res.cookies.set(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax",
    maxAge: expiryDate ? Math.max(60, Math.floor((expiryDate - Date.now()) / 1000)) : 3600,
    path: "/",
  });
}

export function setRefreshCookie(res: NextResponse, refreshToken: string): void {
  res.cookies.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
}

/** Persist anything resolveUser had to refresh or look up. */
export function applyAuthCookies(res: NextResponse, user: SessionUser): NextResponse {
  if (user.refreshed) setAccessCookie(res, user.refreshed.access_token, user.refreshed.expiry_date);
  if (user.uidToSet) setUidCookie(res, user.uidToSet);
  return res;
}

export function clearAuthCookies(res: NextResponse): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, UID_COOKIE, "syncstream_licensed", "google_user_id"]) {
    res.cookies.set(name, "", { maxAge: 0, path: "/" });
  }
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
