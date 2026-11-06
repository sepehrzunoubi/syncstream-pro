import { test } from "node:test";
import assert from "node:assert/strict";
import { docTabs, inTab, isTabId, openTab } from "./doc-tabs";

test("a request names its tab in every place Docs takes one, and those that name it themselves name it", () => {
  const requests = [
    { insertText: { location: { index: 5 }, text: "x" } },
    { updateTextStyle: { range: { startIndex: 1, endIndex: 3 }, textStyle: { bold: true }, fields: "bold" } },
    { insertTable: { endOfSegmentLocation: {}, rows: 1, columns: 1 } },
    { updateTableCellStyle: { tableRange: { tableCellLocation: { tableStartLocation: { index: 2 }, rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 1 }, tableCellStyle: {}, fields: "backgroundColor" } },
    { updateTableColumnProperties: { tableStartLocation: { index: 2 }, columnIndices: [0], tableColumnProperties: {}, fields: "width" } },
    { insertText: { location: { segmentId: "kix.h1", index: 0 }, text: "header" } },
    { updateDocumentStyle: { documentStyle: { marginTop: { magnitude: 36, unit: "PT" } }, fields: "marginTop" } },
    { deleteHeader: { headerId: "kix.h1" } },
    { createFootnote: { location: { index: 4 } } },
  ];
  const before = structuredClone(requests);
  const out = inTab(requests, "t.web") as unknown as Record<string, Record<string, unknown>>[];
  assert.deepEqual(requests, before, "the requests given are left as they are");
  assert.deepEqual(out[0].insertText.location, { index: 5, tabId: "t.web" });
  assert.deepEqual(out[1].updateTextStyle.range, { startIndex: 1, endIndex: 3, tabId: "t.web" });
  assert.deepEqual(out[1].updateTextStyle.textStyle, { bold: true }, "styles carry no tab");
  assert.deepEqual(out[2].insertTable.endOfSegmentLocation, { tabId: "t.web" });
  assert.deepEqual((out[3].updateTableCellStyle.tableRange as { tableCellLocation: { tableStartLocation: object } }).tableCellLocation.tableStartLocation, { index: 2, tabId: "t.web" });
  assert.deepEqual(out[4].updateTableColumnProperties.tableStartLocation, { index: 2, tabId: "t.web" });
  assert.deepEqual(out[5].insertText.location, { segmentId: "kix.h1", index: 0, tabId: "t.web" }, "a header is the tab's own");
  assert.equal(out[6].updateDocumentStyle.tabId, "t.web", "each tab has its own page setup");
  assert.equal(out[7].deleteHeader.tabId, "t.web");
  assert.deepEqual(out[8].createFootnote.location, { index: 4, tabId: "t.web" });
});

test("a new header or footer goes to its tab's own page style: another tab's through its first section break", () => {
  const [h, f] = inTab([{ createHeader: { type: "DEFAULT" } }, { createFooter: { type: "FIRST_PAGE" } }], "t.web", false) as unknown as Record<string, Record<string, unknown>>[];
  assert.deepEqual(h.createHeader, { type: "DEFAULT", sectionBreakLocation: { index: 0, tabId: "t.web" } });
  assert.deepEqual(f.createFooter, { type: "FIRST_PAGE", sectionBreakLocation: { index: 0, tabId: "t.web" } });
  // The first tab's: the document style, as for a document without tabs
  assert.deepEqual(inTab([{ createHeader: { type: "DEFAULT" } }], "t.0", true), [{ createHeader: { type: "DEFAULT" } }]);
  // A section's own: in its tab
  assert.deepEqual(inTab([{ createHeader: { type: "DEFAULT", sectionBreakLocation: { index: 40 } } }], "t.web", false), [{ createHeader: { type: "DEFAULT", sectionBreakLocation: { index: 40, tabId: "t.web" } } }]);
});

test("with no tab, requests go as they are", () => {
  const r = [{ insertText: { location: { index: 1 }, text: "x" } }];
  assert.equal(inTab(r, null), r);
  assert.equal(inTab(r, undefined), r);
  assert.equal(inTab(r, ""), r);
});

test("a document read with its tabs gives each tab where a document without tabs has its content; a missing tab is null", () => {
  const tab = (id: string, title: string, text: string, childTabs: object[] = [], level = 0) => ({
    tabProperties: { tabId: id, title, nestingLevel: level },
    documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] }, lists: { [`l-${id}`]: {} }, documentStyle: { marginTop: { magnitude: level, unit: "PT" } }, headers: { [`h-${id}`]: {} } },
    childTabs,
  });
  const doc = { documentId: "d", title: "T", revisionId: "r1", tabs: [tab("t.0", "One", "a\n"), tab("t.2", "Two", "b\n", [tab("t.3", "", "c\n", [], 1)])] };
  assert.deepEqual(docTabs(doc), [{ id: "t.0", title: "One", level: 0 }, { id: "t.2", title: "Two", level: 0 }, { id: "t.3", title: "Untitled tab", level: 1 }]);
  const kid = openTab(doc, "t.3")!;
  assert.equal(kid.tabId, "t.3");
  assert.equal(kid.first, false);
  assert.equal(kid.doc.body?.content?.[0].paragraph?.elements?.[0].textRun?.content, "c\n");
  assert.deepEqual(Object.keys(kid.doc.lists ?? {}), ["l-t.3"]);
  assert.deepEqual(Object.keys(kid.doc.headers ?? {}), ["h-t.3"]);
  assert.equal(kid.doc.documentStyle?.marginTop?.magnitude, 1);
  assert.equal(kid.doc.revisionId, "r1");
  assert.equal("tabs" in kid.doc, false);
  assert.equal(openTab(doc)!.tabId, "t.0");
  assert.equal(openTab(doc)!.first, true);
  assert.equal(openTab(doc, "t.9"), null);
  // Read without its tabs: as it is
  const legacy = { documentId: "d", body: { content: [] } };
  assert.deepEqual(openTab(legacy), { doc: legacy, tabs: [], tabId: null, first: true });
  assert.equal(openTab(legacy, "t.2"), null);
});

test("tab ids are checked before they reach Google", () => {
  for (const ok of ["t.0", "t.abc123", "t.9x_y-z"]) assert.equal(isTabId(ok), true, ok);
  for (const bad of ["", "t 0", "t/../x", "t.0&x=1", 5, null, "x".repeat(101)]) assert.equal(isTabId(bad), false, String(bad));
});
