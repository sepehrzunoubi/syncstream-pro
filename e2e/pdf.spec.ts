import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, CLOSING_TEXT, DOC, FIXTURE_DOC_ID, FIXTURE_DOC_NAME, tabContent, type App } from "./fixtures";
import { importPdfForEditor, type PdfImportBody } from "../src/lib/pdf-route";

// Import PDF: a PDF read on the server comes onto the page as new text, glowing, with the PDF's page
// setup and header on a blank page; a page with content gets a new Google Doc, the PDF after what's
// there, or the PDF in its place (asked twice). The route is faked here with what the real reader
// makes of the fixture PDFs, its images served as the image route serves them.

const FIXTURES = path.join(process.cwd(), "fixtures", "pdf");
/** Where the route says the stored images are (the deployment's own address; any https one does here) */
const IMAGES = "https://images.e2e.test";
const bytesOf = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.pdf`));

interface Served { body: PdfImportBody; images: Map<string, { mime: string; data: Buffer }> }
const served = new Map<string, Promise<Served>>();
/** What /api/pdf/import answers for a fixture PDF: the real reader's result, images stored */
function readFixture(name: string): Promise<Served> {
  if (!served.has(name)) {
    served.set(name, (async () => {
      const images = new Map<string, { mime: string; data: Buffer }>();
      const reply = await importPdfForEditor(new Uint8Array(bytesOf(name)), {
        baseUrl: IMAGES,
        store: async (mime, base64) => { const id = `e2e-${name}-${images.size + 1}-img000000`; images.set(id, { mime, data: Buffer.from(base64, "base64") }); return id; },
      });
      if (!reply.ok) throw new Error(`${name}: ${reply.body.error}`);
      return { body: reply.body, images };
    })());
  }
  return served.get(name)!;
}

/** The text of the PDF's paragraphs, as the page shows them */
const textsOf = (body: PdfImportBody): string[] => {
  const text = (n: { type: string; text?: string; content?: unknown[] }): string => (n.type === "text" ? n.text ?? "" : ((n.content ?? []) as typeof n[]).map(text).join(""));
  return body.nodes.flatMap((n) => (n.type === "table" ? [] : [text(n as never)])).filter((t) => t.trim());
};

/**
 * Fake the import route (and the image route for its images). Registered after the app opens, so it
 * comes before the fake Google. Records what was sent; `reply` and `delay` can be changed on the way.
 */
async function fakeImport(page: Page, first: { status?: number; body: unknown; images?: Served["images"] }) {
  const fake = { reply: first, delay: 0, calls: [] as { type: string; bytes: number }[] };
  await page.route(/\/api\/(pdf\/import|images\/[\w-]+)$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/images/")) {
      const img = fake.reply.images?.get(url.pathname.split("/").pop()!);
      return img ? route.fulfill({ status: 200, contentType: img.mime, body: img.data }) : route.fulfill({ status: 404, body: "" });
    }
    fake.calls.push({ type: route.request().headers()["content-type"] ?? "", bytes: route.request().postDataBuffer()?.length ?? 0 });
    const { status = 200, body } = fake.reply;
    if (fake.delay) await new Promise((r) => setTimeout(r, fake.delay));
    // (a read cancelled meanwhile has no one to answer)
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
  });
  return fake;
}

/** Google makes headers and footers with ids of their own: this fake hands them out */
async function headersMade(app: App) {
  let n = 0;
  await app.page.route(/\/api\/docs\/edit$/, async (route) => {
    const body = route.request().postDataJSON() as { requests: Record<string, unknown>[] };
    const makes = body.requests.some((r) => "createHeader" in r || "createFooter" in r);
    if (!makes) return route.fallback();
    app.api.edits.push(body as never);
    const replies = body.requests.map((r) => ("createHeader" in r ? { createHeader: { headerId: `kix.hdr${++n}` } } : "createFooter" in r ? { createFooter: { footerId: `kix.ftr${++n}` } } : {}));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revisionId: `made-rev-${n}`, replies }) });
  });
}

/** The new text on the page, run after run (a page break shows as its label), as one string */
const pendingText = async (app: App) => (await app.pending()).filter((t) => t !== "Page break").join("");
const pdfText = (body: PdfImportBody) => textsOf(body).join("");

const dialog = (page: Page) => page.getByRole("dialog");
const panel = (page: Page) => page.getByRole("complementary", { name: "Sync settings" });
/** The snackbar saying the PDF came in (the one before it may still be leaving) */
const snackbar = (page: Page) => page.locator(".ss-snackbar", { hasText: "PDF imported" });

async function choosePdf(page: Page, name: string, fileName = `${name}.pdf`) {
  await dialog(page).locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: bytesOf(name) });
}

test.describe("Import PDF", () => {
  test("a blank doc: the card opens it, and the PDF goes straight onto the page with its page setup and header; Undo puts it all back", async ({ app, page, api }) => {
    api.content = tabContent([""]);
    await app.open({ named: false });
    const pdf = await readFixture("headerfooter-tagged");
    const { calls } = await fakeImport(page, pdf);
    await headersMade(app);

    const card = panel(page).getByRole("region", { name: "Start from a PDF" });
    await expect(card).toContainText("Rebuild a PDF here");
    await card.getByRole("button", { name: "Import PDF" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("Drop a PDF here or choose a file");
    await expect(dialog(page)).toContainText("PDF, up to 4 MB");
    await choosePdf(page, "headerfooter-tagged", "Project Atlas.pdf");

    await expect(dialog(page)).toContainText("3 pages · 3 paragraphs");
    await expect(dialog(page)).toContainText("Arial");
    await expect(dialog(page)).toContainText("A4 · 2 cm top and bottom, 2.5 cm sides");
    await expect(dialog(page)).toContainText("Header on every page");
    await expect(dialog(page)).toContainText("This doc is empty");
    expect(calls).toEqual([{ type: "application/pdf", bytes: bytesOf("headerfooter-tagged").length }]);
    await dialog(page).getByRole("button", { name: "Put it on the page" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => pendingText(app)).toBe(pdfText(pdf.body));
    await expect(snackbar(page)).toContainText("PDF imported. Check it over, then start the sync.");
    await expect(page.getByRole("button", { name: "Start sync" })).toBeEnabled();
    // With something on the page, the card steps back to a line
    await expect(card).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "Import PDF" })).toBeVisible();
    // The PDF's paper and margins went to the Google Doc, as Page setup sends them
    await expect.poll(() => api.requests("updateDocumentStyle").length).toBeGreaterThanOrEqual(1);
    const style = api.requests("updateDocumentStyle")[0] as { documentStyle: { pageSize?: { width: { magnitude: number } }; marginTop?: { magnitude: number } } };
    expect(Math.round(style.documentStyle.pageSize!.width.magnitude)).toBe(595);
    expect(style.documentStyle.marginTop!.magnitude).toBeCloseTo(56.7, 1);
    // Its header, made and written straight into it
    await expect.poll(() => api.requests("createHeader").length).toBe(1);
    await expect.poll(() => (api.requests("insertText") as { text: string; location: { segmentId?: string } }[]).find((r) => r.location.segmentId === "kix.hdr1")?.text).toContain("Project Atlas");
    await expect(page.locator(".ss-hf").first()).toContainText("Project Atlas");
    // The caret is at the start of the PDF, on the page
    expect(await page.evaluate(() => window.ssEditor!.isFocused)).toBe(true);
    // Nothing else changed since: Undo takes it off the page, with its setup and header
    await snackbar(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => app.text()).toBe("");
    await expect.poll(() => api.requests("deleteHeader").length).toBe(1);
    await expect.poll(() => api.requests("updateDocumentStyle").length).toBe(2);
    await expect(page.locator(".ss-hf", { hasText: "Project Atlas" })).toHaveCount(0);
    // An empty page again: the card is back up front
    await expect(card).toBeVisible();
  });

  test("a doc with content: three choices, a new Google Doc first; Add after what's here keeps every word and adds the PDF as new text", async ({ app, page, api }) => {
    await app.open();
    const before = await app.text();
    const pdf = await readFixture("images-tagged");
    await fakeImport(page, pdf);
    await app.menu("File", "Import PDF…");
    await choosePdf(page, "images-tagged", "Quarterly report.pdf");

    const choices = dialog(page).getByRole("group", { name: "Where should it go?" }).getByRole("radio");
    await expect(choices).toHaveCount(3);
    await expect(dialog(page).locator(".ss-pdf-choice-title")).toHaveText(["New Google Doc for this PDFRecommended", "Add after what's here", "Replace what's here"]);
    await expect(choices.first()).toBeChecked();
    await expect(dialog(page)).toContainText("A new doc named “Quarterly report”");
    await expect(dialog(page).getByRole("button", { name: "Create and import" })).toBeVisible();
    await dialog(page).getByText("Add after what's here").click();
    await expect(choices.nth(1)).toBeChecked();
    await dialog(page).getByRole("button", { name: "Add it" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => pendingText(app)).toBe(pdfText(pdf.body));
    // Its images, from where the route stored them, drawn on the page
    const images = page.locator(`${DOC} img[src^="${IMAGES}/api/images/"]`);
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth > 0))).toEqual([true, true]);
    const after = await app.text();
    expect(after.startsWith(before)).toBe(true);
    // Nothing of the document is deleted or restyled, and its page setup stays
    await page.waitForTimeout(1200);
    expect(api.kinds().filter((k) => k === "deleteContentRange" || k === "updateDocumentStyle")).toEqual([]);
    await snackbar(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => app.pending()).toEqual([]);
    expect(await app.text()).toBe(before);
  });

  test("Replace what's here asks again, then the page holds only the PDF and the save deletes the rest", async ({ app, page, api }) => {
    await app.open();
    const pdf = await readFixture("headerfooter-untagged");
    await fakeImport(page, pdf);
    await headersMade(app);
    await panel(page).getByRole("button", { name: "Import PDF" }).click();
    await choosePdf(page, "headerfooter-untagged");
    await dialog(page).getByText("Replace what's here").click();
    await dialog(page).getByRole("button", { name: "Replace…" }).click();
    await expect(page.getByRole("dialog", { name: "Replace what's here?" })).toContainText("This deletes everything in this document from Google Docs now. The PDF's content is then typed in by the sync.");
    // Back changes nothing
    await dialog(page).getByRole("button", { name: "Back" }).click();
    await expect(dialog(page).getByRole("group", { name: "Where should it go?" })).toBeVisible();
    await expect(dialog(page).getByRole("radio").nth(2)).toBeChecked();
    expect(api.edits.length).toBe(0);
    await dialog(page).getByRole("button", { name: "Replace…" }).click();
    await dialog(page).getByRole("button", { name: "Replace", exact: true }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => pendingText(app)).toBe(pdfText(pdf.body));
    // (page breaks are leaves of their own)
    expect((await app.text()).replace(/[\n\uFFFC]/g, "")).toBe(pdfText(pdf.body));
    await expect(app.doc).not.toContainText(FIXTURE_DOC_NAME);
    await expect.poll(() => api.kinds().includes("deleteContentRange")).toBe(true);
    await expect.poll(() => api.requests("updateDocumentStyle").length).toBe(1);
    // The fixture has no header: the PDF's is made
    await expect.poll(() => api.requests("createHeader").length).toBe(1);
    // What was deleted in Google Docs can't be undone from here
    await expect(snackbar(page)).toBeVisible();
    await expect(snackbar(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  });

  test("New Google Doc for this PDF: made, named after the file, opened, given the PDF's page setup and content; the open doc is left alone", async ({ app, page, api }) => {
    await app.open();
    const pdf = await readFixture("headerfooter-tagged");
    await fakeImport(page, pdf);
    await headersMade(app);
    await app.menu("File", "Import PDF…");
    await choosePdf(page, "headerfooter-tagged", "Project Atlas.pdf");
    await dialog(page).getByRole("button", { name: "Create and import" }).click();

    await expect(dialog(page)).toHaveCount(0, { timeout: 10_000 });
    // Made with the PDF's name in the one request: no rename after
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]).toMatchObject({ title: "Project Atlas" });
    expect(api.renames).toEqual([]);
    await expect(page.locator("header .ss-title")).toContainText("Project Atlas");
    await expect.poll(() => pendingText(app)).toBe(pdfText(pdf.body));
    await expect(app.doc).not.toContainText(FIXTURE_DOC_NAME);
    // Every change went to the new document, none to the one that was open
    await expect.poll(() => api.requests("updateDocumentStyle").length).toBe(1);
    await expect.poll(() => api.requests("createHeader").length).toBe(1);
    expect(api.edits.map((e) => e.documentId).filter((id) => id === FIXTURE_DOC_ID)).toEqual([]);
    await expect(snackbar(page)).toContainText("PDF imported. Check it over, then start the sync.");
  });

  test("what can't be imported says why, and Cancel while it is read leaves everything as it was", async ({ app, page }) => {
    await app.open();
    const fake = await fakeImport(page, { status: 422, body: { error: "This PDF is protected with a password. Remove the password, then import it again.", code: "encrypted" } });
    await panel(page).getByRole("button", { name: "Import PDF" }).click();
    // Too large, or not a PDF: refused before anything is sent
    await dialog(page).locator('input[type="file"]').setInputFiles({ name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(5 * 1024 * 1024, 32) });
    await expect(dialog(page).getByRole("alert")).toContainText("This PDF is 5 MB. You can import a PDF of up to 4 MB");
    await dialog(page).locator('input[type="file"]').setInputFiles({ name: "notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK") });
    await expect(dialog(page).getByRole("alert")).toContainText("That isn't a PDF.");
    expect(fake.calls.length).toBe(0);
    // The reader's own reason
    await choosePdf(page, "encrypted");
    await expect(dialog(page).getByRole("alert")).toHaveText("This PDF is protected with a password. Remove the password, then import it again.");
    await expect(dialog(page)).toContainText("Drop a PDF here");
    // Esc closes it
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);

    // A slow read: the steps show, and Cancel goes back with nothing changed
    fake.reply = await readFixture("styles-tagged");
    fake.delay = 4000;
    const text = await app.text();
    await panel(page).getByRole("button", { name: "Import PDF" }).click();
    await choosePdf(page, "styles-tagged");
    const steps = dialog(page).getByRole("list", { name: "Reading the PDF" });
    await expect(steps).toContainText("Reading text and fonts");
    await expect(steps.locator('li[aria-current="step"]')).toHaveCount(1);
    await expect(steps).toContainText("Copying images");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toContainText("Drop a PDF here or choose a file");
    await expect(steps).toHaveCount(0);
    await page.waitForTimeout(4500);
    await expect(dialog(page)).toContainText("Drop a PDF here or choose a file");
    expect(await app.text()).toBe(text);
    expect(await app.pending()).toEqual([]);
  });

  test("it waits while there's no document, and while a sync types into this one", async ({ app, page, api }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.type(" And one more line.");
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => api.starts.length).toBe(1);
    await page.getByRole("button", { name: "Back to editing" }).click();
    const button = panel(page).getByRole("button", { name: "Import PDF" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", "A sync is typing into this document. You can import a PDF when it finishes.");
    await page.locator(".ss-menubar-trigger", { hasText: "File" }).click();
    await expect(page.getByRole("menuitem", { name: "Import PDF…" })).toHaveAttribute("data-disabled", "");
    await page.keyboard.press("Escape");
  });

  test("with no document open, the card says to open one first", async ({ app, page }) => {
    await app.open({ plain: [{ type: "paragraph", content: [{ type: "text", text: "A draft before any doc." }] }] });
    const button = panel(page).getByRole("button", { name: "Import PDF" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", "Open or make a Google Doc first");
  });
});
