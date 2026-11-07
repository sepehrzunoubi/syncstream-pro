import { NextRequest, NextResponse } from "next/server";
import { canEditDocument, getRawDocument } from "@/lib/google";
import { buildSides } from "@/lib/compare-server";
import type { CompareLoadResponse } from "@/lib/compare-types";
import { applyAuthCookies, googleStatus, resolveUser, unauthorized, withGoogleToken } from "@/lib/auth";
import { withRoute } from "@/lib/route";
import { rateLimited } from "@/lib/rate-limit";
import { log, startTimer, uidTag } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isDocId = (v: string) => /^[A-Za-z0-9_-]{10,200}$/.test(v);

/**
 * Both documents of a comparison, every tab: yours as it is, and the reference imported against
 * the named styles of the tabs its content goes into. `map` (JSON) says where reference tabs go;
 * the rest are matched automatically.
 */
export const GET = withRoute(async (req: NextRequest) => {
  const user = await resolveUser(req);
  if (!user) return unauthorized();
  const limited = await rateLimited(req, "compare.load", { max: 30, windowMs: 60_000, userId: user.userId });
  if (limited) return limited;
  const leftId = req.nextUrl.searchParams.get("left") ?? "";
  const rightId = req.nextUrl.searchParams.get("right") ?? "";
  if (!isDocId(leftId) || !isDocId(rightId)) return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  if (leftId === rightId) return NextResponse.json({ error: "Pick two different documents to compare." }, { status: 400 });
  let map: unknown = undefined;
  const rawMap = req.nextUrl.searchParams.get("map");
  if (rawMap) {
    try { map = JSON.parse(rawMap); } catch { return NextResponse.json({ error: "Invalid tab map" }, { status: 400 }); }
  }
  const done = startTimer();
  // Which of the two failed, for the message
  let reading: "left" | "right" = "left";
  try {
    const { left, right, canEdit } = await withGoogleToken(user, async (token) => {
      reading = "left";
      const [l, edit] = await Promise.all([getRawDocument(token, leftId), canEditDocument(token, leftId).catch(() => true)]);
      reading = "right";
      const r = await getRawDocument(token, rightId);
      return { left: l, right: r, canEdit: edit };
    });
    const sides = buildSides(left, leftId, right, rightId, map);
    const body: CompareLoadResponse = { ...sides, canEdit };
    log.info("compare.load", { uid: uidTag(user.userId), leftTabs: sides.left.tabs.length, rightTabs: sides.right.tabs.length, ms: done() });
    return applyAuthCookies(NextResponse.json(body, { headers: { "Cache-Control": "no-store" } }), user);
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401) return unauthorized();
    const which = reading === "left" ? "your document" : "the reference document";
    if (status === 403) return NextResponse.json({ error: `SyncStream can't open ${which}. Check that your Google account can open it.` }, { status: 403 });
    if (status === 404) return NextResponse.json({ error: `Couldn't find ${which}. It may have been deleted, or the link is wrong.` }, { status: 404 });
    log.error("compare.load_failed", { uid: uidTag(user.userId), status, err: error });
    return NextResponse.json({ error: "Couldn't load the documents. Try again." }, { status: 502 });
  }
});
