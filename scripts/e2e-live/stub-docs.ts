/**
 * An in-memory Google Docs, for dry runs and tests.
 *
 * One item per Docs index: the section break at 0, characters, page
 * breaks, paragraph ends (which carry the paragraph's style and bullet, as
 * the newline does in Docs) and table structure (table, row and cell starts
 * and the table's end, one index each). documents.get is rebuilt from the
 * items in the shape Google returns; batchUpdate applies the requests the
 * app uses with the rules the Docs API documents: inserted text takes the
 * style of its neighbour, a typed newline copies the paragraph's style and
 * bullet, a page break brings its own newline, a table is preceded by a
 * newline, leading tabs set bullet levels and disappear, the final newline
 * and the newline before a table cannot be deleted, and a batch sent for an
 * old revision is refused. Inline images (one index each, kept as
 * inlineObjects with their address and size), footnotes (a reference of one
 * index in the body; the footnote itself a segment that starts as a space and
 * a newline), the document's header and footer, and its page style are
 * modelled too: a request with a segmentId writes to that header, footer or
 * footnote, whose indices start at 0.
 */

import type { docs_v1 } from "googleapis";
import type { E2EDocs } from "./docs-client";

type TextStyle = docs_v1.Schema$TextStyle;
type ParagraphStyle = docs_v1.Schema$ParagraphStyle;
interface Bullet { listId: string; nestingLevel: number }

type Item =
  | { k: "sb" }
  | { k: "c"; ch: string; ts: TextStyle }
  | { k: "pb"; ts: TextStyle }
  | { k: "img"; id: string; ts: TextStyle }
  | { k: "fn"; id: string; ts: TextStyle }
  | { k: "nl"; ts: TextStyle; ps: ParagraphStyle; bullet?: Bullet }
  | { k: "tbl"; columns: number; widths?: docs_v1.Schema$TableColumnProperties[] }
  | { k: "row" }
  | { k: "cell"; style?: docs_v1.Schema$TableCellStyle; covered?: boolean }
  | { k: "tend" };

const STRUCTURAL = new Set(["sb", "tbl", "row", "cell", "tend"]);
const clone = <T>(v: T): T => structuredClone(v);

export class DocsApiError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
  }
}
const bad = (message: string) => new DocsApiError(message, 400);

const BULLET_GLYPHS = ["●", "○", "■"];
const NUMBER_GLYPHS: [string, string][] = [["DECIMAL", "%0."], ["ALPHA", "%1."], ["ROMAN", "%2."]];

function listFor(preset: string): docs_v1.Schema$List {
  const nestingLevels: docs_v1.Schema$NestingLevel[] = [];
  for (let l = 0; l < 9; l++) {
    const indent = { indentFirstLine: { magnitude: 18 + 36 * l, unit: "PT" }, indentStart: { magnitude: 36 * (l + 1), unit: "PT" } };
    if (preset === "BULLET_CHECKBOX") nestingLevels.push({ glyphSymbol: "☐", ...indent });
    else if (preset.startsWith("BULLET")) nestingLevels.push({ glyphSymbol: BULLET_GLYPHS[l % 3], ...indent });
    else {
      const [glyphType, glyphFormat] = NUMBER_GLYPHS[l % 3];
      nestingLevels.push({ glyphType, glyphFormat, startNumber: 1, ...indent });
    }
  }
  return { listProperties: { nestingLevels } };
}

const NAMED_STYLES: docs_v1.Schema$NamedStyle[] = [
  { namedStyleType: "NORMAL_TEXT", textStyle: { fontSize: { magnitude: 11, unit: "PT" }, weightedFontFamily: { fontFamily: "Arial", weight: 400 } }, paragraphStyle: { lineSpacing: 115, namedStyleType: "NORMAL_TEXT" } },
  { namedStyleType: "TITLE", textStyle: { fontSize: { magnitude: 26, unit: "PT" } }, paragraphStyle: {} },
  { namedStyleType: "SUBTITLE", textStyle: { fontSize: { magnitude: 15, unit: "PT" }, foregroundColor: { color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } } } }, paragraphStyle: {} },
  { namedStyleType: "HEADING_1", textStyle: { fontSize: { magnitude: 20, unit: "PT" } }, paragraphStyle: { keepWithNext: true } },
  { namedStyleType: "HEADING_2", textStyle: { fontSize: { magnitude: 16, unit: "PT" } }, paragraphStyle: { keepWithNext: true } },
  { namedStyleType: "HEADING_3", textStyle: { fontSize: { magnitude: 14, unit: "PT" }, foregroundColor: { color: { rgbColor: { red: 0.26, green: 0.26, blue: 0.26 } } } }, paragraphStyle: { keepWithNext: true } },
  { namedStyleType: "HEADING_4", textStyle: { fontSize: { magnitude: 12, unit: "PT" } }, paragraphStyle: { keepWithNext: true } },
  { namedStyleType: "HEADING_5", textStyle: { fontSize: { magnitude: 11, unit: "PT" } }, paragraphStyle: { keepWithNext: true } },
  { namedStyleType: "HEADING_6", textStyle: { fontSize: { magnitude: 11, unit: "PT" }, italic: true }, paragraphStyle: { keepWithNext: true } },
];

interface Location { index: number; segmentId?: string }
interface Request {
  insertText?: { location: Location; text: string };
  insertPageBreak?: { location: Location };
  insertTable?: { rows: number; columns: number; location: Location };
  insertInlineImage?: { location: Location; uri: string; objectSize?: docs_v1.Schema$Size };
  createFootnote?: { location: Location };
  createHeader?: { type?: string; sectionBreakLocation?: Location };
  createFooter?: { type?: string; sectionBreakLocation?: Location };
  deleteHeader?: { headerId: string };
  deleteFooter?: { footerId: string };
  updateDocumentStyle?: { documentStyle: docs_v1.Schema$DocumentStyle; fields: string };
  deleteContentRange?: { range: { startIndex: number; endIndex: number } };
  updateTextStyle?: { range: { startIndex: number; endIndex: number }; textStyle: TextStyle; fields: string };
  updateParagraphStyle?: { range: { startIndex: number; endIndex: number }; paragraphStyle: ParagraphStyle; fields: string };
  createParagraphBullets?: { range: { startIndex: number; endIndex: number }; bulletPreset: string };
  deleteParagraphBullets?: { range: { startIndex: number; endIndex: number } };
  updateTableCellStyle?: docs_v1.Schema$UpdateTableCellStyleRequest;
  mergeTableCells?: docs_v1.Schema$MergeTableCellsRequest;
  unmergeTableCells?: docs_v1.Schema$UnmergeTableCellsRequest;
  updateTableColumnProperties?: docs_v1.Schema$UpdateTableColumnPropertiesRequest;
  insertTableRow?: docs_v1.Schema$InsertTableRowRequest;
  deleteTableRow?: docs_v1.Schema$DeleteTableRowRequest;
  insertTableColumn?: docs_v1.Schema$InsertTableColumnRequest;
  deleteTableColumn?: docs_v1.Schema$DeleteTableColumnRequest;
}

/** A header, footer or footnote: its items after a stand-in for the body's section break, so its index i is item i + 1 */
interface Segment { kind: "header" | "footer" | "footnote"; items: Item[] }

const DOCUMENT_STYLE: docs_v1.Schema$DocumentStyle = {
  pageSize: { width: { magnitude: 612, unit: "PT" }, height: { magnitude: 792, unit: "PT" } },
  marginTop: { magnitude: 72, unit: "PT" }, marginBottom: { magnitude: 72, unit: "PT" }, marginLeft: { magnitude: 72, unit: "PT" }, marginRight: { magnitude: 72, unit: "PT" },
};

/** "The provided URI must be publicly accessible and at most 2 kB in length" (InsertInlineImageRequest) */
const insertableUri = (uri: unknown) => typeof uri === "string" && /^https?:\/\//i.test(uri) && uri.length <= 2000;

/** Every index a request names, moved by `by` (a segment's indices are its items' less one) */
function shifted<T>(v: T, by: number): T {
  if (Array.isArray(v)) return v.map((x) => shifted(x, by)) as T;
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (k === "index" || k === "startIndex" || k === "endIndex") && typeof x === "number" ? x + by : shifted(x, by)])) as T;
}

/** A table's cells by grid row and column (the covered ones too), each with what follows it up to the next */
interface GridCell { cell: Extract<Item, { k: "cell" }>; content: Item[] }
interface Grid { at: number; end: number; tbl: Extract<Item, { k: "tbl" }>; rows: GridCell[][] }
const rowSpanOf = (c: GridCell) => c.cell.style?.rowSpan ?? 1;
const columnSpanOf = (c: GridCell) => c.cell.style?.columnSpan ?? 1;
/** An unset column, as documents.get gives it: "width... Set when the column's widthType is FIXED_WIDTH" */
const evenColumn = (): docs_v1.Schema$TableColumnProperties => ({ widthType: "EVENLY_DISTRIBUTED" });

export class StubDocument {
  items: Item[] = [{ k: "sb" }, { k: "nl", ts: {}, ps: { namedStyleType: "NORMAL_TEXT" } }];
  lists: Record<string, docs_v1.Schema$List> = {};
  /** Headers, footers and footnotes by id */
  segments: Record<string, Segment> = {};
  /** Inline images by object id: the address inserted and the size asked for */
  images: Record<string, { uri: string; size?: docs_v1.Schema$Size }> = {};
  documentStyle: docs_v1.Schema$DocumentStyle = clone(DOCUMENT_STYLE);
  revision = 1;
  private listSeq = 0;
  private objectSeq = 0;

  constructor(public readonly documentId: string, public title: string) {}

  get revisionId(): string {
    return `rev${this.revision}`;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** The text with position i holding the character at index i (structure as "\0", like indexedText) */
  text(items: Item[] = this.items): string {
    return items.map((it) => (it.k === "c" ? it.ch : it.k === "nl" ? "\n" : it.k === "pb" ? "\u000C" : it.k === "img" ? "\uFFFC" : "\0")).join("");
  }

  /** A header's, footer's or footnote's text, from its index 0 */
  segmentText(id: string): string {
    const seg = this.segments[id];
    if (!seg) throw new Error(`stub: no segment ${id}`);
    return this.text(seg.items).slice(1);
  }

  /** Everything a batch can change, to put back when one of its requests is refused */
  checkpoint(): () => void {
    const saved = clone({ items: this.items, lists: this.lists, segments: this.segments, images: this.images, documentStyle: this.documentStyle });
    return () => Object.assign(this, saved);
  }

  toDocument(): docs_v1.Schema$Document {
    const content: docs_v1.Schema$StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {} } }, ...this.contentOf(this.items)];
    const doc: docs_v1.Schema$Document = {
      documentId: this.documentId,
      title: this.title,
      revisionId: this.revisionId,
      body: { content },
      lists: clone(this.lists),
      namedStyles: { styles: clone(NAMED_STYLES) },
      documentStyle: clone(this.documentStyle),
    };
    const segments = Object.entries(this.segments);
    // A segment's indices start at 0: its items' less the stand-in section break
    const read = (seg: Segment) => shifted(this.contentOf(seg.items), -1);
    const headers = segments.filter(([, x]) => x.kind === "header");
    const footers = segments.filter(([, x]) => x.kind === "footer");
    const footnotes = segments.filter(([, x]) => x.kind === "footnote");
    if (headers.length) doc.headers = Object.fromEntries(headers.map(([id, x]) => [id, { headerId: id, content: read(x) }]));
    if (footers.length) doc.footers = Object.fromEntries(footers.map(([id, x]) => [id, { footerId: id, content: read(x) }]));
    if (footnotes.length) doc.footnotes = Object.fromEntries(footnotes.map(([id, x]) => [id, { footnoteId: id, content: read(x) }]));
    const images = Object.entries(this.images);
    if (images.length) {
      doc.inlineObjects = Object.fromEntries(images.map(([id, img]) => [id, {
        objectId: id,
        inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: img.uri, sourceUri: img.uri }, ...(img.size ? { size: clone(img.size) } : {}) } },
      }]));
    }
    return doc;
  }

  /** The structural elements of items (the body's or a segment's), from index 1 */
  private contentOf(items: Item[]): docs_v1.Schema$StructuralElement[] {
    const body = this.items;
    this.items = items;
    try {
      const content: docs_v1.Schema$StructuralElement[] = [];
      let i = 1;
      while (i < this.items.length) {
        const it = this.items[i];
        if (it.k === "tbl") {
          const { element, end } = this.readTable(i);
          content.push(element);
          i = end;
        } else if (it.k === "c" || it.k === "pb" || it.k === "nl" || it.k === "img" || it.k === "fn") {
          const { element, end } = this.readParagraph(i);
          content.push(element);
          i = end;
        } else throw new Error(`stub: unexpected ${it.k} at ${i}`);
      }
      return content;
    } finally {
      this.items = body;
    }
  }

  /** Footnotes are numbered in the order their references come in the body */
  private footnoteNumber(id: string): string {
    return String(this.items.filter((x) => x.k === "fn").findIndex((x) => (x as { id: string }).id === id) + 1);
  }

  private readParagraph(start: number): { element: docs_v1.Schema$StructuralElement; end: number } {
    const elements: docs_v1.Schema$ParagraphElement[] = [];
    let i = start;
    let run: { start: number; text: string; ts: TextStyle } | null = null;
    const flush = () => {
      if (run) elements.push({ startIndex: run.start, endIndex: run.start + run.text.length, textRun: { content: run.text, textStyle: clone(run.ts) } });
      run = null;
    };
    for (;;) {
      const it = this.items[i];
      if (!it || it.k === "sb" || it.k === "tbl" || it.k === "row" || it.k === "cell" || it.k === "tend") throw new Error(`stub: paragraph at ${start} has no end`);
      if (it.k === "pb") {
        flush();
        elements.push({ startIndex: i, endIndex: i + 1, pageBreak: { textStyle: clone(it.ts) } });
        i++;
        continue;
      }
      if (it.k === "img") {
        flush();
        elements.push({ startIndex: i, endIndex: i + 1, inlineObjectElement: { inlineObjectId: it.id, textStyle: clone(it.ts) } });
        i++;
        continue;
      }
      if (it.k === "fn") {
        flush();
        elements.push({ startIndex: i, endIndex: i + 1, footnoteReference: { footnoteId: it.id, footnoteNumber: this.footnoteNumber(it.id), textStyle: clone(it.ts) } });
        i++;
        continue;
      }
      const ch = it.k === "c" ? it.ch : "\n";
      const key = JSON.stringify(it.ts);
      if (run && JSON.stringify((run as { ts: TextStyle }).ts) === key) (run as { text: string }).text += ch;
      else { flush(); run = { start: i, text: ch, ts: it.ts }; }
      i++;
      if (it.k === "nl") {
        flush();
        const paragraph: docs_v1.Schema$Paragraph = { elements, paragraphStyle: clone(it.ps) };
        if (it.bullet) paragraph.bullet = { listId: it.bullet.listId, ...(it.bullet.nestingLevel ? { nestingLevel: it.bullet.nestingLevel } : {}) };
        return { element: { startIndex: start, endIndex: i, paragraph }, end: i };
      }
    }
  }

  private readTable(start: number): { element: docs_v1.Schema$StructuralElement; end: number } {
    const tbl = this.items[start] as Extract<Item, { k: "tbl" }>;
    const tableRows: docs_v1.Schema$TableRow[] = [];
    let i = start + 1;
    while (this.items[i]?.k === "row") {
      const rowStart = i++;
      const tableCells: docs_v1.Schema$TableCell[] = [];
      while (this.items[i]?.k === "cell") {
        const cellItem = this.items[i] as Extract<Item, { k: "cell" }>;
        const cellStart = i++;
        const content: docs_v1.Schema$StructuralElement[] = [];
        while (this.items[i] && !["cell", "row", "tend"].includes(this.items[i].k)) {
          if (this.items[i].k === "tbl") throw new Error("stub: nested tables are not modelled");
          const p = this.readParagraph(i);
          content.push(p.element);
          i = p.end;
        }
        tableCells.push({ startIndex: cellStart, endIndex: i, content, tableCellStyle: clone(cellItem.style ?? {}) });
      }
      tableRows.push({ startIndex: rowStart, endIndex: i, tableCells });
    }
    if (this.items[i]?.k !== "tend") throw new Error(`stub: table at ${start} has no end`);
    i++;
    return { element: { startIndex: start, endIndex: i, table: { rows: tableRows.length, columns: tbl.columns, tableRows, tableStyle: { tableColumnProperties: Array.from({ length: tbl.columns }, (_, c) => clone(tbl.widths?.[c] ?? evenColumn())) } } }, end: i };
  }

  // ── Paragraph geometry ────────────────────────────────────────────────────

  /** Index of the newline ending the paragraph that contains index i (i may be the newline itself) */
  private paragraphEnd(i: number): number {
    for (let j = i; j < this.items.length; j++) {
      const k = this.items[j].k;
      if (k === "nl") return j;
      if (STRUCTURAL.has(k)) break;
    }
    throw bad(`Index ${i} is not inside a paragraph`);
  }

  /** First index of the paragraph that contains index i */
  private paragraphStart(i: number): number {
    let j = i;
    while (j > 0 && !STRUCTURAL.has(this.items[j - 1].k) && this.items[j - 1].k !== "nl") j--;
    return j;
  }

  /** [start, newline index] of every paragraph overlapping [s, e) */
  private paragraphsIn(s: number, e: number): { start: number; nl: number }[] {
    const out: { start: number; nl: number }[] = [];
    let i = 1;
    while (i < this.items.length) {
      const k = this.items[i].k;
      if (STRUCTURAL.has(k)) { i++; continue; }
      const nl = this.paragraphEnd(i);
      if (i < e && nl + 1 > s) out.push({ start: i, nl });
      i = nl + 1;
    }
    return out;
  }

  private assertInsertIndex(i: number): void {
    if (!Number.isInteger(i) || i < 1 || i >= this.items.length) throw bad(`Invalid insertion index ${i}: must be between 1 and ${this.items.length - 1}`);
    if (STRUCTURAL.has(this.items[i].k)) throw bad(`Index ${i} must be inside a paragraph (it is a table boundary)`);
  }

  /** Whether index i is inside a table: a table starts before it and doesn't end before it */
  private inTable(i: number): boolean {
    let depth = 0;
    for (let j = 0; j < i; j++) {
      const k = this.items[j].k;
      if (k === "tbl") depth++;
      else if (k === "tend") depth--;
    }
    return depth > 0;
  }

  /** Style of inserted text: the character before it in the paragraph, else the one after */
  private inheritedStyle(i: number): TextStyle {
    const prev = this.items[i - 1];
    if (prev && (prev.k === "c" || prev.k === "pb" || prev.k === "img")) return clone(prev.ts);
    const next = this.items[i];
    if (next && (next.k === "c" || next.k === "pb" || next.k === "nl" || next.k === "img")) return clone(next.ts);
    return {};
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /** Applies every request or none; each one's reply, as Google gives them */
  batchUpdate(requests: Request[], requiredRevisionId?: string): object[] {
    if (requiredRevisionId && requiredRevisionId !== this.revisionId) {
      throw bad(`The document has been modified since the specified revision (${requiredRevisionId} vs ${this.revisionId}); the batch was not applied`);
    }
    // Atomic: all or nothing
    const restore = this.checkpoint();
    const replies: object[] = [];
    try {
      for (const r of requests) replies.push(this.apply(r));
    } catch (err) {
      restore();
      throw err;
    }
    this.revision++;
    return replies;
  }

  /** The request applied where it names: the body, or a header, footer or footnote (its segmentId) */
  private apply(r: Request): object {
    const [key] = Object.keys(r);
    const body = (r as Record<string, { location?: Location; range?: { segmentId?: string }; endOfSegmentLocation?: { segmentId?: string } }>)[key];
    const segmentId = body?.location?.segmentId || body?.range?.segmentId || body?.endOfSegmentLocation?.segmentId;
    if (!segmentId) return this.applyHere(this.atEnd(r));
    const seg = this.segments[segmentId];
    if (!seg) throw bad(`Invalid segment ID: ${segmentId}`);
    if (key === "insertPageBreak" || key === "insertSectionBreak" || key === "createFootnote") throw bad(`${key} can only be inserted in the body`);
    if (seg.kind === "footnote" && (key === "insertInlineImage" || key === "insertTable")) throw bad(`${key} can't be inserted in a footnote`);
    // Written as the body is, the segment's items standing in for the body's
    const own = this.items;
    this.items = seg.items;
    try {
      return this.applyHere(this.atEnd(shifted(r, 1)));
    } finally {
      seg.items = this.items;
      this.items = own;
    }
  }

  /** An insert at endOfSegmentLocation: "immediately before the last newline" of where it writes */
  private atEnd(r: Request): Request {
    const [key] = Object.keys(r);
    const body = (r as Record<string, Record<string, unknown>>)[key];
    if (!body?.endOfSegmentLocation) return r;
    const at: Record<string, unknown> = { ...body, location: { index: this.items.length - 1 } };
    delete at.endOfSegmentLocation;
    return { [key]: at } as Request;
  }

  private applyHere(r: Request): object {
    if (r.insertInlineImage) return { insertInlineImage: { objectId: this.insertInlineImage(r.insertInlineImage) } };
    if (r.createFootnote) return { createFootnote: { footnoteId: this.createFootnote(r.createFootnote.location.index) } };
    if (r.createHeader) return { createHeader: { headerId: this.createSegment("header", r.createHeader) } };
    if (r.createFooter) return { createFooter: { footerId: this.createSegment("footer", r.createFooter) } };
    this.applyEdit(r);
    return {};
  }

  /** A request whose reply is empty */
  private applyEdit(r: Request): void {
    const [key] = Object.keys(r);
    if (r.insertText) return this.insertText(r.insertText.location.index, r.insertText.text);
    if (r.insertPageBreak) return this.insertPageBreak(r.insertPageBreak.location.index);
    if (r.insertTable) return this.insertTable(r.insertTable.location.index, r.insertTable.rows, r.insertTable.columns);
    if (r.deleteHeader) return this.deleteSegment("header", r.deleteHeader.headerId);
    if (r.deleteFooter) return this.deleteSegment("footer", r.deleteFooter.footerId);
    if (r.updateDocumentStyle) return this.updateDocumentStyle(r.updateDocumentStyle.documentStyle, r.updateDocumentStyle.fields);
    if (r.deleteContentRange) return this.deleteContentRange(r.deleteContentRange.range.startIndex, r.deleteContentRange.range.endIndex);
    if (r.updateTextStyle) return this.updateTextStyle(r.updateTextStyle.range.startIndex, r.updateTextStyle.range.endIndex, r.updateTextStyle.textStyle, r.updateTextStyle.fields);
    if (r.updateParagraphStyle) return this.updateParagraphStyle(r.updateParagraphStyle.range.startIndex, r.updateParagraphStyle.range.endIndex, r.updateParagraphStyle.paragraphStyle, r.updateParagraphStyle.fields);
    if (r.createParagraphBullets) return this.createParagraphBullets(r.createParagraphBullets.range.startIndex, r.createParagraphBullets.range.endIndex, r.createParagraphBullets.bulletPreset);
    if (r.deleteParagraphBullets) return this.deleteParagraphBullets(r.deleteParagraphBullets.range.startIndex, r.deleteParagraphBullets.range.endIndex);
    if (r.updateTableCellStyle) return this.updateTableCellStyle(r.updateTableCellStyle);
    if (r.mergeTableCells) return this.mergeTableCells(r.mergeTableCells);
    if (r.updateTableColumnProperties) return this.updateTableColumnProperties(r.updateTableColumnProperties);
    if (r.unmergeTableCells) return this.unmergeTableCells(r.unmergeTableCells);
    if (r.insertTableRow) return this.insertTableRow(r.insertTableRow);
    if (r.deleteTableRow) return this.deleteTableRow(r.deleteTableRow);
    if (r.insertTableColumn) return this.insertTableColumn(r.insertTableColumn);
    if (r.deleteTableColumn) return this.deleteTableColumn(r.deleteTableColumn);
    throw bad(`The stub does not model ${key} requests`);
  }

  private nextId(prefix: string): string {
    return `kix.${prefix}${++this.objectSeq}`;
  }

  /** One index in a paragraph; the image is fitted inside the size asked for (the stub keeps that size) */
  insertInlineImage(ins: NonNullable<Request["insertInlineImage"]>): string {
    if (!insertableUri(ins.uri)) throw bad("Invalid requests[0].insertInlineImage: the image URI must be a public http(s) address of at most 2 kB");
    const index = ins.location.index;
    this.assertInsertIndex(index);
    for (const d of [ins.objectSize?.width, ins.objectSize?.height]) {
      if (d && (d.unit !== "PT" || !((d.magnitude ?? 0) > 0))) throw bad("An image's size must be given in points, above 0");
    }
    const id = this.nextId("img");
    this.items.splice(index, 0, { k: "img", id, ts: this.inheritedStyle(index) });
    this.images[id] = { uri: ins.uri, ...(ins.objectSize ? { size: clone(ins.objectSize) } : {}) };
    return id;
  }

  /** "The new Footnote segment will contain a space followed by a newline character" (CreateFootnoteRequest) */
  createFootnote(index: number): string {
    this.assertInsertIndex(index);
    const id = this.nextId("fn");
    this.items.splice(index, 0, { k: "fn", id, ts: this.inheritedStyle(index) });
    this.segments[id] = { kind: "footnote", items: [{ k: "sb" }, { k: "c", ch: " ", ts: {} }, { k: "nl", ts: {}, ps: { namedStyleType: "NORMAL_TEXT" } }] };
    return id;
  }

  /** The document's own header or footer (the stub models one section): an empty paragraph */
  private createSegment(kind: "header" | "footer", req: { type?: string; sectionBreakLocation?: Location }): string {
    if (req.type !== "DEFAULT") throw bad(`Only a DEFAULT ${kind} can be created`);
    if (req.sectionBreakLocation && req.sectionBreakLocation.index !== 0) throw bad(`The stub models the ${kind} of the document's first section only`);
    const field = kind === "header" ? "defaultHeaderId" : "defaultFooterId";
    if (this.documentStyle[field]) throw bad(`A default ${kind} already exists`);
    const id = this.nextId(kind === "header" ? "hdr" : "ftr");
    this.segments[id] = { kind, items: [{ k: "sb" }, { k: "nl", ts: {}, ps: { namedStyleType: "NORMAL_TEXT" } }] };
    this.documentStyle[field] = id;
    return id;
  }

  private deleteSegment(kind: "header" | "footer", id: string): void {
    if (this.segments[id]?.kind !== kind) throw bad(`Invalid ${kind} ID: ${id}`);
    delete this.segments[id];
    const field = kind === "header" ? "defaultHeaderId" : "defaultFooterId";
    if (this.documentStyle[field] === id) delete this.documentStyle[field];
  }

  /** The page: each field named is set, or reset when the style leaves it out */
  updateDocumentStyle(style: docs_v1.Schema$DocumentStyle, fields: string): void {
    const keys = [...new Set((fields ?? "").split(",").map((f) => f.trim().split(".")[0]).filter(Boolean))];
    if (!keys.length) throw bad("fields is required");
    for (const key of keys) {
      if (key === "defaultHeaderId" || key === "defaultFooterId") throw bad(`${key} can't be set`);
      const v = (style as Record<string, unknown>)[key];
      if (v == null) delete (this.documentStyle as Record<string, unknown>)[key];
      else (this.documentStyle as Record<string, unknown>)[key] = clone(v);
    }
  }

  insertText(index: number, text: string): void {
    if (!text) return;
    this.assertInsertIndex(index);
    const ts = this.inheritedStyle(index);
    const end = this.items[this.paragraphEnd(index)] as Extract<Item, { k: "nl" }>;
    const fresh: Item[] = [];
    // Docs counts indexes in UTF-16 code units: a character outside the basic plane (an emoji) takes two
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (ch === "\n") fresh.push({ k: "nl", ts: clone(ts), ps: clone(end.ps), ...(end.bullet ? { bullet: clone(end.bullet) } : {}) });
      else if (ch === "\r" || ch === "\u000C") continue; // Docs drops these from insertText
      else fresh.push({ k: "c", ch, ts: clone(ts) });
    }
    this.items.splice(index, 0, ...fresh);
  }

  /** "Page breaks cannot be inserted inside a table, equation, footnote, header or footer" (InsertPageBreakRequest.location) */
  insertPageBreak(index: number): void {
    this.assertInsertIndex(index);
    if (this.inTable(index)) throw bad(`Invalid requests[0].insertPageBreak: a page break can't be inserted inside a table (index ${index})`);
    const ts = this.inheritedStyle(index);
    const end = this.items[this.paragraphEnd(index)] as Extract<Item, { k: "nl" }>;
    this.items.splice(index, 0, { k: "pb", ts: clone(ts) }, { k: "nl", ts: clone(ts), ps: clone(end.ps), ...(end.bullet ? { bullet: clone(end.bullet) } : {}) });
  }

  insertTable(index: number, rows: number, columns: number): void {
    this.assertInsertIndex(index);
    if (rows < 1 || columns < 1) throw bad("A table needs at least one row and one column");
    const end = this.items[this.paragraphEnd(index)] as Extract<Item, { k: "nl" }>;
    // "A newline character will be inserted before the inserted table"
    const fresh: Item[] = [{ k: "nl", ts: {}, ps: clone(end.ps), ...(end.bullet ? { bullet: clone(end.bullet) } : {}) }, { k: "tbl", columns }];
    for (let r = 0; r < rows; r++) {
      fresh.push({ k: "row" });
      for (let c = 0; c < columns; c++) fresh.push({ k: "cell" }, { k: "nl", ts: {}, ps: { namedStyleType: "NORMAL_TEXT" } });
    }
    fresh.push({ k: "tend" });
    this.items.splice(index, 0, ...fresh);
  }

  /** One cell's style (the stub models a range of one cell, and its background) */
  updateTableCellStyle(u: docs_v1.Schema$UpdateTableCellStyleRequest): void {
    const loc = u.tableRange?.tableCellLocation;
    const at = loc?.tableStartLocation?.index;
    if (at == null || this.items[at]?.k !== "tbl") throw bad(`Invalid table start location ${at}: there is no table there`);
    if ((u.tableRange?.rowSpan ?? 1) !== 1 || (u.tableRange?.columnSpan ?? 1) !== 1) throw bad("The stub models one cell at a time");
    const fields = (u.fields ?? "").split(",").filter(Boolean);
    if (!fields.length) throw bad("fields is required");
    if (fields.some((f) => f !== "backgroundColor")) throw bad(`The stub does not model table cell fields ${fields.join(",")}`);
    let row = -1;
    let column = -1;
    for (let i = at + 1; i < this.items.length && this.items[i].k !== "tend"; i++) {
      const it = this.items[i];
      if (it.k === "row") { row++; column = -1; continue; }
      if (it.k !== "cell" || ++column !== loc?.columnIndex || row !== loc?.rowIndex) continue;
      const style = { ...(it.style ?? {}) };
      if (u.tableCellStyle?.backgroundColor) style.backgroundColor = clone(u.tableCellStyle.backgroundColor);
      else delete style.backgroundColor;
      it.style = style;
      return;
    }
    throw bad(`Invalid table cell location: row ${loc?.rowIndex}, column ${loc?.columnIndex}`);
  }

  /** Columns' width: "If the value of tableColumnProperties#width is less than 5 points (5/72 inch), a 400 bad request error is returned" */
  updateTableColumnProperties(u: docs_v1.Schema$UpdateTableColumnPropertiesRequest): void {
    const at = u.tableStartLocation?.index;
    const tbl = at == null ? undefined : this.items[at];
    if (!tbl || tbl.k !== "tbl") throw bad(`Invalid table start location ${at}: there is no table there`);
    const fields = (u.fields ?? "").split(",").filter(Boolean);
    if (!fields.length) throw bad("fields is required");
    if (fields.some((f) => f !== "width" && f !== "widthType")) throw bad(`The stub does not model table column fields ${fields.join(",")}`);
    const props = u.tableColumnProperties ?? {};
    const w = props.width;
    if (fields.includes("width") && w && (w.unit !== "PT" || !((w.magnitude ?? 0) >= 5))) throw bad("The column width must be at least 5 points");
    const columns = u.columnIndices?.length ? u.columnIndices : Array.from({ length: tbl.columns }, (_, c) => c);
    for (const c of columns) if (!Number.isInteger(c) || c < 0 || c >= tbl.columns) throw bad(`Invalid column index ${c}`);
    const widths = tbl.widths ?? Array.from({ length: tbl.columns }, evenColumn);
    for (const c of columns) {
      const now: docs_v1.Schema$TableColumnProperties = { ...widths[c] };
      for (const f of fields as ("width" | "widthType")[]) {
        if (props[f] == null) delete now[f];
        else (now as Record<string, unknown>)[f] = clone(props[f]);
      }
      if (now.widthType === "FIXED_WIDTH" && !now.width) throw bad("A fixed width column needs a width");
      // An evenly distributed column has no width of its own
      if (now.widthType !== "FIXED_WIDTH") delete now.width;
      widths[c] = now;
    }
    tbl.widths = widths;
  }

  /** The table starting at `at`, cell by cell of its grid */
  private grid(at: number | null | undefined): Grid {
    const tbl = at == null ? undefined : this.items[at];
    if (!tbl || tbl.k !== "tbl") throw bad(`Invalid table start location ${at}: there is no table there`);
    const rows: GridCell[][] = [];
    let i = at! + 1;
    for (; this.items[i].k !== "tend"; i++) {
      const it = this.items[i];
      if (it.k === "row") rows.push([]);
      else if (it.k === "cell") rows[rows.length - 1].push({ cell: it, content: [] });
      else rows[rows.length - 1][rows[rows.length - 1].length - 1].content.push(it);
    }
    return { at: at!, end: i + 1, tbl, rows };
  }

  private writeGrid(g: Grid): void {
    const out: Item[] = [g.tbl];
    for (const row of g.rows) {
      out.push({ k: "row" });
      for (const c of row) out.push(c.cell, ...c.content);
    }
    out.push({ k: "tend" });
    this.items.splice(g.at, g.end - g.at, ...out);
  }

  /** The cell a request refers to. What a cell a merge covers means isn't documented: the stub refuses it */
  private referenceCell(loc: docs_v1.Schema$TableCellLocation | undefined): { g: Grid; r: number; c: number } {
    const g = this.grid(loc?.tableStartLocation?.index);
    const r = loc?.rowIndex ?? 0;
    const c = loc?.columnIndex ?? 0;
    if (!g.rows[r]?.[c]) throw bad(`Invalid table cell location: row ${r}, column ${c}`);
    if (g.rows[r][c].cell.covered) throw bad("The stub does not model a reference cell that a merge covers");
    return { g, r, c };
  }

  /** The head of the merge (or the cell) at a grid row and column */
  private headAt(g: Grid, r: number, c: number): [number, number] {
    for (let hr = r; hr >= 0; hr--) for (let hc = c; hc >= 0; hc--) {
      const h = g.rows[hr][hc];
      if (!h.cell.covered && hr + rowSpanOf(h) > r && hc + columnSpanOf(h) > c) return [hr, hc];
    }
    throw new Error("stub: a covered cell has no head");
  }

  /**
   * Rows or columns taken out: a merge across one shrinks, and when its head's goes, the first one it
   * keeps takes the head (and its content)
   */
  private removeLines(g: Grid, lines: Set<number>, columns: boolean): void {
    const at = (a: number, b: number) => (columns ? g.rows[b][a] : g.rows[a][b]);
    const span = columns ? columnSpanOf : rowSpanOf;
    g.rows.forEach((row, r) => row.forEach((h, c) => {
      const [line, other] = columns ? [c, r] : [r, c];
      if (h.cell.covered || span(h) === 1) return;
      const kept = Array.from({ length: span(h) }, (_, k) => line + k).filter((x) => !lines.has(x));
      if (!kept.length || kept[0] === line) {
        if (kept.length) h.cell.style = { ...h.cell.style, [columns ? "columnSpan" : "rowSpan"]: kept.length };
        return;
      }
      const next = at(kept[0], other);
      next.cell.covered = false;
      next.cell.style = { ...h.cell.style, [columns ? "columnSpan" : "rowSpan"]: kept.length };
      next.content = h.content;
    }));
    if (columns) {
      for (const row of g.rows) for (let c = row.length - 1; c >= 0; c--) if (lines.has(c)) row.splice(c, 1);
      g.tbl.widths = g.tbl.widths?.filter((_, c) => !lines.has(c));
      g.tbl.columns -= lines.size;
    } else g.rows = g.rows.filter((_, r) => !lines.has(r));
    if (!g.rows.length || !g.tbl.columns) throw bad("The stub does not delete a table's every row or column");
  }

  /** "If this is a merged cell that spans multiple rows, all rows that the cell spans will be deleted" */
  deleteTableRow(d: docs_v1.Schema$DeleteTableRowRequest): void {
    const { g, r, c } = this.referenceCell(d.tableCellLocation);
    this.removeLines(g, new Set(Array.from({ length: rowSpanOf(g.rows[r][c]) }, (_, k) => r + k)), false);
    this.writeGrid(g);
  }

  /** "If this is a merged cell that spans multiple columns, all columns that the cell spans will be deleted" */
  deleteTableColumn(d: docs_v1.Schema$DeleteTableColumnRequest): void {
    const { g, r, c } = this.referenceCell(d.tableCellLocation);
    this.removeLines(g, new Set(Array.from({ length: columnSpanOf(g.rows[r][c]) }, (_, k) => c + k)), true);
    this.writeGrid(g);
  }

  /** "If the reference cell is a merged cell, a new row will be inserted above (or below) the merged cell" */
  insertTableRow(ins: docs_v1.Schema$InsertTableRowRequest): void {
    const { g, r, c } = this.referenceCell(ins.tableCellLocation);
    const k = ins.insertBelow ? r + rowSpanOf(g.rows[r][c]) : r;
    const fresh: GridCell[] = Array.from({ length: g.tbl.columns }, () => ({ cell: { k: "cell" }, content: [{ k: "nl", ts: {}, ps: { namedStyleType: "NORMAL_TEXT" } }] }));
    // A merge across where it goes takes it in
    if (k > 0 && k < g.rows.length) for (let col = 0; col < g.tbl.columns; col++) {
      const [hr, hc] = this.headAt(g, k - 1, col);
      const h = g.rows[hr][hc];
      if (hr + rowSpanOf(h) <= k) continue;
      fresh[col].cell.covered = true;
      if (hc === col) h.cell.style = { ...h.cell.style, rowSpan: rowSpanOf(h) + 1 };
    }
    g.rows.splice(k, 0, fresh);
    this.writeGrid(g);
  }

  /** "If the reference cell is a merged cell, a new column will be inserted to the left (or right) of the merged cell" */
  insertTableColumn(ins: docs_v1.Schema$InsertTableColumnRequest): void {
    const { g, r, c } = this.referenceCell(ins.tableCellLocation);
    const k = ins.insertRight ? c + columnSpanOf(g.rows[r][c]) : c;
    g.rows.forEach((row, ri) => {
      const fresh: GridCell = { cell: { k: "cell" }, content: [{ k: "nl", ts: {}, ps: { namedStyleType: "NORMAL_TEXT" } }] };
      if (k > 0 && k < g.tbl.columns) {
        const [hr, hc] = this.headAt(g, ri, k - 1);
        const h = g.rows[hr][hc];
        if (hc + columnSpanOf(h) > k) {
          fresh.cell.covered = true;
          if (hr === ri) h.cell.style = { ...h.cell.style, columnSpan: columnSpanOf(h) + 1 };
        }
      }
      row.splice(k, 0, fresh);
    });
    if (g.tbl.widths) g.tbl.widths.splice(k, 0, evenColumn());
    g.tbl.columns++;
    this.writeGrid(g);
  }

  /** "All merged cells in this range will be unmerged"; a merged cell's text stays in its head */
  unmergeTableCells(u: docs_v1.Schema$UnmergeTableCellsRequest): void {
    const loc = u.tableRange?.tableCellLocation;
    const g = this.grid(loc?.tableStartLocation?.index);
    const r0 = loc?.rowIndex ?? 0;
    const c0 = loc?.columnIndex ?? 0;
    const r1 = r0 + (u.tableRange?.rowSpan ?? 1);
    const c1 = c0 + (u.tableRange?.columnSpan ?? 1);
    if (r0 < 0 || c0 < 0 || r1 > g.rows.length || c1 > g.tbl.columns) throw bad("The table range is out of the table's bounds");
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const h = g.rows[r][c];
      if (h.cell.covered || (rowSpanOf(h) === 1 && columnSpanOf(h) === 1)) continue;
      for (let dr = 0; dr < rowSpanOf(h); dr++) for (let dc = 0; dc < columnSpanOf(h); dc++) if (dr || dc) g.rows[r + dr][c + dc].cell.covered = false;
      const style = { ...h.cell.style };
      delete style.rowSpan;
      delete style.columnSpan;
      h.cell.style = style;
    }
    this.writeGrid(g);
  }

  /**
   * Cells merged into their head (the range's top left). The stub's tables list every cell of their
   * grid, the covered ones too (each keeps its own newline); it merges cells that hold no text.
   */
  mergeTableCells(m: docs_v1.Schema$MergeTableCellsRequest): void {
    const range = m.tableRange;
    const loc = range?.tableCellLocation;
    const at = loc?.tableStartLocation?.index;
    if (at == null || this.items[at]?.k !== "tbl") throw bad(`Invalid table start location ${at}: there is no table there`);
    const rows: number[][] = [];
    for (let i = at + 1; i < this.items.length && this.items[i].k !== "tend"; i++) {
      if (this.items[i].k === "row") rows.push([]);
      else if (this.items[i].k === "cell") rows[rows.length - 1].push(i);
    }
    const r0 = loc?.rowIndex ?? 0;
    const c0 = loc?.columnIndex ?? 0;
    const rs = range?.rowSpan ?? 1;
    const cs = range?.columnSpan ?? 1;
    if (rs < 1 || cs < 1 || r0 < 0 || c0 < 0 || r0 + rs > rows.length || rows.slice(r0, r0 + rs).some((row) => c0 + cs > row.length)) throw bad("The table range is out of the table's bounds");
    for (let r = r0; r < r0 + rs; r++) for (let c = c0; c < c0 + cs; c++) {
      const cell = this.items[rows[r][c]] as Extract<Item, { k: "cell" }>;
      if ((cell.style?.rowSpan ?? 1) > 1 || (cell.style?.columnSpan ?? 1) > 1 || cell.covered) throw bad("The range overlaps merged cells");
      const next = this.items[rows[r][c] + 1];
      const after = this.items[rows[r][c] + 2];
      if ((r !== r0 || c !== c0) && !(next?.k === "nl" && (!after || ["cell", "row", "tend"].includes(after.k)))) throw bad("The stub merges cells that hold no text");
    }
    for (let r = r0; r < r0 + rs; r++) for (let c = c0; c < c0 + cs; c++) if (r !== r0 || c !== c0) (this.items[rows[r][c]] as Extract<Item, { k: "cell" }>).covered = true;
    const head = this.items[rows[r0][c0]] as Extract<Item, { k: "cell" }>;
    head.style = { ...(head.style ?? {}), rowSpan: rs, columnSpan: cs };
  }

  deleteContentRange(start: number, end: number): void {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end <= start || end > this.items.length) throw bad(`Invalid range [${start}, ${end})`);
    if (end === this.items.length) throw bad("The final newline of the body cannot be deleted");
    for (let i = start; i < end; i++) {
      const it = this.items[i];
      if (it.k === "tbl") {
        const tend = this.items.findIndex((x, j) => j > i && x.k === "tend");
        if (tend < 0 || tend >= end) throw bad("A table can only be deleted whole");
        i = tend;
        continue;
      }
      if (it.k === "row" || it.k === "cell" || it.k === "tend") throw bad("Individual rows or cells of a table cannot be deleted");
      if (it.k === "nl") {
        const next = this.items[i + 1];
        if (next && (next.k === "cell" || next.k === "row" || next.k === "tend")) throw bad("The last newline of a table cell cannot be deleted");
        if (next && next.k === "tbl" && !(i + 1 < end)) throw bad("The newline before a table cannot be deleted without deleting the table");
      }
    }
    // A footnote goes with its reference, an image's object with the image
    for (const it of this.items.splice(start, end - start)) {
      if (it.k === "fn") delete this.segments[it.id];
      if (it.k === "img") delete this.images[it.id];
    }
  }

  updateTextStyle(start: number, end: number, textStyle: TextStyle, fields: string): void {
    if (end <= start || start < 1 || end > this.items.length) throw bad(`Invalid range [${start}, ${end})`);
    const keys = fields.split(",").map((f) => f.trim()).filter(Boolean) as (keyof TextStyle)[];
    for (let i = start; i < end; i++) {
      const it = this.items[i];
      if (it.k !== "c" && it.k !== "pb" && it.k !== "nl" && it.k !== "img" && it.k !== "fn") continue;
      for (const key of keys) {
        const v = (textStyle as Record<string, unknown>)[key];
        if (v == null) delete (it.ts as Record<string, unknown>)[key];
        else (it.ts as Record<string, unknown>)[key] = clone(v);
      }
    }
  }

  updateParagraphStyle(start: number, end: number, paragraphStyle: ParagraphStyle, fields: string): void {
    const keys = fields.split(",").map((f) => f.trim()).filter(Boolean);
    const paragraphs = this.paragraphsIn(start, end);
    if (!paragraphs.length) throw bad(`No paragraph in [${start}, ${end})`);
    for (const p of paragraphs) {
      const nl = this.items[p.nl] as Extract<Item, { k: "nl" }>;
      for (const key of keys) {
        const v = (paragraphStyle as Record<string, unknown>)[key];
        if (v == null) delete (nl.ps as Record<string, unknown>)[key];
        else (nl.ps as Record<string, unknown>)[key] = clone(v);
      }
    }
  }

  createParagraphBullets(start: number, end: number, preset: string): void {
    const paragraphs = this.paragraphsIn(start, end);
    if (!paragraphs.length) throw bad(`No paragraph in [${start}, ${end})`);
    const listId = `kix.list${++this.listSeq}`;
    this.lists[listId] = listFor(preset);
    // As Google does it: the nesting level is the paragraph's leading tabs relative to the fewest
    // tabs among the paragraphs of this request that are not bulleted yet; a paragraph already in a
    // list keeps its level. Leading tabs are removed either way.
    const tabsOf = (p: { start: number }) => {
      let tabs = 0;
      while (this.items[p.start + tabs]?.k === "c" && (this.items[p.start + tabs] as { ch: string }).ch === "\t") tabs++;
      return tabs;
    };
    const fresh = paragraphs.filter((p) => !(this.items[p.nl] as Extract<Item, { k: "nl" }>).bullet);
    const baseline = fresh.length ? Math.min(...fresh.map(tabsOf)) : 0;
    // Last to first: removing a paragraph's leading tabs shifts everything after it
    for (const p of [...paragraphs].reverse()) {
      const tabs = tabsOf(p);
      this.items.splice(p.start, tabs);
      const nl = this.items[p.nl - tabs] as Extract<Item, { k: "nl" }>;
      // The indent left behind by removed bullets counts as levels too
      const leftover = nl.bullet ? 0 : Math.max(0, Math.round((nl.ps.indentStart?.magnitude ?? 0) / 36) - 1);
      nl.bullet = { listId, nestingLevel: nl.bullet ? nl.bullet.nestingLevel ?? 0 : Math.min(8, tabs - baseline + leftover) };
      nl.ps.indentFirstLine = { magnitude: 18 + 36 * nl.bullet.nestingLevel, unit: "PT" };
      nl.ps.indentStart = { magnitude: 36 * (nl.bullet.nestingLevel + 1), unit: "PT" };
    }
  }

  deleteParagraphBullets(start: number, end: number): void {
    for (const p of this.paragraphsIn(start, end)) {
      const nl = this.items[p.nl] as Extract<Item, { k: "nl" }>;
      delete nl.bullet; // Docs keeps the indents the bullets had
    }
  }
}

/** A Docs service holding any number of stub documents */
export function createStubDocs(): E2EDocs & { docs: Map<string, StubDocument>; document(id: string): StubDocument } {
  const docs = new Map<string, StubDocument>();
  let seq = 0;
  const calls = { reads: 0, writes: 0 };
  const document = (id: string) => {
    const d = docs.get(id);
    if (!d) throw new DocsApiError(`Requested entity was not found: ${id}`, 404);
    return d;
  };
  return {
    kind: "stub",
    calls,
    docs,
    document,
    async create(title) {
      calls.writes++;
      const id = `stub-doc-${++seq}`;
      docs.set(id, new StubDocument(id, title));
      return id;
    },
    async get(id) {
      calls.reads++;
      return document(id).toDocument();
    },
    async batchUpdate(id, requests, requiredRevisionId) {
      if (!requests.length) return;
      calls.writes++;
      document(id).batchUpdate(requests as Request[], requiredRevisionId);
    },
    async remove(id) {
      calls.writes++;
      document(id);
      docs.delete(id);
    },
  };
}
