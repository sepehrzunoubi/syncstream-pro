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
    await app.menu("File", "Rename");
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
    // The menu is the page's: it opens once the document is open and the page takes edits
    await expect.poll(() => page.evaluate(() => window.ssEditor!.isEditable)).toBe(true);
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

  test("Ctrl + and Ctrl − zoom the document one Docs level at a time, Ctrl 0 fits it again; the rest of the window stays", async ({ app, page }) => {
    await app.open();
    const caption = page.locator(".ss-zoom-btn .ss-caption");
    const sheetWidth = () => page.locator(".ss-sheet").first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
    const toolbarHeight = () => page.locator(".ss-toolbar").evaluate((e) => e.getBoundingClientRect().height);
    // At 1440 the page fits between the side panels at 88%
    await expect(caption).toHaveText("88%");
    const before = await toolbarHeight();
    // The key reaches the page, not the browser's zoom
    const prevented = page.evaluate(() => new Promise<boolean>((done) => { const on = (e: KeyboardEvent) => { if (e.key === "Control") return; window.removeEventListener("keydown", on); setTimeout(() => done(e.defaultPrevented)); }; window.addEventListener("keydown", on); }));
    await page.keyboard.press("Control+Equal");
    expect(await prevented).toBe(true);
    await expect(caption).toHaveText("90%");
    await expect.poll(sheetWidth).toBe(Math.round(816 * 0.9));
    await page.keyboard.press("Control+Equal");
    await expect(caption).toHaveText("100%");
    await expect.poll(sheetWidth).toBe(816);
    await page.keyboard.press("Control+Minus");
    await page.keyboard.press("Control+Minus");
    await expect(caption).toHaveText("75%");
    await expect.poll(sheetWidth).toBe(612);
    // Past the smallest level it stays there
    await page.keyboard.press("Control+Minus");
    await page.keyboard.press("Control+Minus");
    await expect(caption).toHaveText("50%");
    await page.keyboard.press("Control+0");
    await expect(caption).toHaveText("88%");
    expect(await toolbarHeight()).toBe(before);
  });

  test("the Edit menu opens Find and replace, the View menu hides tabs & outlines", async ({ app, page }) => {
    await app.open();
    await app.menu("Edit", "Find and replace");
    await expect(page.getByRole("dialog", { name: "Find and replace" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ss-outline")).toBeVisible();
    await app.menu("View", "Show tabs & outlines");
    await expect(page.locator(".ss-outline")).toHaveCount(0);
  });
});

test.describe("starting a sync", () => {
  test("a sync doesn't start while a pasted image is uploading (it would be left out), and takes it once it is up", async ({ app, page, api }) => {
    await app.open();
    api.imageDelay = 2500;
    await app.caretAtEnd(CLOSING_TEXT);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await app.paste({ html: `<meta charset="utf-8"><span>Logo </span><img src="${png}" width="24" height="24">`, text: "Logo " });
    const start = page.getByRole("button", { name: "Start sync" });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.getByRole("alert").filter({ hasText: "A pasted image is still uploading" })).toBeVisible();
    expect(api.starts).toHaveLength(0);
    await expect.poll(() => api.uploads.length, { timeout: 8000 }).toBe(1);
    await expect.poll(() => page.evaluate(() => JSON.stringify(window.ssEditor!.getJSON()).includes("https://images.e2e.test/img/1.png"))).toBe(true);
    await start.click();
    await expect.poll(() => api.starts.length).toBe(1);
    expect(JSON.stringify(api.starts[0].segments)).toContain("https://images.e2e.test/img/1.png");
  });

  test("pasted images upload a few at a time, the same one once, and wait when the route has had too many: none is lost", async ({ app, page, api }) => {
    await app.open();
    // Five different images, and the first again
    const pngs = await page.evaluate(() => ["#c00", "#0c0", "#00c", "#cc0", "#0cc"].map((color) => {
      const c = document.createElement("canvas");
      c.width = 2;
      c.height = 2;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 2, 2);
      return c.toDataURL("image/png");
    }));
    api.imageDelay = 300;
    api.imagesTooMany = 2;
    await app.caretAtEnd(CLOSING_TEXT);
    await app.paste({ html: `<meta charset="utf-8"><span>Logos </span>${[...pngs, pngs[0]].map((p) => `<img src="${p}" width="2" height="2">`).join("")}`, text: "Logos " });
    const images = () => page.evaluate(() => {
      const out: string[] = [];
      window.ssEditor!.state.doc.descendants((n) => { if (n.type.name === "image" && n.attrs.src.startsWith("https://images.e2e.test/")) out.push(String(n.attrs.src)); });
      return out;
    });
    await expect.poll(async () => (await images()).length, { timeout: 15_000 }).toBe(6);
    expect(api.imageRefusals).toBe(2);
    expect(api.uploads).toHaveLength(5);
    expect(api.imagesAtOnce).toBeLessThanOrEqual(3);
    const srcs = await images();
    expect(srcs.filter((s) => s === srcs[0])).toHaveLength(2);
    await expect(page.getByText(/Couldn't add a pasted image/)).toHaveCount(0);
  });

  test("nothing can be typed or pasted while a sync starts: the sync takes what the page shows", async ({ app, page, api }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.type(" Typed first.");
    api.startDelay = 2000;
    await page.getByRole("button", { name: "Start sync" }).click();
    // (while the start is still on its way)
    expect(await page.evaluate(() => window.ssEditor!.isEditable)).toBe(false);
    await page.evaluate(() => window.ssEditor!.view.dom.focus());
    await page.keyboard.type(" Typed while starting.");
    expect(await page.evaluate(() => window.ssEditor!.getText())).not.toContain("Typed while starting");
    expect(api.starts).toHaveLength(0);
    await expect.poll(() => api.starts.length).toBe(1);
    expect(api.starts[0].segments?.map((s) => s.text)).toEqual([" Typed first."]);
  });

  test("a pasted image the document can't have is taken out with why: one too long an address for Docs, another site's blob:", async ({ app, page }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    const images = () => page.evaluate(() => {
      let n = 0;
      window.ssEditor!.state.doc.descendants((node) => { if (node.type.name === "image" && !String(node.attrs.src).startsWith("https://images.e2e.test/")) n++; });
      return n;
    });
    const before = await images();
    await app.paste({ html: `<meta charset="utf-8"><span>Signed </span><img src="https://cdn.example.test/photo.png?sig=${"a".repeat(2100)}" width="24" height="24">`, text: "Signed " });
    await expect(page.getByText("Couldn't add a pasted image: its web address is too long for Google Docs. It was left out.")).toBeVisible();
    await expect.poll(images).toBe(before);
    await app.paste({ html: '<meta charset="utf-8"><span>Chat </span><img src="blob:https://chat.example.test/4f1c2d1e-0d6b-4d55-9a57-3e6b2f6b9a10" width="24" height="24">', text: "Chat " });
    await expect(page.getByText(/Couldn't add a pasted image: another site shows it/)).toBeVisible();
    await expect.poll(images).toBe(before);
  });

  test("an image whose upload finishes while its document isn't shown has its address after a reload", async ({ app, page, api }) => {
    api.contentMode = "always";
    api.docs.push({ id: "doc-other-5678", name: "Other notes", modifiedTime: new Date(Date.now() - 60_000).toISOString() });
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    api.imageDelay = 1500;
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await app.paste({ html: `<meta charset="utf-8"><span>Logo </span><img src="${png}" width="24" height="24">`, text: "Logo " });
    await expect.poll(() => page.evaluate(() => JSON.stringify(window.ssEditor!.getJSON()).includes("blob:"))).toBe(true);
    // To another document, where the upload finishes
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Target Google Doc" }).click();
    await page.getByRole("menuitem", { name: /Other notes/ }).click();
    await expect.poll(() => page.evaluate(() => JSON.stringify(window.ssEditor!.getJSON()).includes("blob:"))).toBe(false);
    await expect.poll(() => api.uploads.length, { timeout: 8000 }).toBe(1);
    await page.waitForTimeout(300);
    // Back on the first document after a reload
    await page.reload();
    await page.waitForFunction(() => !!window.ssEditor);
    await page.getByRole("button", { name: "Target Google Doc" }).click();
    await page.getByRole("menuitem", { name: new RegExp(FIXTURE_DOC_NAME) }).click();
    await expect.poll(() => page.evaluate(() => JSON.stringify(window.ssEditor!.getJSON()).includes("https://images.e2e.test/img/1.png")), { timeout: 8000 }).toBe(true);
    await expect(page.getByText(/Couldn't add a pasted image/)).toHaveCount(0);
  });

  test("a pasted image whose upload failed doesn't come back with redo, and one gone with a reload is taken out: the page never shows an image the sync would leave out", async ({ app, page, api }) => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const images = () => page.evaluate(() => {
      const out: string[] = [];
      window.ssEditor!.state.doc.descendants((n) => { if (n.type.name === "image") out.push(String(n.attrs.src)); });
      return out;
    });
    api.contentMode = "always";
    await app.open();
    const before = (await images()).length;
    // Undone before its upload fails, redone after
    api.imagesFail = true;
    api.imageDelay = 1200;
    await app.caretAtEnd(CLOSING_TEXT);
    await app.paste({ html: `<meta charset="utf-8"><span>Logo </span><img src="${png}" width="24" height="24">`, text: "Logo " });
    await expect.poll(images).toHaveLength(before + 1);
    await page.keyboard.press("Control+z");
    await expect.poll(images).toHaveLength(before);
    await expect.poll(() => api.imageFailures, { timeout: 8000 }).toBe(1);
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => page.evaluate(() => window.ssEditor!.getText().includes("Logo"))).toBe(true);
    await expect.poll(images).toHaveLength(before);
    await expect(page.getByText(/Couldn't add a pasted image: Image storage is unavailable/)).toBeVisible();
    // Reloaded while one uploads: the draft has its blob: address, which is gone with the page
    api.imagesFail = false;
    api.imageDelay = 20_000;
    await app.paste({ html: `<meta charset="utf-8"><img src="${png}" width="24" height="24">`, text: "" });
    await expect.poll(async () => (await images()).filter((s) => s.startsWith("blob:"))).toHaveLength(1);
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForFunction(() => !!window.ssEditor);
    await expect(page.getByText(/Couldn't add a pasted image: it was gone before it was uploaded/)).toBeVisible();
    expect((await images()).filter((s) => s.startsWith("blob:"))).toEqual([]);
    // And the sync goes ahead without it, saying nothing is missing
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => api.starts.length).toBe(1);
    expect(JSON.stringify(api.starts[0].segments)).not.toContain("blob:");
  });

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
    await expect(page.locator("header").getByRole("button", { name: "Back to editing" })).toBeVisible();
    await expect(page.locator(".ss-caret")).toHaveCount(1);
    await expect(page.locator(".ss-untyped").first()).toBeAttached();
    await expect(page.getByRole("status").filter({ hasText: "Sync started" })).toBeVisible();
  });

  test("the live page greys out exactly what is still to type, after a footnote too", async ({ app, page, api }) => {
    await app.open();
    // The closing paragraph comes after the footnote's: its positions used to be off by one
    await app.caretAtEnd(CLOSING_TEXT);
    const added = " Typed later.";
    await page.keyboard.type(added);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => api.starts.length).toBe(1);
    const untyped = () => page.locator(".ss-untyped").evaluateAll((els) => els.map((e) => e.textContent).join(""));
    await expect.poll(untyped).toBe(added);
    // The sync has typed 6 characters: the rest is grey, and the caret sits before it
    api.jobs = api.jobs.map((j) => ({ ...j, charsSent: 6 }));
    await expect.poll(untyped, { timeout: 10_000 }).toBe(added.slice(6));
    const caretNext = await page.locator(".ss-caret").evaluate((c) => c.nextSibling?.textContent ?? c.parentElement?.nextSibling?.textContent ?? "");
    expect(caretNext.startsWith(added.slice(6, 8))).toBe(true);
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
  test("the header's buttons never cover the menus: captions give way first, then the menu row scrolls", async ({ app, page }) => {
    await app.open();
    const edges = () => page.evaluate(() => {
      const right = (sel: string) => Math.max(...Array.from(document.querySelectorAll(sel)).map((e) => e.getBoundingClientRect().right));
      const row = document.querySelector(".ss-menubar-row")!;
      return { menus: right(".ss-menubar-trigger"), row: row.getBoundingClientRect().right, scrolls: row.scrollWidth > row.clientWidth, actions: document.querySelector(".ss-header-actions")!.getBoundingClientRect().left, page: document.documentElement.scrollWidth };
    });
    // A laptop's width and a narrow window: every menu is in the clear
    for (const width of [1280, 1100, 900]) {
      await page.setViewportSize({ width, height: 800 });
      const e = await edges();
      expect(e.menus, `menus at ${width}px`).toBeLessThanOrEqual(e.actions);
      expect(e.page).toBe(width);
    }
    await expect(page.getByRole("button", { name: "Start sync" })).toContainText("Start sync");
    // A tablet upright and a phone: the row ends where the buttons start, and scrolls to its last menu
    for (const width of [700, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const e = await edges();
      expect(e.row, `menu row at ${width}px`).toBeLessThanOrEqual(e.actions);
      expect(e.scrolls).toBe(true);
      expect(e.page).toBe(width);
    }
    // On a phone the two buttons are their icons, each a 40px circle, named for screen readers
    for (const name of ["New Google Doc", "Start sync"]) {
      const box = (await page.locator("header").getByRole("button", { name }).boundingBox())!;
      expect(Math.round(box.width)).toBe(40);
    }
    await page.locator(".ss-menubar-row").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await page.locator(".ss-menubar-trigger", { hasText: "History" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
  });
});
