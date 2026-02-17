import { NextRequest, NextResponse } from "next/server";
import { getUserInfo, refreshAccessToken } from "@/lib/google";
import { resetKey, checkRateLimit, seedKeysIfNeeded } from "@/lib/key-store";
import { clearLicensedCookie } from "@/lib/key-cookie";

export async function POST(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;
  const refreshToken = req.cookies.get("google_refresh_token")?.value;

  if (!token && !refreshToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let user: { id: string; email: string } | null = null;

  if (token) {
    try {
      user = await getUserInfo(token);
    } catch {
      // try refresh
    }
  }

  if (!user && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed) {
      try {
        user = await getUserInfo(refreshed.access_token);
      } catch {
        // failed
      }
    }
  }

  if (!user || !user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limiting
  const rateCheck = await checkRateLimit(user.id);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait before trying again." },
      { status: 429 }
    );
  }

  await seedKeysIfNeeded();

  const result = await resetKey(user.id);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Return the key so it can be copied to clipboard before logout
  const response = NextResponse.json({ success: true, key: result.key });
  clearLicensedCookie(response);
  return response;
}
