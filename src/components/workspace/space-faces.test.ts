import { test } from "node:test";
import assert from "node:assert/strict";
import { covers, screenStack, spaceRules } from "./space-faces";

test("a unicode-range covers the code points of its ranges, single points and wildcards", () => {
  // Google Fonts' latin subset, and its cyrillic one
  const latin = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
  assert.equal(covers(latin, 0x20), true);
  assert.equal(covers(latin, 0xa0), true);
  assert.equal(covers("U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116", 0x20), false);
  assert.equal(covers("U+00??", 0x20), true);
  assert.equal(covers("U+01??", 0x20), false);
  assert.equal(covers("u+20", 0x20), true);
  assert.equal(covers("not a range", 0x20), false);
});

test("the page draws a family with its space face first; a name it can't quote safely keeps its own stack", () => {
  assert.equal(screenStack("Arial"), '"SS Space Arial", Arial, Arimo, "Liberation Sans", sans-serif');
  assert.equal(screenStack("Source Sans 3"), '"SS Space Source Sans 3", "Source Sans 3", Arial, Arimo, "Liberation Sans", sans-serif');
  assert.equal(screenStack('Bad"Name'), '"BadName", Arial, Arimo, "Liberation Sans", sans-serif');
});

test("no rules are written where there is no document", () => {
  assert.deepEqual(spaceRules(["Arial"]), []);
});
