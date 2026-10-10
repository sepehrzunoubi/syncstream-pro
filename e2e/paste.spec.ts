import { test, expect, CLOSING_TEXT } from "./fixtures";

/** Clipboard HTML as Google Docs writes it: a nested bulleted list with per-item styles */
const DOCS_LIST_HTML =
  `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-6b8f9d1a-7fff-1b2c-3d4e-5f6a7b8c9d0e">` +
  `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">` +
  `<li dir="ltr" style="list-style-type:disc;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="1">` +
  `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Pasted first</span></p></li>` +
  `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">` +
  `<li dir="ltr" style="list-style-type:circle;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="2">` +
  `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:700;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Pasted nested</span></p></li>` +
  `</ul>` +
  `<li dir="ltr" style="list-style-type:disc;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="1">` +
  `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Pasted third</span></p></li>` +
  `</ul></b>`;

/** A centred title and a justified, first-line-indented body, as Docs copies them */
const DOCS_PARAGRAPHS_HTML =
  `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-0a1b2c3d-7fff-4e5f-6a7b-8c9d0e1f2a3b">` +
  `<p dir="ltr" style="line-height:1.38;text-align: center;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:18pt;font-family:'Times New Roman',serif;color:#000000;background-color:transparent;font-weight:700;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Pasted Title</span></p>` +
  `<p dir="ltr" style="line-height:1.38;text-align: justify;text-indent: 36pt;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:'Times New Roman',serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Pasted justified body text.</span></p>` +
  `</b>`;

test.describe("pasting", () => {
  test("Docs HTML keeps list levels and inline formatting, and the pasted text glows", async ({ app, page }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.press("Enter");
    await app.paste({ html: DOCS_LIST_HTML, text: "Pasted first\nPasted nested\nPasted third" });
    await expect.poll(async () => (await app.paragraphs()).filter((p) => p.text.startsWith("Pasted")).map((p) => [p.text, p.list, p.level])).toEqual([
      ["Pasted first", "bullet", 0],
      ["Pasted nested", "bullet", 1],
      ["Pasted third", "bullet", 0],
    ]);
    await expect(app.doc.locator("p strong", { hasText: "Pasted nested" })).toHaveCount(1);
    expect((await app.pending()).join("")).toContain("Pasted firstPasted nestedPasted third");
  });

  test("Docs HTML paragraphs keep their own alignment and indent", async ({ app, page }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    await page.keyboard.press("Enter");
    await app.paste({ html: DOCS_PARAGRAPHS_HTML, text: "Pasted Title\nPasted justified body text." });
    const pasted = async () => (await app.paragraphs()).filter((p) => p.text.startsWith("Pasted"));
    await expect.poll(async () => (await pasted()).map((p) => [p.text, p.align])).toEqual([
      ["Pasted Title", "center"],
      ["Pasted justified body text.", "justify"],
    ]);
    const indent = await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll<HTMLElement>("p")).find((el) => el.textContent === "Pasted justified body text.")!;
      return parseFloat(getComputedStyle(p).textIndent);
    });
    expect(indent).toBeGreaterThan(0);
  });

  test("plain text takes the formatting of the paragraph it lands in", async ({ app, page }) => {
    await app.open();
    // A new numbered item after "Second piece", then plain lines pasted into it
    await app.caretAtEnd("Second piece, for strings");
    await page.keyboard.press("Enter");
    await app.paste({ text: "Plain one\nPlain two" });
    await expect.poll(async () => (await app.paragraphs()).filter((p) => p.text.startsWith("Plain")).map((p) => [p.text, p.list, p.label])).toEqual([
      ["Plain one", "ordered", "3."],
      ["Plain two", "ordered", "4."],
    ]);
    // Into a heading, plain text stays a heading
    await app.caretAtEnd("Program");
    await app.paste({ text: " notes" });
    await expect.poll(async () => (await app.paragraphs()).find((p) => p.text === "Program notes")?.style).toBe("h2");
  });
});
