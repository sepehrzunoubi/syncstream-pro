/**
 * Read an existing Google Doc into the editor.
 *
 * Paragraphs become ordinary editor paragraphs that keep the document's
 * look. What the editor can't change faithfully (tables, section breaks,
 * paragraphs with smart chips or drawings) becomes locked paragraphs that
 * are shown but can't be edited; each carries how many Docs indices it
 * covers (`span`) so indices of everything after it stay right.
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

export interface ImportedDoc {
  revisionId: string;
  /** True when the doc has no text, images or tables */
  empty: boolean;
  /** The document's paragraphs, in order */
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

/** The kind of list a bullet belongs to, and what Docs draws for its level */
function listInfo(lists: Doc["lists"], bullet: docs_v1.Schema$Bullet) {
  const levelIdx = bullet.nestingLevel ?? 0;
  const level = lists?.[bullet.listId ?? ""]?.listProperties?.nestingLevels?.[levelIdx];
  const type: ListType = level?.glyphSymbol ? "bullet" : level?.glyphType && ORDERED.has(level.glyphType) ? "ordered" : level?.glyphType === "NONE" ? "bullet" : "check";
  return {
    type,
    level,
    attrs: {
      listId: bullet.listId ?? null,
      level: levelIdx,
      glyph: { type: level?.glyphType ?? null, format: level?.glyphFormat ?? null, symbol: level?.glyphSymbol ?? null, start: level?.startNumber ?? null },
    },
  };
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
  // The editor rejects empty text nodes, so a nameless chip shows as a space
  const t = text || " ";
  return marks.length ? { type: "text", text: t, marks } : { type: "text", text: t };
}

/** Plain text of a paragraph, for showing one that couldn't be read properly */
function plainText(p: docs_v1.Schema$Paragraph | undefined): string {
  return (p?.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/[\n\u000b]/g, " ").trim();
}

/** Read a documents.get response into editor paragraphs. */
export function importDoc(doc: Doc): ImportedDoc {
  let blockId = 0;
  const lock = (node: EditorNode, span: number) => {
    node.attrs = { ...node.attrs, locked: true, span, bid: `b${++blockId}` };
    return node;
  };
  const namedStyles = new Map<string, docs_v1.Schema$NamedStyle>();
  for (const s of doc.namedStyles?.styles ?? []) if (s.namedStyleType) namedStyles.set(s.namedStyleType, s);
  let hasContent = false;

  const paragraphNode = (p: docs_v1.Schema$Paragraph): EditorNode => {
    const own: ParagraphStyle = p.paragraphStyle ?? {};
    const namedType = own.namedStyleType ?? "NORMAL_TEXT";
    const named = namedStyles.get(namedType);
    const ps: ParagraphStyle = { ...(named?.paragraphStyle ?? {}), ...stripNull(own) };
    const style = NAMED[namedType] ?? "normal";
    const baseText: TextStyle = named?.textStyle ?? {};

    let list: ListType | null = null;
    let listAttrs: Record<string, unknown> = {};
    let start = pt(ps.indentStart) ?? 0;
    let first = pt(ps.indentFirstLine) ?? start;
    if (p.bullet) {
      const info = listInfo(doc.lists, p.bullet);
      list = info.type;
      listAttrs = info.attrs;
      if (own.indentStart == null && info.level?.indentStart) start = pt(info.level.indentStart) ?? start;
      if (own.indentFirstLine == null && info.level?.indentFirstLine) first = pt(info.level.indentFirstLine) ?? first;
    }

    const content: EditorNode[] = [];
    let unsupported = false;
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
        } else unsupported = true;
      } else if (pe.person?.personProperties) {
        const who = pe.person.personProperties;
        content.push(textNode(who.name || who.email || "", [{ type: "textStyle", attrs: { fontFamily: null, fontSize: null, color: "#1155cc" } }]));
        hasContent = true;
        unsupported = true;
      } else if (pe.richLink?.richLinkProperties) {
        const rl = pe.richLink.richLinkProperties;
        content.push(textNode(rl.title || rl.uri || "link", rl.uri ? [{ type: "link", attrs: { href: rl.uri } }] : []));
        hasContent = true;
        unsupported = true;
      } else if (!pe.textRun) {
        // Page breaks, footnote references, equations and the like: shown, not editable
        unsupported = true;
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
        ...listAttrs,
        box: { ...box, above: above ?? null, below: below ?? null },
        ...(unsupported ? { locked: true } : {}),
      },
      content,
    };
  };

  const cellParagraphs = (elements: Element[], out: EditorNode[]) => {
    for (const el of elements) {
      if (el.paragraph) out.push(paragraphNode(el.paragraph));
      else if (el.table) for (const row of el.table.tableRows ?? []) for (const cell of row.tableCells ?? []) cellParagraphs(cell.content ?? [], out);
      else if (el.tableOfContents) cellParagraphs(el.tableOfContents.content ?? [], out);
    }
  };
  const nodes: EditorNode[] = [];
  const content = doc.body?.content ?? [];
  content.forEach((el, i) => {
    const size = (el.endIndex ?? 0) - (el.startIndex ?? 0);
    try {
      addElement(el, i, size);
    } catch (err) {
      // One element Docs describes in a way we don't expect shouldn't hide the whole document
      console.error("Couldn't read a document element:", err);
      const text = plainText(el.paragraph ?? undefined);
      nodes.push(lock({ type: "paragraph", attrs: {}, content: text ? [{ type: "text", text }] : [] }, size));
    }
  });
  function addElement(el: Element, i: number, size: number) {
    if (el.paragraph) {
      const node = paragraphNode(el.paragraph);
      nodes.push(node.attrs?.locked ? lock(node, size) : node);
    } else if (el.table || el.tableOfContents) {
      // Shown cell by cell; the first carries the whole table's size
      const cells: EditorNode[] = [];
      cellParagraphs([el], cells);
      if (el.table) hasContent = true;
      if (!cells.length) cells.push({ type: "paragraph", attrs: {}, content: [] });
      cells.forEach((c, k) => nodes.push(lock(c, k === 0 ? size : 0)));
    } else if (el.sectionBreak && i > 0) {
      nodes.push(lock({ type: "paragraph", attrs: { kind: "section" }, content: [] }, size));
    }
  }

  if (!nodes.length) nodes.push({ type: "paragraph", attrs: {}, content: [] });
  return { revisionId: doc.revisionId ?? "", empty: !hasContent, nodes };
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
