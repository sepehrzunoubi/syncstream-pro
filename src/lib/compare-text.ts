/**
 * Compare & Sync: reading two documents' text the way a person does. Two copies of a document
 * rarely agree to the character (curly or straight quotes, a non-breaking space, a word typed in
 * capitals, a typo fixed in one of them), so text is compared after normalizing, and a word a letter
 * or two off still counts as the same word. Also the small sequence tools the engine aligns with.
 * Pure and isomorphic: no I/O, the same answer in the browser and on the server.
 */

/** Characters that draw nothing: soft hyphens, zero-width spaces and joiners, byte order marks */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const IS_INVISIBLE = /^[\u00AD\u200B-\u200D\u2060\uFEFF]/;
const SPACES = /[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g;

/** Text as it reads: quotes, dashes, spaces and invisible characters folded, lower case */
export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(SPACES, " ")
    .toLowerCase();
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
export const isWordChar = (ch: string | undefined) => !!ch && WORD_CHAR.test(ch);
export const isSpaceChar = (ch: string | undefined) => !!ch && /[\s\u00A0]/.test(ch);

const WORDS = /[\p{L}\p{N}\p{M}_]+(?:['\u2019][\p{L}\p{N}\p{M}_]+)*/gu;

/** The words of a text, normalized */
export function wordsOf(text: string): string[] {
  return normalize(text).match(WORDS) ?? [];
}

/** How many words a text has, as people count them */
export const countWords = (text: string) => (text.match(WORDS) ?? []).length;

/** A piece of a paragraph the comparison works with: a word, a run of spaces, a mark, or an object */
export type UnitKind = "w" | "s" | "p" | "x" | "z";
export interface Unit {
  /** Word, spaces, punctuation or symbol, an object (image, footnote, break), invisible characters */
  kind: UnitKind;
  /** Where it sits in the paragraph's content tokens: [from, to) */
  from: number;
  to: number;
  raw: string;
  /** What it is compared by */
  norm: string;
}

// A word (with the invisible characters inside it, and apostrophes between its letters), a run of
// spaces, invisible characters on their own, or any other single character
const UNIT = /[\p{L}\p{N}\p{M}_](?:[\p{L}\p{N}\p{M}_\u00AD\u200B-\u200D\u2060\uFEFF]|['\u2019](?=[\p{L}\p{N}\p{M}_]))*|[\s\u00A0]+|[\u00AD\u200B-\u200D\u2060\uFEFF]+|[^]/gu;

/** The units of a stretch of text that starts at content token `offset` */
export function textUnits(text: string, offset: number): Unit[] {
  const out: Unit[] = [];
  for (const m of text.matchAll(UNIT)) {
    const raw = m[0];
    const from = offset + (m.index ?? 0);
    const kind: UnitKind = WORD_CHAR.test(raw[0]) ? "w" : /^[\s\u00A0]/.test(raw) ? "s" : IS_INVISIBLE.test(raw) ? "z" : "p";
    out.push({ kind, from, to: from + raw.length, raw, norm: kind === "s" ? " " : kind === "z" ? "" : normalize(raw) });
  }
  return out;
}

/**
 * The same word, written a little differently: a typo (one letter off from 4 letters, two from 8:
 * a swap, a letter missing, extra or wrong; in a 3-letter word only two letters swapped, as in "teh").
 * Numbers have to be the same.
 */
export function closeWords(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\p{N}/u.test(a) || /\p{N}/u.test(b)) return false;
  const len = Math.min(a.length, b.length);
  const max = len >= 8 ? 2 : len >= 4 ? 1 : 0;
  if (!max) return len === 3 && a.length === b.length && swapped(a, b);
  if (Math.abs(a.length - b.length) > max) return false;
  return editDistance(a, b, max) <= max;
}

/** Two neighbouring letters swapped, nothing else */
function swapped(a: string, b: string): boolean {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/** Damerau's distance (adjacent swaps count once), giving up past `max` */
function editDistance(a: string, b: string, max: number): number {
  const m = b.length;
  let older = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let least = i;
    for (let j = 1; j <= m; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, older[j - 2] + 1);
      cur[j] = v;
      if (v < least) least = v;
    }
    if (least > max) return max + 1;
    [older, prev, cur] = [prev, cur, older];
  }
  return prev[m];
}

/**
 * A longest common subsequence of two sequences under `eq`, as index pairs in order (Myers' diff
 * after trimming the common start and end). Past `maxEdits` the middle is left unmatched.
 */
export function lcsPairs(n: number, m: number, eq: (i: number, j: number) => boolean, maxEdits = 1500): [number, number][] {
  let pre = 0;
  while (pre < n && pre < m && eq(pre, pre)) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && eq(n - 1 - suf, m - 1 - suf)) suf++;
  const out: [number, number][] = [];
  for (let k = 0; k < pre; k++) out.push([k, k]);
  const N = n - pre - suf;
  const M = m - pre - suf;
  if (N > 0 && M > 0) {
    const max = Math.min(N + M, maxEdits);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    // The frontier before each round, diagonals -d-1..d+1 only
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && eq(pre + x, pre + y)) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) { found = d; break; }
      }
    }
    if (found >= 0) {
      const middle: [number, number][] = [];
      let x = N;
      let y = M;
      for (let d = found; d > 0; d--) {
        const prev = trace[d];
        const at = (k: number) => prev[k + d + 1];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { x--; y--; middle.push([pre + x, pre + y]); }
        x = prevX;
        y = prevY;
      }
      while (x > 0 && y > 0) { x--; y--; middle.push([pre + x, pre + y]); }
      out.push(...middle.reverse());
    }
  }
  for (let k = suf; k > 0; k--) out.push([n - k, m - k]);
  return out;
}

/**
 * Pairs of equal keys of two sequences, in order (null keys never pair): keys found once on each
 * side anchor first (patience), what's between them is matched the same way, and stretches with
 * no such key by a longest common subsequence when they are small enough.
 */
export function anchorPairs(a: (string | null)[], b: (string | null)[]): [number, number][] {
  const out: [number, number][] = [];
  const run = (alo: number, ahi: number, blo: number, bhi: number) => {
    while (alo < ahi && blo < bhi && a[alo] != null && a[alo] === b[blo]) out.push([alo++, blo++]);
    const tail: [number, number][] = [];
    while (ahi > alo && bhi > blo && a[ahi - 1] != null && a[ahi - 1] === b[bhi - 1]) tail.push([--ahi, --bhi]);
    if (alo < ahi && blo < bhi) {
      const count = new Map<string, { a: number; b: number; ai: number; bi: number }>();
      for (let i = alo; i < ahi; i++) { const k = a[i]; if (k == null) continue; const c = count.get(k) ?? { a: 0, b: 0, ai: i, bi: -1 }; c.a++; count.set(k, c); }
      for (let j = blo; j < bhi; j++) { const k = b[j]; if (k == null) continue; const c = count.get(k); if (c) { c.b++; c.bi = j; } }
      const unique: [number, number][] = [];
      for (const c of count.values()) if (c.a === 1 && c.b === 1) unique.push([c.ai, c.bi]);
      unique.sort((x, y) => x[0] - y[0]);
      const anchors = increasing(unique);
      if (anchors.length) {
        let pa = alo;
        let pb = blo;
        for (const [i, j] of anchors) { run(pa, i, pb, j); out.push([i, j]); pa = i + 1; pb = j + 1; }
        run(pa, ahi, pb, bhi);
      } else if ((ahi - alo) * (bhi - blo) <= 250_000) {
        for (const [i, j] of lcsPairs(ahi - alo, bhi - blo, (i, j) => a[alo + i] != null && a[alo + i] === b[blo + j], 1000)) out.push([alo + i, blo + j]);
      }
    }
    out.push(...tail.reverse());
  };
  run(0, a.length, 0, b.length);
  return out;
}

/** The longest run of pairs increasing in both (pairs come sorted by the first) */
function increasing(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [];
  const prev = new Array<number>(pairs.length).fill(-1);
  pairs.forEach(([, j], k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < j) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  });
  const out: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

/** How many of `a`'s words are in `b`, in order */
export function wordsInOrder(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  if (a.length * b.length > 400_000) {
    // Too long to align word by word: the words they share, in any order
    const have = new Map<string, number>();
    for (const w of b) have.set(w, (have.get(w) ?? 0) + 1);
    let n = 0;
    for (const w of a) { const c = have.get(w) ?? 0; if (c) { n++; have.set(w, c - 1); } }
    return n;
  }
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** A paragraph's start as people would recognise it, in quotes: “Quarterly plan for…” */
export function quoted(text: string, max = 32): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return `“${flat}”`;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `“${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…”`;
}

/** A short preview of added text */
export function preview(text: string, max = 80): string {
  const flat = text.replace(/[\uFFFC\f]/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/** A short stable id for a string (FNV-1a) */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
