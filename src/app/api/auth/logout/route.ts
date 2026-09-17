import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("google_access_token", "", { maxAge: 0, path: "/" });
  response.cookies.set("google_refresh_token", "", { maxAge: 0, path: "/" });
  // Clear cookies left over from the retired license-key system
  response.cookies.set("syncstream_licensed", "", { maxAge: 0, path: "/" });
  response.cookies.set("google_user_id", "", { maxAge: 0, path: "/" });
  return response;
}
