import { NextRequest, NextResponse } from "next/server";
import { exportPdf } from "@/lib/google";
import { pdfPageTexts } from "@/lib/page-text";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The text of each page of a Google Doc as Docs itself paginates it (from Drive's PDF export). */
export async function GET(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  try {
    const pdf = await withGoogleToken(user, (token) => exportPdf(token, id));
    const pages = (await pdfPageTexts(pdf)).map((p) => p.slice(0, 2000));
    return applyAuthCookies(NextResponse.json({ pages }, { headers: { "Cache-Control": "no-store" } }), user);
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    console.error("Failed to export doc pages:", error);
    return NextResponse.json({ error: "Couldn't read the document's pages" }, { status: 502 });
  }
}
