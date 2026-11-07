/**
 * JSON replies that can run long (both documents of a comparison, an imported PDF, a sync's text and
 * view): sent gzipped to a browser that takes gzip, as every browser does. A function on Vercel
 * answers at most 4.5 MB, counted as sent, and the browser unpacks the reply before the page reads it.
 */

import { gzipSync } from "node:zlib";
import { NextResponse } from "next/server";

/** Replies smaller than this go as they are: packing them saves little */
export const GZIP_FROM_BYTES = 1_000_000;

/** Whether an Accept-Encoding header takes gzip: named, or "*", and not with q=0 */
export function acceptsGzip(header: string | null | undefined): boolean {
  let any = false;
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.split(";").map((s) => s.trim());
    const q = params.find((p) => p.startsWith("q="));
    const takes = q == null || Number(q.slice(2)) > 0;
    if (name === "gzip" || name === "x-gzip") return takes;
    if (name === "*") any = takes;
  }
  return any;
}

/**
 * NextResponse.json, gzipped once it's large and the request takes gzip. It is a NextResponse like
 * any other: cookies set on it afterwards (applyAuthCookies) go with it.
 */
export function jsonReply(req: { headers: Headers }, body: unknown, init: ResponseInit = {}): NextResponse {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
  if (bytes.length < GZIP_FROM_BYTES) return new NextResponse(bytes, { ...init, headers });
  // (a reply this large differs with what the request takes, so a cache must keep them apart)
  headers.append("Vary", "Accept-Encoding");
  if (!acceptsGzip(req.headers.get("accept-encoding"))) return new NextResponse(bytes, { ...init, headers });
  headers.set("Content-Encoding", "gzip");
  return new NextResponse(gzipSync(bytes), { ...init, headers });
}
