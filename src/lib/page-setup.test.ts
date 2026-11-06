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

test("a size Docs' list doesn't have is kept exactly, and a flipped page shows the way Docs shows it", async () => {
  const { documentModeRequest, isPageless, samePageSetup } = await import("./page-setup");
  const dim = (magnitude: number) => ({ magnitude, unit: "PT" });
  // 7" x 10", which isn't in the list: shown and written back at that size, not as the closest paper
  const custom = pageSetupFromDocumentStyle({ pageSize: { width: dim(504), height: dim(720) } });
  assert.deepEqual(custom.custom, { w: 504, h: 720 });
  assert.deepEqual(pageSize(custom), { w: 504, h: 720 });
  const sent = (s: Parameters<typeof documentStyleRequest>[0]) => (documentStyleRequest(s).updateDocumentStyle as { documentStyle: { pageSize: { width: { magnitude: number }; height: { magnitude: number } } } }).documentStyle.pageSize;
  assert.deepEqual([sent(custom).width.magnitude, sent(custom).height.magnitude], [504, 720]);
  assert.deepEqual(pageSize({ ...custom, orientation: "landscape" }), { w: 720, h: 504 });
  // A4 as Docs stores it is A4
  assert.equal(pageSetupFromDocumentStyle({ pageSize: { width: dim(595.2756), height: dim(841.8898) } }).custom, undefined);
  // Landscape by flipping a portrait size: shown landscape, and written back portrait with the flip left alone
  const flipped = pageSetupFromDocumentStyle({ pageSize: { width: dim(612), height: dim(792) }, flipPageOrientation: true });
  assert.equal(flipped.orientation, "landscape");
  assert.deepEqual(pageSize(flipped), { w: 792, h: 612 });
  assert.deepEqual([sent(flipped).width.magnitude, sent(flipped).height.magnitude], [612, 792]);
  assert.doesNotMatch((documentStyleRequest(flipped).updateDocumentStyle as { fields: string }).fields, /flip/);
  // Both survive a round trip through storage and the API, and count as changes
  assert.deepEqual(parsePageSetup(JSON.parse(JSON.stringify(custom))), custom);
  assert.deepEqual(parsePageSetup(JSON.parse(JSON.stringify(flipped))), flipped);
  assert.equal(samePageSetup(custom, { ...custom, custom: undefined }), false);
  // Pageless
  assert.equal(isPageless({ documentFormat: { documentMode: "PAGELESS" } }), true);
  assert.equal(isPageless({}), false);
  assert.deepEqual(documentModeRequest(true), { updateDocumentStyle: { documentStyle: { documentFormat: { documentMode: "PAGELESS" } }, fields: "documentFormat.documentMode" } });
});
