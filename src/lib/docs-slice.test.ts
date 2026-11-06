import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readDocsSlice, sliceParagraphs } from "./docs-slice";
import { listLabels, presetForLevels } from "./list-labels";
import type { DocDefaults } from "./doc-import";
import type { EditorNode } from "./rich-text";

const FIXTURES = path.join(__dirname, "..", "..", "fixtures", "clipboard");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const ARIAL: DocDefaults = { fontFamily: "Arial", fontSize: 11, lineSpacing: 115, styles: {} };

/** A text style as Docs copies it: every value given, none inherited unless asked */
const ts = (o: Record<string, unknown> = {}, inherited: string[] = []) => {
  const base: Record<string, unknown> = { ts_bd: false, ts_fs: 11, ts_ff: "Arial", ts_it: false, ts_sc: false, ts_st: false, ts_tw: 400, ts_un: false, ts_va: "nor", ts_bgc2: { clr_type: 0, hclr_color: null }, ts_fgc2: { clr_type: 0, hclr_color: "#000000" }, ...o };
  for (const k of ["ts_bd", "ts_fs", "ts_ff", "ts_it", "ts_sc", "ts_st", "ts_un", "ts_va", "ts_bgc2", "ts_fgc2"]) base[`${k}_i`] = inherited.includes(k) || inherited.includes("*");
  return base;
};
const ps = (o: Record<string, unknown> = {}) => ({ ps_al: 0, ps_awao: true, ps_hd: 0, ps_ifl: 0, ps_il: 0, ps_ir: 0, ps_klt: false, ps_kwn: false, ps_ltr: true, ps_ls: 1.15, ps_lslm: 1, ps_pbb: false, ps_sm: 0, ps_sa: 0, ps_sb: 0, ...o });

/** A clipboard copy: the text and the style entries at given positions */
function clip(text: string, at: { text?: Record<number, object>; paragraph?: Record<number, object>; list?: Record<number, object>; link?: Record<number, object> } = {}, extra: Record<string, unknown> = {}) {
  const arr = (m: Record<number, object> | undefined) => { const out: (object | null)[] = []; for (const [k, v] of Object.entries(m ?? {})) out[Number(k)] = v; return Array.from(out, (x) => x ?? null); };
  // Every paragraph has a paragraph style and a list entry, as Docs writes them
  const paragraph = { ...at.paragraph };
  const list = { ...at.list };
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") { paragraph[i] ??= ps(); list[i] ??= { ls_nest: 0, ls_id: null }; }
  const resolved = {
    dsl_spacers: text,
    dsl_styleslices: [
      { stsl_type: "text", stsl_styles: arr({ 0: ts(), ...at.text }) },
      { stsl_type: "paragraph", stsl_styles: arr(paragraph) },
      { stsl_type: "list", stsl_styles: arr(list) },
      { stsl_type: "link", stsl_styles: arr({ 0: { lnks_link: null }, ...at.link }) },
      { stsl_type: "tbl", stsl_styles: [] },
    ],
    dsl_entitymap: {},
    dsl_entitytypemap: {},
    dsl_entitypositionmap: {},
    ...extra,
  };
  return JSON.stringify({ dih: 0, data: JSON.stringify({ resolved, autotext_content: {} }), dct: "kix" });
}

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
  assert.deepEqual(nodes.map((n) => n.attrs?.textAlign), [null, null, null, "center", "right", "justify"]);
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
  assert.equal(presetForLevels("bullet", [{ symbol: "❖" }, { symbol: "➢" }, { symbol: "■" }], [3, 1]), "BULLET_DIAMONDX_ARROW3D_SQUARE");
  assert.equal(presetForLevels("bullet", [{ symbol: "❖" }, { symbol: "◇" }, { symbol: "■" }], [3, 1]), "BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE");
  assert.equal(presetForLevels("ordered", [{ type: "DECIMAL", format: "%0." }, { type: "DECIMAL", format: "%0.%1." }], [2, 2]), "NUMBERED_DECIMAL_NESTED");
  assert.equal(presetForLevels("ordered", [{ type: "UPPER_ROMAN", format: "%0." }]), "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL");
  // Nothing alike: Docs' default for the kind
  assert.equal(presetForLevels("bullet", [{ symbol: "✓" }]), "BULLET_DISC_CIRCLE_SQUARE");
  assert.equal(presetForLevels("check", []), "BULLET_CHECKBOX");
});
