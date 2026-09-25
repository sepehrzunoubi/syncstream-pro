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
  const ts = first[1].updateTextStyle as { range: object; textStyle: { fontSize: { magnitude: number } } };
  assert.equal(ts.textStyle.fontSize.magnitude, 26, "title default size");

  // Chunk "here\nOne " spans the newline: second paragraph starts at offset 11
  const second = idx.styleRequests(6, 15, 50);
  const paraReqs = second.filter((r) => r.updateParagraphStyle);
  assert.equal(paraReqs.length, 1);
  const p2 = paraReqs[0].updateParagraphStyle as { range: { startIndex: number; endIndex: number }; paragraphStyle: { indentStart: { magnitude: number }; indentFirstLine: { magnitude: number } } };
  assert.deepEqual(p2.range, { startIndex: 50 + 5, endIndex: 50 + 9 });
  assert.equal(p2.paragraphStyle.indentStart.magnitude, 36);
  assert.equal(p2.paragraphStyle.indentFirstLine.magnitude, 72);
  const textReqs = second.filter((r) => r.updateTextStyle).map((r) => (r.updateTextStyle as { range: { startIndex: number; endIndex: number }; textStyle: { fontSize: { magnitude: number } } }));
  // "here\n" is title-sized (26), "One " is normal (11): two text requests
  assert.equal(textReqs.length, 2);
  assert.deepEqual(textReqs[0].range, { startIndex: 50, endIndex: 55 });
  assert.equal(textReqs[0].textStyle.fontSize.magnitude, 26);
  assert.equal(textReqs[1].textStyle.fontSize.magnitude, 11);

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
  assert.equal(reqs.length, 2, "paragraph starts here, so its style is included");
  const tsr = reqs[1].updateTextStyle as { range: { startIndex: number; endIndex: number }; textStyle: { bold: boolean; fontSize: { magnitude: number } } };
  assert.deepEqual(tsr.range, { startIndex: 10, endIndex: 14 });
  assert.equal(tsr.textStyle.bold, true);
  assert.equal(tsr.textStyle.fontSize.magnitude, 20);
  assert.equal(idx.uniformStyleRequests(4, 2, 10).length, 1);
});

test("plain format applies defaults: Arial 11pt, 1.15 spacing", () => {
  const text = "one\ntwo";
  const idx = new FormatIndex(text, plainFormat(text));
  const reqs = idx.styleRequests(0, text.length, 1);
  assert.equal(reqs.filter((r) => r.updateParagraphStyle).length, 2);
  const ts = reqs.find((r) => r.updateTextStyle)!.updateTextStyle as { textStyle: { weightedFontFamily: { fontFamily: string }; fontSize: { magnitude: number } } };
  assert.equal(ts.textStyle.weightedFontFamily.fontFamily, "Arial");
  assert.equal(ts.textStyle.fontSize.magnitude, 11);
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
