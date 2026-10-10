import { NextResponse } from "next/server";
import { clearAuthCookies } from "@/lib/auth";
import { withRoute } from "@/lib/route";

export const POST = withRoute(async () => {
  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response);
  return response;
});
