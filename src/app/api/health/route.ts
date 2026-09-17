import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { Client } from "@upstash/qstash";
import { getBaseUrl } from "@/lib/base-url";

export const dynamic = "force-dynamic";

type Check = { ok: boolean; detail: string };

function describe(name: string): { present: boolean; length: number; prefix: string; whitespace: boolean } {
  const raw = process.env[name];
  return {
    present: !!raw,
    length: raw?.length ?? 0,
    prefix: raw ? raw.slice(0, 4) + "…" : "",
    whitespace: !!raw && raw !== raw.trim(),
  };
}

/**
 * Live configuration check. Only available to a signed-in user.
 * Never returns secret values, only whether they are present and whether
 * the service accepts them.
 */
export async function GET(req: NextRequest) {
  const signedIn = req.cookies.has("google_access_token") || req.cookies.has("google_refresh_token");
  if (!signedIn) {
    return NextResponse.json({ error: "Sign in first, then open this page again." }, { status: 401 });
  }

  const env = {
    GOOGLE_CLIENT_ID: describe("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: describe("GOOGLE_CLIENT_SECRET"),
    NEXT_PUBLIC_BASE_URL: describe("NEXT_PUBLIC_BASE_URL"),
    UPSTASH_REDIS_REST_URL: describe("UPSTASH_REDIS_REST_URL"),
    UPSTASH_REDIS_REST_TOKEN: describe("UPSTASH_REDIS_REST_TOKEN"),
    QSTASH_TOKEN: describe("QSTASH_TOKEN"),
    QSTASH_CURRENT_SIGNING_KEY: describe("QSTASH_CURRENT_SIGNING_KEY"),
    QSTASH_NEXT_SIGNING_KEY: describe("QSTASH_NEXT_SIGNING_KEY"),
    CRON_SECRET: describe("CRON_SECRET"),
  };

  const checks: Record<string, Check> = {};

  checks.baseUrl = { ok: true, detail: getBaseUrl(req) };

  // Redis
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    checks.redis = { ok: false, detail: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set" };
  } else {
    try {
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      const pong = await redis.ping();
      checks.redis = { ok: pong === "PONG", detail: `PING → ${String(pong)}` };
    } catch (err) {
      checks.redis = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // QStash token
  const qtoken = process.env.QSTASH_TOKEN;
  if (!qtoken) {
    checks.qstash = { ok: false, detail: "QSTASH_TOKEN not set" };
  } else if (qtoken.trim().startsWith("sig_")) {
    checks.qstash = { ok: false, detail: "QSTASH_TOKEN contains a signing key (sig_…). Use the value labelled QSTASH_TOKEN instead." };
  } else {
    try {
      const client = new Client({ token: qtoken.trim() });
      const schedules = await client.schedules.list();
      checks.qstash = { ok: true, detail: `token accepted (${schedules.length} schedules)` };
    } catch (err) {
      checks.qstash = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // QStash signing keys (format only)
  const cur = process.env.QSTASH_CURRENT_SIGNING_KEY ?? "";
  const nxt = process.env.QSTASH_NEXT_SIGNING_KEY ?? "";
  checks.qstashSigningKeys = {
    ok: cur.startsWith("sig_") && nxt.startsWith("sig_"),
    detail:
      cur.startsWith("sig_") && nxt.startsWith("sig_")
        ? "both look like signing keys"
        : "both should start with sig_ (copy QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY from the QStash page)",
  };

  checks.google = {
    ok: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    detail: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? "client id + secret set" : "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing",
  };

  const allOk = Object.values(checks).every((c) => c.ok);
  return NextResponse.json({ ok: allOk, deployment: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local", checks, env });
}
