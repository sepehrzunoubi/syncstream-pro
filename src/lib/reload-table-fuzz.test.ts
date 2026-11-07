/**
 * Reloading a table a collaborator changed, fuzzed. A page has a table (2x2 to 4x4, cells from a few
 * words that repeat, empty ones too) and one addition in a cell. The document then gets one change from
 * a collaborator: a row or column added or deleted, two columns swapped, one moved, or another cell's
 * text edited (never the addition's own cell). The reload (rebase) must leave the document as Google
 * has it, with the addition once, in the cell it was typed in, where that cell is now, at the same
 * place in its text.
 *
 * Where the change could have been another one that gives the same document (two rows that read the
 * same, one of them deleted; a new empty row next to an empty row), the cell that one leaves the
 * addition in is right too: nothing on the page tells them apart. Cases where the addition's own row
 * or column was deleted have nowhere to go and are left out.
 *
 * The seeds are fixed, so a run is the same every time. To hunt with more:
 * RELOAD_FUZZ_SEEDS=1-50000 npx tsx --test src/lib/reload-table-fuzz.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rebase, tokenize, PENDING_MARK } from "./doc-model";
import type { EditorNode } from "./rich-text";

/** A cell: its text, and which of the page's cells it is (-1: one the change made) */
type Cell = { text: string; origin: number };
type Grid = Cell[][];
type Change =
  | { kind: "insertRow" | "deleteRow" | "insertColumn" | "deleteColumn"; at: number }
  | { kind: "swapColumns"; a: number; b: number }
  | { kind: "moveColumn"; from: number; to: number }
  | { kind: "editCell"; row: number; column: number; text: string };

const WORDS = ["a", "b", "a b", ""];
const ADDED = "!";

/** mulberry32 */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function apply(grid: Grid, change: Change): Grid {
  const rows = grid.map((r) => r.slice());
  const empty = (): Cell => ({ text: "", origin: -1 });
  switch (change.kind) {
    case "insertRow": rows.splice(change.at, 0, rows[0].map(empty)); return rows;
    case "deleteRow": rows.splice(change.at, 1); return rows;
    case "insertColumn": return rows.map((r) => { r.splice(change.at, 0, empty()); return r; });
    case "deleteColumn": return rows.map((r) => { r.splice(change.at, 1); return r; });
    case "swapColumns": return rows.map((r) => { [r[change.a], r[change.b]] = [r[change.b], r[change.a]]; return r; });
    case "moveColumn": return rows.map((r) => { const [c] = r.splice(change.from, 1); r.splice(change.to, 0, c); return r; });
    case "editCell": rows[change.row][change.column] = { ...rows[change.row][change.column], text: change.text }; return rows;
  }
}

/** Every change to rows and columns a table of this size can get (a move to the next place is a swap) */
function reshapes(rows: number, columns: number): Change[] {
  const out: Change[] = [];
  for (let at = 0; at <= rows; at++) out.push({ kind: "insertRow", at });
  if (rows > 1) for (let at = 0; at < rows; at++) out.push({ kind: "deleteRow", at });
  for (let at = 0; at <= columns; at++) out.push({ kind: "insertColumn", at });
  if (columns > 1) for (let at = 0; at < columns; at++) out.push({ kind: "deleteColumn", at });
  for (let a = 0; a < columns; a++) for (let b = a + 1; b < columns; b++) out.push({ kind: "swapColumns", a, b });
  for (let from = 0; from < columns; from++) for (let to = 0; to < columns; to++) if (Math.abs(to - from) > 1) out.push({ kind: "moveColumn", from, to });
  return out;
}

const texts = (grid: Grid) => JSON.stringify(grid.map((r) => r.map((c) => c.text)));
const placeOf = (grid: Grid, origin: number): string | null => {
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) if (grid[r][c].origin === origin) return `${r},${c}`;
  return null;
};

/** Where the addition's cell is after each change (or none) that gives the document Google has, leaving that cell's text as it was */
function rightPlaces(before: Grid, after: Grid, origin: number): string[] {
  const out = new Set<string>();
  const consider = (grid: Grid) => {
    const at = texts(grid) === texts(after) ? placeOf(grid, origin) : null;
    if (at) out.add(at);
  };
  consider(before);
  for (const change of reshapes(before.length, before[0].length)) consider(apply(before, change));
  if (before.length === after.length && before[0].length === after[0].length) {
    const edited = before.flatMap((r, row) => r.flatMap((c, column) => (c.text !== after[row][column].text ? [{ row, column }] : [])));
    if (edited.length === 1 && before[edited[0].row][edited[0].column].origin !== origin) consider(apply(before, { kind: "editCell", ...edited[0], text: after[edited[0].row][edited[0].column].text }));
  }
  return [...out];
}

const paragraph = (content: EditorNode[]): EditorNode => ({ type: "paragraph", attrs: {}, content });
const text = (s: string, added = false): EditorNode[] => (s ? [added ? { type: "text", text: s, marks: [{ type: PENDING_MARK }] } : { type: "text", text: s }] : []);

/** The document with the table, its ids as Docs reads them (by place); with the addition in one cell, the page */
function docOf(grid: Grid, addition?: { row: number; column: number; offset: number }): EditorNode {
  const table: EditorNode = {
    type: "table",
    attrs: { tid: "t1", span: 1 },
    content: grid.map((cells, r) => ({
      type: "tableRow",
      attrs: { rid: `t1r${r}`, span: 1 },
      content: cells.map((cell, c) => {
        const here = addition?.row === r && addition.column === c;
        const content = here ? [...text(cell.text.slice(0, addition.offset)), ...text(ADDED, true), ...text(cell.text.slice(addition.offset))] : text(cell.text);
        return { type: "tableCell", attrs: { cid: `t1c${c}`, span: 1 }, content: [paragraph(content)] };
      }),
    })),
  };
  return { type: "doc", content: [paragraph(text("Intro")), table, paragraph(text("After"))] };
}

interface Case { before: Grid; after: Grid; change: Change; addition: { row: number; column: number; offset: number }; origin: number; kind: string }

function caseOf(seed: number): Case | null {
  const next = random(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)];
  const rows = 2 + Math.floor(next() * 3);
  const columns = 2 + Math.floor(next() * 3);
  let n = 0;
  const before: Grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ text: pick(WORDS), origin: n++ })));
  const row = Math.floor(next() * rows);
  const column = Math.floor(next() * columns);
  const offset = Math.floor(next() * (before[row][column].text.length + 1));
  const origin = before[row][column].origin;
  let change: Change;
  if (next() < 0.15) {
    const others = before.flatMap((r, ri) => r.flatMap((_c, ci) => (ri !== row || ci !== column ? [[ri, ci]] : [])));
    const [er, ec] = pick(others);
    change = { kind: "editCell", row: er, column: ec, text: pick(WORDS.filter((w) => w !== before[er][ec].text)) };
  } else change = pick(reshapes(rows, columns));
  const after = apply(before, change);
  if (!placeOf(after, origin)) return null;
  return { before, after, change, addition: { row, column, offset }, origin, kind: kindOf(change, row, column) };
}

function kindOf(change: Change, row: number, column: number): string {
  switch (change.kind) {
    case "insertRow": return change.at <= row ? "row above" : "row below";
    case "deleteRow": return change.at < row ? "row above deleted" : "row below deleted";
    case "insertColumn": return change.at <= column ? "column before" : "column after";
    case "deleteColumn": return change.at < column ? "column before deleted" : "column after deleted";
    case "swapColumns": return change.a === column || change.b === column ? "its column swapped" : "other columns swapped";
    case "moveColumn": return change.from === column ? "its column moved" : "another column moved";
    case "editCell": return "another cell edited";
  }
}

/** Where the reload put the addition: "row,column" of its cell, with the text right there, or what went wrong */
function landed(k: Case): string {
  const out = tokenize(rebase(docOf(k.after), docOf(k.before, k.addition)));
  const reads = (tokens: ReturnType<typeof tokenize>) => tokens.map((t) => (t.k === "c" ? t.c : t.k === "nl" ? "\n" : t.k === "st" ? `<${t.kind}>` : "?")).join("");
  if (reads(out.filter((t) => !(t.k === "c" && t.pending))) !== reads(tokenize(docOf(k.after)))) return "the document's text changed";
  const found: { at: string; text: string }[] = [];
  let r = -1;
  let c = -1;
  let inCell = false;
  let cell = "";
  for (const t of out) {
    if (t.k === "st") {
      if (t.kind === "row") { r++; c = -1; }
      if (t.kind === "cell") { c++; cell = ""; }
      if (t.kind === "cellEnd" && cell.includes("[")) found.push({ at: `${r},${c}`, text: cell });
      inCell = t.kind === "cell";
    } else if (t.k === "c" && t.pending && !inCell) return "outside the table";
    else if (t.k === "c" && inCell) cell += t.pending ? `[${t.c}]` : t.c;
  }
  if (!found.length) return "dropped";
  if (found.length > 1 || found[0].text.split("[").length !== 2) return `more than once: ${found.map((f) => f.at).join(" ")}`;
  const own = k.before[k.addition.row][k.addition.column].text;
  const want = `${own.slice(0, k.addition.offset)}[${ADDED}]${own.slice(k.addition.offset)}`;
  return found[0].text === want ? found[0].at : `${found[0].at}, at another place in its text (${found[0].text})`;
}

function seeds(): number[] {
  const range = /^(\d+)-(\d+)$/.exec(process.env.RELOAD_FUZZ_SEEDS ?? "");
  if (range) return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, k) => Number(range[1]) + k);
  return Array.from({ length: 2000 }, (_, k) => k + 1);
}

test("a reload puts the addition in the cell it was typed in, wherever a collaborator's change to the table moved it", () => {
  const failures: string[] = [];
  const kinds = new Map<string, number>();
  for (const seed of seeds()) {
    const k = caseOf(seed);
    if (!k) continue;
    kinds.set(k.kind, (kinds.get(k.kind) ?? 0) + 1);
    const got = landed(k);
    const right = rightPlaces(k.before, k.after, k.origin);
    if (!right.includes(got)) {
      const grid = (g: Grid) => JSON.stringify(g.map((row) => row.map((c) => c.text)));
      failures.push(`seed ${seed} (${k.kind}): ${JSON.stringify(k.change)}, the addition at ${k.addition.row},${k.addition.column} of ${grid(k.before)}, Google has ${grid(k.after)}: ${got}, not ${right.join(" or ")}`);
    }
  }
  // Every kind of change is tried
  for (const kind of ["row above", "row below", "row above deleted", "row below deleted", "column before", "column after", "column before deleted", "column after deleted", "its column swapped", "other columns swapped", "its column moved", "another column moved", "another cell edited"]) {
    assert.ok((kinds.get(kind) ?? 0) >= 20, `${kind}: tried ${kinds.get(kind) ?? 0} times`);
  }
  assert.deepEqual(failures.slice(0, 20), []);
});
