import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { importPdfForEditor, looksLikePdf, MAX_PDF_BODY, placeImages, readCapped, type PdfImportBody } from "./pdf-route";
import { PdfImportError, type PdfImportResult } from "./pdf-import";
import { PENDING_MARK } from "./doc-model";
import type { EditorNode } from "./rich-text";

const FIXTURES = path.join(process.cwd(), "fixtures", "pdf");
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, `${name}.pdf`)));
const BASE = "https://sync.example.test";

/** A store that hands out ids in order, and remembers what it was given */
function memoryStore() {
  const saved: { mime: string; base64: string }[] = [];
  return { saved, store: async (mime: string, base64: string) => { saved.push({ mime, base64 }); return `id${saved.length}`; } };
}

const images = (nodes: EditorNode[]): EditorNode[] => nodes.flatMap((n) => (n.type === "image" ? [n] : images(n.content ?? [])));
const ok = (r: Awaited<ReturnType<typeof importPdfForEditor>>): PdfImportBody => {
  assert.ok(r.ok, JSON.stringify(r.body));
  return r.body;
};

test("a PDF with images: each is stored and the content points at its copy", async () => {
  const { saved, store } = memoryStore();
  const body = ok(await importPdfForEditor(fixture("images-tagged"), { baseUrl: `${BASE}/`, store }));
  const imgs = images(body.nodes);
  assert.equal(imgs.length, 2);
  assert.deepEqual(imgs.map((i) => i.attrs?.src), [`${BASE}/api/images/id1`, `${BASE}/api/images/id2`]);
  assert.deepEqual(saved.map((s) => s.mime), ["image/png", "image/jpeg"]);
  // The stored bytes are the encoded image itself
  assert.equal(Buffer.from(saved[0].base64, "base64").subarray(1, 4).toString("latin1"), "PNG");
  // Still new text, every image
  assert.ok(imgs.every((i) => (i.marks ?? []).some((m) => m.type === PENDING_MARK)));
  assert.equal(body.stats.images, 2);
  assert.deepEqual(body.warnings, []);
  // Nothing in the answer is the reader's own: no image bytes, no keys
  assert.ok(!("images" in body));
  assert.ok(!JSON.stringify(body).includes("pdf-image:"));
});

test("the answer carries the page setup, header, fonts, pages and stats", async () => {
  const body = ok(await importPdfForEditor(fixture("headerfooter-tagged"), { baseUrl: BASE, store: memoryStore().store }));
  assert.equal(body.pages, 3);
  assert.equal(body.tagged, true);
  assert.equal(body.pageSetup.paper, "a4");
  assert.ok(body.header?.length, "the repeated header comes back");
  assert.deepEqual(body.fonts, ["Arial"]);
  assert.equal(typeof body.stats.paragraphs, "number");
});

test("an image the store refuses is left out, said once in the warnings, and not counted", async () => {
  let n = 0;
  const problems: string[] = [];
  const store = async () => { if (++n === 1) throw new Error("redis down"); return "kept"; };
  const body = ok(await importPdfForEditor(fixture("images-untagged"), { baseUrl: BASE, store, onProblem: (e) => problems.push(e) }));
  assert.deepEqual(images(body.nodes).map((i) => i.attrs?.src), [`${BASE}/api/images/kept`]);
  assert.equal(body.stats.images, 1);
  assert.deepEqual(body.warnings, ["An image in this PDF couldn't be copied."]);
  assert.deepEqual(problems, ["pdf.image_store_failed"]);
});

test("PDFs that can't be imported answer 422 with the reader's plain message and code", async () => {
  for (const [name, code] of [["encrypted", "encrypted"], ["scanned", "scanned"], ["blank", "empty"]] as const) {
    const r = await importPdfForEditor(fixture(name), { baseUrl: BASE, store: memoryStore().store });
    assert.equal(r.status, 422, name);
    const b = r.body as { error: string; code: string };
    assert.equal(b.code, code, name);
    assert.ok(b.error.length > 20 && !/error|exception/i.test(b.error), `${name}: "${b.error}" is for people`);
  }
});

test("a file that isn't a PDF is refused before it is read", async () => {
  let read = 0;
  const r = await importPdfForEditor(new TextEncoder().encode("<html>not a pdf</html>"), { baseUrl: BASE, read: async () => { read++; throw new Error("no"); } });
  assert.equal(r.status, 422);
  assert.equal((r.body as { code: string }).code, "invalid");
  assert.equal(read, 0);
  assert.equal((await importPdfForEditor(new Uint8Array(0), { baseUrl: BASE })).status, 422);
  // Damaged: starts like a PDF, isn't one
  const damaged = await importPdfForEditor(new TextEncoder().encode("%PDF-1.7\n garbage garbage"), { baseUrl: BASE });
  assert.equal(damaged.status, 422);
  assert.equal((damaged.body as { code: string }).code, "invalid");
});

test("too large: 413 without reading it", async () => {
  const big = new Uint8Array(MAX_PDF_BODY + 1);
  big.set(new TextEncoder().encode("%PDF-1.7"));
  const r = await importPdfForEditor(big, { baseUrl: BASE, read: async () => { throw new Error("read"); } });
  assert.equal(r.status, 413);
  assert.equal((r.body as { code: string }).code, "tooLarge");
  assert.match((r.body as { error: string }).error, /4 MB/);
});

test("a PDF that takes too long answers 504; the reader's own error codes pass through; anything else is a 500 that is reported", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7");
  const slow = await importPdfForEditor(pdf, { baseUrl: BASE, timeoutMs: 20, read: () => new Promise<PdfImportResult>(() => {}) });
  assert.equal(slow.status, 504);
  assert.equal((slow.body as { code: string }).code, "timeout");
  const long = await importPdfForEditor(pdf, { baseUrl: BASE, read: async () => { throw new PdfImportError("tooLarge", "This PDF has 400 pages. You can import up to 300 at a time."); } });
  assert.equal(long.status, 422);
  assert.deepEqual(long.body, { error: "This PDF has 400 pages. You can import up to 300 at a time.", code: "tooLarge" });
  const problems: unknown[] = [];
  const broken = await importPdfForEditor(pdf, { baseUrl: BASE, read: async () => { throw new TypeError("bug"); }, onProblem: (_e, err) => problems.push(err) });
  assert.equal(broken.status, 500);
  assert.equal((broken.body as { code: string }).code, "failed");
  assert.equal(problems.length, 1);
});

test("a PDF with very many images: storing them stops in time, and the ones not stored are left out, said in the warnings", async () => {
  // The function is allowed 60 s, the reading 45 s of them: storing has the rest, not as long as it takes
  const count = 400;
  const result: PdfImportResult = {
    nodes: [{ type: "paragraph", content: Array.from({ length: count }, (_, i) => ({ type: "image", attrs: { src: `pdf-image:img${i + 1}`, width: 10, height: 10 }, marks: [{ type: PENDING_MARK }] })) }],
    pageSetup: { paper: "letter", orientation: "portrait", margins: { top: 72, bottom: 72, left: 72, right: 72 } } as PdfImportResult["pageSetup"],
    images: Array.from({ length: count }, (_, i) => ({ key: `img${i + 1}`, mime: "image/png" as const, data: new Uint8Array([1, 2, 3]), width: 10, height: 10 })),
    fonts: [], pages: 1, tagged: false, warnings: [],
    stats: { paragraphs: 1, headings: 0, listItems: 0, tables: 0, images: count, links: 0 },
  };
  let stored = 0;
  // A store that takes 20 ms an image: 400 of them, 4 at a time, would take 2 s
  const store = async () => { await new Promise((r) => setTimeout(r, 20)); return `id${++stored}`; };
  const began = Date.now();
  const body = ok(await importPdfForEditor(fixture("images-tagged"), { baseUrl: BASE, read: async () => result, store, storeTimeoutMs: 200 }));
  const took = Date.now() - began;
  assert.ok(took < 1000, `answered after ${took} ms`);
  const placed = images(body.nodes);
  assert.ok(placed.length > 0 && placed.length < count, `${placed.length} placed`);
  assert.equal(placed.length, stored);
  assert.ok(placed.every((i) => String(i.attrs?.src).startsWith(`${BASE}/api/images/`)));
  assert.equal(body.stats.images, placed.length);
  assert.deepEqual(body.warnings, ["An image in this PDF couldn't be copied."]);
});

test("placeImages: nested images (table cells) are placed; other images stay as they are", () => {
  const img = (src: string): EditorNode => ({ type: "image", attrs: { src, width: 10, height: 10 }, marks: [{ type: PENDING_MARK }] });
  const nodes: EditorNode[] = [
    { type: "paragraph", content: [img("pdf-image:img1"), { type: "text", text: "a" }, img("https://elsewhere.test/x.png")] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [img("pdf-image:img2"), img("pdf-image:gone")] }] }] }] },
  ];
  const out = placeImages(nodes, new Map([["img1", "u1"], ["img2", "u2"]]));
  assert.equal(out.dropped, 1);
  assert.deepEqual(images(out.nodes).map((i) => i.attrs?.src), ["u1", "https://elsewhere.test/x.png", "u2"]);
  // The input is left as it was
  assert.equal(images(nodes)[0].attrs?.src, "pdf-image:img1");
});

test("looksLikePdf and readCapped", async () => {
  assert.equal(looksLikePdf(new TextEncoder().encode("%PDF-1.4\n...")), true);
  assert.equal(looksLikePdf(new TextEncoder().encode("\xef\xbb\xbf junk %PDF-1.4")), true);
  assert.equal(looksLikePdf(new TextEncoder().encode("PK\x03\x04 a zip")), false);
  const stream = (parts: number[]) => new ReadableStream<Uint8Array>({ start(c) { for (const n of parts) c.enqueue(new Uint8Array(n)); c.close(); } });
  assert.equal((await readCapped(stream([3, 4]), 10))?.length, 7);
  assert.equal(await readCapped(stream([6, 6]), 10), null);
  assert.equal((await readCapped(null, 10))?.length, 0);
});
