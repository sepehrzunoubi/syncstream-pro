import { expect, test, CLOSING_TEXT, DOC, FIXTURE_DOC_ID, FIXTURE_DOC_NAME, tabContent, type App } from "./fixtures";
import type { Page } from "@playwright/test";

// Placing breaks is something the user asks for, on the page in front of them; everything that
// belongs to one document (a failed start, a break's popover, Undo) stays with it; a page that
// isn't ready can't be changed; and New Google Doc gives an empty page, ready to type in

const ADDED = " Typed later, with a few hushed zebras.";
const OTHER = "doc-other-0123456789";

/** Where the middle of the first occurrence of `word` is drawn */
async function wordBox(app: App, page: Page, word: string) {
  const { from, to } = await app.locate(word);
  await page.evaluate((a) => {
    const { node } = window.ssEditor!.view.domAtPos(a + 1);
    (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: "center", behavior: "instant" });
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, from);
  return page.evaluate(([a, b]) => {
    const v = window.ssEditor!.view;
    const s = v.coordsAtPos(a + 1);
    const e = v.coordsAtPos(b - 1);
    return { x: (s.left + e.right) / 2, y: (s.top + s.bottom) / 2 };
  }, [from, to]);
}
async function clickWord(app: App, page: Page, word: string) {
  const box = await wordBox(app, page, word);
  await page.mouse.click(box.x, box.y);
}
/** The caret is inside the first occurrence of `word` */
async function expectCaretIn(app: App, page: Page, word: string) {
  const { from, to } = await app.locate(word);
  await expect.poll(() => page.evaluate(() => { const s = window.ssEditor!.state.selection; return [s.from, s.to]; })).toEqual([expect.any(Number), expect.any(Number)]);
  await expect.poll(async () => {
    const [a, b] = await page.evaluate(() => { const s = window.ssEditor!.state.selection; return [s.from, s.to]; });
    return a >= from && b <= to;
  }, { message: `the caret is in "${word}"` }).toBe(true);
}

const placingBar = (page: Page) => page.getByRole("status").filter({ hasText: "starts after the word you click" });
const pills = (page: Page) => page.locator(`${DOC} .ss-brk-pill:not([data-ghost])`);
const panel = (page: Page) => page.getByRole("complementary", { name: "Sync settings" });
const manual = (page: Page) => page.getByRole("group", { name: "Breaks" }).getByRole("button", { name: "Manual" });

async function withNewText(app: App, page: Page) {
  await app.caretAtEnd(CLOSING_TEXT);
  await page.keyboard.type(ADDED);
  await expect.poll(() => app.pending()).toEqual([ADDED]);
}

/** Another document in the list, with its own content */
function otherDoc(app: App, texts = ["Other notes, already in the document."]) {
  app.api.docs.push({ id: OTHER, name: "Other notes", modifiedTime: new Date(Date.now() - 60_000).toISOString() });
  app.api.contents[OTHER] = tabContent(texts);
}
async function pick(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name: "Target Google Doc" }).click();
  await page.getByRole("menuitem", { name }).click();
}

test.describe("Placing breaks is asked for", () => {
  test("Manual with a length kept from last time: after a reload nothing is being placed, and a click puts the caret", async ({ app, page, api }) => {
    api.contentMode = "always";
    await app.open({ draft: { breaksMode: "manual", breakLength: "33m" } });
    await withNewText(app, page);
    await expect(manual(page)).toHaveAttribute("aria-pressed", "true");
    await expect(placingBar(page)).toHaveCount(0);
    // Asked for: Place on page
    const place = panel(page).getByRole("button", { name: "Place on page" });
    await expect(place).toHaveAttribute("aria-pressed", "false");
    await place.click();
    await expect(placingBar(page)).toHaveText(/A 33-minute break starts after the word you click/);
    await expect(place).toHaveAttribute("aria-pressed", "true");
    await clickWord(app, page, "later,");
    await expect(pills(page)).toHaveText(["33m"]);
    await page.waitForTimeout(800);
    // Reload with the draft and the new text as the page saved them
    await page.evaluate(() => sessionStorage.setItem("e2e_draft", localStorage.getItem("syncstream_draft_v2") ?? ""));
    await page.addInitScript(() => { const d = sessionStorage.getItem("e2e_draft"); if (d) localStorage.setItem("syncstream_draft_v2", d); });
    await page.reload();
    await expect(pills(page)).toHaveText(["33m"]);
    await expect(panel(page).getByLabel("Break length")).toHaveValue("33m");
    await expect(placingBar(page)).toHaveCount(0);
    // A click on a new word puts the caret there; no break
    await clickWord(app, page, "hushed");
    await expectCaretIn(app, page, "hushed");
    await expect(pills(page)).toHaveCount(1);
  });

  test("while placing, a click on text that can't take a break puts the caret there (it isn't swallowed)", async ({ app, page }) => {
    await app.open();
    await withNewText(app, page);
    await manual(page).click();
    await panel(page).getByLabel("Break length").fill("5m");
    await expect(placingBar(page)).toBeVisible();
    // Text already in the document
    await clickWord(app, page, "Closing");
    await expectCaretIn(app, page, "Closing");
    // The last new word (nothing is typed after it)
    await clickWord(app, page, "zebras.");
    await expectCaretIn(app, page, "zebras.");
    await expect(pills(page)).toHaveCount(0);
    // A word a break can follow still takes one, without moving the caret
    const caret = await page.evaluate(() => window.ssEditor!.state.selection.from);
    await clickWord(app, page, "few");
    await expect(pills(page)).toHaveText(["5m"]);
    expect(await page.evaluate(() => window.ssEditor!.state.selection.from)).toBe(caret);
  });

  test("Esc that closes a menu keeps placing; Esc on the page ends it", async ({ app, page }) => {
    await app.open();
    await withNewText(app, page);
    await manual(page).click();
    await panel(page).getByLabel("Break length").fill("5m");
    await expect(placingBar(page)).toBeVisible();
    await page.locator(".ss-zoom-btn").click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".ss-zoom-btn")).toBeFocused();
    await expect(placingBar(page)).toBeVisible();
    // The find bar's Esc is its own too (a click on text already there puts the caret, while placing)
    await clickWord(app, page, "Closing");
    await expectCaretIn(app, page, "Closing");
    await page.keyboard.press("Control+f");
    await expect(page.getByRole("search").getByRole("textbox").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("search")).toHaveCount(0);
    await expect(placingBar(page)).toBeVisible();
    // On the page
    await app.caretAfter("Closing");
    await page.keyboard.press("Escape");
    await expect(placingBar(page)).toHaveCount(0);
    // Editing the length asks again
    await panel(page).getByLabel("Break length").fill("6m");
    await expect(placingBar(page)).toHaveText(/A 6-minute break/);
  });

  test("the breaks on the page show in Manual only, and come back with it; choosing a mode ends placing", async ({ app, page, api }) => {
    await app.open();
    await withNewText(app, page);
    await manual(page).click();
    await panel(page).getByLabel("Break length").fill("8m");
    await expect(placingBar(page)).toHaveText(/An 8-minute break/);
    await clickWord(app, page, "later,");
    await expect(pills(page)).toHaveText(["8m"]);
    await expect(page.locator(`${DOC} .ss-brk`)).toHaveCount(1);
    await page.getByRole("group", { name: "Breaks" }).getByRole("button", { name: "Automatic" }).click();
    await expect(pills(page)).toHaveCount(0);
    await expect(page.locator(`${DOC} .ss-brk`)).toHaveCount(0);
    await expect(placingBar(page)).toHaveCount(0);
    await manual(page).click();
    await expect(pills(page)).toHaveText(["8m"]);
    await expect(placingBar(page)).toHaveCount(0);
    // Automatic doesn't send them
    await page.getByRole("group", { name: "Breaks" }).getByRole("button", { name: "Automatic" }).click();
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => api.starts.length).toBe(1);
    expect(api.starts[0].breaks).toBe("auto");
  });

  test("the length field says what Place on page needs: new text on the page", async ({ app, page }) => {
    await app.open();
    await manual(page).click();
    await panel(page).getByLabel("Break length").fill("33m");
    const place = panel(page).getByRole("button", { name: "Place on page" });
    await expect(place).toBeDisabled();
    await expect(panel(page)).toContainText("Type or paste your new text on the page first.");
    await expect(placingBar(page)).toHaveCount(0);
    await withNewText(app, page);
    await expect(place).toBeEnabled();
    await expect(panel(page)).toContainText("Press Place on page, then click a word.");
    await place.click();
    await expect(placingBar(page)).toBeVisible();
    await expect(panel(page)).toContainText("Click a word on the page: the break starts after it.");
  });
});

test.describe("New Google Doc", () => {
  test("opens an empty page that takes the caret, with nothing being placed, even with Manual and a length set", async ({ app, page, api }) => {
    await app.open({ draft: { breaksMode: "manual", breakLength: "33m" } });
    await page.getByRole("navigation", { name: "Syncs" }).getByRole("button", { name: "New Google Doc" }).click();
    await expect.poll(() => api.creates.length).toBe(1);
    await expect(page.locator("header .ss-title")).toContainText("Untitled document");
    await expect.poll(() => app.text()).toBe("");
    await expect.poll(() => page.evaluate(() => window.ssEditor!.isFocused && window.ssEditor!.isEditable)).toBe(true);
    await expect(placingBar(page)).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Opening the document" })).toHaveCount(0);
    // Typing goes straight in, and is new text
    await page.keyboard.type("Fresh words for a new page.");
    await expect.poll(() => app.pending()).toEqual(["Fresh words for a new page."]);
    await expect(placingBar(page)).toHaveCount(0);
    await clickWord(app, page, "words");
    await expectCaretIn(app, page, "words");
    // The fixture's new text didn't come along
    expect(await app.text()).not.toContain(FIXTURE_DOC_NAME);
  });

  test("a table inserted on the first line of a new doc keeps the line Docs has before it, so the save never deletes it", async ({ app, page, api }) => {
    await app.open();
    await page.getByRole("navigation", { name: "Syncs" }).getByRole("button", { name: "New Google Doc" }).click();
    await expect.poll(() => api.creates.length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.ssEditor!.isFocused && window.ssEditor!.isEditable)).toBe(true);
    const before = api.edits.length;
    await page.evaluate(() => window.ssEditor!.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run());
    // As Docs will have it: an empty line, the table, a line after it
    await expect.poll(() => page.evaluate(() => (window.ssEditor!.getJSON().content ?? []).map((n) => n.type))).toEqual(["paragraph", "table", "paragraph"]);
    // (this fake Google doesn't apply edits, so the editor may send the new table again on its next save)
    await expect.poll(() => api.requests("insertTable").length).toBeGreaterThanOrEqual(1);
    // The save makes the table and takes nothing out: no delete of the line before it
    const sent = api.edits.slice(before).flatMap((e) => e.requests.map((r) => Object.keys(r)[0]));
    expect(sent).not.toContain("deleteContentRange");
    // Backspace on that line can't take it away either (Docs can't), and typing in a cell still works
    await page.evaluate(() => window.ssEditor!.chain().focus().setTextSelection(1).run());
    await page.keyboard.press("Backspace");
    await expect.poll(() => page.evaluate(() => window.ssEditor!.getJSON().content?.[0]?.type)).toBe("paragraph");
  });

  test("a second click while Google makes the document makes only one; Refresh list right after keeps it open", async ({ app, page, api }) => {
    api.createDelay = 800;
    api.listLag = 2;
    await app.open();
    const side = page.getByRole("navigation", { name: "Syncs" });
    await side.getByRole("button", { name: "New Google Doc" }).click();
    await page.locator("header").getByRole("button", { name: "New Google Doc" }).click({ force: true }).catch(() => {});
    await expect(page.locator("header .ss-title")).toContainText("Untitled document");
    expect(api.creates.length).toBe(1);
    await expect.poll(() => app.text()).toBe("");
    // Drive doesn't list it yet
    await app.menu("File", "Open");
    await page.getByRole("menuitem").filter({ has: page.getByText("Refresh list", { exact: true }) }).click();
    await page.waitForTimeout(600);
    await expect(page.locator("header .ss-title")).toContainText("Untitled document");
    expect(await app.text()).toBe("");
  });

  test("the text of a document that couldn't be opened, or one still opening, doesn't move into the new one", async ({ app, page, api }) => {
    api.contentMode = "always";
    const broken = "doc-broken-0123456789";
    api.docs.push({ id: broken, name: "Broken doc", modifiedTime: new Date(Date.now() - 60_000).toISOString() });
    api.contentErrors[broken] = 404;
    await app.open();
    await withNewText(app, page);
    await page.waitForTimeout(600);
    await pick(page, /Broken doc/);
    await expect(app.subtitle()).toContainText("Couldn't open this document");
    // Only its own new text (none): not the other document's
    await expect.poll(() => app.pending()).toEqual([]);
    await page.getByRole("navigation", { name: "Syncs" }).getByRole("button", { name: "New Google Doc" }).click();
    await expect(page.locator("header .ss-title")).toContainText("Untitled document");
    await expect.poll(() => app.text()).toBe("");
    // It is still with its own document
    await pick(page, new RegExp(FIXTURE_DOC_NAME));
    await expect.poll(() => app.pending()).toEqual([ADDED]);
  });
});

test.describe("What belongs to one document stays with it", () => {
  test("another document leaves the last one's failed start and its Undo behind", async ({ app, page, api }) => {
    api.contentMode = "always";
    otherDoc(app);
    api.startFailure = { status: 400, error: "Google Docs said no to this one." };
    await app.open();
    await withNewText(app, page);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect(panel(page).getByRole("alert")).toHaveText("Google Docs said no to this one.");
    await manual(page).click();
    await panel(page).getByLabel("Break length").fill("5m");
    await clickWord(app, page, "later,");
    await expect(pills(page)).toHaveCount(1);
    await panel(page).getByRole("button", { name: "Clear all" }).click();
    const undo = page.getByRole("status").getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    // An edit clears a failed start too; so does another document
    await pick(page, /Other notes/);
    await expect(page.locator("header .ss-title")).toContainText("Other notes");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    await expect(undo).toHaveCount(0);
    await expect(app.doc).toContainText("Other notes, already in the document.");
    await expect(pills(page)).toHaveCount(0);
  });

  test("a failed start goes away with an edit to the text", async ({ app, page, api }) => {
    api.startFailure = { status: 400, error: "Google Docs said no to this one." };
    await app.open();
    await withNewText(app, page);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect(panel(page).getByRole("alert")).toBeVisible();
    await app.caretAtEnd("Typed later");
    await page.keyboard.type(" More.");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
  });

  test("a break's popover closes when the page reloads under it (it would point at another word)", async ({ app, page, api }) => {
    api.contentMode = "always";
    await app.open();
    await withNewText(app, page);
    await manual(page).click();
    await panel(page).getByLabel("Break length").fill("5m");
    await clickWord(app, page, "later,");
    await page.getByRole("button", { name: "Done" }).click();
    await pills(page).click();
    const pop = page.getByRole("dialog", { name: "Break" });
    await expect(pop).toBeVisible();
    // The document changes in Google Docs: the next check reloads it
    api.revision = "changed-in-docs";
    await expect(pop).toHaveCount(0, { timeout: 10_000 });
    await expect(pills(page)).toHaveText(["5m"]);
  });
});

test.describe("A page that isn't ready can't be changed", () => {
  test("a document still opening shows under a calm veil and takes no edits until it is in", async ({ app, page, api }) => {
    otherDoc(app);
    api.contentDelay[OTHER] = 1500;
    await app.open();
    await pick(page, /Other notes/);
    await expect(page.getByRole("status").filter({ hasText: "Opening the document" })).toBeVisible();
    await expect(page.locator(DOC)).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("button", { name: "Bold", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Start sync" })).toBeDisabled();
    await expect(app.doc).toContainText("Other notes, already in the document.", { timeout: 5000 });
    await expect(page.getByRole("status").filter({ hasText: "Opening the document" })).toHaveCount(0);
    await expect(page.locator(DOC)).toHaveAttribute("contenteditable", "true");
    await expect(page.getByRole("button", { name: "Bold", exact: true })).toBeEnabled();
  });

  test("a document Google is too busy to give right away opens once it can, without a failure on the way", async ({ app, page, api }) => {
    otherDoc(app);
    api.contentBusy[OTHER] = 2;
    await app.open();
    await pick(page, /Other notes/);
    await expect(page.getByRole("status").filter({ hasText: "Opening the document" })).toBeVisible();
    await expect(app.doc).toContainText("Other notes, already in the document.", { timeout: 15_000 });
    expect(api.contentReadsOf[OTHER]).toBe(3);
    await expect(app.subtitle()).not.toContainText("Couldn't open");
    await expect(page.locator(DOC)).toHaveAttribute("contenteditable", "true");
  });

  test("while a sync types into the document, the toolbar and menus can't change it; zoom and print stay", async ({ app, page, api }) => {
    await app.open();
    await withNewText(app, page);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => api.starts.length).toBe(1);
    // The sync's own page: nothing to format, but zoom and print work
    await expect(page.getByRole("button", { name: "Bold", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Print", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Back to editing" }).click();
    await expect(app.subtitle()).toContainText("A sync is typing into this document");
    await expect(page.locator(DOC)).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("button", { name: "Bold", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Bulleted list \(/ })).toBeDisabled();
    await expect(page.locator(".ss-style-btn")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Print", exact: true })).toBeEnabled();
    await page.locator(".ss-zoom-btn").click();
    await page.getByRole("menuitem", { name: "150%" }).click();
    await expect(page.locator(".ss-zoom-btn")).toContainText("150%");
    await page.locator(".ss-menubar-trigger", { hasText: "Format" }).click();
    await expect(page.getByRole("menuitem", { name: "Text", exact: true })).toHaveAttribute("data-disabled", "");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.ssEditor!.isEditable)).toBe(false);
  });
});

test.describe("Small things", () => {
  test("Ctrl+Shift+C in a text field doesn't open the word count; on the page it does", async ({ app, page }) => {
    await app.open();
    await manual(page).click();
    await panel(page).getByLabel("Break length").click();
    await page.keyboard.press("Control+Shift+C");
    await expect(page.locator(".ss-wordcount")).toHaveCount(0);
    await app.caretAfter("Closing");
    await page.keyboard.press("Control+Shift+C");
    await expect(page.locator(".ss-wordcount")).toHaveCount(1);
  });

  test("a sync shown that goes away (removed in another tab) brings the page back to editing", async ({ app, page, api }) => {
    otherDoc(app);
    await app.open();
    await withNewText(app, page);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect(page.getByRole("complementary", { name: "This sync" })).toBeVisible();
    api.jobs = [];
    await expect(panel(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("header .ss-title")).toContainText(FIXTURE_DOC_NAME);
    // The header's picker opens what it picks again
    await pick(page, /Other notes/);
    await expect(app.doc).toContainText("Other notes, already in the document.");
  });

  test("removing another finished sync from the list leaves the one shown where it is", async ({ app, page, api }) => {
    const now = Date.now();
    const job = (id: string, status: string, name: string) => ({
      id, userId: "user-1", documentId: FIXTURE_DOC_ID, documentName: name, status, createdAt: now, startAt: now, startedAt: now,
      currentAction: 0, totalActions: 20, charsSent: 0, totalChars: 10, typoSubStep: 0, typoCharsInDoc: 0, generation: 0, failures: 0,
      activity: "Typing", etaTargetAt: now + 600_000, nextActionAt: now + 3000, wpm: 32, baselineWordCount: 0, breaks: [], completedBreaks: [],
      lastUpdate: now, sourceText: "Ten chars.", context: null, ...(status === "done" ? { finishedAt: now } : {}),
    });
    api.jobs = [job("sync_live", "running", "Live one"), job("sync_old", "done", "Finished one")];
    await app.page.context().addCookies([{ name: "google_access_token", value: "e2e-token", domain: "localhost", path: "/" }]);
    await api.install(page);
    await page.addInitScript((id: string) => { localStorage.setItem("ss_debug", "1"); localStorage.setItem("syncstream_draft_v2", JSON.stringify({ selectedDocId: id })); }, FIXTURE_DOC_ID);
    await page.goto("/dashboard");
    const shown = page.getByRole("complementary", { name: "This sync" });
    await expect(shown).toBeVisible();
    const old = page.getByRole("navigation", { name: "Syncs" }).locator(".ss-sync-row", { hasText: "Finished one" });
    await old.hover();
    await old.getByRole("button", { name: "More for Finished one" }).click();
    await page.getByRole("menuitem", { name: "Remove from list" }).click();
    await expect(page.getByRole("navigation", { name: "Syncs" })).not.toContainText("Finished one");
    await expect(shown).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to editing" })).toBeVisible();
  });
});
