import { test } from "node:test";
import assert from "node:assert/strict";
import type { docs_v1 } from "googleapis";
import { exportGlyphs, nameLists, unnamedLists } from "./list-glyphs";
import { importDoc } from "./doc-import";

/** Docs' export styles each level of each list, each rule more than once, in its own order */
const EXPORT = [
  '<style type="text/css">',
  '.lst-kix_old1-1>li:before{content:"\\0025cb   "}.lst-kix_old1-0>li:before{content:"\\0025cf   "}.lst-kix_old1-2>li:before{content:"\\0025a0   "}',
  '.lst-kix_check1-0>li:before{content:"\\0025cf   "}.lst-kix_check1-1>li:before{content:"\\0025cf   "}.lst-kix_check1-2>li:before{content:"\\0025cf   "}',
  '.lst-kix_num1-0>li:before{content:"" counter(lst-ctn-kix_num1-0,decimal) ". "}',
  '.lst-kix_old1-0>li:before{content:"\\0025cf   "}.lst-kix_dash1-0>li:before{content:"-  "}',
  "</style>",
].join("");

test("the export's glyph for each level of each list, by list id; a numbered level has none", () => {
  const g = exportGlyphs(EXPORT);
  assert.deepEqual(g.get("kix.old1"), ["●", "○", "■"]);
  assert.deepEqual(g.get("kix.check1"), ["●", "●", "●"]);
  assert.deepEqual(g.get("kix.num1"), [null]);
  assert.deepEqual(g.get("kix.dash1"), ["-"]);
  assert.equal(exportGlyphs("<p>no lists</p>").size, 0);
});

/** A document whose lists the API gives no glyph for at any level (an older preset's, a checklist's), and a named one */
function doc(): docs_v1.Schema$Document {
  const unnamed = (): docs_v1.Schema$List => ({ listProperties: { nestingLevels: [0, 1, 2].map((n) => ({ glyphFormat: `%${n}`, indentStart: { magnitude: 36 * (n + 1), unit: "PT" }, indentFirstLine: { magnitude: 36 * n + 18, unit: "PT" } })) } });
  const item = (at: number, text: string, listId: string, nestingLevel = 0): docs_v1.Schema$StructuralElement => ({
    startIndex: at, endIndex: at + text.length + 1,
    paragraph: { bullet: { listId, nestingLevel }, elements: [{ startIndex: at, endIndex: at + text.length + 1, textRun: { content: `${text}\n`, textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } },
  });
  return {
    documentId: "d",
    body: { content: [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }, item(1, "Top", "kix.old1"), item(5, "Under", "kix.old1", 1), item(11, "Todo", "kix.check1"), item(16, "Named", "kix.new1")] },
    lists: {
      "kix.old1": unnamed(),
      "kix.check1": unnamed(),
      "kix.new1": { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
      "kix.unused": unnamed(),
    },
  };
}

const types = (d: docs_v1.Schema$Document) => importDoc(d).nodes.filter((n) => n.attrs?.list).map((n) => [n.content?.[0]?.text, n.attrs?.list]);

test("an unnamed list the export draws as bullets reads as bullets with its glyphs; one it draws all ● stays a checklist", () => {
  const d = doc();
  const ids = unnamedLists(d);
  assert.deepEqual(ids.sort(), ["kix.check1", "kix.old1"], "only unnamed lists the paragraphs use");
  // As the API gives it, an unnamed list is a checklist
  assert.deepEqual(types(d), [["Top", "check"], ["Under", "check"], ["Todo", "check"], ["Named", "bullet"]]);
  assert.deepEqual(nameLists(d, exportGlyphs(EXPORT), ids), ["kix.old1"]);
  assert.deepEqual(d.lists!["kix.old1"].listProperties!.nestingLevels!.map((l) => l.glyphSymbol), ["●", "○", "■"]);
  assert.equal(d.lists!["kix.check1"].listProperties!.nestingLevels![0].glyphSymbol, undefined);
  assert.deepEqual(types(d), [["Top", "bullet"], ["Under", "bullet"], ["Todo", "check"], ["Named", "bullet"]]);
  // Each level keeps its own glyph
  const under = importDoc(d).nodes.find((n) => n.content?.[0]?.text === "Under")!;
  assert.equal((under.attrs?.glyph as { symbol?: string }).symbol, "○");
});

test("without the export, or with a list it doesn't style, nothing changes", () => {
  const d = doc();
  const before = structuredClone(d);
  assert.deepEqual(nameLists(d, new Map(), unnamedLists(d)), []);
  assert.deepEqual(nameLists(d, exportGlyphs('.lst-kix_other-0>li:before{content:"\\0025cb  "}'), unnamedLists(d)), []);
  assert.deepEqual(d, before);
});
