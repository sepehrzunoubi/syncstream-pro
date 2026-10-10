import { NextRequest, NextResponse } from "next/server";
import { editDocumentWithReplies } from "@/lib/google";
import { applyAuthCookies, googleStatus, resolveUser, tooLarge, unauthorized, withGoogleToken } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, startTimer, uidTag } from "@/lib/log";

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
  "updateDocumentStyle",
  "insertPageBreak",
  "insertSectionBreak",
  "createHeader",
  "createFooter",
  "deleteHeader",
  "deleteFooter",
  "createFootnote",
  "updateSectionStyle",
]);
const MAX_REQUESTS = 2000;

/**
 * Save direct edits to a Google Doc. The editor debounces saves by ~700ms while
 * typing, so even continuous typing stays far below the per-user budget.
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "docs.edit", { max: 120, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const big = tooLarge(req, 4_000_000);
  if (big) return big;
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
  const done = startTimer();
  try {
    const next = await withGoogleToken(user, (token) => editDocumentWithReplies(token, documentId, requests as object[], revisionId));
    log.info("docs.edit", { uid: uidTag(user.userId), requests: requests.length, ms: done() });
    return applyAuthCookies(NextResponse.json({ revisionId: next.revisionId, replies: next.replies }), user);
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    const message = (error as { message?: string })?.message ?? "";
    log.error("docs.edit_failed", { uid: uidTag(user.userId), requests: requests.length, ms: done(), status, err: message });
    // 400 usually means the edit no longer fits the document (it changed elsewhere)
    return NextResponse.json(
      { error: status === 403 ? "SyncStream can't edit this document." : "Couldn't save that change to Google Docs.", code: status === 400 ? "conflict" : undefined },
      { status: status === 403 ? 403 : status === 400 ? 409 : 502 }
    );
  }
});
