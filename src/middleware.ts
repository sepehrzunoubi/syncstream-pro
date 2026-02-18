import { NextRequest, NextResponse } from "next/server";

// API paths that require a valid license key (beyond auth)
const KEY_PROTECTED_PREFIXES = [
  "/api/sync/",
  "/api/docs",
  "/api/wordcount",
];

// API paths that are exempt from key checks (auth + key management)
const KEY_EXEMPT_PATHS = [
  "/api/auth/",
  "/api/keys/",
  "/api/sync/process",  // Only called internally (start route + self-chain); no cookies on server-to-server fetch
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasToken = req.cookies.has("google_access_token") || req.cookies.has("google_refresh_token");

  // Authenticated user visiting / → redirect to /dashboard (server-side, no flash)
  if (pathname === "/" && hasToken) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Unauthenticated user visiting /dashboard → redirect to /
  if (pathname === "/dashboard" && !hasToken) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  // Key-gate enforcement for protected API routes
  if (pathname.startsWith("/api/")) {
    const isExempt = KEY_EXEMPT_PATHS.some((p) => pathname.startsWith(p));
    if (!isExempt) {
      const isProtected = KEY_PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
      if (isProtected) {
        const licensedValue = req.cookies.get("syncstream_licensed")?.value;
        const googleIdValue = req.cookies.get("google_user_id")?.value;

        // Check 1: licensed cookie must exist
        if (!licensedValue) {
          return NextResponse.json(
            { error: "License key required. Please activate your key." },
            { status: 403 }
          );
        }

        // Check 2: licensed cookie must match the current user's Google ID.
        // If google_user_id cookie is missing (old session), allow through
        // but the /api/keys/status endpoint will do the full Redis check.
        // If it IS present and doesn't match → different user, block.
        if (googleIdValue && licensedValue !== googleIdValue) {
          const response = NextResponse.json(
            { error: "License key does not belong to this account. Please re-activate." },
            { status: 403 }
          );
          // Clear the stale licensed cookie so the user gets the KeyGate
          response.cookies.set("syncstream_licensed", "", { maxAge: 0, path: "/" });
          return response;
        }
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard", "/api/:path*"],
};
