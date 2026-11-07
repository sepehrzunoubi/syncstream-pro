import { expect, test, CLOSING_TEXT, type App } from "./fixtures";
import type { Page } from "@playwright/test";

const ADDED = " Typed later, with a few more words.";

/** Click the middle of the first occurrence of `word` on the page */
async function clickWord(app: App, page: Page, word: string) {
  const { from, to } = await app.locate(word);
  const box = await page.evaluate(([a, b]) => {
    const v = window.ssEditor!.view;
    const s = v.coordsAtPos(a + 1);
    const e = v.coordsAtPos(b - 1);
    return { x: (s.left + e.right) / 2, y: (s.top + s.bottom) / 2 };
  }, [from, to]);
  await page.mouse.click(box.x, box.y);
}

/** Click the middle of `word` as drawn in whichever page is showing (the live page in a sync's view) */
async function clickShownWord(page: Page, word: string) {
  const box = await page.evaluate((w) => {
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(".ProseMirror"))) {
      if (!root.offsetParent) continue;
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = (n.textContent ?? "").search(new RegExp(`(^|\\s)${w}(\\s|$)`));
        if (i < 0) continue;
        const k = (n.textContent ?? "").indexOf(w, i);
        const r = document.createRange();
        r.setStart(n, k);
        r.setEnd(n, k + w.length);
        const b = r.getBoundingClientRect();
        if (b.width) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
    }
    return null;
  }, word);
  if (!box) throw new Error(`"${word}" is not on the page`);
  await page.mouse.click(box.x, box.y);
}

/** Where each character of the closing paragraph is drawn */
const layout = (page: Page) => page.evaluate(() => {
  const v = window.ssEditor!.view;
  const out: number[] = [];
  v.state.doc.descendants((n, pos) => {
    if (!n.isTextblock || !n.textContent.startsWith("Closing thoughts")) return true;
    for (let i = 1; i <= n.content.size; i += 3) { const c = v.coordsAtPos(pos + i); out.push(Math.round(c.left * 10), Math.round(c.top * 10)); }
    return false;
  });
  return out;
});

async function manualWithText(app: App, page: Page) {
  await app.open();
  await app.caretAtEnd(CLOSING_TEXT);
  await page.keyboard.type(ADDED);
  await page.getByRole("group", { name: "Breaks" }).getByRole("button", { name: "Manual" }).click();
}

test.describe("Manual breaks", () => {
  test("a length, then a click on a word: the break goes after it, without moving the text or the cursor; Total time goes away", async ({ app, page, api }) => {
    await manualWithText(app, page);
    await expect(page.getByLabel("Total time")).toHaveCount(0);
    await page.getByLabel("Break length").fill("5m");
    await expect(page.getByRole("status").filter({ hasText: "the 5 minutes break starts after it" })).toBeVisible();
    const before = await layout(page);
    const caret = await page.evaluate(() => window.ssEditor!.state.selection.from);
    await clickWord(app, page, "later,");
    const pill = page.locator(".ss-doc .ss-brk-pill:not([data-ghost])");
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveText("5m");
    expect(await page.evaluate(() => window.ssEditor!.state.selection.from)).toBe(caret);
    expect(await layout(page)).toEqual(before);
    // The list names it
    await expect(page.getByRole("list", { name: "Breaks on the page" })).toContainText("after “later,”");
    // Text that is already in the document can't take one
    await clickWord(app, page, "Closing");
    await expect(pill).toHaveCount(1);
    // Never copied
    const copied = await page.evaluate(() => { const v = window.ssEditor!.view; const sel = v.serializeForClipboard(v.state.doc.slice(0, v.state.doc.content.size)); return sel.dom.innerHTML; });
    expect(copied).not.toContain("5m");
    expect(copied).not.toContain("ss-brk-pill");
    // Starting sends it as a place in the text typed, at the natural pace
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => api.starts.length).toBe(1);
    const body = api.starts[0];
    expect(body.targetMinutes).toBeNull();
    expect(body.breaks).toEqual([{ at: ADDED.indexOf("later,") + "later, ".length, minutes: 5 }]);
  });

  test("Clear all takes every break off, and Undo brings them back; Done stops placing", async ({ app, page }) => {
    await manualWithText(app, page);
    await page.getByLabel("Break length").fill("1h 5m");
    await clickWord(app, page, "later,");
    await clickWord(app, page, "few");
    const pills = page.locator(".ss-doc .ss-brk-pill:not([data-ghost])");
    await expect(pills).toHaveText(["1h 5m", "1h 5m"]);
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(pills).toHaveCount(0);
    await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
    await expect(pills).toHaveCount(2);
    // Done: clicks go back to placing the cursor
    await page.getByRole("status").filter({ hasText: "Click a word" }).getByRole("button", { name: "Done" }).click();
    await clickWord(app, page, "more");
    await expect(pills).toHaveCount(2);
    // A length it can't read says how to write one, and doesn't place
    await page.getByLabel("Break length").fill("soon");
    await expect(page.getByText("Try 33m or 1h 5m.")).toBeVisible();
    await clickWord(app, page, "words.");
    await expect(pills).toHaveCount(2);
  });

  test("a pill opens its break: change the length or remove it", async ({ app, page }) => {
    await manualWithText(app, page);
    await page.getByLabel("Break length").fill("10");
    await clickWord(app, page, "few");
    await page.getByLabel("Break length").fill("");
    await page.locator(".ss-doc .ss-brk-pill").click();
    const pop = page.getByRole("dialog", { name: "Break" });
    await pop.getByLabel("Break length").fill("45m");
    await pop.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".ss-doc .ss-brk-pill")).toHaveText("45m");
    await page.locator(".ss-doc .ss-brk-pill").click();
    await page.getByRole("dialog", { name: "Break" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.locator(".ss-doc .ss-brk-pill")).toHaveCount(0);
  });

  test("breaks stay on their words through a reload", async ({ app, page, api }) => {
    api.contentMode = "always";
    await manualWithText(app, page);
    await page.getByLabel("Break length").fill("33m");
    await clickWord(app, page, "few");
    await expect(page.locator(".ss-doc .ss-brk-pill")).toHaveText("33m");
    await page.waitForTimeout(800);
    // Keep the draft the page saved (the fixture writes its own on every load)
    await page.evaluate(() => sessionStorage.setItem("e2e_draft", localStorage.getItem("syncstream_draft_v2") ?? ""));
    await page.addInitScript(() => { const d = sessionStorage.getItem("e2e_draft"); if (d) localStorage.setItem("syncstream_draft_v2", d); });
    await page.reload();
    await expect(page.locator(".ss-doc .ss-brk-pill")).toHaveText("33m");
    await expect(page.getByRole("group", { name: "Breaks" }).getByRole("button", { name: "Manual" })).toHaveAttribute("aria-pressed", "true");
  });

  test("on the live page: the breaks show where they are, and one can be added to text not typed yet", async ({ app, page, api }) => {
    await manualWithText(app, page);
    await page.getByLabel("Break length").fill("5m");
    await clickWord(app, page, "later,");
    await page.getByRole("button", { name: "Start sync" }).click();
    await expect.poll(() => api.starts.length).toBe(1);
    const at = ADDED.indexOf("later,") + "later, ".length;
    // As the server has it: the break's place, from where breaks can still change
    api.jobs = api.jobs.map((j) => ({ ...j, breaks: [5], breakAt: [at], breaksVersion: 0, editableFrom: 3, completedBreaks: [] }));
    const livePills = page.locator(".ss-doc .ss-brk-pill:not([data-ghost])");
    await expect(livePills).toHaveText("5m", { timeout: 10_000 });
    const panel = page.getByRole("complementary", { name: "This sync" });
    await expect(panel).toContainText("after “later,”");
    await panel.getByLabel("Add a break").fill("10m");
    await clickShownWord(page, "few");
    await expect.poll(() => api.breakEdits.length).toBe(1);
    expect(api.breakEdits[0]).toEqual({ jobId: api.jobs[0].id, version: 0, breaks: [{ at, minutes: 5 }, { at: ADDED.indexOf("few") + "few ".length, minutes: 10 }] });
    await expect(livePills).toHaveText(["5m", "10m"]);
    // Removing one from the list
    await panel.getByRole("button", { name: "Remove the 5m break" }).click();
    await expect.poll(() => api.breakEdits.length).toBe(2);
    expect(api.breakEdits[1].breaks).toEqual([{ at: ADDED.indexOf("few") + "few ".length, minutes: 10 }]);
    await expect(livePills).toHaveText(["10m"]);
  });
});
