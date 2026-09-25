import { NextRequest, NextResponse } from "next/server";
import { createGoogleDoc } from "@/lib/google";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();

  const { title } = (await req.json().catch(() => ({}))) as { title?: unknown };
  const name = typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : "Untitled document";

  try {
    const doc = await withGoogleToken(user, (token) => createGoogleDoc(token, name));
    return applyAuthCookies(NextResponse.json(doc), user);
  } catch (err) {
    console.error("Failed to create Google Doc:", err);
    const status = googleStatus(err);
    if (status === 401) return unauthorized();
    if (status === 403) {
      return NextResponse.json({ error: "Google didn't allow SyncStream to create documents. Reconnect your Google account from the account menu." }, { status: 403 });
    }
    return NextResponse.json({ error: "Couldn't create the document. Try again." }, { status: 502 });
  }
}
