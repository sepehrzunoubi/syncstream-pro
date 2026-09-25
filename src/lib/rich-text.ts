/**
 * Formatted source text.
 *
 * The planner and runner work on plain text. Formatting travels alongside it
 * as run lengths (character styles) and one entry per paragraph, so any range
 * of the text can be turned into the Google Docs requests that style it.
 */

// ── Vocabulary (mirrors the Google Docs editor) ─────────────────────────────

export type NamedStyle = "normal" | "title" | "subtitle" | "h1" | "h2" | "h3";
export type Align = "left" | "center" | "right" | "justify";
export type ListType = "bullet" | "ordered" | "check";

/** Placeholder character for an inline image in the source text (one Docs index, like the image) */
export const OBJ = "\uFFFC";

const LIST_PRESETS: Record<ListType, string> = {
  bullet: "BULLET_DISC_CIRCLE_SQUARE",
  ordered: "NUMBERED_DECIMAL_ALPHA_ROMAN",
  check: "BULLET_CHECKBOX",
};
const LIST_TYPES = new Set<string>(["bullet", "ordered", "check"]);
/** Docs' default link colour */
export const LINK_COLOR = "#1155cc";

export const NAMED_STYLES: Record<NamedStyle, { label: string; size: number; docs: string }> = {
  normal: { label: "Normal text", size: 11, docs: "NORMAL_TEXT" },
  title: { label: "Title", size: 26, docs: "TITLE" },
  subtitle: { label: "Subtitle", size: 15, docs: "SUBTITLE" },
  h1: { label: "Heading 1", size: 20, docs: "HEADING_1" },
  h2: { label: "Heading 2", size: 16, docs: "HEADING_2" },
  h3: { label: "Heading 3", size: 14, docs: "HEADING_3" },
};
export const NAMED_STYLE_ORDER: NamedStyle[] = ["normal", "title", "subtitle", "h1", "h2", "h3"];

const DOCS_ALIGN: Record<Align, string> = { left: "START", center: "CENTER", right: "END", justify: "JUSTIFIED" };

export const DEFAULT_FONT = "Arial";

/** Fonts offered in the menu, with metric-compatible web fallbacks for the preview */
export const FONT_STACKS: Record<string, string> = {
  Arial: 'Arial, Arimo, "Liberation Sans", sans-serif',
  Calibri: "Calibri, Carlito, sans-serif",
  Cambria: "Cambria, Caladea, serif",
  "Comic Sans MS": '"Comic Sans MS", "Comic Neue", cursive',
  "Courier New": '"Courier New", Cousine, monospace',
  "EB Garamond": '"EB Garamond", Garamond, serif',
  Georgia: "Georgia, Gelasio, serif",
  Lato: "Lato, sans-serif",
  Lexend: "Lexend, sans-serif",
  Lora: "Lora, serif",
  Merriweather: "Merriweather, serif",
  Montserrat: "Montserrat, sans-serif",
  Nunito: "Nunito, sans-serif",
  "Open Sans": '"Open Sans", sans-serif',
  "Playfair Display": '"Playfair Display", serif',
  Roboto: "Roboto, sans-serif",
  "Roboto Mono": '"Roboto Mono", monospace',
  Spectral: "Spectral, serif",
  "Times New Roman": '"Times New Roman", Tinos, "Liberation Serif", serif',
  "Trebuchet MS": '"Trebuchet MS", sans-serif',
  Verdana: "Verdana, sans-serif",
};
export const FONT_FAMILIES = Object.keys(FONT_STACKS);

export function fontStack(family: string): string {
  return FONT_STACKS[family] ?? `"${family.replace(/"/g, "")}", ${FONT_STACKS[DEFAULT_FONT]}`;
}

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
export const LINE_SPACINGS = [
  { value: 100, label: "Single" },
  { value: 115, label: "1.15" },
  { value: 150, label: "1.5" },
  { value: 200, label: "Double" },
];
/** One indent step, like the Docs toolbar: half an inch */
export const INDENT_PT = 36;
export const MAX_INDENT = 8;
/** CSS line-height for Docs line spacing: Docs uses 1.2× the font size as "single" */
export function cssLineHeight(spacing: number): number {
  return Math.round((spacing / 100) * 1.2 * 1000) / 1000;
}

// ── Model ───────────────────────────────────────────────────────────────────

export interface ParagraphFormat {
  style: NamedStyle;
  align: Align;
  /** Indent level, each step is INDENT_PT */
  indent: number;
  /** Extra first-line indent of one step */
  firstLine: boolean;
  /** Line spacing in percent, 100 = single */
  spacing: number;
  /** Bulleted, numbered or checklist paragraph */
  list?: ListType;
}

export interface RunFormat {
  len: number;
  b?: 1;
  i?: 1;
  u?: 1;
  s?: 1;
  font?: string;
  /** Point size; when absent the paragraph's named-style size applies */
  size?: number;
  /** Text colour, #rrggbb */
  color?: string;
  /** Highlight colour, #rrggbb */
  bg?: string;
  /** Link target (http, https or mailto) */
  link?: string;
}

/** An inline image at source offset `at` (where the text holds OBJ). Size in points. */
export interface ImageRef {
  at: number;
  src: string;
  w: number;
  h: number;
}

export interface RichFormat {
  v: 1;
  paragraphs: ParagraphFormat[];
  runs: RunFormat[];
  images?: ImageRef[];
}

export const DEFAULT_PARAGRAPH: ParagraphFormat = { style: "normal", align: "left", indent: 0, firstLine: false, spacing: 115 };

const MAX_RUNS = 200_000;
const MAX_PARAGRAPHS = 100_000;

/**
 * Remove what Google Docs would silently drop (carriage returns, most control
 * characters, private-use characters) so offsets stay aligned with the doc.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uE000-\uF8FF]/g, "");
}

export function plainFormat(text: string): RichFormat {
  const paragraphCount = countChar(text, "\n") + 1;
  return {
    v: 1,
    paragraphs: Array.from({ length: paragraphCount }, () => ({ ...DEFAULT_PARAGRAPH })),
    runs: text.length > 0 ? [{ len: text.length }] : [],
  };
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

// ── CSS helpers shared with the editor ─────────────────────────────────────

/** "\"Times New Roman\", serif" → "Times New Roman" */
export function cssFontToFamily(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim().replace(/^["']|["']$/g, "").trim();
  if (!first) return undefined;
  const known = FONT_FAMILIES.find((f) => f.toLowerCase() === first.toLowerCase());
  return known ?? (isSafeFontName(first) ? first : undefined);
}

/** "12pt" → 12, "16px" → 12, "0.5in" → 36. Returns undefined for unknown units. */
export function cssLengthToPt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(-?\d*\.?\d+)\s*(pt|px|in|cm|mm|em)?$/i.exec(value.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "px").toLowerCase();
  const pt = unit === "pt" ? n : unit === "px" ? n * 0.75 : unit === "in" ? n * 72 : unit === "cm" ? (n * 72) / 2.54 : unit === "mm" ? (n * 72) / 25.4 : n * 12;
  return Number.isFinite(pt) ? pt : undefined;
}

/** "#abc", "#aabbcc", "rgb(1, 2, 3)" → "#010203"; transparent or unknown → undefined */
export function cssColorToHex(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return "#" + m[1].split("").map((c) => c + c).join("");
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return v;
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] != null && parseFloat(m[4]) === 0) return undefined;
    return "#" + [m[1], m[2], m[3]].map((n) => Math.min(255, parseInt(n, 10)).toString(16).padStart(2, "0")).join("");
  }
  return undefined;
}

/** Only web and mail links; adds https:// to bare domains */
export function normalizeLink(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  let h = href.trim();
  if (!h || h.length > 2000) return undefined;
  if (/^(www\.|[a-z0-9-]+\.[a-z]{2,})/i.test(h) && !/^[a-z][a-z0-9+.-]*:/i.test(h)) h = `https://${h}`;
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : undefined;
}

export function roundSize(pt: number): number {
  return Math.min(400, Math.max(1, Math.round(pt * 2) / 2));
}

function isSafeFontName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 \-]{0,59}$/.test(name);
}

// ── From the editor ─────────────────────────────────────────────────────────

/** The subset of TipTap/ProseMirror JSON this module reads */
export interface EditorNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: EditorNode[];
}

type RunStyle = Omit<RunFormat, "len">;

function paragraphFromAttrs(attrs: Record<string, unknown> | undefined): ParagraphFormat {
  const a = attrs ?? {};
  const style = typeof a.styleName === "string" && a.styleName in NAMED_STYLES ? (a.styleName as NamedStyle) : "normal";
  const align = a.textAlign === "center" || a.textAlign === "right" || a.textAlign === "justify" ? a.textAlign : "left";
  const indent = typeof a.indent === "number" ? Math.max(0, Math.min(MAX_INDENT, Math.round(a.indent))) : 0;
  const spacing = typeof a.lineSpacing === "number" && Number.isFinite(a.lineSpacing) ? Math.max(50, Math.min(500, Math.round(a.lineSpacing))) : 115;
  const list = typeof a.list === "string" && LIST_TYPES.has(a.list) ? (a.list as ListType) : undefined;
  return list ? { style, align, indent: 0, firstLine: false, spacing, list } : { style, align, indent, firstLine: a.firstLine === true, spacing };
}

function styleFromMarks(marks: EditorNode["marks"]): RunStyle {
  const s: RunStyle = {};
  for (const m of marks ?? []) {
    if (m.type === "bold") s.b = 1;
    else if (m.type === "italic") s.i = 1;
    else if (m.type === "underline") s.u = 1;
    else if (m.type === "strike") s.s = 1;
    else if (m.type === "textStyle") {
      const font = typeof m.attrs?.fontFamily === "string" ? cssFontToFamily(m.attrs.fontFamily) : undefined;
      if (font) s.font = font;
      const raw = m.attrs?.fontSize;
      const size = typeof raw === "number" ? raw : typeof raw === "string" ? cssLengthToPt(raw) : undefined;
      if (size != null && size > 0) s.size = roundSize(size);
      const color = typeof m.attrs?.color === "string" ? cssColorToHex(m.attrs.color) : undefined;
      if (color && color !== "#000000") s.color = color;
    } else if (m.type === "highlight") {
      const bg = typeof m.attrs?.color === "string" ? cssColorToHex(m.attrs.color) : "#ffff00";
      if (bg) s.bg = bg;
    } else if (m.type === "link") {
      const link = normalizeLink(typeof m.attrs?.href === "string" ? m.attrs.href : undefined);
      if (link) s.link = link;
    }
  }
  return s;
}

const sameStyle = (a: RunStyle, b: RunStyle) =>
  a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.font === b.font && a.size === b.size &&
  a.color === b.color && a.bg === b.bg && a.link === b.link;

/** Convert editor JSON into source text plus formatting. */
export function richFromEditorJSON(doc: EditorNode | null | undefined): { text: string; format: RichFormat } {
  type Piece = { text: string; style: RunStyle; image?: Omit<ImageRef, "at"> };
  const lines: { para: ParagraphFormat; pieces: Piece[] }[] = [];
  const newLine = (para: ParagraphFormat) => {
    const line = { para, pieces: [] as Piece[] };
    lines.push(line);
    return line;
  };

  const visitInline = (node: EditorNode, para: ParagraphFormat, state: { line: ReturnType<typeof newLine> }) => {
    if (node.type === "image") {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      if (/^https?:\/\//i.test(src)) {
        const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) || 0 : 0);
        const wpx = num(node.attrs?.width);
        const hpx = num(node.attrs?.height);
        state.line.pieces.push({ text: OBJ, style: styleFromMarks(node.marks), image: { src, w: Math.round(wpx * 0.75 * 10) / 10, h: Math.round(hpx * 0.75 * 10) / 10 } });
      }
    } else if (node.type === "text" && typeof node.text === "string") {
      const style = styleFromMarks(node.marks);
      const parts = normalizeText(node.text).replace(/\uFFFC/g, "").split("\n");
      parts.forEach((part, idx) => {
        if (idx > 0) state.line = newLine({ ...para });
        if (part) state.line.pieces.push({ text: part, style });
      });
    } else if (node.type === "hardBreak") {
      state.line = newLine({ ...para });
    } else if (node.content) {
      for (const child of node.content) visitInline(child, para, state);
    }
  };

  const visitBlock = (node: EditorNode) => {
    const isTextBlock = node.type === "paragraph" || node.type === "heading" || (node.content ?? []).some((c) => c.type === "text" || c.type === "hardBreak");
    if (isTextBlock) {
      const para = paragraphFromAttrs(node.attrs);
      const state = { line: newLine(para) };
      for (const child of node.content ?? []) visitInline(child, para, state);
    } else {
      for (const child of node.content ?? []) visitBlock(child);
    }
  };

  for (const block of doc?.content ?? []) visitBlock(block);
  if (lines.length === 0) newLine({ ...DEFAULT_PARAGRAPH });

  // Docs removes leading tabs when it turns a paragraph into a list item; drop them here so offsets agree.
  for (const line of lines) {
    if (!line.para.list) continue;
    while (line.pieces.length && line.pieces[0].text.startsWith("\t")) {
      line.pieces[0].text = line.pieces[0].text.replace(/^\t+/, "");
      if (!line.pieces[0].text) line.pieces.shift();
    }
  }

  let text = "";
  const runs: RunFormat[] = [];
  const images: ImageRef[] = [];
  const push = (len: number, style: RunStyle) => {
    if (len <= 0) return;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.len += len;
    else runs.push({ len, ...style });
  };
  lines.forEach((line, idx) => {
    if (idx > 0) {
      const prev = lines[idx - 1].pieces;
      // Docs can't link a newline, so it never carries the link
      const nl: RunStyle = prev.length ? { ...prev[prev.length - 1].style } : {};
      delete nl.link;
      push(1, nl);
      text += "\n";
    }
    for (const piece of line.pieces) {
      if (piece.image) images.push({ at: text.length, ...piece.image });
      text += piece.text;
      push(piece.text.length, piece.style);
    }
  });

  const format: RichFormat = { v: 1, paragraphs: lines.map((l) => l.para), runs };
  if (images.length) format.images = images;
  return { text, format };
}

// ── Validation (server side) ────────────────────────────────────────────────

export function parseFormat(text: string, raw: unknown): { ok: true; format: RichFormat } | { ok: false; error: string } {
  if (raw == null) return { ok: true, format: plainFormat(text) };
  if (typeof raw !== "object") return { ok: false, error: "format must be an object" };
  const r = raw as { v?: unknown; paragraphs?: unknown; runs?: unknown };
  if (r.v !== 1 || !Array.isArray(r.paragraphs) || !Array.isArray(r.runs)) return { ok: false, error: "Unsupported format" };
  if (r.runs.length > MAX_RUNS || r.paragraphs.length > MAX_PARAGRAPHS) return { ok: false, error: "Too much formatting" };

  const expectedParagraphs = countChar(text, "\n") + 1;
  if (r.paragraphs.length !== expectedParagraphs) {
    return { ok: false, error: `format has ${r.paragraphs.length} paragraphs, text has ${expectedParagraphs}` };
  }
  const paragraphs = r.paragraphs.map((p) => paragraphFromAttrs(
    p && typeof p === "object"
      ? {
          styleName: (p as ParagraphFormat).style,
          textAlign: (p as ParagraphFormat).align,
          indent: (p as ParagraphFormat).indent,
          firstLine: (p as ParagraphFormat).firstLine,
          lineSpacing: (p as ParagraphFormat).spacing,
          list: (p as ParagraphFormat).list,
        }
      : undefined
  ));
  // List items can't start with a tab (Docs would delete it and shift every index after it)
  const lineTexts = text.split("\n");
  for (let i = 0; i < paragraphs.length; i++) {
    if (paragraphs[i].list && lineTexts[i].startsWith("\t")) return { ok: false, error: "List items can't start with a tab" };
  }

  const runs: RunFormat[] = [];
  let total = 0;
  for (const item of r.runs) {
    if (!item || typeof item !== "object") return { ok: false, error: "Invalid run" };
    const run = item as RunFormat;
    if (!Number.isInteger(run.len) || run.len <= 0) return { ok: false, error: "Invalid run length" };
    total += run.len;
    const clean: RunFormat = { len: run.len };
    if (run.b) clean.b = 1;
    if (run.i) clean.i = 1;
    if (run.u) clean.u = 1;
    if (run.s) clean.s = 1;
    if (typeof run.font === "string" && isSafeFontName(run.font)) clean.font = run.font;
    if (typeof run.size === "number" && Number.isFinite(run.size) && run.size > 0) clean.size = roundSize(run.size);
    if (typeof run.color === "string" && /^#[0-9a-f]{6}$/i.test(run.color)) clean.color = run.color.toLowerCase();
    if (typeof run.bg === "string" && /^#[0-9a-f]{6}$/i.test(run.bg)) clean.bg = run.bg.toLowerCase();
    const link = typeof run.link === "string" ? normalizeLink(run.link) : undefined;
    if (link) clean.link = link;
    runs.push(clean);
  }
  if (total !== text.length) return { ok: false, error: `format covers ${total} characters, text has ${text.length}` };

  // Every image placeholder needs exactly one image, and nothing else may use the placeholder
  const rawImages = (raw as { images?: unknown }).images;
  const images: ImageRef[] = [];
  if (rawImages != null) {
    if (!Array.isArray(rawImages) || rawImages.length > 200) return { ok: false, error: "Invalid images" };
    for (const item of rawImages) {
      const im = item as Partial<ImageRef>;
      if (!im || !Number.isInteger(im.at) || typeof im.src !== "string") return { ok: false, error: "Invalid image" };
      if (!/^https?:\/\//i.test(im.src) || im.src.length > 2000) return { ok: false, error: "Images need a web address" };
      const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(2000, n)) : 0);
      images.push({ at: im.at as number, src: im.src, w: clamp(im.w), h: clamp(im.h) });
    }
  }
  images.sort((a, b) => a.at - b.at);
  const objectAt: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === OBJ) objectAt.push(i);
  if (objectAt.length !== images.length || objectAt.some((at, i) => images[i].at !== at)) {
    return { ok: false, error: "Images don't line up with the text" };
  }
  const format: RichFormat = { v: 1, paragraphs, runs };
  if (images.length) format.images = images;
  return { ok: true, format };
}

// ── To Google Docs requests ─────────────────────────────────────────────────

export type DocsRequest = Record<string, unknown>;

/** List state of the paragraph the next write appends to */
export type DocListState = { type: ListType; start: number } | null;

/** Precomputed lookups for turning text ranges into Docs formatting requests. */
export class FormatIndex {
  private readonly paraStarts: number[];
  private readonly runStarts: number[];

  constructor(private readonly text: string, private readonly format: RichFormat) {
    this.paraStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.paraStarts.push(i + 1);
    this.runStarts = [];
    let pos = 0;
    for (const r of format.runs) {
      this.runStarts.push(pos);
      pos += r.len;
    }
  }

  paragraphIndexAt(offset: number): number {
    return lastLE(this.paraStarts, offset);
  }

  paragraphAt(offset: number): ParagraphFormat {
    return this.format.paragraphs[this.paragraphIndexAt(offset)] ?? DEFAULT_PARAGRAPH;
  }

  private runIndexAt(offset: number): number {
    return Math.max(0, lastLE(this.runStarts, offset));
  }

  /** Requests that style the source range [start, end) once it sits at docIndex in the doc. */
  styleRequests(start: number, end: number, docIndex: number): DocsRequest[] {
    return this.writeRequests(start, end, docIndex, null).requests;
  }

  /** The image placed at source offset `at`, if any */
  imageAt(at: number): ImageRef | undefined {
    return this.format.images?.find((im) => im.at === at);
  }

  /**
   * Everything needed after inserting source range [start, end) at docIndex:
   * paragraph styles and list membership for paragraphs that begin in the
   * range, then character styles.
   *
   * `docList` is the list state of the paragraph text is being appended to,
   * as it was before this write. Every paragraph created by the write
   * inherits it (Docs copies the paragraph style, bullets included, on each
   * new line), so each new paragraph is corrected against it. A list item
   * joins its list by re-creating bullets from the list's first item, which
   * keeps numbering continuous across writes. Returns the new state of the
   * paragraph that the next write will append to.
   */
  writeRequests(start: number, end: number, docIndex: number, docList: DocListState): { requests: DocsRequest[]; docList: DocListState } {
    if (end <= start || this.format.runs.length === 0) return { requests: [], docList };
    const requests: DocsRequest[] = [];
    const at = (offset: number) => docIndex + offset - start;
    const processed = new Map<number, DocListState>();

    const firstPara = this.paragraphIndexAt(start);
    const lastPara = this.paragraphIndexAt(end - 1);
    for (let p = firstPara; p <= lastPara; p++) {
      const pStart = this.paraStarts[p];
      if (pStart < start || pStart >= end) continue;
      const pEnd = this.paraStarts[p + 1] ?? this.text.length;
      const segEnd = Math.min(end, Math.max(pEnd, pStart + 1));
      const para = this.format.paragraphs[p] ?? DEFAULT_PARAGRAPH;
      if (!para.list) {
        if (docList) requests.push({ deleteParagraphBullets: { range: { startIndex: at(pStart), endIndex: at(segEnd) } } });
        requests.push(paragraphRequest(para, at(pStart), at(segEnd)));
        processed.set(p, null);
      } else {
        requests.push(paragraphRequest(para, at(pStart), at(segEnd)));
        const listStart = this.listStartOf(p);
        if (!(docList && docList.type === para.list && docList.start === listStart)) {
          requests.push({ createParagraphBullets: { range: { startIndex: at(listStart), endIndex: at(segEnd) }, bulletPreset: LIST_PRESETS[para.list] } });
        }
        processed.set(p, { type: para.list, start: listStart });
      }
    }

    // Character styles, split at run and paragraph boundaries, merged when equal.
    let pending: { from: number; to: number; key: string; style: DocsRequest } | null = null;
    const flush = () => {
      if (pending) requests.push(textRequest(pending.style, at(pending.from), at(pending.to)));
      pending = null;
    };
    let pos = start;
    while (pos < end) {
      const ri = this.runIndexAt(pos);
      const run = this.format.runs[ri];
      const runEnd = this.runStarts[ri] + run.len;
      const pi = this.paragraphIndexAt(pos);
      const paraEnd = this.paraStarts[pi + 1] ?? Infinity;
      const segEnd = Math.min(end, runEnd, paraEnd);
      const style = resolveTextStyle(run, this.format.paragraphs[pi] ?? DEFAULT_PARAGRAPH);
      const key = JSON.stringify(style);
      if (pending && (pending as { key: string }).key === key && (pending as { to: number }).to === pos) {
        (pending as { to: number }).to = segEnd;
      } else {
        flush();
        pending = { from: pos, to: segEnd, key, style };
      }
      pos = segEnd;
    }
    flush();

    // The paragraph the next write appends to: created by this write (it
    // inherited the old state), or the last paragraph this write styled.
    let next = docList;
    if (end > 0 && this.text[end - 1] !== "\n") {
      const pl = this.paragraphIndexAt(end - 1);
      if (processed.has(pl)) next = processed.get(pl) ?? null;
    }
    return { requests, docList: next };
  }

  /** Source offset of the first paragraph of the list that paragraph p belongs to */
  private listStartOf(p: number): number {
    const type = this.format.paragraphs[p]?.list;
    let q = p;
    while (q > 0 && this.format.paragraphs[q - 1]?.list === type) q--;
    return this.paraStarts[q];
  }

  /**
   * Requests for `length` characters that are not source text (a typo) typed
   * where source offset `offset` goes: they take that character's style.
   */
  uniformStyleRequests(offset: number, length: number, docIndex: number): DocsRequest[] {
    if (length <= 0 || this.format.runs.length === 0) return [];
    const at = Math.max(0, Math.min(offset, this.text.length - 1));
    const pi = this.paragraphIndexAt(at);
    const para = this.format.paragraphs[pi] ?? DEFAULT_PARAGRAPH;
    const run = { ...this.format.runs[this.runIndexAt(at)] };
    delete run.link;
    return [textRequest(resolveTextStyle(run, para), docIndex, docIndex + length)];
  }
}

function lastLE(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { color: { rgbColor: { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 } } };
}

function resolveTextStyle(run: RunFormat, para: ParagraphFormat): DocsRequest {
  const style: DocsRequest = {
    bold: !!run.b,
    italic: !!run.i,
    underline: !!run.u || !!run.link,
    strikethrough: !!run.s,
    fontSize: { magnitude: run.size ?? NAMED_STYLES[para.style].size, unit: "PT" },
    weightedFontFamily: { fontFamily: run.font ?? DEFAULT_FONT, weight: 400 },
  };
  // Fields listed in the mask but left unset are reset to their defaults
  const color = run.color ?? (run.link ? LINK_COLOR : undefined);
  if (color) style.foregroundColor = rgb(color);
  if (run.bg) style.backgroundColor = rgb(run.bg);
  if (run.link) style.link = { url: run.link };
  return style;
}

function textRequest(textStyle: DocsRequest, startIndex: number, endIndex: number): DocsRequest {
  return {
    updateTextStyle: {
      range: { startIndex, endIndex },
      textStyle,
      fields: "bold,italic,underline,strikethrough,fontSize,weightedFontFamily,foregroundColor,backgroundColor,link",
    },
  };
}

function paragraphRequest(p: ParagraphFormat, startIndex: number, endIndex: number): DocsRequest {
  if (p.list) {
    // Bullets own the indentation of list items
    return {
      updateParagraphStyle: {
        range: { startIndex, endIndex },
        paragraphStyle: { namedStyleType: NAMED_STYLES[p.style].docs, alignment: DOCS_ALIGN[p.align], lineSpacing: p.spacing },
        fields: "namedStyleType,alignment,lineSpacing",
      },
    };
  }
  const indentStart = p.indent * INDENT_PT;
  return {
    updateParagraphStyle: {
      range: { startIndex, endIndex },
      paragraphStyle: {
        namedStyleType: NAMED_STYLES[p.style].docs,
        alignment: DOCS_ALIGN[p.align],
        indentStart: { magnitude: indentStart, unit: "PT" },
        indentFirstLine: { magnitude: indentStart + (p.firstLine ? INDENT_PT : 0), unit: "PT" },
        lineSpacing: p.spacing,
      },
      fields: "namedStyleType,alignment,indentStart,indentFirstLine,lineSpacing",
    },
  };
}

// ── Back to the editor ──────────────────────────────────────────────────────

/** Rebuild editor JSON from text and formatting (the inverse of richFromEditorJSON). */
export function richToEditorJSON(text: string, format: RichFormat | null): EditorNode {
  const fmt = format ?? plainFormat(text);
  const runStarts: number[] = [];
  let acc = 0;
  for (const r of fmt.runs) { runStarts.push(acc); acc += r.len; }

  const content: EditorNode[] = [];
  let pos = 0;
  text.split("\n").forEach((line, li) => {
    const p = fmt.paragraphs[li] ?? DEFAULT_PARAGRAPH;
    const node: EditorNode = {
      type: "paragraph",
      attrs: { styleName: p.style, textAlign: p.align === "left" ? null : p.align, indent: p.indent, firstLine: p.firstLine, lineSpacing: p.spacing, list: p.list ?? null },
      content: [],
    };
    const end = pos + line.length;
    let at = pos;
    while (at < end) {
      const ri = Math.max(0, lastLE(runStarts, at));
      const run = fmt.runs[ri];
      const segEnd = Math.min(end, runStarts[ri] + run.len);
      const marks: NonNullable<EditorNode["marks"]> = [];
      if (run.b) marks.push({ type: "bold" });
      if (run.i) marks.push({ type: "italic" });
      if (run.u) marks.push({ type: "underline" });
      if (run.s) marks.push({ type: "strike" });
      if (run.link) marks.push({ type: "link", attrs: { href: run.link } });
      if (run.bg) marks.push({ type: "highlight", attrs: { color: run.bg } });
      if (run.font || run.size || run.color) marks.push({ type: "textStyle", attrs: { fontFamily: run.font ?? null, fontSize: run.size ?? null, color: run.color ?? null } });
      // Images are single placeholder characters; emit them as image nodes
      let cursor = at;
      for (let k = at; k < segEnd; k++) {
        if (text[k] !== OBJ) continue;
        if (k > cursor) node.content!.push(marks.length ? { type: "text", text: text.slice(cursor, k), marks } : { type: "text", text: text.slice(cursor, k) });
        const im = fmt.images?.find((x) => x.at === k);
        if (im) node.content!.push({ type: "image", attrs: { src: im.src, width: im.w ? Math.round(im.w / 0.75) : null, height: im.h ? Math.round(im.h / 0.75) : null } });
        cursor = k + 1;
      }
      if (segEnd > cursor) node.content!.push(marks.length ? { type: "text", text: text.slice(cursor, segEnd), marks } : { type: "text", text: text.slice(cursor, segEnd) });
      at = segEnd;
    }
    content.push(node);
    pos = end + 1;
  });
  return { type: "doc", content };
}
