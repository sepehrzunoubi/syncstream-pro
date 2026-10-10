/**
 * Live end-to-end test against the real Google Docs API.
 *
 *   npm run e2e:live:auth            # once: prints the refresh token to put in E2E_GOOGLE_REFRESH_TOKEN
 *   npm run e2e:live                 # creates a throwaway doc, runs scenarios A, B and C, deletes it
 *   npm run e2e:live -- --keep       # keep the document afterwards
 *   npm run e2e:live -- --dry-run    # the same scenarios against the in-memory stub, no Google
 *
 * Options: --seed N, --typos 0..1, --pace-ms N (gap between Google calls, default 700),
 *          --collab-after N (scenario C: the collaborator writes after N runner writes, default 2),
 *          --verbose (runner chatter).
 *
 * Reads GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and E2E_GOOGLE_REFRESH_TOKEN from the
 * environment or .env.local. Exit code 1 when any check fails; the document's URL is
 * printed whenever it is kept.
 */

import { Report } from "./compare";
import { googleDocs, type E2EDocs } from "./docs-client";
import { loadLocalEnv, requireEnv } from "./env";
import { runE2E } from "./scenarios";
import { createStubDocs } from "./stub-docs";

interface Args { keep: boolean; dryRun: boolean; verbose: boolean; seed: number; typos: number; paceMs: number; collabAfter: number }

export function parseArgs(argv: string[]): Args {
  const a: Args = { keep: false, dryRun: false, verbose: false, seed: 7, typos: 0.7, paceMs: 700, collabAfter: 2 };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split("=");
    const next = () => inline ?? argv[++i];
    const num = (name: string) => {
      const v = Number(next());
      if (!Number.isFinite(v)) throw new Error(`${name} needs a number`);
      return v;
    };
    switch (k) {
      case "--keep": a.keep = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--verbose": a.verbose = true; break;
      case "--seed": a.seed = num(k) >>> 0; break;
      case "--typos": a.typos = Math.max(0, Math.min(1, num(k))); break;
      case "--pace-ms": a.paceMs = Math.max(0, num(k)); break;
      case "--collab-after": a.collabAfter = Math.max(1, Math.round(num(k))); break;
      case "--help": case "-h":
        console.log("Usage: npm run e2e:live -- [--keep] [--dry-run] [--seed N] [--typos 0..1] [--pace-ms N] [--collab-after N] [--verbose]");
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default: throw new Error(`Unknown option ${k}`);
    }
  }
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const read = loadLocalEnv();
  const log = (line: string) => console.log(line);
  let docs: E2EDocs;
  if (args.dryRun) {
    log("Dry run: the scenarios run against the in-memory Docs stub, Google is not called.");
    docs = createStubDocs();
  } else {
    const env = requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "E2E_GOOGLE_REFRESH_TOKEN"]);
    if (!env.ok) {
      console.error(`Missing ${env.missing.join(", ")}${read.length ? ` (read ${read.join(", ")})` : " (no .env.local found)"}.`);
      console.error("Run `npm run e2e:live:auth` once to get a refresh token, then put it in E2E_GOOGLE_REFRESH_TOKEN.");
      return 2;
    }
    const client = googleDocs({ clientId: env.values.GOOGLE_CLIENT_ID, clientSecret: env.values.GOOGLE_CLIENT_SECRET, refreshToken: env.values.E2E_GOOGLE_REFRESH_TOKEN, paceMs: args.paceMs, log });
    try {
      await client.accessToken();
    } catch (err) {
      console.error(`Could not mint an access token from E2E_GOOGLE_REFRESH_TOKEN: ${err instanceof Error ? err.message : String(err)}`);
      console.error("The token may have been revoked or expired (OAuth apps in testing status expire refresh tokens after 7 days). Run `npm run e2e:live:auth` again.");
      return 2;
    }
    log(`Signed in. Calls are spaced ${args.paceMs}ms apart; the run makes a few hundred Docs API requests and touches only the document it creates.`);
    docs = client;
  }
  // The runner logs through src/lib/log; show its chatter only with --verbose
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = args.verbose ? "debug" : "warn";
  const report = new Report(log);
  const result = await runE2E(docs, report, { seed: args.seed, typoFrequency: args.typos, keep: args.keep, collaboratorAfterWrite: args.collabAfter, verbose: args.verbose, log, ...(args.dryRun ? { sleep: async () => {} } : {}) });
  log("");
  log(`${result.ok ? "PASS" : "FAIL"} — ${report.summary()}`);
  if (!result.deleted) log(`Document: ${result.url}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("run.ts") || process.argv[1]?.endsWith("/run")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    }
  );
}
