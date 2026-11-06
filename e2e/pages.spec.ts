import { test, expect, CLOSING_TEXT, LONG_BODY, plainParagraphs, DOC } from "./fixtures";
import { importDoc } from "../src/lib/doc-import";
import { EMPTY_DOC } from "./fixtures/empty-doc";

/** Rectangles of every paragraph and every page sheet, to check how the text sits on the pages */
async function layout(page: import("@playwright/test").Page) {
  return page.evaluate((sel) => {
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
    return {
      // The pages are drawn at the "fit" zoom: declared gap heights are in unzoomed CSS px
      zoom: parseFloat(getComputedStyle(document.querySelector(".ss-pages")!).zoom) || 1,
      sheets: Array.from(document.querySelectorAll(".ss-sheet")).map(rect),
      paragraphs: Array.from(document.querySelectorAll(`${sel} > p`)).map((p) => ({ ...rect(p), text: (p.textContent ?? "").slice(0, 20) })),
      gaps: Array.from(document.querySelectorAll(`${sel} .ss-page-gap`)).map((g) => ({ ...rect(g), declared: Number((g as HTMLElement).dataset.gap), tag: g.tagName })),
    };
  }, DOC);
}

/** A plain 40-row table typed without a document: taller than a page */
function tallTable(rows: number) {
  const para = (t: string) => ({ type: "paragraph", attrs: {}, content: [{ type: "text", text: t }] });
  return {
    type: "table",
    attrs: { tid: "t1", span: 1 },
    content: Array.from({ length: rows }, (_, r) => ({
      type: "tableRow",
      attrs: { rid: `r${r}`, span: 1 },
      content: [0, 1].map((c) => ({ type: "tableCell", attrs: { cid: `r${r}c${c}`, span: 1 }, content: [para(`Row ${r + 1}, cell ${c + 1}`)] })),
    })),
  };
}

test.describe("pages", () => {
  test("a long draft flows onto several pages with no text in the margins and gaps that match", async ({ app, page }) => {
    await app.open({ plain: plainParagraphs(Array.from({ length: 12 }, (_, i) => `${i + 1}. ${LONG_BODY}`)) });
    await expect.poll(() => app.sheets()).toBeGreaterThanOrEqual(2);
    // Give the measuring plugin a settled layout before reading rectangles
    await expect.poll(async () => (await layout(page)).gaps.length).toBe((await app.sheets()) - 1);
    const { sheets, paragraphs, gaps, zoom } = await layout(page);
    expect(paragraphs).toHaveLength(12);
    // Letter paper: a 1in margin is 1/11 of the sheet's height
    const margin = sheets[0].height / 11;
    for (const p of paragraphs) {
      const sheet = sheets.find((s) => p.top >= s.top - 1 && p.top <= s.bottom + 1);
      expect(sheet, `${p.text} starts on a page`).toBeTruthy();
      expect(p.top, `${p.text} is below the top margin`).toBeGreaterThanOrEqual(sheet!.top + margin - 1);
      // A paragraph that crosses pages is split by a gap inside it; otherwise it ends above the bottom margin
      const crosses = gaps.some((g) => g.top > p.top && g.bottom < p.bottom);
      if (!crosses) expect(p.bottom, `${p.text} ends above the bottom margin`).toBeLessThanOrEqual(sheet!.bottom - margin + 1);
    }
    // Paragraphs never overlap
    for (let i = 1; i < paragraphs.length; i++) expect(paragraphs[i].top).toBeGreaterThanOrEqual(paragraphs[i - 1].bottom - 1);
    // Each gap spans from one page's bottom margin to the next page's top margin
    for (let k = 0; k < gaps.length; k++) {
      const g = gaps[k];
      expect(g.height).toBeCloseTo(g.declared * zoom, 0);
      const expected = sheets[k + 1].top + margin - (sheets[k].bottom - margin);
      expect(g.height).toBeGreaterThanOrEqual(expected - 1);
      expect(g.height).toBeLessThanOrEqual(expected + sheets[0].height / 11 + 1); // plus at most one line that did not fit
    }
  });

  test("double-spaced text flows onto pages and every line stays inside the margins", async ({ app, page }) => {
    await app.open({ plain: Array.from({ length: 16 }, (_, i) => ({ type: "paragraph", attrs: { lineSpacing: 200 }, content: [{ type: "text", text: `${i + 1}. ${LONG_BODY}` }] })) });
    await expect.poll(() => app.sheets()).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => (await layout(page)).gaps.length).toBe((await app.sheets()) - 1);
    const { sheets, lines } = await page.evaluate((sel) => {
      const rect = (r: DOMRect) => ({ top: r.top, bottom: r.bottom });
      const out: { top: number; bottom: number }[] = [];
      for (const p of Array.from(document.querySelectorAll(`${sel} > p`))) {
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(t);
          out.push(...Array.from(range.getClientRects()).map(rect));
        }
      }
      return { sheets: Array.from(document.querySelectorAll(".ss-sheet")).map((s) => rect(s.getBoundingClientRect())), lines: out };
    }, DOC);
    const margin = (sheets[0].bottom - sheets[0].top) / 11;
    // Lines by where they sit (a line can come as more than one rectangle)
    const onPage = sheets.map(() => new Set<number>());
    for (const l of lines) {
      const k = sheets.findIndex((s) => l.top >= s.top && l.top < s.bottom);
      expect(k, "a line on a page").toBeGreaterThanOrEqual(0);
      expect(l.top).toBeGreaterThanOrEqual(sheets[k].top + margin - 1);
      expect(l.bottom).toBeLessThanOrEqual(sheets[k].bottom - margin + 1);
      onPage[k].add(Math.round(l.top));
    }
    // Docs keeps a line on a page when its top and its text's natural height (12.64pt) fit: 26 double-spaced
    // Arial 11 lines (25.28pt apart) on a 648pt page
    expect(onPage[0].size).toBe(26);
  });

  test("a table taller than a page breaks between rows", async ({ app, page }) => {
    await app.open({ plain: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "Before the table" }] }, tallTable(45), { type: "paragraph", attrs: {}, content: [{ type: "text", text: "After the table" }] }] });
    await expect.poll(() => app.sheets()).toBeGreaterThanOrEqual(2);
    const rowGaps = app.doc.locator("tr.ss-page-gap");
    await expect.poll(() => rowGaps.count()).toBeGreaterThanOrEqual(1);
    // Every real row sits whole on one page: none straddles a gap row
    const straddling = await page.evaluate((sel) => {
      const gaps = Array.from(document.querySelectorAll(`${sel} tr.ss-page-gap`)).map((g) => g.getBoundingClientRect());
      return Array.from(document.querySelectorAll(`${sel} tr:not(.ss-page-gap)`)).filter((tr) => {
        const r = tr.getBoundingClientRect();
        return gaps.some((g) => r.top < g.top && r.bottom > g.bottom);
      }).length;
    }, DOC);
    expect(straddling).toBe(0);
    await expect(app.doc.locator("tr:not(.ss-page-gap)")).toHaveCount(45);
  });

  // A filler paragraph whose space above puts what follows near the end of the first page (a 9in text area)
  const filler = (above: number) => ({ type: "paragraph", attrs: { box: { start: 0, first: 0, above, below: 0 } }, content: [{ type: "text", text: "Filler" }] });
  const para = (text: string, attrs: Record<string, unknown> = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] });
  /** Each paragraph's sheet and where its border box starts below the sheet's text area, in pt */
  const placed = (page: import("@playwright/test").Page) => page.evaluate((sel) => {
    const zoom = parseFloat(getComputedStyle(document.querySelector(".ss-pages")!).zoom) || 1;
    const sheets = Array.from(document.querySelectorAll(".ss-sheet")).map((s) => s.getBoundingClientRect());
    return Array.from(document.querySelectorAll<HTMLElement>(`${sel} > p`)).map((p) => {
      const top = p.getBoundingClientRect().top;
      const k = sheets.findIndex((s) => top >= s.top && top < s.bottom);
      // Letter paper, 1in margins: the text area starts 96px down the sheet
      return { text: p.textContent, sheet: k, below: k < 0 ? NaN : Math.round(((top - sheets[k].top) / zoom - 96) * 0.75 * 10) / 10 };
    });
  }, DOC);

  test("a paragraph moved to a new page keeps its space above there, as Docs does", async ({ app, page }) => {
    // The heading (20pt above, a 26pt line) doesn't fit after 600pt and a line of filler
    await app.open({ plain: [filler(600), para("Heading pushed down", { styleName: "h1" }), para("Text after it")] });
    await expect.poll(() => app.sheets()).toBe(2);
    await expect.poll(async () => (await placed(page)).map((p) => p.sheet)).toEqual([0, 1, 1]);
    const [first, heading] = await placed(page);
    // Space above stays at the top of a page, the first page's too
    expect(Math.abs(first.below - 600)).toBeLessThanOrEqual(1);
    expect(Math.abs(heading.below - 20)).toBeLessThanOrEqual(1);
  });

  test("a heading keeps with the next paragraph as its style says, unless it says otherwise itself", async ({ app, page }) => {
    // After 577pt and a line of filler the heading fits at the end of the page, the text after it doesn't
    await app.open({ plain: [filler(577), para("Heading made here", { styleName: "h1" }), para("Text after it")] });
    await expect.poll(() => app.sheets()).toBe(2);
    // A heading with no keep options of its own has its style's: Docs' headings keep with the next paragraph
    await expect.poll(async () => (await placed(page)).map((p) => p.sheet)).toEqual([0, 1, 1]);
    expect(Math.abs((await placed(page))[1].below - 20)).toBeLessThanOrEqual(1);
    // The menu says so, and turning it off there leaves the heading where it fits
    await app.caretBefore("Heading made here");
    await page.locator(".ss-menubar-trigger", { hasText: "Format" }).click();
    await page.getByRole("menuitem").filter({ has: page.getByText("Line & paragraph spacing", { exact: true }) }).hover();
    const keepNext = page.getByRole("menuitem").filter({ has: page.getByText("Keep with next", { exact: true }) });
    await expect(keepNext.locator(".ss-check > *")).toHaveCount(1);
    await keepNext.click();
    await expect.poll(async () => (await placed(page)).map((p) => p.sheet)).toEqual([0, 0, 1]);
    // Its own options now: lines together still, as its style had them
    await expect(app.doc.locator("p[data-keep]")).toHaveAttribute("data-keep", "lines");
  });

  test("Ctrl+Enter inserts a page break and the text after it starts a new page", async ({ app, page }) => {
    // The split must land exactly at the caret, in the same transaction as the break
    await app.open();
    const before = await app.sheets();
    await app.caretBefore("thoughts on the whole program.");
    await page.keyboard.press("Control+Enter");
    await expect(app.doc.locator("span[data-page-break]")).toHaveCount(2);
    await expect.poll(async () => (await app.paragraphs()).slice(-2).map((p) => p.text)).toEqual(["Closing Page break", "thoughts on the whole program."]);
    await expect.poll(() => app.sheets()).toBe(before + 1);
    const { sheets, paragraphs } = await layout(page);
    const moved = paragraphs.find((p) => p.text.startsWith("thoughts on the"))!;
    expect(moved.top).toBeGreaterThanOrEqual(sheets[sheets.length - 1].top);
    // The break is new text: it is pending, like what was typed, and nothing was saved
    await expect.poll(() => page.locator(`${DOC} .ss-add span[data-page-break]`).count()).toBe(1);
  });

  test("Insert > Break > Page break from the menu adds a pending page break", async ({ app, page, api }) => {
    await app.open();
    await app.caretAtEnd(CLOSING_TEXT);
    await page.locator(".ss-menubar-trigger", { hasText: "Insert" }).click();
    await page.getByRole("menuitem").filter({ has: page.getByText("Break", { exact: true }) }).hover();
    await page.getByRole("menuitem").filter({ has: page.getByText("Page break", { exact: true }) }).click();
    await expect(app.doc.locator("span[data-page-break]")).toHaveCount(2);
    // New structure glows like new text and waits for a sync: nothing is saved
    await expect.poll(() => page.locator(`${DOC} .ss-add span[data-page-break]`).count()).toBe(1);
    await page.keyboard.type("On the next page.");
    await expect(app.subtitle()).toHaveText("New text glows. Start sync types it in.");
    expect((await app.pending()).join("")).toContain("On the next page.");
    expect(api.edits).toEqual([]);
  });

  test("File > Page setup > Pageless shows one continuous sheet with page breaks as labels", async ({ app, page, api }) => {
    await app.open();
    await expect.poll(() => app.sheets()).toBeGreaterThanOrEqual(2);
    await app.menu("File", "Page setup");
    const dialog = page.getByRole("dialog", { name: "Page setup" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "Pageless" }).click();
    await dialog.getByRole("button", { name: "OK" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".ss-pages")).toHaveClass(/ss-pageless/);
    await expect(page.locator(".ss-sheet")).toHaveCount(1);
    await expect(app.doc.locator(".ss-page-break-label")).toBeVisible();
    // Paper and margins didn't change: only the format is written to Google Docs
    await expect.poll(() => api.edits.length).toBe(1);
    expect(api.edits[0].requests).toEqual([{ updateDocumentStyle: { documentStyle: { documentFormat: { documentMode: "PAGELESS" } }, fields: "documentFormat.documentMode" } }]);
    expect(await app.text()).toContain(CLOSING_TEXT);
  });

  test("a pageless Google Doc opens as one continuous sheet", async ({ app, page, api }) => {
    api.content = { ...api.content, pageless: true };
    await app.open();
    await expect(page.locator(".ss-pages")).toHaveClass(/ss-pageless/);
    await expect(page.locator(".ss-sheet")).toHaveCount(1);
  });
});

test.describe("lines as Docs draws them", () => {
  test("a document in another font spaces its lines by that font's line height", async ({ app, api, page }) => {
    // A Word document's Calibri (drawn in Carlito, which has its metrics): taller lines than Arial's
    const doc = structuredClone(EMPTY_DOC);
    doc.namedStyles.styles[0].textStyle.weightedFontFamily = { fontFamily: "Calibri", weight: 400 };
    api.content = importDoc(doc as never);
    api.revision = api.content.revisionId;
    await app.open({ named: false });
    await page.evaluate(() => window.ssEditor!.chain().focus().insertContent("Text in the document's own font").run());
    const got = await page.evaluate((sel) => {
      const p = document.querySelector<HTMLElement>(`${sel} > p`)!;
      // The font's natural line height, at a size where the browser's rounding to whole pixels costs nothing
      const probe = document.createElement("div");
      probe.style.cssText = `position:absolute;font-size:10000px;line-height:normal;white-space:nowrap;font-family:${getComputedStyle(p).fontFamily}`;
      probe.textContent = "Hg";
      document.body.appendChild(probe);
      const natural = probe.getBoundingClientRect().height / 10000;
      probe.remove();
      return { lineHeight: parseFloat(getComputedStyle(p).lineHeight), fontSize: parseFloat(getComputedStyle(p).fontSize), natural, nlh: parseFloat(getComputedStyle(p).getPropertyValue("--ss-nlh")) };
    }, DOC);
    expect(got.natural).toBeGreaterThan(1.2);
    // Measured to the fourth decimal (Calibri's is 1.2207: 1.22 would cost 0.05% a line)
    expect(Math.abs(got.nlh - got.natural)).toBeLessThan(0.00006);
    expect(Math.abs(got.lineHeight - 1.15 * got.natural * got.fontSize)).toBeLessThan(0.02);
  });

  test("items of a list leave out the space between them unless their spacing mode keeps it, as Docs does", async ({ app, page }) => {
    const item = (text: string, spacingMode?: string) => ({ type: "paragraph", attrs: { list: "bullet", level: 0, box: { start: 36, marker: -18, above: 0, below: 12 }, ...(spacingMode ? { spacingMode } : {}) }, content: [{ type: "text", text }] });
    const para = (text: string) => ({ type: "paragraph", attrs: {}, content: [{ type: "text", text }] });
    await app.open({ plain: [item("Tight one"), item("Tight two"), para("Between"), item("Kept one", "NEVER_COLLAPSE"), item("Kept two", "NEVER_COLLAPSE"), para("After")] });
    const gaps = await page.evaluate((sel) => {
      const zoom = parseFloat(getComputedStyle(document.querySelector(".ss-pages")!).zoom) || 1;
      const ps = Array.from(document.querySelectorAll(`${sel} > p`)).map((p) => p.getBoundingClientRect());
      return ps.slice(1).map((r, i) => Math.round(((r.top - ps[i].bottom) / zoom) * 0.75 * 10) / 10);
    }, DOC);
    // A list's last item keeps its space below: what follows is not an item of the list
    expect(gaps).toEqual([0, 12, 0, 12, 12]);
  });

  test("text spaced wider than single sits where a single-spaced line's does, the extra space below it", async ({ app, page }) => {
    const para = (text: string, lineSpacing: number) => ({ type: "paragraph", attrs: { lineSpacing }, content: [{ type: "text", text }] });
    await app.open({ plain: [para("Single", 115), para("Double", 200), para("One and a half", 150), para("Single again", 115)] });
    const got = await page.evaluate((sel) => {
      const zoom = parseFloat(getComputedStyle(document.querySelector(".ss-pages")!).zoom) || 1;
      return Array.from(document.querySelectorAll<HTMLElement>(`${sel} > p`)).map((p) => {
        const range = document.createRange();
        range.selectNodeContents(p.firstChild!);
        const text = range.getClientRects()[0];
        const box = p.getBoundingClientRect();
        // Where the paragraph is laid out: as drawn, less how far it is drawn above that
        const shift = (parseFloat(getComputedStyle(p).top) || 0) * zoom;
        return { textTop: text.top / zoom, top: (box.top - shift) / zoom, bottom: (box.bottom - shift) / zoom };
      });
    }, DOC);
    // Text below the top of its line by as much as single-spaced text is, whatever the spacing
    const single = got[0].textTop - got[0].top;
    for (const p of got) expect(Math.abs(p.textTop - p.top - single), JSON.stringify(got)).toBeLessThanOrEqual(0.6);
    // Laid out as before: each paragraph starts where the one above ends, the double-spaced one twice as tall
    for (let i = 1; i < got.length; i++) expect(Math.abs(got[i].top - got[i - 1].bottom)).toBeLessThanOrEqual(0.6);
    expect((got[1].bottom - got[1].top) / (got[0].bottom - got[0].top)).toBeCloseTo(200 / 115, 1);
  });

  test("text kerns the pairs inside a word but not a pair with a space, as Docs does", async ({ app, page }) => {
    const text = "Tavily A round";
    const tnr = [{ type: "textStyle", attrs: { fontFamily: "Times New Roman" } }];
    await app.open({ plain: [{ type: "paragraph", content: [{ type: "text", text }] }, { type: "paragraph", content: [{ type: "text", text, marks: tnr }] }] });
    await page.evaluate(async () => { await document.fonts.load('11pt "SS Space Arial"', " "); await document.fonts.load('11pt "SS Space Times New Roman"', " "); await document.fonts.ready; });
    const got = await page.evaluate(({ sel, text }) => {
      const pages = document.querySelector<HTMLElement>(".ss-pages")!;
      const stacks = ['Arial, Arimo, "Liberation Sans", sans-serif', '"Times New Roman", Tinos, "Liberation Serif", serif'];
      return Array.from(document.querySelectorAll(`${sel} > p`)).map((p, i) => {
        const node = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode() as Text;
        const width = (from: number, to: number) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect().width; };
        // The same text in the same font, beside the page and at its zoom, kerned or not, with no space face
        const ref = (s: string, kerning: string) => {
          const el = document.createElement("span");
          el.style.cssText = `position:absolute;white-space:pre;font-variant-ligatures:none;font-size:${getComputedStyle(node.parentElement!).fontSize};font-family:${stacks[i]};font-kerning:${kerning}`;
          el.textContent = s;
          pages.appendChild(el);
          const w = el.getBoundingClientRect().width;
          el.remove();
          return w;
        };
        const a = text.indexOf("A ");
        return { word: width(0, 6), wordKerned: ref("Tavily", "normal"), wordPlain: ref("Tavily", "none"), aSpace: width(a, a + 2), aSpacePlain: ref("A ", "none"), aSpaceKerned: ref("A ", "normal"), family: getComputedStyle(node.parentElement!).fontFamily };
      });
    }, { sel: DOC, text });
    for (const g of got) {
      // Each font kerns T-a and A-space, so both checks below tell kerned from not
      expect(g.wordPlain - g.wordKerned).toBeGreaterThan(0.5);
      expect(g.aSpacePlain - g.aSpaceKerned).toBeGreaterThan(0.3);
      expect(Math.abs(g.word - g.wordKerned)).toBeLessThan(0.1);
      expect(Math.abs(g.aSpace - g.aSpacePlain)).toBeLessThan(0.1);
      expect(g.family).toMatch(/^"SS Space /);
    }
    // The page's space faces stay on the page: the editor's HTML, which its clipboard writes, names the fonts alone
    expect(await page.evaluate(() => window.ssEditor!.getHTML())).not.toContain("SS Space");
  });

  test("a right-to-left paragraph starts at the right margin, is indented from it, and has its glyph on its right", async ({ app, page }) => {
    const rtl = (text: string, attrs: Record<string, unknown> = {}) => ({ type: "paragraph", attrs: { dir: "rtl", ...attrs }, content: [{ type: "text", text }] });
    await app.open({ plain: [
      rtl("مرحبا بالعالم"),
      rtl("مزاح", { box: { start: 36, first: 0, above: 0, below: 0 } }),
      rtl("بند", { list: "bullet", level: 0 }),
      rtl("إلى اليسار", { textAlign: "left" }),
      { type: "paragraph", content: [{ type: "text", text: "Left to right" }] },
    ] });
    const got = await page.evaluate((sel) => {
      const doc = document.querySelector<HTMLElement>(sel)!;
      const zoom = parseFloat(getComputedStyle(document.querySelector(".ss-pages")!).zoom) || 1;
      // The text column: the sheet without its margins
      const sheet = doc.getBoundingClientRect();
      const cs = getComputedStyle(doc);
      const box = { left: sheet.left + parseFloat(cs.paddingLeft) * zoom, right: sheet.right - parseFloat(cs.paddingRight) * zoom };
      const pt = (px: number) => Math.round((px / zoom) * 0.75 * 10) / 10;
      return Array.from(doc.querySelectorAll(":scope > p")).map((p) => {
        const r = document.createRange();
        r.selectNodeContents(p);
        const t = r.getBoundingClientRect();
        const glyph = getComputedStyle(p, "::before");
        return { dir: p.getAttribute("dir"), fromLeft: pt(t.left - box.left), fromRight: pt(box.right - t.right), glyphRight: glyph.content !== "none" ? glyph.right : null };
      });
    }, DOC);
    expect(got.map((g) => g.dir)).toEqual(["rtl", "rtl", "rtl", "rtl", null]);
    // Its start is the right margin: the text ends there, an indent from its start comes in from the right
    expect(got[0].fromRight).toBeLessThan(0.5);
    expect(Math.abs(got[1].fromRight - 36)).toBeLessThan(0.5);
    // A list item's text at 36pt from its start, its glyph 18pt before the text, on the text's right
    expect(Math.abs(got[2].fromRight - 36)).toBeLessThan(0.5);
    expect(got[2].glyphRight).toBe("-24px");
    // Aligned to its end, which is the left; and text left to right starts at the left again
    expect(got[3].fromLeft).toBeLessThan(0.5);
    expect(got[4].fromLeft).toBeLessThan(0.5);
  });

  test("a list glyph's highlight is the height of its text's and level with it", async ({ app, page }) => {
    const text = { type: "text", text: "Highlighted item", marks: [{ type: "highlight", attrs: { color: "#fff2cc" } }] };
    await app.open({ plain: [{ type: "paragraph", attrs: { list: "bullet", level: 0 }, content: [text] }, { type: "paragraph", attrs: { list: "bullet", level: 0, lineSpacing: 200 }, content: [{ ...text, text: "Double spaced" }] }] });
    const got = await page.evaluate((sel) => {
      const zoom = parseFloat(getComputedStyle(document.querySelector(".ss-pages")!).zoom) || 1;
      return Array.from(document.querySelectorAll<HTMLElement>(`${sel} > p`)).map((p) => {
        const mark = p.querySelector("mark")!.getClientRects()[0];
        const g = getComputedStyle(p, "::before");
        const height = parseFloat(g.backgroundSize.split(" ")[1]);
        const top = parseFloat(g.backgroundPositionY);
        // The glyph box sits at the paragraph's top
        return { glyph: [Math.round(top * 100) / 100, Math.round(height * 100) / 100], text: [Math.round(((mark.top - p.getBoundingClientRect().top) / zoom) * 100) / 100, Math.round((mark.height / zoom) * 100) / 100] };
      });
    }, DOC);
    for (const p of got) {
      expect(Math.abs(p.glyph[0] - p.text[0]), JSON.stringify(p)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(p.glyph[1] - p.text[1]), JSON.stringify(p)).toBeLessThanOrEqual(0.05);
    }
  });
});

test.describe("narrow screens", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the layout reflows without horizontal scrolling and the page is pageless", async ({ app, page }) => {
    await app.open({ plain: plainParagraphs([`Phone draft. ${LONG_BODY}`, LONG_BODY, LONG_BODY]) });
    await expect(page.locator(".ss-pages")).toHaveClass(/ss-pageless/);
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      canvas: (() => { const c = document.querySelector(".ss-canvas")!; return c.scrollWidth - c.clientWidth; })(),
      // The text column fits the screen and every paragraph wraps inside it
      doc: Array.from(document.querySelectorAll(".ss-doc > p")).filter((p) => p.getBoundingClientRect().right > window.innerWidth).length,
    }));
    expect(overflow).toEqual({ page: 0, canvas: 0, doc: 0 });
    await expect(page.getByRole("button", { name: "Start sync" })).toBeVisible();
    // The ruler is hidden on phones
    await expect(page.locator(".ss-ruler-row")).toBeHidden();
  });

  test("an opened document stays within the screen apart from its fixed-width table", async ({ app, page }) => {
    await app.open();
    await expect(page.locator(".ss-pages")).toHaveClass(/ss-pageless/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    const wide = await page.evaluate(() => Array.from(document.querySelectorAll(".ss-doc > *")).filter((e) => e.getBoundingClientRect().right > window.innerWidth).map((e) => e.tagName));
    // Tables keep the column widths the document gives them, like Docs; everything else wraps
    expect(wide.every((t) => t === "TABLE" || t === "DIV")).toBe(true);
    await expect(app.doc).toContainText(CLOSING_TEXT);
  });
});
