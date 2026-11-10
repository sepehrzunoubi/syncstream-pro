import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, type FakeGoogle } from "./fixtures";

/** A workbook made for tests (scripts/make-xlsx-fixture.py): four sheets, every kind of formatting */
const WORKBOOK = path.join(__dirname, "..", "fixtures", "xlsx", "kitchen-sink.xlsx");

/** Open the Sheets page, signed in, with the fake API behind it */
async function openSheets(page: Page, api: FakeGoogle, query = ""): Promise<void> {
  await page.context().addCookies([{ name: "google_access_token", value: "e2e-token", domain: "localhost", path: "/" }]);
  await api.install(page);
  await page.goto(`/dashboard/sheets${query}`);
  await expect(page.locator(".sx-workspace")).toBeVisible();
}

/** A second one (scripts/make-xlsx-features-fixture.py): charts, a table, a filter, groups, rules */
const FEATURES = path.join(__dirname, "..", "fixtures", "xlsx", "features.xlsx");

async function upload(page: Page, file = WORKBOOK): Promise<void> {
  await page.locator("[data-testid=sx-file]").setInputFiles(file);
  await expect(page.locator(".sx-grid")).toBeVisible();
}

/** The text a cell shows on the grid */
const cell = (page: Page, ref: string) => page.locator(`.sx-cells .sx-text[data-cell="${ref}"]`);

/** Click a cell (its text lets clicks through to the grid, so the click goes where the cell is) */
async function clickCell(page: Page, ref: string): Promise<void> {
  const box = (await cell(page, ref).boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
}

test.describe("sheets", () => {
  test("an uploaded workbook shows as it is: values, formats, tabs, and what it will take", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await expect(page.getByRole("heading", { name: "Sync an Excel workbook into Google Sheets" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start sync" })).toBeDisabled();
    await upload(page);

    await expect(page.locator("[data-testid=sx-stats]")).toHaveText("4 sheets · 202 cells · 20 formulas");
    await expect(page.locator(".sx-title-input")).toHaveValue("kitchen-sink");
    await expect(cell(page, "A1")).toHaveText("Default");
    // Number formats are applied as Google Sheets applies them
    await expect(cell(page, "B15")).toHaveText("45,124");
    await expect(cell(page, "B18")).toHaveText("4512356.78%");
    await expect(cell(page, "B31")).toHaveText("2023-07-16");
    await expect(cell(page, "C33")).toHaveText("(1,235)");
    // A cell's look: font, weight, colour, fill behind it
    await expect(cell(page, "C1")).toHaveCSS("font-weight", "700");
    await expect(cell(page, "C1")).toHaveCSS("font-style", "italic");
    await expect(cell(page, "F1")).toHaveCSS("color", "rgb(255, 0, 0)");
    await expect(cell(page, "C8")).toHaveCSS("text-align", "right");
    await expect(page.locator(".sx-fill").first()).toBeVisible();

    // Every sheet is a tab; the hidden one is marked
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveText(["Formats", "Data", "Hidden sheet", "Q'uote & co"]);
    await expect(tabs.nth(2)).toHaveAttribute("data-hidden", "true");
    await tabs.nth(1).click();
    await expect(cell(page, "A1")).toHaveText("id");
    await expect(cell(page, "B4")).toHaveText("30.5");

    // The plan: a total, and the sections in the order they are built
    await expect(page.locator("[data-testid=sx-total]")).toContainText("min");
    await expect(page.locator(".sx-sections li").first()).toContainText("Formats");
    await expect(page.getByRole("button", { name: "Start sync" })).toBeEnabled();
  });

  test("picking a cell shows what it holds: a formula as typed", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await upload(page);
    await clickCell(page, "A15");
    await expect(page.locator(".sx-namebox")).toHaveText("A15");
    await expect(page.locator("[data-testid=sx-formula]")).toHaveText("#,##0");
    // Arrow keys move the selection, as in a spreadsheet
    for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
    await expect(page.locator(".sx-namebox")).toHaveText("H15");
    await expect(page.locator("[data-testid=sx-formula]")).toHaveText("=SUM(H12:H14)");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("[data-testid=sx-formula]")).toHaveText("=H15/$I$15");
  });

  test("the build can be stepped through: empty at first, labels before formulas, everything at the end", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await upload(page);
    const scrub = page.locator("[data-testid=sx-scrub]");
    const max = Number(await scrub.getAttribute("max"));
    expect(max).toBeGreaterThan(100);

    await scrub.fill("0");
    await expect(page.locator("[data-testid=sx-step]")).toContainText("Before the first step");
    await expect(page.locator(".sx-cells .sx-text")).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(0);

    // A little in: the first tab exists and its first labels are typed, in Sheets' own font until the look is set
    await scrub.fill("12");
    await expect(page.locator("[data-testid=sx-step]")).toContainText("Step 12 of");
    await expect(page.getByRole("tab")).toHaveText(["Formats"]);
    await expect(cell(page, "A1")).toHaveText("Default");
    await expect(page.locator(".sx-focus").first()).toBeVisible();

    await scrub.fill(String(max));
    await expect(page.locator("[data-testid=sx-step]")).toContainText("The finished sheet");
    await expect(page.getByRole("tab")).toHaveCount(4);

    // Play runs it from the start and can be paused
    const play = page.locator("[data-testid=sx-play]");
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-testid=sx-step]")).toContainText(/Step \d+ of/);
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "false");
  });

  test("Start sync sends the workbook and its settings, then follows the new sync", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await upload(page);
    await page.locator(".sx-title-input").fill("Q3 model");
    await page.locator("#sx-duration").selectOption("120");
    await expect(page.locator("[data-testid=sx-total]")).toHaveText("2 hr");
    await page.getByRole("button", { name: "Start sync" }).click();

    await expect(page.locator("[data-testid=sx-job-title]")).toHaveText("Building the sheet");
    expect(api.sheetStarts).toHaveLength(1);
    const sent = api.sheetStarts[0];
    expect(sent.name).toBe("Q3 model");
    expect(sent.targetMinutes).toBe(120);
    expect(sent.startInMinutes).toBe(0);
    expect(typeof sent.seed).toBe("number");
    expect(sent.workbook.sheets.map((s) => s.name)).toEqual(["Formats", "Data", "Hidden sheet", "Q'uote & co"]);
    const h15 = sent.workbook.sheets[0].cells.find((c) => c.r === 14 && c.c === 7)!;
    expect(h15.f).toBe("SUM(H12:H14)");

    // The sync is on the page and in the list, with its way into Google Sheets
    await expect(page.locator("header")).toContainText("Q3 model");
    await expect(page.locator(".sx-rail .ss-sync-item")).toContainText("Q3 model");
    await expect(page.locator(".sx-panel").getByRole("link", { name: "Open in Google Sheets" })).toHaveAttribute("href", "https://docs.google.com/spreadsheets/d/spreadsheet-1/edit");
    // Its page starts empty: nothing is built yet
    await expect(page.locator(".sx-text")).toHaveCount(0);

    // Back to the workbook, which is still there for another sync
    await page.getByRole("button", { name: "Back to the workbook" }).click();
    await expect(cell(page, "A1")).toHaveText("Default");
  });

  test("charts, filter buttons, conditional formatting and folded groups show as Google Sheets shows them", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await upload(page, FEATURES);
    // Five charts, each of its kind, where the workbook has them
    const charts = page.locator("[data-testid=sx-chart]");
    await expect(charts).toHaveCount(5);
    expect(await charts.evaluateAll((els) => els.map((e) => e.getAttribute("data-chart")))).toEqual(["COLUMN", "LINE", "PIE", "BAR", "SCATTER"]);
    await expect(page.getByRole("img", { name: "Chart: Units and price" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Chart: Units and price" }).locator("polyline")).toHaveCount(2);
    // The table's header row carries filter buttons
    await expect(page.locator(".sx-filter-btn")).toHaveCount(4);
    // The table's style is alternating colours, as Google Sheets imports it: a blue header with white words, every other row pale blue
    const bands = page.locator(".sx-cells .sx-fill[data-band]");
    await expect(bands).toHaveCount(7);
    expect(await bands.evaluateAll((els) => els.slice(0, 3).map((e) => getComputedStyle(e).backgroundColor))).toEqual(["rgb(79, 129, 189)", "rgb(219, 229, 241)", "rgb(255, 255, 255)"]);
    await expect(cell(page, "A1")).toHaveCSS("color", "rgb(255, 255, 255)");
    // A formula that named the table's columns reads cell ranges
    await clickCell(page, "A2");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".sx-namebox")).toHaveText("F1");
    await expect(page.locator("[data-testid=sx-formula]")).toHaveText("=SUM($D$2:$D$7)");

    await page.getByRole("tab", { name: "Rules" }).click();
    // Top three green and bold, the repeated and low values red: the rules, worked out from the values
    await expect(cell(page, "A5")).toHaveCSS("color", "rgb(0, 97, 0)");
    await expect(cell(page, "A5")).toHaveCSS("font-weight", "700");
    await expect(cell(page, "A2")).toHaveCSS("color", "rgb(156, 0, 6)");
    await expect(cell(page, "A8")).toHaveCSS("color", "rgb(156, 0, 6)");
    // Rows 9 to 11 are a folded group, row 14 is hidden: neither shows
    await expect(page.locator(".sx-rowhead", { hasText: /^8$/ })).toHaveCount(1);
    await expect(page.locator(".sx-rowhead", { hasText: /^10$/ })).toHaveCount(0);
    await expect(page.locator(".sx-rowhead", { hasText: /^14$/ })).toHaveCount(0);
    await expect(cell(page, "E3")).toHaveText("March 9, 2024");
    await expect(cell(page, "E5")).toHaveText("7 units");
    // An indent is room before the text
    await expect(cell(page, "E1")).toHaveCSS("padding-left", "21px");
    // What can't be carried over is said
    await expect(page.locator("[data-testid=sx-warnings]")).toContainText("Data bars and icon sets");
  });

  test("frozen rows and columns stay put while the rest scrolls", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await upload(page);
    const frozenRow = page.locator("[data-testid=sx-frozen-rows]");
    const frozenCol = page.locator("[data-testid=sx-frozen-cols]");
    await expect(frozenRow.locator('.sx-text[data-cell="C1"]')).toHaveText("TNR14bi");
    const before = (await frozenRow.locator('.sx-text[data-cell="C1"]').boundingBox())!;
    await page.locator(".sx-grid").evaluate((el) => { el.scrollTop = 600; el.scrollLeft = 40; });
    await expect.poll(async () => (await page.locator(".sx-grid").evaluate((el) => el.scrollTop))).toBe(600);
    // Row 1 is still at the top (it moved sideways with its columns, not down), column A still at the left
    const after = (await frozenRow.locator('.sx-text[data-cell="C1"]').boundingBox())!;
    expect(Math.round(after.y)).toBe(Math.round(before.y));
    expect(Math.round(after.x)).toBe(Math.round(before.x) - 40);
    const grid = (await page.locator(".sx-grid").boundingBox())!;
    const colA = (await frozenCol.locator('.sx-text[data-cell="A31"]').boundingBox())!;
    expect(colA.x).toBeGreaterThanOrEqual(grid.x + 46);
    expect(colA.x).toBeLessThan(grid.x + 46 + 40);
    // A click on the frozen row picks the cell shown there
    await page.mouse.click(after.x + 4, after.y + after.height / 2);
    await expect(page.locator(".sx-namebox")).toHaveText("C1");
  });

  test("a break placed before a section is part of the plan and of what Start sends", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await upload(page, FEATURES);
    const total = page.locator("[data-testid=sx-total]");
    // (the schedule is drawn afresh for each upload: a few minutes, give or take one)
    const minutes = Number(/^(\d+) min$/.exec((await total.textContent()) ?? "")?.[1]);
    expect(minutes).toBeGreaterThan(3);
    await page.getByRole("button", { name: "Add a break before section 2" }).click();
    await expect(page.locator("[data-testid=sx-break]")).toHaveCount(1);
    await expect(total).toHaveText(`${minutes + 15} min`);
    await page.getByLabel("Break before section 2", { exact: true }).selectOption("30");
    await expect(total).toHaveText(`${minutes + 30} min`);
    await page.getByRole("button", { name: "Add a break before section 3" }).click();
    await page.getByRole("button", { name: "Remove the break before section 3" }).click();
    await expect(page.locator("[data-testid=sx-break]")).toHaveCount(1);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect(page.locator("[data-testid=sx-job-title]")).toBeVisible();
    expect(api.sheetStarts[0].breaks).toEqual([{ section: 1, minutes: 30 }]);
  });

  test("a sync that had edits refused says which, and still shows as finished", async ({ app, page, api }) => {
    void app;
    const now = Date.now();
    api.jobs = [{ id: "sheet_r", userId: "user-1", kind: "sheet", documentId: "sheet-r", documentName: "Budget", status: "done", createdAt: now, startAt: now, finishedAt: now, currentAction: 10, totalActions: 10, charsSent: 10, totalChars: 10, activity: "Done", wpm: 0, baselineWordCount: 0, breaks: [], completedBreaks: [], lastUpdate: now, refused: { count: 2, notes: ["Number format on C3: Invalid number format pattern"] } }];
    await openSheets(page, api, "?job=sheet_r");
    await expect(page.locator("[data-testid=sx-job-title]")).toHaveText("Finished");
    await expect(page.locator("[data-testid=sx-refused]")).toContainText("Google Sheets refused 2 edits");
    await expect(page.locator("[data-testid=sx-refused]")).toContainText("Number format on C3");
  });

  test("a refused start says why and keeps the workbook", async ({ app, page, api }) => {
    void app;
    api.sheetStartFailure = { status: 503, error: "The Google Sheets API is turned off for this SyncStream deployment." };
    await openSheets(page, api);
    await upload(page);
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect(page.locator(".sx-panel [role=alert]")).toContainText("Google Sheets API is turned off");
    await expect(cell(page, "A1")).toHaveText("Default");
  });

  test("a file that isn't a workbook is refused in words", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await page.locator("[data-testid=sx-file]").setInputFiles({ name: "notes.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("just some text") });
    await expect(page.locator(".sx-upload-error")).toHaveText("This file isn't an Excel workbook (.xlsx).");
  });

  test("the workbook is still there after a reload", async ({ app, page, api }) => {
    void app;
    await openSheets(page, api);
    await upload(page);
    await expect(cell(page, "A1")).toHaveText("Default");
    // (the draft is written a moment after the upload)
    await expect.poll(() => page.evaluate(() => !!localStorage.getItem("syncstream_sheet_draft_v1"))).toBe(true);
    await page.reload();
    await expect(cell(page, "A1")).toHaveText("Default");
    await expect(page.locator("[data-testid=sx-stats]")).toHaveText("4 sheets · 202 cells · 20 formulas");
  });
});

test.describe("sync history", () => {
  const entries = () => {
    const now = Date.now();
    return [
      { id: "sync_a", kind: "doc", documentId: "doc-a", documentName: "Field notes", status: "done", createdAt: now - 3_600_000, startAt: now - 3_600_000, startedAt: now - 3_600_000, finishedAt: now - 1_800_000, totalChars: 900, charsSent: 900, words: 150 },
      { id: "sheet_b", kind: "sheet", documentId: "sheet-b", documentName: "Cap table", status: "cancelled", createdAt: now - 26 * 3_600_000, startAt: now - 26 * 3_600_000, startedAt: now - 26 * 3_600_000, finishedAt: now - 25 * 3_600_000, totalChars: 1000, charsSent: 400 },
    ];
  };

  test("the header's history button lists past syncs of both kinds, and one can be removed", async ({ app, page, api }) => {
    void app;
    api.history = entries();
    await openSheets(page, api);
    await page.getByRole("button", { name: "Sync history" }).click();
    const dialog = page.getByRole("dialog", { name: "Sync history" });
    await expect(dialog.locator(".ss-history-row")).toHaveCount(2);
    await expect(dialog.locator(".ss-history-day")).toHaveText(["Today", "Yesterday"]);
    await expect(dialog.locator(".ss-history-row").first()).toContainText("Field notes");
    await expect(dialog.locator(".ss-history-row").first()).toContainText("Finished");
    await expect(dialog.locator(".ss-history-row").first()).toContainText("150 words");
    await expect(dialog.getByRole("link", { name: "Open Cap table in Google Sheets" })).toHaveAttribute("href", "https://docs.google.com/spreadsheets/d/sheet-b/edit");
    await expect(dialog.getByRole("link", { name: "Open Field notes in Google Docs" })).toHaveAttribute("href", "https://docs.google.com/document/d/doc-a/edit");

    await dialog.getByRole("button", { name: "Sheets", exact: true }).click();
    await expect(dialog.locator(".ss-history-row")).toHaveCount(1);
    await dialog.getByRole("button", { name: "Remove Cap table from history" }).click();
    await expect(dialog.locator(".ss-history-row")).toHaveCount(0);
    expect(api.historyRemoved).toEqual(["sheet_b"]);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
  });

  test("the editor's History menu opens it, and its list keeps to document syncs", async ({ app, page, api }) => {
    api.history = entries();
    const now = Date.now();
    api.jobs = [{ id: "sheet_live", userId: "user-1", kind: "sheet", documentId: "sheet-live", documentName: "Budget build", status: "done", createdAt: now, startAt: now, finishedAt: now, currentAction: 10, totalActions: 10, charsSent: 10, totalChars: 10, activity: "Done", wpm: 0, baselineWordCount: 0, breaks: [], completedBreaks: [], lastUpdate: now }];
    await app.open();
    // A spreadsheet sync isn't something the document editor can show
    await expect(page.locator(".ss-sidebar")).not.toContainText("Budget build");
    await expect(page.locator(".ss-sidebar").getByRole("link", { name: "Excel sheet" })).toHaveAttribute("href", "/dashboard/sheets");
    await app.menu("History", "Sync history");
    const dialog = page.getByRole("dialog", { name: "Sync history" });
    await expect(dialog.locator(".ss-history-row")).toHaveCount(2);
    await dialog.getByRole("button", { name: "Clear history" }).click();
    await dialog.getByRole("button", { name: "Clear history" }).click();
    await expect(dialog.locator(".ss-history-empty")).toBeVisible();
    expect(api.historyRemoved).toEqual(["*"]);
  });
});
