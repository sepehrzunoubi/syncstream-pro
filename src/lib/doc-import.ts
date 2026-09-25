/**
 * Read an existing Google Doc for display in the editor.
 *
 * The document's paragraphs become locked editor paragraphs: they look like
 * the doc but cannot be edited from SyncStream. Each one carries the anchors
 * a sync can be typed at: just before it or just after it.
 */

import type { docs_v1 } from "googleapis";
import { DEFAULT_FONT, NAMED_STYLES, OBJ, type Align, type EditorNode, type ListType, type NamedStyle } from "./rich-text";

type Doc = docs_v1.Schema$Document;
type Element = docs_v1.Schema$StructuralElement;
type TextStyle = docs_v1.Schema$TextStyle;
type ParagraphStyle = docs_v1.Schema$ParagraphStyle;

/**
 * Where a sync is typed, in the document as it was loaded.
 * "before": a new paragraph is opened at the start of the paragraph at `at`.
 * "after": a new paragraph is opened after the paragraph that ends at `at`.
 */
export interface Anchor {
  mode: "before" | "after";
  at: number;
}

export interface LockedAnchors {
  before: Anchor | null;
  after: Anchor | null;
}

export interface ImportedDoc {
  revisionId: string;
  /** True when the doc has no text, images or tables: the whole page is editable */
  empty: boolean;
  /** Locked paragraphs, in order */
  nodes: EditorNode[];
}

/**
 * The body as a string where position i holds the character at Docs index i.
 * Structural positions (section breaks, table boundaries, chips) hold "\0";
 * inline images hold the image placeholder, as in the source text.
 */
export function indexedText(doc: Doc): string {
  const content = doc.body?.content ?? [];
  const end = content[content.length - 1]?.endIndex ?? 1;
  const chars: string[] = new Array(end).fill("\0");
  const put = (start: number, s: string) => {
    for (let k = 0; k < s.length && start + k < end; k++) chars[start + k] = s[k];
  };
  const walk = (elements: Element[]) => {
    for (const el of elements) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) {
          const at = pe.startIndex ?? 0;
          if (pe.textRun?.content) put(at, pe.textRun.content);
          else if (pe.inlineObjectElement) put(at, OBJ);
        }
      } else if (el.table) {
        for (const row of el.table.tableRows ?? []) for (const cell of row.tableCells ?? []) walk(cell.content ?? []);
      } else if (el.tableOfContents) {
        walk(el.tableOfContents.content ?? []);
      }
    }
  };
  walk(content);
  return chars.join("");
}

const NAMED: Record<string, NamedStyle> = {
  NORMAL_TEXT: "normal",
  TITLE: "title",
  SUBTITLE: "subtitle",
  HEADING_1: "h1",
  HEADING_2: "h2",
  HEADING_3: "h3",
  HEADING_4: "h3",
  HEADING_5: "h3",
  HEADING_6: "h3",
};
const ALIGN: Record<string, Align | null> = { START: null, CENTER: "center", END: "right", JUSTIFIED: "justify" };
const ORDERED = new Set(["DECIMAL", "ZERO_DECIMAL", "UPPER_ALPHA", "ALPHA", "UPPER_ROMAN", "ROMAN"]);

function pt(d: docs_v1.Schema$Dimension | undefined | null): number | undefined {
  if (!d) return undefined;
  const m = d.magnitude ?? 0;
  return d.unit === "PT" || !d.unit ? m : undefined;
}

function hex(c: docs_v1.Schema$OptionalColor | undefined | null): string | undefined {
  const rgb = c?.color?.rgbColor;
  if (!rgb) return undefined;
  const h = (v: number | null | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${h(rgb.red)}${h(rgb.green)}${h(rgb.blue)}`;
}

function roman(n: number): string {
  const table: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

function alpha(n: number): string {
  let out = "";
  while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

function glyphNumber(n: number, type: string | null | undefined): string {
  switch (type) {
    case "ZERO_DECIMAL": return n < 10 ? `0${n}` : String(n);
    case "ALPHA": return alpha(n);
    case "UPPER_ALPHA": return alpha(n).toUpperCase();
    case "ROMAN": return roman(n);
    case "UPPER_ROMAN": return roman(n).toUpperCase();
    default: return String(n);
  }
}

/** Numbering state of every list, so labels continue across interrupted items like in Docs */
class ListCounters {
  private counts = new Map<string, number[]>();
  constructor(private readonly lists: Doc["lists"]) {}

  label(bullet: docs_v1.Schema$Bullet): { type: ListType; label: string | null; level: docs_v1.Schema$NestingLevel | undefined } {
    const listId = bullet.listId ?? "";
    const levelIdx = bullet.nestingLevel ?? 0;
    const levels = this.lists?.[listId]?.listProperties?.nestingLevels ?? [];
    const level = levels[levelIdx];
    const counts = this.counts.get(listId) ?? [];
    counts[levelIdx] = (counts[levelIdx] ?? (levels[levelIdx]?.startNumber ?? 1) - 1) + 1;
    counts.length = levelIdx + 1; // deeper levels restart
    this.counts.set(listId, counts);

    if (level?.glyphSymbol) return { type: "bullet", label: level.glyphSymbol, level };
    if (level?.glyphType && ORDERED.has(level.glyphType)) {
      const format = level.glyphFormat || `%${levelIdx}.`;
      const label = format.replace(/%(\d)/g, (_, d: string) => {
        const k = Number(d);
        return glyphNumber(counts[k] ?? levels[k]?.startNumber ?? 1, levels[k]?.glyphType);
      });
      return { type: "ordered", label, level };
    }
    if (level?.glyphType === "NONE") return { type: "bullet", label: "", level };
    // Checklists report no glyph; our checklist style draws the box
    return { type: "check", label: null, level };
  }
}

function textMarks(ts: TextStyle, style: NamedStyle): NonNullable<EditorNode["marks"]> {
  const marks: NonNullable<EditorNode["marks"]> = [];
  if (ts.bold) marks.push({ type: "bold" });
  if (ts.italic) marks.push({ type: "italic" });
  if (ts.underline) marks.push({ type: "underline" });
  if (ts.strikethrough) marks.push({ type: "strike" });
  if (ts.link?.url) marks.push({ type: "link", attrs: { href: ts.link.url } });
  const bg = hex(ts.backgroundColor);
  if (bg && bg !== "#ffffff") marks.push({ type: "highlight", attrs: { color: bg } });
  const font = ts.weightedFontFamily?.fontFamily ?? undefined;
  const size = pt(ts.fontSize);
  const color = hex(ts.foregroundColor);
  const attrs = {
    fontFamily: font && font !== DEFAULT_FONT ? font : null,
    fontSize: size && size !== NAMED_STYLES[style].size ? size : null,
    color: color && color !== "#000000" ? color : null,
  };
  if (attrs.fontFamily || attrs.fontSize || attrs.color) marks.push({ type: "textStyle", attrs });
  return marks;
}

function textNode(text: string, marks: NonNullable<EditorNode["marks"]>): EditorNode {
  return marks.length ? { type: "text", text, marks } : { type: "text", text };
}

/** Read a documents.get response into locked editor paragraphs. */
export function importDoc(doc: Doc): ImportedDoc {
  const namedStyles = new Map<string, docs_v1.Schema$NamedStyle>();
  for (const s of doc.namedStyles?.styles ?? []) if (s.namedStyleType) namedStyles.set(s.namedStyleType, s);
  const counters = new ListCounters(doc.lists);
  let hasContent = false;

  const paragraphNode = (p: docs_v1.Schema$Paragraph): EditorNode => {
    const own: ParagraphStyle = p.paragraphStyle ?? {};
    const namedType = own.namedStyleType ?? "NORMAL_TEXT";
    const named = namedStyles.get(namedType);
    const ps: ParagraphStyle = { ...(named?.paragraphStyle ?? {}), ...stripNull(own) };
    const style = NAMED[namedType] ?? "normal";
    const baseText: TextStyle = named?.textStyle ?? {};

    let list: ListType | null = null;
    let label: string | null = null;
    let start = pt(ps.indentStart) ?? 0;
    let first = pt(ps.indentFirstLine) ?? start;
    if (p.bullet) {
      const info = counters.label(p.bullet);
      list = info.type;
      label = info.label;
      if (own.indentStart == null && info.level?.indentStart) start = pt(info.level.indentStart) ?? start;
      if (own.indentFirstLine == null && info.level?.indentFirstLine) first = pt(info.level.indentFirstLine) ?? first;
    }

    const content: EditorNode[] = [];
    for (const pe of p.elements ?? []) {
      if (pe.textRun?.content != null) {
        const ts = { ...baseText, ...stripNull(pe.textRun.textStyle ?? {}) };
        const marks = textMarks(ts, style);
        const text = pe.textRun.content.replace(/\n$/, "");
        text.split("\u000b").forEach((part, i) => {
          if (i > 0) content.push({ type: "hardBreak" });
          if (part) content.push(textNode(part, marks));
        });
        if (text.trim()) hasContent = true;
      } else if (pe.inlineObjectElement?.inlineObjectId) {
        const obj = doc.inlineObjects?.[pe.inlineObjectElement.inlineObjectId]?.inlineObjectProperties?.embeddedObject;
        const src = obj?.imageProperties?.contentUri;
        if (src) {
          const w = pt(obj?.size?.width);
          const h = pt(obj?.size?.height);
          content.push({ type: "image", attrs: { src, width: w ? Math.round(w / 0.75) : null, height: h ? Math.round(h / 0.75) : null } });
          hasContent = true;
        }
      } else if (pe.person?.personProperties) {
        const who = pe.person.personProperties;
        content.push(textNode(who.name || who.email || "", [{ type: "textStyle", attrs: { fontFamily: null, fontSize: null, color: "#1155cc" } }]));
        hasContent = true;
      } else if (pe.richLink?.richLinkProperties) {
        const rl = pe.richLink.richLinkProperties;
        content.push(textNode(rl.title || rl.uri || "link", rl.uri ? [{ type: "link", attrs: { href: rl.uri } }] : []));
        hasContent = true;
      }
    }

    const box = list
      ? { start, marker: first - start }
      : { start, first: first - start };
    const above = pt(ps.spaceAbove);
    const below = pt(ps.spaceBelow);
    return {
      type: "paragraph",
      attrs: {
        styleName: style,
        textAlign: ALIGN[ps.alignment ?? "START"] ?? null,
        indent: 0,
        firstLine: false,
        lineSpacing: ps.lineSpacing ? Math.round(ps.lineSpacing) : 115,
        list,
        locked: true,
        label,
        box: { ...box, above: above ?? null, below: below ?? null },
        anchors: null,
      },
      content,
    };
  };

  type Unit = { kind: "p"; start: number; end: number; node: EditorNode } | { kind: "block"; nodes: EditorNode[] };
  const units: Unit[] = [];
  const cellParagraphs = (elements: Element[], out: EditorNode[]) => {
    for (const el of elements) {
      if (el.paragraph) out.push(paragraphNode(el.paragraph));
      else if (el.table) for (const row of el.table.tableRows ?? []) for (const cell of row.tableCells ?? []) cellParagraphs(cell.content ?? [], out);
      else if (el.tableOfContents) cellParagraphs(el.tableOfContents.content ?? [], out);
    }
  };
  for (const el of doc.body?.content ?? []) {
    if (el.paragraph) {
      units.push({ kind: "p", start: el.startIndex ?? 0, end: el.endIndex ?? 0, node: paragraphNode(el.paragraph) });
    } else if (el.table || el.tableOfContents) {
      const nodes: EditorNode[] = [];
      cellParagraphs([el], nodes);
      if (el.table) hasContent = true;
      units.push({ kind: "block", nodes });
    }
  }

  const nodes: EditorNode[] = [];
  units.forEach((u, i) => {
    if (u.kind === "p") {
      u.node.attrs!.anchors = { before: { mode: "before", at: u.start }, after: { mode: "after", at: u.end } } satisfies LockedAnchors;
      nodes.push(u.node);
      return;
    }
    // Inside a table or table of contents a sync can only go around it
    const prev = units[i - 1];
    const next = units[i + 1];
    const anchors: LockedAnchors = {
      before: prev?.kind === "p" ? { mode: "after", at: prev.end } : null,
      after: next?.kind === "p" ? { mode: "before", at: next.start } : null,
    };
    for (const n of u.nodes) {
      n.attrs!.anchors = anchors;
      nodes.push(n);
    }
  });

  return { revisionId: doc.revisionId ?? "", empty: !hasContent, nodes: hasContent ? nodes : [] };
}

function stripNull<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v != null) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Check an anchor against the document text and return where typing starts. */
export function anchorPosition(chars: string, anchor: Anchor): number | null {
  const { mode, at } = anchor;
  if (!Number.isInteger(at) || at < 1 || at > chars.length) return null;
  if (mode === "after") {
    // Right after a paragraph's newline
    return chars[at - 1] === "\n" ? at : null;
  }
  // At the start of a paragraph: after a newline or a structural position
  if (at >= chars.length) return null;
  const prev = chars[at - 1];
  return prev === "\n" || prev === "\0" ? at : null;
}
