import { test } from "node:test";
import assert from "node:assert/strict";
import type { docs_v1 } from "googleapis";
import { buildDripPlan } from "./drip-engine";
import { buildSyncRecords, MAX_COMPARE_SEGMENTS, MAX_SEGMENTS, parseSegments, planSegmentsOf, spotsFor, spotsForTabs, tabsOfSegments, type SegmentInput } from "./sync-plan";
import { indexedText } from "./doc-import";
import { openTab } from "./doc-tabs";
import type { RichFormat } from "./rich-text";

/** Plain text's formatting, as a client sends it (parseFormat fills in each paragraph's defaults) */
const fmt = (text: string) => ({ v: 1, paragraphs: Array.from({ length: text.split("\n").length }, () => ({})), runs: [{ len: text.length }] }) as unknown as RichFormat;
const seg = (at: number, text: string, tabId?: string, mode: "inline" | "before" = "inline"): SegmentInput => ({ at, mode, text, format: fmt(text), ...(tabId ? { tabId } : {}) });

test("segments that name their tab: each tab's together, top to bottom within it", () => {
  const ok = parseSegments([seg(9, " one", "t.a"), seg(20, " two", "t.a"), seg(1, "three", "t.b"), seg(4, " four", "t.c")]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.segments.map((s) => [s.tabId, s.at]), [["t.a", 9], ["t.a", 20], ["t.b", 1], ["t.c", 4]], "a new tab starts again from its own top");
  // A tab's segments split by another tab's
  assert.equal(parseSegments([seg(1, "a", "t.a"), seg(1, "b", "t.b"), seg(5, "c", "t.a")]).ok, false);
  // Going back up within a tab
  assert.equal(parseSegments([seg(9, "a", "t.a"), seg(3, "b", "t.a")]).ok, false);
  // Some naming a tab and some not
  assert.equal(parseSegments([seg(1, "a", "t.a"), seg(5, "b")]).ok, false);
  assert.equal(parseSegments([seg(1, "a"), seg(5, "b", "t.a")]).ok, false);
  // A tab id that isn't one
  assert.equal(parseSegments([seg(1, "a", "t a")]).ok, false);
  assert.equal(parseSegments([{ ...seg(1, "a"), tabId: "" }]).ok, false);
  assert.equal(parseSegments([{ ...seg(1, "a"), tabId: 5 }]).ok, false);
});

test("segments without tabs are checked as before, and the editor's limit stays", () => {
  const ok = parseSegments([seg(3, "a"), seg(3, "b"), seg(7, "c", undefined, "before")]);
  assert.ok(ok.ok);
  assert.equal(ok.segments.some((s) => "tabId" in s), false);
  assert.equal(parseSegments([seg(7, "a"), seg(3, "b")]).ok, false);
  const many = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => seg(1 + i, "x"));
  assert.equal(parseSegments(many).ok, false);
  assert.equal(parseSegments(many, { maxSegments: MAX_COMPARE_SEGMENTS }).ok, true);
  assert.equal(parseSegments(Array.from({ length: MAX_COMPARE_SEGMENTS + 1 }, (_, i) => seg(1 + i, "x")), { maxSegments: MAX_COMPARE_SEGMENTS }).ok, false);
});

test("the plan keeps each segment's tab; the job lists the tabs in typing order with their titles", () => {
  const segments = (parseSegments([seg(2, "ab", "t.b"), seg(5, "cd", "t.b"), seg(1, "ef", "t.a")]) as { segments: SegmentInput[] }).segments;
  assert.deepEqual(planSegmentsOf(segments).map((s) => [s.start, s.end, s.tabId]), [[0, 2, "t.b"], [2, 4, "t.b"], [4, 6, "t.a"]]);
  assert.deepEqual(tabsOfSegments(segments, [{ id: "t.a", title: "Alpha" }, { id: "t.b", title: "Beta" }]), [{ id: "t.b", title: "Beta" }, { id: "t.a", title: "Alpha" }]);
  const plan = buildDripPlan("abcdef", { seed: 1, breaks: [] });
  const records = (tabs?: { id: string; title: string }[]) => buildSyncRecords({
    id: "j", userId: "u", documentId: "d", documentName: "D", tabs, plan, format: fmt("abcdef") as never, segments, now: 0, accessToken: "a", refreshToken: "r", baselineWordCount: 0,
  });
  const { plan: stored, job } = records([{ id: "t.a", title: "Alpha" }, { id: "t.b", title: "Beta" }]);
  assert.deepEqual(stored.segments!.map((s) => s.tabId), ["t.b", "t.b", "t.a"]);
  assert.deepEqual(job.tabs, [{ id: "t.b", title: "Beta" }, { id: "t.a", title: "Alpha" }]);
  assert.equal(job.tabId, "t.b", "the first tab typed into is the job's tab");
  assert.equal(job.tabTitle, "Beta");
  // A one-tab job has no list of tabs
  const single = buildSyncRecords({ id: "j", userId: "u", documentId: "d", documentName: "D", tab: { id: "t.0", title: "" }, plan, format: fmt("abcdef") as never, segments: [seg(1, "abcdef")], now: 0, accessToken: "a", refreshToken: "r", baselineWordCount: 0 }).job;
  assert.equal(single.tabs, undefined);
  assert.equal(single.tabId, "t.0");
});

/** A tab whose body is these paragraphs (Docs indices from 1) */
function tab(id: string, paragraphs: string[], bulleted = false): docs_v1.Schema$Tab {
  let at = 1;
  const content: docs_v1.Schema$StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {} } }];
  for (const p of paragraphs) {
    const text = `${p}\n`;
    content.push({ startIndex: at, endIndex: at + text.length, paragraph: { elements: [{ startIndex: at, endIndex: at + text.length, textRun: { content: text } }], ...(bulleted ? { bullet: { listId: "l1" } } : {}) } });
    at += text.length;
  }
  return { tabProperties: { tabId: id, title: id }, documentTab: { body: { content }, lists: { l1: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } } } } };
}

test("spots are found tab by tab: what a tab's earlier segments type moves only that tab's later ones", () => {
  const doc: docs_v1.Schema$Document = { documentId: "d", revisionId: "r", tabs: [tab("t.a", ["Alpha one", "Alpha two"]), tab("t.b", ["Beta one", "Beta two"], true)] };
  const segments: SegmentInput[] = [seg(10, " more", "t.a"), seg(20, " and more", "t.a"), seg(9, " too", "t.b"), seg(10, "New", "t.b", "before")];
  const spots = spotsForTabs(doc, segments)!;
  assert.deepEqual(spots.map((s) => [s.tabId, s.cursor]), [["t.a", 10], ["t.a", 25], ["t.b", 9], ["t.b", 14]]);
  assert.equal(spots[1].ctx, "\0Alpha one more\nAlpha two", "the context is the tab's text as it will be once the earlier segments are typed");
  assert.equal(spots[2].ctx, "\0Beta one", "and starts again in the next tab");
  assert.deepEqual(spots[2].docList, { type: "bullet", start: -1, level: 0 }, "each tab's own lists");
  assert.equal(spots[0].docList, undefined);
  // The same as spotsFor in each tab on its own
  const b = openTab(doc, "t.b")!.doc;
  const untabbed = spots.slice(2).map((s) => {
    const copy = { ...s };
    delete copy.tabId;
    return copy;
  });
  assert.deepEqual(untabbed, spotsFor(b, indexedText(b), segments.slice(2)));
  // A tab that's gone, or a position that isn't on a paragraph any more: the document changed
  assert.equal(spotsForTabs(doc, [seg(1, "x", "t.gone")]), null);
  assert.equal(spotsForTabs(doc, [seg(3, "x", "t.a", "before")]), null);
  // Segments without a tab go into the first tab
  assert.deepEqual(spotsForTabs(doc, [seg(10, " more")])!.map((s) => [s.tabId, s.cursor]), [[undefined, 10]]);
});
