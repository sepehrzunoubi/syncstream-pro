import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end tests of the dashboard against a production build (`npm run build` first).
 * Every `/api/*` route is stubbed in the browser (see e2e/fixtures.ts), so no Google account
 * or environment variables are needed.
 */
const port = Number(process.env.E2E_PORT || 4123);
const baseURL = `http://localhost:${port}`;

/**
 * Playwright normally finds Chromium in its own cache (`npx playwright install chromium`, as CI
 * does). On a machine where the browsers live elsewhere, as in /opt/pw-browsers here, and the
 * cache is empty, the newest Chromium there is used instead. PLAYWRIGHT_BROWSERS_PATH wins.
 */
function chromiumExecutable(): string | undefined {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(cache) && fs.readdirSync(cache).some((d) => d.startsWith("chromium"))) return undefined;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"]) {
    if (!root || !fs.existsSync(root)) continue;
    // The pinned Playwright's own build, when it is there, is used as is
    const pinned = fs.readdirSync(root).some((d) => /^chromium_headless_shell-1243$/.test(d));
    if (pinned) return undefined;
    const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
    for (const sub of ["chrome-linux", "chrome-linux64"]) {
      const exe = dir ? path.join(root, dir, sub, "chrome") : null;
      if (exe && fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const executablePath = chromiumExecutable();

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Flaky tests are fixed, not retried
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: "test-results",
  use: {
    baseURL,
    // Screenshots and traces only as artifacts of failures
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    // The build is done beforehand (CI builds in its own job); a server already on the port is reused
    command: `npx next start -p ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
