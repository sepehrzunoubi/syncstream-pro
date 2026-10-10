import { NextRequest, NextResponse } from "next/server";
import { log, startTimer, uidTag } from "./log";
import { reportError, type ReportContext } from "./monitor";
import { verifySigned } from "./secret";

/**
 * Wraps an API route handler so an unhandled error becomes a JSON 500
 * (`{error:"Internal error"}`), is reported to operators with the route,
 * method, latency and the user's tag, and never leaks a stack to the client.
 *
 *   export const GET = withRoute(async (req) => { ... });
 */

type RouteHandler<C> = (req: NextRequest, ctx: C) => Promise<Response> | Response;

export interface RouteOptions {
  /** Route label in logs; default: the request path */
  name?: string;
  /** Also log one `route.ok` line per successful request (status, ms) */
  logSuccess?: boolean;
  /** Error reporter; default `reportError` */
  report?: (err: unknown, context: ReportContext) => Promise<boolean>;
}

/** The signed uid cookie set by lib/auth (UID_COOKIE), as a tag; "anon" when absent or invalid */
export function requestUid(req: { cookies: { get(name: string): { value: string } | undefined } }): string {
  try {
    return uidTag(verifySigned(req.cookies.get("ss_uid")?.value, "uid"));
  } catch {
    // No signing secret configured (tests): no tag
    return "anon";
  }
}

export function withRoute<C = unknown>(handler: RouteHandler<C>, opts: RouteOptions = {}): (req: NextRequest, ctx: C) => Promise<Response> {
  const report = opts.report ?? reportError;
  return async (req, ctx) => {
    const done = startTimer();
    const route = opts.name ?? req.nextUrl?.pathname ?? "?";
    try {
      const res = await handler(req, ctx);
      if (opts.logSuccess) log.info("route.ok", { route, method: req.method, status: res.status, ms: done(), uid: requestUid(req) });
      return res;
    } catch (err) {
      // Awaited so a serverless function does not freeze before the report leaves; the reporter caps itself at 3s
      await report(err, { event: "route.failed", route, method: req.method, status: 500, ms: done(), uid: requestUid(req) });
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  };
}
