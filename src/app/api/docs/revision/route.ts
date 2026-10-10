import { NextRequest, NextResponse } from "next/server";
import { getRevisionId } from "@/lib/google";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The document's current revision, polled to mirror changes made in Google Docs. */
export async function GET(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  try {
    const revisionId = await withGoogleToken(user, (token) => getRevisionId(token, id));
    return applyAuthCookies(NextResponse.json({ revisionId }, { headers: { "Cache-Control": "no-store" } }), user);
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    return NextResponse.json({ error: "Couldn't check the document" }, { status: status === 403 || status === 404 ? status : 502 });
  }
}
