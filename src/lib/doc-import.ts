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
import { pageSetupFromDocumentStyle, type PageSetup } from "./page-setup";
import { BORDER_SIDES, DEFAULT_FONT, NAMED_STYLES, OBJ, PAGE_BREAK, type Align, type Border, type Borders, type EditorNode, type KeepOptions, type ListType, type NamedStyle } from "./rich-text";

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

/** A header, footer or footnote: its Docs segment id and paragraphs */
export interface ImportedSegment { id: string; nodes: EditorNode[] }

/** What the document's own named styles give text that sets nothing itself */
export interface DocDefaults {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  /** Per paragraph style: size, font and colour when the document's named style sets them */
  styles: Partial<Record<NamedStyle, { fontSize?: number; fontFamily?: string; color?: string }>>;
}

export interface ImportedDoc {
  revisionId: string;
  /** Fonts and sizes of the document's named styles */
  defaults: DocDefaults;
  /** Paper size, margins and colour, from the document's style */
  pageSetup: PageSetup;
  /** Headers and footers, when the document has them */
  header?: ImportedSegment;
  footer?: ImportedSegment;
  firstPageHeader?: ImportedSegment;
  firstPageFooter?: ImportedSegment;
  /** Docs' "Different first page" */
  useFirstPage: boolean;
  /** Distance of the header and footer from the page edge, in points */
  marginHeader: number;
  marginFooter: number;
  /** Footnotes, keyed by id */
  footnotes: Record<string, ImportedSegment>;
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
          else if (pe.pageBreak) put(at, PAGE_BREAK);
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
  HEADING_4: "h4",
  HEADING_5: "h5",
  HEADING_6: "h6",
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

function textMarks(ts: TextStyle, style: NamedStyle, defaults: DocDefaults): NonNullable<EditorNode["marks"]> {
  const marks: NonNullable<EditorNode["marks"]> = [];
  if (ts.bold) marks.push({ type: "bold" });
  if (ts.smallCaps) marks.push({ type: "smallCaps" });
  if (ts.italic) marks.push({ type: "italic" });
  if (ts.underline) marks.push({ type: "underline" });
  if (ts.strikethrough) marks.push({ type: "strike" });
  if (ts.baselineOffset === "SUPERSCRIPT") marks.push({ type: "superscript" });
  if (ts.baselineOffset === "SUBSCRIPT") marks.push({ type: "subscript" });
  if (ts.link?.url) marks.push({ type: "link", attrs: { href: ts.link.url } });
  const bg = hex(ts.backgroundColor);
  if (bg && bg !== "#ffffff") marks.push({ type: "highlight", attrs: { color: bg } });
  const font = ts.weightedFontFamily?.fontFamily ?? undefined;
  const size = pt(ts.fontSize);
  const color = hex(ts.foregroundColor);
  // A value the paragraph's named style already gives is not a mark: the editor shows the
  // document's defaults itself, and text with no mark is written to Docs without an explicit value
  const own = defaults.styles[style] ?? {};
  const styleFont = own.fontFamily ?? defaults.fontFamily;
  const styleSize = own.fontSize ?? (style === "normal" ? defaults.fontSize : NAMED_STYLES[style].size);
  const styleColor = own.color ?? "#000000";
  const attrs = {
    fontFamily: font && font !== styleFont ? font : null,
    fontSize: size && size !== styleSize ? size : null,
    color: color && color !== styleColor ? color : null,
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

/** The fonts and sizes the document's named styles give text that sets none itself */
function docDefaults(namedStyles: Map<string, docs_v1.Schema$NamedStyle>): DocDefaults {
  const normal = namedStyles.get("NORMAL_TEXT");
  const nt = normal?.textStyle ?? {};
  const styles: DocDefaults["styles"] = {};
  for (const [docsName, name] of Object.entries(NAMED)) {
    if (docsName === "NORMAL_TEXT") continue;
    const ts = namedStyles.get(docsName)?.textStyle ?? {};
    const entry: { fontSize?: number; fontFamily?: string; color?: string } = {};
    const size = pt(ts.fontSize);
    if (size) entry.fontSize = size;
    if (ts.weightedFontFamily?.fontFamily) entry.fontFamily = ts.weightedFontFamily.fontFamily;
    const color = hex(ts.foregroundColor);
    if (color) entry.color = color;
    if (Object.keys(entry).length) styles[name] = entry;
  }
  return {
    fontFamily: nt.weightedFontFamily?.fontFamily ?? DEFAULT_FONT,
    fontSize: pt(nt.fontSize) ?? NAMED_STYLES.normal.size,
    lineSpacing: normal?.paragraphStyle?.lineSpacing ? Math.round(normal.paragraphStyle.lineSpacing) : 115,
    styles,
  };
}

export function importDoc(doc: Doc): ImportedDoc {
  let blockId = 0;
  const lock = (node: EditorNode, span: number) => {
    node.attrs = { ...node.attrs, locked: true, span, bid: `b${++blockId}` };
    return node;
  };
  const namedStyles = new Map<string, docs_v1.Schema$NamedStyle>();
  for (const s of doc.namedStyles?.styles ?? []) if (s.namedStyleType) namedStyles.set(s.namedStyleType, s);
  const defaults = docDefaults(namedStyles);
  let hasContent = false;

  const paragraphNode = (p: docs_v1.Schema$Paragraph): EditorNode => {
    const own: ParagraphStyle = p.paragraphStyle ?? {};
    const namedType = own.namedStyleType ?? "NORMAL_TEXT";
    const named = namedStyles.get(namedType);
    const normal = namedStyles.get("NORMAL_TEXT");
    // Docs resolves a paragraph as: its own fields, then its named style, then Normal text
    const ps: ParagraphStyle = {
      ...stripNull(normal?.paragraphStyle ?? {}),
      ...(namedType !== "NORMAL_TEXT" ? stripNull(named?.paragraphStyle ?? {}) : {}),
      ...stripNull(own),
    };
    const style = NAMED[namedType] ?? "normal";
    const baseText: TextStyle = {
      ...stripNull(normal?.textStyle ?? {}),
      ...(namedType !== "NORMAL_TEXT" ? stripNull(named?.textStyle ?? {}) : {}),
    };

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
    let rule = false;
    for (const pe of p.elements ?? []) {
      if (pe.textRun?.content != null) {
        const ts = { ...baseText, ...stripNull(pe.textRun.textStyle ?? {}) };
        const marks = textMarks(ts, style, defaults);
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
      } else if (pe.pageBreak) {
        content.push({ type: "pageBreak" });
      } else if (pe.footnoteReference?.footnoteId) {
        content.push({ type: "footnoteRef", attrs: { fid: pe.footnoteReference.footnoteId, n: pe.footnoteReference.footnoteNumber ?? null } });
        hasContent = true;
      } else if (pe.horizontalRule) {
        // Docs draws a line across the paragraph; the paragraph itself stays read-only here
        rule = true;
        unsupported = true;
      } else if (!pe.textRun) {
        // Equations, chips and the like: shown, not editable
        unsupported = true;
      }
    }

    const box = list
      ? { start, marker: first - start }
      : { start, first: first - start };
    const above = pt(ps.spaceAbove);
    const below = pt(ps.spaceBelow);
    // Keep options as Docs has them (its own default for single lines is on)
    const keep: KeepOptions = {};
    if (ps.keepWithNext) keep.withNext = true;
    if (ps.keepLinesTogether) keep.linesTogether = true;
    if (ps.avoidWidowAndOrphan === false) keep.singleLines = false;
    const borders: Borders = {};
    const sides = { top: ps.borderTop, bottom: ps.borderBottom, left: ps.borderLeft, right: ps.borderRight, between: ps.borderBetween };
    for (const side of BORDER_SIDES) {
      const b = sides[side];
      const width = pt(b?.width) ?? 0;
      if (!b || width <= 0) continue;
      const border: Border = { width, color: hex(b.color) ?? "#000000", dash: b.dashStyle === "DOT" || b.dashStyle === "DASH" ? b.dashStyle : "SOLID", padding: pt(b.padding) ?? 0 };
      borders[side] = border;
    }
    const shading = hex(ps.shading?.backgroundColor);
    return {
      type: "paragraph",
      attrs: {
        styleName: style,
        textAlign: ALIGN[ps.alignment ?? "START"] ?? null,
        ...(rule ? { kind: "rule" } : {}),
        indent: 0,
        firstLine: false,
        lineSpacing: ps.lineSpacing ? Math.round(ps.lineSpacing) : 115,
        list,
        ...listAttrs,
        indentEnd: pt(ps.indentEnd) || null,
        box: { ...box, above: above ?? null, below: below ?? null },
        keep: Object.keys(keep).length ? keep : null,
        borders: Object.keys(borders).length ? borders : null,
        shading: shading && shading !== "#ffffff" ? shading : null,
        ...(unsupported ? { locked: true } : {}),
      },
      content,
    };
  };

  /**
   * A table as editable rows and cells. The Docs indices between one piece
   * of content and the next (table, row and cell starts and ends) are kept
   * as spans on the cell that follows them, or on the table's end, so the
   * index of everything after the table stays right whatever Docs puts
   * between cells.
   */
  const tableNode = (el: Element, tid: string): EditorNode => {
    const table = el.table!;
    const widths = (table.tableStyle?.tableColumnProperties ?? []).map((c) => pt(c.width));
    // The index just after the last content read so far
    let cursor = el.startIndex ?? 0;
    const rowNodes: EditorNode[] = (table.tableRows ?? []).map((row, r) => {
      const cellNodes: EditorNode[] = (row.tableCells ?? []).map((cell, c) => {
        const content: EditorNode[] = [];
        const firstContent = cell.content?.[0]?.startIndex ?? (cell.startIndex ?? cursor) + 1;
        const span = Math.max(0, firstContent - cursor);
        cursor = firstContent;
        for (const inner of cell.content ?? []) {
          if (inner.paragraph) content.push(paragraphNode(inner.paragraph));
          else if (inner.table) {
            // A table inside a table: shown, not editable
            const flat: EditorNode[] = [];
            cellParagraphs([inner], flat);
            flat.forEach((p, k) => content.push(lock(p, k === 0 ? (inner.endIndex ?? 0) - (inner.startIndex ?? 0) : 0)));
          }
          cursor = inner.endIndex ?? cursor;
        }
        if (!content.length) { content.push({ type: "paragraph", attrs: {}, content: [] }); cursor = firstContent + 1; }
        const style = cell.tableCellStyle ?? {};
        const bg = hex(style.backgroundColor);
        return {
          type: "tableCell",
          attrs: {
            cid: `${tid}c${c}`,
            span,
            colspan: style.columnSpan ?? 1,
            rowspan: style.rowSpan ?? 1,
            colwidth: widths[c] ? [Math.round(widths[c]! / 0.75)] : null,
            background: bg && bg !== "#ffffff" ? bg : null,
          },
          content,
        };
      });
      return { type: "tableRow", attrs: { rid: `${tid}r${r}`, span: 0 }, content: cellNodes };
    });
    return { type: "table", attrs: { tid, span: 0, endSpan: Math.max(0, (el.endIndex ?? cursor) - cursor) }, content: rowNodes };
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
    } else if (el.table) {
      nodes.push(tableNode(el, `t${++blockId}`));
      hasContent = true;
    } else if (el.tableOfContents) {
      // Shown cell by cell; the first carries the whole table's size
      const cells: EditorNode[] = [];
      cellParagraphs([el], cells);
      if (!cells.length) cells.push({ type: "paragraph", attrs: {}, content: [] });
      cells.forEach((c, k) => nodes.push(lock(c, k === 0 ? size : 0)));
    } else if (el.sectionBreak) {
      const style = el.sectionBreak.sectionStyle ?? {};
      const cols = style.columnProperties ?? [];
      const columns = Math.max(1, cols.length);
      const spacing = columns > 1 ? pt(cols[0]?.paddingEnd) ?? 36 : 36;
      const line = style.columnSeparatorStyle === "BETWEEN_EACH_COLUMN";
      const sectionType = style.sectionType === "CONTINUOUS" ? "continuous" : "next";
      // The document's first section break is index 0, which the body's indices already start after:
      // it only needs a (hidden) marker when it lays its section out in columns
      if (i === 0) { if (columns > 1) nodes.push(lock({ type: "paragraph", attrs: { kind: "section", first: true, sectionType, columns, spacing, line }, content: [] }, 0)); }
      else nodes.push(lock({ type: "paragraph", attrs: { kind: "section", sectionType, columns, spacing, line }, content: [] }, size));
    }
  }

  if (!nodes.length) nodes.push({ type: "paragraph", attrs: {}, content: [] });

  // Headers, footers and footnotes: paragraphs of their own, read the same way
  const segment = (id: string | null | undefined, content: Element[] | undefined): ImportedSegment | undefined => {
    if (!id) return undefined;
    const out: EditorNode[] = [];
    for (const el of content ?? []) {
      if (el.paragraph) { const node = paragraphNode(el.paragraph); out.push(node.attrs?.locked ? lock(node, (el.endIndex ?? 0) - (el.startIndex ?? 0)) : node); }
      else if (el.table) out.push(tableNode(el, `t${++blockId}`));
    }
    if (!out.length) out.push({ type: "paragraph", attrs: {}, content: [] });
    return { id, nodes: out };
  };
  const ds = doc.documentStyle ?? {};
  const footnotes: Record<string, ImportedSegment> = {};
  for (const [id, fn] of Object.entries(doc.footnotes ?? {})) { const seg = segment(id, fn.content ?? undefined); if (seg) footnotes[id] = seg; }
  return {
    revisionId: doc.revisionId ?? "",
    defaults,
    pageSetup: pageSetupFromDocumentStyle(doc.documentStyle),
    header: segment(ds.defaultHeaderId, doc.headers?.[ds.defaultHeaderId ?? ""]?.content ?? undefined),
    footer: segment(ds.defaultFooterId, doc.footers?.[ds.defaultFooterId ?? ""]?.content ?? undefined),
    firstPageHeader: segment(ds.firstPageHeaderId, doc.headers?.[ds.firstPageHeaderId ?? ""]?.content ?? undefined),
    firstPageFooter: segment(ds.firstPageFooterId, doc.footers?.[ds.firstPageFooterId ?? ""]?.content ?? undefined),
    useFirstPage: ds.useFirstPageHeaderFooter === true,
    marginHeader: pt(ds.marginHeader) ?? 36,
    marginFooter: pt(ds.marginFooter) ?? 36,
    footnotes,
    empty: !hasContent,
    nodes,
  };
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
