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
