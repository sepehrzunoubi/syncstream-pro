import { NextRequest, NextResponse } from "next/server";
import { applyAuthCookies, resolveUser, unauthorized } from "@/lib/auth";
import { getBaseUrl } from "@/lib/base-url";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, saveImage } from "@/lib/image-store";

export const dynamic = "force-dynamic";

/** Upload an image (as a data URL) so Google Docs can fetch it during a sync. */
export async function POST(req: NextRequest) {
  const user = await resolveUser(req);
  if (!user) return unauthorized();

  const body = (await req.json().catch(() => null)) as { dataUrl?: unknown } | null;
  const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
  const m = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m || !IMAGE_TYPES.has(m[1])) {
    return NextResponse.json({ error: "Images must be PNG, JPEG or GIF" }, { status: 400 });
  }
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "That image is too large. Try a smaller one." }, { status: 413 });
  }
  const id = await saveImage(m[1], m[2]);
  return applyAuthCookies(NextResponse.json({ url: `${getBaseUrl(req)}/api/images/${id}` }), user);
}
