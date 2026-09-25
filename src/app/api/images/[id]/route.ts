import { NextRequest, NextResponse } from "next/server";
import { loadImage } from "@/lib/image-store";

export const dynamic = "force-dynamic";

/** Public on purpose: Google fetches the image from here when it inserts it. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const image = await loadImage(params.id);
  if (!image) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.mime,
      "Content-Length": String(image.bytes.length),
      "Cache-Control": "public, max-age=1209600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
