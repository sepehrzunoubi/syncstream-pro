import { NextRequest, NextResponse } from "next/server";
import { listRecentDocs } from "@/lib/google";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  try {
    const docs = await withGoogleToken(user, (token) => listRecentDocs(token, 25));
    return applyAuthCookies(NextResponse.json({ docs }), user);
  } catch (error) {
    console.error("Failed to list docs:", error);
    const status = googleStatus(error);
    if (status === 401 || status === 403) return unauthorized();
    return NextResponse.json({ error: "Couldn't load your Google Docs" }, { status: 502 });
  }
}
