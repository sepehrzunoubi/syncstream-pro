import { NextRequest, NextResponse } from "next/server";
import { createGoogleDoc } from "@/lib/google";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { title } = await req.json().catch(() => ({ title: undefined }));

  try {
    const doc = await createGoogleDoc(token, title || "Untitled Document");
    return NextResponse.json(doc);
  } catch (err) {
    console.error("Failed to create Google Doc:", err);
    return NextResponse.json({ error: "Failed to create document" }, { status: 500 });
  }
}
