import { NextRequest, NextResponse } from "next/server";
import { getUserInfo } from "@/lib/google";

export async function GET(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;

  if (!token) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  try {
    const user = await getUserInfo(token);
    return NextResponse.json({ authenticated: true, user });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}
