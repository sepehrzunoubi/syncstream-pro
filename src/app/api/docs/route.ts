import { NextRequest, NextResponse } from "next/server";
import { listRecentDocs } from "@/lib/google";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "docs.list", { max: 60, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  try {
    const docs = await withGoogleToken(user, (token) => listRecentDocs(token, 25));
    return applyAuthCookies(NextResponse.json({ docs }), user);
  } catch (error) {
    const status = googleStatus(error);
    log.error("docs.list_failed", { uid: uidTag(user.userId), status, err: error });
    if (status === 401 || status === 403) return unauthorized();
    return NextResponse.json({ error: "Couldn't load your Google Docs" }, { status: 502 });
  }
});
