import { NextResponse } from "next/server";

const COOKIE_NAME = "syncstream_licensed";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/**
 * Set the licensed cookie on a response. Called after successful key redemption
 * or when key status is verified. The value is the Google user ID — not secret
 * since it's httpOnly, but gives us something to cross-check.
 */
export function setLicensedCookie(response: NextResponse, googleId: string): void {
  response.cookies.set(COOKIE_NAME, googleId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

/**
 * Clear the licensed cookie (on key reset or logout).
 */
export function clearLicensedCookie(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", { maxAge: 0, path: "/" });
}

/**
 * Check if the licensed cookie is present on a request.
 */
export function hasLicensedCookie(cookies: { has: (name: string) => boolean }): boolean {
  return cookies.has(COOKIE_NAME);
}

export { COOKIE_NAME };
