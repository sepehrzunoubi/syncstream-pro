import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import type { CompareSide, CompareTab, TabCompare } from "@/lib/compare-types";
import type { EditorNode } from "@/lib/rich-text";
import { BREAK_MARK, PENDING_MARK } from "@/lib/doc-model";
import { editorExtensions } from "../workspace/extensions";
import { tokenPositions } from "../workspace/pagination";
import { anchorPairs, isDefaultTabTitle, keptLine, mapOffset, tabStatus, targetFor, targetValue, tokenRange, typedText, unsupportedLine } from "./compare-view";
import { parseDocRef } from "./doc-link";
import { FOCUS_MAX_AGE_MS, parseSession, readFocusHandoff } from "./storage";
import { tabContent } from "../../../e2e/fixtures/google-doc";

const ADD = [{ type: PENDING_MARK }];
const para = (...content: EditorNode[]): EditorNode => ({ type: "paragraph", content });
const text = (t: string, marks?: EditorNode["marks"]): EditorNode => ({ type: "text", text: t, ...(marks ? { marks } : {}) });

const tab = (id: string, title: string, texts: string[], extra: Partial<CompareTab> = {}): CompareTab => ({ id, title, level: 0, parentId: null, index: 0, doc: tabContent(texts), ...extra });
const side = (tabs: CompareTab[]): CompareSide => ({ documentId: "d", name: "Doc", revisionId: "r", tabs });

const compareTab = (over: Partial<TabCompare>): TabCompare => ({
  rightTabId: "R1", rightTitle: "Intro", target: { kind: "tab", leftTabId: "L1" }, base: { type: "doc", content: [] }, merged: { type: "doc", content: [] }, origin: [],
  changes: [], kept: [], unsupported: [], rightCopied: [],
  stats: { words: 0, images: 0, tables: 0, footnotes: 0, changes: 0, skipped: 0, presentPct: 100 }, ...over,
});
const change = (id: string, kind: "text" | "rename" = "text") => ({ id, kind, rightTabId: "R1", words: 3, preview: "three new words", where: "after “Intro”", when: "typed" as const, merged: null, right: null });

test("a Docs link, a Drive link or a bare id gives the document id; anything else gives none", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
  assert.equal(parseDocRef(id), id);
  assert.equal(parseDocRef(`https://docs.google.com/document/d/${id}/edit?tab=t.0#heading=h.1`), id);
  assert.equal(parseDocRef(`docs.google.com/document/u/1/d/${id}/edit`), id);
  assert.equal(parseDocRef(`https://drive.google.com/file/d/${id}/view`), id);
  assert.equal(parseDocRef(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(parseDocRef("Quarterly report"), null);
  assert.equal(parseDocRef(`https://example.com/document/d/${id}/edit`), null);
  assert.equal(parseDocRef("https://docs.google.com/document/d/short/edit"), null);
  assert.equal(parseDocRef("   "), null);
});

test("a tab's status: additions, a new tab, up to date, not copied", () => {
  const none = new Set<string>();
  assert.deepEqual(tabStatus(compareTab({ changes: [change("a"), change("b")] }), none), { label: "2 additions", tone: "add" });
  assert.deepEqual(tabStatus(compareTab({ changes: [change("a")] }), none), { label: "1 addition", tone: "add" });
  assert.deepEqual(tabStatus(compareTab({ changes: [change("a"), change("b")] }), new Set(["a", "b"])), { label: "Nothing to copy", tone: "done" });
  assert.deepEqual(tabStatus(compareTab({}), none), { label: "Up to date", tone: "done" });
  assert.deepEqual(tabStatus(compareTab({ target: { kind: "new", title: "Intro", parentRightTabId: null }, changes: [change("a")] }), none), { label: "New tab", tone: "new" });
  assert.deepEqual(tabStatus(compareTab({ target: { kind: "skip" } }), none), { label: "Not copied", tone: "off" });
  assert.deepEqual(tabStatus(compareTab({ changes: [change("r", "rename")] }), none), { label: "Small changes", tone: "add" });
});

test("a target select round-trips, and a blank default tab takes the reference tab's name", () => {
  const ref = tab("R1", "Introduction", ["Hello"], { emoji: "📘" });
  const left = side([tab("L1", "Tab 1", []), tab("L2", "Notes", ["Mine"])]);
  assert.deepEqual(targetFor("tab:L1", ref, left), { kind: "tab", leftTabId: "L1", rename: "Introduction" });
  assert.deepEqual(targetFor("tab:L2", ref, left), { kind: "tab", leftTabId: "L2" });
  assert.deepEqual(targetFor("new", ref, left), { kind: "new", title: "Introduction", emoji: "📘", parentRightTabId: null });
  assert.deepEqual(targetFor("skip", ref, left), { kind: "skip" });
  assert.equal(targetFor("tab:gone", ref, left), null);
  assert.equal(targetValue({ kind: "tab", leftTabId: "L2" }), "tab:L2");
  assert.equal(targetValue({ kind: "new", title: "x", parentRightTabId: null }), "new");
  assert.ok(isDefaultTabTitle("Tab 3") && isDefaultTabTitle("Untitled tab") && !isDefaultTabTitle("Tab of contents"));
});

test("what is left alone and what can't be copied read as plain sentences", () => {
  assert.equal(keptLine({ kind: "formatting", rightTabId: "R1", leftTabId: "L1", count: 2 }), "2 parts with the same words but a different look keep your look");
  assert.equal(keptLine({ kind: "spelling", rightTabId: "R1", leftTabId: "L1", count: 1 }), "1 word spelled a little differently isn't typed again");
  assert.equal(keptLine({ kind: "header", rightTabId: "R1", leftTabId: "L1", count: 1 }), "Your header stays as it is");
  assert.equal(unsupportedLine({ kind: "chip", rightTabId: "R1", count: 3, asText: true }), "3 smart chips: copied as their text");
  assert.equal(unsupportedLine({ kind: "rule", rightTabId: "R1", count: 1 }), "1 horizontal line: Google Docs gives no way to add it, so it's skipped");
});

test("the typed text is the pending text, paragraph by paragraph, and a break starts after its word", () => {
  const brk = (m: number) => [{ type: PENDING_MARK }, { type: BREAK_MARK, attrs: { minutes: m } }];
  const doc: EditorNode = { type: "doc", content: [
    para(text("Kept "), text("new words", ADD)),
    para(text("Own line")),
    para(text("Second ", ADD), text("part", brk(10)), text(" goes on", ADD)),
  ] };
  const { text: t, anchors } = typedText([doc]);
  assert.equal(t, "new words\nSecond part goes on\n");
  assert.deepEqual(anchors, [{ at: t.indexOf("goes"), minutes: 10 }]);
  // A break on the very last word has nothing after it
  const last: EditorNode = { type: "doc", content: [para(text("Only ", ADD), text("end", brk(5)))] };
  assert.deepEqual(typedText([last]).anchors, []);
});

test("anchor pairs follow copied runs in order on both sides", () => {
  assert.deepEqual(anchorPairs([-1, -1, 5, 6, 7, -1, 12, 13]), [[2, 5], [5, 8], [6, 12], [8, 14]]);
  assert.deepEqual(anchorPairs([-1, -1]), []);
  assert.equal(anchorPairs(Array.from({ length: 5000 }, (_, i) => (i % 2 ? i * 3 : -1)), 100).length, 100);
});

test("a token range lands on the words it covers on the page", () => {
  const schema = getSchema(editorExtensions);
  const json: EditorNode = { type: "doc", content: [para(text("Hello ")), para(text("big", ADD), text(" world"))] };
  const doc = PMNode.fromJSON(schema, json);
  const positions = tokenPositions(doc);
  // Tokens: H e l l o ␣ ⏎ b i g ␣ w o r l d ⏎ → "big" is tokens 7..10
  const r = tokenRange(positions, [7, 10], doc.content.size)!;
  assert.equal(doc.textBetween(r.from, r.to), "big");
  assert.equal(tokenRange(positions, null, doc.content.size), null);
});

test("an offset between anchors maps in proportion, the pane ends included", () => {
  assert.equal(mapOffset(50, [100], [300], 200, 400), 150);
  assert.equal(mapOffset(150, [100], [300], 200, 400), 350);
  assert.equal(mapOffset(100, [], [], 1000, 2000), 200);
});

test("a stored session is read defensively", () => {
  const s = parseSession(JSON.stringify({
    left: { id: "L", name: "Mine" }, right: { id: "" }, skip: ["a", 3], tabMap: { R1: { kind: "tab", leftTabId: "L1" }, R2: { kind: "bogus" } },
    breaks: [{ rightTabId: "R1", rightToken: 4, minutes: 10 }, { rightTabId: "R1", rightToken: -1, minutes: 5 }], settings: { breaksMode: "manual", typoFrequency: 9 },
  }));
  assert.deepEqual(s.left, { id: "L", name: "Mine" });
  assert.equal(s.right, null);
  assert.deepEqual(s.skip, ["a"]);
  assert.deepEqual(s.tabMap, { R1: { kind: "tab", leftTabId: "L1" } });
  assert.deepEqual(s.breaks, [{ rightTabId: "R1", rightToken: 4, minutes: 10 }]);
  assert.equal(s.settings.breaksMode, "manual");
  assert.equal(s.settings.typoFrequency, 1);
  assert.equal(parseSession("{not json").left, null);
});

test("the editor takes a sync handoff only while it is fresh", () => {
  const now = 1_000_000;
  const raw = (at: number) => JSON.stringify({ documentId: "D", jobId: "J", at });
  assert.deepEqual(readFocusHandoff(raw(now - 5_000), now), { documentId: "D", jobId: "J", at: now - 5_000 });
  assert.equal(readFocusHandoff(raw(now - FOCUS_MAX_AGE_MS - 1), now), null);
  assert.equal(readFocusHandoff(raw(now + 60_000), now), null);
  assert.equal(readFocusHandoff("garbage", now), null);
  assert.equal(readFocusHandoff(null, now), null);
});
