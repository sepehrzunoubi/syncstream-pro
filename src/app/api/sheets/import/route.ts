import { NextRequest, NextResponse } from "next/server";
import { applyAuthCookies, googleStatus, resolveUser, tooLarge, unauthorized, withGoogleToken } from "@/lib/auth";
import { convertToGoogleSheet } from "@/lib/google";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, startTimer, uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A file as the page sends it: under what a function on Vercel takes (4.5 MB) */
const MAX_BODY = 4_300_000;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** What the bytes are, by how they start: an old Excel workbook (or a password's wrapper), or a zipped one */
function kindOf(bytes: Uint8Array): string | null {
  if (bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "application/vnd.ms-excel";
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return XLSX;
  return null;
}

/**
 * A workbook the page can't read itself (an old .xls) as Google Sheets reads it: the file is put in
 * the person's Drive for Google to convert, the spreadsheet it becomes is downloaded as an .xlsx,
 * and the copy in Drive is deleted. The page then reads that .xlsx like any other, so what it shows
 * and what a sync builds is what Google Sheets itself makes of the file.
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "sheets.import", { max: 10, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const big = tooLarge(req, MAX_BODY);
  const tooBig = () => NextResponse.json({ error: "This file is too large to convert here (4 MB at most). Open it in Excel or Google Sheets, save it as .xlsx, and upload that.", code: "too_large" }, { status: 413 });
  if (big) return tooBig();
  const done = startTimer();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_BODY) return tooBig();
  const kind = kindOf(bytes);
  if (!kind) return NextResponse.json({ error: "This isn't an Excel workbook." }, { status: 400 });
  const name = (req.nextUrl.searchParams.get("name") ?? "Workbook").replace(/[\u0000-\u001f]/g, " ").replace(/\.(xlsx?|xlsm|xlt|xla)$/i, "").trim().slice(0, 200) || "Workbook";
  try {
    const xlsx = await withGoogleToken(user, (t) => convertToGoogleSheet(t, bytes, kind, name));
    log.info("sheets.import", { uid: uidTag(user.userId), bytes: bytes.length, out: xlsx.length, ms: done() });
    return applyAuthCookies(new NextResponse(Buffer.from(xlsx), { status: 200, headers: { "Content-Type": XLSX, "Cache-Control": "no-store" } }), user);
  } catch (err) {
    const status = googleStatus(err);
    log.error("sheets.import_failed", { uid: uidTag(user.userId), status, err });
    if (status === 401) return unauthorized();
    if (status === 403) return NextResponse.json({ error: "SyncStream can't use your Google Drive to convert this file. Reconnect your Google account and try again." }, { status: 403 });
    if (status === 400) return NextResponse.json({ error: "Google Sheets couldn't open this file. If it has a password, remove it in Excel and try again." }, { status: 400 });
    return NextResponse.json({ error: "The file couldn't be converted just now. Try again." }, { status: 502 });
  }
});
