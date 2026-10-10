import { NextRequest, NextResponse } from "next/server";
import { getDocument } from "@/lib/google";
import { importDoc } from "@/lib/doc-import";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";

/** The current content of a Google Doc as locked editor paragraphs, for placing a sync inside it. */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "docs.content", { max: 60, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
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
    log.error("docs.content_failed", { uid: uidTag(user.userId), status, err: error });
    return NextResponse.json({ error: "Couldn't load this document" }, { status: 502 });
  }
});
