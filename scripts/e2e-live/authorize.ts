/**
 * One-time authorization for the live end-to-end test.
 *
 *   npm run e2e:live:auth
 *
 * Prints the Google sign-in URL for this app's OAuth client (the same scopes
 * the app asks for, with access_type=offline and prompt=consent so Google
 * issues a refresh token), waits for the redirect or for a pasted code, and
 * prints the refresh token to put in E2E_GOOGLE_REFRESH_TOKEN.
 *
 * The redirect goes to GOOGLE_REDIRECT_URI (the one registered for the OAuth
 * client, e.g. http://localhost:3000/api/auth/callback). When nothing is
 * listening on that port the script listens there itself and catches the
 * code; otherwise (the dev server is running, or the URI is not local) the
 * browser shows a page or an error and the code can be pasted from the
 * address bar. Reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the
 * environment or .env.local. Nothing is written to disk.
 */

import http from "node:http";
import readline from "node:readline";
import { getAuthUrl, getTokensFromCode } from "../../src/lib/google";
import { loadLocalEnv, requireEnv } from "./env";

/** The code from a pasted callback URL, a bare code, or null */
export function extractCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.searchParams.get("code");
  } catch {
    return /^[\w./-]+$/.test(s) ? s : null;
  }
}

function listenForCode(redirect: URL): Promise<{ code: Promise<string>; close: () => void } | null> {
  return new Promise((resolve) => {
    let settle: (code: string) => void = () => {};
    const code = new Promise<string>((r) => { settle = r; });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirect.origin);
      const got = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (url.pathname !== redirect.pathname || (!got && !error)) { res.statusCode = 404; res.end("Not the callback"); return; }
      if (error) { res.end(`Google reported: ${error}. You can close this tab.`); return; }
      res.end("SyncStream e2e: authorization received. You can close this tab.");
      settle(got!);
    });
    server.once("error", () => resolve(null));
    const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
    server.listen(port, redirect.hostname === "localhost" ? "127.0.0.1" : redirect.hostname, () => resolve({ code, close: () => server.close() }));
  });
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(prompt, (answer) => { rl.close(); r(answer); }));
}

async function main(): Promise<number> {
  loadLocalEnv();
  const env = requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  if (!env.ok) {
    console.error(`Missing ${env.missing.join(", ")}: set them in .env.local (see .env.example).`);
    return 2;
  }
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || "http://localhost:3000/api/auth/callback";
  const redirect = new URL(redirectUri);
  const authUrl = getAuthUrl(redirectUri);
  console.log("\n1. Open this URL in a browser, signed in as the Google account whose Drive the test may create and delete a document in:\n");
  console.log(authUrl);
  console.log("\n   (The URL asks for the app's own scopes with access_type=offline&prompt=consent, so Google issues a refresh token.)");

  const local = redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1";
  const listener = local ? await listenForCode(redirect) : null;
  let code: string | null = null;
  if (listener) {
    console.log(`\n2. Listening on ${redirect.origin}${redirect.pathname} for the redirect. If the browser does not come back here, paste the code or the full redirected URL below.\n`);
    code = await Promise.race([listener.code, ask("Code (or redirected URL): ").then((s) => extractCode(s) ?? "")]);
    listener.close();
  } else {
    console.log(`\n2. After consenting, the browser is sent to ${redirectUri}. Copy the \`code\` from its address bar (the page itself may fail to load; that is fine).\n`);
    code = extractCode(await ask("Code (or redirected URL): "));
  }
  if (!code) {
    console.error("No authorization code received.");
    return 1;
  }
  const tokens = await getTokensFromCode(code, redirectUri);
  if (!tokens.refresh_token) {
    console.error("Google returned no refresh token. Revoke the app at https://myaccount.google.com/permissions and try again (prompt=consent only yields one on a fresh grant).");
    return 1;
  }
  console.log("\n3. Refresh token (keep it secret; it grants Docs and Drive access for this account):\n");
  console.log(`E2E_GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("\n   Put that line in .env.local (ignored by git) for local runs, or add it as a repository secret for the e2e-live workflow.");
  console.log("   Then: npm run e2e:live");
  if (!tokens.scope?.includes("auth/documents")) console.log(`\n   Granted scopes: ${tokens.scope ?? "(unknown)"} — the test needs documents and drive.file.`);
  return 0;
}

if (process.argv[1]?.endsWith("authorize.ts") || process.argv[1]?.endsWith("authorize")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  );
}
