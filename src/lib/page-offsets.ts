/** Where Google's pages start in the saved text (page-text.ts reads the PDF; this stays free of pdf.js so the browser never loads it) */

/** Letters and digits only, lower case: what survives the trip through a PDF */
const NOT_WORD = new RegExp("[^\\p{L}\\p{N}]+", "gu");
const squash = (s: string) => s.toLowerCase().replace(NOT_WORD, "");

/**
 * For each page after the first, the offset in `body` where its text
 * starts, or null when it couldn't be placed. `body` is the document's text
 * with "\n" between paragraphs; headers, footers and footnotes are not in
 * it, so a page's first lines are tried until one is found in the body.
 */
export function pageStartOffsets(body: string, pages: string[]): (number | null)[] {
  // The body squashed, with each squashed character's offset in the original
  const map: number[] = [];
  let hay = "";
  for (let i = 0; i < body.length; i++) {
    const q = squash(body[i]);
    if (q) { hay += q; map.push(i); }
  }
  const out: (number | null)[] = [];
  let from = 0;
  for (let p = 1; p < pages.length; p++) {
    const lines = pages[p].split("\n").map((l) => squash(l)).filter((l) => l.length >= 8);
    let found: number | null = null;
    for (const line of lines.slice(0, 6)) {
      const needle = line.slice(0, 40);
      const at = hay.indexOf(needle, from);
      if (at >= 0 && hay.indexOf(needle, at + 1) < 0) { found = at; break; }
      if (at >= 0 && found == null) found = at;
    }
    if (found == null) { out.push(null); continue; }
    out.push(map[found]);
    from = found + 1;
  }
  return out;
}
