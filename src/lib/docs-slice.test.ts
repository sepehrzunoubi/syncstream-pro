import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeSliceWithHtml, readDocsSlice, readDocsSliceParts, sliceParagraphs } from "./docs-slice";
import { clip, mixedCopy, ps, ts } from "./docs-slice.testing";
import { listLabels, presetForLevels } from "./list-labels";
import type { DocDefaults } from "./doc-import";
import type { EditorNode } from "./rich-text";

const FIXTURES = path.join(__dirname, "..", "..", "fixtures", "clipboard");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const ARIAL: DocDefaults = { fontFamily: "Arial", fontSize: 11, lineSpacing: 115, styles: {} };

const texts = (nodes: EditorNode[]) => nodes.map((n) => (n.content ?? []).map((c) => c.text ?? (c.type === "hardBreak" ? "\n" : "")).join(""));
const mark = (n: EditorNode, type: string) => (n.content ?? []).flatMap((c) => c.marks ?? []).find((m) => m.type === type);

test("the reference document's copy reads paragraph for paragraph", () => {
  const plain = fixture("web-structured-data.txt");
  const slice = readDocsSlice(fixture("web-structured-data.slice.json"), plain);
  assert.ok(slice);
  assert.equal(slice.endsWithParagraph, true);
  const nodes = sliceParagraphs(slice, ARIAL);
  // 45 paragraphs, the last two empty, exactly the copied text
  assert.equal(nodes.length, 45);
  assert.equal(texts(nodes).join("\n") + "\n", plain);
  assert.deepEqual(texts(nodes).slice(-2), ["", ""]);

  const [title, intro, first] = nodes;
  assert.equal(title.attrs?.styleName, "h1");
  assert.deepEqual(title.attrs?.box, { start: 0, first: 0, above: 20, below: 6 });
  assert.deepEqual(mark(title, "highlight")?.attrs, { color: "#fff2cc" });
  // Text in the destination's own font and size carries no font or size of its own
  assert.equal(mark(intro, "textStyle"), undefined);
  assert.equal(first.attrs?.list, "bullet");
  assert.equal(first.attrs?.preset, "BULLET_DISC_CIRCLE_SQUARE");
  assert.deepEqual(first.attrs?.box, { start: 36, marker: -18, above: 0, below: 0 });
  assert.deepEqual(mark(first, "highlight")?.attrs, { color: "#d9ead3" });

  // Every list item at its level, its indent from the copy
  const levels = nodes.filter((n) => n.attrs?.list).map((n) => n.attrs?.level);
  assert.deepEqual(levels, [0, 1, 2, 1, 2, 1, 2, 0, 1, 2, 2, 1, 2, 2, 1, 2, 2, 3, 0, 1, 1, 1, 1, 2, 2, 2, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1]);
  for (const n of nodes.filter((x) => x.attrs?.list)) assert.equal((n.attrs?.box as { start: number }).start, 36 * ((n.attrs?.level as number) + 1));

  // The link, underlined and in Docs' link colour, as copied
  const linked = nodes.flatMap((n) => n.content ?? []).find((c) => c.marks?.some((m) => m.type === "link"));
  assert.equal(linked?.text, "Contextbase ");
  assert.ok(linked?.marks?.some((m) => m.type === "underline"));
  assert.ok(linked?.marks?.some((m) => m.type === "textStyle" && m.attrs?.color === "#1155cc"));
  // Underlined text that isn't a link
  const under = nodes.flatMap((n) => n.content ?? []).find((c) => c.text === "agent search APIs");
  assert.deepEqual(under?.marks?.map((m) => m.type), ["underline"]);
});

test("against another document's styles, what differs from them becomes formatting", () => {
  const slice = readDocsSlice(fixture("web-structured-data.slice.json"))!;
  const nodes = sliceParagraphs(slice, { fontFamily: "Times New Roman", fontSize: 12, lineSpacing: 100, styles: {} });
  assert.deepEqual(mark(nodes[1], "textStyle")?.attrs, { fontFamily: "Arial", fontSize: 11, color: null, fontWeight: null });
  assert.equal(nodes[1].attrs?.lineSpacing, 115);
});

test("a copy whose text/plain disagrees isn't trusted", () => {
  assert.equal(readDocsSlice(fixture("web-structured-data.slice.json"), "something else"), null);
  assert.ok(readDocsSlice(clip("Hello\n"), "Hello\r\n"));
  assert.ok(readDocsSlice(clip("a\u00a0b\n"), "a b"));
});

test("tables, images, equations and suggestions are left to the HTML", () => {
  assert.equal(readDocsSlice(clip("\u0010\u0012\u001ccell\n\u0011\n")), null);
  assert.equal(readDocsSlice(clip("a*\n", {}, { dsl_entitypositionmap: { inline: [null, { id: "kix.img" }] }, dsl_entitytypemap: { "kix.img": "inline" } })), null);
  assert.equal(readDocsSlice(clip("x\n", {}, { dsl_suggestedinsertions: { sgsl_sugg: [["s1"]] } })), null);
  assert.equal(readDocsSlice("not json"), null);
  assert.equal(readDocsSlice(JSON.stringify({ data: "{}" })), null);
});

test("headings, title and subtitle, alignment, spacing and direction", () => {
  const text = "T\nS\nH3\nC\nR\nJ\n";
  const p = (i: number) => text.split("").reduce((at, ch, k) => (ch === "\n" ? [...at, k] : at), [] as number[])[i];
  const slice = readDocsSlice(clip(text, { paragraph: {
    [p(0)]: ps({ ps_hd: 100 }),
    [p(1)]: ps({ ps_hd: 101 }),
    [p(2)]: ps({ ps_hd: 3, ps_sb: 16, ps_sa: 4 }),
    [p(3)]: ps({ ps_al: 1, ps_ls: 2 }),
    [p(4)]: ps({ ps_al: 2, ps_ltr: false, ps_ir: 18 }),
    [p(5)]: ps({ ps_al: 3, ps_il: 36, ps_ifl: 72 }),
  } }))!;
  const nodes = sliceParagraphs(slice, ARIAL);
  assert.deepEqual(nodes.map((n) => n.attrs?.styleName), ["title", "subtitle", "h3", "normal", "normal", "normal"]);
  // A right-to-left paragraph's END is its left side (Docs' HTML of the same copy says text-align: left)
  assert.deepEqual(nodes.map((n) => n.attrs?.textAlign), [null, null, null, "center", "left", "justify"]);
  assert.deepEqual(nodes.map((n) => n.attrs?.dir ?? null), [null, null, null, null, "rtl", null]);
  assert.equal(nodes[3].attrs?.lineSpacing, 200);
  assert.deepEqual(nodes[2].attrs?.box, { start: 0, first: 0, above: 16, below: 4 });
  assert.equal(nodes[4].attrs?.indentEnd, 18);
  assert.deepEqual(nodes[5].attrs?.box, { start: 36, first: 36, above: 0, below: 0 });
});

test("text styles: weights, small caps, offsets, colours, and what's inherited", () => {
  const text = "bold light caps sup red named\n";
  const at = (w: string) => text.indexOf(w);
  const slice = readDocsSlice(clip(text, { text: {
    [at("bold")]: ts({ ts_bd: true }),
    [at("light")]: ts({ ts_ff: "Roboto", ts_tw: 300 }),
    [at("caps")]: ts({ ts_sc: true }),
    [at("sup")]: ts({ ts_va: "sup" }),
    [at("red")]: ts({ ts_fgc2: { clr_type: 0, hclr_color: "#FF0000" }, ts_bgc2: { clr_type: 0, hclr_color: "#ffff00" } }),
    // Inherited: takes the destination's named style, whatever the copy says
    [at("named")]: ts({ ts_fs: 30, ts_ff: "Comic Sans MS" }, ["*"]),
  } }))!;
  const [p] = sliceParagraphs(slice, ARIAL);
  const run = (w: string) => p.content!.find((c) => c.text?.startsWith(w))!;
  assert.deepEqual(run("bold").marks?.map((m) => m.type), ["bold"]);
  assert.deepEqual(run("light").marks, [{ type: "textStyle", attrs: { fontFamily: "Roboto", fontSize: null, color: null, fontWeight: 300 } }]);
  assert.deepEqual(run("caps").marks?.map((m) => m.type), ["smallCaps"]);
  assert.deepEqual(run("sup").marks?.map((m) => m.type), ["superscript"]);
  assert.deepEqual(run("red").marks, [{ type: "highlight", attrs: { color: "#ffff00" } }, { type: "textStyle", attrs: { fontFamily: null, fontSize: null, color: "#ff0000", fontWeight: null } }]);
  assert.equal(run("named").marks, undefined);
});

test("line breaks inside a paragraph, tabs, and a copy that ends mid-paragraph", () => {
  const slice = readDocsSlice(clip("one\u000btwo\tthree\npartial"))!;
  assert.equal(slice.endsWithParagraph, false);
  const nodes = sliceParagraphs(slice, ARIAL);
  assert.deepEqual(nodes[0].content?.map((c) => c.type), ["text", "hardBreak", "text"]);
  assert.equal(nodes[0].content?.[2].text, "two\tthree");
  assert.deepEqual(texts(nodes), ["one\ntwo\tthree", "partial"]);
});

test("pasted lists take the closest Docs list style, numbered from one", () => {
  const level = (gt: number, gf: string, gs = "", sn = 1) => ({ b_gt: gt, b_gf: gf, b_gs: gs, b_sn: sn, b_il: 36, b_ifl: 18, b_a: 0 });
  const entity = (levels: object[]) => ({ le_nb: Object.fromEntries(levels.map((l, i) => [`nl_${i}`, l])) });
  const text = "one\ntwo\nthree\nx\ny\n";
  const nl = [3, 7, 13, 15, 17];
  const slice = readDocsSlice(clip(text, { list: {
    [nl[0]]: { ls_id: "kix.num", ls_nest: 0 },
    [nl[1]]: { ls_id: "kix.num", ls_nest: 1 },
    [nl[2]]: { ls_id: "kix.num", ls_nest: 0 },
    [nl[3]]: { ls_id: "kix.star", ls_nest: 0 },
    [nl[4]]: { ls_id: "kix.star", ls_nest: 0 },
  } }, {
    dsl_entitymap: {
      "kix.num": entity([level(12, "%0)", "", 5), level(13, "%1)"), level(15, "%2)")]),
      "kix.star": entity([level(9, "%0", "★"), level(9, "%1", "○"), level(9, "%2", "■")]),
    },
    dsl_entitytypemap: { "kix.num": "list", "kix.star": "list" },
  }))!;
  const nodes = sliceParagraphs(slice, ARIAL);
  assert.deepEqual(nodes.map((n) => [n.attrs?.list, n.attrs?.level, n.attrs?.preset, n.attrs?.listId, n.attrs?.glyph]), [
    ["ordered", 0, "NUMBERED_UPPERALPHA_ALPHA_ROMAN", null, null],
    ["ordered", 1, "NUMBERED_UPPERALPHA_ALPHA_ROMAN", null, null],
    ["ordered", 0, "NUMBERED_UPPERALPHA_ALPHA_ROMAN", null, null],
    ["bullet", 0, "BULLET_STAR_CIRCLE_SQUARE", null, null],
    ["bullet", 0, "BULLET_STAR_CIRCLE_SQUARE", null, null],
  ]);
});

test("a list that numbers one level and bullets the others, and a checklist, each pasted as Docs draws them", () => {
  const level = (gt: number, gf: string, gs = "") => ({ b_gt: gt, b_gf: gf, b_gs: gs, b_sn: 1, b_il: 36, b_ifl: 18, b_a: 0 });
  const entity = (levels: object[]) => ({ le_nb: Object.fromEntries(levels.map((l, i) => [`nl_${i}`, l])) });
  // As the corpus's "lists" document has them: a bulleted list whose level 3 is numbered, and a checklist (glyph type 17)
  const text = "a\nb\nc\nd\nnumbered\ne\ntodo one\ntodo two\n";
  const ends = [...text].flatMap((ch, i) => (ch === "\n" ? [i] : []));
  const nest = [0, 1, 2, 2, 3, 0];
  const list: Record<number, object> = {};
  ends.forEach((at, k) => { list[at] = k < 6 ? { ls_id: "kix.mixed", ls_nest: nest[k] } : { ls_id: "kix.check", ls_nest: 0 }; });
  const slice = readDocsSlice(clip(text, { list }, {
    dsl_entitymap: {
      "kix.mixed": entity([level(9, "%0", "●"), level(9, "%1", "○"), level(9, "%2", "■"), level(10, "%3."), level(9, "%4", "○")]),
      "kix.check": entity([level(17, "%0"), level(17, "%1"), level(17, "%2")]),
    },
    dsl_entitytypemap: { "kix.mixed": "list", "kix.check": "list" },
  }))!;
  const nodes = sliceParagraphs(slice, ARIAL);
  assert.deepEqual(nodes.map((n) => [n.attrs?.list, n.attrs?.level, n.attrs?.preset]), [
    ["bullet", 0, "BULLET_DISC_CIRCLE_SQUARE"],
    ["bullet", 1, "BULLET_DISC_CIRCLE_SQUARE"],
    ["bullet", 2, "BULLET_DISC_CIRCLE_SQUARE"],
    ["bullet", 2, "BULLET_DISC_CIRCLE_SQUARE"],
    // Its own kind of list, in the style that numbers level 3 "1.", as the copy does
    ["ordered", 3, "NUMBERED_DECIMAL_ALPHA_ROMAN"],
    ["bullet", 0, "BULLET_DISC_CIRCLE_SQUARE"],
    ["check", 0, "BULLET_CHECKBOX"],
    ["check", 0, "BULLET_CHECKBOX"],
  ]);
  assert.deepEqual(listLabels(nodes.map((n) => n.attrs ?? {})), ["●", "○", "■", "■", "1.", "●", null, null]);
});

test("an older document's list presets (glyph codes 0-7, no symbol or format) are its bullets and numbers", () => {
  // As chicago-guide copies: legacy codes with empty symbol and format fields
  const level = (gt: number) => ({ b_gt: gt, b_gf: "", b_gs: "", b_sn: 1, b_il: 36, b_ifl: 18, b_a: 0 });
  const entity = (codes: number[]) => ({ le_nb: Object.fromEntries(codes.map((c, i) => [`nl_${i}`, level(c)])) });
  const text = "disc\ncircle\nsquare\none\nletter\nroman\n";
  const ends = [...text].flatMap((ch, i) => (ch === "\n" ? [i] : []));
  const list: Record<number, object> = {};
  ends.forEach((at, k) => { list[at] = k < 3 ? { ls_id: "kix.old", ls_nest: k } : { ls_id: "kix.oldnum", ls_nest: k - 3 }; });
  const slice = readDocsSlice(clip(text, { list }, {
    dsl_entitymap: { "kix.old": entity([0, 1, 2]), "kix.oldnum": entity([3, 5, 7]) },
    dsl_entitytypemap: { "kix.old": "list", "kix.oldnum": "list" },
  }))!;
  const nodes = sliceParagraphs(slice, ARIAL);
  assert.deepEqual(nodes.map((n) => [n.attrs?.list, n.attrs?.level]), [["bullet", 0], ["bullet", 1], ["bullet", 2], ["ordered", 0], ["ordered", 1], ["ordered", 2]]);
  assert.deepEqual(listLabels(nodes.map((n) => n.attrs ?? {})), ["●", "○", "■", "1.", "a.", "i."]);
});

test("a weighted font is its family and its weight", () => {
  // Docs copies Lexend Light as "Lexend;300", its weight field saying 400
  const slice = readDocsSlice(clip("light text\n", { text: { 0: ts({ ts_ff: "Lexend;300", ts_fs: 12 }) } }))!;
  const [p] = sliceParagraphs(slice, ARIAL);
  assert.deepEqual(p.content![0].marks, [{ type: "textStyle", attrs: { fontFamily: "Lexend", fontSize: 12, color: null, fontWeight: 300 } }]);
});

test("presetForLevels weighs the levels a list uses", () => {
  assert.equal(presetForLevels("bullet", [{ symbol: "●" }, { symbol: "○" }, { symbol: "■" }]), "BULLET_DISC_CIRCLE_SQUARE");
  assert.equal(presetForLevels("bullet", [{ symbol: "\u2756" }, { symbol: "\u27a2" }, { symbol: "■" }], [3, 1]), "BULLET_DIAMONDX_ARROW3D_SQUARE");
  assert.equal(presetForLevels("bullet", [{ symbol: "\u2756" }, { symbol: "\u25c7" }, { symbol: "■" }], [3, 1]), "BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE");
  assert.equal(presetForLevels("ordered", [{ type: "DECIMAL", format: "%0." }, { type: "DECIMAL", format: "%0.%1." }], [2, 2]), "NUMBERED_DECIMAL_NESTED");
  assert.equal(presetForLevels("ordered", [{ type: "UPPER_ROMAN", format: "%0." }]), "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL");
  // Nothing alike: Docs' default for the kind
  assert.equal(presetForLevels("bullet", [{ symbol: "\u2713" }]), "BULLET_DISC_CIRCLE_SQUARE");
  assert.equal(presetForLevels("check", []), "BULLET_CHECKBOX");
});

/** The HTML path's nodes for mixedCopy's HTML (as the editor parses it), with what that path adds besides: an empty paragraph, a line of only a line break */
function mixedHtmlNodes(): EditorNode[] {
  const p = (content: EditorNode[], attrs: Record<string, unknown> = {}): EditorNode => ({ type: "paragraph", attrs, content });
  const t = (text: string): EditorNode => ({ type: "text", text });
  const cell = (text: string): EditorNode => ({ type: "tableCell", content: [p([t(text)])] });
  return [
    p([t("Report")], { styleName: "h1" }),
    { type: "table", content: [{ type: "tableRow", content: [cell("Name"), cell("Score")] }, { type: "tableRow", content: [cell("Ada"), cell("90")] }] },
    p([t("After")]),
    p([]),
    p([t("Logo "), { type: "image", attrs: { src: "https://lh7-rt.googleusercontent.com/docsz/mixed-copy-logo" } }], { textAlign: "center" }),
    p([{ type: "hardBreak" }]),
    p([t("Due Nov 6, 2026 soon")]),
    p([t("Star item")], { list: "bullet", level: 0, preset: "BULLET_DISC_CIRCLE_SQUARE" }),
    p([t("Last")]),
  ];
}

test("a copy with a table, an image and a chip is read block by block: what the copy reads whole, and where it can't, the HTML's", () => {
  const { slice, text } = mixedCopy();
  assert.equal(readDocsSlice(slice, text), null, "not whole");
  const parts = readDocsSliceParts(slice)!;
  assert.deepEqual(parts.blocks.map((b) => [b.kind, b.exact, b.text]), [
    ["paragraph", true, "Report"],
    ["table", false, "Name\nScore\nAda\n90"],
    ["paragraph", true, "After"],
    ["paragraph", false, "Logo *"],
    ["paragraph", false, "Due  soon"],
    ["paragraph", true, "Star item"],
    ["paragraph", true, "Last"],
  ]);
  const html = mixedHtmlNodes();
  const merged = mergeSliceWithHtml(parts, sliceParagraphs(parts, ARIAL), html)!;
  assert.ok(merged);
  // One node per block of the copy: the HTML's extra empty lines aren't in it
  assert.deepEqual(merged.map((n) => n.type), ["paragraph", "table", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph"]);
  assert.deepEqual(texts(merged.filter((n) => n.type === "paragraph")), ["Report", "After", "Logo ", "Due Nov 6, 2026 soon", "Star item", "Last"]);
  // The copy's own: the heading, the 14pt, the star bullet
  assert.equal(merged[0].attrs?.styleName, "h1");
  assert.equal(mark(merged[2], "textStyle")?.attrs?.fontSize, 14);
  assert.equal(merged[5].attrs?.preset, "BULLET_STAR_CIRCLE_SQUARE");
  // The HTML's: the table, the image, the chip's text, each with the copy's paragraph format
  assert.equal(merged[1], html[1]);
  assert.deepEqual(merged[3].content?.map((c) => c.type), ["text", "image"]);
  assert.equal(merged[3].attrs?.textAlign, "center");
  assert.equal(merged[4].attrs?.styleName, "normal");
});

test("a copy whose HTML lacks a block, or has it out of order, isn't merged (the HTML is pasted as it is)", () => {
  const { slice } = mixedCopy();
  const parts = readDocsSliceParts(slice)!;
  const nodes = sliceParagraphs(parts, ARIAL);
  const html = mixedHtmlNodes();
  // No table
  assert.equal(mergeSliceWithHtml(parts, nodes, html.filter((n) => n.type !== "table")), null);
  // No chip paragraph
  assert.equal(mergeSliceWithHtml(parts, nodes, html.filter((n) => !texts([n])[0]?.startsWith("Due"))), null);
  // An image on a paragraph of its own, then its credit, where the HTML has only the credit
  const image: (object | null)[] = [null, null, null];
  image[0] = { id: "kix.img" };
  const credit = readDocsSliceParts(clip("*\nImage credit\n", {}, { dsl_entitypositionmap: { inline: image }, dsl_entitytypemap: { "kix.img": "inline" } }))!;
  assert.deepEqual(credit.blocks.map((b) => b.exact), [false, true]);
  const only = [{ type: "paragraph", content: [{ type: "text", text: "Image credit" }] }];
  assert.equal(mergeSliceWithHtml(credit, sliceParagraphs(credit, ARIAL), only), null);
  assert.ok(mergeSliceWithHtml(credit, sliceParagraphs(credit, ARIAL), [{ type: "paragraph", content: [{ type: "image", attrs: { src: "x" } }] }, ...only]));
});

test("images on paragraphs of their own each go with their own image, past an empty line Docs writes as a line break", () => {
  const text = "Intro\n\n*\nCaption\n*\nEnd\n";
  const image: (object | null)[] = Array.from({ length: text.length }, () => null);
  image[text.indexOf("*")] = { id: "kix.a" };
  image[text.lastIndexOf("*")] = { id: "kix.b" };
  const parts = readDocsSliceParts(clip(text, {}, { dsl_entitypositionmap: { inline: image }, dsl_entitytypemap: { "kix.a": "inline", "kix.b": "inline" }, dsl_entitymap: { "kix.a": {}, "kix.b": {} } }))!;
  assert.deepEqual(parts.blocks.map((b) => [b.exact, b.images ?? 0]), [[true, 0], [true, 0], [false, 1], [true, 0], [false, 1], [true, 0]]);
  const p = (...content: EditorNode[]): EditorNode => ({ type: "paragraph", attrs: {}, content });
  const img = (src: string): EditorNode => ({ type: "image", attrs: { src } });
  // <p><br><span><br></span></p> pastes as a paragraph with a line break
  const html = [p({ type: "text", text: "Intro" }), p({ type: "hardBreak" }), p(img("A")), p({ type: "text", text: "Caption" }), p(img("B")), p({ type: "text", text: "End" })];
  const merged = mergeSliceWithHtml(parts, sliceParagraphs(parts, ARIAL), html)!;
  const shape = (n: EditorNode) => (n.content ?? []).map((c) => (c.type === "image" ? `<${c.attrs?.src}>` : c.type === "hardBreak" ? "<br>" : c.text)).join("");
  assert.deepEqual(merged.map(shape), ["Intro", "", "<A>", "Caption", "<B>", "End"]);
  // An image the HTML left out: the empty paragraph in its place, and the rest still lines up
  const without = [p({ type: "text", text: "Intro" }), p({ type: "hardBreak" }), p(), p({ type: "text", text: "Caption" }), p(img("B")), p({ type: "text", text: "End" })];
  assert.deepEqual(mergeSliceWithHtml(parts, sliceParagraphs(parts, ARIAL), without)!.map(shape), ["Intro", "", "", "Caption", "<B>", "End"]);
  // An empty paragraph the HTML has and the copy doesn't, before an image: the image's paragraph is the one with the image
  const one = readDocsSliceParts(clip("Intro\n*\nEnd\n", {}, { dsl_entitypositionmap: { inline: [null, null, null, null, null, null, { id: "kix.a" }] }, dsl_entitytypemap: { "kix.a": "inline" }, dsl_entitymap: { "kix.a": {} } }))!;
  const extra = [p({ type: "text", text: "Intro" }), p(), p(img("A")), p({ type: "text", text: "End" })];
  assert.deepEqual(mergeSliceWithHtml(one, sliceParagraphs(one, ARIAL), extra)!.map(shape), ["Intro", "<A>", "End"]);
});

test("a positioned image, which the copy anchors on the paragraph before, is pasted where the HTML draws it, the paragraphs as the copy has them", () => {
  const text = "Steps\nRight click it\nEnd\n";
  const positioned: (object | null)[] = Array.from({ length: text.length }, () => null);
  positioned[text.indexOf("\n")] = ["kix.pos"];
  const slice = clip(text, { text: { [text.indexOf("Right")]: ts({ ts_fs: 14 }), [text.indexOf("\nEnd")]: ts() } }, {
    dsl_entitypositionmap: { positioned }, dsl_entitytypemap: { "kix.pos": "positioned" }, dsl_entitymap: { "kix.pos": {} },
  });
  assert.equal(readDocsSlice(slice, "Steps\nRight click it\nEnd\n"), null, "the image isn't in the copy's text");
  const parts = readDocsSliceParts(slice)!;
  assert.deepEqual(parts.blocks.map((b) => b.exact), [true, true, true]);
  const p = (...content: EditorNode[]): EditorNode => ({ type: "paragraph", attrs: {}, content });
  const img: EditorNode = { type: "image", attrs: { src: "https://lh7-rt.googleusercontent.com/docsz/pos" } };
  const t = (s: string): EditorNode => ({ type: "text", text: s });
  for (const [drawn, want] of [
    [[img, t("Right click it")], ["image", "Right click it"]],
    [[t("Right "), img, t("click it")], ["Right ", "image", "click it"]],
    [[t("Right click it"), img], ["Right click it", "image"]],
  ] as [EditorNode[], string[]][]) {
    const merged = mergeSliceWithHtml(parts, sliceParagraphs(parts, ARIAL), [p(t("Steps")), p(...drawn), p(t("End"))])!;
    assert.deepEqual(merged[1].content?.map((c) => (c.type === "image" ? "image" : c.text)), want);
    // The copy's own text style, on every piece of the text
    for (const c of merged[1].content!.filter((x) => x.type === "text")) assert.equal(c.marks?.find((m) => m.type === "textStyle")?.attrs?.fontSize, 14);
    assert.deepEqual(texts([merged[0], merged[2]]), ["Steps", "End"]);
  }
});

test("a floating image Docs writes before the <p> it's drawn by goes with that paragraph, not an empty one before it, and every later one is still found", () => {
  const text = "Intro\n\nYou can check\nNext step\nRight click it\nEnd\n";
  const positioned: (object | null)[] = Array.from({ length: text.length }, () => null);
  positioned[text.indexOf("\n\nYou") + 1] = ["kix.a"];
  positioned[text.indexOf("\nRight")] = ["kix.b"];
  const parts = readDocsSliceParts(clip(text, {}, { dsl_entitypositionmap: { positioned }, dsl_entitytypemap: { "kix.a": "positioned", "kix.b": "positioned" }, dsl_entitymap: { "kix.a": {}, "kix.b": {} } }))!;
  const p = (...content: EditorNode[]): EditorNode => ({ type: "paragraph", attrs: {}, content });
  const img = (src: string): EditorNode => ({ type: "image", attrs: { src } });
  const t = (s: string): EditorNode => ({ type: "text", text: s });
  const shape = (n: EditorNode) => (n.content ?? []).map((c) => (c.type === "image" ? `<${c.attrs?.src}>` : c.type === "hardBreak" ? "<br>" : c.text)).join("");
  // ...</p><br><img style="float:right"><p>You can check: the image pastes as a paragraph of its own
  const html = [p(t("Intro")), p(), p(img("A")), p(t("You can check")), p(t("Next step")), p(img("B"), t("Right click it")), p(t("End"))];
  assert.deepEqual(mergeSliceWithHtml(parts, sliceParagraphs(parts, ARIAL), html)!.map(shape), ["Intro", "", "<A>You can check", "Next step", "<B>Right click it", "End"]);
  // One the merge can't place (no paragraph after it) isn't lost: the HTML is pasted as it is
  const last = readDocsSliceParts(clip("Intro\n", {}, { dsl_entitypositionmap: { positioned: [null, null, null, null, null, ["kix.a"]] }, dsl_entitytypemap: { "kix.a": "positioned" }, dsl_entitymap: { "kix.a": {} } }))!;
  assert.equal(mergeSliceWithHtml(last, sliceParagraphs(last, ARIAL), [p(t("Intro")), p(img("A"))]), null);
});

test("an image the HTML draws at the start of a paragraph goes before its spaces, dashes and line breaks", () => {
  const p = (...content: EditorNode[]): EditorNode => ({ type: "paragraph", attrs: {}, content });
  const img: EditorNode = { type: "image", attrs: { src: "https://lh7-rt.googleusercontent.com/docsz/pos" } };
  const t = (s: string): EditorNode => ({ type: "text", text: s });
  const br: EditorNode = { type: "hardBreak" };
  const shape = (n: EditorNode) => (n.content ?? []).map((c) => (c.type === "image" ? "<IMG>" : c.type === "hardBreak" ? "<br>" : c.text)).join("");
  for (const [drawn, want] of [
    [[img, t("- dash item")], "<IMG>- dash item"],
    [[img, t("  indented")], "<IMG>  indented"],
    [[img, t("#1 rule")], "<IMG>#1 rule"],
    [[img, t("---")], "<IMG>---"],
    [[img, br, t("line two")], "<IMG><br>line two"],
    [[t("line one"), br, img, t("two")], "line one<br><IMG>two"],
    [[t("Step 1"), img, t(" - click")], "Step 1<IMG> - click"],
    // Text that differs in its spaces: placed by what isn't a space
    [[t("Step  1 "), img, t("click")], "Step 1 <IMG>click"],
  ] as [EditorNode[], string][]) {
    const own = (drawn.filter((c) => c.type !== "image").map((c) => (c.type === "hardBreak" ? "\u000b" : c.text)).join("")).replace(/  /, " ");
    const text = `Steps\n${own}\nEnd\n`;
    const positioned: (object | null)[] = Array.from({ length: text.length }, () => null);
    positioned[text.indexOf("\n")] = ["kix.pos"];
    const parts = readDocsSliceParts(clip(text, {}, { dsl_entitypositionmap: { positioned }, dsl_entitytypemap: { "kix.pos": "positioned" }, dsl_entitymap: { "kix.pos": {} } }))!;
    const merged = mergeSliceWithHtml(parts, sliceParagraphs(parts, ARIAL), [p(t("Steps")), p(...drawn), p(t("End"))]);
    assert.equal(merged && shape(merged[1]), want, want);
  }
});

test("a page break is read in its paragraph (Docs' text/plain leaves it out), and a section break is no paragraph", () => {
  const slice = readDocsSlice(clip("One\u000ctwo\n\ue905Next\n"), "Onetwo\nNext\n")!;
  assert.ok(slice);
  const nodes = sliceParagraphs(slice, ARIAL);
  assert.deepEqual(nodes[0].content?.map((c) => c.type), ["text", "pageBreak", "text"]);
  assert.deepEqual(texts(nodes), ["Onetwo", "Next"]);
});
