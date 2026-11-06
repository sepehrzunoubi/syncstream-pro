/**
 * The Docs batchUpdate requests the editor's direct edits may send: POST /api/docs/edit takes these
 * and nothing else. Every request directEdits (text, formatting, lists, breaks, footnotes, images and
 * table structure), segmentEdits (headers and footers) and the page setup make is one of them.
 */
export const EDIT_REQUESTS: ReadonlySet<string> = new Set([
  "updateTextStyle",
  "updateParagraphStyle",
  "deleteContentRange",
  "insertText",
  "insertInlineImage",
  "createParagraphBullets",
  "deleteParagraphBullets",
  "updateDocumentStyle",
  "insertPageBreak",
  "insertSectionBreak",
  "createHeader",
  "createFooter",
  "deleteHeader",
  "deleteFooter",
  "createFootnote",
  "updateSectionStyle",
  // Table structure: a new table, rows and columns added or removed (a removed table is a deleteContentRange)
  "insertTable",
  "insertTableRow",
  "insertTableColumn",
  "deleteTableRow",
  "deleteTableColumn",
  // A cell's background (a pasted table's)
  "updateTableCellStyle",
]);
