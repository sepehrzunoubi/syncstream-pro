import { NextRequest, NextResponse } from "next/server";
import { exportPdf } from "@/lib/google";
import { isTabId } from "@/lib/doc-tabs";
import { pdfPageTexts } from "@/lib/page-text";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * The text of each page of a Google Doc as Docs itself paginates it (from its PDF export): of one
 * tab, `tab`, when the document has tabs. The first tab falls back to Drive's export.
 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "docs.pages", { max: 90, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  const tab = req.nextUrl.searchParams.get("tab") || null;
  if (tab && !isTabId(tab)) return NextResponse.json({ error: "Invalid tab" }, { status: 400 });
  const first = req.nextUrl.searchParams.get("first") === "1";
  try {
    const pdf = await withGoogleToken(user, async (token) => {
      try { return await exportPdf(token, id, tab); } catch (err) {
        if (!tab || !first || googleStatus(err) === 401) throw err;
        return exportPdf(token, id);
      }
    });
    const pages = (await pdfPageTexts(pdf)).map((p) => p.slice(0, 2000));
    return applyAuthCookies(NextResponse.json({ pages }, { headers: { "Cache-Control": "no-store" } }), user);
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    log.error("docs.pages_failed", { uid: uidTag(user.userId), status, err: error });
    return NextResponse.json({ error: "Couldn't read the document's pages" }, { status: 502 });
  }
});
