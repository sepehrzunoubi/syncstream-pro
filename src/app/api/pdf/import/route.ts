import { NextRequest, NextResponse } from "next/server";
import { applyAuthCookies, resolveUser, unauthorized } from "@/lib/auth";
import { getBaseUrl } from "@/lib/base-url";
import { importPdfForEditor, MAX_PDF_BODY, readCapped, TOO_LARGE_MESSAGE } from "@/lib/pdf-route";
import { withRoute } from "@/lib/route";
import { jsonReply } from "@/lib/json-response";
import { rateLimited } from "@/lib/rate-limit";
import { log, startTimer, uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";
// pdf.js and the image encoder are Node libraries
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Import PDF: the PDF itself is the body (Content-Type application/pdf). Answers with the editor
 * content that rebuilds it, every part of it new text for a sync, its images already stored.
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "pdf.import", { max: 10, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const uid = uidTag(user.userId);
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/pdf") return NextResponse.json({ error: "Send the PDF file itself.", code: "invalid" }, { status: 415 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  const bytes = declared > MAX_PDF_BODY ? null : await readCapped(req.body, MAX_PDF_BODY);
  if (!bytes) {
    log.info("pdf.import_refused", { uid, code: "tooLarge", bytes: declared || undefined });
    return NextResponse.json({ error: TOO_LARGE_MESSAGE, code: "tooLarge" }, { status: 413 });
  }

  const done = startTimer();
  const reply = await importPdfForEditor(bytes, {
    baseUrl: getBaseUrl(req),
    onProblem: (event, err) => log.error(event, { uid, bytes: bytes.length, err }),
  });
  if (!reply.ok) {
    const { code } = reply.body;
    // A PDF that can't be imported is the file's doing, not ours: only unexpected failures are errors
    if (code !== "failed") log.info("pdf.import_refused", { uid, code, bytes: bytes.length, ms: done() });
    return applyAuthCookies(NextResponse.json(reply.body, { status: reply.status }), user);
  }
  const { body } = reply;
  log.info("pdf.import", { uid, bytes: bytes.length, pages: body.pages, tagged: body.tagged, nodes: body.nodes.length, images: body.stats.images, warnings: body.warnings.length, ms: done() });
  // (a long PDF's content runs past what Vercel sends as it is: gzipped, it fits)
  return applyAuthCookies(jsonReply(req, body, { headers: { "Cache-Control": "no-store" } }), user);
});
