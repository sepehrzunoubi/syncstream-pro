import { NextRequest, NextResponse } from "next/server";
import { getDocWordCount } from "@/lib/google";

export async function GET(req: NextRequest) {
  const accessToken = req.cookies.get("google_access_token")?.value;

  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const documentId = searchParams.get("documentId");

  if (!documentId) {
    return NextResponse.json({ error: "Missing documentId" }, { status: 400 });
  }

  try {
    const wordCount = await getDocWordCount(accessToken, documentId);
    return NextResponse.json({ wordCount });
  } catch (error) {
    console.error("Word count fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch word count" },
      { status: 500 }
    );
  }
}
