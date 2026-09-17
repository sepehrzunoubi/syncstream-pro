import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasToken =
    req.cookies.has("google_access_token") || req.cookies.has("google_refresh_token");

  // Authenticated user visiting / → redirect to /dashboard (server-side, no flash)
  if (pathname === "/" && hasToken) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Unauthenticated user visiting /dashboard → redirect to /
  if (pathname === "/dashboard" && !hasToken) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard"],
};
