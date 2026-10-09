import { NextRequest, NextResponse } from "next/server";
import { renameDoc } from "@/lib/google";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Rename a Google Doc, as clicking its title in Docs does. */
export async function POST(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as { documentId?: unknown; name?: unknown };
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(documentId)) return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Enter a name" }, { status: 400 });
  try {
    const saved = await withGoogleToken(user, (token) => renameDoc(token, documentId, name));
    return applyAuthCookies(NextResponse.json({ name: saved }), user);
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    console.error("Failed to rename doc:", error);
    return NextResponse.json({ error: status === 403 ? "SyncStream can't rename this document." : "Couldn't rename the document" }, { status: status === 403 ? 403 : 502 });
  }
}
