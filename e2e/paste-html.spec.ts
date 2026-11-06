import fs from "node:fs";
import path from "node:path";
import { test, expect, type App, type FakeGoogle } from "./fixtures";
import type { Page } from "@playwright/test";
import { importDoc } from "../src/lib/doc-import";
import { PENDING_MARK } from "../src/lib/doc-model";
import type { EditorNode } from "../src/lib/rich-text";
import { EMPTY_DOC } from "./fixtures/empty-doc";

/**
 * Pasting Google Docs' text/html without Docs' own copy of it (Safari, or a copy with a table,
 * image or chip, which the slice reader leaves to the HTML). The snippets are written the way
 * Docs writes its clipboard (checked against real captures of 16 public documents).
 */
const RUN = "font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;";
const span = (t: string, extra = "") => `<span style="${RUN}${extra}white-space:pre-wrap;">${t}</span>`;
const para = (inner: string, style = "line-height:1.38;margin-top:0pt;margin-bottom:0pt;") => `<p dir="ltr" style="${style}">${inner}</p>`;
const docs = (inner: string) => `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-5e1c0a77-7fff-41d2-8a3b-0c9d8e7f6a5b">${inner}</b>`;
const item = (t: string, level: number, liExtra = "", pStyle = "line-height:1.38;margin-top:0pt;margin-bottom:0pt;") =>
  `<li dir="ltr" style="list-style-type:disc;${RUN}${liExtra}" aria-level="${level}"><p dir="ltr" style="${pStyle}" role="presentation">${span(t)}</p></li>`;
const list = (inner: string, pad = "48px") => `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:${pad};">${inner}</ul>`;

async function openEmpty(app: App, api: FakeGoogle, page: Page) {
  api.content = importDoc(EMPTY_DOC as never);
  api.revision = api.content.revisionId;
  await app.open({ named: false });
  await page.evaluate(() => window.ssEditor!.chain().focus().setTextSelection(1).run());
}
const paragraphsOf = async (app: App) => ((await app.json()).content as EditorNode[]).filter((n) => n.type === "paragraph");
const marksOf = (n: EditorNode | undefined) => (n?.marks ?? []).filter((m) => m.type !== PENDING_MARK);

test.describe("pasting Google Docs' HTML", () => {
  test("its &nbsp; entities are the spaces the document has, its literal non-breaking spaces stay", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    // Docs escapes a space at the end of a run and in runs of spaces; text/plain has every one as a space
    await app.paste({ html: docs(para(span("Ends with a space.&nbsp;")) + para(span("a&nbsp; &nbsp;b, 10 km"))), text: "Ends with a space. \na   b, 10 km\n" });
    await expect.poll(() => app.text()).toBe("Ends with a space. \na   b, 10 km");
  });

  test("a copy that ends inside a paragraph joins the text after the caret", async ({ app }) => {
    await app.open();
    await app.caretBefore("the whole program.");
    // text/plain ends with a newline whenever more than one paragraph is copied, even mid-paragraph
    await app.paste({ html: docs(para(span("First copied")) + para(span("and the start of the next"))), text: "First copied\nand the start of the next\n" });
    await expect.poll(async () => (await app.paragraphs()).map((p) => p.text).filter((t) => /copied|whole program/.test(t))).toEqual(["Closing thoughts on First copied", "and the start of the nextthe whole program."]);
  });

  test("Docs' own copy, even one that can't be read, says whether the last newline was copied", async ({ app }) => {
    await app.open();
    await app.caretBefore("the whole program.");
    // A copy with a table: the slice reader leaves it to the HTML, but its text still ends with the newline
    const slice = JSON.stringify({ data: JSON.stringify({ resolved: { dsl_spacers: "First copied\n\u0010\u0012\u001cCell\n\u0011And a whole paragraph\n", dsl_styleslices: [] } }) });
    const html = docs(para(span("First copied")) + `<div dir="ltr" style="margin-left:0pt;" align="left"><table style="border:none;border-collapse:collapse;"><tbody><tr><td>${para(span("Cell"))}</td></tr></tbody></table></div>` + para(span("And a whole paragraph")));
    await app.paste({ html, slice, text: "First copied\nCell\nAnd a whole paragraph\n" });
    await expect.poll(async () => (await app.paragraphs()).map((p) => p.text).filter((t) => /whole/.test(t))).toEqual(["And a whole paragraph", "the whole program."]);
  });

  test("superscript keeps the size of the text around it", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    // Docs writes the run's size on the outer span and draws the offset at 0.6em
    const sup = `<span style="${RUN}white-space:pre-wrap;"><span style="font-size:0.6em;vertical-align:super;">2</span></span>`;
    await app.paste({ html: docs(para(span("E = mc") + sup)), text: "E = mc2\n" });
    await expect.poll(async () => (await paragraphsOf(app))[0]?.content?.length).toBe(2);
    const two = (await paragraphsOf(app))[0].content![1];
    expect(marksOf(two).map((m) => m.type)).toEqual(["superscript"]);
  });

  test("a paragraph's shading is not its text's highlight, and its padding is not an indent", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    await app.paste({
      html: docs(para(span("Shaded"), "line-height:1.2;background-color:#eaeaea;margin-top:0pt;margin-bottom:0pt;padding:2pt 2pt 2pt 2pt;") + para(span("Shaded, 8pt below"), "line-height:1.2;background-color:#d9ead3;margin-top:0pt;margin-bottom:0pt;padding:0pt 0pt 8pt 0pt;")),
      text: "Shaded\nShaded, 8pt below\n",
    });
    await expect.poll(async () => (await paragraphsOf(app)).length).toBeGreaterThanOrEqual(2);
    const [a, b] = await paragraphsOf(app);
    expect(a.attrs?.shading).toBe("#eaeaea");
    expect((a.attrs?.box as { start: number }).start).toBe(0);
    expect((b.attrs?.box as { below: number }).below).toBe(8);
    for (const p of [a, b]) expect(marksOf(p.content?.[0]).filter((m) => m.type === "highlight")).toEqual([]);
  });

  test("list items keep Docs' exact indents and their glyph's style", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    // Glyph at 0, text at 36pt (an outline); text at 108pt; a red bold glyph
    const html = docs(list(item("Outline", 1, "margin-left: -18pt;padding-left: 18pt;") + item("Far in", 1, "margin-left: 72pt;")) +
      list(item("Red glyph", 1).replace("color:#000000;", "color:#ff0000;").replace("font-weight:400;", "font-weight:700;")));
    await app.paste({ html, text: "Outline\nFar in\nRed glyph\n" });
    await expect.poll(async () => (await paragraphsOf(app)).filter((p) => p.attrs?.list).length).toBe(3);
    const items = (await paragraphsOf(app)).filter((p) => p.attrs?.list);
    expect(items.map((p) => p.attrs?.box && [(p.attrs.box as { start: number }).start, (p.attrs.box as { marker: number }).marker])).toEqual([[36, -36], [108, -18], [36, -18]]);
    expect(items[2].attrs?.glyphStyle).toEqual({ color: "#ff0000", b: 1 });
  });

  test("a checked checklist item stays one item, without a strikethrough of its own", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    const box = `<img src="data:image/png;base64,iVBORw0KGgo=" width="17.6px" height="17.6px" alt="checked" aria-roledescription="checkbox" style="margin-right:3px;" />`;
    const html = docs(list(
      `<li dir="ltr" role="checkbox" aria-checked="true" style="list-style-type:none;${RUN.replace("text-decoration:none;", "text-decoration:line-through;")}" aria-level="1">${box}<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;display:inline-block;vertical-align:top;margin-top:0;" role="presentation">${span("Done", "text-decoration:line-through;")}</p></li>` +
      `<li dir="ltr" role="checkbox" aria-checked="false" style="list-style-type:none;${RUN}" aria-level="1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">${span("To do")}</p></li>`, "28px"));
    await app.paste({ html, text: "Done\nTo do\n" });
    await expect.poll(async () => (await app.paragraphs()).filter((p) => p.text).map((p) => [p.text, p.list])).toEqual([["Done", "check"], ["To do", "check"]]);
    const done = (await paragraphsOf(app))[0];
    expect(marksOf(done.content?.[0]).map((m) => m.type)).not.toContain("strike");
    expect(done.attrs?.preset).toBe("BULLET_CHECKBOX");
  });

  test("right-to-left paragraphs keep their direction, their place on the page and their indents from the right", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    const rtl = (inner: string, style: string) => `<p dir="rtl" style="${style}">${inner}</p>`;
    await app.paste({
      // As Docs copies them: START is the right in a right-to-left paragraph, END the left; indents on its own sides
      html: docs(rtl(span("\u0645\u0631\u062d\u0628\u0627"), "line-height:1.38;text-align: right;margin-top:0pt;margin-bottom:0pt;") + rtl(span("\u064a\u0633\u0627\u0631"), "line-height:1.38;text-align: left;margin-right: 36pt;margin-left: 18pt;margin-top:0pt;margin-bottom:0pt;") + para(span("Left to right"))),
      text: "\u0645\u0631\u062d\u0628\u0627\n\u064a\u0633\u0627\u0631\nLeft to right\n",
    });
    await expect.poll(async () => (await paragraphsOf(app)).length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = await paragraphsOf(app);
    expect([a.attrs?.dir, b.attrs?.dir, c.attrs?.dir ?? null]).toEqual(["rtl", "rtl", null]);
    expect([a.attrs?.textAlign, b.attrs?.textAlign]).toEqual(["right", "left"]);
    expect((b.attrs?.box as { start: number }).start).toBe(36);
    expect(b.attrs?.indentEnd).toBe(18);
  });

  test("text copied from inside a paragraph has no formatting its new paragraph's style gives", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    await app.paste({ html: docs(span("plain words")), text: "plain words" });
    await expect.poll(() => app.text()).toBe("plain words");
    expect(marksOf((await paragraphsOf(app))[0].content?.[0])).toEqual([]);
  });

  test("a line break is pasted as the paragraph the sync will make of it, each line where the break put it", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    const br = `<span style="${RUN}white-space:pre-wrap;"><br /></span>`;
    const li = (inner: string, level: number) => `<li dir="ltr" style="list-style-type:disc;${RUN}" aria-level="${level}"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">${inner}</p></li>`;
    const html = docs(
      list(li(span("Item one") + br + span("its second line"), 1) + list(li(span("Nested") + br + span("nested next line"), 2)) + li(span("Item two"), 1)) +
      para(span("Indented first line") + br + span("and its next line"), "line-height:1.38;margin-left:36pt;text-indent:18pt;margin-top:10pt;margin-bottom:12pt;") +
      para(span("After")),
    );
    const lines = ["Item one", "its second line", "Nested", "nested next line", "Item two", "Indented first line", "and its next line", "After"];
    await app.paste({ html, text: "Item one\u000bits second line\nNested\u000bnested next line\nItem two\nIndented first line\u000band its next line\nAfter\n" });
    await expect.poll(async () => (await paragraphsOf(app)).map((p) => p.content?.map((c) => c.text ?? `[${c.type}]`).join("") ?? "")).toEqual(lines);
    // The lines after the breaks are no list items: the sync types each as a paragraph, and gives it no glyph
    expect((await paragraphsOf(app)).map((p) => p.attrs?.list ?? null)).toEqual(["bullet", null, "bullet", null, "bullet", null, null, null]);
    /** Where each line's first character is drawn, from the page's top left corner */
    const drawn = () => page.evaluate((texts) => {
      const doc = document.querySelector(".ss-doc")!;
      const origin = doc.getBoundingClientRect();
      return texts.map((t) => {
        const walk = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const i = n.textContent!.indexOf(t);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const b = r.getBoundingClientRect();
          return [Math.round((b.left - origin.left) * 100) / 100, Math.round((b.top - origin.top) * 100) / 100];
        }
        return null;
      });
    }, lines);
    const pasted = await drawn();
    // The same content with its line breaks, as the page drew a paste before (and as Docs draws the copy)
    await page.evaluate((after) => {
      const ed = window.ssEditor!;
      const out: { type?: string; attrs?: Record<string, unknown>; content?: { type?: string; text?: string }[] }[] = [];
      for (const n of (ed.getJSON().content ?? []) as typeof out) {
        const prev = out[out.length - 1];
        const text = (n.content ?? []).map((c) => c.text ?? "").join("");
        if (after.includes(text) && prev) {
          prev.content = [...(prev.content ?? []), { type: "hardBreak" }, ...(n.content ?? [])];
          prev.attrs = { ...prev.attrs, box: { ...(prev.attrs?.box as object), below: (n.attrs?.box as { below: number }).below } };
        } else out.push(n);
      }
      ed.commands.setContent({ type: "doc", content: out });
    }, ["its second line", "nested next line", "and its next line"]);
    await expect(app.doc.locator("br:not(.ProseMirror-trailingBreak)")).toHaveCount(3);
    const broken = await drawn();
    for (let k = 0; k < lines.length; k++) {
      expect(Math.abs(pasted[k]![0] - broken[k]![0]), `${lines[k]}: x ${pasted[k]![0]} vs ${broken[k]![0]}`).toBeLessThan(0.05);
      expect(Math.abs(pasted[k]![1] - broken[k]![1]), `${lines[k]}: y ${pasted[k]![1]} vs ${broken[k]![1]}`).toBeLessThan(0.05);
    }
  });

  test("a numbered item's line break doesn't restart the numbering: the next item is 2., as in Docs", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    const br = `<span style="${RUN}white-space:pre-wrap;"><br /></span>`;
    const li = (inner: string) => `<li dir="ltr" style="list-style-type:decimal;${RUN}" aria-level="1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">${inner}</p></li>`;
    const ol = (inner: string) => `<ol style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">${inner}</ol>`;
    await app.paste({ html: docs(ol(li(span("First") + br + span("its next line")) + li(span("Second")) + li(span("Third") + br + span("more") + br + span("and more")) + li(span("Fourth")))), text: "First\u000bits next line\nSecond\nThird\u000bmore\u000band more\nFourth\n" });
    await expect.poll(async () => (await paragraphsOf(app)).length).toBeGreaterThanOrEqual(7);
    // The labels the page draws, item by item (a next line draws none)
    const labels = () => app.doc.locator("p").evaluateAll((ps) => ps.map((p) => (p.textContent ? (p.hasAttribute("data-list") ? p.getAttribute("data-label") : "-") : null)).filter((l) => l !== null));
    await expect.poll(labels).toEqual(["1.", "-", "2.", "3.", "-", "-", "4."]);
  });

  test("a list with paragraphs between its items counts on as Docs' <ol start> says, copies the same way, and keeps counting when an item loses its bullet", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    const li = (t: string) => `<li dir="ltr" style="list-style-type:decimal;${RUN}" aria-level="1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">${span(t)}</p></li>`;
    const ol = (inner: string, start?: number) => `<ol style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"${start ? ` start="${start}"` : ""}>${inner}</ol>`;
    // As Docs copies one list with notes between its steps; the last list restarts (Docs says where, the API can't)
    const html = docs(ol(li("Step one")) + para(span("Its note")) + "<br />" + ol(li("Step two") + li("Step three"), 2) + para(span("Another note")) + ol(li("Step four"), 4) + para(span("Not a step")) + ol(li("A new list"), 7));
    await app.paste({ html, text: "Step one\nIts note\n\nStep two\nStep three\nAnother note\nStep four\nNot a step\nA new list\n" });
    await expect.poll(async () => (await paragraphsOf(app)).length).toBeGreaterThanOrEqual(9);
    const shownLabels = () => app.doc.locator("p").evaluateAll((ps) => ps.map((p) => p.getAttribute("data-label")).filter(Boolean));
    await expect.poll(shownLabels).toEqual(["1.", "2.", "3.", "4.", "1."]);
    expect((await paragraphsOf(app)).map((p) => (p.attrs?.listCont ? "cont" : p.attrs?.list ?? "-"))).toEqual(["ordered", "cont", "cont", "ordered", "ordered", "cont", "ordered", "-", "ordered", "-"].slice(0, (await paragraphsOf(app)).length));
    // Copied for other apps: the lists after the notes start where the list left off
    const copied = await page.evaluate(() => { const v = window.ssEditor!.view; return v.serializeForClipboard(v.state.doc.slice(0, v.state.doc.content.size)).dom.innerHTML; });
    expect(Array.from(copied.matchAll(/<ol\b([^>]*)>/g), (m) => /start="(\d+)"/.exec(m[1])?.[1] ?? null)).toEqual([null, "2", "4", null]);
    // Taking the bullet off "Step two" (Ctrl+Shift+7): it stays between items of the list, which count on as in Docs
    await app.doc.getByText("Step two").click();
    await page.keyboard.press("Control+Shift+7");
    await expect.poll(shownLabels).toEqual(["1.", "2.", "3.", "1."]);
    // And back: it is an item again, numbered in its place
    await page.keyboard.press("Control+Shift+7");
    await expect.poll(shownLabels).toEqual(["1.", "2.", "3.", "4.", "1."]);
  });
});

test.describe("typing line breaks", () => {
  type Line = { text: string; list: string | null; label: string | null; above: number | null; below: number | null; left: number; top: number };
  /** Each paragraph: its text, list, label and spacing, and where its first character is drawn */
  const lines = (app: App) => app.doc.locator("p").evaluateAll((ps): Line[] => {
    const origin = ps[0]?.closest(".ss-doc")!.getBoundingClientRect();
    return ps.filter((p) => p.textContent).map((p) => {
      const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const t = walk.nextNode()!;
      const r = document.createRange();
      r.setStart(t, 0);
      r.setEnd(t, 1);
      const b = r.getBoundingClientRect();
      const cs = getComputedStyle(p);
      return { text: p.textContent!, list: p.getAttribute("data-list"), label: p.getAttribute("data-label"), above: parseFloat(cs.marginTop), below: parseFloat(cs.marginBottom), left: Math.round((b.left - origin.left) * 100) / 100, top: Math.round((b.top - origin.top) * 100) / 100 };
    });
  });

  /** Waits until the editor has the caret where the keys put it (it reads the page's selection a moment later) */
  const caretAt = (page: Page, text: string, where: "start" | "end") => expect.poll(() => page.evaluate(({ text, where }) => {
    const { $from, empty } = window.ssEditor!.state.selection;
    return empty && $from.parent.textContent === text && $from.parentOffset === (where === "start" ? 0 : $from.parent.content.size);
  }, { text, where })).toBe(true);

  test("Shift+Enter is a line break as Docs makes it: the same line of the item, its list numbered on after it; Enter starts the next item; Backspace takes it out", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    await expect.poll(() => page.evaluate(() => window.ssEditor!.isFocused)).toBe(true);
    await page.keyboard.press("Control+Shift+7");
    await page.keyboard.type("Item one");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("its second line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Item two");
    await expect.poll(async () => (await lines(app)).map((l) => [l.text, l.label])).toEqual([["Item one", "1."], ["its second line", null], ["Item two", "2."]]);
    const [one, second, two] = await lines(app);
    // The line starts where the item's text does, a line's height under it, with no space between
    expect(Math.abs(second.left - one.left)).toBeLessThan(0.05);
    expect(Math.abs(second.top - one.top - (two.top - second.top))).toBeLessThan(0.05);
    // As the same content pasted (a line break in the item) is drawn
    const typed = await paragraphsOf(app);
    expect(typed[1].attrs?.softBreak).toBe(true);
    expect(typed[1].attrs?.listCont).toBe(true);

    // Copied for other apps: the line break is in the item again
    const copied = await page.evaluate(() => { const v = window.ssEditor!.view; return v.serializeForClipboard(v.state.doc.slice(0, v.state.doc.content.size)).dom.innerHTML; });
    expect(copied).toMatch(/Item one(<\/span>)?<br>(<span[^>]*>)?its second line/);
    expect(copied.match(/<li\b/g)).toHaveLength(2);

    // Backspace at the start of the line: one line again
    await app.doc.getByText("its second line").click();
    await page.keyboard.press("Home");
    await caretAt(page, "its second line", "start");
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await lines(app)).map((l) => [l.text, l.label])).toEqual([["Item oneits second line", "1."], ["Item two", "2."]]);
  });

  test("a line break in a spaced paragraph keeps the paragraph's space around it, not between its lines, and Backspace gives it back", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    await page.evaluate(() => window.ssEditor!.chain().focus().setParagraphSpace({ above: 12, below: 18 }).run());
    await expect.poll(() => page.evaluate(() => window.ssEditor!.isFocused)).toBe(true);
    await page.keyboard.type("First line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Second line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Next paragraph");
    await expect.poll(async () => (await lines(app)).map((l) => l.text)).toEqual(["First line", "Second line", "Next paragraph"]);
    const pt = 96 / 72;
    const [first, second, next] = await lines(app);
    expect([first.above, first.below, second.above, second.below, next.above, next.below].map((v) => Math.round((v ?? 0) / pt * 10) / 10)).toEqual([12, 0, 0, 18, 12, 18]);
    expect(Math.abs(second.left - first.left)).toBeLessThan(0.05);
    // Delete at the end of the first line takes the break out: one paragraph, spaced as before the break
    await app.doc.getByText("First line").click();
    await page.keyboard.press("End");
    await caretAt(page, "First line", "end");
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await lines(app)).map((l) => l.text)).toEqual(["First lineSecond line", "Next paragraph"]);
    const [joined] = await lines(app);
    expect([joined.above, joined.below].map((v) => Math.round((v ?? 0) / pt * 10) / 10)).toEqual([12, 18]);
  });
});

test.describe("pasting other HTML", () => {
  test("named colours and <mark> keep their colour", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    await app.paste({ html: `<p><span style="color:red">red</span> <mark>marked</mark></p><p>next</p>`, text: "red marked\nnext" });
    await expect.poll(async () => (await paragraphsOf(app)).length).toBeGreaterThanOrEqual(2);
    const runs = (await paragraphsOf(app))[0].content ?? [];
    expect(runs.find((r) => r.text === "red")?.marks?.find((m) => m.type === "textStyle")?.attrs?.color).toBe("#ff0000");
    expect(runs.find((r) => r.text === "marked")?.marks?.find((m) => m.type === "highlight")?.attrs?.color).toBe("#ffff00");
  });
});

/**
 * The clipboard corpus (fixtures/clipboard/corpus), each copy pasted twice: from Docs' own copy, and from
 * its HTML alone, as Safari pastes it. The two must come out the same, but for what Docs' HTML doesn't
 * carry: an empty paragraph is a bare line break there (only that it is one, and its style, are compared),
 * and keep options, spacing modes and list styles of their own aren't in it.
 */
const CORPUS = path.join(__dirname, "..", "fixtures", "clipboard", "corpus");
const CAPTURES = ["lists", "inline", "reference"].flatMap((d) => ["full", "partial-a", "partial-b", "partial-c", "partial-d"].filter((k) => !(d === "reference" && k === "full")).map((k) => `${d}/${k}`));

/** A paragraph as the page shows it: its text, its look and its runs' marks, adjacent runs with the same marks joined */
function shown(p: EditorNode) {
  const a = (p.attrs ?? {}) as Record<string, unknown>;
  const runs: { text: string; marks: string }[] = [];
  for (const c of p.content ?? []) {
    const marks = JSON.stringify((c.marks ?? []).filter((m) => m.type !== PENDING_MARK).map((m) => ({ type: m.type, ...(m.attrs ? { attrs: Object.fromEntries(Object.entries(m.attrs).filter(([k, v]) => v != null && k !== "target" && k !== "rel" && k !== "class").sort()) } : {}) })).sort((x, y) => x.type.localeCompare(y.type)));
    const text = c.text ?? `[${c.type}]`;
    if (runs.length && runs[runs.length - 1].marks === marks) runs[runs.length - 1].text += text;
    else runs.push({ text, marks });
  }
  const r1 = (v: unknown) => (typeof v === "number" ? Math.round(v * 10) / 10 : v ?? null);
  const box = (a.box ?? null) as Record<string, number | null> | null;
  const empty = !runs.length;
  return {
    style: a.styleName ?? "normal",
    list: a.list ?? null,
    level: a.list ? a.level ?? 0 : null,
    ...(empty ? {} : {
      align: a.textAlign ?? null,
      spacing: a.lineSpacing ?? 115,
      box: box ? Object.fromEntries(Object.entries(box).map(([k, v]) => [k, r1(v)])) : null,
      end: r1(a.indentEnd),
      shading: a.shading ?? null,
      borders: a.borders ?? null,
      glyph: a.glyphStyle ?? null,
    }),
    runs,
  };
}

/** Paste into an empty document (the page's one, emptied again) and read the paragraphs back */
async function pasteAndRead(app: App, page: Page, clip: { slice?: string; html: string; text: string }) {
  await page.evaluate(() => window.ssEditor!.chain().setContent({ type: "doc", content: [{ type: "paragraph" }] }).focus().setTextSelection(1).run());
  await app.paste(clip);
  await expect.poll(() => app.text()).not.toBe("");
  return ((await app.json()).content as EditorNode[]).map(shown);
}

/** Copies whose HTML can't say all their copy does */
const KNOWN: Record<string, string> = {
  // Docs' copy says its last newline was copied; the HTML doesn't show it, so its last paragraph goes
  // over the empty one pasted into, not before it (Docs' copy keeps that paragraph after the paste)
  "lists/full": "ends with a newline its HTML doesn't show",
};

test.describe("Docs' HTML against Docs' own copy", () => {
  for (const name of CAPTURES) {
    test(`${name}: the HTML alone pastes as Docs' copy does`, async ({ app, api, page }) => {
      const file = (ext: string) => fs.readFileSync(path.join(CORPUS, `${name}${ext}`), "utf8");
      const clip = { slice: file("-slice.json"), html: file(".html"), text: file(".txt") };
      await openEmpty(app, api, page);
      const fromSlice = await pasteAndRead(app, page, clip);
      const fromHtml = await pasteAndRead(app, page, { html: clip.html, text: clip.text });
      const diffs: string[] = [];
      if (KNOWN[name]) {
        // The paragraph pasted into, left after the paste only by Docs' copy
        expect(fromSlice.length).toBe(fromHtml.length + 1);
        expect(fromSlice.pop()).toMatchObject({ runs: [] });
      }
      if (fromSlice.length !== fromHtml.length) diffs.push(`paragraphs: slice ${fromSlice.length}, html ${fromHtml.length}`);
      for (let i = 0; i < Math.min(fromSlice.length, fromHtml.length); i++) {
        const a = JSON.stringify(fromSlice[i]);
        const b = JSON.stringify(fromHtml[i]);
        if (a !== b) diffs.push(`P${i}\n  slice ${a}\n  html  ${b}`);
      }
      expect(diffs).toEqual([]);
    });
  }
});
