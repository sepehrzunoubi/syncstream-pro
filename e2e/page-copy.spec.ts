import { test, expect, FIXTURE_DOC_ID, FIXTURE_DOC_NAME } from "./fixtures";
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
    // One line per paragraph, as Docs copies them
    expect(copied.text).toBe("Plain words in Courier\nSecond");
    expect(copied.html).toContain("Courier New");
    expect(copied.html).not.toContain("SS Space");
  });

  test("a copy of a numbered list counts on after a sub-item that follows a paragraph between items", async ({ app, page }) => {
    const box = { start: 0, first: 0, above: 0, below: 0 };
    const p = (text: string, attrs: Record<string, unknown>) => ({ type: "paragraph", attrs: { box, ...attrs }, content: [{ type: "text", text }] });
    await app.open({ plain: [p("Item A", { list: "ordered", level: 0 }), p("Between", { listCont: true }), p("Sub item", { list: "ordered", level: 1 }), p("Item B", { list: "ordered", level: 0 })] });
    await expect.poll(async () => (await app.paragraphs()).map((x) => x.label)).toEqual(["1.", null, "a.", "2."]);
    const html = await page.evaluate(() => { const v = window.ssEditor!.view; return v.serializeForClipboard(v.state.doc.slice(0, v.state.doc.content.size)).dom.innerHTML; });
    const lists = await page.evaluate((h) => { const d = document.createElement("div"); d.innerHTML = h; return Array.from(d.children).filter((e) => /^(OL|UL)$/.test(e.tagName)).map((e) => ({ tag: e.tagName, start: e.getAttribute("start"), text: e.textContent })); }, html);
    expect(lists.find((l) => l.text?.includes("Item B"))).toMatchObject({ tag: "OL", start: "2" });
    expect(lists.every((l) => l.tag === "OL" || l.start == null)).toBe(true);
  });

  test("Ctrl+A while a header is edited selects the header, even after a click on the page", async ({ app, api, page }) => {
    const doc = { ...EMPTY_DOC, documentStyle: { ...EMPTY_DOC.documentStyle, defaultHeaderId: "kix.header" }, headers: { "kix.header": { headerId: "kix.header", content: [{ startIndex: 0, endIndex: 12, paragraph: { elements: [{ startIndex: 0, endIndex: 12, textRun: { content: "Header text\n", textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } }] } } };
    api.content = importDoc(doc as never);
    api.revision = api.content.revisionId;
    await app.open({ named: false });
    await page.locator(".ss-hf-header").first().dblclick();
    await expect(page.locator(".ss-hf-editing")).toHaveCount(1);
    // A click somewhere that takes no focus
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+A");
    const header = await page.evaluate(() => {
      const ed = (document.querySelector(".ss-hf-editing .ProseMirror") as HTMLElement & { editor?: { state: { selection: { from: number; to: number }; doc: { content: { size: number }; textBetween(a: number, b: number): string } } } }).editor!;
      const { from, to } = ed.state.selection;
      return ed.state.doc.textBetween(from, to);
    });
    expect(header).toBe("Header text");
    await expect(page.locator(".ss-hf-editing")).toHaveCount(1);
  });

  test("Ctrl+A straight after a double-click on the header selects the header", async ({ app, api, page }) => {
    const doc = { ...EMPTY_DOC, documentStyle: { ...EMPTY_DOC.documentStyle, defaultHeaderId: "kix.header" }, headers: { "kix.header": { headerId: "kix.header", content: [{ startIndex: 0, endIndex: 12, paragraph: { elements: [{ startIndex: 0, endIndex: 12, textRun: { content: "Header text\n", textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } }] } } };
    api.content = importDoc(doc as never);
    api.revision = api.content.revisionId;
    await app.open({ named: false });
    // As soon as the page has drawn the header as edited, before the header has taken focus
    await page.locator(".ss-hf-header").first().evaluate(async (el) => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      while (!document.querySelector(".ss-hf-editing")) await new Promise((r) => requestAnimationFrame(r));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    const selected = () => page.evaluate(() => {
      const ed = (document.querySelector(".ss-hf-editing .ProseMirror") as (HTMLElement & { editor?: { state: { selection: { from: number; to: number }; doc: { textBetween(a: number, b: number): string } } } }) | null)?.editor;
      return ed ? ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to) : null;
    });
    await expect.poll(selected).toBe("Header text");
    // And it stays selected once the header has taken focus
    await page.waitForTimeout(200);
    expect(await selected()).toBe("Header text");
    await expect(page.locator(".ss-hf-editing")).toHaveCount(1);
    // The body's text isn't what is selected
    expect(await page.evaluate(() => { const s = window.ssEditor!.state.selection; return s.to - s.from; })).toBe(0);
  });

  test("while a sync shows, Ctrl+A selects what it is typing and a copy of it is the editor's own", async ({ app, page, api }) => {
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
    const viewer = page.locator("[aria-label='Text being typed into Google Docs']");
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText("Already being typed in");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+A");
    const copied = await page.evaluate(() => {
      const sel = document.getSelection()!;
      const view = document.querySelector("[aria-label='Text being typed into Google Docs']")!;
      const inside = sel.rangeCount > 0 && view.contains(sel.getRangeAt(0).commonAncestorContainer);
      const data = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
      return { inside, html: data.getData("text/html"), text: data.getData("text/plain") };
    });
    expect(copied.inside).toBe(true);
    expect(copied.text).toContain("Already being typed in");
    expect(copied.html).toContain("Already being typed in");
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
    // (polled: the copies are drawn again as the pages settle)
    await expect.poll(() => copies.first().getByText("Header text").evaluate((el) => (el.isConnected ? getComputedStyle(el).userSelect : null))).toBe("none");
    // The live header is text to select and edit
    expect(await page.locator(".ss-hf-body:not(.ss-static-copy) .ss-doc").first().evaluate((el) => getComputedStyle(el).userSelect)).toBe("text");
  });
});
