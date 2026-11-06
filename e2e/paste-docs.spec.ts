import fs from "node:fs";
import path from "node:path";
import { test, expect, type App, type FakeGoogle } from "./fixtures";
import type { Page } from "@playwright/test";
import { importDoc } from "../src/lib/doc-import";
import { readDocsSlice, sliceParagraphs } from "../src/lib/docs-slice";
import { mixedCopy } from "../src/lib/docs-slice.testing";
import { PENDING_MARK } from "../src/lib/doc-model";
import type { EditorNode } from "../src/lib/rich-text";
import { EMPTY_DOC } from "./fixtures/empty-doc";

/** The reference document (Web Structured Data / Web Connection), Ctrl+A, Ctrl+C in Chrome */
const CLIP = path.join(__dirname, "..", "fixtures", "clipboard");
const SLICE = fs.readFileSync(path.join(CLIP, "web-structured-data.slice.json"), "utf8");
const HTML = fs.readFileSync(path.join(CLIP, "web-structured-data.html"), "utf8");
const TEXT = fs.readFileSync(path.join(CLIP, "web-structured-data.txt"), "utf8");

async function openEmpty(app: App, api: FakeGoogle, page: Page) {
  api.content = importDoc(EMPTY_DOC as never);
  api.revision = api.content.revisionId;
  await app.open({ named: false });
  await page.evaluate(() => window.ssEditor!.chain().focus().setTextSelection(1).run());
}

/** A paragraph's text runs with their marks (the glow left out), adjacent runs with the same marks joined */
function runsOf(p: EditorNode) {
  const out: { text: string; marks: string }[] = [];
  for (const c of p.content ?? []) {
    // A link is its address (the editor adds its own defaults for target and rel)
    const sorted = (a: Record<string, unknown> | undefined) => (a ? Object.fromEntries(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))) : null);
    const attrs = (m: { type: string; attrs?: Record<string, unknown> }) => (m.type === "link" ? { href: m.attrs?.href } : sorted(m.attrs));
    const marks = JSON.stringify((c.marks ?? []).filter((m) => m.type !== PENDING_MARK).map((m) => ({ type: m.type, attrs: attrs(m) })).sort((a, b) => a.type.localeCompare(b.type)));
    const text = c.type === "text" ? c.text ?? "" : `<${c.type}>`;
    const last = out[out.length - 1];
    if (last && last.marks === marks) last.text += text;
    else out.push({ text, marks });
  }
  return out;
}

const KEYS = ["styleName", "textAlign", "lineSpacing", "list", "level", "preset", "box", "keep", "indentEnd", "borders", "shading"];
const attrsOf = (p: EditorNode) => Object.fromEntries(KEYS.map((k) => [k, (p.attrs ?? {})[k] ?? null]));

test.describe("pasting from Google Docs", () => {
  test("a whole document pasted into an empty one comes out paragraph for paragraph", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    await app.paste({ slice: SLICE, html: HTML, text: TEXT });
    const want = sliceParagraphs(readDocsSlice(SLICE, TEXT)!, api.content.defaults);
    // Ctrl+A leaves out the document's last, empty paragraph; the one pasted into takes its place, as in Docs
    await expect.poll(async () => ((await app.json()).content as EditorNode[]).length).toBe(46);
    const got = (await app.json()).content as EditorNode[];
    for (let i = 0; i < want.length; i++) {
      expect(attrsOf(got[i]), `paragraph ${i + 1} format`).toEqual(attrsOf(want[i]));
      expect(runsOf(got[i]), `paragraph ${i + 1} text`).toEqual(runsOf(want[i]));
    }
    expect(got[45].content ?? []).toEqual([]);
    // All of it is new: it glows, and every character is typed by the sync
    expect((await app.pending()).join("")).toBe(TEXT.replace(/\n/g, ""));
    // The page shows the heading's highlight and the list's glyphs as Docs does
    const view = await app.paragraphs();
    expect(view[0]).toMatchObject({ style: "h1", text: "Web Structured Data / Web Connection" });
    expect(view.filter((p) => p.list).slice(0, 3).map((p) => p.label)).toEqual(["●", "○", "■"]);
  });

  test("without Docs' own copy (Safari), the HTML gives the same paragraphs and text", async ({ app, api, page }) => {
    await openEmpty(app, api, page);
    await app.paste({ html: HTML, text: TEXT });
    const want = sliceParagraphs(readDocsSlice(SLICE, TEXT)!, api.content.defaults);
    // The HTML ends with the empty line that shows the last newline was copied: the paragraph pasted
    // into stays after the pasted ones, as with Docs' own copy
    await expect.poll(async () => ((await app.json()).content as EditorNode[]).length).toBe(46);
    const got = (await app.json()).content as EditorNode[];
    expect(got[45].content ?? []).toEqual([]);
    // Same text, character for character (no non-breaking spaces where the document has spaces)
    expect(await app.text()).toBe(TEXT);
    const outline = (ps: EditorNode[]) => ps.map((p) => [p.attrs?.styleName, p.attrs?.list ?? null, p.attrs?.list ? p.attrs?.level ?? 0 : null]);
    expect(outline(got.slice(0, 45))).toEqual(outline(want));
    // Highlights and the link, as copied
    expect(runsOf(got[0])).toEqual(runsOf(want[0]));
  });

  test("pasted into the middle of a paragraph, it splits it the way Docs does", async ({ app }) => {
    await app.open();
    // "Closing thoughts on |the whole program."
    await app.caretBefore("the whole program.");
    const heading = { ps_al: 0, ps_hd: 2, ps_ls: 1.15, ps_sb: 18, ps_sa: 6 };
    const normal = { ps_al: 0, ps_hd: 0, ps_ls: 1.15, ps_sb: 0, ps_sa: 0 };
    const text = "Pasted heading\nPasted body\n";
    const resolved = {
      dsl_spacers: text,
      dsl_styleslices: [
        { stsl_type: "text", stsl_styles: [{ ts_bd: false, ts_fs: 16, ts_ff: "Arial", ts_it: false, ts_un: false, ts_st: false, ts_sc: false, ts_va: "nor", ts_tw: 400, ts_fgc2: { hclr_color: "#000000" }, ts_bgc2: { hclr_color: null } }, ...Array(14).fill(null), { ts_bd: false, ts_fs: 11, ts_ff: "Arial", ts_it: false, ts_un: false, ts_st: false, ts_sc: false, ts_va: "nor", ts_tw: 400, ts_fgc2: { hclr_color: "#000000" }, ts_bgc2: { hclr_color: "#ffff00" } }] },
        { stsl_type: "paragraph", stsl_styles: [...Array(14).fill(null), heading, ...Array(11).fill(null), normal] },
        { stsl_type: "list", stsl_styles: [...Array(14).fill(null), { ls_id: null }, ...Array(11).fill(null), { ls_id: null }] },
      ],
    };
    await app.paste({ slice: JSON.stringify({ data: JSON.stringify({ resolved }) }), text });
    // The paragraph the paste began in ends with the pasted heading's newline: it is the heading now.
    // What came after the cursor stays a paragraph of its own, in its own format.
    await expect.poll(async () => (await app.paragraphs()).filter((p) => /Pasted|whole program/.test(p.text)).map((p) => [p.text, p.style])).toEqual([
      ["Closing thoughts on Pasted heading", "h2"],
      ["Pasted body", "normal"],
      ["the whole program.", "normal"],
    ]);
    // Only the pasted text is new: the document's own text doesn't glow
    expect(await app.pending()).toEqual(["Pasted heading", "Pasted body"]);
  });
  test("a copy with a table, an image and a chip takes each paragraph's format from Docs' own copy, and the table, image and chip from the HTML", async ({ app, api, page }) => {
    const mixed = mixedCopy();
    const outline = async () => ((await app.json()).content as EditorNode[]).map((n) => {
      const text = (x: EditorNode): string => x.type === "text" ? x.text ?? "" : x.type === "image" ? "<image>" : (x.content ?? []).map(text).join(x.type === "paragraph" ? "" : "|");
      const size = (n.content ?? []).flatMap((c) => c.marks ?? []).find((m) => m.type === "textStyle" && m.attrs?.fontSize)?.attrs?.fontSize ?? null;
      return [n.type, text(n), n.attrs?.styleName ?? null, n.attrs?.textAlign ?? null, n.attrs?.preset ?? null, size];
    });
    await openEmpty(app, api, page);
    await app.paste(mixed);
    await expect.poll(outline).toEqual([
      ["paragraph", "Report", "h1", null, null, null],
      ["table", "Name|Score|Ada|90", null, null, null, null],
      ["paragraph", "After", "normal", null, null, 14],
      ["paragraph", "Logo <image>", "normal", "center", null, null],
      ["paragraph", "Due Nov 6, 2026 soon", "normal", null, null, null],
      // Docs' copy says its bullet is a star; the HTML says only "disc"
      ["paragraph", "Star item", "normal", null, "BULLET_STAR_CIRCLE_SQUARE", null],
      ["paragraph", "Last", "normal", null, null, null],
      ["paragraph", "", "normal", null, null, null],
    ]);
    // The same copy without Docs' own (Safari): the HTML's bullet
    await page.evaluate(() => window.ssEditor!.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] }));
    await page.evaluate(() => window.ssEditor!.chain().focus().setTextSelection(1).run());
    await app.paste({ html: mixed.html, text: mixed.text });
    await expect.poll(async () => (await outline()).find((r) => r[1] === "Star item")?.[4]).toBe("BULLET_DISC_CIRCLE_SQUARE");
  });
  test("a copy that ends with a table, pasted into a paragraph, leaves the paragraph's rest after the table with its own format", async ({ app, api, page }) => {
    const mixed = mixedCopy({ tableLast: true });
    await openEmpty(app, api, page);
    await page.evaluate(() => {
      const ed = window.ssEditor!;
      ed.commands.setContent({ type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "right" }, content: [{ type: "text", text: "Before after" }] }] });
      ed.chain().focus().setTextSelection(8).run();
    });
    await app.paste(mixed);
    const outline = async () => ((await app.json()).content as EditorNode[]).map((n) => {
      const text = (x: EditorNode): string => x.type === "text" ? x.text ?? "" : x.type === "image" ? "<image>" : (x.content ?? []).map(text).join(x.type === "paragraph" ? "" : "|");
      return [n.type, text(n), n.attrs?.styleName ?? null, n.attrs?.textAlign ?? null, n.attrs?.preset ?? null];
    });
    await expect.poll(outline).toEqual([
      // The paragraph pasted into ends with the copy's first newline, and takes its format
      ["paragraph", "Before Report", "h1", null, null],
      ["table", "Name|Score|Ada|90", null, null, null],
      ["paragraph", "After", "normal", null, null],
      ["paragraph", "Logo <image>", "normal", "center", null],
      ["paragraph", "Due Nov 6, 2026 soon", "normal", null, null],
      ["paragraph", "Star item", "normal", null, "BULLET_STAR_CIRCLE_SQUARE"],
      ["table", "Total|90", null, null, null],
      ["paragraph", "after", "normal", "right", null],
    ]);
    // Into an empty paragraph: it is what follows the table, still with its own format
    await page.evaluate(() => {
      const ed = window.ssEditor!;
      ed.commands.setContent({ type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "right" } }] });
      ed.chain().focus().setTextSelection(1).run();
    });
    await app.paste(mixed);
    await expect.poll(async () => (await outline()).slice(-2)).toEqual([["table", "Total|90", null, null, null], ["paragraph", "", "normal", "right", null]]);
  });
});
