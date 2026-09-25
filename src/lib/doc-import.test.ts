import { test } from "node:test";
import assert from "node:assert/strict";
import type { docs_v1 } from "googleapis";
import { anchorPosition, importDoc, indexedText } from "./doc-import";
import { additions, PENDING_MARK } from "./doc-model";
import { listLabels } from "./list-labels";

/** Build a documents.get body from paragraphs, assigning indices like Docs does */
function makeDoc(paras: { text: string; bullet?: { listId: string; nestingLevel?: number }; style?: docs_v1.Schema$TextStyle; image?: boolean }[], extra: Partial<docs_v1.Schema$Document> = {}): docs_v1.Schema$Document {
  const content: docs_v1.Schema$StructuralElement[] = [{ endIndex: 1, sectionBreak: {} }];
  let i = 1;
  for (const p of paras) {
    const start = i;
    const elements: docs_v1.Schema$ParagraphElement[] = [];
    if (p.image) {
      elements.push({ startIndex: i, endIndex: i + 1, inlineObjectElement: { inlineObjectId: "img1" } });
      i += 1;
    }
    const run = p.text + "\n";
    elements.push({ startIndex: i, endIndex: i + run.length, textRun: { content: run, textStyle: p.style ?? {} } });
    i += run.length;
    content.push({ startIndex: start, endIndex: i, paragraph: { elements, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, ...(p.bullet ? { bullet: p.bullet } : {}) } });
  }
  return { revisionId: "rev1", body: { content }, ...extra };
}

const lists = {
  q: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }, { glyphType: "ALPHA", glyphFormat: "%1." }] } },
  b: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
};

test("imports paragraphs as editable nodes, numbering questions across the answers between them", () => {
  const doc = makeDoc(
    [
      { text: "Logistics:", style: { underline: true } },
      { text: "What is your phone number?", bullet: { listId: "q" } },
      { text: "845" },
      { text: "Where will you be?", bullet: { listId: "q" } },
      { text: "If not, when?", bullet: { listId: "q", nestingLevel: 1 } },
      { text: "In NYC." },
      { text: "Are you available?", bullet: { listId: "q" } },
      { text: "A point", bullet: { listId: "b" } },
    ],
    { lists }
  );
  const out = importDoc(doc);
  assert.equal(out.empty, false);
  assert.equal(out.revisionId, "rev1");
  assert.equal(out.nodes.length, 8);
  assert.ok(out.nodes.every((n) => !n.attrs?.locked));
  const labels = listLabels(out.nodes.map((n) => n.attrs ?? {}));
  assert.deepEqual(labels, [null, "1.", null, "2.", "a.", null, "3.", "●"]);
  assert.deepEqual(out.nodes.map((n) => n.attrs?.list ?? null), [null, "ordered", null, "ordered", "ordered", null, "ordered", "bullet"]);
  assert.deepEqual(out.nodes[0].content, [{ type: "text", text: "Logistics:", marks: [{ type: "underline" }] }]);
});

test("an empty document imports as empty", () => {
  const out = importDoc(makeDoc([{ text: "" }, { text: "  " }]));
  assert.equal(out.empty, true);
  assert.equal(out.nodes.length, 2);
});

test("images show with their Google address and size", () => {
  const doc = makeDoc([{ text: "Pic", image: true }], {
    inlineObjects: { img1: { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: "https://lh3.googleusercontent.com/x" }, size: { width: { magnitude: 150, unit: "PT" }, height: { magnitude: 75, unit: "PT" } } } } } },
  });
  const out = importDoc(doc);
  assert.deepEqual(out.nodes[0].content?.[0], { type: "image", attrs: { src: "https://lh3.googleusercontent.com/x", width: 200, height: 100 } });
});

test("index-aligned text and anchor validation", () => {
  const doc = makeDoc([{ text: "Ab" }, { text: "Cd" }]);
  const chars = indexedText(doc);
  assert.equal(chars, "\0Ab\nCd\n");
  assert.equal(anchorPosition(chars, { mode: "after", at: 4 }), 4);
  assert.equal(anchorPosition(chars, { mode: "before", at: 4 }), 4);
  assert.equal(anchorPosition(chars, { mode: "before", at: 1 }), 1);
  assert.equal(anchorPosition(chars, { mode: "after", at: 7 }), 7);
  assert.equal(anchorPosition(chars, { mode: "after", at: 3 }), null, "not the end of a paragraph");
  assert.equal(anchorPosition(chars, { mode: "before", at: 2 }), null, "not the start of a paragraph");
  assert.equal(anchorPosition(chars, { mode: "before", at: 7 }), null, "past the last paragraph");
});

test("tables are locked and keep the indices after them right", () => {
  const doc: docs_v1.Schema$Document = {
    revisionId: "r",
    body: {
      content: [
        { endIndex: 1, sectionBreak: {} },
        { startIndex: 1, endIndex: 4, paragraph: { elements: [{ startIndex: 1, endIndex: 4, textRun: { content: "Hi\n" } }] } },
        { startIndex: 4, endIndex: 12, table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 6, endIndex: 10, paragraph: { elements: [{ startIndex: 6, endIndex: 10, textRun: { content: "Cel\n" } }] } }] }] }] } },
        { startIndex: 12, endIndex: 16, paragraph: { elements: [{ startIndex: 12, endIndex: 16, textRun: { content: "Bye\n" } }] } },
      ],
    },
  };
  const out = importDoc(doc);
  assert.equal(out.nodes.length, 3);
  assert.equal(out.nodes[1].attrs?.locked, true);
  assert.equal(out.nodes[1].attrs?.span, 8);
  // Text added at the end of "Bye" goes before its newline at index 15
  const base = { type: "doc", content: out.nodes };
  const target = { type: "doc", content: [out.nodes[0], out.nodes[1], { ...out.nodes[2], content: [...(out.nodes[2].content ?? []), { type: "text", text: "!", marks: [{ type: PENDING_MARK }] }] }] };
  assert.deepEqual(additions(base, target).segments.map((x) => x.at), [15]);
});

test("a list item added after a Docs item continues its numbering; a new list starts at 1", () => {
  const q = { list: "ordered", listId: "q", level: 0, glyph: { type: "DECIMAL", format: "%0." } };
  assert.deepEqual(
    listLabels([q, { list: null }, q, { ...q }, { list: null }, { list: "ordered" }, { list: "ordered" }, { list: "bullet" }]),
    ["1.", null, "2.", "3.", null, "1.", "2.", "\u25CF"]
  );
});
