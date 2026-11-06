import { test } from "node:test";
import assert from "node:assert/strict";
import { listLabels, presetGlyph } from "./list-labels";

test("lists made in the editor are numbered per level in their Docs style", () => {
  const n = (level: number, preset = "NUMBERED_DECIMAL_ALPHA_ROMAN") => ({ list: "ordered", level, preset });
  assert.deepEqual(listLabels([n(0), n(1), n(1), n(2), n(0), n(1)]), ["1.", "a.", "b.", "i.", "2.", "a."]);
  assert.deepEqual(listLabels([n(0, "NUMBERED_DECIMAL_NESTED"), n(1, "NUMBERED_DECIMAL_NESTED"), n(1, "NUMBERED_DECIMAL_NESTED"), n(2, "NUMBERED_DECIMAL_NESTED")]), ["1.", "1.1.", "1.2.", "1.2.1."]);
  assert.deepEqual(listLabels([n(0, "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL"), n(1, "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL"), n(0, "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL")]), ["I.", "A.", "II."]);
  assert.deepEqual(listLabels([{ list: "bullet", level: 0, preset: "BULLET_ARROW_DIAMOND_DISC" }, { list: "bullet", level: 1, preset: "BULLET_ARROW_DIAMOND_DISC" }, { list: "bullet", level: 3, preset: "BULLET_ARROW_DIAMOND_DISC" }]), ["➔", "◆", "➔"]);
  assert.equal(presetGlyph("BULLET_DISC_CIRCLE_SQUARE", 4), "○");
  // A new list of another style starts counting again
  assert.deepEqual(listLabels([n(0), n(0, "NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS")]), ["1.", "1)"]);
});

test("new items right after a Docs list in the same style count on from it, as the sync adds them to it", () => {
  const doc = (n: number) => ({ list: "ordered", listId: "kix.a", level: 0, glyph: { type: "DECIMAL", format: "%0.", start: 1 }, n });
  const mine = (level = 0, preset = "NUMBERED_DECIMAL_ALPHA_ROMAN") => ({ list: "ordered", level, preset });
  // Docs: createParagraphBullets adds paragraphs to the list right before them when its style matches
  assert.deepEqual(listLabels([doc(1), doc(2), mine(), mine(1), mine()]), ["1.", "2.", "3.", "a.", "4."]);
  // Another style, or a paragraph in between: a list of their own
  assert.deepEqual(listLabels([doc(1), doc(2), mine(0, "NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS")]), ["1.", "2.", "1)"]);
  assert.deepEqual(listLabels([doc(1), {}, mine()]), ["1.", null, "1."]);
  // The Docs list goes on counting after them
  assert.deepEqual(listLabels([doc(1), mine(), doc(3)]), ["1.", "2.", "3."]);
});

test("a list item's next line (a pasted line break) keeps its list counting, as Docs numbers the items around it", () => {
  const n = (level = 0) => ({ list: "ordered", level, preset: "NUMBERED_DECIMAL_ALPHA_ROMAN" });
  const cont = { listCont: true };
  assert.deepEqual(listLabels([n(), cont, n(), cont, cont, n(1), n()]), ["1.", null, "2.", null, null, "a.", "3."]);
  // Any other paragraph ends the list
  assert.deepEqual(listLabels([n(), {}, n()]), ["1.", null, "1."]);
  assert.deepEqual(listLabels([n(), cont, {}, n()]), ["1.", null, null, "1."]);
});
