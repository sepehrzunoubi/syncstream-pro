import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAGE_SETUP, documentStyleRequest, pageGeometry, pageSetupFromDocumentStyle, parsePageSetup, pageSize } from "./page-setup";

test("a Google Doc's documentStyle becomes a page setup and back", () => {
  const ds = {
    pageSize: { width: { magnitude: 841.9, unit: "PT" }, height: { magnitude: 595.3, unit: "PT" } },
    marginTop: { magnitude: 57.6, unit: "PT" }, marginBottom: { magnitude: 57.6, unit: "PT" },
    marginLeft: { magnitude: 57.6, unit: "PT" }, marginRight: { magnitude: 57.6, unit: "PT" },
    background: { color: { color: { rgbColor: { red: 1, green: 0.9490196, blue: 0.8 } } } },
  };
  const s = pageSetupFromDocumentStyle(ds);
  assert.equal(s.paper, "a4");
  assert.equal(s.orientation, "landscape");
  assert.deepEqual(s.margins, { top: 57.6, bottom: 57.6, left: 57.6, right: 57.6 });
  assert.equal(s.color, "#fff2cc");
  const req = documentStyleRequest(s).updateDocumentStyle as { documentStyle: { pageSize: { width: { magnitude: number }; height: { magnitude: number } }; marginLeft: { magnitude: number } }; fields: string };
  assert.equal(req.documentStyle.pageSize.width.magnitude, 841.9);
  assert.equal(req.documentStyle.pageSize.height.magnitude, 595.3);
  assert.equal(req.documentStyle.marginLeft.magnitude, 57.6);
  assert.match(req.fields, /background/);
  // A doc with no documentStyle is Letter with 1in margins
  assert.deepEqual(pageSetupFromDocumentStyle(undefined), DEFAULT_PAGE_SETUP);
  assert.deepEqual(pageSetupFromDocumentStyle({ pageSize: { width: { magnitude: 612 }, height: { magnitude: 792 } } }), DEFAULT_PAGE_SETUP);
});

test("page setups are validated and measured", () => {
  assert.deepEqual(parsePageSetup({ ...DEFAULT_PAGE_SETUP, color: "#FFFFFF" }), DEFAULT_PAGE_SETUP);
  assert.equal(parsePageSetup({ ...DEFAULT_PAGE_SETUP, paper: "napkin" }), null);
  assert.equal(parsePageSetup({ ...DEFAULT_PAGE_SETUP, margins: { top: 72, bottom: 72, left: 400, right: 400 } }), null, "no room for text");
  assert.deepEqual(parsePageSetup({ ...DEFAULT_PAGE_SETUP, margins: { top: -5, bottom: 9999, left: 57.6, right: 57.6 } })?.margins, { top: 0, bottom: 720, left: 57.6, right: 57.6 });
  assert.deepEqual(pageSize({ ...DEFAULT_PAGE_SETUP, orientation: "landscape" }), { w: 792, h: 612 });
  assert.deepEqual(pageGeometry(DEFAULT_PAGE_SETUP), { w: 816, h: 1056, top: 96, bottom: 96, left: 96, right: 96 });
});
