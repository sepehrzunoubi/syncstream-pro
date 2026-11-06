import { test, expect, CLOSING_TEXT, FIXTURE_DOC_ID, tabContent } from "./fixtures";

const TABS = [
  { id: "t.0", title: "Research", level: 0 },
  { id: "t.web", title: "Web Structured Data", level: 0 },
  { id: "t.kid", title: "Sources", level: 1 },
];

test.describe("document tabs", () => {
  test("a document's tabs are listed; the one picked is shown, saved to and synced into, and each keeps its own new text", async ({ app, page, api }) => {
    api.tabs = TABS;
    api.tabContents = { "t.web": tabContent(["Agent payments overview", "Web tab closing line."]), "t.kid": tabContent(["A source"]) };
    api.contentMode = "always";
    await app.open();
    const panel = page.getByRole("navigation", { name: "Document tabs" });
    await expect(panel.locator(".ss-doc-tab .truncate")).toHaveText(["Research", "Web Structured Data", "Sources"]);
    await expect(panel.getByRole("button", { name: "Research" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("header")).toContainText("Research");
    // New text in the first tab
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.type(" Kept in research.");

    await panel.getByRole("button", { name: "Web Structured Data" }).click();
    await expect(app.doc).toContainText("Agent payments overview");
    await expect(app.doc).not.toContainText(CLOSING_TEXT);
    await expect(panel.getByRole("button", { name: "Web Structured Data" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("header")).toContainText("Web Structured Data");
    await expect(page.getByRole("link", { name: "Open in Google Docs" })).toHaveAttribute("href", `https://docs.google.com/document/d/${FIXTURE_DOC_ID}/edit?tab=t.web`);
    expect(api.contentTabs.at(-1)).toBe("t.web");

    // A direct edit is saved to this tab
    await app.caretAtEnd("Web tab closing line.");
    await page.keyboard.press("Backspace");
    await expect.poll(() => api.edits.filter((e) => e.tabId === "t.web").length).toBeGreaterThan(0);
    expect(api.edits.find((e) => e.tabId === "t.web")).toMatchObject({ documentId: FIXTURE_DOC_ID, tabId: "t.web", firstTab: false });
    expect(api.edits.every((e) => e.tabId), "every edit names its tab").toBe(true);
    await page.keyboard.type(". Typed for the web tab.");

    // Each tab keeps its own new text
    await panel.getByRole("button", { name: "Research" }).click();
    await expect(app.doc).toContainText(`${CLOSING_TEXT} Kept in research.`);
    await expect(app.doc).not.toContainText("Typed for the web tab");
    await panel.getByRole("button", { name: "Web Structured Data" }).click();
    await expect(app.doc).toContainText("Typed for the web tab.");
    await expect(app.doc).not.toContainText("Kept in research");

    // The tab picked is kept with the draft, to open next time (the next test opens one)
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("syncstream_draft_v2") ?? "{}").selectedTabId)).toBe("t.web");

    // And a sync types into it
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => api.starts.length).toBe(1);
    expect(api.starts[0].tabId).toBe("t.web");
    expect(api.starts[0].segments?.map((s) => s.text).join("")).toContain("Typed for the web tab.");
    expect(JSON.stringify(api.starts[0].segments)).not.toContain("Kept in research");
    await expect(page.locator("header")).toContainText("Web Structured Data");
  });

  test("the tab kept with the draft is the one opened", async ({ app, page, api }) => {
    api.tabs = TABS;
    api.tabContents = { "t.web": tabContent(["Agent payments overview"]), "t.kid": tabContent(["A source"]) };
    api.contentMode = "always";
    await app.open({ draft: { selectedTabId: "t.kid" }, named: false });
    await expect(app.doc).toContainText("A source");
    await expect(page.getByRole("navigation", { name: "Document tabs" }).getByRole("button", { name: "Sources" })).toHaveAttribute("aria-current", "page");
    expect(api.contentTabs).toEqual(["t.kid"]);
    // Google's page starts are asked for this tab
    await expect.poll(() => api.pageTabs.at(-1)).toBe("t.kid");
  });

  test("a tab that is gone opens the document's first tab, saying so; a document with one tab lists none", async ({ app, page, api }) => {
    api.tabs = TABS;
    api.tabContents = { "t.web": tabContent(["Agent payments overview"]), "t.kid": tabContent(["A source"]) };
    api.contentMode = "always";
    await app.open({ draft: { selectedTabId: "t.deleted" } });
    await expect(page.getByText("That tab is no longer in the document, so SyncStream opened its first tab.")).toBeVisible();
    await expect(app.doc).toContainText(CLOSING_TEXT);
    await expect(page.getByRole("navigation", { name: "Document tabs" }).getByRole("button", { name: "Research" })).toHaveAttribute("aria-current", "page");
    expect(api.contentTabs[0]).toBe("t.deleted");
  });

  test("a document with a single tab shows no tab list and names no tab", async ({ app, page, api }) => {
    api.tabs = [TABS[0]];
    api.contentMode = "always";
    await app.open();
    await expect(page.getByRole("navigation", { name: "Document tabs" })).toHaveCount(0);
    await expect(page.locator(".ss-header-tab")).toHaveCount(0);
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.press("Backspace");
    await expect.poll(() => api.edits.length).toBeGreaterThan(0);
    // Its edits still name it, so they reach it wherever the tabs move
    expect(api.edits[0]).toMatchObject({ tabId: "t.0", firstTab: true });
  });
});
