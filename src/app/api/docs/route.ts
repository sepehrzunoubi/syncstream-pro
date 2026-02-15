import { NextRequest, NextResponse } from "next/server";
import { listRecentDocs } from "@/lib/google";

export async function GET(req: NextRequest) {
  const token = req.cookies.get("google_access_token")?.value;

  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const docs = await listRecentDocs(token, 15);
    return NextResponse.json({ docs });
  } catch (error) {
    console.error("Failed to list docs:", error);
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 }
    );
  }
}
