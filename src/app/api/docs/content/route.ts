import { NextRequest, NextResponse } from "next/server";
import { getDocument } from "@/lib/google";
import { importDoc } from "@/lib/doc-import";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The current content of a Google Doc as locked editor paragraphs, for placing a sync inside it. */
export async function GET(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  try {
    const doc = await withGoogleToken(user, (token) => getDocument(token, id));
    return applyAuthCookies(NextResponse.json(importDoc(doc), { headers: { "Cache-Control": "no-store" } }), user);
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    if (status === 403) return NextResponse.json({ error: "SyncStream can't open this document. Reconnect your Google account." }, { status: 403 });
    if (status === 404) return NextResponse.json({ error: "That document could not be found." }, { status: 404 });
    console.error("Failed to load doc content:", error);
    return NextResponse.json({ error: "Couldn't load this document" }, { status: 502 });
  }
}
