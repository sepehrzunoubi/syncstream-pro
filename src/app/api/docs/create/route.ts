import { NextRequest, NextResponse } from "next/server";
import { createGoogleDoc, editDocument } from "@/lib/google";
import { documentStyleRequest, parsePageSetup } from "@/lib/page-setup";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";

export const POST = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "docs.create", { max: 20, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;

  const { title, pageSetup } = (await req.json().catch(() => ({}))) as { title?: unknown; pageSetup?: unknown };
  const name = typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : "Untitled document";
  // The user's default page setup, applied to the new document
  const setup = pageSetup == null ? null : parsePageSetup(pageSetup);

  try {
    const doc = await withGoogleToken(user, (token) => createGoogleDoc(token, name));
    if (setup) {
      try { await withGoogleToken(user, (token) => editDocument(token, doc.id, [documentStyleRequest(setup)])); }
      catch (err) { log.warn("docs.create_page_setup_failed", { uid: uidTag(user.userId), err }); }
    }
    return applyAuthCookies(NextResponse.json(doc), user);
  } catch (err) {
    const status = googleStatus(err);
    log.error("docs.create_failed", { uid: uidTag(user.userId), status, err });
    if (status === 401) return unauthorized();
    if (status === 403) {
      return NextResponse.json({ error: "Google didn't allow SyncStream to create documents. Reconnect your Google account from the account menu." }, { status: 403 });
    }
    return NextResponse.json({ error: "Couldn't create the document. Try again." }, { status: 502 });
  }
});
