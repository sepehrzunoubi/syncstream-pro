/**
 * Comparing what the editor meant with what Google Docs has.
 *
 * Both sides become the same "shape": a list of blocks, each a paragraph
 * (named style, list kind and level, alignment, page breaks, and runs of
 * text with the marks a reader sees) or a table of cells of paragraphs.
 * Everything Docs decides on its own (indents, colours it adds to links,
 * run boundaries) is left out, so the comparison is about what was asked
 * for. A Report collects named PASS/FAIL lines.
 */

import { PENDING_MARK } from "../../src/lib/doc-model";
import { paragraphFromAttrs, styleFromMarks, type EditorNode } from "../../src/lib/rich-text";

export interface Run {
  text: string;
  b: boolean;
  i: boolean;
  /** Underline only when the run is not a link (Docs underlines links itself) */
  u: boolean;
  link: string | null;
}

export interface ParagraphBlock {
  kind: "p";
  style: string;
  list: string | null;
  level: number;
  align: string;
  pageBreaks: number;
  runs: Run[];
}

export interface TableBlock {
  kind: "table";
  /** rows → cells → paragraphs */
  rows: ParagraphBlock[][][];
}

export type Block = ParagraphBlock | TableBlock;

function runOf(node: EditorNode): Run | null {
  if (node.type !== "text" || typeof node.text !== "string") return null;
  const s = styleFromMarks((node.marks ?? []).filter((m) => m.type !== PENDING_MARK));
  return { text: node.text, b: !!s.b, i: !!s.i, u: !!s.u && !s.link, link: s.link ?? null };
}

const sameRun = (a: Run, b: Run) => a.b === b.b && a.i === b.i && a.u === b.u && a.link === b.link;

function paragraphBlock(node: EditorNode): ParagraphBlock {
  const p = paragraphFromAttrs(node.attrs);
  const runs: Run[] = [];
  let pageBreaks = 0;
  for (const child of node.content ?? []) {
    if (child.type === "pageBreak") { pageBreaks++; continue; }
    if (child.type === "hardBreak") { pushRun(runs, { text: "\u000b", b: false, i: false, u: false, link: null }); continue; }
    const r = runOf(child);
    if (r) pushRun(runs, r);
  }
  return { kind: "p", style: p.style, list: p.list ?? null, level: p.list ? p.level ?? 0 : 0, align: p.align, pageBreaks, runs };
}

function pushRun(runs: Run[], r: Run) {
  const last = runs[runs.length - 1];
  if (last && sameRun(last, r)) last.text += r.text;
  else runs.push({ ...r });
}

/** The comparable shape of an editor document (or a list of its blocks) */
export function shapeOf(doc: EditorNode | EditorNode[]): Block[] {
  const blocks = Array.isArray(doc) ? doc : doc.content ?? [];
  const out: Block[] = [];
  for (const node of blocks) {
    if (node.type === "columnSection") { out.push(...shapeOf(node.content ?? [])); continue; }
    if (node.type === "table") {
      out.push({
        kind: "table",
        rows: (node.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map(paragraphBlock))),
      });
      continue;
    }
    out.push(paragraphBlock(node));
  }
  return out;
}

/** Plain text of a shape: paragraphs on lines, page breaks as form feeds, tables as their cells joined by tabs */
export function plainTextOf(blocks: Block[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind === "table") {
      for (const row of b.rows) lines.push(row.map((cell) => cell.map((p) => p.runs.map((r) => r.text).join("")).join(" ")).join("\t"));
      continue;
    }
    lines.push(b.runs.map((r) => r.text).join("") + "\u000C".repeat(b.pageBreaks));
  }
  return lines.join("\n");
}

const show = (v: unknown) => JSON.stringify(v);

/** Human-readable differences between two shapes; empty when they are the same */
export function diffShapes(expected: Block[], actual: Block[]): string[] {
  const diffs: string[] = [];
  const n = Math.max(expected.length, actual.length);
  for (let k = 0; k < n; k++) {
    const e = expected[k];
    const a = actual[k];
    if (!e) { diffs.push(`block ${k}: unexpected extra ${a.kind === "p" ? `paragraph ${show(plainTextOf([a]))}` : "table"}`); continue; }
    if (!a) { diffs.push(`block ${k}: missing ${e.kind === "p" ? `paragraph ${show(plainTextOf([e]))}` : "table"}`); continue; }
    if (e.kind !== a.kind) { diffs.push(`block ${k}: expected a ${e.kind}, found a ${a.kind}`); continue; }
    if (e.kind === "table" && a.kind === "table") {
      if (e.rows.length !== a.rows.length) { diffs.push(`block ${k}: table has ${a.rows.length} rows, expected ${e.rows.length}`); continue; }
      e.rows.forEach((row, r) => {
        if (row.length !== a.rows[r].length) { diffs.push(`block ${k}: row ${r} has ${a.rows[r].length} cells, expected ${row.length}`); return; }
        row.forEach((cell, c) => {
          for (const d of diffShapes(cell, a.rows[r][c])) diffs.push(`block ${k} cell r${r}c${c}: ${d}`);
        });
      });
      continue;
    }
    if (e.kind === "p" && a.kind === "p") {
      const label = `paragraph ${k} (${show(plainTextOf([e]).slice(0, 40))})`;
      if (e.style !== a.style) diffs.push(`${label}: style ${a.style}, expected ${e.style}`);
      if (e.list !== a.list || e.level !== a.level) diffs.push(`${label}: list ${show(a.list)} level ${a.level}, expected ${show(e.list)} level ${e.level}`);
      if (e.align !== a.align) diffs.push(`${label}: alignment ${a.align}, expected ${e.align}`);
      if (e.pageBreaks !== a.pageBreaks) diffs.push(`${label}: ${a.pageBreaks} page break(s), expected ${e.pageBreaks}`);
      const et = e.runs.map((r) => r.text).join("");
      const at = a.runs.map((r) => r.text).join("");
      if (et !== at) diffs.push(`${label}: text ${show(at)}, expected ${show(et)}`);
      else if (show(e.runs) !== show(a.runs)) diffs.push(`${label}: runs ${show(a.runs)}, expected ${show(e.runs)}`);
    }
  }
  return diffs;
}

// ── Projections: one assertion per kind of thing ────────────────────────────

const paragraphs = (blocks: Block[]): ParagraphBlock[] => blocks.flatMap((b) => (b.kind === "p" ? [b] : b.rows.flat(2)));

/** Checks that together say whether `actual` is what `expected` asked for, each reported on its own */
export function compareShapes(report: Report, label: string, expected: Block[], actual: Block[]): boolean {
  const ep = paragraphs(expected);
  const ap = paragraphs(actual);
  const texts = (ps: ParagraphBlock[]) => ps.map((p) => p.runs.map((r) => r.text).join(""));
  const first = (a: string[], b: string[]) => {
    const k = a.findIndex((v, i) => v !== b[i]);
    const i = k < 0 ? Math.min(a.length, b.length) : k;
    return `at ${i}: ${show(b[i] ?? "<none>")}, expected ${show(a[i] ?? "<none>")}`;
  };
  const check = (name: string, project: (p: ParagraphBlock) => string, only?: (p: ParagraphBlock) => boolean) => {
    const e = ep.filter(only ?? (() => true)).map(project);
    const a = ap.filter(only ?? (() => true)).map(project);
    const ok = e.length === a.length && e.every((v, i) => v === a[i]);
    report.check(`${label}: ${name}`, ok, ok ? undefined : first(e, a));
    return ok;
  };
  let ok = true;
  ok = check("text equals expected", (p) => p.runs.map((r) => r.text).join("") || "<empty>") && ok;
  ok = check("named styles (headings) match", (p) => `${p.style}: ${texts([p])[0]}`, (p) => p.style !== "normal") && ok;
  ok = check("bold/italic/underline/link runs match", (p) => show(p.runs.filter((r) => r.b || r.i || r.u || r.link)), (p) => p.runs.some((r) => r.b || r.i || r.u || r.link)) && ok;
  ok = check("list items and nesting levels match", (p) => `${p.list} L${p.level}: ${texts([p])[0]}`, (p) => !!p.list) && ok;
  ok = check("page breaks match", (p) => `${p.pageBreaks} after ${texts([p])[0]}`, (p) => p.pageBreaks > 0) && ok;
  const tables = (blocks: Block[]) => blocks.filter((b): b is TableBlock => b.kind === "table").map((t) => t.rows.map((r) => r.map((c) => plainTextOf(c))));
  const et = tables(expected);
  const at = tables(actual);
  const tOk = show(et) === show(at);
  report.check(`${label}: tables match`, tOk, tOk ? undefined : `${show(at)}, expected ${show(et)}`);
  ok = tOk && ok;
  const all = diffShapes(expected, actual);
  report.check(`${label}: whole document matches`, all.length === 0, all.slice(0, 6).join("; "));
  return ok && all.length === 0;
}

// ── Report ──────────────────────────────────────────────────────────────────

export interface CheckResult { name: string; ok: boolean; detail?: string }

export class Report {
  readonly results: CheckResult[] = [];
  constructor(private readonly out: (line: string) => void = (l) => console.log(l)) {}
  section(title: string): void {
    this.out("");
    this.out(`── ${title}`);
  }
  info(line: string): void {
    this.out(`   ${line}`);
  }
  check(name: string, ok: boolean, detail?: string): boolean {
    this.results.push({ name, ok, ...(detail ? { detail } : {}) });
    this.out(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
    return ok;
  }
  /** A step that throws is one failed check */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const v = await fn();
      this.check(name, true);
      return v;
    } catch (err) {
      this.check(name, false, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }
  get failed(): number {
    return this.results.filter((r) => !r.ok).length;
  }
  get passed(): number {
    return this.results.filter((r) => r.ok).length;
  }
  summary(): string {
    return `${this.passed} passed, ${this.failed} failed`;
  }
}
