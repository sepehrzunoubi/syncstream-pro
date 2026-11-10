import { NextRequest, NextResponse } from "next/server";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";
import { exportSpreadsheet } from "@/lib/google";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * A Google Sheet as the .xlsx Google exports of it, for Compare & Sync: the page reads it like any
 * workbook, so "what the spreadsheet holds now" is read by the same code as the reference.
 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "sheets.export", { max: 20, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return NextResponse.json({ error: "Invalid spreadsheet id" }, { status: 400 });
  try {
    const xlsx = await withGoogleToken(user, (t) => exportSpreadsheet(t, id));
    return applyAuthCookies(new NextResponse(Buffer.from(xlsx), { status: 200, headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Cache-Control": "no-store" } }), user);
  } catch (err) {
    const status = googleStatus(err);
    log.warn("sheets.export_failed", { uid: uidTag(user.userId), status, err });
    if (status === 401) return unauthorized();
    if (status === 404) return NextResponse.json({ error: "That spreadsheet could not be found." }, { status: 404 });
    if (status === 403) return NextResponse.json({ error: "SyncStream can't open that spreadsheet. Reconnect your Google account." }, { status: 403 });
    return NextResponse.json({ error: "The spreadsheet couldn't be read just now. Try again." }, { status: 502 });
  }
});
