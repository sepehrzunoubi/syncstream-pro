import { NextRequest, NextResponse } from "next/server";
import { getUserInfo, refreshAccessToken } from "@/lib/google";
import { redeemKey, checkRateLimit, seedKeysIfNeeded } from "@/lib/key-store";
import { setLicensedCookie } from "@/lib/key-cookie";

export async function POST(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;
  const refreshToken = req.cookies.get("google_refresh_token")?.value;

  if (!token && !refreshToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let user: { id: string; name: string; email: string; picture: string } | null = null;

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
      { error: "Too many attempts. Please wait before trying again.", remaining: rateCheck.remaining },
      { status: 429 }
    );
  }

  // Parse body
  let body: { key?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const inputKey = body.key;
  if (!inputKey || typeof inputKey !== "string" || inputKey.trim().length === 0) {
    return NextResponse.json({ error: "License key is required." }, { status: 400 });
  }

  // Validate key length/format before hitting storage
  const normalized = inputKey.trim().toUpperCase();
  if (!/^SYNCLIFETIME-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(normalized)) {
    return NextResponse.json({ error: "Invalid key format." }, { status: 400 });
  }

  await seedKeysIfNeeded();

  const result = await redeemKey(normalized, user.id, user.email);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const response = NextResponse.json({ success: true, key: normalized });
  setLicensedCookie(response, user.id);
  return response;
}
