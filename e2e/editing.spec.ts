import { test, expect, CLOSING_TEXT, FIXTURE_DOC_ID } from "./fixtures";
import type { Page } from "@playwright/test";
import { importDoc } from "../src/lib/doc-import";
import { EMPTY_DOC } from "./fixtures/empty-doc";

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

  test("Format > Align & indent > Right-to-left text turns the paragraph around and saves its direction", async ({ app, api, page }) => {
    await app.open();
    await app.caretAfter("Closing");
    const closing = app.doc.locator("p", { hasText: CLOSING_TEXT });
    const choose = async (item: string) => {
      await page.locator(".ss-menubar-trigger", { hasText: "Format" }).click();
      await page.getByRole("menuitem").filter({ has: page.getByText("Align & indent", { exact: true }) }).hover();
      await page.getByRole("menuitem").filter({ has: page.getByText(item, { exact: true }) }).click();
    };
    await choose("Right-to-left text");
    await expect(closing).toHaveAttribute("dir", "rtl");
    await app.waitForSave(1);
    const range = { startIndex: api.fixture.at.closing, endIndex: api.fixture.at.closing + CLOSING_TEXT.length + 1 };
    // Aligned to its start, which is now the right: the same alignment in Docs, sent with the direction
    expect(api.edits[0].requests).toEqual([{ updateParagraphStyle: { range, paragraphStyle: { alignment: "START", direction: "RIGHT_TO_LEFT" }, fields: "alignment,direction" } }]);
    await choose("Left-to-right text");
    await expect(closing).not.toHaveAttribute("dir", /./);
    await app.waitForSave(2);
    expect(api.edits[1].requests).toEqual([{ updateParagraphStyle: { range, paragraphStyle: { alignment: "START", direction: "LEFT_TO_RIGHT" }, fields: "alignment,direction" } }]);
  });

  test("paint format copies a paragraph's direction and a list item's level", async ({ app, api, page }) => {
    await app.open();
    const intro = "Notes on three works, with bold, italic and underlined words.";
    const paint = async (from: string, to: string) => {
      await app.caretAfter(from);
      await page.getByRole("button", { name: "Paint format" }).click();
      await app.select(to);
      await app.doc.dispatchEvent("mouseup");
      await expect(page.getByRole("button", { name: "Paint format" })).toHaveAttribute("aria-pressed", "false");
    };
    await app.caretAfter("Closing");
    await page.locator(".ss-menubar-trigger", { hasText: "Format" }).click();
    await page.getByRole("menuitem").filter({ has: page.getByText("Align & indent", { exact: true }) }).hover();
    await page.getByRole("menuitem").filter({ has: page.getByText("Right-to-left text", { exact: true }) }).click();
    await app.waitForSave(1);
    // A right-to-left paragraph aligned to its start: the paragraph painted turns around with it
    await paint("Closing", "Notes on three");
    await expect(app.doc.locator("p", { hasText: intro })).toHaveAttribute("dir", "rtl");
    await app.waitForSave(2);
    const range = { startIndex: api.fixture.at.intro, endIndex: api.fixture.at.intro + intro.length + 1 };
    const styles = api.edits[1].requests.filter((r) => "updateParagraphStyle" in r).map((r) => (r as { updateParagraphStyle: { range: unknown; paragraphStyle: Record<string, unknown> } }).updateParagraphStyle);
    expect(styles.find((u) => JSON.stringify(u.range) === JSON.stringify(range))?.paragraphStyle).toMatchObject({ alignment: "START", direction: "RIGHT_TO_LEFT" });
    // A nested item paints its level, not just that it is an item
    await paint("How the voice", "Second piece");
    await expect.poll(async () => (await app.paragraphs()).find((p) => p.text.startsWith("Second piece"))?.level).toBe(1);
  });

  test("the ruler measures a right-to-left paragraph's indents from the right", async ({ app, api, page }) => {
    await app.open();
    await app.caretAfter("Closing");
    await page.locator(".ss-menubar-trigger", { hasText: "Format" }).click();
    await page.getByRole("menuitem").filter({ has: page.getByText("Align & indent", { exact: true }) }).hover();
    await page.getByRole("menuitem").filter({ has: page.getByText("Right-to-left text", { exact: true }) }).click();
    await app.waitForSave(1);
    const ruler = page.locator(".ss-ruler svg");
    const box = (await ruler.boundingBox())!;
    const scale = box.width / Number(await ruler.getAttribute("width"));
    const centre = async (marker: string) => { const b = (await ruler.locator(`[data-marker="${marker}"]`).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    // The start and first-line markers sit on the right margin, the end marker on the left one
    const paper = (await app.doc.boundingBox())!;
    const margin = 96 * scale;
    expect(Math.abs((await centre("start")).x - (box.x + box.width - margin))).toBeLessThan(1);
    expect(Math.abs((await centre("first")).x - (box.x + box.width - margin))).toBeLessThan(1);
    expect(Math.abs((await centre("end")).x - (box.x + margin))).toBeLessThan(1);
    expect(Math.abs(paper.width - box.width)).toBeLessThan(1);
    // Dragging the start marker an inch to the left indents the paragraph an inch from the right
    const from = await centre("start");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 48 * scale, from.y, { steps: 4 });
    await page.mouse.move(from.x - 96 * scale, from.y, { steps: 4 });
    await page.mouse.up();
    const closing = app.doc.locator("p", { hasText: CLOSING_TEXT });
    await expect.poll(() => closing.evaluate((p) => [getComputedStyle(p).marginRight, getComputedStyle(p).marginLeft])).toEqual(["96px", "0px"]);
    await app.waitForSave(2);
    expect(api.edits[1].requests).toEqual([{ updateParagraphStyle: {
      range: { startIndex: api.fixture.at.closing, endIndex: api.fixture.at.closing + CLOSING_TEXT.length + 1 },
      paragraphStyle: { indentStart: { magnitude: 72, unit: "PT" }, indentFirstLine: { magnitude: 72, unit: "PT" } },
      fields: "indentStart,indentFirstLine",
    } }]);
    expect(Math.abs((await centre("start")).x - (box.x + box.width - 2 * margin))).toBeLessThan(1);
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
    const zeroIndent = { updateParagraphStyle: { range, paragraphStyle: { indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } }, fields: "indentStart,indentFirstLine" } };
    expect(api.edits[0].requests).toEqual([
      { deleteParagraphBullets: { range } },
      // Indents left by earlier bullets would count as levels, so the item starts from zero
      zeroIndent,
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
    expect(api.kinds()).toEqual(["deleteParagraphBullets", "updateParagraphStyle", "insertText", "insertText", "createParagraphBullets"]);
    expect(api.requests("deleteParagraphBullets")).toEqual([{ range: { startIndex: at.bullet1, endIndex: listEnd } }]);
    expect(api.requests("updateParagraphStyle")).toEqual([{ range: { startIndex: at.bullet1, endIndex: listEnd }, paragraphStyle: { indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } }, fields: "indentStart,indentFirstLine" }]);
    expect(api.requests("insertText")).toEqual([{ location: { index: at.bullet3 }, text: "\t" }, { location: { index: at.bullet2 }, text: "\t" }]);
    expect(api.requests("createParagraphBullets")).toEqual([{ range: { startIndex: at.bullet1, endIndex: listEnd + 2 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" }]);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(level).toBe(0);
    await app.waitForSave(2);
    expect(api.edits[1].requests.map((r) => Object.keys(r)[0])).toEqual(["deleteParagraphBullets", "updateParagraphStyle", "insertText", "createParagraphBullets"]);
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

test.describe("headers and footers", () => {
  const run = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, textRun: { content: text, textStyle: {} } });
  const para = (text: string, startIndex: number) => ({ startIndex, endIndex: startIndex + text.length, paragraph: { elements: [run(text, startIndex)], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } });
  /** The empty document with a header of these elements */
  const withHeader = (content: object[]) => ({ ...EMPTY_DOC, documentStyle: { ...EMPTY_DOC.documentStyle, defaultHeaderId: "kix.header" }, headers: { "kix.header": { headerId: "kix.header", content } } });
  type HeaderEditor = { commands: { focus(at: string): void; setTextSelection(at: number): void }; state: { doc: { descendants(f: (n: { type: { name: string }; attrs: Record<string, unknown> }) => void): void } } };
  /** The caret in the header being edited: at its end, or at a position */
  const caretInHeader = (page: Page, at: number | "end") => page.evaluate((pos) => {
    const ed = (document.querySelector(".ss-hf-editing .ProseMirror") as HTMLElement & { editor?: HeaderEditor }).editor!;
    if (pos === "end") ed.commands.focus("end");
    else ed.commands.setTextSelection(pos);
  }, at);
  /** The images in the header being edited */
  const headerImages = (page: Page) => page.evaluate(() => {
    const ed = (document.querySelector(".ss-hf-editing .ProseMirror") as HTMLElement & { editor?: HeaderEditor }).editor!;
    const out: unknown[] = [];
    ed.state.doc.descendants((n) => { if (n.type.name === "image") out.push(n.attrs.src); });
    return out;
  });

  test("a header with a table shows the table's text, and typing in the header saves only what is typed", async ({ app, api, page }) => {
    // "Logo co.", a table of one row (Address | Phone), and the paragraph Docs keeps after a table
    const table = { startIndex: 9, endIndex: 28, table: { rows: 1, columns: 2, tableRows: [{ startIndex: 10, endIndex: 27, tableCells: [
      { startIndex: 11, endIndex: 20, content: [para("Address\n", 12)] },
      { startIndex: 20, endIndex: 27, content: [para("Phone\n", 21)] },
    ] }] } };
    api.content = importDoc(withHeader([para("Logo co.\n", 0), table, para("\n", 28)]) as never);
    api.revision = api.content.revisionId;
    await app.open({ named: false });
    await expect(page.locator(".ss-hf-header").first()).toContainText("Address");
    await page.locator(".ss-hf-header").first().dblclick();
    await expect(page.locator(".ss-hf-editing")).toHaveCount(1);
    await caretInHeader(page, "end");
    await page.keyboard.type("Hi");
    await app.waitForSave(1);
    expect(api.requests("deleteContentRange")).toEqual([]);
    expect(api.requests("insertText")).toEqual([{ location: { index: 28, segmentId: "kix.header" }, text: "Hi" }]);
    // The table's text can't be changed here
    await caretInHeader(page, 14);
    await page.keyboard.type("x");
    await expect(page.locator(".ss-hf-editing")).toContainText("Address");
    await expect(page.locator(".ss-hf-editing")).not.toContainText("Adxdress");
  });

  test("an image pasted into a header is kept only when the save can put it there", async ({ app, api, page }) => {
    api.content = importDoc(withHeader([para("Head\n", 0)]) as never);
    api.revision = api.content.revisionId;
    await app.open({ named: false });
    await page.locator(".ss-hf-header").first().dblclick();
    await expect(page.locator(".ss-hf-editing")).toHaveCount(1);
    await caretInHeader(page, "end");
    const paste = (html: string) => page.evaluate((h) => {
      const dt = new DataTransfer();
      dt.setData("text/html", h);
      dt.setData("text/plain", "Logo ");
      document.querySelector(".ss-hf-editing .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, html);
    const images = () => headerImages(page);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    // Given as data (Docs' copy of a document open for viewing), or a word processor's file
    await paste(`<meta charset="utf-8"><span>Logo </span><img src="${png}" width="24" height="24"><img src="file:///C:/clip_image001.png">`);
    await expect(page.getByText("Couldn't add a pasted image: a header or footer takes an image only from a web address. It was left out.")).toBeVisible();
    await expect(page.locator(".ss-hf-editing")).toContainText("Logo");
    expect(await images()).toEqual([]);
    // On the web: kept
    await paste('<meta charset="utf-8"><img src="https://images.e2e.test/logo.png" width="24" height="24">');
    await expect.poll(images).toEqual(["https://images.e2e.test/logo.png"]);
  });
});
