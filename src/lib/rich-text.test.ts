import { test } from "node:test";
import assert from "node:assert/strict";
import { FormatIndex, normalizeText, parseFormat, plainFormat, richFromEditorJSON, cssFontToFamily, cssLengthToPt, type EditorNode } from "./rich-text";

const p = (content: EditorNode[], attrs: Record<string, unknown> = {}): EditorNode => ({ type: "paragraph", attrs, content });
const t = (text: string, ...marks: EditorNode["marks"] & object): EditorNode => ({ type: "text", text, marks });

test("editor JSON becomes text, runs and paragraphs", () => {
  const doc: EditorNode = {
    type: "doc",
    content: [
      p([t("My Essay", { type: "textStyle", attrs: { fontSize: 26 } })], { styleName: "title", textAlign: "center" }),
      p([t("Hello "), t("bold", { type: "bold" }), t(" world.")], { firstLine: true, lineSpacing: 200 }),
      p([]),
      p([t("Times", { type: "textStyle", attrs: { fontFamily: "\"Times New Roman\", serif", fontSize: "16px" } })], { indent: 2 }),
    ],
  };
  const { text, format } = richFromEditorJSON(doc);
  assert.equal(text, "My Essay\nHello bold world.\n\nTimes");
  assert.equal(format.paragraphs.length, 4);
  assert.deepEqual(format.paragraphs[0], { style: "title", align: "center", indent: 0, firstLine: false, spacing: 115 });
  assert.deepEqual(format.paragraphs[1], { style: "normal", align: "left", indent: 0, firstLine: true, spacing: 200 });
  assert.equal(format.paragraphs[3].indent, 2);
  assert.equal(format.runs.reduce((s, r) => s + r.len, 0), text.length);
  // "My Essay" + its newline share a run; "Times" is 12pt Times New Roman
  assert.deepEqual(format.runs[0], { len: 9, size: 26 });
  const last = format.runs[format.runs.length - 1];
  assert.deepEqual(last, { len: 5, font: "Times New Roman", size: 12 });
  assert.ok(format.runs.some((r) => r.b === 1 && r.len === 4));
});

test("hard breaks and newlines inside text split paragraphs; carriage returns are removed", () => {
  const { text, format } = richFromEditorJSON({
    type: "doc",
    content: [p([t("a"), { type: "hardBreak" }, t("b\r\nc\u0001")], { styleName: "h2" })],
  });
  assert.equal(text, "a\nb\nc");
  assert.equal(format.paragraphs.length, 3);
  assert.ok(format.paragraphs.every((x) => x.style === "h2"));
  assert.equal(normalizeText("x\ry\u2028z\uE000"), "x\ny\nz");
});

test("empty document gives one empty paragraph and no runs", () => {
  const { text, format } = richFromEditorJSON({ type: "doc", content: [] });
  assert.equal(text, "");
  assert.equal(format.paragraphs.length, 1);
  assert.deepEqual(format.runs, []);
});

test("css helpers", () => {
  assert.equal(cssFontToFamily("'times new roman', serif"), "Times New Roman");
  assert.equal(cssFontToFamily("Proxima Nova"), "Proxima Nova");
  assert.equal(cssFontToFamily("url(evil)"), undefined);
  assert.equal(cssLengthToPt("12pt"), 12);
  assert.equal(cssLengthToPt("16px"), 12);
  assert.equal(cssLengthToPt("0.5in"), 36);
  assert.equal(cssLengthToPt("large"), undefined);
});

test("parseFormat accepts a matching format and rejects mismatches", () => {
  const text = "ab\ncd";
  assert.equal(parseFormat(text, undefined).ok, true);
  const good = { v: 1, paragraphs: [{ style: "h1" }, { style: "bogus", indent: 99, spacing: 9999 }], runs: [{ len: 3, b: 1, font: "Lora" }, { len: 2, size: 1000 }] };
  const r = parseFormat(text, good);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.format.paragraphs[0].style, "h1");
    assert.equal(r.format.paragraphs[1].style, "normal");
    assert.equal(r.format.paragraphs[1].indent, 8);
    assert.equal(r.format.paragraphs[1].spacing, 500);
    assert.equal(r.format.runs[1].size, 400);
  }
  assert.equal(parseFormat(text, { ...good, paragraphs: [{}] }).ok, false);
  assert.equal(parseFormat(text, { ...good, runs: [{ len: 2 }] }).ok, false);
  assert.equal(parseFormat(text, { ...good, runs: [{ len: 5, font: "x;y{}" }] }).ok, true);
  const bad = parseFormat(text, { ...good, runs: [{ len: 5, font: "x;y{}" }] });
  if (bad.ok) assert.equal(bad.format.runs[0].font, undefined);
});

test("styleRequests: paragraph style only where a paragraph starts, text styles merged and offset", () => {
  const { text, format } = richFromEditorJSON({
    type: "doc",
    content: [
      p([t("Title here")], { styleName: "title", textAlign: "center" }),
      p([t("One "), t("two", { type: "italic" }), t(" three")], { firstLine: true, indent: 1 }),
    ],
  });
  const idx = new FormatIndex(text, format);

  // Chunk "Title " at doc index 1: paragraph 0 starts inside it
  const first = idx.styleRequests(0, 6, 1);
  assert.equal(first.length, 2);
  const para = first[0].updateParagraphStyle as { range: { startIndex: number; endIndex: number }; paragraphStyle: Record<string, unknown> };
  assert.deepEqual(para.range, { startIndex: 1, endIndex: 7 });
  assert.equal(para.paragraphStyle.namedStyleType, "TITLE");
  assert.equal(para.paragraphStyle.alignment, "CENTER");
  const ts = first[1].updateTextStyle as { range: object; textStyle: { fontSize?: { magnitude: number } }; fields: string };
  assert.equal(ts.textStyle.fontSize, undefined, "no size of its own: the named style's applies");
  assert.ok(ts.fields.includes("fontSize"), "fontSize is in the mask so an inherited value is reset");

  // Chunk "here\nOne " spans the newline: second paragraph starts at offset 11
  const second = idx.styleRequests(6, 15, 50);
  const paraReqs = second.filter((r) => r.updateParagraphStyle);
  assert.equal(paraReqs.length, 1);
  const p2 = paraReqs[0].updateParagraphStyle as { range: { startIndex: number; endIndex: number }; paragraphStyle: { indentStart: { magnitude: number }; indentFirstLine: { magnitude: number } } };
  assert.deepEqual(p2.range, { startIndex: 50 + 5, endIndex: 50 + 9 });
  assert.equal(p2.paragraphStyle.indentStart.magnitude, 36);
  assert.equal(p2.paragraphStyle.indentFirstLine.magnitude, 72);
  const textReqs = second.filter((r) => r.updateTextStyle).map((r) => (r.updateTextStyle as { range: { startIndex: number; endIndex: number }; textStyle: { fontSize?: { magnitude: number } } }));
  // "here\nOne " carries no explicit text style: one request over the whole chunk
  assert.equal(textReqs.length, 1);
  assert.deepEqual(textReqs[0].range, { startIndex: 50, endIndex: 59 });
  assert.equal(textReqs[0].textStyle.fontSize, undefined);

  // A chunk entirely inside paragraph 1 does not restyle the paragraph
  const inner = idx.styleRequests(15, 22, 80);
  assert.equal(inner.filter((r) => r.updateParagraphStyle).length, 0);
  const italic = inner.map((r) => r.updateTextStyle as { textStyle: { italic: boolean } }).filter(Boolean);
  assert.equal(italic.length, 2, "italic 'two' and plain ' th' split");
  assert.equal(italic[0].textStyle.italic, true);
});

test("uniform requests style typo characters like the text they precede", () => {
  const { text, format } = richFromEditorJSON({ type: "doc", content: [p([t("ab")]), p([t("cd", { type: "bold" })], { styleName: "h1" })] });
  const idx = new FormatIndex(text, format);
  const reqs = idx.uniformStyleRequests(3, 4, 10);
  assert.equal(reqs.length, 1, "only character styling; the paragraph is set with the real text");
  const tsr = reqs[0].updateTextStyle as { range: { startIndex: number; endIndex: number }; textStyle: { bold: boolean; fontSize?: { magnitude: number } } };
  assert.deepEqual(tsr.range, { startIndex: 10, endIndex: 14 });
  assert.equal(tsr.textStyle.bold, true);
  assert.equal(tsr.textStyle.fontSize, undefined, "the heading's size comes from the named style");
  assert.equal(idx.uniformStyleRequests(4, 2, 10).length, 1);
});

test("plain format applies defaults: the document's Normal text style, 1.15 spacing", () => {
  const text = "one\ntwo";
  const idx = new FormatIndex(text, plainFormat(text));
  const reqs = idx.styleRequests(0, text.length, 1);
  assert.equal(reqs.filter((r) => r.updateParagraphStyle).length, 2);
  const ts = reqs.find((r) => r.updateTextStyle)!.updateTextStyle as { textStyle: { weightedFontFamily?: unknown; fontSize?: unknown; smallCaps: boolean }; fields: string };
  // Nothing explicit: Docs applies the document's own Normal text font and size
  assert.equal(ts.textStyle.weightedFontFamily, undefined);
  assert.equal(ts.textStyle.fontSize, undefined);
  assert.equal(ts.textStyle.smallCaps, false);
  for (const f of ["fontSize", "weightedFontFamily", "smallCaps"]) assert.ok(ts.fields.split(",").includes(f));
});

test("explicit font and size are sent as given; small caps round-trips", () => {
  const { text, format } = richFromEditorJSON({ type: "doc", content: [p([t("ab", { type: "textStyle", attrs: { fontFamily: "Georgia", fontSize: 14 } }, { type: "smallCaps" })])] });
  const idx = new FormatIndex(text, format);
  const ts = idx.styleRequests(0, 2, 1).find((r) => r.updateTextStyle)!.updateTextStyle as { textStyle: { weightedFontFamily: { fontFamily: string }; fontSize: { magnitude: number }; smallCaps: boolean } };
  assert.equal(ts.textStyle.weightedFontFamily.fontFamily, "Georgia");
  assert.equal(ts.textStyle.fontSize.magnitude, 14);
  assert.equal(ts.textStyle.smallCaps, true);
});

test("richToEditorJSON round-trips through richFromEditorJSON", async () => {
  const { richToEditorJSON } = await import("./rich-text");
  const doc: EditorNode = {
    type: "doc",
    content: [
      p([t("Title", { type: "textStyle", attrs: { fontFamily: "Lora", fontSize: 26 } })], { styleName: "title", textAlign: "center" }),
      p([]),
      p([t("A "), t("mixed", { type: "bold" }, { type: "italic" }), t(" line", { type: "underline" })], { indent: 1, firstLine: true, lineSpacing: 200 }),
      p([t("end", { type: "strike" })], { textAlign: "justify" }),
    ],
  };
  const first = richFromEditorJSON(doc);
  const again = richFromEditorJSON(richToEditorJSON(first.text, first.format));
  assert.equal(again.text, first.text);
  assert.deepEqual(again.format, first.format);
  const plain = richFromEditorJSON(richToEditorJSON("x\ny", null));
  assert.equal(plain.text, "x\ny");
});

test("colours, highlight, links, lists and images convert and validate", async () => {
  const { OBJ } = await import("./rich-text");
  const { text, format } = richFromEditorJSON({ type: "doc", content: [
    p([t("red", { type: "textStyle", attrs: { color: "rgb(255, 0, 0)" } }), t(" mark", { type: "highlight", attrs: { color: "#ff0" } }), t(" link", { type: "link", attrs: { href: "www.example.com" } })]),
    p([t("\t\tfirst item")], { list: "bullet", indent: 3 }),
    p([t("img "), { type: "image", attrs: { src: "https://x.test/i.png", width: 100, height: 50 } }]),
  ] });
  assert.equal(text, `red mark link\nfirst item\nimg ${OBJ}`, "leading tabs are dropped from list items");
  assert.equal(format.paragraphs[1].list, "bullet");
  assert.equal(format.paragraphs[1].indent, 0);
  assert.ok(format.runs.some((r) => r.color === "#ff0000"));
  assert.ok(format.runs.some((r) => r.bg === "#ffff00"));
  assert.ok(format.runs.some((r) => r.link === "https://www.example.com"));
  assert.deepEqual(format.images, [{ at: text.length - 1, src: "https://x.test/i.png", w: 75, h: 37.5 }]);
  const ok = parseFormat(text, format);
  assert.ok(ok.ok);
  assert.equal(parseFormat(text, { ...format, images: [] }).ok, false, "placeholder without image");
  assert.equal(parseFormat(text, { ...format, images: [{ at: 0, src: "https://x.test/i.png", w: 1, h: 1 }] }).ok, false, "image not on a placeholder");
  assert.equal(parseFormat("\tx", { v: 1, paragraphs: [{ style: "normal", align: "left", indent: 0, firstLine: false, spacing: 115, list: "bullet" }], runs: [{ len: 2 }] }).ok, false);
  const back = richFromEditorJSON(richToEditorJSONFor(text, format));
  assert.equal(back.text, text);
  assert.deepEqual(back.format, format);
});

import { richToEditorJSON as richToEditorJSONFor } from "./rich-text";

test("pasted paragraphs keep exact indents and spacing, and send them to Docs", async () => {
  const { paragraphFromAttrs, paragraphRequest, paragraphDelta, richToEditorJSON } = await import("./rich-text");
  // What the editor holds for a paragraph pasted from Docs: margin-left 72pt, text-indent 36pt, 10pt after
  const para = paragraphFromAttrs({ styleName: "normal", lineSpacing: 200, box: { start: 72, first: 36, above: 0, below: 10 } });
  assert.deepEqual(para.exact, { start: 72, first: 108 });
  assert.deepEqual(para.space, { above: 0, below: 10 });
  const req = paragraphRequest(para, 1, 10).updateParagraphStyle as { paragraphStyle: Record<string, unknown>; fields: string };
  assert.deepEqual(req.paragraphStyle.spaceBelow, { magnitude: 10, unit: "PT" });
  assert.deepEqual(req.paragraphStyle.indentStart, { magnitude: 72, unit: "PT" });
  assert.match(req.fields, /spaceAbove,spaceBelow/);
  // Spacing is sent only when it changes
  const same = paragraphFromAttrs({ styleName: "normal", lineSpacing: 200, box: { start: 72, first: 36, above: 0, below: 10 } });
  assert.equal(paragraphDelta(para, same), null);
  const wider = paragraphFromAttrs({ styleName: "normal", lineSpacing: 200, box: { start: 72, first: 36, above: 0, below: 18 } });
  assert.deepEqual(paragraphDelta(para, wider)?.fields, ["spaceAbove", "spaceBelow"]);
  // A paragraph with no spacing of its own takes its named style's: the fields are in the mask,
  // unset, so the spacing a typed newline copied from the paragraph before is not kept
  const plain = paragraphFromAttrs({ styleName: "normal" });
  assert.equal(plain.space, undefined);
  const reset = paragraphRequest(plain, 1, 10).updateParagraphStyle as { paragraphStyle: Record<string, unknown>; fields: string };
  assert.match(reset.fields, /spaceAbove,spaceBelow/);
  assert.equal(reset.paragraphStyle.spaceAbove, undefined);
  assert.deepEqual(paragraphDelta({ ...plain, space: { above: 20, below: 6 } }, plain, true)?.fields, ["spaceAbove", "spaceBelow"]);
  // An existing paragraph's spacing is left as the doc has it when the editor has none to give
  assert.equal(paragraphDelta({ ...plain, space: { above: 20, below: 6 } }, plain), null);
  // And it all comes back to the editor as the same box
  const json = richToEditorJSON("x", { v: 1, paragraphs: [para], runs: [{ len: 1 }] });
  assert.deepEqual(json.content?.[0].attrs?.box, { start: 72, first: 36, above: 0, below: 10 });
  assert.deepEqual(parseFormat("x", { v: 1, paragraphs: [para], runs: [{ len: 1 }] }), { ok: true, format: { v: 1, paragraphs: [para], runs: [{ len: 1 }] } });
});

test("super/subscript, headings 4-6, keep options, borders and shading reach Docs and come back", async () => {
  const { paragraphFromAttrs, paragraphRequest, paragraphDelta, resolveTextStyle, richToEditorJSON, richFromEditorJSON } = await import("./rich-text");
  const doc: EditorNode = { type: "doc", content: [
    p([t("x", { type: "superscript" }), t("y", { type: "subscript" }), t("z")], { styleName: "h5", keep: { withNext: true }, borders: { bottom: { width: 1.5, color: "#ff0000", dash: "DASH", padding: 2 } }, shading: "#fff2cc" }),
  ] };
  const { text, format } = richFromEditorJSON(doc);
  assert.equal(text, "xyz");
  assert.deepEqual(format.runs, [{ len: 1, sup: 1 }, { len: 1, sub: 1 }, { len: 1 }]);
  const para = format.paragraphs[0];
  assert.equal(para.style, "h5");
  assert.deepEqual(para.keep, { withNext: true });
  assert.deepEqual(para.borders, { bottom: { width: 1.5, color: "#ff0000", dash: "DASH", padding: 2 } });
  assert.equal(para.shading, "#fff2cc");
  assert.equal(resolveTextStyle({ sup: 1 }).baselineOffset, "SUPERSCRIPT");
  assert.equal(resolveTextStyle({}).baselineOffset, "NONE");
  const req = paragraphRequest(para, 1, 4).updateParagraphStyle as { paragraphStyle: Record<string, unknown>; fields: string };
  assert.equal(req.paragraphStyle.namedStyleType, "HEADING_5");
  assert.equal(req.paragraphStyle.keepWithNext, true);
  assert.equal(req.paragraphStyle.avoidWidowAndOrphan, true, "Docs' default stays on");
  assert.deepEqual((req.paragraphStyle.borderBottom as { width: unknown }).width, { magnitude: 1.5, unit: "PT" });
  assert.deepEqual((req.paragraphStyle.borderTop as { width: unknown }).width, { magnitude: 0, unit: "PT" }, "other sides are cleared");
  assert.match(req.fields, /keepWithNext,keepLinesTogether,avoidWidowAndOrphan/);
  assert.match(req.fields, /borderTop,borderBottom,borderLeft,borderRight,borderBetween/);
  assert.match(req.fields, /shading/);
  // Only what changed is sent
  const plain = paragraphFromAttrs({ styleName: "h5" });
  const d = paragraphDelta(para, plain)!;
  assert.ok(d.fields.includes("shading") && d.fields.includes("borderTop") && d.fields.includes("keepWithNext") && !d.fields.includes("namedStyleType"));
  assert.equal(paragraphDelta(para, para), null);
  // Round trip to the editor
  const back = richToEditorJSON(text, format);
  assert.deepEqual(back.content?.[0].attrs?.keep, { withNext: true });
  assert.deepEqual(back.content?.[0].attrs?.borders, para.borders);
  assert.equal(back.content?.[0].attrs?.shading, "#fff2cc");
  assert.deepEqual(back.content?.[0].content?.[0].marks, [{ type: "superscript" }]);
  assert.deepEqual(parseFormat(text, format), { ok: true, format });
});

test("list levels and styles: bullets are created with leading tabs that Docs removes", async () => {
  const { bulletRequests, SegmentFormat, paragraphFromAttrs, paragraphRequest, paragraphDelta, richToEditorJSON } = await import("./rich-text");
  const reqs = bulletRequests([{ start: 1, end: 5, level: 0 }, { start: 5, end: 9, level: 2 }], "NUMBERED_DECIMAL_NESTED");
  assert.deepEqual(reqs, [
    // Indents left by earlier bullets would add levels: every item starts from zero
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 9 }, paragraphStyle: { indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } }, fields: "indentStart,indentFirstLine" } },
    { insertText: { location: { index: 5 }, text: "\t\t" } },
    { createParagraphBullets: { range: { startIndex: 1, endIndex: 11 }, bulletPreset: "NUMBERED_DECIMAL_NESTED" } },
  ]);
  // A segment whose second line is one level deeper re-creates the whole list (Docs nests relative to
  // the request's other paragraphs, and only paragraphs without bullets): delete, tab, one create
  const fmt = { v: 1 as const, paragraphs: [paragraphFromAttrs({ list: "bullet", preset: "BULLET_STAR_CIRCLE_SQUARE" }), paragraphFromAttrs({ list: "bullet", level: 1, preset: "BULLET_STAR_CIRCLE_SQUARE" })], runs: [{ len: 7 }] };
  const sf = new SegmentFormat("one\ntwo", fmt);
  const r = sf.writeRequests(0, 7, 10, null);
  const creates = r.requests.filter((q) => q.createParagraphBullets);
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1], { createParagraphBullets: { range: { startIndex: 10, endIndex: 18 }, bulletPreset: "BULLET_STAR_CIRCLE_SQUARE" } });
  assert.deepEqual(r.requests.find((q) => q.deleteParagraphBullets), { deleteParagraphBullets: { range: { startIndex: 10, endIndex: 17 } } });
  assert.deepEqual(r.docList, { type: "bullet", start: 0, level: 1, preset: "BULLET_STAR_CIRCLE_SQUARE" });
  assert.deepEqual(r.requests.find((q) => (q.insertText as { text?: string } | undefined)?.text === "\t"), { insertText: { location: { index: 14 }, text: "\t" } });
  // Typed chunk by chunk: the newline that opens the deeper line re-creates the list from its first
  // item over the opened paragraph, and the text typed into it afterwards inherits the level
  const a = sf.writeRequests(0, 4, 10, null);
  assert.deepEqual(a.requests.find((q) => q.deleteParagraphBullets), { deleteParagraphBullets: { range: { startIndex: 10, endIndex: 15 } } });
  assert.deepEqual(a.requests.filter((q) => q.createParagraphBullets)[1], { createParagraphBullets: { range: { startIndex: 10, endIndex: 16 }, bulletPreset: "BULLET_STAR_CIRCLE_SQUARE" } });
  const b = sf.writeRequests(4, 7, 14, a.docList);
  assert.equal(b.requests.filter((q) => q.createParagraphBullets || q.deleteParagraphBullets).length, 0);
  // Right indent reaches Docs and comes back
  const p = paragraphFromAttrs({ indentEnd: 54 });
  assert.equal(p.end, 54);
  assert.deepEqual((paragraphRequest(p, 1, 2).updateParagraphStyle as { paragraphStyle: { indentEnd: unknown } }).paragraphStyle.indentEnd, { magnitude: 54, unit: "PT" });
  assert.deepEqual(paragraphDelta(paragraphFromAttrs({}), p)?.fields, ["indentEnd"]);
  assert.equal(richToEditorJSON("x", { v: 1, paragraphs: [p], runs: [{ len: 1 }] }).content?.[0].attrs?.indentEnd, 54);
  const li = richToEditorJSON("x", { v: 1, paragraphs: [fmt.paragraphs[1]], runs: [{ len: 1 }] }).content?.[0].attrs;
  assert.equal(li?.level, 1);
  assert.equal(li?.preset, "BULLET_STAR_CIRCLE_SQUARE");
});

test("every paragraph one write opens is corrected against the paragraph it was typed in, not the line before it", async () => {
  const { SegmentFormat, DEFAULT_PARAGRAPH } = await import("./rich-text");
  const h1 = { ...DEFAULT_PARAGRAPH, style: "h1" as const, space: { above: 20, below: 6 } };
  // "Heading" typed and styled already; this write types "\n\nBody": Docs copies the heading into both new paragraphs
  const text = "Heading\n\nBody";
  const sf = new SegmentFormat(text, { v: 1, base: { ...DEFAULT_PARAGRAPH }, paragraphs: [h1, { ...DEFAULT_PARAGRAPH }, { ...DEFAULT_PARAGRAPH }], runs: [{ len: text.length }] });
  const { requests } = sf.writeRequests(7, 13, 8, null);
  const styled = requests.filter((r) => r.updateParagraphStyle).map((r) => r.updateParagraphStyle as { range: { startIndex: number }; paragraphStyle: Record<string, unknown>; fields: string });
  assert.deepEqual(styled.map((u) => [u.range.startIndex, u.paragraphStyle.namedStyleType]), [[9, "NORMAL_TEXT"], [10, "NORMAL_TEXT"]]);
  // and the heading's spacing goes back to Normal text's
  assert.ok(styled.every((u) => /spaceAbove,spaceBelow/.test(u.fields) && u.paragraphStyle.spaceAbove === undefined));
});

test("bullets a write makes are dropped from the new paragraphs that are not list items", async () => {
  const { SegmentFormat, DEFAULT_PARAGRAPH } = await import("./rich-text");
  const item = { ...DEFAULT_PARAGRAPH, list: "bullet" as const };
  const text = "Item\n\nAfter";
  const sf = new SegmentFormat(text, { v: 1, base: { ...DEFAULT_PARAGRAPH }, paragraphs: [item, { ...DEFAULT_PARAGRAPH }, { ...DEFAULT_PARAGRAPH }], runs: [{ len: text.length }] });
  // "Item" is a bullet already; "\n\nAfter" opens two paragraphs, both copies of the bullet
  const { requests, docList } = sf.writeRequests(4, 11, 5, { type: "bullet", start: 0, level: 0 });
  const deleted = requests.filter((r) => r.deleteParagraphBullets).map((r) => (r.deleteParagraphBullets as { range: { startIndex: number } }).range.startIndex);
  assert.deepEqual(deleted, [6, 7]);
  assert.equal(docList, null);
});

test("a finished list item is styled whole so its glyph takes its text's style, and its text keeps its own", async () => {
  const { SegmentFormat, DEFAULT_PARAGRAPH } = await import("./rich-text");
  const item = { ...DEFAULT_PARAGRAPH, list: "bullet" as const };
  const text = "Key point\n";
  const sf = new SegmentFormat(text, { v: 1, base: { ...DEFAULT_PARAGRAPH }, paragraphs: [item, { ...DEFAULT_PARAGRAPH }], runs: [{ len: 3, b: 1, bg: "#d9ead3" }, { len: 7, bg: "#d9ead3" }] });
  const { requests } = sf.writeRequests(4, 10, 5, { type: "bullet", start: 0, level: 0 });
  const text1 = requests.filter((r) => r.updateTextStyle).map((r) => r.updateTextStyle as { range: { startIndex: number; endIndex: number }; textStyle: Record<string, unknown> });
  // the whole item [1, 11) with the first character's style, then "Key" and the rest restored
  assert.deepEqual(text1[0].range, { startIndex: 1, endIndex: 11 });
  assert.equal(text1[0].textStyle.bold, true);
  assert.ok(text1.some((u) => u.range.startIndex === 1 && u.range.endIndex === 4 && u.textStyle.bold === true));
  assert.ok(text1.some((u) => u.range.startIndex === 4 && u.textStyle.bold === false));
});

test("the empty last paragraph a trailing newline opens is styled by the write that opens it", async () => {
  const text = "Item\n";
  const fi = new FormatIndex(text, { v: 1, paragraphs: [{ style: "normal", align: "left", indent: 0, firstLine: false, spacing: 115, list: "bullet" }, { style: "normal", align: "left", indent: 0, firstLine: false, spacing: 115 }], runs: [{ len: 5 }] });
  // "Item" was typed and bulleted; the last write types its newline, which copies the bullet into the doc's last paragraph
  const { requests, docList } = fi.writeRequests(4, 5, 5, { type: "bullet", start: 0, level: 0 });
  const del = requests.find((r) => r.deleteParagraphBullets)?.deleteParagraphBullets as { range: { startIndex: number; endIndex: number } } | undefined;
  assert.deepEqual(del?.range, { startIndex: 6, endIndex: 7 });
  assert.equal(docList, null);
});

test("a list item's own glyph style goes through the format to the sync, and back to the editor", async () => {
  const { SegmentFormat, DEFAULT_PARAGRAPH, paragraphFromAttrs, richToEditorJSON } = await import("./rich-text");
  // As the editor has it: the glyph style Docs gave the bullet (bold, 14pt), not the text's
  const item = paragraphFromAttrs({ list: "bullet", glyphStyle: { b: 1, size: 14, link: "https://x.test", color: "red" } });
  assert.deepEqual(item.glyph, { b: 1, size: 14 });
  // Kept by the server's check, and dropped from paragraphs that aren't list items
  const parsed = parseFormat("Item\n", { v: 1, paragraphs: [item, { ...DEFAULT_PARAGRAPH, glyph: { b: 1 } }], runs: [{ len: 5 }] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.format.paragraphs.map((p) => p.glyph), [{ b: 1, size: 14 }, undefined]);
  // The finished item is styled whole with it, then its text gets its own style back
  const sf = new SegmentFormat("Item\n", { ...parsed.format, base: { ...DEFAULT_PARAGRAPH } });
  const { requests } = sf.writeRequests(4, 5, 5, { type: "bullet", start: 0, level: 0 });
  const styles = requests.filter((r) => r.updateTextStyle).map((r) => r.updateTextStyle as { range: { startIndex: number; endIndex: number }; textStyle: Record<string, unknown> });
  assert.deepEqual(styles[0].range, { startIndex: 1, endIndex: 6 });
  assert.equal(styles[0].textStyle.bold, true);
  assert.deepEqual(styles[0].textStyle.fontSize, { magnitude: 14, unit: "PT" });
  assert.ok(styles.slice(1).some((u) => u.range.startIndex === 1 && u.range.endIndex === 5 && u.textStyle.bold === false));
  // Back in the editor, the item carries it
  const json = richToEditorJSON("Item", { v: 1, paragraphs: [item], runs: [{ len: 4 }] });
  assert.deepEqual(json.content?.[0].attrs?.glyphStyle, { b: 1, size: 14 });
});

test("a style from a paste keeps only checked values, so nothing else gets into the page's CSS", async () => {
  const { cleanStyle } = await import("./rich-text");
  assert.deepEqual(cleanStyle({ font: "Arial; background: url(https://x.test/p)", color: "red;x:y", bg: "#FFF2CC", size: "12", b: 1 }), { bg: "#fff2cc", b: 1 });
  assert.deepEqual(cleanStyle(null), {});
});

test("a list item indented its own way keeps its indents through the format, and the sync gives them back after making its bullet", async () => {
  const { SegmentFormat, DEFAULT_PARAGRAPH, paragraphFromAttrs, richToEditorJSON } = await import("./rich-text");
  // Pasted: text at 54pt, glyph 18pt before it (the list style gives 36pt at level 0)
  const item = paragraphFromAttrs({ list: "bullet", box: { start: 54, marker: -18 } });
  assert.deepEqual(item.exact, { start: 54, first: 36 });
  // What the list style gives anyway is not kept
  assert.equal(paragraphFromAttrs({ list: "bullet", level: 1, box: { start: 72, marker: -18 } }).exact, undefined);
  const parsed = parseFormat("Item\n", { v: 1, paragraphs: [item, { ...DEFAULT_PARAGRAPH }], runs: [{ len: 5 }] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.format.paragraphs[0].exact, { start: 54, first: 36 });
  // The bullet is made, then the item gets its indents
  const sf = new SegmentFormat("Item\n", { ...parsed.format, base: { ...DEFAULT_PARAGRAPH } });
  const { requests } = sf.writeRequests(0, 5, 1, null);
  const create = requests.findIndex((r) => r.createParagraphBullets);
  const indent = requests.findIndex((r, i) => i > create && (r.updateParagraphStyle as { fields?: string } | undefined)?.fields === "indentStart,indentFirstLine");
  assert.ok(create >= 0 && indent > create);
  assert.deepEqual((requests[indent].updateParagraphStyle as { paragraphStyle: unknown }).paragraphStyle, { indentStart: { magnitude: 54, unit: "PT" }, indentFirstLine: { magnitude: 36, unit: "PT" } });
  // And the editor shows them
  assert.deepEqual(richToEditorJSON("Item", { v: 1, paragraphs: [item], runs: [{ len: 4 }] }).content?.[0].attrs?.box, { start: 54, marker: -18, above: null, below: null });
});

test("a list that can only start at level 0 still puts each item's text where its level does", async () => {
  const { bulletRequests } = await import("./rich-text");
  const indents = (reqs: Record<string, unknown>[]) => reqs.slice(reqs.findIndex((r) => r.createParagraphBullets) + 1).map((r) => {
    const u = r.updateParagraphStyle as { range: { startIndex: number }; paragraphStyle: { indentStart: { magnitude: number }; indentFirstLine: { magnitude: number } } };
    return [u.range.startIndex, u.paragraphStyle.indentStart.magnitude, u.paragraphStyle.indentFirstLine.magnitude];
  });
  // On its own, an item lands at level 0 whatever its tabs: a level-2 item is indented as level 2 is
  const solo = bulletRequests([{ start: 1, end: 9, level: 2 }], "BULLET_DISC_CIRCLE_SQUARE");
  assert.equal(solo.filter((r) => r.insertText).length, 0);
  assert.deepEqual(indents(solo), [[1, 108, 90]]);
  // Items nest relative to each other: levels 1, 2, 1 come out 0, 1, 0, so each gets its own level's indents
  assert.deepEqual(indents(bulletRequests([{ start: 1, end: 3, level: 1 }, { start: 3, end: 5, level: 2 }, { start: 5, end: 7, level: 1 }], "BULLET_DISC_CIRCLE_SQUARE")), [[1, 72, 54], [3, 108, 90], [5, 72, 54]]);
  // A list starting at level 0 nests as it is: nothing more to set; an item's own indents still win
  assert.deepEqual(indents(bulletRequests([{ start: 1, end: 3, level: 0 }, { start: 3, end: 5, level: 1 }], "BULLET_DISC_CIRCLE_SQUARE")), []);
  assert.deepEqual(indents(bulletRequests([{ start: 1, end: 9, level: 1, indent: { start: 90, first: 72 } }], "BULLET_DISC_CIRCLE_SQUARE")), [[1, 90, 72]]);
});

test("the last list item of a segment is styled whole once its text is in, when its paragraph ends there", async () => {
  const { SegmentFormat, DEFAULT_PARAGRAPH, paragraphFromAttrs } = await import("./rich-text");
  // A numbered item whose numeral is bold, its text not, typed into the paragraph the document has
  const item = paragraphFromAttrs({ list: "ordered", glyphStyle: { b: 1 } });
  const text = "Restate the thesis";
  const sf = new SegmentFormat(text, { v: 1, base: { ...DEFAULT_PARAGRAPH }, paragraphs: [item], runs: [{ len: text.length }] });
  const whole = (closes: "newline" | "final" | null, start = 8) => sf.writeRequests(start, text.length, 1 + start, { type: "ordered", start: 0, level: 0 }, closes)
    .requests.filter((r) => r.updateTextStyle).map((r) => r.updateTextStyle as { range: { startIndex: number; endIndex: number }; textStyle: Record<string, unknown> })
    .find((u) => u.range.startIndex === 1);
  // More of the paragraph follows the text: the item isn't finished, nothing restyles it
  assert.equal(whole(null), undefined);
  // The text ends at the paragraph's newline: the item, newline included, takes the glyph's style
  assert.deepEqual(whole("newline")?.range, { startIndex: 1, endIndex: 1 + text.length + 1 });
  assert.equal(whole("newline")?.textStyle.bold, true);
  // ...but not the body's last newline, which no range may include
  assert.deepEqual(whole("final")?.range, { startIndex: 1, endIndex: 1 + text.length });
  // and only on the write that finishes the text
  assert.equal(sf.writeRequests(0, 8, 1, null, "newline").requests.filter((r) => r.updateTextStyle && (r.updateTextStyle as { range: { endIndex: number } }).range.endIndex > 9).length, 0);
});
