/**
 * A Google Doc as `documents.get` returns it, built with Docs' own index
 * arithmetic (UTF-16 code units, body starting at 1, one index per table,
 * row and cell start, one per inline object, page break and footnote
 * reference). The tests run it through the app's real importer so the
 * fixture the browser receives is exactly what `/api/docs/content` would
 * send for such a document.
 */
import type { docs_v1 } from "googleapis";
import { importDoc, type ImportedDoc } from "../../src/lib/doc-import";

type Element = docs_v1.Schema$StructuralElement;
type ParagraphElement = docs_v1.Schema$ParagraphElement;
type TextStyle = docs_v1.Schema$TextStyle;

type Run = string | { text: string; style?: TextStyle } | { footnote: string } | { image: string } | "pageBreak";

interface ParagraphSpec {
  runs: Run[];
  named?: "TITLE" | "SUBTITLE" | "HEADING_1" | "HEADING_2" | "HEADING_3" | "NORMAL_TEXT";
  bullet?: { listId: string; nestingLevel?: number };
  align?: "START" | "CENTER" | "END" | "JUSTIFIED";
}

/** Where each labelled part of the fixture starts, as a Docs index */
export interface FixtureIndex {
  [label: string]: number;
}

export interface Fixture {
  doc: docs_v1.Schema$Document;
  /** Docs index of each labelled paragraph's first character */
  at: FixtureIndex;
}

const PT = (magnitude: number) => ({ magnitude, unit: "PT" });

/** Builds a document element by element, keeping Docs' running index */
class DocBuilder {
  private i = 1;
  readonly content: Element[] = [{ endIndex: 1, sectionBreak: { sectionStyle: { sectionType: "CONTINUOUS" } } }];
  readonly at: FixtureIndex = {};
  readonly footnotes: Record<string, docs_v1.Schema$Footnote> = {};
  readonly inlineObjects: Record<string, docs_v1.Schema$InlineObject> = {};

  private paragraphOf(spec: ParagraphSpec, start: number): { paragraph: docs_v1.Schema$Paragraph; end: number } {
    let i = start;
    const elements: ParagraphElement[] = [];
    for (const run of spec.runs) {
      if (run === "pageBreak") {
        elements.push({ startIndex: i, endIndex: i + 1, pageBreak: { textStyle: {} } });
        i += 1;
      } else if (typeof run === "string" || "text" in run) {
        const text = typeof run === "string" ? run : run.text;
        const textStyle = typeof run === "string" ? {} : run.style ?? {};
        elements.push({ startIndex: i, endIndex: i + text.length, textRun: { content: text, textStyle } });
        i += text.length;
      } else if ("footnote" in run) {
        const n = String(Object.keys(this.footnotes).length + 1);
        const footnoteId = `kix.fn${n}`;
        elements.push({ startIndex: i, endIndex: i + 1, footnoteReference: { footnoteId, footnoteNumber: n, textStyle: {} } });
        const fn = this.paragraphOf({ runs: [run.footnote + "\n"] }, 0);
        this.footnotes[footnoteId] = { footnoteId, content: [{ startIndex: 0, endIndex: fn.end, paragraph: fn.paragraph }] };
        i += 1;
      } else if ("image" in run) {
        const inlineObjectId = `kix.img${Object.keys(this.inlineObjects).length + 1}`;
        elements.push({ startIndex: i, endIndex: i + 1, inlineObjectElement: { inlineObjectId, textStyle: {} } });
        this.inlineObjects[inlineObjectId] = {
          objectId: inlineObjectId,
          inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: run.image }, size: { width: PT(96), height: PT(96) } } },
        };
        i += 1;
      }
    }
    // Every Docs paragraph ends with a newline run
    const last = elements[elements.length - 1];
    if (!last?.textRun?.content?.endsWith("\n")) {
      elements.push({ startIndex: i, endIndex: i + 1, textRun: { content: "\n", textStyle: {} } });
      i += 1;
    }
    const paragraphStyle: docs_v1.Schema$ParagraphStyle = { namedStyleType: spec.named ?? "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" };
    if (spec.align) paragraphStyle.alignment = spec.align;
    return { paragraph: { elements, paragraphStyle, ...(spec.bullet ? { bullet: spec.bullet } : {}) }, end: i };
  }

  paragraph(label: string | null, spec: ParagraphSpec): this {
    const start = this.i;
    if (label) this.at[label] = start;
    const { paragraph, end } = this.paragraphOf(spec, start);
    this.content.push({ startIndex: start, endIndex: end, paragraph });
    this.i = end;
    return this;
  }

  table(label: string, rows: string[][], columnWidthPt: number): this {
    const start = this.i;
    this.at[label] = start;
    let i = start + 1; // the table's own start
    const tableRows: docs_v1.Schema$TableRow[] = rows.map((cells) => {
      const rowStart = i;
      i += 1; // the row's start
      const tableCells: docs_v1.Schema$TableCell[] = cells.map((text) => {
        const cellStart = i;
        i += 1; // the cell's start
        const { paragraph, end } = this.paragraphOf({ runs: [text] }, i);
        const cell: docs_v1.Schema$TableCell = { startIndex: cellStart, endIndex: end, content: [{ startIndex: i, endIndex: end, paragraph }], tableCellStyle: {} };
        i = end;
        return cell;
      });
      i += 1; // the row's end
      return { startIndex: rowStart, endIndex: i, tableCells };
    });
    i += 1; // the table's end
    this.content.push({
      startIndex: start,
      endIndex: i,
      table: { rows: rows.length, columns: rows[0].length, tableRows, tableStyle: { tableColumnProperties: rows[0].map(() => ({ width: PT(columnWidthPt), widthType: "FIXED_WIDTH" })) } },
    });
    this.i = i;
    return this;
  }

  build(extra: Partial<docs_v1.Schema$Document> = {}): docs_v1.Schema$Document {
    return {
      documentId: FIXTURE_DOC_ID,
      title: FIXTURE_DOC_NAME,
      revisionId: "fixture-rev-1",
      body: { content: this.content },
      footnotes: this.footnotes,
      inlineObjects: this.inlineObjects,
      documentStyle: {
        pageSize: { width: PT(612), height: PT(792) },
        marginTop: PT(72),
        marginBottom: PT(72),
        marginLeft: PT(72),
        marginRight: PT(72),
        marginHeader: PT(36),
        marginFooter: PT(36),
      },
      namedStyles: {
        styles: [
          { namedStyleType: "NORMAL_TEXT", textStyle: { fontSize: PT(11), weightedFontFamily: { fontFamily: "Arial", weight: 400 } }, paragraphStyle: { lineSpacing: 115, spaceAbove: PT(0), spaceBelow: PT(0) } },
          { namedStyleType: "TITLE", textStyle: { fontSize: PT(26) }, paragraphStyle: { spaceBelow: PT(3) } },
          { namedStyleType: "HEADING_1", textStyle: { fontSize: PT(20) }, paragraphStyle: { spaceAbove: PT(20), spaceBelow: PT(6) } },
          { namedStyleType: "HEADING_2", textStyle: { fontSize: PT(16) }, paragraphStyle: { spaceAbove: PT(18), spaceBelow: PT(6) } },
        ],
      },
      lists: {
        "kix.bullets": { listProperties: { nestingLevels: [{ glyphSymbol: "●", indentFirstLine: PT(18), indentStart: PT(36) }, { glyphSymbol: "○", indentFirstLine: PT(54), indentStart: PT(72) }, { glyphSymbol: "■", indentFirstLine: PT(90), indentStart: PT(108) }] } },
        "kix.numbers": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0.", indentFirstLine: PT(18), indentStart: PT(36) }, { glyphType: "ALPHA", glyphFormat: "%1.", indentFirstLine: PT(54), indentStart: PT(72) }] } },
      },
      ...extra,
    };
  }
}

export const FIXTURE_DOC_ID = "1FixtureDocument0000000000000000000000000";
export const FIXTURE_DOC_NAME = "Field Notes on Transformation";

/** The paragraph the editing tests work in: plain text, nothing else on its line */
export const CLOSING_TEXT = "Closing thoughts on the whole program.";
export const LONG_BODY =
  "This one was interesting because the voice slowly stopped sounding completely human to me. I could still hear where some of the vocal sounds were coming from, but the electronics stretched them into unstable pitches that would swell and then become rougher. Some moments felt almost like a siren, while others were much quieter and more distant.";

/** The document most tests open: title, headings, nested lists, a table, an image, a page break and a footnote */
export function fixtureDocument(): Fixture {
  const b = new DocBuilder();
  b.paragraph("title", { runs: [FIXTURE_DOC_NAME], named: "TITLE" })
    .paragraph("intro", { runs: ["Notes on three works, with ", { text: "bold", style: { bold: true } }, ", ", { text: "italic", style: { italic: true } }, " and ", { text: "underlined", style: { underline: true } }, " words."] })
    .paragraph("h1", { runs: ["What I listened for"], named: "HEADING_1" })
    .paragraph("bullet1", { runs: ["Texture and resonance"], bullet: { listId: "kix.bullets" } })
    .paragraph("bullet2", { runs: ["How the voice changes"], bullet: { listId: "kix.bullets", nestingLevel: 1 } })
    .paragraph("bullet3", { runs: ["Silence between sounds"], bullet: { listId: "kix.bullets" } })
    .paragraph("h2", { runs: ["Program"], named: "HEADING_2" })
    .paragraph("num1", { runs: ["First piece, for voice and tape"], bullet: { listId: "kix.numbers" } })
    .paragraph("num2", { runs: ["Second piece, for strings"], bullet: { listId: "kix.numbers" } })
    .table("table", [["Work", "Duration"], ["Study I", "12 min"], ["Study II", "9 min"]], 234)
    .paragraph("image", { runs: [{ image: "/sync-icon.png" }] })
    .paragraph("break", { runs: ["Intermission notes", "pageBreak"] })
    .paragraph("footnote", { runs: ["The second work uses tape", { footnote: "Recorded in 1962 at the radio studio." }, "."] })
    .paragraph("closing", { runs: [CLOSING_TEXT] });
  return { doc: b.build(), at: b.at };
}

/** The same document imported the way the app imports it: the body of `/api/docs/content` */
export function fixtureContent(fixture: Fixture = fixtureDocument()): ImportedDoc {
  return importDoc(fixture.doc);
}

/** Plain editor paragraphs for drafts typed without a document (pagination tests) */
export function plainParagraphs(texts: string[]): Record<string, unknown>[] {
  return texts.map((text) => ({ type: "paragraph", attrs: {}, content: text ? [{ type: "text", text }] : [] }));
}
