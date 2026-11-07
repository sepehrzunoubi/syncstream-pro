/**
 * Build the small synthetic PDFs in fixtures/pdf that src/lib/pdf-import.test.ts reads, with
 * Chromium (Playwright): each page tagged (as Chrome's "Save as PDF" makes it with tags) and untagged.
 * Run once after changing a page; the PDFs are committed.
 *
 *   npx tsx scripts/pdf-eval/make-fixtures.ts
 *
 * The encrypted fixture is written with pypdf (python3 -I), when it is installed.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const req = createRequire(path.join(process.cwd(), "package.json"));
const { chromium } = req("playwright") as typeof import("playwright");
const { createCanvas } = req("@napi-rs/canvas") as typeof import("@napi-rs/canvas");

const OUT = path.join(process.cwd(), "fixtures", "pdf");

function png(): string {
  const c = createCanvas(200, 100);
  const g = c.getContext("2d");
  g.fillStyle = "#3c78d8"; g.fillRect(0, 0, 200, 100);
  g.fillStyle = "#ffd966"; g.fillRect(20, 20, 60, 60);
  g.fillStyle = "#cc0000"; g.beginPath(); g.arc(140, 50, 30, 0, Math.PI * 2); g.fill();
  return `data:image/png;base64,${c.toBuffer("image/png").toString("base64")}`;
}
function photo(): string {
  // Smooth colour everywhere, as a photograph has
  const c = createCanvas(160, 120);
  const g = c.getContext("2d");
  const img = g.createImageData(160, 120);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
    const k = (y * 160 + x) * 4;
    img.data[k] = (x * 255) / 160; img.data[k + 1] = (y * 255) / 120; img.data[k + 2] = ((x + y) * 3) % 256; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return `data:image/jpeg;base64,${c.toBuffer("image/jpeg", 90).toString("base64")}`;
}

const page = (body: string, css = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@page { size: Letter; margin: 1in; }
body { margin: 0; font-family: Arial; font-size: 11pt; line-height: 1.15; color: #000; }
p { margin: 0 0 8pt; }
${css}
</style></head><body>${body}</body></html>`;

const FIXTURES: Record<string, { html: string; pdf?: Record<string, unknown> }> = {
  styles: {
    html: page(`
<h1>Quarterly report</h1>
<h2>Summary of the year</h2>
<p>Plain text with <b>bold</b>, <i>italic</i>, <u>underlined</u>, <s>struck</s>, <span style="color:#cc0000">red</span> and <span style="background:#ffff00">highlighted</span> words, x<sup>2</sup> and H<sub>2</sub>O.</p>
<p style="text-align:center">A centered line.</p>
<p style="text-align:right">A line on the right.</p>
<p style="text-align:justify">This paragraph is justified and long enough to wrap across several lines, so the space between its words stretches on every line but the last one, which is how justified text shows itself.</p>
<p style="font-family:'Courier New'">Courier New line.</p>
<p style="font-family:'Times New Roman'; font-size:14pt; color:#1155cc">Times New Roman in blue at fourteen points.</p>
<p style="font-family:Calibri">Calibri line.</p>
<p>Read <a href="https://example.com/docs?id=7">the guide</a> or <a href="mailto:team@example.com">write to us</a>.</p>
<p style="margin-left:36pt">An indented paragraph.</p>
<p style="text-indent:36pt">A first-line indent: this paragraph is long enough to wrap onto a second line, which starts at the margin again.</p>
<p style="line-height:2">Double spaced: this paragraph is long enough to wrap onto a second and a third line, so its line pitch can be measured from the lines it has, as the pitch of any paragraph can be, however wide its spacing is.</p>
<p style="letter-spacing:3pt">Spaced letters</p>`, `
h1 { font-size: 20pt; margin: 0 0 6pt; }
h2 { font-family: 'Times New Roman'; font-size: 16pt; font-weight: normal; color: #434343; margin: 18pt 0 6pt; }`),
  },
  lists: {
    html: page(`
<p>Shopping:</p>
<ul><li>Apples</li><li>Bread<ul><li>White</li><li>Rye<ul><li>Dark rye</li></ul></li></ul></li><li>Milk</li></ul>
<p>Steps:</p>
<ol><li>Open the lid</li><li>Pour the water<ol type="a"><li>Cold water</li><li>Warm water<ol type="i"><li>Not hot</li><li>Not boiling</li></ol></li></ol></li><li>Close the lid</li></ol>
<p>Done.</p>`, "ul, ol { margin: 0 0 8pt; }"),
  },
  table: {
    html: page(`
<p>Team scores</p>
<table><tr><th style="width:90pt">Name</th><th style="width:120pt">Role</th><th style="width:60pt">Score</th></tr>
<tr><td>Alice</td><td>Engineer</td><td>93</td></tr>
<tr><td colspan="2" style="background:#d9ead3">Merged two columns</td><td>88</td></tr></table>
<p>After the table.</p>`, `
table { border-collapse: collapse; margin: 0 0 8pt; }
td, th { border: 1px solid #000; padding: 4pt 6pt; text-align: left; font-size: 11pt; }
th { background: #cfe2f3; }`),
  },
  borderless: {
    html: page(`
<p>Opening hours</p>
<table><tr><th>Day</th><th>Hours</th></tr><tr><td>Monday</td><td style="background:#fff2cc">9 to 5</td></tr><tr><td colspan="2">Closed on holidays</td></tr></table>
<p>See you soon.</p>`, "td, th { padding: 3pt 8pt; text-align: left; } table { margin: 0 0 8pt; }"),
  },
  images: {
    html: page(`
<p>The logo <img src="${png()}" width="150" height="75" alt="Logo"> sits in this line.</p>
<p style="text-align:center"><img src="${photo()}" width="160" height="120" alt="Photo"></p>
<p>After the images.</p>`),
  },
  columns: {
    html: page(`
<h1>Two columns</h1>
<div style="columns: 2; column-gap: 24pt; column-fill: auto; height: 220pt">
<p>The first column starts here and runs down the left half of the page. It is long enough to wrap over many lines, so the gutter between the columns stays clear from top to bottom.</p>
<p>A second paragraph in the first column, with more words to fill its lines up to the gutter and down the page a little further.</p>
<p style="break-before: column">The second column starts at the top of the right half. Its text is read after all of the first column, never line by line across the gutter.</p>
<p>The last paragraph of the second column ends the page.</p>
</div>`, "h1 { font-size: 20pt; margin: 0 0 12pt; } .columns p { text-align: left; }"),
  },
  headerfooter: {
    html: page(`
<p>Page one text. Each page of this document has the same header and a footer with its page number.</p>
<p style="break-before: page">Page two text, after a page break.</p>
<p style="break-before: page">Page three text, the last page.</p>`, "@page { size: A4; margin: 2cm 2.5cm; }"),
    pdf: {
      displayHeaderFooter: true,
      headerTemplate: '<div style="font-family: Arial; font-size: 9pt; width: 100%; text-align: center;">Project Atlas</div>',
      footerTemplate: '<div style="font-family: Arial; font-size: 9pt; width: 100%; text-align: center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    },
  },
  rtl: {
    html: page(`
<p>An English line first.</p>
<p dir="rtl" style="text-align: right">שלום עולם, זו שורה בעברית.</p>
<p>An English line after.</p>`),
  },
  scanned: {
    html: page(`<img src="${photo()}" width="400" height="300">`),
  },
  blank: {
    html: page(""),
  },
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const tab = await browser.newPage();
  for (const [name, f] of Object.entries(FIXTURES)) {
    await tab.setContent(f.html, { waitUntil: "load" });
    const variants = name === "scanned" || name === "blank" ? [[name, false]] as const : [[`${name}-tagged`, true], [`${name}-untagged`, false]] as const;
    for (const [file, tagged] of variants) {
      await tab.pdf({ path: path.join(OUT, `${file}.pdf`), preferCSSPageSize: true, printBackground: true, tagged, ...(f.pdf ?? {}) });
      console.log("wrote", `${file}.pdf`);
    }
  }
  await browser.close();
  // A password-protected copy (pypdf, when installed)
  try {
    execFileSync("python3", ["-I", "-c", [
      "import sys", "from pypdf import PdfReader, PdfWriter",
      "w = PdfWriter(clone_from=PdfReader(sys.argv[1]))", "w.encrypt(user_password='secret', owner_password='owner', algorithm='AES-128')", "w.write(sys.argv[2])",
    ].join("\n"), path.join(OUT, "rtl-untagged.pdf"), path.join(OUT, "encrypted.pdf")]);
    console.log("wrote encrypted.pdf");
  } catch (err) {
    console.warn("encrypted.pdf not written (needs python3 with pypdf):", (err as Error).message);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
