import { test, expect, CLOSING_TEXT, FIXTURE_DOC_ID, FIXTURE_DOC_NAME } from "./fixtures";

test.describe("workspace", () => {
  test("the Google account picture is a plain image (no image optimizer)", async ({ app, page, api }) => {
    api.user.picture = "https://lh3.googleusercontent.com/a/example-avatar=s96-c";
    await app.open();
    const avatar = page.locator("header button[aria-label='Account'] img");
    await expect(avatar).toHaveAttribute("src", api.user.picture);
    await expect(avatar).toHaveAttribute("referrerpolicy", "no-referrer");
    // Nothing on the page goes through /_next/image
    expect(await page.locator("img[src^='/_next/image']").count()).toBe(0);
  });

  test("renaming the document posts the new name and shows it", async ({ app, page, api }) => {
    await app.open();
    await page.getByRole("button", { name: "Rename document" }).click();
    const input = page.locator(".ss-title-input");
    await expect(input).toBeFocused();
    await input.fill("Renamed Field Notes");
    await input.press("Enter");
    await expect(page.locator("header")).toContainText("Renamed Field Notes");
    await expect(page.locator("header")).not.toContainText(FIXTURE_DOC_NAME);
    expect(api.renames).toEqual([{ documentId: FIXTURE_DOC_ID, name: "Renamed Field Notes" }]);
  });

  test("right-click opens the context menu and Select all selects the document", async ({ app, page }) => {
    await app.open();
    // A paragraph at the top of the first page: the menu closes on any scroll, and right-clicking
    // text that is only partly in view would scroll it into view
    const target = app.doc.locator("p", { hasText: "Notes on three works" });
    await target.scrollIntoViewIfNeeded();
    await target.click({ button: "right" });
    const menu = page.locator(".ss-context-menu[role=menu]");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Select all" })).toBeEnabled();
    // Nothing is selected, so Cut and Copy are off
    await expect(menu.getByRole("menuitem", { name: "Cut" })).toBeDisabled();
    await menu.getByRole("menuitem", { name: "Select all" }).click();
    await expect(menu).toBeHidden();
    const selected = await page.evaluate(() => { const s = window.ssEditor!.state.selection; return s.to - s.from; });
    expect(selected).toBeGreaterThan(300);
  });

  test("dialogs keep keystrokes to themselves and give focus back to the editor", async ({ app, page }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.press("Control+/");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Ctrl+Enter");
    await page.keyboard.type("ZZ");
    expect(await app.text()).not.toContain("ZZ");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.ssEditor!.isFocused)).toBe(true);
    await page.keyboard.type("!");
    await expect(app.doc).toContainText(CLOSING_TEXT + "!");
  });

  test("the Edit menu opens Find and replace, the View menu hides the outline", async ({ app, page }) => {
    await app.open();
    await app.menu("Edit", "Find and replace");
    await expect(page.getByRole("dialog", { name: "Find and replace" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ss-outline")).toBeVisible();
    await app.menu("View", "Show outline");
    await expect(page.locator(".ss-outline")).toHaveCount(0);
  });
});

test.describe("starting a sync", () => {
  test("Start sync posts the pending additions with their Docs position and shows the running view", async ({ app, page, api }) => {
    await app.open();
    const start = page.getByRole("button", { name: "Start sync" });
    await expect(start).toBeDisabled();
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.type(" Typed later.");
    await expect(app.subtitle()).toHaveText("New text glows. Start sync types it in.");
    await expect(start).toBeEnabled();
    // The plan preview on the right follows the text
    await expect(page.getByRole("complementary", { name: "Sync settings" })).toContainText(/min|sec/);
    await start.click();
    await expect.poll(() => api.starts.length).toBe(1);
    const body = api.starts[0];
    expect(body.documentId).toBe(FIXTURE_DOC_ID);
    expect(body.documentName).toBe(FIXTURE_DOC_NAME);
    expect(body.revisionId).toBe("fixture-rev-1");
    expect(body.segments).toEqual([{ at: api.fixture.at.closing + CLOSING_TEXT.length, mode: "inline", text: " Typed later.", format: expect.anything() }]);
    expect(body.targetMinutes).toBe(60);
    expect(body.breaks).toBe("auto");
    expect(body.context?.ranges).toHaveLength(1);
    // Nothing was saved as a direct edit: additions belong to the sync
    expect(api.edits).toEqual([]);
    // The running view: the sync's panel, a caret where typing is, the untyped text marked
    await expect(page.getByRole("complementary", { name: "This sync" })).toBeVisible();
    await expect(page.locator("header").getByRole("button", { name: "New sync" })).toBeVisible();
    await expect(page.locator(".ss-caret")).toHaveCount(1);
    await expect(page.locator(".ss-untyped").first()).toBeAttached();
    await expect(page.getByRole("status").filter({ hasText: "Sync started" })).toBeVisible();
  });

  test("a sync that is already running shows up in the rail and pauses on request", async ({ app, page, api }) => {
    const now = Date.now();
    api.jobs = [{
      id: "sync_existing", userId: api.user.id, documentId: FIXTURE_DOC_ID, documentName: FIXTURE_DOC_NAME, status: "running",
      createdAt: now - 60_000, startAt: now - 60_000, startedAt: now - 60_000, currentAction: 4, totalActions: 20, charsSent: 12, totalChars: 40,
      typoSubStep: 0, typoCharsInDoc: 0, generation: 0, failures: 0, activity: "Typing", etaTargetAt: now + 600_000, nextActionAt: now + 3000, wpm: 30,
      baselineWordCount: 0, breaks: [], completedBreaks: [], lastUpdate: now, sourceText: "Already being typed in.", context: null,
    }];
    await app.page.context().addCookies([{ name: "google_access_token", value: "e2e-token", domain: "localhost", path: "/" }]);
    await api.install(page);
    await page.addInitScript((id: string) => { localStorage.setItem("ss_debug", "1"); localStorage.setItem("syncstream_draft_v2", JSON.stringify({ selectedDocId: id })); }, FIXTURE_DOC_ID);
    await page.goto("/dashboard");
    const panel = page.getByRole("complementary", { name: "This sync" });
    await expect(panel).toBeVisible();
    await expect(page.locator("header")).toContainText(FIXTURE_DOC_NAME);
    await panel.getByRole("button", { name: /Pause/ }).click();
    await expect.poll(() => api.jobs[0].status).toBe("paused");
    await expect(panel.getByRole("button", { name: /Resume/ })).toBeVisible();
  });
});
