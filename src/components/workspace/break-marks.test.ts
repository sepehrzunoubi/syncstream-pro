import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { editorExtensions } from "./extensions";
import { aBreakOf, breakRanges, breakRefusal, breakUiKey, breakUiPlugin, trackBreaks, wordAt } from "./break-marks";
import { mergeDocs } from "./use-docs-list";
import { snackDuration } from "./snack";
import { BREAK_MARK, PENDING_MARK } from "@/lib/doc-model";

// Manual breaks are marks on words; the list in the panel names each by an id that must survive
// typing around it, and the page shows them (and lets clicks through) only where it should

const schema = getSchema(editorExtensions);
const add = () => schema.marks[PENDING_MARK].create();
const brk = (minutes: number) => schema.marks[BREAK_MARK].create({ minutes });

/** "Old text. " then new words, the ones listed with a break after them */
function page(words: { text: string; minutes?: number }[]) {
  const runs = [schema.text("Old text. ")];
  words.forEach((w, i) => {
    runs.push(schema.text(w.text, w.minutes ? [add(), brk(w.minutes)] : [add()]));
    if (i < words.length - 1) runs.push(schema.text(" ", [add()]));
  });
  return schema.node("doc", null, [schema.node("paragraph", null, runs)]);
}

test("a break's phrase reads as English: the length as an adjective, and a/an", () => {
  assert.equal(aBreakOf(33), "A 33-minute break");
  assert.equal(aBreakOf(1), "A 1-minute break");
  assert.equal(aBreakOf(8), "An 8-minute break");
  assert.equal(aBreakOf(11), "An 11-minute break");
  assert.equal(aBreakOf(18), "An 18-minute break");
  assert.equal(aBreakOf(80), "A 1-hour 20-minute break");
  assert.equal(aBreakOf(60), "A 1-hour break");
  assert.equal(aBreakOf(480), "An 8-hour break");
  assert.equal(aBreakOf(65), "A 1-hour 5-minute break");
});

test("each break keeps its id while text is typed before it, and a new one gets a new id", () => {
  const doc = page([{ text: "alpha", minutes: 5 }, { text: "beta" }, { text: "gamma", minutes: 10 }]);
  let state = EditorState.create({ schema, doc, plugins: [breakUiPlugin()] });
  const first = breakUiKey.getState(state)!.ranges;
  assert.equal(first.length, 2);
  const ids = first.map((r) => r.id);
  assert.ok(ids.every((id) => typeof id === "number") && ids[0] !== ids[1]);
  // Typing before both moves them; the ids stay
  state = state.apply(state.tr.insertText("Typed ", 1));
  const moved = breakUiKey.getState(state)!.ranges;
  assert.deepEqual(moved.map((r) => r.id), ids);
  assert.deepEqual(moved.map((r) => r.from), first.map((r) => r.from + 6));
  // A break put on the word between: the others keep theirs
  const beta = state.doc.textContent.indexOf("beta") + 1;
  state = state.apply(state.tr.addMark(beta, beta + 4, brk(3)));
  const three = breakUiKey.getState(state)!.ranges;
  assert.equal(three.length, 3);
  assert.equal(three[0].id, ids[0]);
  assert.equal(three[2].id, ids[1]);
  assert.ok(three[1].id != null && !ids.includes(three[1].id));
  // The page replaced (another document): none of the old ids carry over
  state = state.apply(state.tr.replaceWith(0, state.doc.content.size, page([{ text: "alpha", minutes: 5 }]).content));
  const fresh = breakUiKey.getState(state)!.ranges;
  assert.equal(fresh.length, 1);
  assert.ok(!three.some((r) => r.id === fresh[0].id));
});

test("trackBreaks with no change gives every break an id once", () => {
  const doc = page([{ text: "one", minutes: 5 }, { text: "two", minutes: 5 }, { text: "three" }]);
  const a = trackBreaks([], null, doc);
  const b = trackBreaks(a, null, doc);
  assert.deepEqual(b, a);
  assert.deepEqual(a.map(({ from, to, minutes }) => ({ from, to, minutes })), breakRanges(doc));
});

test("the page's pills show in Manual only; the marks stay for when Manual is chosen again", () => {
  const doc = page([{ text: "alpha", minutes: 5 }, { text: "beta" }]);
  const plugin = breakUiPlugin();
  let state = EditorState.create({ schema, doc, plugins: [plugin] });
  const widgets = () => (plugin.props.decorations!.call(plugin, state) as DecorationSet).find().filter((d) => (d as unknown as { type: { toDOM?: unknown } }).type.toDOM).length;
  assert.equal(widgets(), 1);
  state = state.apply(state.tr.setMeta(breakUiKey, { showBreaks: false }));
  assert.equal(widgets(), 0);
  assert.equal(breakRanges(state.doc).length, 1);
});

test("only new text with more new text after it can take a break", () => {
  const doc = page([{ text: "alpha" }, { text: "beta" }]);
  const text = doc.textContent;
  const old = wordAt(doc, text.indexOf("Old") + 2)!;
  assert.equal(breakRefusal(doc, old.from, old.to), "Only new text can take a break");
  const alpha = wordAt(doc, text.indexOf("alpha") + 2)!;
  assert.equal(breakRefusal(doc, alpha.from, alpha.to), null);
  const beta = wordAt(doc, text.indexOf("beta") + 2)!;
  assert.equal(breakRefusal(doc, beta.from, beta.to), "Nothing is typed after the last word");
});

test("the docs list keeps documents made here and the one picked until Drive lists them", () => {
  const listed = [{ id: "a", name: "A", modifiedTime: "1" }];
  const made = [{ id: "new", name: "Untitled document", modifiedTime: "2" }];
  const before = [{ id: "old", name: "Old notes", modifiedTime: "0" }, ...listed];
  assert.deepEqual(mergeDocs(listed, made, before, "old").map((d) => d.id), ["new", "old", "a"]);
  // Listed already: not twice
  assert.deepEqual(mergeDocs([...made, ...listed], made, before, "new").map((d) => d.id), ["new", "a"]);
  // Not picked any more: only what is listed and made
  assert.deepEqual(mergeDocs(listed, [], before, "a").map((d) => d.id), ["a"]);
});

test("a message shows long enough to read; a problem stays until dismissed", () => {
  assert.equal(snackDuration("Sync started"), 6000);
  assert.ok(snackDuration("x".repeat(200))! > 6000);
  assert.ok(snackDuration("x".repeat(2000))! <= 15_000);
  assert.equal(snackDuration("Couldn't save that change to Google Docs"), null);
  assert.equal(snackDuration("Google didn't confirm the new document."), null);
});
