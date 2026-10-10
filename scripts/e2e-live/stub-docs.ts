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
 * old revision is refused.
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
  | { k: "nl"; ts: TextStyle; ps: ParagraphStyle; bullet?: Bullet }
  | { k: "tbl"; columns: number }
  | { k: "row" }
  | { k: "cell" }
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

interface Request {
  insertText?: { location: { index: number }; text: string };
  insertPageBreak?: { location: { index: number } };
  insertTable?: { rows: number; columns: number; location: { index: number } };
  deleteContentRange?: { range: { startIndex: number; endIndex: number } };
  updateTextStyle?: { range: { startIndex: number; endIndex: number }; textStyle: TextStyle; fields: string };
  updateParagraphStyle?: { range: { startIndex: number; endIndex: number }; paragraphStyle: ParagraphStyle; fields: string };
  createParagraphBullets?: { range: { startIndex: number; endIndex: number }; bulletPreset: string };
  deleteParagraphBullets?: { range: { startIndex: number; endIndex: number } };
}

export class StubDocument {
  items: Item[] = [{ k: "sb" }, { k: "nl", ts: {}, ps: { namedStyleType: "NORMAL_TEXT" } }];
  lists: Record<string, docs_v1.Schema$List> = {};
  revision = 1;
  private listSeq = 0;

  constructor(public readonly documentId: string, public title: string) {}

  get revisionId(): string {
    return `rev${this.revision}`;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** The text with position i holding the character at index i (structure as "\0", like indexedText) */
  text(): string {
    return this.items.map((it) => (it.k === "c" ? it.ch : it.k === "nl" ? "\n" : it.k === "pb" ? "\u000C" : "\0")).join("");
  }

  toDocument(): docs_v1.Schema$Document {
    const content: docs_v1.Schema$StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {} } }];
    let i = 1;
    while (i < this.items.length) {
      const it = this.items[i];
      if (it.k === "tbl") {
        const { element, end } = this.readTable(i);
        content.push(element);
        i = end;
      } else if (it.k === "c" || it.k === "pb" || it.k === "nl") {
        const { element, end } = this.readParagraph(i);
        content.push(element);
        i = end;
      } else throw new Error(`stub: unexpected ${it.k} at ${i}`);
    }
    return {
      documentId: this.documentId,
      title: this.title,
      revisionId: this.revisionId,
      body: { content },
      lists: clone(this.lists),
      namedStyles: { styles: clone(NAMED_STYLES) },
      documentStyle: {
        pageSize: { width: { magnitude: 612, unit: "PT" }, height: { magnitude: 792, unit: "PT" } },
        marginTop: { magnitude: 72, unit: "PT" }, marginBottom: { magnitude: 72, unit: "PT" }, marginLeft: { magnitude: 72, unit: "PT" }, marginRight: { magnitude: 72, unit: "PT" },
      },
    };
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
        const cellStart = i++;
        const content: docs_v1.Schema$StructuralElement[] = [];
        while (this.items[i] && !["cell", "row", "tend"].includes(this.items[i].k)) {
          if (this.items[i].k === "tbl") throw new Error("stub: nested tables are not modelled");
          const p = this.readParagraph(i);
          content.push(p.element);
          i = p.end;
        }
        tableCells.push({ startIndex: cellStart, endIndex: i, content, tableCellStyle: {} });
      }
      tableRows.push({ startIndex: rowStart, endIndex: i, tableCells });
    }
    if (this.items[i]?.k !== "tend") throw new Error(`stub: table at ${start} has no end`);
    i++;
    return { element: { startIndex: start, endIndex: i, table: { rows: tableRows.length, columns: tbl.columns, tableRows, tableStyle: { tableColumnProperties: Array.from({ length: tbl.columns }, () => ({ width: { magnitude: 468 / tbl.columns, unit: "PT" } })) } } }, end: i };
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

  /** Style of inserted text: the character before it in the paragraph, else the one after */
  private inheritedStyle(i: number): TextStyle {
    const prev = this.items[i - 1];
    if (prev && (prev.k === "c" || prev.k === "pb")) return clone(prev.ts);
    const next = this.items[i];
    if (next && (next.k === "c" || next.k === "pb" || next.k === "nl")) return clone(next.ts);
    return {};
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  batchUpdate(requests: Request[], requiredRevisionId?: string): void {
    if (requiredRevisionId && requiredRevisionId !== this.revisionId) {
      throw bad(`The document has been modified since the specified revision (${requiredRevisionId} vs ${this.revisionId}); the batch was not applied`);
    }
    // Atomic: all or nothing
    const before = { items: clone(this.items), lists: clone(this.lists) };
    try {
      for (const r of requests) this.apply(r);
    } catch (err) {
      this.items = before.items;
      this.lists = before.lists;
      throw err;
    }
    this.revision++;
  }

  private apply(r: Request): void {
    const [key] = Object.keys(r);
    if (r.insertText) return this.insertText(r.insertText.location.index, r.insertText.text);
    if (r.insertPageBreak) return this.insertPageBreak(r.insertPageBreak.location.index);
    if (r.insertTable) return this.insertTable(r.insertTable.location.index, r.insertTable.rows, r.insertTable.columns);
    if (r.deleteContentRange) return this.deleteContentRange(r.deleteContentRange.range.startIndex, r.deleteContentRange.range.endIndex);
    if (r.updateTextStyle) return this.updateTextStyle(r.updateTextStyle.range.startIndex, r.updateTextStyle.range.endIndex, r.updateTextStyle.textStyle, r.updateTextStyle.fields);
    if (r.updateParagraphStyle) return this.updateParagraphStyle(r.updateParagraphStyle.range.startIndex, r.updateParagraphStyle.range.endIndex, r.updateParagraphStyle.paragraphStyle, r.updateParagraphStyle.fields);
    if (r.createParagraphBullets) return this.createParagraphBullets(r.createParagraphBullets.range.startIndex, r.createParagraphBullets.range.endIndex, r.createParagraphBullets.bulletPreset);
    if (r.deleteParagraphBullets) return this.deleteParagraphBullets(r.deleteParagraphBullets.range.startIndex, r.deleteParagraphBullets.range.endIndex);
    throw bad(`The stub does not model ${key} requests`);
  }

  insertText(index: number, text: string): void {
    if (!text) return;
    this.assertInsertIndex(index);
    const ts = this.inheritedStyle(index);
    const end = this.items[this.paragraphEnd(index)] as Extract<Item, { k: "nl" }>;
    const fresh: Item[] = [];
    for (const ch of text) {
      if (ch === "\n") fresh.push({ k: "nl", ts: clone(ts), ps: clone(end.ps), ...(end.bullet ? { bullet: clone(end.bullet) } : {}) });
      else if (ch === "\r" || ch === "\u000C") continue; // Docs drops these from insertText
      else fresh.push({ k: "c", ch, ts: clone(ts) });
    }
    this.items.splice(index, 0, ...fresh);
  }

  insertPageBreak(index: number): void {
    this.assertInsertIndex(index);
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
    this.items.splice(start, end - start);
  }

  updateTextStyle(start: number, end: number, textStyle: TextStyle, fields: string): void {
    if (end <= start || start < 1 || end > this.items.length) throw bad(`Invalid range [${start}, ${end})`);
    const keys = fields.split(",").map((f) => f.trim()).filter(Boolean) as (keyof TextStyle)[];
    for (let i = start; i < end; i++) {
      const it = this.items[i];
      if (it.k !== "c" && it.k !== "pb" && it.k !== "nl") continue;
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
    // Last to first: removing a paragraph's leading tabs shifts everything after it
    for (const p of [...paragraphs].reverse()) {
      let tabs = 0;
      while (this.items[p.start + tabs]?.k === "c" && (this.items[p.start + tabs] as { ch: string }).ch === "\t") tabs++;
      this.items.splice(p.start, tabs);
      const nl = this.items[p.nl - tabs] as Extract<Item, { k: "nl" }>;
      nl.bullet = { listId, nestingLevel: Math.min(8, tabs) };
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
