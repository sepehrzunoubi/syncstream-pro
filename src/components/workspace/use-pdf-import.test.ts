import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getSchema } from "@tiptap/core";
import { editorExtensions } from "./extensions";
import { additions, directEdits, PENDING_MARK } from "@/lib/doc-model";
import { DEFAULT_PAGE_SETUP } from "@/lib/page-setup";
import { importPdf } from "@/lib/pdf-import";
import type { EditorNode } from "@/lib/rich-text";
import { appendPdf, checkFile, failureMessage, isBlankDoc, MAX_PDF_BYTES, pageLabel, parseResult, pdfTitle, replaceWithPdf, segmentRequests, summaryLine } from "./use-pdf-import";

// Import PDF puts a PDF's content on the page as new text: next to what the document has (nothing of it
// deleted), or in its place (all of it deleted by the save), and its header written straight to Docs

const schema = getSchema(editorExtensions);
const ADD = { type: PENDING_MARK };
const para = (text: string, attrs: Record<string, unknown> = {}, pending = false): EditorNode => ({ type: "paragraph", attrs, content: text ? [{ type: "text", text, ...(pending ? { marks: [ADD] } : {}) }] : [] });
const doc = (...content: EditorNode[]): EditorNode => ({ type: "doc", content });
const pdfNodes = [para("From the PDF", { styleName: "heading1" }, true), para("Its first paragraph.", {}, true)];
/** Every node the editor can't take throws here */
const valid = (d: EditorNode) => schema.nodeFromJSON(d).check();
const table = (cells: string[][]): EditorNode => ({ type: "table", content: cells.map((row) => ({ type: "tableRow", content: row.map((t) => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [para(t)] })) })) });
const kinds = (requests: Record<string, unknown>[]) => requests.map((r) => Object.keys(r)[0]);

test("a blank page: nothing but empty paragraphs", () => {
  assert.equal(isBlankDoc(doc(para(""))), true);
  assert.equal(isBlankDoc(doc(para(""), para(""))), true);
  assert.equal(isBlankDoc(doc(para("x"))), false);
  assert.equal(isBlankDoc(doc(para("new", {}, true))), false, "new text isn't blank either");
  assert.equal(isBlankDoc(doc(para(" "))), false);
  assert.equal(isBlankDoc(doc({ type: "paragraph", content: [{ type: "image", attrs: { src: "https://x.test/a.png" } }] })), false);
  assert.equal(isBlankDoc(doc(table([["a"]]), para(""))), false);
  assert.equal(isBlankDoc(null), false);
});

test("Add after what's here: the document stays as it is, the PDF is all additions after it", () => {
  const base = doc(para("Already here.", { styleName: "title" }), para("Second line."));
  const next = appendPdf(base, pdfNodes);
  valid(next);
  assert.deepEqual(next.content!.slice(0, 2), base.content);
  assert.deepEqual(next.content!.slice(2), pdfNodes);
  // Saving changes nothing in the Google Doc: it's all for the sync
  assert.deepEqual(directEdits(base, next).requests, []);
  assert.equal(additions(base, next).text.replace(/\n/g, "|"), "|From the PDF|Its first paragraph.");
});

test("Add after what's here, in a document that ends in columns: the PDF joins the last section", () => {
  const marker: EditorNode = { type: "paragraph", attrs: { kind: "section", sectionType: "continuous", columns: 2, spacing: 36, line: false, locked: true, span: 1, bid: "b1" }, content: [] };
  const base = doc(para("Intro"), marker, { type: "columnSection", attrs: { columns: 2, spacing: 36, line: false }, content: [para("Left"), para("Right")] });
  const next = appendPdf(base, pdfNodes);
  valid(next);
  assert.equal(next.content!.length, 3);
  assert.deepEqual(next.content![2].content!.map((p) => p.content?.[0]?.text), ["Left", "Right", "From the PDF", "Its first paragraph."]);
});

test("Replace what's here: everything goes (text, tables, images), the PDF is all that's typed", () => {
  const image: EditorNode = { type: "paragraph", attrs: {}, content: [{ type: "image", attrs: { src: "https://x.test/a.png", width: 10, height: 10 } }] };
  const rest = [para("Old title", { styleName: "title" }), para("Old text."), image];
  const base = doc(rest[0], rest[1], table([["a", "b"]]), para(""), rest[2]);
  const next = replaceWithPdf(base, pdfNodes);
  valid(next);
  assert.deepEqual(next.content, pdfNodes);
  // The table goes first, on its own (Docs' indices change); the document is then read back without it
  const first = directEdits(base, next);
  assert.equal(first.structural, true);
  assert.deepEqual(kinds(first.requests), ["deleteContentRange"]);
  const fresh = doc(rest[0], rest[1], para(""), rest[2]);
  const second = directEdits(fresh, next);
  assert.ok(second.requests.length && kinds(second.requests).every((k) => k === "deleteContentRange"), kinds(second.requests).join(","));
  // The PDF's text is left for the sync, all of it (typed into the paragraphs that are left, then new ones)
  assert.equal(additions(second.saved, next).text.replace(/\n/g, ""), "From the PDFIts first paragraph.");
  assert.deepEqual(directEdits(second.saved, next).requests, []);
});

test("Replace what's here keeps what the page can't change, each after an emptied paragraph", () => {
  const toc: EditorNode = { type: "paragraph", attrs: { kind: "toc", locked: true, span: 20, bid: "b2" }, content: [] };
  const first: EditorNode = { type: "paragraph", attrs: { kind: "section", first: true, sectionType: "continuous", columns: 2, spacing: 36, line: false, locked: true, span: 0, bid: "b1" }, content: [] };
  const next = replaceWithPdf(doc(first, { type: "columnSection", attrs: { columns: 2, spacing: 36, line: false }, content: [para("Intro", { styleName: "subtitle" }), toc, para("After")] }), pdfNodes);
  const flat = next.content!.flatMap((n) => (n.type === "columnSection" ? n.content! : [n]));
  // The document's first section break has no paragraph before it; the contents table does, emptied, in its style
  assert.deepEqual(flat.map((n) => n.attrs?.kind ?? n.content?.[0]?.text ?? `(empty ${n.attrs?.styleName})`), ["section", "(empty subtitle)", "toc", "From the PDF", "Its first paragraph."]);
  valid(next);
});

test("Replace what's here adds no paragraph between kept blocks that were next to each other: a contents table's entries, smart chips", () => {
  // A contents table is shown entry by entry: the first carries the whole table's size, the others none
  const entry = (text: string, span: number, bid: string): EditorNode => ({ type: "paragraph", attrs: { locked: true, span, bid }, content: [{ type: "text", text }] });
  const base = doc(para("Title", { styleName: "title" }), entry("Intro", 30, "b1"), entry("Method", 0, "b2"), entry("Results", 0, "b3"), para("Body text."), entry("@Alice", 8, "b4"), entry("@Bob", 6, "b5"), para("After"));
  const next = replaceWithPdf(base, pdfNodes);
  valid(next);
  assert.deepEqual(next.content!.map((n) => n.content?.[0]?.text ?? "(empty)"), ["(empty)", "Intro", "Method", "Results", "(empty)", "@Alice", "@Bob", "From the PDF", "Its first paragraph."]);
  // The save only deletes: no new paragraph goes into the Google Doc
  const { requests } = directEdits(base, next);
  assert.ok(requests.length && kinds(requests).every((k) => k === "deleteContentRange"), kinds(requests).join(","));
});

test("a header from a PDF is written straight into the new header, as Docs requests in that segment", async () => {
  const r = await importPdf(new Uint8Array(fs.readFileSync(path.join(process.cwd(), "fixtures", "pdf", "headerfooter-tagged.pdf"))));
  assert.ok(r.header?.length);
  const requests = segmentRequests(r.header!, "kix.hdr1");
  assert.ok(requests.length > 0);
  const insert = requests.find((q) => "insertText" in q) as { insertText: { text: string; location: { segmentId: string } } } | undefined;
  assert.ok(insert, kinds(requests).join(","));
  assert.match(insert.insertText.text, /Project Atlas/);
  assert.equal(insert.insertText.location.segmentId, "kix.hdr1");
  // Centred, as in the PDF
  const style = requests.find((q) => "updateParagraphStyle" in q) as { updateParagraphStyle: { paragraphStyle: { alignment?: string }; range: { segmentId: string } } } | undefined;
  assert.equal(style?.updateParagraphStyle.paragraphStyle.alignment, "CENTER");
  assert.equal(style?.updateParagraphStyle.range.segmentId, "kix.hdr1");
});

test("the summary, page and title read as plain English", () => {
  assert.equal(summaryLine({ pages: 12, stats: { paragraphs: 48, headings: 3, listItems: 0, tables: 2, images: 5, links: 9 } }), "12 pages · 3 headings · 48 paragraphs · 2 tables · 5 images");
  assert.equal(summaryLine({ pages: 1, stats: { paragraphs: 1, headings: 1, listItems: 1, tables: 1, images: 1, links: 0 } }), "1 page · 1 heading · 1 paragraph · 1 list item · 1 table · 1 image");
  assert.equal(summaryLine({ pages: 3, stats: { paragraphs: 1200, headings: 0, listItems: 0, tables: 0, images: 0, links: 0 } }), "3 pages · 1,200 paragraphs");
  assert.equal(pageLabel(DEFAULT_PAGE_SETUP), "Letter · 1 in margins");
  assert.equal(pageLabel({ ...DEFAULT_PAGE_SETUP, paper: "a4", margins: { top: 56.7, bottom: 56.7, left: 56.7, right: 56.7 } }), "A4 · 2 cm margins");
  assert.equal(pageLabel({ ...DEFAULT_PAGE_SETUP, orientation: "landscape", margins: { top: 72, bottom: 72, left: 36, right: 36 } }), "Letter, landscape · 1 in top and bottom, 0.5 in sides");
  assert.equal(pageLabel({ ...DEFAULT_PAGE_SETUP, paper: "a4", margins: { top: 56.7, bottom: 56.7, left: 70.85, right: 70.85 } }), "A4 · 2 cm top and bottom, 2.5 cm sides");
  assert.equal(pageLabel({ ...DEFAULT_PAGE_SETUP, margins: { top: 72, bottom: 72, left: 72, right: 82.5 } }), "Letter · top 1, bottom 1, left 1, right 1.15 in");
  assert.equal(pageLabel({ ...DEFAULT_PAGE_SETUP, custom: { w: 432, h: 648 } }), "6 × 9 in · 1 in margins");
  assert.equal(pdfTitle("Quarterly report.PDF"), "Quarterly report");
  assert.equal(pdfTitle("  notes   v2 .pdf"), "notes v2");
  assert.equal(pdfTitle(".pdf"), "Imported PDF");
});

test("a file is checked before it is sent", () => {
  assert.equal(checkFile({ name: "a.pdf", type: "application/pdf", size: 1000 }), null);
  assert.equal(checkFile({ name: "a.PDF", type: "", size: 1000 }), null);
  assert.match(checkFile({ name: "a.docx", type: "application/vnd.openxmlformats", size: 1000 })!, /isn't a PDF/);
  assert.match(checkFile({ name: "big.pdf", type: "application/pdf", size: MAX_PDF_BYTES + 1 })!, /This PDF is 4 MB\. You can import a PDF of up to 4 MB/);
  assert.match(checkFile({ name: "big.pdf", type: "application/pdf", size: 6.2 * 1024 * 1024 })!, /^This PDF is 6\.2 MB\./);
  assert.match(checkFile({ name: "e.pdf", type: "application/pdf", size: 0 })!, /empty/);
});

test("failures say what to do, in plain words", () => {
  assert.match(failureMessage(0, null), /offline/);
  assert.match(failureMessage(401, { error: "Unauthorized" }), /sign-in expired/);
  assert.match(failureMessage(413, { error: "Request too large" }), /over 4 MB/);
  assert.equal(failureMessage(429, { error: "Too many requests. Try again in 12 seconds." }), "You've imported several PDFs in a short time. Try again in 12 seconds.");
  assert.equal(failureMessage(422, { error: "This PDF is protected with a password. Remove the password, then import it again.", code: "encrypted" }), "This PDF is protected with a password. Remove the password, then import it again.");
  assert.match(failureMessage(504, null), /too long/);
  assert.match(failureMessage(502, "<html>Bad gateway</html>"), /^Couldn't import this PDF/);
});

test("the route's answer is checked before it reaches the page", () => {
  assert.equal(parseResult(null), null);
  assert.equal(parseResult({ nodes: [], pageSetup: DEFAULT_PAGE_SETUP, pages: 1, stats: {} }), null);
  assert.equal(parseResult({ nodes: pdfNodes, pageSetup: { paper: "nope" }, pages: 1, stats: {} }), null);
  const r = parseResult({ nodes: pdfNodes, pageSetup: DEFAULT_PAGE_SETUP, pages: 2, stats: { paragraphs: 3, images: -1, tables: "x" }, warnings: ["One", 2], fonts: ["Arial", null], header: [] });
  assert.ok(r);
  assert.deepEqual(r.stats, { paragraphs: 3, headings: 0, listItems: 0, tables: 0, images: 0, links: 0 });
  assert.deepEqual(r.warnings, ["One"]);
  assert.deepEqual(r.fonts, ["Arial"]);
  assert.equal("header" in r, false, "an empty header is no header");
});
