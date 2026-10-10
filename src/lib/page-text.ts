/**
 * Google's own pagination. Drive exports a Google Doc as PDF exactly as Docs
 * lays it out; the text of each PDF page says where Docs breaks pages. The
 * preview pins its page breaks to those places, so pages match for saved
 * content without reproducing Docs' layout engine.
 */

/** Text of each page of a PDF, in order */
export async function pdfPageTexts(data: ArrayBuffer | Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: data instanceof Uint8Array ? data : new Uint8Array(data), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      if (typeof item.str === "string") text += item.str;
      if (item.hasEOL) text += "\n";
    }
    pages.push(text);
  }
  return pages;
}
