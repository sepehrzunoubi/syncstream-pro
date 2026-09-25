/**
 * The editor shows a Google Doc that can be edited freely. Two kinds of
 * change come out of it:
 *
 *  - Direct edits to what the document already has (formatting, deleting,
 *    splitting or joining paragraphs). These are saved to the Google Doc
 *    right away, like Docs itself autosaves.
 *  - Additions: text the user types or pastes. It carries the "syncAdd" mark
 *    (it glows) and is typed into the Google Doc by a sync, spot by spot,
 *    top to bottom.
 *
 * Both come from comparing the document as last saved (the base) with the
 * editor (the target), token by token. Everything here works on editor JSON
 * so it runs the same in the browser and in tests.
 */

import {
  DEFAULT_PARAGRAPH,
  DOCS_ALIGN,
  LINK_COLOR,
  LIST_PRESETS,
  NAMED_STYLES,
  OBJ,
  effectiveIndent,
  paragraphFromAttrs,
  resolveTextStyle,
  rgb,
  sameStyle,
  styleFromMarks,
  textRequest,
  type DocsRequest,
  type EditorNode,
  type ImageRef,
  type ParagraphFormat,
  type RichFormat,
  type RunFormat,
  type RunStyle,
} from "./rich-text";

export const PENDING_MARK = "syncAdd";

type Marks = NonNullable<EditorNode["marks"]>;

export type Tok =
  | { k: "c"; c: string; marks: Marks; pending: boolean }
  | { k: "img"; attrs: Record<string, unknown>; marks: Marks; pending: boolean }
  | { k: "br"; marks: Marks; pending: boolean }
  /** End of a paragraph; carries the paragraph's attributes, like the newline does in Docs */
  | { k: "nl"; attrs: Record<string, unknown> }
  /** Something shown but not editable (a table, a section break): `span` Docs indices */
  | { k: "block"; node: EditorNode };

const isPendingMarks = (marks: Marks | undefined) => !!marks?.some((m) => m.type === PENDING_MARK);
const withoutPending = (marks: Marks | undefined): Marks => (marks ?? []).filter((m) => m.type !== PENDING_MARK);
/** Only text and images are additions; line breaks on their own are edits to the document */
const isPending = (t: Tok) => (t.k === "c" || t.k === "img") && t.pending;

/** Size of a token in Docs indices */
function sizeOf(t: Tok): number {
  if (t.k === "block") return typeof t.node.attrs?.span === "number" ? (t.node.attrs.span as number) : 0;
  return 1;
}

export function tokenize(doc: EditorNode | null | undefined): Tok[] {
  const out: Tok[] = [];
  for (const node of doc?.content ?? []) {
    if (node.attrs?.locked) {
      out.push({ k: "block", node });
      continue;
    }
    for (const child of node.content ?? []) {
      const marks = child.marks ?? [];
      const pending = isPendingMarks(marks);
      if (child.type === "text" && typeof child.text === "string") {
        for (let i = 0; i < child.text.length; i++) out.push({ k: "c", c: child.text[i], marks, pending });
      } else if (child.type === "image") {
        out.push({ k: "img", attrs: child.attrs ?? {}, marks, pending });
      } else if (child.type === "hardBreak") {
        out.push({ k: "br", marks, pending });
      }
    }
    out.push({ k: "nl", attrs: node.attrs ?? {} });
  }
  return out;
}

const marksKey = (m: Marks) => JSON.stringify(m);

export function untokenize(tokens: Tok[]): EditorNode {
  const content: EditorNode[] = [];
  let inline: EditorNode[] = [];
  let text = "";
  let textMarks: Marks | null = null;
  const flushText = () => {
    if (text) inline.push(textMarks && textMarks.length ? { type: "text", text, marks: textMarks } : { type: "text", text });
    text = "";
    textMarks = null;
  };
  for (const t of tokens) {
    if (t.k === "c") {
      if (textMarks && marksKey(textMarks) !== marksKey(t.marks)) flushText();
      textMarks = t.marks;
      text += t.c;
      continue;
    }
    flushText();
    if (t.k === "img") inline.push(t.marks.length ? { type: "image", attrs: t.attrs, marks: t.marks } : { type: "image", attrs: t.attrs });
    else if (t.k === "br") inline.push(t.marks.length ? { type: "hardBreak", marks: t.marks } : { type: "hardBreak" });
    else if (t.k === "nl") {
      content.push({ type: "paragraph", attrs: t.attrs, content: inline });
      inline = [];
    } else if (t.k === "block") {
      content.push(t.node);
    }
  }
  flushText();
  if (inline.length) content.push({ type: "paragraph", content: inline });
  if (!content.length) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

/** The document's characters and structure, ignoring formatting: equal when two copies read the same */
export function signature(doc: EditorNode | null | undefined): string {
  return tokenize(doc)
    .filter((t) => !isPending(t))
    .map((t) => (t.k === "c" ? t.c : t.k === "img" ? OBJ : t.k === "br" ? "\u000b" : t.k === "nl" ? "\n" : `\u0000${sizeOf(t)}\u0000`))
    .join("");
}

/** True when the editor holds any addition */
export function hasPending(doc: EditorNode | null | undefined): boolean {
  return tokenize(doc).some(isPending);
}

/** True when the document has text of its own (not only additions) */
export function hasOriginalText(doc: EditorNode | null | undefined): boolean {
  return tokenize(doc).some((t) => (t.k === "c" && !t.pending && t.c.trim() !== "") || (t.k === "img" && !t.pending) || t.k === "block");
}

// ── Diff ────────────────────────────────────────────────────────────────────

function same(b: Tok, t: Tok): boolean {
  if (isPending(t) || b.k !== t.k) return false;
  switch (b.k) {
    case "c": return b.c === (t as typeof b).c;
    case "img": return b.attrs.src === (t as typeof b).attrs.src;
    case "block": return b.node.attrs?.bid === (t as typeof b).node.attrs?.bid;
    default: return true;
  }
}

/**
 * For each target token, the base token it is the same as (or -1). Myers'
 * diff after trimming the common start and end; very different documents
 * fall back to replacing the middle.
 */
export function alignTokens(base: Tok[], target: Tok[], maxEdits = 4000): number[] {
  const match = new Array<number>(target.length).fill(-1);
  let pre = 0;
  while (pre < base.length && pre < target.length && same(base[pre], target[pre])) { match[pre] = pre; pre++; }
  let suf = 0;
  while (suf < base.length - pre && suf < target.length - pre && same(base[base.length - 1 - suf], target[target.length - 1 - suf])) {
    match[target.length - 1 - suf] = base.length - 1 - suf;
    suf++;
  }
  const a = base.slice(pre, base.length - suf);
  const b = target.slice(pre, target.length - suf);
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return match;

  // Myers O((n+m)·d), keeping each round's frontier to walk the path back
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(a[x], b[y])) { x++; y++; }
      next[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    v = next;
    if (found >= 0) { trace.push(v.slice()); break; }
  }
  if (found < 0) return match; // too different: everything in the middle changed

  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; match[pre + y] = pre + x; }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; match[pre + y] = pre + x; }
  return match;
}

interface Region {
  /** Base tokens [bs, be) that are gone */
  bs: number;
  be: number;
  /** Target tokens [ts, te) that are new */
  ts: number;
  te: number;
  pending: boolean;
}

/** Stretches between matched tokens where something changed */
function regionsOf(base: Tok[], target: Tok[], match: number[]): Region[] {
  const regions: Region[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < target.length) {
    if (j < target.length && match[j] === i && i < base.length) { i++; j++; continue; }
    const ts = j;
    while (j < target.length && match[j] < 0) j++;
    const nextBase = j < target.length ? match[j] : base.length;
    const bs = i;
    i = Math.max(i, nextBase);
    if (j > ts || i > bs) {
      regions.push({ bs, be: i, ts, te: j, pending: target.slice(ts, j).some(isPending) });
    }
  }
  return regions;
}

/**
 * Move an addition that ends with a paragraph break and starts right after
 * one to just before that break: "Enter at the end of a paragraph, then
 * type" rather than "type at the start of the next one", which keeps the
 * next paragraph's style out of the addition.
 */
function rotate(base: Tok[], target: Tok[], match: number[]): void {
  for (const r of regionsOf(base, target, match)) {
    if (r.be !== r.bs || r.te === r.ts || r.ts === 0 || r.bs === 0) continue;
    if (target[r.te - 1].k !== "nl" || target[r.ts - 1].k !== "nl") continue;
    if (match[r.ts - 1] !== r.bs - 1 || base[r.bs - 1].k !== "nl") continue;
    match[r.te - 1] = r.bs - 1;
    match[r.ts - 1] = -1;
  }
}

function diff(base: Tok[], target: Tok[], forTyping = true) {
  const match = alignTokens(base, target);
  if (forTyping) rotate(base, target, match);
  const regions = regionsOf(base, target, match);
  // Docs index of each base token
  const index = new Array<number>(base.length + 1);
  let at = 1;
  for (let i = 0; i < base.length; i++) { index[i] = at; at += sizeOf(base[i]); }
  index[base.length] = at;
  return { match, regions, index };
}

/** Whether target paragraph ending at nl token j has additions in it */
function paragraphHasPending(target: Tok[], j: number): boolean {
  for (let q = j - 1; q >= 0; q--) {
    const t = target[q];
    if (t.k === "nl" || t.k === "block") return false;
    if (isPending(t)) return true;
  }
  return false;
}

// ── Direct edits ────────────────────────────────────────────────────────────

function textStyleDiff(a: RunStyle, b: RunStyle): { textStyle: DocsRequest; fields: string[] } | null {
  const textStyle: DocsRequest = {};
  const fields: string[] = [];
  const flag = (key: "b" | "i" | "u" | "s", field: string) => {
    if (!!a[key] !== !!b[key]) { textStyle[field] = !!b[key]; fields.push(field); }
  };
  flag("b", "bold");
  flag("i", "italic");
  flag("u", "underline");
  flag("s", "strikethrough");
  if (a.font !== b.font) { if (b.font) textStyle.weightedFontFamily = { fontFamily: b.font, weight: 400 }; fields.push("weightedFontFamily"); }
  if (a.size !== b.size) { if (b.size) textStyle.fontSize = { magnitude: b.size, unit: "PT" }; fields.push("fontSize"); }
  if (a.color !== b.color) { if (b.color) textStyle.foregroundColor = rgb(b.color); fields.push("foregroundColor"); }
  if (a.bg !== b.bg) { if (b.bg) textStyle.backgroundColor = rgb(b.bg); fields.push("backgroundColor"); }
  if (a.link !== b.link) {
    if (b.link) textStyle.link = { url: b.link };
    fields.push("link");
    // Links look like links in Docs only with the colour and underline set
    if (b.link && !a.link) {
      if (!b.color && !fields.includes("foregroundColor")) { textStyle.foregroundColor = rgb(LINK_COLOR); fields.push("foregroundColor"); }
      if (!fields.includes("underline")) { textStyle.underline = true; fields.push("underline"); }
    }
  }
  return fields.length ? { textStyle, fields } : null;
}

function paragraphDiff(a: ParagraphFormat, b: ParagraphFormat): { style: DocsRequest; fields: string[] } | null {
  const style: DocsRequest = {};
  const fields: string[] = [];
  if (a.style !== b.style) { style.namedStyleType = NAMED_STYLES[b.style].docs; fields.push("namedStyleType"); }
  if (a.align !== b.align) { style.alignment = DOCS_ALIGN[b.align]; fields.push("alignment"); }
  if (a.spacing !== b.spacing) { style.lineSpacing = b.spacing; fields.push("lineSpacing"); }
  if (!b.list) {
    const ia = effectiveIndent(a);
    const ib = effectiveIndent(b);
    // Removing bullets leaves their indent behind in Docs, so always set it then
    if (a.list || ia.start !== ib.start || ia.first !== ib.first) {
      style.indentStart = { magnitude: ib.start, unit: "PT" };
      style.indentFirstLine = { magnitude: ib.first, unit: "PT" };
      fields.push("indentStart", "indentFirstLine");
    }
  }
  return fields.length ? { style, fields } : null;
}

export interface DirectEdits {
  /** One batchUpdate, in order */
  requests: DocsRequest[];
  /** The base once these edits are saved: the target without its additions */
  saved: EditorNode;
}

/** Requests that make the Google Doc match the editor, except for additions */
export function directEdits(baseDoc: EditorNode, targetDoc: EditorNode): DirectEdits {
  const base = tokenize(baseDoc);
  const target = tokenize(targetDoc);
  const { match, regions, index } = diff(base, target);

  // Paragraph starts in the base, for paragraph ranges
  const paraStart = new Array<number>(base.length);
  let start = 0;
  for (let i = 0; i < base.length; i++) {
    paraStart[i] = start;
    if (base[i].k === "nl" || base[i].k === "block") start = i + 1;
  }

  const styleRequests: DocsRequest[] = [];
  const bulletRequests: DocsRequest[] = [];
  let run: { from: number; to: number; key: string; diff: NonNullable<ReturnType<typeof textStyleDiff>> } | null = null;
  const flushRun = () => {
    if (run) styleRequests.push({ updateTextStyle: { range: { startIndex: run.from, endIndex: run.to }, textStyle: run.diff.textStyle, fields: run.diff.fields.join(",") } });
    run = null;
  };
  const creates: { from: number; to: number; preset: string }[] = [];

  for (let j = 0; j < target.length; j++) {
    const i = match[j];
    if (i < 0) continue;
    const b = base[i];
    const t = target[j];
    if ((b.k === "c" || b.k === "br" || b.k === "img") && (t.k === "c" || t.k === "br" || t.k === "img")) {
      const d = textStyleDiff(styleFromMarks(withoutPending(b.marks)), styleFromMarks(withoutPending(t.marks)));
      if (!d) { flushRun(); continue; }
      const key = JSON.stringify(d);
      const r = run as { from: number; to: number; key: string } | null;
      if (r && r.key === key && r.to === index[i]) r.to = index[i] + 1;
      else { flushRun(); run = { from: index[i], to: index[i] + 1, key, diff: d }; }
      continue;
    }
    flushRun();
    if (b.k === "nl" && t.k === "nl" && !paragraphHasPending(target, j)) {
      const pa = paragraphFromAttrs(b.attrs);
      const pb = paragraphFromAttrs(t.attrs);
      const range = { startIndex: index[paraStart[i]], endIndex: index[i] + 1 };
      if ((pa.list ?? null) !== (pb.list ?? null)) {
        if (pa.list) bulletRequests.push({ deleteParagraphBullets: { range } });
        if (pb.list) creates.push({ from: range.startIndex, to: range.endIndex, preset: LIST_PRESETS[pb.list] });
      }
      const d = paragraphDiff(pa, pb);
      if (d) styleRequests.push({ updateParagraphStyle: { range, paragraphStyle: d.style, fields: d.fields.join(",") } });
    }
  }
  flushRun();
  // Consecutive paragraphs turned into the same kind of list become one list
  const merged: typeof creates = [];
  for (const c of creates) {
    const last = merged[merged.length - 1];
    if (last && last.preset === c.preset && last.to === c.from) last.to = c.to;
    else merged.push({ ...c });
  }
  for (const c of merged) bulletRequests.push({ createParagraphBullets: { range: { startIndex: c.from, endIndex: c.to }, bulletPreset: c.preset } });

  // Content changes from the end backwards, so earlier indices stay valid
  const contentRequests: DocsRequest[] = [];
  for (const r of [...regions].reverse()) {
    const at = index[r.bs];
    if (r.be > r.bs) contentRequests.push({ deleteContentRange: { range: { startIndex: at, endIndex: index[r.be] } } });
    if (r.pending || r.te === r.ts) continue;
    // Text that came back without being an addition (undoing a deletion): put it back now
    const inserted = target.slice(r.ts, r.te).filter((t) => t.k !== "block");
    let text = "";
    const styled: { from: number; to: number; style: DocsRequest }[] = [];
    let pos = at;
    for (let q = 0; q < inserted.length; q++) {
      const t = inserted[q];
      if (t.k === "img") {
        if (text) { contentRequests.push({ insertText: { location: { index: pos }, text } }); pos += text.length; text = ""; }
        if (typeof t.attrs.src === "string" && /^https:\/\//.test(t.attrs.src)) {
          contentRequests.push({ insertInlineImage: { location: { index: pos }, uri: t.attrs.src } });
          pos += 1;
        }
        continue;
      }
      // Docs drops soft line breaks sent through the API, so a line break becomes a new paragraph
      const ch = t.k === "c" ? t.c : "\n";
      if (t.k === "c") {
        const para = paragraphFromAttrs(nextNl(target, r.ts + q)?.attrs);
        styled.push({ from: pos + text.length, to: pos + text.length + 1, style: resolveTextStyle(styleFromMarks(withoutPending(t.marks)), para) });
      }
      text += ch;
    }
    if (text) contentRequests.push({ insertText: { location: { index: pos }, text } });
    for (const st of styled) contentRequests.push(textRequest(st.style, st.from, st.to));
  }

  const requests = [...styleRequests, ...bulletRequests, ...contentRequests];

  // What the base becomes: the target without additions, with paragraph
  // changes that wait for an addition still at their saved values
  const saved: Tok[] = [];
  const regionAt = new Map<number, Region>();
  for (const r of regions) regionAt.set(r.ts, r);
  for (let j = 0; j < target.length; j++) {
    const r = regionAt.get(j);
    if (r && r.te > r.ts) {
      if (!r.pending) for (let q = r.ts; q < r.te; q++) saved.push(stripPending(target[q]));
      j = r.te - 1;
      continue;
    }
    const i = match[j];
    if (i < 0) continue;
    const t = target[j];
    if (t.k === "nl" && paragraphHasPending(target, j)) saved.push(base[i]);
    else saved.push(stripPending(t));
  }
  return { requests, saved: untokenize(saved) };
}

function stripPending(t: Tok): Tok {
  if (t.k === "c" || t.k === "img" || t.k === "br") return { ...t, marks: withoutPending(t.marks), pending: false };
  return t;
}

function nextNl(tokens: Tok[], from: number): Extract<Tok, { k: "nl" }> | undefined {
  for (let q = from; q < tokens.length; q++) {
    const t = tokens[q];
    if (t.k === "nl") return t;
  }
  return undefined;
}

// ── Additions ───────────────────────────────────────────────────────────────

export interface Segment {
  /** Docs index in the saved document where the addition goes */
  at: number;
  /**
   * "inline": typed at `at`. "before": a new paragraph is opened at `at`
   * (the start of a paragraph) and the text typed into it.
   */
  mode: "inline" | "before";
  text: string;
  format: RichFormat;
  /** The target tokens this text came from, for showing progress */
  tokens: [number, number];
}

const DROPPED_BY_DOCS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uE000-\\uF8FF\\u2028\\u2029]");

/**
 * The additions, in document order, with where each goes in the saved
 * document. Call with the base as saved (no direct edits left to save).
 */
export function additions(baseDoc: EditorNode, targetDoc: EditorNode): { segments: Segment[]; text: string; boundaries: number[] } {
  const base = tokenize(baseDoc);
  const target = tokenize(targetDoc);
  const { regions, index } = diff(base, target);
  const segments: Segment[] = [];
  for (const r of regions) {
    if (!r.pending || r.te === r.ts) continue;
    const atParagraphStart = r.bs === 0 || base[r.bs - 1].k === "nl" || base[r.bs - 1].k === "block";
    const endsWithBreak = target[r.te - 1].k === "nl";
    const mode: Segment["mode"] = atParagraphStart && endsWithBreak ? "before" : "inline";
    const te = mode === "before" ? r.te - 1 : r.te;
    segments.push({ at: index[r.bs], mode, ...segmentText(target, r.ts, te), tokens: [r.ts, te] });
  }
  let text = "";
  const boundaries: number[] = [];
  for (const s of segments) {
    if (text.length) boundaries.push(text.length);
    text += s.text;
  }
  return { segments, text, boundaries };
}

/** Text and formatting of target tokens [ts, te): line k is paragraph k */
function segmentText(target: Tok[], ts: number, te: number): { text: string; format: RichFormat } {
  let text = "";
  const runs: RunFormat[] = [];
  const images: ImageRef[] = [];
  const paragraphs: ParagraphFormat[] = [];
  const push = (len: number, style: RunStyle) => {
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.len += len;
    else runs.push({ len, ...style });
  };
  let lastStyle: RunStyle = {};
  let lineStart = true;
  for (let q = ts; q < te; q++) {
    const t = target[q];
    if (lineStart) {
      paragraphs.push(paragraphFromAttrs(nextNl(target, q)?.attrs));
      lineStart = false;
    }
    if (t.k === "nl" || t.k === "br") {
      const style = { ...lastStyle };
      delete style.link;
      text += "\n";
      push(1, style);
      lineStart = true;
      continue;
    }
    if (t.k === "block") continue;
    const style = styleFromMarks(withoutPending(t.marks));
    lastStyle = style;
    if (t.k === "img") {
      const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) || 0 : 0);
      const src = typeof t.attrs.src === "string" ? t.attrs.src : "";
      if (/^https?:\/\//i.test(src)) {
        images.push({ at: text.length, src, w: Math.round(num(t.attrs.width) * 0.75 * 10) / 10, h: Math.round(num(t.attrs.height) * 0.75 * 10) / 10 });
        text += OBJ;
      } else text += " ";
      push(1, style);
      continue;
    }
    let ch = t.c;
    // Keep one character per token: swap what Docs would drop, and a tab that would start a list item
    if (DROPPED_BY_DOCS.test(ch) || ch === OBJ) ch = " ";
    if (ch === "\t" && paragraphs[paragraphs.length - 1]?.list && (text.length === 0 || text[text.length - 1] === "\n")) ch = " ";
    text += ch;
    push(1, style);
  }
  if (lineStart) paragraphs.push(paragraphFromAttrs(nextNl(target, te)?.attrs));
  if (!paragraphs.length) paragraphs.push({ ...DEFAULT_PARAGRAPH });
  const format: RichFormat = { v: 1, paragraphs, runs };
  if (images.length) format.images = images;
  return { text, format };
}

// ── Reloading ───────────────────────────────────────────────────────────────

/**
 * The document as Google has it now, with the editor's additions put back
 * where they were. The Google Doc wins everywhere else.
 */
export function rebase(newBase: EditorNode, oldTarget: EditorNode): EditorNode {
  const base = tokenize(newBase);
  const target = tokenize(oldTarget);
  const { regions } = diff(base, target, false);
  const regionAt = new Map<number, Region>();
  for (const r of regions) regionAt.set(r.bs, r);
  const out: Tok[] = [];
  let i = 0;
  while (i <= base.length) {
    const r = regionAt.get(i);
    if (r) {
      // Base tokens the editor had lost stay, since Google has them; additions follow
      for (let q = r.bs; q < r.be; q++) out.push(base[q]);
      if (r.pending) for (let q = r.ts; q < r.te; q++) out.push(target[q]);
      i = r.be;
    }
    if (i < base.length) out.push(base[i]);
    i++;
  }
  return untokenize(out);
}
