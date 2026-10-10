import { test } from "node:test";
import assert from "node:assert/strict";
import { flowColumns, stackHeight, type FlowBlock } from "./column-flow";

const block = (height: number, marginTop = 0, marginBottom = 0): FlowBlock => ({ height, marginTop, marginBottom });
const blocks = (...heights: number[]) => heights.map((h) => block(h));
const pages = (first: number, full: number) => (k: number) => (k === 0 ? first : full);

test("stackHeight collapses adjoining margins like CSS siblings", () => {
  const b = [block(10, 4, 6), block(20, 2, 3), block(30, 8, 1)];
  assert.equal(stackHeight(b, 0, 0), 0);
  assert.equal(stackHeight(b, 0, 1), 4 + 10 + 6);
  // 6 vs 2 collapses to 6; 3 vs 8 collapses to 8
  assert.equal(stackHeight(b, 0, 3), 4 + 10 + 6 + 20 + 8 + 30 + 1);
  assert.equal(stackHeight(b, 1, 3), 2 + 20 + 8 + 30 + 1);
});

test("a section that fits the page is one balanced part with no forced column starts", () => {
  const parts = flowColumns(blocks(100, 100, 100), 2, pages(500, 500));
  assert.deepEqual(parts, [{ start: 0, end: 3, columnStarts: [], height: 300 }]);
});

test("fills column 1 to the page bottom, then column 2, then the next page", () => {
  // 10 blocks of 100px, 2 columns, 350px left on this page, 1000px pages after
  const parts = flowColumns(blocks(...Array(10).fill(100)), 2, pages(350, 1000));
  assert.equal(parts.length, 2);
  // Page 1: col 1 = blocks 0..2, col 2 = blocks 3..5 (3 each), tallest column 300
  assert.deepEqual(parts[0], { start: 0, end: 6, columnStarts: [3], height: 300 });
  // Page 2 holds the rest and is balanced by the browser
  assert.deepEqual(parts[1], { start: 6, end: 10, columnStarts: [], height: 400 });
});

test("text order is preserved across pages and columns", () => {
  const heights = [120, 80, 200, 60, 90, 150, 70, 300, 40, 40, 40];
  const parts = flowColumns(heights.map((h) => block(h)), 3, pages(260, 400));
  // Parts tile the blocks in order
  let next = 0;
  for (const p of parts) {
    assert.equal(p.start, next);
    assert.ok(p.end > p.start);
    for (const c of p.columnStarts) assert.ok(c > p.start && c < p.end);
    assert.deepEqual([...p.columnStarts], [...p.columnStarts].sort((a, b) => a - b));
    next = p.end;
  }
  assert.equal(next, heights.length);
  // Every forced column holds no more than its page allows (the last part is the browser's to balance)
  parts.slice(0, -1).forEach((p, k) => {
    const bounds = [p.start, ...p.columnStarts, p.end];
    for (let c = 0; c + 1 < bounds.length; c++) {
      const h = stackHeight(heights.map((x) => block(x)), bounds[c], bounds[c + 1]);
      if (bounds[c + 1] - bounds[c] > 1) assert.ok(h <= (k === 0 ? 260 : 400) + 0.5, `part ${k} column ${c}: ${h}`);
    }
  });
});

test("nothing fits what is left of the page: [] so the section starts on the next one", () => {
  assert.deepEqual(flowColumns(blocks(200, 50), 2, pages(100, 500)), []);
  // On a fresh page the same section fits
  assert.deepEqual(flowColumns(blocks(200, 50), 2, pages(500, 500)), [{ start: 0, end: 2, columnStarts: [], height: 250 }]);
});

test("a block taller than a page is placed alone rather than pushed down forever", () => {
  const parts = flowColumns(blocks(50, 2000, 50), 2, pages(500, 500));
  // 50 fits col 1; 2000 fits nowhere on this page, so page 1 ends; it then sits alone in page 2's first column
  assert.deepEqual(parts[0], { start: 0, end: 1, columnStarts: [], height: 50 });
  assert.deepEqual(parts[1], { start: 1, end: 3, columnStarts: [], height: 2000 });
  // With placeFirst the same happens on the first part
  assert.deepEqual(flowColumns(blocks(2000, 50), 2, pages(100, 500), true), [{ start: 0, end: 2, columnStarts: [], height: 2000 }]);
  assert.deepEqual(flowColumns(blocks(2000, 50), 2, pages(100, 500), false), []);
});

test("later pages use their own capacity (footnotes shorten a page)", () => {
  const caps = [300, 500, 200];
  const parts = flowColumns(blocks(...Array(12).fill(100)), 2, (k) => caps[Math.min(k, caps.length - 1)]);
  // Page 1: 3+3, page 2: 5+1 (the rest fits page 2's two columns)
  assert.deepEqual(parts.map((p) => [p.start, p.end, p.columnStarts]), [[0, 6, [3]], [6, 12, []]]);
  const more = flowColumns(blocks(...Array(20).fill(100)), 2, (k) => caps[Math.min(k, caps.length - 1)]);
  assert.deepEqual(more.map((p) => [p.start, p.end, p.columnStarts]), [[0, 6, [3]], [6, 16, [11]], [16, 20, []]]);
});

test("margins count toward the column height", () => {
  // 3 blocks of 100 with 20px above each: 100 | 20+100+20+100 = 240 > 230, so the second column starts at block 1
  const parts = flowColumns([block(100, 20), block(100, 20), block(100, 20), block(100, 20)], 2, pages(230, 230));
  assert.deepEqual(parts.map((p) => [p.start, p.end, p.columnStarts]), [[0, 2, [1]], [2, 4, []]]);
});
