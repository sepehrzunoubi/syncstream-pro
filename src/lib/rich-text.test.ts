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
  // A paragraph with no spacing of its own leaves Docs' alone
  const plain = paragraphFromAttrs({ styleName: "normal" });
  assert.equal(plain.space, undefined);
  assert.doesNotMatch((paragraphRequest(plain, 1, 10).updateParagraphStyle as { fields: string }).fields, /space/);
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
    { insertText: { location: { index: 5 }, text: "\t\t" } },
    { createParagraphBullets: { range: { startIndex: 1, endIndex: 11 }, bulletPreset: "NUMBERED_DECIMAL_NESTED" } },
  ]);
  // A segment whose second line is one level deeper re-creates bullets for that line at its level
  const fmt = { v: 1 as const, paragraphs: [paragraphFromAttrs({ list: "bullet" }), paragraphFromAttrs({ list: "bullet", level: 1, preset: "BULLET_STAR_CIRCLE_SQUARE" })], runs: [{ len: 7 }] };
  const sf = new SegmentFormat("one\ntwo", fmt);
  const r = sf.writeRequests(0, 7, 10, null);
  const creates = r.requests.filter((q) => q.createParagraphBullets);
  assert.equal(creates.length, 2);
  assert.deepEqual(r.docList, { type: "bullet", start: 4, level: 1, preset: "BULLET_STAR_CIRCLE_SQUARE" });
  assert.ok(r.requests.some((q) => (q.insertText as { text?: string } | undefined)?.text === "\t"));
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
