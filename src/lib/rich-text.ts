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
}

export interface RichFormat {
  v: 1;
  paragraphs: ParagraphFormat[];
  runs: RunFormat[];
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
  return { style, align, indent, firstLine: a.firstLine === true, spacing };
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
    }
  }
  return s;
}

const sameStyle = (a: RunStyle, b: RunStyle) =>
  a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.font === b.font && a.size === b.size;

/** Convert editor JSON into source text plus formatting. */
export function richFromEditorJSON(doc: EditorNode | null | undefined): { text: string; format: RichFormat } {
  const lines: { para: ParagraphFormat; pieces: { text: string; style: RunStyle }[] }[] = [];
  const newLine = (para: ParagraphFormat) => {
    const line = { para, pieces: [] as { text: string; style: RunStyle }[] };
    lines.push(line);
    return line;
  };

  const visitInline = (node: EditorNode, para: ParagraphFormat, state: { line: ReturnType<typeof newLine> }) => {
    if (node.type === "text" && typeof node.text === "string") {
      const style = styleFromMarks(node.marks);
      const parts = normalizeText(node.text).split("\n");
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

  let text = "";
  const runs: RunFormat[] = [];
  const push = (len: number, style: RunStyle) => {
    if (len <= 0) return;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.len += len;
    else runs.push({ len, ...style });
  };
  lines.forEach((line, idx) => {
    if (idx > 0) {
      const prev = lines[idx - 1].pieces;
      push(1, prev.length ? prev[prev.length - 1].style : {});
      text += "\n";
    }
    for (const piece of line.pieces) {
      text += piece.text;
      push(piece.text.length, piece.style);
    }
  });

  return { text, format: { v: 1, paragraphs: lines.map((l) => l.para), runs } };
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
        }
      : undefined
  ));

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
    runs.push(clean);
  }
  if (total !== text.length) return { ok: false, error: `format covers ${total} characters, text has ${text.length}` };
  return { ok: true, format: { v: 1, paragraphs, runs } };
}

// ── To Google Docs requests ─────────────────────────────────────────────────

export type DocsRequest = Record<string, unknown>;

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
    if (end <= start || this.format.runs.length === 0) return [];
    const requests: DocsRequest[] = [];

    // Paragraph styles, applied once: in the chunk that contains the paragraph's start.
    const firstPara = this.paragraphIndexAt(start);
    const lastPara = this.paragraphIndexAt(end - 1);
    for (let p = firstPara; p <= lastPara; p++) {
      const pStart = this.paraStarts[p];
      if (pStart < start || pStart >= end) continue;
      const pEnd = this.paraStarts[p + 1] ?? this.text.length;
      const segEnd = Math.min(end, Math.max(pEnd, pStart + 1));
      requests.push(paragraphRequest(this.format.paragraphs[p] ?? DEFAULT_PARAGRAPH, docIndex + pStart - start, docIndex + segEnd - start));
    }

    // Character styles, split at run and paragraph boundaries, merged when equal.
    let pending: { from: number; to: number; key: string; style: DocsRequest } | null = null;
    const flush = () => {
      if (pending) requests.push(textRequest(pending.style, docIndex + pending.from - start, docIndex + pending.to - start));
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
    return requests;
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
    const requests: DocsRequest[] = [];
    if (this.paraStarts[pi] === offset) requests.push(paragraphRequest(para, docIndex, docIndex + length));
    requests.push(textRequest(resolveTextStyle(this.format.runs[this.runIndexAt(at)], para), docIndex, docIndex + length));
    return requests;
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

function resolveTextStyle(run: RunFormat, para: ParagraphFormat): DocsRequest {
  return {
    bold: !!run.b,
    italic: !!run.i,
    underline: !!run.u,
    strikethrough: !!run.s,
    fontSize: { magnitude: run.size ?? NAMED_STYLES[para.style].size, unit: "PT" },
    weightedFontFamily: { fontFamily: run.font ?? DEFAULT_FONT, weight: 400 },
  };
}

function textRequest(textStyle: DocsRequest, startIndex: number, endIndex: number): DocsRequest {
  return {
    updateTextStyle: {
      range: { startIndex, endIndex },
      textStyle,
      fields: "bold,italic,underline,strikethrough,fontSize,weightedFontFamily",
    },
  };
}

function paragraphRequest(p: ParagraphFormat, startIndex: number, endIndex: number): DocsRequest {
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
      attrs: { styleName: p.style, textAlign: p.align === "left" ? null : p.align, indent: p.indent, firstLine: p.firstLine, lineSpacing: p.spacing },
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
      if (run.font || run.size) marks.push({ type: "textStyle", attrs: { fontFamily: run.font ?? null, fontSize: run.size ?? null } });
      node.content!.push(marks.length ? { type: "text", text: text.slice(at, segEnd), marks } : { type: "text", text: text.slice(at, segEnd) });
      at = segEnd;
    }
    content.push(node);
    pos = end + 1;
  });
  return { type: "doc", content };
}
