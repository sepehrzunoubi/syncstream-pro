import { test, expect, CLOSING_TEXT, FIXTURE_DOC_ID } from "./fixtures";

/**
 * Direct edits (formatting and deleting text the document already has) save
 * straight to Google Docs as batchUpdate requests. These tests assert the
 * exact requests, with Docs indices computed from the fixture's layout.
 */
test.describe("direct edits save to Google Docs", () => {
  test("bold, italic and underline via shortcuts send updateTextStyle for exactly the selection", async ({ app, api, page }) => {
    await app.open();
    const closing = api.fixture.at.closing;
    const word = { start: closing + CLOSING_TEXT.indexOf("thoughts"), end: closing + CLOSING_TEXT.indexOf("thoughts") + "thoughts".length };

    await app.select("thoughts");
    await page.keyboard.press("Control+b");
    await expect(app.doc.locator("p strong", { hasText: "thoughts" })).toHaveCount(1);
    await app.waitForSave(1);
    expect(api.edits[0].documentId).toBe(FIXTURE_DOC_ID);
    expect(api.edits[0].revisionId).toBe("fixture-rev-1");
    expect(api.edits[0].requests).toEqual([{ updateTextStyle: { range: { startIndex: word.start, endIndex: word.end }, textStyle: { bold: true }, fields: "bold" } }]);

    await page.keyboard.press("Control+i");
    await expect(app.doc.locator("p em", { hasText: "thoughts" })).toHaveCount(1);
    await app.waitForSave(2);
    // The next save carries the revision the previous one returned
    expect(api.edits[1].revisionId).toBe(api.revisions[0]);
    expect(api.edits[1].requests).toEqual([{ updateTextStyle: { range: { startIndex: word.start, endIndex: word.end }, textStyle: { italic: true }, fields: "italic" } }]);

    await page.keyboard.press("Control+u");
    await expect(app.doc.locator("p u", { hasText: "thoughts" })).toHaveCount(1);
    await app.waitForSave(3);
    expect(api.edits[2].requests).toEqual([{ updateTextStyle: { range: { startIndex: word.start, endIndex: word.end }, textStyle: { underline: true }, fields: "underline" } }]);
    // Nothing glows: formatting existing text is not an addition
    expect(await app.pending()).toEqual([]);
  });

  test("deleting a word inside existing text sends one deleteContentRange", async ({ app, api, page }) => {
    await app.open();
    const closing = api.fixture.at.closing;
    await app.caretAfter("whole ");
    for (let i = 0; i < "whole ".length; i++) await page.keyboard.press("Backspace");
    await expect(app.doc).toContainText("Closing thoughts on the program.");
    await app.waitForSave(1);
    const start = closing + CLOSING_TEXT.indexOf("whole ");
    expect(api.requests()).toEqual([{ deleteContentRange: { range: { startIndex: start, endIndex: start + "whole ".length } } }]);
    await expect(app.subtitle()).toHaveText("Edits save to Google Docs. Type anywhere to add text.");
  });

  test("Heading 1 via Ctrl+Alt+1 restyles the paragraph and saves its named style", async ({ app, api, page }) => {
    await app.open();
    await app.caretAfter("Closing");
    await page.keyboard.press("Control+Alt+1");
    await expect.poll(async () => (await app.paragraphs()).find((p) => p.text === CLOSING_TEXT)?.style).toBe("h1");
    await app.waitForSave(1);
    const styles = api.requests("updateParagraphStyle") as { range: { startIndex: number; endIndex: number }; paragraphStyle: { namedStyleType?: string }; fields: string }[];
    expect(styles).toHaveLength(1);
    expect(styles[0].paragraphStyle.namedStyleType).toBe("HEADING_1");
    expect(styles[0].fields.split(",")).toContain("namedStyleType");
    // The range is the paragraph, up to and including its newline
    expect(styles[0].range).toEqual({ startIndex: api.fixture.at.closing, endIndex: api.fixture.at.closing + CLOSING_TEXT.length + 1 });
    // The outline picks the new heading up
    await expect(page.locator(".ss-outline .ss-outline-item").last()).toHaveText(CLOSING_TEXT);
  });

  test("Ctrl+Shift+8 turns a paragraph into a bulleted list item and saves createParagraphBullets", async ({ app, api, page }) => {
    await app.open();
    await app.caretAfter("Closing");
    await page.keyboard.press("Control+Shift+8");
    await expect.poll(async () => (await app.paragraphs()).find((p) => p.text === CLOSING_TEXT)?.list).toBe("bullet");
    await app.waitForSave(1);
    // The paragraph, newline included; any old bullets are cleared before the new ones are made
    const range = { startIndex: api.fixture.at.closing, endIndex: api.fixture.at.closing + CLOSING_TEXT.length + 1 };
    expect(api.edits[0].requests).toEqual([
      { deleteParagraphBullets: { range } },
      { createParagraphBullets: { range, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
    ]);
    // Pressing it again leaves the list: bullets removed, the paragraph's own indents restored
    await page.keyboard.press("Control+Shift+8");
    await expect.poll(async () => (await app.paragraphs()).find((p) => p.text === CLOSING_TEXT)?.list).toBeNull();
    await app.waitForSave(2);
    expect(api.edits[1].requests).toEqual([
      { deleteParagraphBullets: { range } },
      { updateParagraphStyle: { range, paragraphStyle: { indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } }, fields: "indentStart,indentFirstLine" } },
    ]);
  });

  test("Tab nests a list item and Shift+Tab brings it back", async ({ app, api, page }) => {
    await app.open();
    const item = "Silence between sounds";
    const level = async () => (await app.paragraphs()).find((p) => p.text === item)?.level;
    expect(await level()).toBe(0);
    await app.caretBefore(item);
    await page.keyboard.press("Tab");
    await expect.poll(level).toBe(1);
    await app.waitForSave(1);
    // Docs has no "nesting level" request: the whole list is recreated with a leading tab per level
    // (one for the item that was already nested, one for the item that was just nested)
    const { at } = api.fixture;
    const listEnd = at.h2; // the list runs up to the heading that follows it
    expect(api.kinds()).toEqual(["deleteParagraphBullets", "insertText", "insertText", "createParagraphBullets"]);
    expect(api.requests("deleteParagraphBullets")).toEqual([{ range: { startIndex: at.bullet1, endIndex: listEnd } }]);
    expect(api.requests("insertText")).toEqual([{ location: { index: at.bullet3 }, text: "\t" }, { location: { index: at.bullet2 }, text: "\t" }]);
    expect(api.requests("createParagraphBullets")).toEqual([{ range: { startIndex: at.bullet1, endIndex: listEnd + 2 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" }]);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(level).toBe(0);
    await app.waitForSave(2);
    expect(api.edits[1].requests.map((r) => Object.keys(r)[0])).toEqual(["deleteParagraphBullets", "insertText", "createParagraphBullets"]);
  });

  test("find and replace: Ctrl+F counts matches, Ctrl+H replaces all and saves the replacements", async ({ app, api, page }) => {
    await app.open();
    await app.caretAfter("Closing");
    await page.keyboard.press("Control+f");
    const bar = page.locator(".ss-find-bar");
    await expect(bar).toBeVisible();
    await expect(bar.locator("input")).toBeFocused();
    await page.keyboard.type("piece");
    await expect(bar.locator(".ss-find-count")).toHaveText("1 of 2");
    await expect(app.doc.locator(".ss-find-current")).toHaveCount(1);
    await expect(app.doc.locator(".ss-find-match")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(bar.locator(".ss-find-count")).toHaveText("2 of 2");
    await page.keyboard.press("Enter");
    await expect(bar.locator(".ss-find-count")).toHaveText("1 of 2");

    // Ctrl+H opens the dialog with the same query
    await page.keyboard.press("Control+h");
    const dialog = page.getByRole("dialog", { name: "Find and replace" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Find")).toHaveValue("piece");
    await dialog.getByLabel("Replace with").fill("work");
    await dialog.getByRole("button", { name: "Replace all" }).click();
    await expect(app.doc).toContainText("First work, for voice and tape");
    await expect(app.doc).toContainText("Second work, for strings");
    // Replacements inside existing text are direct edits: nothing glows, both are saved
    expect(await app.pending()).toEqual([]);
    await app.waitForSave(1);
    const first = api.fixture.at.num1 + "First ".length;
    const second = api.fixture.at.num2 + "Second ".length;
    const deletes = api.requests("deleteContentRange") as { range: { startIndex: number; endIndex: number } }[];
    const inserts = api.requests("insertText") as { location: { index: number }; text: string }[];
    expect(deletes.map((d) => d.range).sort((a, b) => a.startIndex - b.startIndex)).toEqual([
      { startIndex: first, endIndex: first + "piece".length },
      { startIndex: second, endIndex: second + "piece".length },
    ]);
    expect(inserts.map((i) => [i.location.index, i.text]).sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([[first, "work"], [second, "work"]]);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
  });
});
