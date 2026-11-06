import { test, expect } from "./fixtures";
import { importDoc } from "../src/lib/doc-import";
import { EMPTY_DOC } from "./fixtures/empty-doc";

/**
 * The page draws each family in a stack that starts with a face of its own ("SS Space Arial",
 * space-faces.ts). A copy the browser makes itself inlines that stack, so another app would name it as
 * the font: every copy of the document goes through the editor's own copy instead (page-copy.ts).
 */
test.describe("copies of the page", () => {
  test("Ctrl+A outside the editor selects the document, and a copy dragged in from the margin is the editor's own", async ({ app, api, page }) => {
    api.content = importDoc(EMPTY_DOC as never);
    api.revision = api.content.revisionId;
    await app.open({ named: false });
    await page.evaluate(() => window.ssEditor!.commands.setContent({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Plain words " }, { type: "text", text: "in Courier", marks: [{ type: "textStyle", attrs: { fontFamily: "Courier New" } }] }] },
      { type: "paragraph", content: [{ type: "text", text: "Second paragraph" }] },
    ] }));
    // The page draws the text in its own faces (what a browser copy would name)
    const drawn = await app.doc.locator("[data-font='Courier New']").first().evaluate((el) => getComputedStyle(el).fontFamily);
    expect(drawn).toContain("SS Space");

    // Ctrl+A with a toolbar button focused: the document, as in Docs
    await page.getByRole("button", { name: "Bold" }).first().focus();
    await page.keyboard.press("Control+A");
    const sel = await page.evaluate(() => { const s = window.ssEditor!.state; return { from: s.selection.from, to: s.selection.to, size: s.doc.content.size }; });
    expect(sel.from).toBeLessThanOrEqual(1);
    expect(sel.to).toBeGreaterThanOrEqual(sel.size - 1);
    await expect.poll(() => page.evaluate(() => window.ssEditor!.isFocused)).toBe(true);

    // A selection dragged from outside the editor into its text (the editor doesn't have focus), copied
    const copied = await page.evaluate(() => {
      const dom = window.ssEditor!.view.dom;
      (document.activeElement as HTMLElement | null)?.blur();
      const walk = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent!.includes("Second")) last = n as Text;
      const range = document.createRange();
      range.setStartBefore(dom);
      range.setEnd(last!, "Second".length);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const data = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
      return { html: data.getData("text/html"), text: data.getData("text/plain") };
    });
    expect(copied.text).toBe("Plain words in Courier\n\nSecond");
    expect(copied.html).toContain("Courier New");
    expect(copied.html).not.toContain("SS Space");
  });

  test("the header drawn on the other pages can't be selected: it is a picture of the live one, as in Docs", async ({ app, api, page }) => {
    const doc = { ...EMPTY_DOC, documentStyle: { ...EMPTY_DOC.documentStyle, defaultHeaderId: "kix.header" }, headers: { "kix.header": { headerId: "kix.header", content: [{ startIndex: 0, endIndex: 12, paragraph: { elements: [{ startIndex: 0, endIndex: 12, textRun: { content: "Header text\n", textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } }] } } };
    api.content = importDoc(doc as never);
    api.revision = api.content.revisionId;
    await app.open({ named: false });
    await page.evaluate(() => window.ssEditor!.commands.setContent({ type: "doc", content: Array.from({ length: 80 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `Line ${i + 1}` }] })) }));
    const copies = page.locator(".ss-static-copy");
    await expect.poll(() => copies.count()).toBeGreaterThan(0);
    await expect(copies.first()).toContainText("Header text");
    // The text itself (the page's documents are selectable, .ss-doc)
    expect(await copies.first().getByText("Header text").evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
    // The live header is text to select and edit
    expect(await page.locator(".ss-hf-body:not(.ss-static-copy) .ss-doc").first().evaluate((el) => getComputedStyle(el).userSelect)).toBe("text");
  });
});
