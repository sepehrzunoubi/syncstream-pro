import { NextRequest, NextResponse } from "next/server";
import { getUserInfo, refreshAccessToken } from "@/lib/google";
import { getUserBinding, getLicenseKey, seedKeysIfNeeded } from "@/lib/key-store";
import { setLicensedCookie, clearLicensedCookie } from "@/lib/key-cookie";

export async function GET(req: NextRequest) {
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

  await seedKeysIfNeeded();

  const binding = await getUserBinding(user.id);

  if (!binding) {
    const response = NextResponse.json({
      hasKey: false,
      key: null,
      resetUsed: false,
    });
    clearLicensedCookie(response);
    return response;
  }

  // Check both binding and key-level reset flag so a new owner sees reset as used
  const licenseKey = await getLicenseKey(binding.key);
  const resetUsed = binding.resetUsed || (licenseKey?.resetUsed ?? false);

  const response = NextResponse.json({
    hasKey: true,
    key: binding.key,
    boundAt: binding.boundAt,
    resetUsed,
  });
  setLicensedCookie(response, user.id);
  return response;
}
