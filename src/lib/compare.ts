/**
 * Compare & Sync's engine: what the reference (RIGHT) has that your document (LEFT) lacks, put where
 * the reference has it.
 *
 * Per reference tab, LEFT's tab comes back exactly as it is (every node, mark and attribute) with the
 * reference's missing content added where the reference has it, marked as pending additions
 * (`syncAdd`), so the ordinary sync types it in. Paragraphs are anchored where both sides have the
 * same text, the rest paired by how many of LEFT's words a reference paragraph has, in order. Inside
 * a paragraph both have, words are compared after normalizing (quotes, spaces, case, a typo), and
 * only the reference's missing words are added, with the reference's look. Nothing of LEFT is
 * deleted, moved or restyled: what differs and can't be added is listed as left as it is.
 *
 * Pure and deterministic: the page shows the preview with it, and the server repeats it from fresh
 * reads when the sync starts (the same revisions give the same answer, change ids included).
 */

import {
  anchorPairs,
  closeWords,
  countWords,
  hashId,
  isSpaceChar,
  isWordChar,
  lcsPairs,
  normalize,
  preview,
  quoted,
  textUnits,
  wordsInOrder,
  wordsOf,
  type Unit,
} from "./compare-text";
import type {
  Change,
  ChangeKind,
  CompareBreak,
  CompareOptions,
  CompareResult,
  CompareSide,
  CompareTab,
  Kept,
  KeptKind,
  TabCompare,
  TabMap,
  TabTarget,
  Unsupported,
  UnsupportedKind,
} from "./compare-types";
import type { ImportedSegment } from "./doc-import";
import { BREAK_MARK, groupColumns, PENDING_MARK, tokenize } from "./doc-model";
import { presetForLevels, type Glyph } from "./list-labels";
import { DEFAULT_PAGE_SETUP, PAPERS, samePageSetup, type PageSetup } from "./page-setup";
import { OBJ, PAGE_BREAK, paragraphFromAttrs, sameStyle, styleFromMarks, type EditorNode } from "./rich-text";

type Marks = NonNullable<EditorNode["marks"]>;

/**
 * The one paragraph of a new tab, as a new Google Doc tab is read (Google's default named styles):
 * the base a new tab's content is put into
 */
export const NEW_TAB_PARAGRAPH: EditorNode = {
  type: "paragraph",
  attrs: { styleName: "normal", textAlign: null, indent: 0, firstLine: false, lineSpacing: 115, list: null, indentEnd: null, box: { start: 0, first: 0, above: 0, below: 0 }, keep: null, borders: null, shading: null, spacingMode: null },
  content: [],
};

// ── Reading a tab ───────────────────────────────────────────────────────────

/** One token of a paragraph's content, as doc-model's tokenize has it */
interface Atom {
  kind: "c" | "img" | "br" | "pb" | "fn";
  ch: string;
  node: EditorNode;
  /** Its index in its document's tokens */
  tok: number;
}

interface Para {
  t: "p";
  node: EditorNode;
  atoms: Atom[];
  /** Token of its paragraph end (a chip paragraph's one token) */
  nl: number;
  /** A locked paragraph with smart chips: read for its text only */
  chip: boolean;
  text: string;
  /** Normalized text, null for an empty or blank line */
  key: string | null;
  words: string[];
  units?: Unit[];
  wordCounts?: Map<string, number>;
}
interface Locked { t: "lock"; node: EditorNode; tok: number; text: string; key: string; what: UnsupportedKind }
interface Cell { node: EditorNode; tok: number; end: number; blocks: Block[] }
interface Row { node: EditorNode; tok: number; end: number; cells: Cell[] }
interface Table { t: "table"; node: EditorNode; tok: number; end: number; rows: Row[]; key: string | null; words: string[]; text: string; wordCounts?: Map<string, number> }
type Block = Para | Locked | Table;

const firstTok = (b: Block) => (b.t === "p" ? b.atoms[0]?.tok ?? b.nl : b.tok);
/** A block's last token (inclusive) */
const lastTok = (b: Block) => (b.t === "p" ? b.nl : b.t === "lock" ? b.tok : b.end);

const INLINE_ATOMS = new Set(["image", "hardBreak", "pageBreak", "footnoteRef"]);
const atomsIn = (child: EditorNode) => (child.type === "text" ? child.text?.length ?? 0 : INLINE_ATOMS.has(child.type ?? "") ? 1 : 0);
const flatten = (nodes: EditorNode[]): EditorNode[] => nodes.flatMap((n) => (n.type === "columnSection" ? flatten(n.content ?? []) : [n]));
const plainText = (n: EditorNode): string => (n.type === "text" ? n.text ?? "" : (n.content ?? []).map(plainText).join(n.type === "paragraph" ? "" : " "));

/** Docs' smart chips as the importer shows them: a person's name or a link's title, in Docs' link blue */
const chipLook = (marks: Marks | undefined) => !!marks?.some((m) => m.type === "textStyle" && m.attrs?.color === "#1155cc" && m.attrs?.fontFamily == null);
const isChip = (node: EditorNode) => !node.attrs?.kind && (node.content ?? []).some((c) => c.type === "text" && chipLook(c.marks));

/** The blocks of a document, with the token each starts at, read as doc-model's tokenize reads it */
function readBlocks(nodes: EditorNode[]): Block[] {
  let pos = 0;
  const para = (node: EditorNode, chipTok: number): Para => {
    const chip = chipTok >= 0;
    const atoms: Atom[] = [];
    for (const child of node.content ?? []) {
      if (child.type === "text" && typeof child.text === "string") {
        for (let i = 0; i < child.text.length; i++) atoms.push({ kind: "c", ch: child.text[i], node: child, tok: chip ? chipTok : pos++ });
      } else if (chip) continue;
      else if (child.type === "image") atoms.push({ kind: "img", ch: OBJ, node: child, tok: pos++ });
      else if (child.type === "hardBreak") atoms.push({ kind: "br", ch: "\n", node: child, tok: pos++ });
      else if (child.type === "pageBreak") atoms.push({ kind: "pb", ch: PAGE_BREAK, node: child, tok: pos++ });
      else if (child.type === "footnoteRef") atoms.push({ kind: "fn", ch: "", node: child, tok: pos++ });
    }
    const nl = chip ? chipTok : pos++;
    const text = atoms.map((a) => a.ch).join("");
    const flat = normalize(text).replace(/\s+/g, " ").trim();
    const objects = atoms.filter((a) => a.kind === "img" || a.kind === "pb" || a.kind === "fn").map((a) => a.kind).join(",");
    const key = flat || objects ? `p:${flat || objects}` : null;
    return { t: "p", node, atoms, nl, chip, text, key, words: wordsOf(text) };
  };
  const paragraph = (node: EditorNode, top: boolean): Block => {
    if (!node.attrs?.locked) return para(node, -1);
    const tok = pos++;
    if (isChip(node)) return para(node, tok);
    const text = plainText(node);
    const kind = node.attrs.kind;
    const what: UnsupportedKind = kind === "rule" ? "rule" : kind === "section" ? ((node.attrs.columns as number) > 1 ? "columns" : "other") : "other";
    return { t: "lock", node, tok, text, key: `l:${kind ?? (top ? "" : "cell")}:${normalize(text).trim()}`, what };
  };
  const table = (node: EditorNode): Table => {
    const tok = pos++;
    const rows: Row[] = (node.content ?? []).map((row) => {
      const rowTok = pos++;
      const cells: Cell[] = (row.content ?? []).map((cell) => {
        const cellTok = pos++;
        const content = cell.content?.length ? cell.content : [{ type: "paragraph", attrs: {}, content: [] }];
        const blocks = content.map((p) => paragraph(p, false));
        return { node: cell, tok: cellTok, end: pos++, blocks };
      });
      return { node: row, tok: rowTok, cells, end: pos++ };
    });
    const end = pos++;
    const text = rows.map((r) => r.cells.map((c) => c.blocks.map((b) => b.text).join(" ")).join(" | ")).join(" / ");
    const flat = normalize(text).replace(/\s+/g, " ").trim();
    return { t: "table", node, tok, end, rows, key: `t:${rows.length}:${flat}`, words: wordsOf(text), text };
  };
  const blocks = flatten(nodes).map((n) => (n.type === "table" ? table(n) : paragraph(n, true)));
  // A table of contents: its first paragraph covers the whole table's indices, the others none
  for (let i = 0; i + 1 < blocks.length; i++) {
    const b = blocks[i];
    if (b.t !== "lock" || b.what !== "other" || !((b.node.attrs?.span as number) > 0)) continue;
    let j = i + 1;
    while (j < blocks.length && blocks[j].t === "lock" && (blocks[j].node.attrs?.span ?? 0) === 0 && !blocks[j].node.attrs?.kind) j++;
    if (j > i + 1) for (let q = i; q < j; q++) (blocks[q] as Locked).what = "toc";
    i = j - 1;
  }
  return blocks;
}

/** The units of a paragraph: words, spaces, marks and objects, with where each sits in its content */
function unitsOf(p: Para): Unit[] {
  if (p.units) return p.units;
  const out: Unit[] = [];
  let text = "";
  let start = 0;
  const flush = () => { if (text) out.push(...textUnits(text, start)); text = ""; };
  p.atoms.forEach((a, i) => {
    if (a.kind === "c") { if (!text) start = i; text += a.ch; return; }
    flush();
    out.push({ kind: "x", from: i, to: i + 1, raw: a.kind, norm: a.kind });
  });
  flush();
  p.units = out.filter((u) => u.kind !== "z");
  return p.units;
}

/** How a paragraph looks, as a sync would set it (list glyph styles aside) */
const lookOf = (attrs: Record<string, unknown> | undefined) => {
  const f = paragraphFromAttrs(attrs);
  delete f.preset;
  delete f.glyph;
  return JSON.stringify(f);
};
const isHeading = (p: Para) => /^(h[1-6]|title|subtitle)$/.test(String(p.node.attrs?.styleName ?? ""));
const isListItem = (p: Para) => !!p.node.attrs?.list;
const imageCount = (p: Para) => p.atoms.filter((a) => a.kind === "img").length;

// ── Pairing blocks ──────────────────────────────────────────────────────────

/** How often each of a block's words comes in it */
function countsOf(b: Para | Table): Map<string, number> {
  if (b.wordCounts) return b.wordCounts;
  const counts = new Map<string, number>();
  for (const w of b.words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return (b.wordCounts = counts);
}

/** How well a LEFT block and a reference block are the same block; 0 when they aren't */
function similarity(l: Block, r: Block): number {
  if (l.t === "p" && r.t === "p") {
    if (l.key == null || r.key == null) return l.key == null && r.key == null && !l.chip && !r.chip ? 0.5 : 0;
    const lw = l.words.length;
    if (!lw) return l.key === r.key ? 2 : !r.words.length && imageCount(l) > 0 && imageCount(l) === imageCount(r) ? 0.8 : 0;
    return pairScore(l, r, 0.6);
  }
  if (l.t === "table" && r.t === "table") {
    if (!l.words.length) return r.words.length ? 0.5 : 1;
    return pairScore(l, r, 0.5, false);
  }
  if (l.t === "lock" && r.t === "lock") return l.key === r.key ? 2 : l.what === r.what && (l.what === "toc" || l.what === "rule") ? 0.5 : 0;
  return 0;
}

/**
 * Whether a LEFT block is the reference block with pieces missing: at least `least` of LEFT's words
 * are in it in order (or nearly all of them, sentences moved around); for paragraphs, not when a
 * third of LEFT's words stand where the reference has other words (that's a rewrite: the reference's
 * paragraph is added as it is). More of both in common scores higher.
 */
function pairScore(l: Para | Table, r: Para | Table, least: number, rewrites = true): number {
  const lw = l.words.length;
  const rw = r.words.length;
  // Their words in common, each counted as often as both have it: a quick no for most pairs
  const have = countsOf(r);
  const used = new Map<string, number>();
  let shared = 0;
  for (const w of l.words) {
    const n = used.get(w) ?? 0;
    if (n < (have.get(w) ?? 0)) { shared++; used.set(w, n + 1); }
  }
  if (shared < least * lw) return 0;
  const n = wordsInOrder(l.words, r.words);
  const inOrder = n >= least * lw;
  const reordered = shared >= 0.9 * lw && shared >= 0.5 * rw;
  if (!inOrder && !reordered) return 0;
  if (rewrites && lw * rw <= 40_000) {
    let replaced = 0;
    let pi = -1;
    let pj = -1;
    for (const [i, j] of [...lcsPairs(lw, rw, (a, b) => l.words[a] === r.words[b], 400), [lw, rw] as [number, number]]) {
      // LEFT's words in a place where the reference has others, unless a typo apart
      const mine = l.words.slice(pi + 1, i);
      const theirs = r.words.slice(pj + 1, j);
      if (mine.length && theirs.length) replaced += mine.filter((w) => !theirs.some((x) => closeWords(w, x))).length;
      pi = i;
      pj = j;
    }
    if (replaced && replaced * 3 >= lw) return 0;
  }
  return 1 + n / Math.max(lw, rw);
}

/** Pairs of LEFT and reference blocks that are the same block, in order */
function pairBlocks(L: Block[], R: Block[]): [number, number][] {
  const anchors = anchorPairs(L.map((b) => b.key), R.map((b) => b.key));
  const out: [number, number][] = [];
  let pl = 0;
  let pr = 0;
  for (const [i, j] of [...anchors, [L.length, R.length] as [number, number]]) {
    if (i > pl && j > pr) out.push(...pairGap(L, R, pl, i, pr, j));
    if (i < L.length) out.push([i, j]);
    pl = i + 1;
    pr = j + 1;
  }
  return out;
}

/** The best pairing of what's between two anchors, by similarity (in order) */
function pairGap(L: Block[], R: Block[], l0: number, l1: number, r0: number, r1: number): [number, number][] {
  const n = l1 - l0;
  const m = r1 - r0;
  if (n * m > 40_000) {
    // Too many to weigh every pair: each LEFT block takes the best of the next few reference ones (the
    // first that is nearly all of it, when one is)
    const out: [number, number][] = [];
    let from = r0;
    for (let i = l0; i < l1; i++) {
      let best = -1;
      let bestScore = 0;
      for (let j = from; j < Math.min(r1, from + 64); j++) {
        const s = similarity(L[i], R[j]);
        if (s > bestScore) { best = j; bestScore = s; }
        if (s >= 1.9) break;
      }
      if (best >= 0) { out.push([i, best]); from = best + 1; }
    }
    return out;
  }
  const W = m + 1;
  const total = new Float64Array((n + 1) * W);
  const sim = new Float64Array(n * m);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = similarity(L[l0 + i - 1], R[r0 + j - 1]);
      sim[(i - 1) * m + j - 1] = s;
      let best = Math.max(total[(i - 1) * W + j], total[i * W + j - 1]);
      if (s > 0) best = Math.max(best, total[(i - 1) * W + j - 1] + s);
      total[i * W + j] = best;
    }
  }
  const out: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = sim[(i - 1) * m + j - 1];
    if (s > 0 && total[i * W + j] === total[(i - 1) * W + j - 1] + s) { out.push([l0 + i - 1, r0 + j - 1]); i--; j--; }
    else if (total[(i - 1) * W + j] >= total[i * W + j - 1]) i--;
    else j--;
  }
  return out.reverse();
}

// ── The plan: what goes where ───────────────────────────────────────────────

/** Reference text added inside a LEFT paragraph: content [from, to) of the reference paragraph, at LEFT content token `at` */
interface Insert {
  at: number;
  from: number;
  to: number;
  /** A space before or after it, so words never run together */
  padBefore: boolean;
  padAfter: boolean;
  words: string[];
  moved?: boolean;
}

type Item =
  | { k: "L"; b: Block; moved?: boolean }
  | { k: "M"; l: Block; r: Block; fill?: boolean; inserts?: Insert[]; table?: TablePlan }
  | { k: "R"; b: Block; drop?: "moved" | "spacing" | "unsupported" };

type RowItem = { k: "L"; row: Row } | { k: "M"; l: Row; r: Row; cells: (Item[] | null)[] } | { k: "R"; row: Row };
interface TablePlan { rows: RowItem[]; shape: boolean }

interface Notes {
  kept: Map<KeptKind, Kept>;
  unsupported: Map<UnsupportedKind, Unsupported>;
  /** Each sequence of blocks the plan has (the tab's, each cell's), for the passes over all of them */
  seqs: Item[][];
  /** Words LEFT has in paragraphs both have that the reference doesn't: text a moved run may be */
  pool: string[][];
}

/** LEFT's blocks and the reference's, in the merged order */
function itemsOf(L: Block[], R: Block[], notes: Notes): Item[] {
  const pairs = pairBlocks(L, R);
  // A container's empty last paragraph (a blank document's, an empty cell's) takes the reference's last
  // paragraph when they look the same: no empty line is left after the copy
  let fill: [number, number] | null = null;
  const li = L.length - 1;
  const ri = R.length - 1;
  const last = pairs[pairs.length - 1];
  if (li >= 0 && ri >= 0 && (!last || (last[0] < li && last[1] < ri))) {
    const l = L[li];
    const r = R[ri];
    if (l.t === "p" && !l.chip && !l.atoms.length && r.t === "p" && r.key != null && lookOf(l.node.attrs) === lookOf(r.node.attrs)) fill = [li, ri];
  }
  if (fill) pairs.push(fill);
  const items: Item[] = [];
  let pl = 0;
  let pr = 0;
  for (const [i, j] of [...pairs, [L.length, R.length] as [number, number]]) {
    // Between two pairs: LEFT's own blocks, the reference's new ones, then LEFT's empty lines (a
    // container's last paragraph among them, which nothing can be typed after)
    let blanks = i;
    while (blanks > pl && L[blanks - 1].t === "p" && (L[blanks - 1] as Para).key == null) blanks--;
    for (let q = pl; q < blanks; q++) items.push({ k: "L", b: L[q] });
    for (let q = pr; q < j; q++) items.push({ k: "R", b: R[q] });
    for (let q = blanks; q < i; q++) items.push({ k: "L", b: L[q] });
    if (i < L.length) items.push({ k: "M", l: L[i], r: R[j], ...(fill && fill[0] === i ? { fill: true } : {}) });
    pl = i + 1;
    pr = j + 1;
  }
  notes.seqs.push(items);
  for (const it of items) {
    if (it.k !== "M") continue;
    // (An empty last paragraph taking the reference's last one takes it whole: see buildSeq)
    if (it.l.t === "p" && it.r.t === "p") it.inserts = it.fill || it.l.chip ? [] : diffParagraph(it.l, it.r, notes);
    else if (it.l.t === "table" && it.r.t === "table") it.table = planTable(it.l, it.r, notes);
  }
  return items;
}

function keep(notes: Notes, kind: KeptKind, sample?: string, count = 1) {
  const k = notes.kept.get(kind);
  if (k) k.count += count;
  else notes.kept.set(kind, { kind, rightTabId: null, leftTabId: null, count, ...(sample ? { sample } : {}) });
}

function unsupported(notes: Notes, kind: UnsupportedKind, sample: string, asText = false) {
  const u = notes.unsupported.get(kind);
  if (u) u.count++;
  else notes.unsupported.set(kind, { kind, rightTabId: "", count: 1, ...(sample ? { sample: preview(sample, 60) } : {}), ...(asText ? { asText: true } : {}) });
}

const sizeOf = (n: EditorNode) => [Number(n.attrs?.width) || 0, Number(n.attrs?.height) || 0];
/** The same image: the same source, or the same size give or take 3% */
function sameImage(a: EditorNode, b: EditorNode): boolean {
  if (a.attrs?.src && a.attrs.src === b.attrs?.src) return true;
  const [aw, ah] = sizeOf(a);
  const [bw, bh] = sizeOf(b);
  if (!aw || !ah || !bw || !bh) return !aw && !ah && !bw && !bh;
  return Math.abs(aw - bw) <= 0.03 * Math.max(aw, bw) && Math.abs(ah - bh) <= 0.03 * Math.max(ah, bh);
}

/**
 * The reference's words missing from a paragraph both have: a word-level comparison (words the same
 * once normalized first, then words a typo apart), and each run of the reference's missing words put
 * where the reference has it, after LEFT's own words in the same place
 */
function diffParagraph(l: Para, r: Para, notes: Notes): Insert[] {
  const lu = unitsOf(l);
  const ru = unitsOf(r);
  const same = (i: number, j: number) => {
    const a = lu[i];
    const b = ru[j];
    if (a.kind !== b.kind) return false;
    if (a.kind === "s") return true;
    if (a.kind === "x") return a.raw === b.raw && (a.raw !== "img" || sameImage(l.atoms[a.from].node, r.atoms[b.from].node));
    return a.norm === b.norm;
  };
  const exact = lcsPairs(lu.length, ru.length, same);
  // Between those, words a typo apart are the same word
  const pairs: [number, number][] = [];
  let pi = 0;
  let pj = 0;
  for (const [i, j] of [...exact, [lu.length, ru.length] as [number, number]]) {
    if (i > pi && j > pj && (i - pi) * (j - pj) <= 40_000) {
      for (const [a, b] of lcsPairs(i - pi, j - pj, (x, y) => lu[pi + x].kind === "w" && ru[pj + y].kind === "w" && closeWords(lu[pi + x].norm, ru[pj + y].norm), 400)) pairs.push([pi + a, pj + b]);
    }
    if (i < lu.length) pairs.push([i, j]);
    pi = i + 1;
    pj = j + 1;
  }
  // What the pairs say LEFT keeps as it is
  let formatting = false;
  for (const [i, j] of pairs) {
    const a = lu[i];
    const b = ru[j];
    if (a.kind === "w" && a.raw !== b.raw) keep(notes, "spelling", `${quoted(a.raw)} / ${quoted(b.raw)}`);
    else if (a.kind === "s" && a.raw !== b.raw) keep(notes, "spacing");
    if (!formatting && a.kind !== "s") {
      for (let k = 0; k < a.to - a.from && k < b.to - b.from; k++) {
        if (!sameStyle(styleFromMarks(l.atoms[a.from + k].node.marks), styleFromMarks(r.atoms[b.from + k].node.marks))) { formatting = true; break; }
      }
    }
  }
  if (formatting) keep(notes, "formatting", preview(l.text, 40));
  if (lookOf(l.node.attrs) !== lookOf(r.node.attrs)) keep(notes, "paragraphStyle", preview(l.text, 40));

  const inserts: Insert[] = [];
  let prevI = -1;
  let prevJ = -1;
  for (const [i, j] of [...pairs, [lu.length, ru.length] as [number, number]]) {
    // LEFT's own words here stay; the reference's go after them
    const ownWords = lu.slice(prevI + 1, i).filter((u) => u.kind === "w").map((u) => u.norm);
    if (ownWords.length) { keep(notes, "onlyLeft", lu.slice(prevI + 1, i).map((u) => u.raw).join("").trim()); notes.pool.push(ownWords); }
    let a = prevJ + 1;
    let b = j;
    const at = i < lu.length ? lu[i].from : l.atoms.length;
    const before = at > 0 ? l.atoms[at - 1] : undefined;
    const after = at < l.atoms.length ? l.atoms[at] : undefined;
    const charOf = (x: Atom | undefined) => (x?.kind === "c" ? x.ch : x ? "\u0000" : undefined);
    // Spaces that would double LEFT's own (or start or end the paragraph) aren't added
    while (a < b && ru[a].kind === "s" && (!before || isSpaceChar(charOf(before)))) a++;
    while (b > a && ru[b - 1].kind === "s" && (!after || isSpaceChar(charOf(after)))) b--;
    if (a < b) {
      const run = ru.slice(a, b);
      if (run.every((u) => u.kind === "s")) keep(notes, "spacing");
      else {
        const first = r.atoms[run[0].from];
        const last = r.atoms[run[run.length - 1].to - 1];
        inserts.push({
          at,
          from: run[0].from,
          to: run[run.length - 1].to,
          padBefore: isWordChar(charOf(before)) && isWordChar(charOf(first)),
          padAfter: isWordChar(charOf(after)) && isWordChar(charOf(last)),
          words: run.filter((u) => u.kind === "w").map((u) => u.norm),
        });
      }
    }
    prevI = i;
    prevJ = j;
  }
  return inserts;
}

/** Whether two tables have the same columns and no merged cells, so rows can be added */
function plainGrid(t: Table): number | null {
  let width = -1;
  for (const row of t.rows) {
    if (row.cells.some((c) => (Number(c.node.attrs?.colspan) || 1) > 1 || (Number(c.node.attrs?.rowspan) || 1) > 1)) return null;
    if (width >= 0 && row.cells.length !== width) return null;
    width = row.cells.length;
  }
  return width;
}

const rowText = (row: Row) => row.cells.map((c) => c.blocks.map((b) => b.text).join(" ")).join(" | ");

/**
 * A table both have: with the same columns, rows are paired by their text and the reference's
 * missing rows added where it has them; otherwise only the cells at the same place are compared
 */
function planTable(l: Table, r: Table, notes: Notes): TablePlan {
  const lw = plainGrid(l);
  const rw = plainGrid(r);
  const cellsOf = (lr: Row, rr: Row) => lr.cells.map((c, k) => (rr.cells[k] ? itemsOf(c.blocks, rr.cells[k].blocks, notes) : null));
  if (lw != null && lw === rw) {
    const lk = l.rows.map((row) => `${normalize(rowText(row)).replace(/\s+/g, " ").trim()}`);
    const rk = r.rows.map((row) => `${normalize(rowText(row)).replace(/\s+/g, " ").trim()}`);
    const anchors = anchorPairs(lk.map((k) => k || null), rk.map((k) => k || null));
    const pairs: [number, number][] = [];
    let pl = 0;
    let pr = 0;
    for (const [i, j] of [...anchors, [l.rows.length, r.rows.length] as [number, number]]) {
      // Between anchors, rows pair by their words, then by place
      let from = pr;
      for (let q = pl; q < i; q++) {
        const words = wordsOf(rowText(l.rows[q]));
        for (let s = from; s < j; s++) {
          const theirs = wordsOf(rowText(r.rows[s]));
          if (!words.length ? !theirs.length || i - pl === j - pr : wordsInOrder(words, theirs) >= 0.5 * words.length) { pairs.push([q, s]); from = s + 1; break; }
        }
      }
      if (i < l.rows.length) pairs.push([i, j]);
      pl = i + 1;
      pr = j + 1;
    }
    const rows: RowItem[] = [];
    pl = 0;
    pr = 0;
    for (const [i, j] of [...pairs, [l.rows.length, r.rows.length] as [number, number]]) {
      for (let q = pr; q < j; q++) rows.push({ k: "R", row: r.rows[q] });
      for (let q = pl; q < i; q++) rows.push({ k: "L", row: l.rows[q] });
      if (i < l.rows.length) rows.push({ k: "M", l: l.rows[i], r: r.rows[j], cells: cellsOf(l.rows[i], r.rows[j]) });
      pl = i + 1;
      pr = j + 1;
    }
    return { rows, shape: true };
  }
  // Other columns or merged cells: the cells at the same row and place
  keep(notes, "tableShape", preview(l.text, 40));
  const rows: RowItem[] = l.rows.map((row, i) => (r.rows[i] ? { k: "M", l: row, r: r.rows[i], cells: cellsOf(row, r.rows[i]) } : { k: "L", row }));
  return { rows, shape: false };
}

/**
 * Content the reference has twice as often as LEFT is copied, content LEFT has elsewhere isn't: a
 * reference paragraph that is one of LEFT's unpaired ones, or a run of 4 words or more LEFT has in
 * text no reference text took, is "moved". Lone empty lines the reference has more of aren't copied.
 */
function settle(notes: Notes) {
  // LEFT's unpaired paragraphs by their text, and all the words LEFT has that no reference text took
  const keys = new Map<string, Extract<Item, { k: "L" }>[]>();
  const pool: string[] = notes.pool.map((w) => ` ${w.join(" ")} `);
  for (const seq of notes.seqs) seq.forEach((it, n) => {
    if (it.k !== "L") return;
    const b = it.b;
    if (b.t === "lock") return;
    // An empty line LEFT has more of (not its last paragraph, which every document has)
    if (b.t === "p" && b.key == null) { if (n < seq.length - 1) keep(notes, "spacing"); return; }
    if (b.t === "p" && b.key) keys.set(b.key, [...(keys.get(b.key) ?? []), it]);
    if (b.words.length) pool.push(` ${b.words.join(" ")} `);
  });
  const consume = (words: string[]) => {
    const s = ` ${words.join(" ")} `;
    for (let k = 0; k < pool.length; k++) {
      const at = pool[k].indexOf(s);
      if (at >= 0) { pool[k] = `${pool[k].slice(0, at)} \u0000 ${pool[k].slice(at + s.length)}`; return true; }
    }
    return false;
  };
  for (const seq of notes.seqs) {
    for (const it of seq) {
      if (it.k === "R" && it.b.t === "p" && it.b.key != null) {
        const theirs = keys.get(it.b.key)?.shift();
        if (theirs) { theirs.moved = true; consume(it.b.words); it.drop = "moved"; }
        else if (it.b.words.length >= 4 && consume(it.b.words)) it.drop = "moved";
      } else if (it.k === "R" && it.b.t === "lock") it.drop = "unsupported";
      else if (it.k === "M") for (const ins of it.inserts ?? []) if (ins.words.length >= 4 && consume(ins.words)) ins.moved = true;
    }
    // Empty lines only between paragraphs both have (or at the end) are spacing, not content
    for (let s = 0; s < seq.length;) {
      if (seq[s].k !== "R") { s++; continue; }
      let e = s;
      while (e < seq.length && seq[e].k === "R") e++;
      const run = seq.slice(s, e) as Extract<Item, { k: "R" }>[];
      const blank = (x: Extract<Item, { k: "R" }>) => x.b.t === "p" && x.b.key == null && !x.drop;
      const copied = run.some((x) => !x.drop && !blank(x));
      const atEnd = seq.slice(e).every((x) => x.k === "L");
      if (!copied) for (const x of run) { if (blank(x)) x.drop = "spacing"; }
      else if (atEnd) for (let q = run.length - 1; q >= 0 && (blank(run[q]) || run[q].drop); q--) if (blank(run[q])) run[q].drop = "spacing";
      s = e;
    }
  }
  for (const seq of notes.seqs) for (const it of seq) {
    if (it.k === "R" && it.drop === "moved") keep(notes, "moved", preview(it.b.t === "p" ? it.b.text : "", 40));
    else if (it.k === "R" && it.drop === "spacing") keep(notes, "spacing");
    else if (it.k === "R" && it.drop === "unsupported" && it.b.t === "lock") unsupported(notes, it.b.what, it.b.text);
    else if (it.k === "R" && it.b.t === "p" && it.b.chip) unsupported(notes, "chip", it.b.text, true);
    else if (it.k === "L" && !it.moved && it.b.t !== "lock" && it.b.words.length) keep(notes, "onlyLeft", preview(it.b.text, 40));
    else if (it.k === "M") {
      for (const ins of it.inserts ?? []) if (ins.moved) keep(notes, "moved", ins.words.join(" "));
      if (it.r.t === "p" && it.r.chip && it.inserts?.some((x) => !x.moved)) unsupported(notes, "chip", it.r.text, true);
    }
  }
}

// ── Building the merged document ────────────────────────────────────────────

interface Tags {
  /** The reference token each token of a new inline node copies */
  origin: WeakMap<EditorNode, number[]>;
  /** The reference tokens of a new block's own: a paragraph's end, a table's, row's or cell's start and end */
  block: WeakMap<EditorNode, { nl?: number; open?: number; end?: number }>;
  /** The change a new node belongs to */
  change: WeakMap<EditorNode, string>;
}

interface Draft {
  id: string;
  kind: ChangeKind;
  right: [number, number] | null;
  words: number;
  preview: string;
  where: string;
  when: "typed" | "start";
  skipped: boolean;
  images: number;
  tables: number;
  footnotes: number;
  /** Content of the tab (not a tab, rename, page setup, header or footer change) */
  content: boolean;
}

interface Ctx {
  rightTabId: string;
  skip: Set<string>;
  tags: Tags;
  drafts: Draft[];
  /** The Docs list style each of the reference's lists is made with */
  presets: Map<string, string>;
  /** Where what's added next goes, for people: "at the start", "after “Intro”", "in a new tab" */
  where: string;
  /** In a table cell: where its additions go */
  cell: string | null;
}

type DraftInfo = Partial<Pick<Draft, "images" | "tables" | "footnotes">> & Pick<Draft, "words" | "preview" | "where" | "when">;

/** A change, with its id: the same for the same reference content, whatever else changes */
function change(ctx: Ctx, kind: ChangeKind, right: [number, number] | null, info: DraftInfo, key?: string): { id: string; skipped: boolean } {
  const id = `${kind}-${hashId(`${ctx.rightTabId}|${kind}|${key ?? (right ? right.join("-") : "")}`)}`;
  const skipped = ctx.skip.has(id);
  ctx.drafts.push({ id, kind, right, skipped, images: 0, tables: 0, footnotes: 0, content: !key, ...info });
  return { id, skipped };
}

const pendingMarks = (marks: Marks | undefined): Marks => [...(marks ?? []).filter((m) => m.type !== PENDING_MARK && m.type !== BREAK_MARK), { type: PENDING_MARK }];

/** New editor nodes for reference content [from, to) of a paragraph, pending, with its look */
function copyAtoms(p: Para, from: number, to: number, ctx: Ctx, id: string): EditorNode[] {
  const out: EditorNode[] = [];
  for (let k = from; k < to;) {
    const a = p.atoms[k];
    const origin: number[] = [];
    let node: EditorNode;
    if (a.kind === "c") {
      let text = "";
      while (k < to && p.atoms[k].kind === "c" && p.atoms[k].node === a.node) { text += p.atoms[k].ch; origin.push(p.atoms[k].tok); k++; }
      node = { type: "text", text, marks: pendingMarks(a.node.marks) };
    } else {
      origin.push(a.tok);
      k++;
      node = a.kind === "img" ? { type: "image", attrs: { ...a.node.attrs }, marks: pendingMarks(a.node.marks) }
        : a.kind === "pb" ? { type: "pageBreak", marks: pendingMarks(a.node.marks) }
        : a.kind === "br" ? { type: "hardBreak" }
        // A footnote Docs makes when the sync starts, with the reference's text
        : { type: "footnoteRef", attrs: { fid: null, n: null } };
    }
    ctx.tags.origin.set(node, origin);
    ctx.tags.change.set(node, id);
    out.push(node);
  }
  return out;
}

/** A space that keeps an added word from running into its neighbour, in the look of the word next to it */
function pad(a: Atom, ctx: Ctx, id: string): EditorNode {
  const marks = a.kind === "c" ? (a.node.marks ?? []).filter((m) => m.type !== "link") : [];
  const node: EditorNode = { type: "text", text: " ", marks: pendingMarks(marks) };
  ctx.tags.origin.set(node, [a.tok]);
  ctx.tags.change.set(node, id);
  return node;
}

/** What ties a reference node to the reference's indices and lists, which a new node in LEFT doesn't have */
const STRUCTURE_IDS = ["tid", "rid", "cid", "span", "endSpan", "bid", "locked"];
const withoutIds = (attrs: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(attrs ?? {}).filter(([k]) => !STRUCTURE_IDS.includes(k)));
const listKey = (attrs: Record<string, unknown> | undefined) => `${String(attrs?.listId ?? "")}|${String(attrs?.list ?? "")}`;

/** A reference paragraph's attributes for a new paragraph: its look, its list made the way the editor makes one */
function freshAttrs(attrs: Record<string, unknown> | undefined, presets: Map<string, string>): Record<string, unknown> {
  const a = withoutIds(attrs);
  if (a.list) Object.assign(a, { listId: null, glyph: null, preset: presets.get(listKey(attrs)) ?? null });
  else if ("listId" in a) a.listId = null;
  return a;
}

/** The Docs list style closest to each of the reference's lists (by the glyphs its levels use) */
function presetsOf(blocks: Block[]): Map<string, string> {
  const used = new Map<string, { kind: string; glyphs: Glyph[]; weights: number[] }>();
  const visit = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === "table") { for (const row of b.rows) for (const cell of row.cells) visit(cell.blocks); continue; }
      const attrs = b.node.attrs;
      if (b.t !== "p" || !attrs?.list) continue;
      const u = used.get(listKey(attrs)) ?? { kind: String(attrs.list), glyphs: [], weights: [] };
      const level = Math.max(0, Math.min(8, Number(attrs.level) || 0));
      u.weights[level] = (u.weights[level] ?? 0) + 1;
      const g = attrs.glyph as Partial<Glyph> | null | undefined;
      if (g && !u.glyphs[level]) u.glyphs[level] = { type: g.type ?? null, format: g.format ?? null, symbol: g.symbol ?? null };
      used.set(listKey(attrs), u);
    }
  };
  visit(blocks);
  return new Map(Array.from(used, ([k, u]) => [k, presetForLevels(u.kind, u.glyphs, u.weights)]));
}

function newParagraph(p: Para, ctx: Ctx, id: string): EditorNode {
  const node: EditorNode = { type: "paragraph", attrs: freshAttrs(p.node.attrs, ctx.presets), content: copyAtoms(p, 0, p.atoms.length, ctx, id) };
  ctx.tags.block.set(node, { nl: p.nl });
  ctx.tags.change.set(node, id);
  return node;
}

/** A reference cell's paragraphs, new (a table inside it can't be copied: Docs has no way to make one) */
function newCellContent(cell: Cell, ctx: Ctx, id: string): EditorNode[] {
  const out = cell.blocks.flatMap((b) => (b.t === "p" ? [newParagraph(b, ctx, id)] : []));
  if (!out.length) {
    const empty: EditorNode = { type: "paragraph", attrs: {}, content: [] };
    ctx.tags.block.set(empty, { nl: lastTok(cell.blocks[cell.blocks.length - 1]) });
    out.push(empty);
  }
  return out;
}

function newRow(row: Row, ctx: Ctx, id: string): EditorNode {
  const node: EditorNode = {
    type: "tableRow",
    attrs: withoutIds(row.node.attrs),
    content: row.cells.map((cell) => {
      const c: EditorNode = { type: "tableCell", attrs: withoutIds(cell.node.attrs), content: newCellContent(cell, ctx, id) };
      ctx.tags.block.set(c, { open: cell.tok, end: cell.end });
      return c;
    }),
  };
  ctx.tags.block.set(node, { open: row.tok, end: row.end });
  return node;
}

const objectsPreview = (atoms: Atom[]) => {
  const images = atoms.filter((a) => a.kind === "img").length;
  if (images) return images === 1 ? "An image" : `${images} images`;
  if (atoms.some((a) => a.kind === "pb")) return "A page break";
  if (atoms.some((a) => a.kind === "fn")) return "A footnote";
  return "An empty line";
};

/** What added content holds: the kind of change it is outside a table, its images and footnotes */
function contentOf(atoms: Atom[]): { kinds: Set<string>; images: number; footnotes: number; text: string } {
  const kinds = new Set<string>();
  for (const a of atoms) if (!(a.kind === "c" && /\s/.test(a.ch))) kinds.add(a.kind);
  return { kinds, images: atoms.filter((a) => a.kind === "img").length, footnotes: atoms.filter((a) => a.kind === "fn").length, text: atoms.map((a) => a.ch).join("") };
}

/** LEFT's blocks with the reference's additions, in order */
function buildSeq(items: Item[], ctx: Ctx): EditorNode[] {
  const out: EditorNode[] = [];
  // Reference paragraphs added together (one change), each new or into LEFT's empty last paragraph
  let group: { p: Para; into?: Para }[] = [];
  const flush = () => {
    if (!group.length) return;
    const g = group;
    group = [];
    const atoms = g.flatMap((x) => x.p.atoms);
    const { images, footnotes } = contentOf(atoms);
    const text = g.map((x) => x.p.text).join("\n");
    const paras = g.map((x) => x.p);
    const kind: ChangeKind = ctx.cell ? "cell" : paras.every(isListItem) ? "list" : paras.every((p) => !p.words.length && imageCount(p) > 0) ? "image" : paras.every((p) => p.atoms.length > 0 && p.atoms.every((a) => a.kind === "pb")) ? "pageBreak" : "paragraph";
    const right: [number, number] = [firstTok(g[0].p), lastTok(g[g.length - 1].p) + 1];
    const { id, skipped } = change(ctx, kind, right, { words: countWords(text), preview: preview(text) || objectsPreview(atoms), where: ctx.cell ?? ctx.where, when: "typed", images, footnotes });
    if (skipped) return;
    for (const x of g) out.push(x.into ? splice(x.into.node, new Map([[0, copyAtoms(x.p, 0, x.p.atoms.length, ctx, id)]])) : newParagraph(x.p, ctx, id));
  };
  for (const it of items) {
    if (it.k === "R") {
      if (it.drop || it.b.t === "lock") continue;
      if (it.b.t === "table") {
        // Empty lines right before a table go with it (Docs puts one before every table it makes)
        const lead = group.length && group.every((x) => !x.into && x.p.key == null) ? group.map((x) => x.p) : [];
        if (lead.length) group = [];
        else flush();
        out.push(...newTable(it.b, lead, ctx));
        continue;
      }
      if (group.length && isHeading(it.b)) flush();
      group.push({ p: it.b });
      continue;
    }
    if (it.k === "M" && it.fill && it.l.t === "p" && it.r.t === "p") {
      if (group.length && isHeading(it.r)) flush();
      group.push({ p: it.r, into: it.l });
      continue;
    }
    flush();
    const left = it.k === "L" ? it.b : it.l;
    out.push(it.k === "L" ? it.b.node : buildMatched(it, ctx));
    // What follows is "after" this
    if (left.t === "p" && /\S/.test(left.text)) ctx.where = `after ${quoted(left.text)}`;
    else if (left.t === "table") ctx.where = "after the table";
  }
  flush();
  return out;
}

/** A reference table, new, with the empty lines before it (`lead`): one change, its structure made when the sync starts */
function newTable(t: Table, lead: Para[], ctx: Ctx): EditorNode[] {
  const atoms = t.rows.flatMap((r) => r.cells.flatMap((c) => c.blocks.flatMap((b) => (b.t === "p" ? b.atoms : []))));
  const { images, footnotes } = contentOf(atoms);
  const columns = Math.max(0, ...t.rows.map((r) => r.cells.reduce((n, c) => n + (Number(c.node.attrs?.colspan) || 1), 0)));
  const right: [number, number] = [lead.length ? firstTok(lead[0]) : t.tok, t.end + 1];
  const { id, skipped } = change(ctx, "table", right, { words: countWords(t.text), preview: preview(t.text.replace(/[|/]/g, " ")) || `A table, ${t.rows.length} by ${columns}`, where: ctx.cell ?? ctx.where, when: "start", images, footnotes, tables: 1 });
  if (skipped) return [];
  const node: EditorNode = { type: "table", attrs: withoutIds(t.node.attrs), content: t.rows.map((row) => newRow(row, ctx, id)) };
  ctx.tags.block.set(node, { open: t.tok, end: t.end });
  ctx.tags.change.set(node, id);
  return [...lead.map((p) => newParagraph(p, ctx, id)), node];
}

function buildMatched(it: Extract<Item, { k: "M" }>, ctx: Ctx): EditorNode {
  const { l, r } = it;
  if (l.t === "p" && r.t === "p") return buildParagraph(l, r, it.inserts ?? [], ctx);
  if (l.t === "table" && r.t === "table" && it.table) return buildTable(l, it.table, ctx);
  return l.node;
}

function buildParagraph(l: Para, r: Para, inserts: Insert[], ctx: Ctx): EditorNode {
  const at = new Map<number, EditorNode[]>();
  for (const ins of inserts) {
    if (ins.moved) continue;
    const atoms = r.atoms.slice(ins.from, ins.to);
    const { kinds, images, footnotes, text } = contentOf(atoms);
    const only = (k: string) => kinds.size === 1 && kinds.has(k);
    const kind: ChangeKind = ctx.cell ? "cell" : only("img") ? "image" : only("pb") ? "pageBreak" : only("fn") ? "footnote" : "text";
    const { id, skipped } = change(ctx, kind, [atoms[0].tok, atoms[atoms.length - 1].tok + 1], {
      words: countWords(text),
      preview: preview(text) || objectsPreview(atoms),
      where: /\S/.test(l.text) ? `in ${quoted(l.text)}` : ctx.cell ?? ctx.where,
      when: kind === "footnote" ? "start" : "typed",
      images,
      footnotes,
    });
    if (skipped) continue;
    const nodes = [...(ins.padBefore ? [pad(atoms[0], ctx, id)] : []), ...copyAtoms(r, ins.from, ins.to, ctx, id), ...(ins.padAfter ? [pad(atoms[atoms.length - 1], ctx, id)] : [])];
    at.set(ins.at, [...(at.get(ins.at) ?? []), ...nodes]);
  }
  return at.size ? splice(l.node, at) : l.node;
}

/** A LEFT paragraph with new inline nodes put in at content tokens (a text node split where one goes) */
function splice(node: EditorNode, at: Map<number, EditorNode[]>): EditorNode {
  const keys = [...at.keys()].sort((a, b) => a - b);
  const content: EditorNode[] = [];
  let k = 0;
  let off = 0;
  for (const child of node.content ?? []) {
    const n = atomsIn(child);
    while (k < keys.length && keys[k] <= off) content.push(...at.get(keys[k++])!);
    if (child.type === "text" && typeof child.text === "string" && k < keys.length && keys[k] < off + n) {
      let cut = 0;
      while (k < keys.length && keys[k] < off + n) {
        const c = keys[k] - off;
        content.push({ ...child, text: child.text.slice(cut, c) });
        content.push(...at.get(keys[k++])!);
        cut = c;
      }
      content.push({ ...child, text: child.text.slice(cut) });
    } else content.push(child);
    off += n;
  }
  while (k < keys.length) content.push(...at.get(keys[k++])!);
  return { ...node, content };
}

function buildTable(l: Table, plan: TablePlan, ctx: Ctx): EditorNode {
  const cellCtx: Ctx = { ...ctx, cell: ctx.where.startsWith("after") ? `in the table ${ctx.where}` : "in the table at the start" };
  const rows: EditorNode[] = [];
  let changed = false;
  let added: Row[] = [];
  const flushRows = () => {
    if (!added.length) return;
    const run = added;
    added = [];
    const text = run.map(rowText).join(" ");
    const atoms = run.flatMap((r) => r.cells.flatMap((c) => c.blocks.flatMap((b) => (b.t === "p" ? b.atoms : []))));
    const { images, footnotes } = contentOf(atoms);
    const { id, skipped } = change(ctx, "row", [run[0].tok, run[run.length - 1].end + 1], { words: countWords(text), preview: preview(text.replace(/[|/]/g, " ")) || (run.length === 1 ? "An empty row" : `${run.length} empty rows`), where: cellCtx.cell!, when: "start", images, footnotes });
    if (skipped) return;
    for (const row of run) {
      const node = newRow(row, ctx, id);
      ctx.tags.change.set(node, id);
      rows.push(node);
    }
    changed = true;
  };
  for (const it of plan.rows) {
    if (it.k === "R") { added.push(it.row); continue; }
    flushRows();
    if (it.k === "L") { rows.push(it.row.node); continue; }
    const cells = it.l.cells.map((c, k) => {
      const items = it.cells[k];
      if (!items) return c.node;
      const content = buildSeq(items, { ...cellCtx });
      const own = c.node.content ?? [];
      return content.length === own.length && content.every((n, q) => n === own[q]) ? c.node : { ...c.node, content };
    });
    if (cells.every((c, k) => c === it.l.cells[k].node)) rows.push(it.l.node);
    else { rows.push({ ...it.l.node, content: cells }); changed = true; }
  }
  flushRows();
  return changed ? { ...l.node, content: rows } : l.node;
}

// ── Token maps ──────────────────────────────────────────────────────────────

/**
 * For each token of the merged document (doc-model's tokenize order): the reference token it copies
 * (-1 for LEFT's own), and each change's token range
 */
function originOf(blocks: EditorNode[], tags: Tags): { origin: number[]; spans: Map<string, [number, number]> } {
  const origin: number[] = [];
  const spans = new Map<string, [number, number]>();
  const mark = (id: string | undefined, from: number, to: number) => {
    if (!id || to <= from) return;
    const s = spans.get(id);
    if (s) { s[0] = Math.min(s[0], from); s[1] = Math.max(s[1], to); } else spans.set(id, [from, to]);
  };
  const push = (o: number | undefined, id: string | undefined) => { origin.push(o ?? -1); mark(id, origin.length - 1, origin.length); };
  const paragraph = (node: EditorNode, inherited: string | undefined) => {
    const id = tags.change.get(node) ?? inherited;
    if (node.attrs?.locked) { push(-1, id); return; }
    for (const child of node.content ?? []) {
      const n = atomsIn(child);
      const o = tags.origin.get(child);
      const cid = tags.change.get(child) ?? id;
      for (let k = 0; k < n; k++) push(o ? o[Math.min(k, o.length - 1)] : -1, cid);
    }
    push(tags.block.get(node)?.nl, id);
  };
  const table = (node: EditorNode) => {
    const id = tags.change.get(node);
    push(tags.block.get(node)?.open, id);
    for (const row of node.content ?? []) {
      const rid = tags.change.get(row) ?? id;
      const rt = tags.block.get(row);
      push(rt?.open, rid);
      for (const cell of row.content ?? []) {
        const ct = tags.block.get(cell);
        push(ct?.open, rid);
        const content = cell.content?.length ? cell.content : [{ type: "paragraph" }];
        for (const p of content) paragraph(p, rid);
        push(ct?.end, rid);
      }
      push(rt?.end, rid);
    }
    push(tags.block.get(node)?.end, id);
  };
  for (const b of flatten(blocks)) {
    if (b.type === "table") table(b);
    else paragraph(b, undefined);
  }
  return { origin, spans };
}

// ── Tabs ────────────────────────────────────────────────────────────────────

const DEFAULT_TITLE = /^(tab \d+|untitled tab)$/i;
const titleKey = (title: string) => title.trim().toLowerCase();
/** Docs nests tabs three levels deep at most, and a document has at most 100 */
const MAX_LEVEL = 2;
const MAX_TABS = 100;

const tabWords = (tab: CompareTab): Map<string, number> => {
  const counts = new Map<string, number>();
  const words = wordsOf(tab.doc.nodes.map(plainText).join(" "));
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return counts;
};

/** How much of LEFT's tab the reference's tab has: the share of LEFT's words found in it */
function containment(l: Map<string, number>, r: Map<string, number>): number {
  let total = 0;
  let found = 0;
  for (const [w, n] of l) { total += n; found += Math.min(n, r.get(w) ?? 0); }
  return total ? found / total : 0;
}

/**
 * Where each reference tab's content goes. `given` (the user's choices) wins where it names a LEFT
 * tab not already taken, a new tab or none; the rest go, in order: into the LEFT tab of the same title;
 * into the LEFT tab whose words the reference tab has at least half of; into a blank LEFT tab with
 * Docs' default name ("Tab 1"), which takes the reference tab's name; or into a new tab, nested under
 * where its parent's content goes. With one tab on each side, those two go together.
 */
export function matchTabs(left: CompareSide, right: CompareSide, given: TabMap = {}): TabMap {
  const map: TabMap = {};
  const rights = [...right.tabs].sort((a, b) => a.index - b.index);
  const lefts = [...left.tabs].sort((a, b) => a.index - b.index);
  const leftById = new Map(lefts.map((t) => [t.id, t]));
  const taken = new Set<string>();
  // A blank LEFT tab with Docs' default name, matched automatically, takes the reference tab's name
  const into = (r: CompareTab, l: CompareTab, given?: string) => {
    taken.add(l.id);
    const auto = l.doc.empty && DEFAULT_TITLE.test(l.title.trim()) && titleKey(l.title) !== titleKey(r.title) && r.title.trim() ? r.title.trim() : undefined;
    const rename = given === undefined ? auto : given.trim() || undefined;
    map[r.id] = { kind: "tab", leftTabId: l.id, ...(rename ? { rename } : {}) };
  };
  const pending = new Set<string>();
  for (const r of rights) {
    const g = given[r.id];
    if (g?.kind === "tab" && leftById.has(g.leftTabId) && !taken.has(g.leftTabId)) into(r, leftById.get(g.leftTabId)!, g.rename ?? "");
    else if (g?.kind === "skip") map[r.id] = { kind: "skip" };
    else if (g) pending.add(r.id);
  }
  const free = () => rights.filter((r) => !map[r.id] && !pending.has(r.id));
  if (rights.length === 1 && lefts.length === 1 && free().length === 1 && !taken.size) into(rights[0], lefts[0]);
  for (const r of free()) {
    const l = lefts.find((t) => !taken.has(t.id) && titleKey(t.title) === titleKey(r.title));
    if (l) into(r, l);
  }
  if (free().length) {
    const words = new Map(lefts.map((t) => [t.id, tabWords(t)]));
    for (const r of free()) {
      const theirs = tabWords(r);
      let best: CompareTab | null = null;
      let bestShare = 0.5;
      for (const l of lefts) {
        if (taken.has(l.id) || l.doc.empty) continue;
        const share = containment(words.get(l.id)!, theirs);
        if (share >= bestShare && (!best || share > bestShare)) { best = l; bestShare = share; }
      }
      if (best) into(r, best);
    }
  }
  for (const l of lefts) {
    if (taken.has(l.id) || !l.doc.empty || !DEFAULT_TITLE.test(l.title.trim())) continue;
    const r = free()[0];
    if (r) into(r, l);
  }
  // New tabs, parents first, under where their parent's content goes (Docs' nesting limit allowing)
  const levelOf = new Map<string, number>();
  for (const r of rights) {
    const t = map[r.id];
    if (t?.kind === "tab") levelOf.set(r.id, leftById.get(t.leftTabId)?.level ?? 0);
  }
  let count = lefts.length;
  const byId = new Map(rights.map((t) => [t.id, t]));
  for (const r of rights) {
    if (map[r.id]) continue;
    if (count >= MAX_TABS) { map[r.id] = { kind: "skip" }; continue; }
    let parent = r.parentId;
    while (parent && (map[parent]?.kind === "skip" || !map[parent] || (levelOf.get(parent) ?? 0) >= MAX_LEVEL)) parent = byId.get(parent)?.parentId ?? null;
    const g = given[r.id];
    const title = (g?.kind === "new" && g.title.trim()) || r.title.trim() || "Untitled tab";
    map[r.id] = { kind: "new", title, ...(r.emoji ? { emoji: r.emoji } : {}), parentRightTabId: parent };
    levelOf.set(r.id, parent ? (levelOf.get(parent) ?? 0) + 1 : 0);
    count++;
  }
  return map;
}

// ── One tab ─────────────────────────────────────────────────────────────────

const segmentText = (s: ImportedSegment | undefined) => (s ? s.nodes.map(plainText).join("\n").trim() : "");
const pageSetupPreview = (s: PageSetup) => {
  const inches = (pt: number) => `${Math.round((pt / 72) * 100) / 100} in`;
  const m = s.margins;
  const margins = m.top === m.bottom && m.top === m.left && m.top === m.right ? `${inches(m.top)} margins` : `margins ${inches(m.top)}, ${inches(m.right)}, ${inches(m.bottom)}, ${inches(m.left)}`;
  return `${s.custom ? "Custom size" : PAPERS[s.paper]?.label ?? "Custom size"}, ${s.orientation}, ${margins}`;
};

/** Merge [from, to) ranges that touch or overlap, in order */
function union(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const docOf = (nodes: EditorNode[]): EditorNode => ({ type: "doc", content: groupColumns(nodes) });

/** One reference tab compared with the LEFT tab it goes into; with the reference's words, and how many are missing */
function compareTab(rt: CompareTab, target: TabTarget, lt: CompareTab | null, skip: Set<string>, parentTitle: string | null): { tab: TabCompare; total: number; missing: number } {
  const baseNodes = lt ? lt.doc.nodes : [NEW_TAB_PARAGRAPH];
  const base = docOf(baseNodes);
  const tags: Tags = { origin: new WeakMap(), block: new WeakMap(), change: new WeakMap() };
  const ctx: Ctx = { rightTabId: rt.id, skip, tags, drafts: [], presets: new Map(), where: target.kind === "new" ? "in a new tab" : "at the start", cell: null };
  const notes: Notes = { kept: new Map(), unsupported: new Map(), seqs: [], pool: [] };
  const setup: NonNullable<TabCompare["setup"]> = {};
  let merged = base;
  let origin: number[] = [];
  let spans = new Map<string, [number, number]>();
  let total = 0;
  const R = readBlocks(rt.doc.nodes);
  if (target.kind !== "skip") {
    const blank = !lt || lt.doc.empty;
    let tabSkipped = false;
    if (target.kind === "new") tabSkipped = change(ctx, "tab", null, { words: 0, preview: target.title, where: parentTitle ? `inside ${quoted(parentTitle)}` : "as a new tab", when: "start" }, "tab").skipped;
    if (target.kind === "tab" && target.rename) change(ctx, "rename", null, { words: 0, preview: target.rename, where: quoted(lt?.title ?? ""), when: "start" }, "rename");
    if (!tabSkipped) {
      // Page size and margins: a new or blank tab takes the reference's; a tab with content keeps its own
      const own = lt?.doc.pageSetup ?? DEFAULT_PAGE_SETUP;
      if (!samePageSetup(own, rt.doc.pageSetup)) {
        if (blank) { if (!change(ctx, "pageSetup", null, { words: 0, preview: pageSetupPreview(rt.doc.pageSetup), where: "for the whole tab", when: "start" }, "pageSetup").skipped) setup.pageSetup = rt.doc.pageSetup; }
        else keep(notes, "pageSetup");
      }
      // A header or footer LEFT doesn't have is made; one it has stays as it is
      for (const side of ["header", "footer"] as const) {
        const theirs = rt.doc[side];
        const mine = lt?.doc[side];
        const text = segmentText(theirs);
        if (!theirs || (!text && !mine)) continue;
        if (!mine) { if (!change(ctx, side, null, { words: countWords(text), preview: preview(text) || `An empty ${side}`, where: `in the ${side}`, when: "start" }, side).skipped) setup[side] = theirs; }
        else if (normalize(segmentText(mine)) !== normalize(text)) keep(notes, side, preview(text, 40));
      }
      ctx.presets = presetsOf(R);
      const items = itemsOf(readBlocks(baseNodes), R, notes);
      settle(notes);
      const blocks = buildSeq(items, ctx);
      merged = docOf(blocks);
      ({ origin, spans } = originOf(blocks, tags));
      // Footnote texts that differ stay as LEFT has them
      footnoteNotes(items, lt, rt, notes);
    }
  }
  if (!origin.length) origin = new Array<number>(tokenize(merged).length).fill(-1);
  for (const b of R) if (b.t !== "lock") total += b.words.length;
  const changes: Change[] = ctx.drafts.map((d) => ({ id: d.id, kind: d.kind, rightTabId: rt.id, words: d.words, preview: d.preview, where: d.where, when: d.when, merged: d.skipped ? null : spans.get(d.id) ?? null, right: d.right }));
  const live = ctx.drafts.filter((d) => !d.skipped);
  const missing = ctx.drafts.filter((d) => d.content).reduce((n, d) => n + d.words, 0);
  const sum = (key: "words" | "images" | "tables" | "footnotes") => live.reduce((n, d) => n + d[key], 0);
  const tab: TabCompare = {
    rightTabId: rt.id,
    rightTitle: rt.title,
    target,
    base,
    merged,
    origin,
    changes,
    kept: Array.from(notes.kept.values(), (k) => ({ ...k, rightTabId: rt.id, leftTabId: lt?.id ?? null })),
    unsupported: Array.from(notes.unsupported.values(), (u) => ({ ...u, rightTabId: rt.id })),
    rightCopied: union(live.filter((d) => d.right && d.content).map((d) => d.right!)),
    ...(Object.keys(setup).length ? { setup } : {}),
    stats: {
      words: sum("words"),
      images: sum("images"),
      tables: sum("tables"),
      footnotes: sum("footnotes"),
      changes: live.length,
      skipped: ctx.drafts.length - live.length,
      presentPct: total ? Math.round((100 * Math.max(0, total - missing)) / total) : 100,
    },
  };
  return { tab, total: target.kind === "skip" ? 0 : total, missing };
}

/** Footnotes both have whose text differs: kept as LEFT has it */
function footnoteNotes(items: Item[], lt: CompareTab | null, rt: CompareTab, notes: Notes) {
  if (!lt) return;
  const text = (doc: CompareTab["doc"], fid: unknown) => (typeof fid === "string" ? normalize(segmentText(doc.footnotes[fid])) : "");
  const visit = (seq: Item[]) => {
    for (const it of seq) {
      if (it.k !== "M") continue;
      if (it.l.t === "p" && it.r.t === "p") {
        const mine = it.l.atoms.filter((a) => a.kind === "fn");
        const theirs = it.r.atoms.filter((a) => a.kind === "fn");
        for (let k = 0; k < Math.min(mine.length, theirs.length); k++) {
          const a = text(lt.doc, mine[k].node.attrs?.fid);
          const b = text(rt.doc, theirs[k].node.attrs?.fid);
          if (a !== b) keep(notes, "footnoteText", preview(b, 40));
        }
      } else if (it.table) for (const row of it.table.rows) if (row.k === "M") for (const cell of row.cells) if (cell) visit(cell);
    }
  };
  visit(items);
}

// ── The comparison ──────────────────────────────────────────────────────────

/**
 * Everything the reference has that LEFT lacks, per reference tab in typing order (the reference's
 * tab order, parents first), with LEFT's tabs nothing goes into.
 */
export function compareDocs(left: CompareSide, right: CompareSide, opts: CompareOptions = {}): CompareResult {
  const tabMap = matchTabs(left, right, opts.tabMap);
  const skip = new Set(opts.skip ?? []);
  const leftById = new Map(left.tabs.map((t) => [t.id, t]));
  const titleOf = (rightTabId: string | null): string | null => {
    if (!rightTabId) return null;
    const t = tabMap[rightTabId];
    if (t?.kind === "tab") return t.rename ?? leftById.get(t.leftTabId)?.title ?? null;
    if (t?.kind === "new") return t.title;
    return null;
  };
  const rights = [...right.tabs].sort((a, b) => a.index - b.index);
  let total = 0;
  let missing = 0;
  const tabs = rights.map((rt) => {
    const target = tabMap[rt.id] ?? { kind: "skip" };
    const lt = target.kind === "tab" ? leftById.get(target.leftTabId) ?? null : null;
    const one = compareTab(rt, target, lt, skip, target.kind === "new" ? titleOf(target.parentRightTabId) : null);
    total += one.total;
    missing += one.missing;
    return one.tab;
  });
  const into = new Set(Object.values(tabMap).flatMap((t) => (t.kind === "tab" ? [t.leftTabId] : [])));
  const leftOnlyTabs = [...left.tabs].sort((a, b) => a.index - b.index).filter((t) => !into.has(t.id)).map((t) => ({ id: t.id, title: t.title }));
  const add = (key: "words" | "images" | "tables" | "footnotes" | "changes") => tabs.reduce((n, t) => n + t.stats[key], 0);
  return {
    tabs,
    leftOnlyTabs,
    totals: {
      words: add("words"),
      images: add("images"),
      tables: add("tables"),
      footnotes: add("footnotes"),
      changes: add("changes"),
      newTabs: tabs.filter((t) => t.target.kind === "new" && t.changes.some((c) => c.kind === "tab" && c.merged === null && !skip.has(c.id))).length,
      presentPct: total ? Math.round((100 * Math.max(0, total - missing)) / total) : 100,
    },
  };
}

// ── Manual breaks ───────────────────────────────────────────────────────────

/** A word a break can follow: letters, digits and the punctuation stuck to them (as the page picks one) */
const BREAK_WORD = /[\p{L}\p{N}\p{M}'’_\-.,;:!?)"\]»”]/u;

/**
 * The merged document with each Manual break marked on the word it follows (syncBreak, as a click on
 * the page puts one): the pending word that copies the break's reference token
 */
export function applyBreaks(tab: TabCompare, breaks: CompareBreak[]): EditorNode {
  const want = new Map<number, number>();
  for (const b of breaks) if (b.rightTabId === tab.rightTabId && Number.isFinite(b.minutes) && b.minutes > 0) want.set(b.rightToken, Math.max(1, Math.round(b.minutes)));
  if (!want.size) return tab.merged;
  const toks = tokenize(tab.merged);
  const word = (j: number) => { const t = toks[j]; return !!t && t.k === "c" && t.pending && BREAK_WORD.test(t.c); };
  // The last pending character copying each break's token, then its whole word
  const last = new Map<number, number>();
  toks.forEach((t, j) => { const o = tab.origin[j]; if (o != null && o >= 0 && want.has(o) && word(j)) last.set(o, j); });
  const minutesAt = new Map<number, number>();
  for (const [o, j] of last) {
    let a = j;
    let b = j;
    while (word(a - 1)) a--;
    while (word(b + 1)) b++;
    for (let k = a; k <= b; k++) minutesAt.set(k, want.get(o)!);
  }
  return minutesAt.size ? withBreakMarks(tab.merged, minutesAt) : tab.merged;
}

/** The document with the break mark on each token `minutesAt` names (text nodes split where it starts or ends) */
function withBreakMarks(doc: EditorNode, minutesAt: Map<number, number>): EditorNode {
  let pos = 0;
  const inline = (child: EditorNode): EditorNode[] => {
    const n = atomsIn(child);
    const from = pos;
    pos += n;
    if (child.type !== "text" || !child.text) return [child];
    let any = false;
    for (let k = from; k < from + n && !any; k++) any = minutesAt.has(k);
    if (!any) return [child];
    const out: EditorNode[] = [];
    let start = 0;
    const minutesOf = (k: number) => minutesAt.get(from + k) ?? null;
    for (let k = 1; k <= n; k++) {
      if (k < n && minutesOf(k) === minutesOf(start)) continue;
      const m = minutesOf(start);
      const marks = (child.marks ?? []).filter((x) => x.type !== BREAK_MARK);
      const piece: EditorNode = { ...child, text: child.text.slice(start, k) };
      const all = m == null ? marks : [...marks, { type: BREAK_MARK, attrs: { minutes: m } }];
      if (all.length) piece.marks = all;
      else delete piece.marks;
      out.push(piece);
      start = k;
    }
    return out;
  };
  const block = (node: EditorNode): EditorNode => {
    if (node.type === "paragraph") {
      if (node.attrs?.locked) { pos++; return node; }
      const content = (node.content ?? []).flatMap(inline);
      pos++;
      return content.length === (node.content ?? []).length && content.every((c, i) => c === node.content![i]) ? node : { ...node, content };
    }
    if (node.type === "table") {
      pos++;
      const rows = (node.content ?? []).map((row) => {
        pos++;
        const cells = (row.content ?? []).map((cell) => {
          pos++;
          const content = cell.content?.length ? cell.content.map(block) : (pos++, cell.content ?? []);
          pos++;
          return content.every((c, i) => c === cell.content?.[i]) ? cell : { ...cell, content };
        });
        pos++;
        return cells.every((c, i) => c === row.content?.[i]) ? row : { ...row, content: cells };
      });
      pos++;
      return rows.every((r, i) => r === node.content?.[i]) ? node : { ...node, content: rows };
    }
    if (node.type === "columnSection") return { ...node, content: (node.content ?? []).map(block) };
    return node;
  };
  return { ...doc, content: (doc.content ?? []).map(block) };
}

/** The Manual breaks marked on a merged document (as the page has it), by the reference token each follows */
export function breaksFromMerged(tab: TabCompare, mergedWithMarks: EditorNode): CompareBreak[] {
  const toks = tokenize(mergedWithMarks);
  const minutesOf = (j: number): number | null => {
    const t = toks[j];
    if (!t || t.k !== "c") return null;
    const m = t.marks.find((x) => x.type === BREAK_MARK);
    if (!m) return null;
    const v = Number(m.attrs?.minutes);
    return v > 0 ? Math.round(v) : 5;
  };
  const out = new Map<number, number>();
  for (let j = 0; j < toks.length; j++) {
    const m = minutesOf(j);
    if (m == null || minutesOf(j + 1) != null) continue;
    const o = tab.origin[j];
    if (o != null && o >= 0) out.set(o, m);
  }
  return Array.from(out, ([rightToken, minutes]) => ({ rightTabId: tab.rightTabId, rightToken, minutes })).sort((a, b) => a.rightToken - b.rightToken);
}
