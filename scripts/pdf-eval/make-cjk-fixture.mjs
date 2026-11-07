/**
 * Write fixtures/pdf/cjk-cmap.pdf: Japanese text in a font the PDF only names (KozMinPr6N-Regular,
 * not embedded) with one of the character maps every PDF reader has (UniJIS-UCS2-H), as Acrobat
 * and Word write CJK text when they don't embed the font, and a line of Helvetica, also only named.
 * pdf.js reads that text only with its own character maps (cMapUrl); without them it drops it.
 * Written byte by byte, so the file is the same every time. The PDF is committed.
 *
 *   node scripts/pdf-eval/make-cjk-fixture.mjs
 */
import fs from "node:fs";
import path from "node:path";

// UniJIS-UCS2-H takes each character as its UTF-16 code: 日本語
const japanese = Buffer.from("日本語", "utf16le").swap16().toString("hex").toUpperCase();
const content = [
  "BT /F1 12 Tf 72 720 Td (Japanese below.) Tj ET",
  `BT /F2 12 Tf 72 680 Td <${japanese}> Tj ET`,
  "",
].join("\n");

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 8 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>",
  "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R /DW 1000 >>",
  // No FontFile: the font is only named
  "<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 6 /FontBBox [-437 -340 1144 1317] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 742 /StemV 80 >>",
  `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
];

let pdf = "%PDF-1.7\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, "latin1"));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const at of offsets) pdf += `${String(at).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const out = path.join(process.cwd(), "fixtures", "pdf", "cjk-cmap.pdf");
fs.writeFileSync(out, pdf, "latin1");
console.log(`wrote ${path.relative(process.cwd(), out)}`);
