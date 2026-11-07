import { expect, test, tabContent, type FakeGoogle } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { CompareLoadResponse, CompareStartBody, CompareTab, TabMap } from "../src/lib/compare-types";

// Compare & Sync: pick your document and a reference, see what the sync adds, leave parts out,
// place breaks, start; the editor then shows the sync. Google is the fixtures' fake; the compare
// routes are faked here, and the engine is the real one, running in the page.

const LEFT = "1CompareLeftDocument00000000000000000000000";
const RIGHT = "1CompareRightDocument0000000000000000000000";
const NEW_LINE = "Beta two is the part the reference added.";

const tab = (id: string, title: string, texts: string[], index: number): CompareTab => ({ id, title, level: 0, parentId: null, index, doc: tabContent(texts) });

/** Your document lacks a paragraph of the reference's first tab, and its whole second tab (with `highlight`, the reference's first line is highlighted) */
function comparison(rev = 1, given: TabMap = {}, highlight = false): CompareLoadResponse {
  const ref = tab("t.ref", "Overview", ["Alpha one stays as it is.", NEW_LINE, "Gamma three closes it."], 0);
  if (highlight) {
    const first = ref.doc.nodes[0].content![0];
    first.marks = [...(first.marks ?? []), { type: "highlight", attrs: { color: "#f4cccc" } }];
  }
  return {
    left: { documentId: LEFT, name: "Team notes", revisionId: `left-${rev}`, tabs: [tab("t.left", "Overview", ["Alpha one stays as it is.", "Gamma three closes it."], 0)] },
    right: {
      documentId: RIGHT, name: "Team notes (final)", revisionId: `right-${rev}`,
      tabs: [ref, tab("t.app", "Appendix", ["Only the reference has this appendix."], 1)],
    },
    tabMap: { "t.ref": { kind: "tab", leftTabId: "t.left" }, "t.app": { kind: "new", title: "Appendix", parentRightTabId: null }, ...given },
    canEdit: true,
  };
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface CompareFake {
  loads: URLSearchParams[];
  starts: CompareStartBody[];
  /** How the next start answers */
  startAnswer: "ok" | "changed" | "busy";
  /** Images of the reference a start says it couldn't copy */
  droppedImages: number;
  /** The reference's first line is highlighted */
  highlight?: boolean;
}

/** Signed in, with the fixtures' Google, the two documents in Drive and the compare routes faked */
async function openCompare(page: Page, api: FakeGoogle, session?: Record<string, unknown>, opts: { highlight?: boolean } = {}): Promise<CompareFake> {
  const fake: CompareFake = { loads: [], starts: [], startAnswer: "ok", droppedImages: 0, highlight: opts.highlight };
  api.docs = [
    { id: LEFT, name: "Team notes", modifiedTime: new Date().toISOString() },
    { id: RIGHT, name: "Team notes (final)", modifiedTime: new Date(Date.now() - 86_400_000).toISOString() },
  ];
  await page.context().addCookies([{ name: "google_access_token", value: "e2e-token", domain: "localhost", path: "/" }]);
  await api.install(page);
  // Registered after the fixtures' routes, so these answer first
  await page.route(/\/api\/compare\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/compare/load") {
      fake.loads.push(url.searchParams);
      // As the route does: the tab choices given win, the rest are matched automatically
      const map = url.searchParams.get("map");
      return json(route, comparison(fake.loads.length, map ? (JSON.parse(map) as TabMap) : {}, fake.highlight));
    }
    if (url.pathname === "/api/compare/start") {
      const body = route.request().postDataJSON() as CompareStartBody;
      fake.starts.push(body);
      if (fake.startAnswer === "changed") { fake.startAnswer = "ok"; return json(route, { error: "One of the documents changed. Compare again.", code: "changed" }, 409); }
      const now = Date.now();
      const job = {
        id: `sync_cmp_${fake.starts.length}`, userId: api.user.id, documentId: body.leftId, documentName: body.documentName ?? "Team notes",
        status: "running", createdAt: now, startAt: now, startedAt: now, currentAction: 0, totalActions: 20, charsSent: 0, totalChars: NEW_LINE.length,
        typoSubStep: 0, typoCharsInDoc: 0, generation: 0, failures: 0, activity: "Typing", etaTargetAt: now + 600_000, nextActionAt: now + 3000,
        wpm: 32, baselineWordCount: 0, breaks: [], completedBreaks: [], lastUpdate: now, sourceText: NEW_LINE, context: null,
      };
      api.jobs = [job, ...api.jobs];
      // As the route does when a sync is already typing into your document: which one it is
      if (fake.startAnswer === "busy") { fake.startAnswer = "ok"; return json(route, { error: "A sync is already typing into your document. Wait for it to finish, or cancel it, first.", code: "busy", jobId: job.id }, 409); }
      return json(route, { job, ...(fake.droppedImages ? { droppedImages: fake.droppedImages } : {}) });
    }
    return json(route, { error: "e2e: no compare fake" }, 404);
  });
  await page.addInitScript((s) => {
    if (sessionStorage.getItem("ss-e2e-seeded")) return;
    sessionStorage.setItem("ss-e2e-seeded", "1");
    localStorage.setItem("ss_debug", "1");
    if (s) localStorage.setItem("syncstream_compare_v1", JSON.stringify(s));
  }, session ?? null);
  await page.goto("/dashboard/compare");
  return fake;
}

const PICKED = { left: { id: LEFT, name: "Team notes" }, right: { id: RIGHT, name: "Team notes (final)" } };
const yours = (page: Page) => page.locator('.ss-cmp-pane[aria-label^="Your document"]');
const reference = (page: Page) => page.locator('.ss-cmp-pane[aria-label="Reference"]');
const changeRow = (page: Page, text: string) => page.locator(".ss-cmp-change", { hasText: text });

/** A reference tab in the tabs panel, opened first (at this width the tabs don't show by themselves) */
async function refTab(page: Page, title: string) {
  if (!(await page.locator(".ss-cmp-tab").count())) await page.getByRole("button", { name: "Show tabs" }).click();
  return page.locator(".ss-cmp-tab", { hasText: title });
}

/** The comparison is on both pages and in the panel */
async function compared(page: Page) {
  await expect(yours(page).locator(".ss-add", { hasText: "Beta two" })).toBeVisible();
  await expect(changeRow(page, "Beta two")).toBeVisible();
}

/** Click the middle of `word` inside the glowing text of your document */
async function clickGlowingWord(page: Page, word: string) {
  const box = await page.evaluate((w) => {
    const root = document.querySelector('.ss-cmp-pane[aria-label^="Your document"] .ProseMirror')!;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!(n.parentElement?.closest(".ss-add"))) continue;
      const k = (n.textContent ?? "").indexOf(w);
      if (k < 0) continue;
      const r = document.createRange();
      r.setStart(n, k);
      r.setEnd(n, k + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, word);
  if (!box) throw new Error(`"${word}" doesn't glow in your document`);
  await page.mouse.click(box.x, box.y);
}

test.describe("Compare & Sync", () => {
  test("picking both documents shows your document after the sync beside the reference", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api);
    await expect(page.getByRole("heading", { name: "Bring a document up to date" })).toBeVisible();

    await page.getByRole("button", { name: /^Your document: choose a document/ }).click();
    // The reference can't be your document too; picking one side marks it on the other
    await page.getByRole("option", { name: /^Team notes\b/ }).first().click();
    await page.getByRole("button", { name: /^Reference: choose a document/ }).click();
    await expect(page.getByRole("option", { name: /^Team notes\b(?! \()/ })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: /Team notes \(final\)/ }).click();

    await compared(page);
    expect(fake.loads).toHaveLength(1);
    expect(fake.loads[0].get("left")).toBe(LEFT);
    expect(fake.loads[0].get("right")).toBe(RIGHT);
    // What will be copied is highlighted on the reference, and only that
    await expect(reference(page).locator(".ss-cmp-copy", { hasText: "Beta two" }).first()).toBeVisible();
    await expect(reference(page).locator(".ss-cmp-copy", { hasText: "Alpha one" })).toHaveCount(0);
    // Your own text stays as it is, without a glow
    await expect(yours(page).locator(".ProseMirror")).toContainText("Alpha one stays as it is.");
    await expect(yours(page).locator(".ss-add", { hasText: "Alpha one" })).toHaveCount(0);
    // The new tab is listed with the reference's tabs
    await expect(await refTab(page, "Appendix")).toContainText("New tab");
    // The session is kept: a reload compares the same two documents again
    await page.reload();
    await compared(page);
  });

  test("a pasted link picks the reference", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, { left: PICKED.left });
    await page.getByRole("button", { name: /^Reference: choose a document/ }).click();
    await page.getByRole("combobox", { name: "Search your Drive or paste a link" }).fill(`https://docs.google.com/document/d/${RIGHT}/edit`);
    await page.keyboard.press("Enter");
    await compared(page);
    expect(fake.loads[0].get("right")).toBe(RIGHT);
    await expect(page.getByRole("button", { name: /^Reference: Team notes \(final\)/ })).toBeVisible();
  });

  test("a change left out is neither shown nor sent", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, PICKED);
    await compared(page);
    const row = changeRow(page, "Beta two");
    await row.locator(".ss-cmp-toggle").click();
    await expect(row.getByRole("checkbox")).not.toBeChecked();
    await expect(yours(page).locator(".ss-add", { hasText: "Beta two" })).toHaveCount(0);
    await expect(reference(page).locator(".ss-cmp-skip", { hasText: "Beta two" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => fake.starts.length).toBe(1);
    expect(fake.starts[0].skip).toHaveLength(1);
  });

  test("a highlight the reference has on a line you have comes over with the text added after it: one change, shown on both pages", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, PICKED, { highlight: true });
    await compared(page);
    const row = changeRow(page, "Beta two");
    await expect(row).toContainText("restyles 1 line");
    // Your line takes the highlight, marked as restyled; it isn't typed (no glow)
    const line = yours(page).locator(".ss-cmp-restyle", { hasText: "Alpha one" });
    await expect(line).toBeVisible();
    await expect(yours(page).locator("mark", { hasText: "Alpha one" })).toBeVisible();
    await expect(yours(page).locator(".ss-add", { hasText: "Alpha one" })).toHaveCount(0);
    await expect(yours(page).locator(".ss-cmp-pane-head")).toContainText("restyled text underlined");
    // Left out, the change takes its restyle with it
    await row.locator(".ss-cmp-toggle").click();
    await expect(yours(page).locator(".ss-cmp-restyle")).toHaveCount(0);
    await expect(yours(page).locator("mark", { hasText: "Alpha one" })).toHaveCount(0);
    await expect(reference(page).locator(".ss-cmp-skip", { hasText: "Alpha one" }).first()).toBeVisible();
    await row.locator(".ss-cmp-toggle").click();
    await expect(line).toBeVisible();
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => fake.starts.length).toBe(1);
    expect(fake.starts[0].skip).toEqual([]);
  });

  test("Start sends the comparison as it was reviewed", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, PICKED);
    await compared(page);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => fake.starts.length).toBe(1);
    const body = fake.starts[0];
    expect(body).toMatchObject({
      leftId: LEFT, rightId: RIGHT, leftRevision: "left-1", rightRevision: "right-1",
      skip: [], breaksMode: "auto", breaks: [], targetMinutes: null, typoFrequency: 0.5, startInMinutes: 0, documentName: "Team notes",
    });
    // Only the tab choices made by hand (none here): the route matches the rest again, the same way
    expect(body.tabMap).toEqual({});
    expect(Number.isInteger(body.seed)).toBe(true);
  });

  test("a tab's target is read again and sent as chosen, and only that choice", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, PICKED);
    await compared(page);
    await (await refTab(page, "Appendix")).click();
    // The select under the tab (the last tab's folds away)
    await page.locator("li", { has: page.locator(".ss-cmp-tab", { hasText: "Appendix" }) }).getByLabel("Copy into", { exact: true }).selectOption("skip");
    await expect(await refTab(page, "Appendix")).toContainText("Not copied");
    expect(fake.loads).toHaveLength(2);
    expect(JSON.parse(fake.loads[1].get("map") ?? "{}")).toEqual({ "t.app": { kind: "skip" } });
    await expect(changeRow(page, "Only the reference has")).toHaveCount(0);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => fake.starts.length).toBe(1);
    expect(fake.starts[0].tabMap).toEqual({ "t.app": { kind: "skip" } });
  });

  test("a Manual break is placed on a glowing word and sent by its place in the reference", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, PICKED);
    await compared(page);
    await page.getByRole("group", { name: "Breaks" }).getByRole("button", { name: "Manual" }).click();
    await page.locator("#ss-break-length").fill("15m");
    await expect(page.locator(".ss-placing-bar")).toBeVisible();
    await clickGlowingWord(page, "two");
    await expect(yours(page).locator(".ss-brk-pill", { hasText: "15m" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Breaks in this tab" })).toContainText("after “two”");
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => fake.starts.length).toBe(1);
    const body = fake.starts[0];
    expect(body.breaksMode).toBe("manual");
    expect(body.targetMinutes).toBeNull();
    expect(body.breaks).toHaveLength(1);
    expect(body.breaks[0]).toMatchObject({ rightTabId: "t.ref", minutes: 15 });
    expect(Number.isInteger(body.breaks[0].rightToken) && body.breaks[0].rightToken >= 0).toBe(true);
  });

  test("a document that changed since the comparison is compared again, keeping what was left out", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, PICKED);
    await compared(page);
    await (await refTab(page, "Appendix")).click();
    await changeRow(page, "Only the reference has").locator(".ss-cmp-toggle").click();
    fake.startAnswer = "changed";
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect(page.locator(".ss-cmp-banner", { hasText: "One of the documents changed. Here's the new comparison." })).toBeVisible();
    expect(fake.loads).toHaveLength(2);
    await expect(changeRow(page, "Only the reference has").getByRole("checkbox")).not.toBeChecked();
    // Starting again sends the new revisions
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => fake.starts.length).toBe(2);
    expect(fake.starts[1]).toMatchObject({ leftRevision: "left-2", rightRevision: "right-2" });
    expect(fake.starts[1].skip).toHaveLength(1);
  });

  test("after Start the editor shows the sync, live, on your document", async ({ page, api, app }) => {
    void app;
    await openCompare(page, api, PICKED);
    await compared(page);
    await page.getByRole("button", { name: "Start sync" }).click();
    await page.waitForURL(/\/dashboard$/);
    await expect(page.getByRole("button", { name: "Back to editing" })).toBeVisible();
    await expect(page.locator("header")).toContainText("Team notes");
    expect(await page.evaluate(() => localStorage.getItem("syncstream_focus_v1"))).toBeNull();
    // And the switch goes back to Compare & Sync
    await page.getByRole("link", { name: "Compare & Sync" }).first().click();
    await page.waitForURL(/\/dashboard\/compare$/);
  });

  test("a sync already typing into your document is one click away when Start is refused", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, PICKED);
    await compared(page);
    fake.startAnswer = "busy";
    await page.getByRole("button", { name: "Start sync" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "already typing into your document" });
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "Open that sync" }).click();
    await page.waitForURL(/\/dashboard$/);
    await expect(page.getByRole("button", { name: "Back to editing" })).toBeVisible();
  });

  test("images the sync couldn't copy are said when the editor opens on it", async ({ page, api, app }) => {
    void app;
    const fake = await openCompare(page, api, PICKED);
    await compared(page);
    fake.droppedImages = 2;
    await page.getByRole("button", { name: "Start sync" }).click();
    await page.waitForURL(/\/dashboard$/);
    await expect(page.getByText("2 images from the reference couldn't be copied, so the sync leaves them out")).toBeVisible();
  });
});
