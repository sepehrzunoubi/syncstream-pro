import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { importPdf, PdfImportError, type PdfImportResult } from "./pdf-import";
import { docsFont } from "./pdf-fonts";
import { parseMarker } from "./pdf-lists";
import { getSchema } from "@tiptap/core";
import { PENDING_MARK } from "./doc-model";
import type { EditorNode } from "./rich-text";
import { editorExtensions } from "../components/workspace/extensions";

// Synthetic PDFs made by Chromium (scripts/pdf-eval/make-fixtures.ts), each tagged and untagged
const FIXTURES = path.join(process.cwd(), "fixtures", "pdf");
const cache = new Map<string, Promise<PdfImportResult>>();
const load = (name: string, opts?: { maxPages?: number }) => {
  if (opts) return importPdf(new Uint8Array(fs.readFileSync(path.join(FIXTURES, `${name}.pdf`))), opts);
  if (!cache.has(name)) cache.set(name, importPdf(new Uint8Array(fs.readFileSync(path.join(FIXTURES, `${name}.pdf`)))));
  return cache.get(name)!;
};
const BOTH = ["tagged", "untagged"] as const;

const textOf = (n: EditorNode): string => (n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? "\n" : n.type === "image" ? "\uFFFC" : (n.content ?? []).map(textOf).join(""));
const paragraphs = (r: PdfImportResult) => r.nodes.filter((n) => n.type === "paragraph" && textOf(n).trim());
const find = (r: PdfImportResult, text: string) => {
  const p = r.nodes.find((n) => n.type === "paragraph" && textOf(n).includes(text));
  assert.ok(p, `no paragraph with "${text}"`);
  return p;
};
/** The text node carrying exactly this text in a paragraph */
const run = (p: EditorNode, text: string) => {
  const t = (p.content ?? []).find((c) => c.type === "text" && c.text === text);
  assert.ok(t, `no run "${text}" in "${textOf(p)}" (runs: ${(p.content ?? []).map((c) => JSON.stringify(c.text)).join(", ")})`);
  return t;
};
const has = (n: EditorNode, mark: string) => (n.marks ?? []).some((m) => m.type === mark);
const style = (n: EditorNode) => (n.marks ?? []).find((m) => m.type === "textStyle")?.attrs ?? {};
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

/** Every character, image and page break is a pending addition */
function assertAllPending(nodes: EditorNode[]) {
  const walk = (n: EditorNode) => {
    if (n.type === "text" || n.type === "image" || n.type === "pageBreak" || n.type === "hardBreak") assert.ok(has(n, PENDING_MARK), `${n.type} ${JSON.stringify(n.text ?? "")} is not pending`);
    for (const c of n.content ?? []) walk(c);
  };
  nodes.forEach(walk);
}

for (const v of BOTH) {
  test(`styles (${v}): text, headings, fonts, sizes, colours, marks and alignment`, async () => {
    const r = await load(`styles-${v}`);
    assert.equal(r.tagged, v === "tagged");
    assert.equal(r.pages, 1);
    assert.equal(r.pageSetup.paper, "letter");
    for (const side of ["top", "bottom", "left", "right"] as const) near(r.pageSetup.margins[side], 72, 6, `margin ${side}`);
    assert.deepEqual(paragraphs(r).map(textOf), [
      "Quarterly report",
      "Summary of the year",
      "Plain text with bold, italic, underlined, struck, red and highlighted words, x2 and H2O.",
      "A centered line.",
      "A line on the right.",
      "This paragraph is justified and long enough to wrap across several lines, so the space between its words stretches on every line but the last one, which is how justified text shows itself.",
      "Courier New line.",
      "Times New Roman in blue at fourteen points.",
      "Calibri line.",
      "Read the guide or write to us.",
      "An indented paragraph.",
      "A first-line indent: this paragraph is long enough to wrap onto a second line, which starts at the margin again.",
      "Double spaced: this paragraph is long enough to wrap onto a second and a third line, so its line pitch can be measured from the lines it has, as the pitch of any paragraph can be, however wide its spacing is.",
      // Drawn letter by letter with wide gaps, read as words
      "Spaced letters",
    ]);
    assertAllPending(r.nodes);

    const h1 = find(r, "Quarterly report");
    assert.equal(h1.attrs?.styleName, "h1");
    assert.ok(has(h1.content![0], "bold"));
    assert.deepEqual(style(h1.content![0]), { fontFamily: "Arial", fontSize: 20, color: "#000000", fontWeight: null });
    const h2 = find(r, "Summary of the year");
    assert.equal(h2.attrs?.styleName, "h2");
    assert.deepEqual(style(h2.content![0]), { fontFamily: "Times New Roman", fontSize: 16, color: "#434343", fontWeight: null });

    const p = find(r, "Plain text with");
    assert.ok(has(run(p, "bold"), "bold"));
    assert.ok(has(run(p, "italic"), "italic"));
    assert.ok(has(run(p, "underlined"), "underline"));
    assert.ok(has(run(p, "struck"), "strike"));
    assert.equal(style(run(p, "red ")).color, "#cc0000");
    const hl = run(p, "highlighted");
    assert.equal(hl.marks?.find((m) => m.type === "highlight")?.attrs?.color, "#ffff00");
    const sups = (p.content ?? []).filter((c) => c.text === "2");
    assert.equal(sups.length, 2);
    assert.ok(has(sups[0], "superscript"));
    assert.ok(has(sups[1], "subscript"));
    // A superscript keeps its text's size, as Docs has it (Docs draws it smaller)
    assert.equal(style(sups[0]).fontSize, 11);

    assert.equal(find(r, "A centered line.").attrs?.textAlign, "center");
    assert.equal(find(r, "A line on the right.").attrs?.textAlign, "right");
    assert.equal(find(r, "This paragraph is justified").attrs?.textAlign, "justify");
    assert.equal(find(r, "Plain text with").attrs?.textAlign, null);
    assert.equal(style(find(r, "Courier New line.").content![0]).fontFamily, "Courier New");
    assert.deepEqual(style(find(r, "Times New Roman in blue").content![0]), { fontFamily: "Times New Roman", fontSize: 14, color: "#1155cc", fontWeight: null });
    // Chromium drew Calibri with Carlito, its metric twin: it goes back to Calibri
    assert.equal(style(find(r, "Calibri line.").content![0]).fontFamily, "Calibri");

    const links = find(r, "Read the guide");
    assert.equal(run(links, "the guide").marks?.find((m) => m.type === "link")?.attrs?.href, "https://example.com/docs?id=7");
    assert.equal(run(links, "write to us").marks?.find((m) => m.type === "link")?.attrs?.href, "mailto:team@example.com");
    assert.ok(!has(run(links, "Read "), "link"));
    assert.equal((find(r, "An indented paragraph.").attrs?.box as { start: number }).start, 36);
    assert.deepEqual(find(r, "A first-line indent").attrs?.box, { start: 0, first: 36, above: 7.5, below: 0 });
    // Line spacing as Docs measures it: CSS line-height 2 is 1.74 of Arial's natural line height
    near(find(r, "Double spaced").attrs?.lineSpacing as number, 174, 3, "double spacing");
    assert.equal(find(r, "Courier New line.").attrs?.lineSpacing, 100);
    // Space between paragraphs: CSS gave each 8 pt below
    near((find(r, "Courier New line.").attrs?.box as { above: number }).above, 8, 1.5, "space above");
    assert.deepEqual(r.fonts, ["Arial", "Calibri", "Courier New", "Times New Roman"]);
    assert.equal(r.stats.headings, 2);
    assert.equal(r.stats.links, 2);
  });

  test(`lists (${v}): nested bullets and numbers, levels and Docs list styles`, async () => {
    const r = await load(`lists-${v}`);
    const items = r.nodes.filter((n) => n.attrs?.list).map((n) => [textOf(n), n.attrs!.list, n.attrs!.level, n.attrs!.preset]);
    assert.deepEqual(items, [
      ["Apples", "bullet", 0, "BULLET_DISC_CIRCLE_SQUARE"],
      ["Bread", "bullet", 0, "BULLET_DISC_CIRCLE_SQUARE"],
      ["White", "bullet", 1, "BULLET_DISC_CIRCLE_SQUARE"],
      ["Rye", "bullet", 1, "BULLET_DISC_CIRCLE_SQUARE"],
      ["Dark rye", "bullet", 2, "BULLET_DISC_CIRCLE_SQUARE"],
      ["Milk", "bullet", 0, "BULLET_DISC_CIRCLE_SQUARE"],
      ["Open the lid", "ordered", 0, "NUMBERED_DECIMAL_ALPHA_ROMAN"],
      ["Pour the water", "ordered", 0, "NUMBERED_DECIMAL_ALPHA_ROMAN"],
      ["Cold water", "ordered", 1, "NUMBERED_DECIMAL_ALPHA_ROMAN"],
      ["Warm water", "ordered", 1, "NUMBERED_DECIMAL_ALPHA_ROMAN"],
      ["Not hot", "ordered", 2, "NUMBERED_DECIMAL_ALPHA_ROMAN"],
      ["Not boiling", "ordered", 2, "NUMBERED_DECIMAL_ALPHA_ROMAN"],
      ["Close the lid", "ordered", 0, "NUMBERED_DECIMAL_ALPHA_ROMAN"],
    ]);
    // Lists look like the editor's own: no Docs list ids or glyph descriptions
    for (const n of r.nodes.filter((x) => x.attrs?.list)) {
      assert.equal(n.attrs!.listId, undefined);
      assert.equal(n.attrs!.glyph, undefined);
      const box = n.attrs!.box as { start: number; marker: number };
      near(box.start, 30 * ((n.attrs!.level as number) + 1), 1.5, `indent of ${textOf(n)}`);
      assert.ok(box.marker < 0);
    }
    assert.deepEqual(r.nodes.filter((n) => !n.attrs?.list && textOf(n)).map(textOf), ["Shopping:", "Steps:", "Done."]);
    assert.equal(r.stats.listItems, 13);
    assertAllPending(r.nodes);
  });

  test(`table (${v}): rows, a merged cell, backgrounds and column widths`, async () => {
    const r = await load(`table-${v}`);
    const tables = r.nodes.filter((n) => n.type === "table");
    assert.equal(tables.length, 1);
    const rows = tables[0].content!;
    assert.deepEqual(rows.map((row) => row.content!.map(textOf)), [["Name", "Role", "Score"], ["Alice", "Engineer", "93"], ["Merged two columns", "88"]]);
    const [head, , last] = rows;
    for (const c of head.content!) assert.equal(c.attrs?.background, "#cfe2f3");
    assert.equal(last.content![0].attrs?.colspan, 2);
    assert.equal(last.content![0].attrs?.background, "#d9ead3");
    assert.equal(last.content![1].attrs?.background, null);
    // Column widths in pixels, from the rules: 90 + 12 pt padding, 120 + 12, 60 + 12, borders shared
    const widths = head.content!.map((c) => (c.attrs?.colwidth as number[])[0]);
    near(widths[0], 137, 2, "first column");
    near(widths[1], 177, 2, "second column");
    near(widths[2], 97, 2, "third column");
    assert.deepEqual(last.content![0].attrs?.colwidth, [widths[0], widths[1]]);
    // Cell text keeps its look
    assert.ok(has(head.content![0].content![0].content![0], "bold"));
    assert.deepEqual(paragraphs(r).map(textOf), ["Team scores", "After the table."]);
    assert.equal(r.nodes.indexOf(tables[0]), r.nodes.indexOf(find(r, "Team scores")) + 1);
    assertAllPending(r.nodes);
  });

  test(`borderless table (${v}): from the structure tree when tagged, as lines of text when not`, async () => {
    const r = await load(`borderless-${v}`);
    if (v === "tagged") {
      const table = r.nodes.find((n) => n.type === "table");
      assert.ok(table);
      assert.deepEqual(table.content!.map((row) => row.content!.map(textOf)), [["Day", "Hours"], ["Monday", "9 to 5"], ["Closed on holidays"]]);
      assert.equal(table.content![1].content![1].attrs?.background, "#fff2cc");
      assert.equal(table.content![2].content![0].attrs?.colspan, 2);
      assert.deepEqual(paragraphs(r).map(textOf), ["Opening hours", "See you soon."]);
    } else {
      // No rules and no tags: nothing says it is a table, so its rows are lines, in order
      assert.deepEqual(paragraphs(r).map(textOf), ["Opening hours", "Day\tHours", "Monday 9 to 5", "Closed on holidays", "See you soon."]);
    }
    assertAllPending(r.nodes);
  });

  test(`images (${v}): an image in a line of text and one on its own, as files`, async () => {
    const r = await load(`images-${v}`);
    assert.equal(r.images.length, 2);
    const [logo, photo] = r.images;
    assert.equal(logo.mime, "image/png");
    assert.deepEqual([logo.width, logo.height], [200, 100]);
    assert.equal(photo.mime, "image/jpeg");
    assert.deepEqual([photo.width, photo.height], [160, 120]);
    assert.deepEqual([...logo.data.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.deepEqual([...photo.data.slice(0, 2)], [0xff, 0xd8]);
    const line = find(r, "The logo");
    assert.equal(textOf(line), "The logo \uFFFC sits in this line.");
    const img = line.content!.find((c) => c.type === "image")!;
    assert.deepEqual(img.attrs, { src: `pdf-image:${logo.key}`, width: 150, height: 75 });
    const own = r.nodes.find((n) => n.content?.length === 1 && n.content[0].type === "image")!;
    assert.equal(own.attrs?.textAlign, "center");
    assert.deepEqual(own.content![0].attrs, { src: `pdf-image:${photo.key}`, width: 160, height: 120 });
    assert.ok(r.nodes.indexOf(own) > r.nodes.indexOf(line) && r.nodes.indexOf(own) < r.nodes.indexOf(find(r, "After the images.")));
    assert.equal(r.stats.images, 2);
    assertAllPending(r.nodes);
  });

  test(`columns (${v}): two columns read one after the other`, async () => {
    const r = await load(`columns-${v}`);
    assert.deepEqual(paragraphs(r).map((n) => textOf(n).slice(0, 30)), [
      "Two columns",
      "The first column starts here a",
      "A second paragraph in the firs",
      "The second column starts at th",
      "The last paragraph of the seco",
    ]);
    assert.ok(textOf(find(r, "The first column")).endsWith("stays clear from top to bottom."));
    assert.ok(r.warnings.some((w) => /columns/.test(w)));
  });

  test(`header and footer (${v}): repeated lines, page numbers left out, page breaks, A4`, async () => {
    const r = await load(`headerfooter-${v}`);
    assert.equal(r.pages, 3);
    assert.equal(r.pageSetup.paper, "a4");
    assert.equal(r.pageSetup.custom, undefined);
    near(r.pageSetup.margins.top, 56.7, 6, "top");
    near(r.pageSetup.margins.bottom, 56.7, 6, "bottom");
    near(r.pageSetup.margins.left, 70.87, 6, "left");
    near(r.pageSetup.margins.right, 70.87, 6, "right");
    assert.deepEqual(r.header?.map(textOf), ["Project Atlas"]);
    assert.equal(r.header?.[0].attrs?.textAlign, "center");
    // The footer is only page numbers, which Docs numbers itself
    assert.equal(r.footer, undefined);
    assert.deepEqual(paragraphs(r).map(textOf), [
      "Page one text. Each page of this document has the same header and a footer with its page number.",
      "Page two text, after a page break.",
      "Page three text, the last page.",
    ]);
    const breaks = r.nodes.filter((n) => n.content?.some((c) => c.type === "pageBreak"));
    assert.equal(breaks.length, 2);
    for (const b of breaks) assert.equal(b.content![b.content!.length - 1].type, "pageBreak");
    assert.ok(!r.nodes.some((n) => /Page \d of/.test(textOf(n))));
    assertAllPending(r.nodes);
    if (r.header) assertAllPending(r.header);
  });

  test(`right to left (${v}): a Hebrew line in reading order`, async () => {
    const r = await load(`rtl-${v}`);
    assert.deepEqual(paragraphs(r).map(textOf), ["An English line first.", "שלום עולם, זו שורה בעברית.", "An English line after."]);
    const he = find(r, "שלום");
    assert.equal(he.attrs?.dir, "rtl");
    assert.equal(he.attrs?.textAlign, null);
    assert.equal(find(r, "An English line first.").attrs?.dir, undefined);
  });
}

test("CJK text in a font the PDF only names: read with pdf.js's character maps", async () => {
  // Japanese in KozMinPr6N-Regular, not embedded, with the UniJIS-UCS2-H character map
  // (scripts/pdf-eval/make-cjk-fixture.mjs). Without pdf.js's character maps the line is dropped.
  const r = await load("cjk-cmap");
  assert.equal(r.pages, 1);
  assert.deepEqual(paragraphs(r).map(textOf), ["Japanese below.", "日本語"]);
  assert.deepEqual(r.warnings, []);
  assertAllPending(r.nodes);
});

test("the content loads into the editor as it is: valid nodes and marks, no attributes it doesn't have", async () => {
  const schema = getSchema(editorExtensions as never);
  for (const name of ["styles", "lists", "table", "borderless", "images", "columns", "headerfooter", "rtl"].flatMap((f) => BOTH.map((v) => `${f}-${v}`))) {
    const r = await load(name);
    // The route swaps image keys for uploaded images' addresses
    const nodes = JSON.parse(JSON.stringify(r.nodes).replace(/"pdf-image:/g, '"https://example.com/'));
    const doc = schema.nodeFromJSON({ type: "doc", content: nodes });
    doc.check();
    const unknown: string[] = [];
    const walk = (n: EditorNode) => {
      const type = n.type ? schema.nodes[n.type] : undefined;
      for (const k of Object.keys(n.attrs ?? {})) if (type && !(k in (type.spec.attrs ?? {}))) unknown.push(`${n.type}.${k}`);
      for (const m of n.marks ?? []) for (const k of Object.keys(m.attrs ?? {})) if (!(k in (schema.marks[m.type]?.spec.attrs ?? {}))) unknown.push(`${m.type}.${k}`);
      (n.content ?? []).forEach(walk);
    };
    nodes.forEach(walk);
    assert.deepEqual(unknown, [], name);
  }
});

test("errors: a password, a damaged file, a scan, a blank PDF, too many pages", async () => {
  const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { assert.ok(e instanceof PdfImportError, String(e)); return e.code; } };
  if (fs.existsSync(path.join(FIXTURES, "encrypted.pdf"))) assert.equal(await code(load("encrypted", {})), "encrypted");
  assert.equal(await code(importPdf(new TextEncoder().encode("not a pdf at all"))), "invalid");
  assert.equal(await code(importPdf(new Uint8Array(0))), "invalid");
  assert.equal(await code(load("scanned", {})), "scanned");
  assert.equal(await code(load("blank", {})), "empty");
  const tooLarge = await importPdf(new Uint8Array(fs.readFileSync(path.join(FIXTURES, "headerfooter-untagged.pdf"))), { maxPages: 2 }).catch((e) => e);
  assert.ok(tooLarge instanceof PdfImportError);
  assert.equal(tooLarge.code, "tooLarge");
  assert.match(tooLarge.message, /3 pages.*up to 2/);
});

test("fonts: PDF font names as Docs families, weights and italics", () => {
  const cases: [string, string, number, boolean][] = [
    ["ABCDEF+Arial-BoldMT", "Arial", 700, false],
    ["TimesNewRomanPS-ItalicMT", "Times New Roman", 400, true],
    ["TimesNewRomanPS-BoldItalicMT", "Times New Roman", 700, true],
    ["LiberationSans", "Arial", 400, false],
    ["Helvetica-BoldOblique", "Arial", 700, true],
    ["Carlito-Bold", "Calibri", 700, false],
    ["Calibri-Light", "Calibri", 300, false],
    ["Georgia-Italic", "Georgia", 400, true],
    ["Roboto-Light", "Roboto", 300, false],
    ["OpenSans-SemiBold", "Open Sans", 600, false],
    ["Lato-Black", "Lato", 900, false],
    ["Montserrat-ExtraBoldItalic", "Montserrat", 800, true],
    ["EBGaramond-Regular", "EB Garamond", 400, false],
    ["AGaramondPro-Regular", "EB Garamond", 400, false],
    ["Courier", "Courier New", 400, false],
    ["Arial,Bold", "Arial", 700, false],
    ["PlayfairDisplay-Bold", "Playfair Display", 700, false],
    ["CMBX12", "Times New Roman", 700, false],
  ];
  for (const [name, family, weight, italic] of cases) assert.deepEqual(docsFont(name), { family, weight, italic }, name);
  // A family Docs doesn't have: the closest kind
  assert.equal(docsFont("BCDEFG+HouseSerif-Regular", { serif: true }).family, "Times New Roman");
  assert.equal(docsFont("HouseMono", { mono: true }).family, "Courier New");
  assert.equal(docsFont("Mystery-Bold").family, "Arial");
  assert.equal(docsFont("Mystery-Bold").weight, 700);
});

test("list markers: bullets and numbering forms", () => {
  const kind = (s: string) => { const m = parseMarker(s); return m && [m.kind, m.glyph.symbol ?? `${m.glyph.type} ${m.glyph.format}`, m.n]; };
  assert.deepEqual(kind("•"), ["bullet", "●", 1]);
  assert.deepEqual(kind("◦"), ["bullet", "○", 1]);
  assert.deepEqual(kind("▪"), ["bullet", "■", 1]);
  assert.deepEqual(kind("–"), ["bullet", "–", 1]);
  assert.deepEqual(kind("☐"), ["check", "☐", 1]);
  assert.deepEqual(kind("3."), ["ordered", "DECIMAL %0.", 3]);
  assert.deepEqual(kind("(2)"), ["ordered", "DECIMAL (%0)", 2]);
  assert.deepEqual(kind("b)"), ["ordered", "ALPHA %0)", 2]);
  assert.deepEqual(kind("C."), ["ordered", "UPPER_ALPHA %0.", 3]);
  assert.deepEqual(kind("iv."), ["ordered", "ROMAN %0.", 4]);
  assert.deepEqual(kind("ii."), ["ordered", "ROMAN %0.", 2]);
  assert.deepEqual(kind("1.2."), ["ordered", "DECIMAL %0.%1.", 2]);
  assert.equal(parseMarker("Hello"), null);
  assert.equal(parseMarker("12"), null);
  assert.equal(parseMarker("(3"), null);
});

test("pdf.js's fonts and character maps are found from the app's folder, as a deployment has them", async () => {
  const { dataDirs } = await import("./pdf-extract");
  const dirs = dataDirs();
  assert.ok(dirs.standardFontDataUrl && fs.existsSync(path.join(dirs.standardFontDataUrl, "LiberationSans-Regular.ttf")), "the standard fonts");
  assert.ok(dirs.cMapUrl && fs.existsSync(path.join(dirs.cMapUrl, "UniJIS-UCS2-H.bcmap")), "the character maps");
});
