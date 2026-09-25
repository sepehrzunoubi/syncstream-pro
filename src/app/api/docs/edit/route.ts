import { NextRequest, NextResponse } from "next/server";
import { editDocument } from "@/lib/google";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The kinds of change the editor saves directly (formatting, deleting, restoring text) */
const ALLOWED = new Set([
  "updateTextStyle",
  "updateParagraphStyle",
  "deleteContentRange",
  "insertText",
  "insertInlineImage",
  "createParagraphBullets",
  "deleteParagraphBullets",
]);
const MAX_REQUESTS = 2000;

/** Save direct edits to a Google Doc. */
export async function POST(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  let body: { documentId?: unknown; revisionId?: unknown; requests?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(documentId)) return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  const requests = body.requests;
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_REQUESTS) {
    return NextResponse.json({ error: "Invalid edits" }, { status: 400 });
  }
  for (const r of requests) {
    const keys = r && typeof r === "object" ? Object.keys(r) : [];
    if (keys.length !== 1 || !ALLOWED.has(keys[0])) return NextResponse.json({ error: "Unsupported edit" }, { status: 400 });
  }
  const revisionId = typeof body.revisionId === "string" && body.revisionId ? body.revisionId : undefined;
  try {
    const next = await withGoogleToken(user, (token) => editDocument(token, documentId, requests as object[], revisionId));
    return applyAuthCookies(NextResponse.json({ revisionId: next }), user);
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    const message = (error as { message?: string })?.message ?? "";
    console.error("Failed to save edits:", message);
    // 400 usually means the edit no longer fits the document (it changed elsewhere)
    return NextResponse.json(
      { error: status === 403 ? "SyncStream can't edit this document." : "Couldn't save that change to Google Docs.", code: status === 400 ? "conflict" : undefined },
      { status: status === 403 ? 403 : status === 400 ? 409 : 502 }
    );
  }
}
