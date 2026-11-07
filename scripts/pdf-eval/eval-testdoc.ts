/**
 * How faithfully importPdf rebuilds a Google Doc from its PDF export, scored
 * against the same document's HTML export (Docs writes every paragraph's
 * and span's style there). Local only, not run by npm test: point it at a
 * folder of exports named alike (doc.pdf + doc.html, tab_x.pdf + tab_x.html).
 *
 *   npx tsx scripts/pdf-eval/eval-testdoc.ts <folder> [--untagged] [--verbose]
 *
 * Scores, over the document's non-empty paragraphs:
 *   text     paragraphs whose text comes out exactly (spaces collapsed)
 *   kind     paragraph, heading, bulleted or numbered item, as the HTML has it
 *   level    list nesting level
 *   style    characters whose font, size, bold, italic, underline and strike all match
 *   color    characters whose text colour matches
 *   highlight characters whose highlight matches (where either has one)
 *   link     characters whose link matches (where either has one)
 *   align    paragraph alignment; indent: indent start within 1.5 pt
 * --verbose prints the paragraphs that differ (the document's own text: keep it local).
 */

import fs from "node:fs";
import path from "node:path";
import { importPdf } from "../../src/lib/pdf-import";
import type { EditorNode } from "../../src/lib/rich-text";

interface TruthChar { ch: string; font: string; size: number; bold: boolean; italic: boolean; underline: boolean; strike: boolean; color: string; bg: string | null; href: string | null }
interface Block { kind: string; level: number | null; align: string; indent: number; text: string; chars: TruthChar[] }

const ENTITIES: Record<string, string> = {
  nbsp: "\u00A0", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—",
  hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", times: "×",
  rarr: "→", larr: "←", shy: "\u00AD", laquo: "«", raquo: "»", sect: "§", para: "¶", plusmn: "±", frac12: "½", szlig: "ß",
};
/** Accented letters by name: &atilde; &eacute; &uuml; */
const ACCENTS: Record<string, string> = { grave: "\u0300", acute: "\u0301", circ: "\u0302", tilde: "\u0303", uml: "\u0308", ring: "\u030A", cedil: "\u0327" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
  if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  if (ENTITIES[e]) return ENTITIES[e];
  const a = /^([a-zA-Z])(grave|acute|circ|tilde|uml|ring|cedil)$/.exec(e);
  return a ? (a[1] + ACCENTS[a[2]]).normalize("NFC") : m;
});
const unwrap = (u: string | null) => {
  if (!u) return null;
  const m = /^https:\/\/www\.google\.com\/url\?q=([^&]*)/.exec(u);
  return m ? decodeURIComponent(m[1]) : u;
};

/** The paragraphs of a Docs HTML export with each character's style */
function truth(html: string): Block[] {
  const css = new Map<string, string>();
  for (const m of html.matchAll(/\.(c\d+)\{([^}]*)\}/g)) css.set(m[1], m[2]);
  const styleOf = (cls: string) => cls.split(/\s+/).map((c) => css.get(c) ?? "").join(";");
  const prop = (st: string, name: string) => new RegExp(`(?:^|;)${name}:([^;]+)`).exec(st)?.[1]?.trim() ?? null;
  const body = html.slice(html.indexOf("<body"));
  const out: Block[] = [];
  let list: { kind: string; level: number } | null = null;
  let cur: (Block & { pstyle: string }) | null = null;
  const spans: { style: string; href: string | null }[] = [];
  let href: string | null = null;
  for (const m of body.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (m[4] != null) {
      if (!cur) continue;
      const text = decode(m[4]);
      const st = spans[spans.length - 1]?.style ?? "";
      const font = (prop(st, "font-family") ?? "").replace(/["']/g, "").split(",")[0].trim();
      for (const ch of text) cur.chars.push({
        ch, font, size: parseFloat(prop(st, "font-size") ?? "11"), bold: prop(st, "font-weight") === "700", italic: prop(st, "font-style") === "italic",
        underline: /underline/.test(prop(st, "text-decoration") ?? ""), strike: /line-through/.test(prop(st, "text-decoration") ?? ""),
        color: prop(st, "color") ?? "#000000", bg: (() => { const b = prop(st, "background-color"); return b && b !== "#ffffff" ? b : null; })(), href: unwrap(href),
      });
      continue;
    }
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (!close && (tag === "ul" || tag === "ol")) {
      const lm = /lst-kix_[a-z0-9]+-(\d)/.exec(cls);
      list = { kind: tag, level: lm ? Number(lm[1]) : 0 };
    } else if (close && (tag === "ul" || tag === "ol")) list = null;
    else if (!close && /^(p|h[1-6]|li)$/.test(tag)) {
      const pstyle = styleOf(cls);
      cur = { kind: tag === "li" ? list?.kind ?? "ul" : tag, level: tag === "li" ? list?.level ?? 0 : null, align: prop(pstyle, "text-align") ?? "left", indent: parseFloat(prop(pstyle, "margin-left") ?? "0"), text: "", chars: [], pstyle };
    } else if (close && /^(p|h[1-6]|li)$/.test(tag) && cur) {
      cur.text = cur.chars.map((c) => c.ch).join("").replace(/\s+/g, " ").trim();
      out.push(cur);
      cur = null;
    } else if (tag === "span") {
      if (close) spans.pop(); else spans.push({ style: styleOf(cls), href });
    } else if (tag === "a") href = close ? null : decode(/href="([^"]*)"/.exec(attrs)?.[1] ?? "");
    else if (tag === "br" && cur) cur.chars.push({ ...(cur.chars[cur.chars.length - 1] ?? { font: "", size: 11, bold: false, italic: false, underline: false, strike: false, color: "#000000", bg: null, href: null }), ch: " " });
  }
  return out;
}

interface Ours { kind: string; level: number | null; align: string; indent: number; text: string; chars: TruthChar[] }

function ours(nodes: EditorNode[]): Ours[] {
  const out: Ours[] = [];
  const walk = (n: EditorNode) => {
    if (n.type === "table") { for (const row of n.content ?? []) for (const cell of row.content ?? []) for (const p of cell.content ?? []) walk(p); return; }
    if (n.type !== "paragraph") return;
    const a = n.attrs ?? {};
    const chars: TruthChar[] = [];
    for (const c of n.content ?? []) {
      if (c.type !== "text" && c.type !== "hardBreak") continue;
      const marks = c.marks ?? [];
      const ts = marks.find((m) => m.type === "textStyle")?.attrs ?? {};
      const style = {
        font: String(ts.fontFamily ?? ""), size: Number(ts.fontSize ?? 11), bold: marks.some((m) => m.type === "bold"), italic: marks.some((m) => m.type === "italic"),
        underline: marks.some((m) => m.type === "underline"), strike: marks.some((m) => m.type === "strike"), color: String(ts.color ?? "#000000"),
        bg: (marks.find((m) => m.type === "highlight")?.attrs?.color as string | undefined) ?? null, href: (marks.find((m) => m.type === "link")?.attrs?.href as string | undefined) ?? null,
      };
      for (const ch of c.type === "hardBreak" ? " " : c.text ?? "") chars.push({ ch, ...style });
    }
    const box = (a.box ?? {}) as { start?: number };
    out.push({
      kind: a.list === "bullet" ? "ul" : a.list === "ordered" ? "ol" : a.styleName && a.styleName !== "normal" ? (a.styleName === "title" || a.styleName === "subtitle" ? "p" : String(a.styleName)) : "p",
      level: a.list ? Number(a.level ?? 0) : null,
      align: (a.textAlign as string | null) ?? "left",
      indent: Number(box.start ?? 0),
      text: chars.map((c) => c.ch).join("").replace(/\s+/g, " ").trim(),
      chars,
    });
  };
  nodes.forEach(walk);
  return out;
}

const norm = (s: string) => s.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
/** Characters without the spaces, so a space Docs has and the PDF doesn't draw doesn't shift the rest */
const ink = (cs: TruthChar[]) => cs.filter((c) => !/\s/.test(c.ch));

interface Score { n: number; ok: number }
const pct = (s: Score) => (s.n ? `${((100 * s.ok) / s.n).toFixed(1)}% (${s.ok}/${s.n})` : "n/a");

async function scorePair(pdfPath: string, htmlPath: string, verbose: boolean, useTags: boolean) {
  const t0 = Date.now();
  const result = await importPdf(new Uint8Array(fs.readFileSync(pdfPath)), { useTags });
  const ms = Date.now() - t0;
  const tb = truth(fs.readFileSync(htmlPath, "utf8"));
  const ob = ours(result.nodes);
  const T = tb.filter((b) => b.text), O = ob.filter((b) => b.text);
  const s: Record<string, Score> = Object.fromEntries(["text", "kind", "level", "style", "color", "highlight", "link", "align", "indent"].map((k) => [k, { n: 0, ok: 0 }]));
  let j = 0;
  const misses: string[] = [];
  for (const t of T) {
    s.text.n++;
    let k = j;
    while (k < O.length && k < j + 6 && norm(O[k].text) !== norm(t.text)) k++;
    if (k >= O.length || norm(O[k].text) !== norm(t.text)) {
      if (verbose) {
        const a = norm(t.text), b = norm(O[j]?.text ?? "");
        let d = 0;
        while (d < a.length && a[d] === b[d]) d++;
        misses.push(`TEXT  truth: …${a.slice(Math.max(0, d - 40), d + 40)}\n      ours:  …${b.slice(Math.max(0, d - 40), d + 40)}`);
      }
      continue;
    }
    const o = O[k];
    j = k + 1;
    s.text.ok++;
    s.kind.n++; if (o.kind === t.kind) s.kind.ok++; else if (verbose) misses.push(`KIND  ${t.kind} → ${o.kind}: ${t.text.slice(0, 60)}`);
    if (t.level != null) { s.level.n++; if (o.level === t.level) s.level.ok++; else if (verbose) misses.push(`LEVEL ${t.level} → ${o.level}: ${t.text.slice(0, 60)}`); }
    s.align.n++; if (o.align === t.align) s.align.ok++; else if (verbose) misses.push(`ALIGN ${t.align} → ${o.align}: ${t.text.slice(0, 60)}`);
    s.indent.n++; if (Math.abs(o.indent - t.indent) <= 1.5) s.indent.ok++;
    const a = ink(t.chars), b = ink(o.chars);
    if (a.length !== b.length) continue;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      s.style.n++;
      const same = x.font === y.font && Math.abs(x.size - y.size) < 0.6 && x.bold === y.bold && x.italic === y.italic && x.underline === y.underline && x.strike === y.strike;
      if (same) s.style.ok++;
      else if (verbose && misses.length < 400) misses.push(`STYLE ${JSON.stringify({ ...x, ch: undefined, href: undefined })} → ${JSON.stringify({ ...y, ch: undefined, href: undefined })} at "${a.slice(Math.max(0, i - 8), i + 8).map((c) => c.ch).join("")}"`);
      s.color.n++; if (x.color === y.color) s.color.ok++;
      if (x.bg || y.bg) { s.highlight.n++; if (x.bg === y.bg) s.highlight.ok++; }
      if (x.href || y.href) { s.link.n++; if (x.href === y.href) s.link.ok++; else if (verbose && misses.length < 400) misses.push(`LINK  ${x.href} → ${y.href}`); }
    }
  }
  const emptyTruth = tb.filter((b) => !b.text).length, emptyOurs = ob.filter((b) => !b.text).length;
  console.log(`\n${path.basename(pdfPath)}: ${result.pages} pages, ${ms} ms, tagged ${result.tagged}, page ${result.pageSetup.paper} margins ${JSON.stringify(result.pageSetup.margins)}`);
  for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(10)} ${pct(v)}`);
  console.log(`  paragraphs: truth ${T.length} non-empty + ${emptyTruth} empty; ours ${O.length} non-empty + ${emptyOurs} empty`);
  if (result.warnings.length) console.log(`  warnings: ${result.warnings.join(" | ")}`);
  if (verbose) for (const m of misses.slice(0, 60)) console.log("   ", m);
  return s;
}

async function main() {
  const dir = process.argv[2];
  const verbose = process.argv.includes("--verbose");
  // --untagged: read by geometry alone, as an untagged PDF of the same document would be
  const useTags = !process.argv.includes("--untagged");
  if (!dir) { console.error("usage: eval-testdoc.ts <folder> [--verbose]"); process.exit(2); }
  const pairs = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf") && fs.existsSync(path.join(dir, f.replace(/\.pdf$/, ".html"))));
  const total: Record<string, Score> = {};
  for (const f of pairs) {
    const s = await scorePair(path.join(dir, f), path.join(dir, f.replace(/\.pdf$/, ".html")), verbose, useTags);
    for (const [k, v] of Object.entries(s)) { total[k] ??= { n: 0, ok: 0 }; total[k].n += v.n; total[k].ok += v.ok; }
  }
  console.log("\nAll files:");
  for (const [k, v] of Object.entries(total)) console.log(`  ${k.padEnd(10)} ${pct(v)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
