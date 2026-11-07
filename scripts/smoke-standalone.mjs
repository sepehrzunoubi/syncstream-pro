// After `next build`: runs the self-contained server (output: "standalone") as a deployment runs
// it, from a copy with no node_modules above it, so only the files the build shipped are there, and
// imports PDFs through it. A library that loads a file the build didn't ship, or code the bundler
// broke, fails here where a local run (all of node_modules there, nothing bundled) works. Checks a
// tagged and an untagged PDF import, and that CJK text in a font the PDF only names is read, which
// takes pdf.js's character maps. Needs no credentials: the sign-in cookies are made here.
//
//   npm run build && npm run smoke:standalone
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");
const AUTH_SECRET = "smoke-test-secret";
const READY_MS = 60_000;
// The route's own limit
const IMPORT_MS = 60_000;

/** As src/lib/secret.ts signs a cookie: `value.mac`, keyed by the secret and the purpose */
function sign(value, purpose) {
  const key = createHmac("sha256", AUTH_SECRET).update(purpose).digest();
  return `${value}.${createHmac("sha256", key).update(value).digest("base64url")}`;
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/** Links in the copy that lead out of it, which would let it load what the build didn't ship */
function linksOut(top) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink() && path.relative(top, path.resolve(dir, fs.readlinkSync(p))).startsWith("..")) out.push(path.relative(top, p));
    }
  };
  walk(top);
  return out;
}

const textOf = (n) => (n.text ?? "") + (n.content ?? []).map(textOf).join("");

async function main() {
  if (!fs.existsSync(path.join(standalone, "server.js"))) {
    console.error(`${path.relative(root, standalone)}/server.js is missing: run next build first`);
    return false;
  }
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "syncstream-standalone-"));
  let server = null;
  let output = "";
  try {
    for (let up = path.dirname(dir); ; up = path.dirname(up)) {
      if (fs.existsSync(path.join(up, "node_modules"))) throw new Error(`${up} has a node_modules, so the copy could load what the build didn't ship`);
      if (up === path.dirname(up)) break;
    }
    fs.cpSync(standalone, dir, { recursive: true, verbatimSymlinks: true });
    const links = linksOut(dir);
    if (links.length) {
      // The build's tracing doesn't follow a node_modules that is a link, and copies the link itself
      throw new Error(`the standalone output links out of itself (${links.slice(0, 3).join(", ")}): build with a node_modules of the app's own, not a link to one`);
    }

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    // Only what the server needs: no store, queue or Google settings, nothing found outside the copy
    const env = { PATH: process.env.PATH, HOME: dir, PORT: String(port), HOSTNAME: "127.0.0.1", AUTH_SECRET, NEXT_TELEMETRY_DISABLED: "1" };
    server = spawn(process.execPath, ["server.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (d) => { output += d; });
    server.stderr.on("data", (d) => { output += d; });
    const exited = new Promise((resolve) => server.once("exit", (code, signal) => resolve(`server exited (${signal ?? code})`)));

    const deadline = Date.now() + READY_MS;
    for (;;) {
      const ok = await Promise.race([fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false), exited]);
      if (ok === true) break;
      if (typeof ok === "string") throw new Error(ok);
      if (Date.now() > deadline) throw new Error(`server not ready after ${READY_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const cookie = `ss_uid=${sign("smoke-user", "uid")}; google_access_token=smoke-access-token`;
    const failures = [];
    const importPdf = async (name, check) => {
      const res = await fetch(`${base}/api/pdf/import`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf", Cookie: cookie },
        body: fs.readFileSync(path.join(root, "fixtures", "pdf", name)),
        signal: AbortSignal.timeout(IMPORT_MS),
      });
      const raw = await res.text();
      let body = null;
      try { body = JSON.parse(raw); } catch { /* reported below */ }
      const text = (body?.nodes ?? []).map(textOf).join("\n");
      const problems = res.status !== 200 ? [`HTTP ${res.status}: ${raw.slice(0, 300)}`] : !body ? [`not JSON: ${raw.slice(0, 300)}`] : check(body, text);
      console.log(`${problems.length ? "FAIL" : "ok  "} ${name}${problems.length ? "" : `: ${body.pages} page(s), ${body.nodes.length} nodes, ${body.stats.images} image(s)`}`);
      for (const p of problems) {
        console.log(`       ${p}`);
        failures.push(`${name}: ${p}`);
      }
    };
    const expect = (cond, what) => (cond ? [] : [what]);
    const images = (tagged) => (body, text) => [
      ...expect(body.tagged === tagged, `tagged is ${body.tagged}, not ${tagged}`),
      ...expect(text.includes("The logo") && text.includes("After the images."), `text is missing: ${JSON.stringify(text.slice(0, 200))}`),
      // The images are encoded with @napi-rs/canvas, a native module
      ...expect(body.stats.images === 2, `${body.stats.images} images, not 2 (warnings: ${JSON.stringify(body.warnings)})`),
    ];
    await importPdf("images-tagged.pdf", images(true));
    await importPdf("images-untagged.pdf", images(false));
    await importPdf("cjk-cmap.pdf", (body, text) => [
      ...expect(text.includes("Japanese below."), `the Latin line is missing: ${JSON.stringify(text)}`),
      // Read with pdf.js's character maps: without them the line is dropped, with no warning
      ...expect(text.includes("日本語"), `the Japanese line is missing (pdf.js's character maps weren't used): ${JSON.stringify(text)}`),
    ]);
    if (failures.length) {
      console.error(`\n${failures.length} check(s) failed. The server said:\n${output.trim().split("\n").slice(-40).join("\n")}`);
      return false;
    }
    console.log("The standalone server imports PDFs with only the files the build shipped.");
    return true;
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}${output ? `\nThe server said:\n${output.trim().split("\n").slice(-40).join("\n")}` : ""}`);
    return false;
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const gone = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
      await gone;
      clearTimeout(timer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

process.exit((await main()) ? 0 : 1);
