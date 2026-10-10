import { NextRequest, NextResponse } from "next/server";
import { loadImage } from "@/lib/image-store";
import { withRoute } from "@/lib/route";

export const dynamic = "force-dynamic";

/** Public on purpose: Google fetches the image from here when it inserts it. */
export const GET = withRoute(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const image = await loadImage(id);
  if (!image) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.mime,
      "Content-Length": String(image.bytes.length),
      "Cache-Control": "public, max-age=1209600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
