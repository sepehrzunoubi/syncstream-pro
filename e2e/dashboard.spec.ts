import { test, expect, CLOSING_TEXT, FIXTURE_DOC_NAME } from "./fixtures";

test.describe("opening a document", () => {
  test("renders the fixture document: headings, lists, table, image, page break and footnote", async ({ app, page }) => {
    await app.open();
    const paras = await app.paragraphs();
    expect(paras.map((p) => [p.text, p.style])).toEqual(
      expect.arrayContaining([
        [FIXTURE_DOC_NAME, "title"],
        ["What I listened for", "h1"],
        ["Program", "h2"],
        [CLOSING_TEXT, "normal"],
      ])
    );
    // Lists keep their kind and nesting
    const bullets = paras.filter((p) => p.list === "bullet");
    expect(bullets.map((p) => [p.text, p.level])).toEqual([["Texture and resonance", 0], ["How the voice changes", 1], ["Silence between sounds", 0]]);
    expect(paras.filter((p) => p.list === "ordered").map((p) => p.label)).toEqual(["1.", "2."]);
    // The table with its cells
    const table = app.doc.locator("table");
    await expect(table).toBeVisible();
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(table.locator("td").first()).toHaveText("Work");
    // Image, page break and footnote reference
    await expect(app.doc.locator("img[src]")).toHaveAttribute("src", "/sync-icon.png");
    await expect(app.doc.locator("span[data-page-break]")).toHaveCount(1);
    await expect(app.doc.locator("sup.ss-fn-ref")).toHaveAttribute("data-n", "1");
    // The footnote text sits at the bottom of a page
    await expect(page.locator(".ss-footnotes")).toContainText("Recorded in 1962");
  });

  test("lays the document out on more than one page, with the page break honoured", async ({ app, page }) => {
    await app.open();
    await expect.poll(() => app.sheets()).toBeGreaterThanOrEqual(2);
    // "The second work..." follows the page break, so it starts on the second sheet
    const second = page.locator(".ss-sheet").nth(1);
    const sheetTop = (await second.boundingBox())!.y;
    const after = app.doc.locator("p", { hasText: "The second work uses tape" });
    expect((await after.boundingBox())!.y).toBeGreaterThan(sheetTop);
    const before = app.doc.locator("p", { hasText: "Intermission notes" });
    expect((await before.boundingBox())!.y).toBeLessThan(sheetTop);
  });

  test("shows the document name and nothing is saved on open", async ({ app, page, api }) => {
    await app.open();
    await expect(page.locator("header")).toContainText(FIXTURE_DOC_NAME);
    await expect(app.subtitle()).toHaveText("Edits save to Google Docs. Type anywhere to add text.");
    expect(api.edits).toEqual([]);
    expect(api.contentReads).toBe(1);
  });

  test("the outline lists the title and headings in order", async ({ app, page }) => {
    await app.open();
    const items = page.locator(".ss-outline .ss-outline-item");
    await expect(items).toHaveText([FIXTURE_DOC_NAME, "What I listened for", "Program"]);
    await expect(page.locator(".ss-outline li").nth(2)).toHaveAttribute("data-level", "2");
    // Clicking a heading moves the caret into it
    await items.nth(2).click();
    await expect.poll(() => page.evaluate(() => window.ssEditor!.state.selection.$from.parent.textContent)).toBe("Program");
  });
});

test.describe("typing", () => {
  test("new text glows as pending and is not saved", async ({ app, api }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    await app.page.keyboard.type(" And one more line.");
    await expect.poll(() => app.pending()).toEqual([" And one more line."]);
    await expect(app.subtitle()).toHaveText("New text glows. Start sync types it in.");
    // The save debounce (700ms) passes without a request: additions are for a sync, not a save
    await app.page.waitForTimeout(1200);
    expect(api.edits).toEqual([]);
  });

  test("undo removes typed text and redo brings it back", async ({ app, page }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.type(" Undo me");
    await expect(app.doc).toContainText(CLOSING_TEXT + " Undo me");
    await page.keyboard.press("Control+z");
    await expect(app.doc).not.toContainText("Undo me");
    await page.keyboard.press("Control+y");
    await expect(app.doc).toContainText(CLOSING_TEXT + " Undo me");
    await expect.poll(() => app.pending()).toEqual([" Undo me"]);
  });
});
