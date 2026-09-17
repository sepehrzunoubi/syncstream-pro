/**
 * Resolve the public origin of this deployment (no trailing slash).
 *
 * Priority:
 *  1. NEXT_PUBLIC_BASE_URL (explicit, recommended in production)
 *  2. Forwarded headers from the current request (works behind Vercel's proxy)
 *  3. Vercel-provided deployment URLs
 *  4. localhost for local dev
 */
export function getBaseUrl(req?: { headers: Headers; nextUrl?: { origin?: string } }): string {
  const fromEnv = normalize(process.env.NEXT_PUBLIC_BASE_URL);
  if (fromEnv) return fromEnv;

  if (req) {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (host) {
      const proto =
        req.headers.get("x-forwarded-proto") ||
        (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
      return `${proto}://${host}`;
    }
    const fromNext = normalize(req.nextUrl?.origin);
    if (fromNext) return fromNext;
  }

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "")}`;

  return "http://localhost:3000";
}

function normalize(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return "";
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}
