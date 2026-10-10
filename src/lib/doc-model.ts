/**
 * The editor shows a Google Doc that can be edited freely. Two kinds of
 * change come out of it:
 *
 *  - Direct edits to what the document already has (formatting, deleting,
 *    splitting or joining paragraphs). These are saved to the Google Doc
 *    right away, like Docs itself autosaves.
 *  - Additions: text the user types or pastes. It carries the "syncAdd" mark
 *    (it glows) and is typed into the Google Doc by a sync, spot by spot,
 *    top to bottom.
 *
 * Both come from comparing the document as last saved (the base) with the
 * editor (the target), token by token. Everything here works on editor JSON
 * so it runs the same in the browser and in tests.
 */

import {
  bulletRequests,
  DEFAULT_PARAGRAPH,
  LINK_COLOR,
  OBJ,
  PAGE_BREAK,
  presetOf,
  paragraphFromAttrs,
  paragraphDelta,
  resolveTextStyle,
  rgb,
  sameStyle,
  styleFromMarks,
  textRequest,
  type DocsRequest,
  type EditorNode,
  type ImageRef,
  type ParagraphFormat,
  type RichFormat,
  type RunFormat,
  type RunStyle,
} from "./rich-text";

export const PENDING_MARK = "syncAdd";

type Marks = NonNullable<EditorNode["marks"]>;

export type Tok =
  | { k: "c"; c: string; marks: Marks; pending: boolean }
  | { k: "img"; attrs: Record<string, unknown>; marks: Marks; pending: boolean }
  | { k: "br"; marks: Marks; pending: boolean }
  /** A page break (one Docs index), always right before its paragraph's end */
  | { k: "pb"; marks: Marks; pending: boolean }
  /** A footnote reference (one Docs index); `fid` is null until Docs has created the footnote */
  | { k: "fn"; fid: string | null; attrs: Record<string, unknown> }
  /** End of a paragraph; carries the paragraph's attributes, like the newline does in Docs */
  | { k: "nl"; attrs: Record<string, unknown> }
  /** Something shown but not editable (a table of contents, a section break): `span` Docs indices */
  | { k: "block"; node: EditorNode }
  /**
   * The structure of a table: where the table, each row and each cell start
   * (each `span` Docs indices, as the document has them) and where they end
   * (no indices). Cell contents are ordinary paragraphs between them.
   */
  | { k: "st"; kind: "table" | "row" | "cell" | "cellEnd" | "rowEnd" | "tableEnd"; span: number; id: string; attrs: Record<string, unknown> };

const isPendingMarks = (marks: Marks | undefined) => !!marks?.some((m) => m.type === PENDING_MARK);
const withoutPending = (marks: Marks | undefined): Marks => (marks ?? []).filter((m) => m.type !== PENDING_MARK);
/** Only text, images and page breaks are additions; line breaks on their own are edits to the document */
const isPending = (t: Tok) => (t.k === "c" || t.k === "img" || t.k === "pb") && t.pending;

/** Size of a token in Docs indices */
function sizeOf(t: Tok): number {
  if (t.k === "block") return typeof t.node.attrs?.span === "number" ? (t.node.attrs.span as number) : 0;
  if (t.k === "st") return t.span;
  return 1;
}

const spanOf = (attrs: Record<string, unknown> | undefined, key: string, fallback: number) => (typeof attrs?.[key] === "number" ? (attrs[key] as number) : fallback);
let newTableSeq = 0;

export function tokenize(doc: EditorNode | null | undefined): Tok[] {
  const out: Tok[] = [];
  const paragraph = (node: EditorNode) => {
    if (node.attrs?.locked) {
      out.push({ k: "block", node });
      return;
    }
    for (const child of node.content ?? []) {
      const marks = child.marks ?? [];
      const pending = isPendingMarks(marks);
      if (child.type === "text" && typeof child.text === "string") {
        for (let i = 0; i < child.text.length; i++) out.push({ k: "c", c: child.text[i], marks, pending });
      } else if (child.type === "image") {
        out.push({ k: "img", attrs: child.attrs ?? {}, marks, pending });
      } else if (child.type === "hardBreak") {
        out.push({ k: "br", marks, pending });
      } else if (child.type === "pageBreak") {
        out.push({ k: "pb", marks, pending });
      } else if (child.type === "footnoteRef") {
        out.push({ k: "fn", fid: typeof child.attrs?.fid === "string" ? child.attrs.fid : null, attrs: child.attrs ?? {} });
      }
    }
    out.push({ k: "nl", attrs: node.attrs ?? {} });
  };
  // A column section only groups what follows a section break; its children are the document's blocks
  const blocks = flattenColumns(doc?.content ?? []);
  for (const node of blocks) {
    if (node.type !== "table") { paragraph(node); continue; }
    // A table: its start, then each row's start, each cell's start and content, with ends after each
    const tid = typeof node.attrs?.tid === "string" ? node.attrs.tid : `new${++newTableSeq}`;
    const rows = node.content ?? [];
    out.push({ k: "st", kind: "table", span: spanOf(node.attrs, "span", 1), id: tid, attrs: node.attrs ?? {} });
    rows.forEach((row, r) => {
      out.push({ k: "st", kind: "row", span: spanOf(row.attrs, "span", 1), id: `${tid}:r${r}`, attrs: row.attrs ?? {} });
      (row.content ?? []).forEach((cell, c) => {
        out.push({ k: "st", kind: "cell", span: spanOf(cell.attrs, "span", 1), id: `${tid}:r${r}c${c}`, attrs: cell.attrs ?? {} });
        const content = cell.content?.length ? cell.content : [{ type: "paragraph", attrs: {}, content: [] }];
        for (const p of content) paragraph(p);
        out.push({ k: "st", kind: "cellEnd", span: spanOf(cell.attrs, "endSpan", 0), id: `${tid}:r${r}c${c}/`, attrs: {} });
      });
      out.push({ k: "st", kind: "rowEnd", span: spanOf(row.attrs, "endSpan", 0), id: `${tid}:r${r}/`, attrs: {} });
    });
    out.push({ k: "st", kind: "tableEnd", span: spanOf(node.attrs, "endSpan", 0), id: `${tid}/`, attrs: {} });
  }
  return out;
}

const marksKey = (m: Marks) => JSON.stringify(m);

export function untokenize(tokens: Tok[]): EditorNode {
  const root: EditorNode[] = [];
  // Where blocks go: the document, or the open table cell
  const stack: EditorNode[][] = [root];
  const blocks = () => stack[stack.length - 1];
  let table: EditorNode | null = null;
  let row: EditorNode | null = null;
  let inline: EditorNode[] = [];
  let text = "";
  let textMarks: Marks | null = null;
  const flushText = () => {
    if (text) inline.push(textMarks && textMarks.length ? { type: "text", text, marks: textMarks } : { type: "text", text });
    text = "";
    textMarks = null;
  };
  const flushInline = () => {
    flushText();
    if (inline.length) blocks().push({ type: "paragraph", content: inline });
    inline = [];
  };
  for (const t of tokens) {
    if (t.k === "c") {
      if (textMarks && marksKey(textMarks) !== marksKey(t.marks)) flushText();
      textMarks = t.marks;
      text += t.c;
      continue;
    }
    flushText();
    if (t.k === "img") inline.push(t.marks.length ? { type: "image", attrs: t.attrs, marks: t.marks } : { type: "image", attrs: t.attrs });
    else if (t.k === "br") inline.push(t.marks.length ? { type: "hardBreak", marks: t.marks } : { type: "hardBreak" });
    else if (t.k === "pb") inline.push(t.marks.length ? { type: "pageBreak", marks: t.marks } : { type: "pageBreak" });
    else if (t.k === "fn") inline.push({ type: "footnoteRef", attrs: t.attrs });
    else if (t.k === "nl") {
      blocks().push({ type: "paragraph", attrs: t.attrs, content: inline });
      inline = [];
    } else if (t.k === "block") {
      flushInline();
      blocks().push(t.node);
    } else if (t.k === "st") {
      flushInline();
      if (t.kind === "table") { table = { type: "table", attrs: { ...t.attrs, tid: t.id, span: t.span }, content: [] }; root.push(table); }
      else if (t.kind === "row" && table) { row = { type: "tableRow", attrs: { ...t.attrs, span: t.span }, content: [] }; table.content!.push(row); }
      else if (t.kind === "cell" && row) { const cell: EditorNode = { type: "tableCell", attrs: { ...t.attrs, span: t.span }, content: [] }; row.content!.push(cell); stack.push(cell.content!); }
      else if (t.kind === "cellEnd") { if (stack.length > 1) { const cell = stack.pop()!; if (!cell.length) cell.push({ type: "paragraph", attrs: {}, content: [] }); const node = row?.content?.[row.content.length - 1]; if (node && t.span) node.attrs = { ...node.attrs, endSpan: t.span }; } }
      else if (t.kind === "rowEnd") { if (row && t.span) row.attrs = { ...row.attrs, endSpan: t.span }; row = null; }
      else if (t.kind === "tableEnd") { if (table && t.span) table.attrs = { ...table.attrs, endSpan: t.span }; table = null; }
    }
  }
  flushInline();
  while (stack.length > 1) { const cell = stack.pop()!; if (!cell.length) cell.push({ type: "paragraph", attrs: {}, content: [] }); }
  if (!root.length) root.push({ type: "paragraph" });
  return { type: "doc", content: groupColumns(root) };
}

const isSectionMarker = (n: EditorNode) => n.type === "paragraph" && n.attrs?.kind === "section";

/** The blocks after a section break with columns go in a column section, up to the next break */
/** The document's blocks with every column section opened up, however nested */
function flattenColumns(blocks: EditorNode[]): EditorNode[] {
  return blocks.flatMap((b) => (b.type === "columnSection" ? flattenColumns(b.content ?? []) : [b]));
}

export function groupColumns(blocks: EditorNode[]): EditorNode[] {
  const out: EditorNode[] = [];
  let open: EditorNode | null = null;
  for (const b of flattenColumns(blocks)) {
    if (isSectionMarker(b)) {
      open = null;
      out.push(b);
      const columns = typeof b.attrs?.columns === "number" ? b.attrs.columns : 1;
      if (columns > 1) {
        open = { type: "columnSection", attrs: { columns, spacing: typeof b.attrs?.spacing === "number" ? b.attrs.spacing : 36, line: b.attrs?.line === true }, content: [] };
        out.push(open);
      }
      continue;
    }
    if (open) open.content!.push(b);
    else out.push(b);
  }
  return out.filter((n) => n.type !== "columnSection" || (n.content?.length ?? 0) > 0);
}

/** The column layout of a section, as updateSectionStyle wants it */
export function sectionStyleRequest(attrs: Record<string, unknown>, startIndex: number, endIndex: number): DocsRequest {
  const columns = Math.max(1, Math.min(3, typeof attrs.columns === "number" ? attrs.columns : 1));
  const spacing = typeof attrs.spacing === "number" ? attrs.spacing : 36;
  const textWidth = typeof attrs.textWidth === "number" ? attrs.textWidth : 468;
  const width = Math.max(36, (textWidth - spacing * (columns - 1)) / columns);
  const columnProperties = Array.from({ length: columns }, (_, i) => ({ width: { magnitude: Math.round(width * 100) / 100, unit: "PT" }, paddingEnd: { magnitude: i < columns - 1 ? spacing : 0, unit: "PT" } }));
  return {
    updateSectionStyle: {
      range: { startIndex, endIndex },
      sectionStyle: { columnProperties: columns > 1 ? columnProperties : [], columnSeparatorStyle: columns > 1 && attrs.line === true ? "BETWEEN_EACH_COLUMN" : "NONE" },
      fields: "columnProperties,columnSeparatorStyle",
    },
  };
}

const columnKey = (attrs: Record<string, unknown> | undefined) => JSON.stringify([attrs?.columns ?? 1, attrs?.spacing ?? 36, attrs?.line === true]);

/** The document's characters and structure, ignoring formatting: equal when two copies read the same */
export function signature(doc: EditorNode | null | undefined): string {
  return tokenize(doc)
    .filter((t) => !isPending(t))
    .map((t) => (t.k === "c" ? t.c : t.k === "img" ? OBJ : t.k === "br" ? "\u000b" : t.k === "pb" ? PAGE_BREAK : t.k === "fn" ? "\u0001" : t.k === "nl" ? "\n" : t.k === "st" ? `\u0000${t.kind[0]}${t.span}\u0000` : `\u0000${sizeOf(t)}\u0000`))
    .join("");
}

/** True when the editor holds any addition */
export function hasPending(doc: EditorNode | null | undefined): boolean {
  return tokenize(doc).some(isPending);
}

/** True when the document has text of its own (not only additions) */
export function hasOriginalText(doc: EditorNode | null | undefined): boolean {
  return tokenize(doc).some((t) => (t.k === "c" && !t.pending && t.c.trim() !== "") || (t.k === "img" && !t.pending) || t.k === "block" || t.k === "st");
}

// ── Diff ────────────────────────────────────────────────────────────────────

function same(b: Tok, t: Tok): boolean {
  if (isPending(t) || b.k !== t.k) return false;
  switch (b.k) {
    case "c": return b.c === (t as typeof b).c;
    case "img": return b.attrs.src === (t as typeof b).attrs.src;
    case "block": return b.node.attrs?.bid === (t as typeof b).node.attrs?.bid;
    case "st": return b.kind === (t as typeof b).kind && b.id === (t as typeof b).id;
    case "fn": return b.fid === (t as typeof b).fid;
    default: return true;
  }
}

/**
 * For each target token, the base token it is the same as (or -1). Myers'
 * diff after trimming the common start and end; very different documents
 * fall back to replacing the middle.
 */
export function alignTokens(base: Tok[], target: Tok[], maxEdits = 4000): number[] {
  const match = new Array<number>(target.length).fill(-1);
  let pre = 0;
  while (pre < base.length && pre < target.length && same(base[pre], target[pre])) { match[pre] = pre; pre++; }
  let suf = 0;
  while (suf < base.length - pre && suf < target.length - pre && same(base[base.length - 1 - suf], target[target.length - 1 - suf])) {
    match[target.length - 1 - suf] = base.length - 1 - suf;
    suf++;
  }
  const a = base.slice(pre, base.length - suf);
  const b = target.slice(pre, target.length - suf);
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return match;

  // Myers O((n+m)·d), keeping each round's frontier to walk the path back
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(a[x], b[y])) { x++; y++; }
      next[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    v = next;
    if (found >= 0) { trace.push(v.slice()); break; }
  }
  if (found < 0) return match; // too different: everything in the middle changed

  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; match[pre + y] = pre + x; }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; match[pre + y] = pre + x; }
  return match;
}

interface Region {
  /** Base tokens [bs, be) that are gone */
  bs: number;
  be: number;
  /** Target tokens [ts, te) that are new */
  ts: number;
  te: number;
  pending: boolean;
}

/** Stretches between matched tokens where something changed */
function regionsOf(base: Tok[], target: Tok[], match: number[]): Region[] {
  const regions: Region[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < target.length) {
    if (j < target.length && match[j] === i && i < base.length) { i++; j++; continue; }
    const ts = j;
    while (j < target.length && match[j] < 0) j++;
    const nextBase = j < target.length ? match[j] : base.length;
    const bs = i;
    i = Math.max(i, nextBase);
    if (j > ts || i > bs) {
      const added = target.slice(ts, j);
      // Table structure and footnotes are always direct edits; the text inside a new table becomes an addition once the table exists
      const structural = (t: Tok) => t.k === "st" || t.k === "fn";
      regions.push({ bs, be: i, ts, te: j, pending: added.some(isPending) && !added.some(structural) && !base.slice(bs, i).some(structural) });
    }
  }
  return regions;
}

/**
 * Move an addition that ends with a paragraph break and starts right after
 * one to just before that break: "Enter at the end of a paragraph, then
 * type" rather than "type at the start of the next one", which keeps the
 * next paragraph's style out of the addition.
 */
function rotate(base: Tok[], target: Tok[], match: number[]): void {
  for (const r of regionsOf(base, target, match)) {
    if (r.be !== r.bs || r.te === r.ts || r.ts === 0 || r.bs === 0) continue;
    const last = target[r.te - 1];
    const before = target[r.ts - 1];
    if (last.k !== "nl" || before.k !== "nl") continue;
    if (match[r.ts - 1] !== r.bs - 1 || base[r.bs - 1].k !== "nl") continue;
    if (!r.pending) {
      // A direct edit only when both paragraphs are styled alike: otherwise the style of the wrong one would be sent
      if (JSON.stringify(paragraphFromAttrs(last.attrs)) !== JSON.stringify(paragraphFromAttrs(before.attrs))) continue;
      // Page and section breaks bring their own newline
      if (target.slice(r.ts, r.te).some((t) => t.k === "pb" || t.k === "block")) continue;
    }
    match[r.te - 1] = r.bs - 1;
    match[r.ts - 1] = -1;
  }
}

export function diff(base: Tok[], target: Tok[], forTyping = true, firstIndex = 1) {
  const match = alignTokens(base, target);
  if (forTyping) rotate(base, target, match);
  const regions = regionsOf(base, target, match);
  // Docs index of each base token (the body starts at 1, after its section break; segments at 0)
  const index = new Array<number>(base.length + 1);
  let at = firstIndex;
  for (let i = 0; i < base.length; i++) { index[i] = at; at += sizeOf(base[i]); }
  index[base.length] = at;
  return { match, regions, index };
}

/** Whether target paragraph ending at nl token j has additions in it */
function paragraphHasPending(target: Tok[], j: number): boolean {
  for (let q = j - 1; q >= 0; q--) {
    const t = target[q];
    if (t.k === "nl" || t.k === "block" || t.k === "st") return false;
    if (isPending(t)) return true;
  }
  return false;
}

// ── Table structure ─────────────────────────────────────────────────────────

interface TableShape { id: string; at: number; rows: { rid: string | null; cells: { cid: string | null }[] }[]; endAt: number }

/** The tables of a token list: where each starts, and its rows and columns by identity */
function tablesOf(tokens: Tok[], index?: number[]): TableShape[] {
  const out: TableShape[] = [];
  let cur: TableShape | null = null;
  tokens.forEach((t, i) => {
    if (t.k !== "st") return;
    if (t.kind === "table") { cur = { id: t.id, at: index ? index[i] : i, rows: [], endAt: 0 }; out.push(cur); }
    else if (t.kind === "row" && cur) cur.rows.push({ rid: typeof t.attrs.rid === "string" ? t.attrs.rid : null, cells: [] });
    else if (t.kind === "cell" && cur) cur.rows[cur.rows.length - 1]?.cells.push({ cid: typeof t.attrs.cid === "string" ? t.attrs.cid : null });
    else if (t.kind === "tableEnd" && cur) { cur.endAt = (index ? index[i] : i) + t.span; cur = null; }
  });
  return out;
}

/** Column identities of a table: the first cell with an id in each column */
function columnIds(shape: TableShape): (string | null)[] {
  const n = Math.max(0, ...shape.rows.map((r) => r.cells.length));
  return Array.from({ length: n }, (_, c) => shape.rows.map((r) => r.cells[c]?.cid ?? null).find((x) => x) ?? null);
}

/**
 * Requests that change table structure: whole tables added or removed, rows
 * and columns added or removed. Later tables first, and within a table
 * removals last to first, so indices stay valid. Text inside the tables is
 * saved on the next round, once the document has been read back.
 */
function tableStructureRequests(base: Tok[], target: Tok[], index: number[]): DocsRequest[] {
  const requests: DocsRequest[] = [];
  const baseTables = tablesOf(base, index);
  const targetTables = tablesOf(target);
  const byId = new Map(baseTables.map((t) => [t.id, t]));
  // Where a new table goes: the Docs index of the first base token at or after it
  const match = alignTokens(base, target);
  const docIndexAt = (j: number) => {
    const end = index[base.length];
    for (let q = j; q < target.length; q++) if (match[q] >= 0) return Math.min(index[match[q]], end - 1);
    return end - 1; // nothing goes after the final newline
  };
  const changes: { at: number; requests: DocsRequest[] }[] = [];
  for (const t of targetTables) {
    const b = byId.get(t.id);
    if (!b) {
      const rows = t.rows.length;
      const columns = Math.max(1, ...t.rows.map((r) => r.cells.length));
      changes.push({ at: docIndexAt(t.at), requests: [{ insertTable: { rows, columns, location: { index: docIndexAt(t.at) } } }] });
      continue;
    }
    const reqs: DocsRequest[] = [];
    const loc = (rowIndex: number, columnIndex: number) => ({ tableCellLocation: { tableStartLocation: { index: b.at }, rowIndex, columnIndex } });
    // Columns: removed ones last to first, then new ones left to right
    const baseCols = columnIds(b);
    const targetCols = columnIds(t);
    for (let c = baseCols.length - 1; c >= 0; c--) if (baseCols[c] && !targetCols.includes(baseCols[c])) reqs.push({ deleteTableColumn: loc(0, c) });
    let kept = baseCols.filter((c) => c && targetCols.includes(c));
    targetCols.forEach((cid, c) => {
      if (cid && kept.includes(cid)) return;
      // Insert next to the previous kept column (or before the first)
      const prev = targetCols.slice(0, c).reverse().find((x) => x && kept.includes(x));
      const idx = prev ? kept.indexOf(prev) : 0;
      reqs.push({ insertTableColumn: { ...loc(0, Math.max(0, idx)), insertRight: !!prev } });
      kept = prev ? [...kept.slice(0, idx + 1), cid ?? `col${c}`, ...kept.slice(idx + 1)] : [cid ?? `col${c}`, ...kept];
    });
    const baseRows = b.rows.map((r) => r.rid);
    const targetRows = t.rows.map((r) => r.rid);
    for (let r = baseRows.length - 1; r >= 0; r--) if (baseRows[r] && !targetRows.includes(baseRows[r])) reqs.push({ deleteTableRow: loc(r, 0) });
    let keptRows = baseRows.filter((r) => r && targetRows.includes(r));
    targetRows.forEach((rid, r) => {
      if (rid && keptRows.includes(rid)) return;
      const prev = targetRows.slice(0, r).reverse().find((x) => x && keptRows.includes(x));
      const idx = prev ? keptRows.indexOf(prev) : 0;
      reqs.push({ insertTableRow: { ...loc(Math.max(0, idx), 0), insertBelow: !!prev } });
      keptRows = prev ? [...keptRows.slice(0, idx + 1), rid ?? `row${r}`, ...keptRows.slice(idx + 1)] : [rid ?? `row${r}`, ...keptRows];
    });
    if (reqs.length) changes.push({ at: b.at, requests: reqs });
  }
  for (const b of baseTables) if (!targetTables.some((t) => t.id === b.id)) changes.push({ at: b.at, requests: [{ deleteContentRange: { range: { startIndex: b.at, endIndex: b.endAt } } }] });
  changes.sort((x, y) => y.at - x.at);
  for (const c of changes) requests.push(...c.requests);
  return requests;
}

// ── Direct edits ────────────────────────────────────────────────────────────

function textStyleDiff(a: RunStyle, b: RunStyle): { textStyle: DocsRequest; fields: string[] } | null {
  const textStyle: DocsRequest = {};
  const fields: string[] = [];
  const flag = (key: "b" | "i" | "u" | "s", field: string) => {
    if (!!a[key] !== !!b[key]) { textStyle[field] = !!b[key]; fields.push(field); }
  };
  flag("b", "bold");
  flag("i", "italic");
  flag("u", "underline");
  flag("s", "strikethrough");
  if (!!a.sup !== !!b.sup || !!a.sub !== !!b.sub) { textStyle.baselineOffset = b.sup ? "SUPERSCRIPT" : b.sub ? "SUBSCRIPT" : "NONE"; fields.push("baselineOffset"); }
  if (a.font !== b.font) { if (b.font) textStyle.weightedFontFamily = { fontFamily: b.font, weight: 400 }; fields.push("weightedFontFamily"); }
  if (a.size !== b.size) { if (b.size) textStyle.fontSize = { magnitude: b.size, unit: "PT" }; fields.push("fontSize"); }
  if (a.color !== b.color) { if (b.color) textStyle.foregroundColor = rgb(b.color); fields.push("foregroundColor"); }
  if (a.bg !== b.bg) { if (b.bg) textStyle.backgroundColor = rgb(b.bg); fields.push("backgroundColor"); }
  if (a.link !== b.link) {
    if (b.link) textStyle.link = { url: b.link };
    fields.push("link");
    // Removing a link leaves its colour and underline behind unless they are reset too
    if (a.link && !b.link) {
      if (!b.u && !fields.includes("underline")) { textStyle.underline = false; fields.push("underline"); }
      if (!b.color && !fields.includes("foregroundColor")) fields.push("foregroundColor");
    }
    // Links look like links in Docs only with the colour and underline set
    if (b.link && !a.link) {
      if (!b.color && !fields.includes("foregroundColor")) { textStyle.foregroundColor = rgb(LINK_COLOR); fields.push("foregroundColor"); }
      if (!fields.includes("underline")) { textStyle.underline = true; fields.push("underline"); }
    }
  }
  return fields.length ? { textStyle, fields } : null;
}

export interface DirectEdits {
  /** One batchUpdate, in order */
  requests: DocsRequest[];
  /** The base once these edits are saved: the target without its additions */
  saved: EditorNode;
  /** True when table structure changed: the document must be read back before anything else is saved */
  structural?: boolean;
}

/** Requests that make the Google Doc match the editor, except for additions */
export function directEdits(baseDoc: EditorNode, targetDoc: EditorNode): DirectEdits {
  return edits(baseDoc, targetDoc, 1);
}

/**
 * Requests that make a header, footer or footnote match its editor. A
 * segment's indices start at 0 and nothing in it is typed by a sync: every
 * change is saved right away, so additions marks are ignored.
 */
export function segmentEdits(baseDoc: EditorNode, targetDoc: EditorNode, segmentId: string): DirectEdits {
  const plain = (doc: EditorNode): EditorNode => untokenize(tokenize(doc).map(stripPending));
  const out = edits(plain(baseDoc), plain(targetDoc), 0);
  const tag = (r: DocsRequest): DocsRequest => {
    const [key] = Object.keys(r);
    const body = { ...(r[key] as Record<string, unknown>) };
    if (body.range && typeof body.range === "object") body.range = { ...(body.range as object), segmentId };
    if (body.location && typeof body.location === "object") body.location = { ...(body.location as object), segmentId };
    return { [key]: body };
  };
  return { ...out, requests: out.requests.map(tag) };
}

function edits(baseDoc: EditorNode, targetDoc: EditorNode, firstIndex: number): DirectEdits {
  const base = tokenize(baseDoc);
  const target = tokenize(targetDoc);
  const { match, regions, index } = diff(base, target, true, firstIndex);
  // Tables added, removed or reshaped come first, on their own: their indices are only known once Google has applied them
  const structure = tableStructureRequests(base, target, index);
  if (structure.length) return { requests: structure, saved: baseDoc, structural: true };

  // Column layouts: a section whose marker's columns changed is restyled over its content
  const sectionRequests: DocsRequest[] = [];
  if (firstIndex === 1) {
    const markers = target.map((t, j) => ({ t, j })).filter(({ t }) => t.k === "block" && t.node.attrs?.kind === "section");
    for (const { t, j } of markers) {
      const node = (t as Extract<Tok, { k: "block" }>).node;
      const i = match[j];
      const baseAttrs = i >= 0 && base[i].k === "block" ? (base[i] as Extract<Tok, { k: "block" }>).node.attrs : undefined;
      const changed = i >= 0 ? columnKey(baseAttrs) !== columnKey(node.attrs) : node.attrs?.first === true && (node.attrs?.columns as number ?? 1) > 1;
      if (!changed) continue;
      // The section runs from just after its break to the next one (or the end)
      let start = i >= 0 ? index[i] + sizeOf(base[i]) : 1;
      let end = index[base.length];
      for (let q = (i >= 0 ? i : -1) + 1; q < base.length; q++) {
        const b = base[q];
        if (b.k === "block" && b.node.attrs?.kind === "section" && !b.node.attrs?.first) { end = index[q]; break; }
      }
      if (end <= start) { start = Math.max(1, end - 1); }
      sectionRequests.push(sectionStyleRequest(node.attrs ?? {}, start, end));
    }
  }

  // Character styles of text the document already has (base coordinates, applied before the content changes)
  const styleRequests: DocsRequest[] = [];
  let run: { from: number; to: number; key: string; diff: NonNullable<ReturnType<typeof textStyleDiff>> } | null = null;
  const flushRun = () => {
    if (run) styleRequests.push({ updateTextStyle: { range: { startIndex: run.from, endIndex: run.to }, textStyle: run.diff.textStyle, fields: run.diff.fields.join(",") } });
    run = null;
  };
  for (let j = 0; j < target.length; j++) {
    const i = match[j];
    if (i < 0) continue;
    const b = base[i];
    const t = target[j];
    if ((b.k === "c" || b.k === "br" || b.k === "img" || b.k === "pb") && (t.k === "c" || t.k === "br" || t.k === "img" || t.k === "pb")) {
      const d = textStyleDiff(styleFromMarks(withoutPending(b.marks)), styleFromMarks(withoutPending(t.marks)));
      if (!d) { flushRun(); continue; }
      const key = JSON.stringify(d);
      const r = run as { from: number; to: number; key: string } | null;
      if (r && r.key === key && r.to === index[i]) r.to = index[i] + 1;
      else { flushRun(); run = { from: index[i], to: index[i] + 1, key, diff: d }; }
      continue;
    }
    flushRun();
  }
  flushRun();

  // Content changes from the end backwards, so earlier indices stay valid
  const end = index[base.length];
  const contentRequests: DocsRequest[] = [];
  const extraNlAfter = new Set<Region>();
  // A paragraph's final newline cannot be deleted when it ends the body or a table cell
  const finalNl = (i: number) => { const next = base[i + 1]; return base[i]?.k === "nl" && (i + 1 === base.length || (next.k === "st" && next.kind === "cellEnd")); };
  for (const r of [...regions].reverse()) {
    let bs = r.bs;
    let be = r.be;
    // Deleting the last paragraphs: delete the ones before instead, which leaves the same text
    while (be > bs && finalNl(be - 1) && bs > 0 && base[bs - 1].k === "nl") { bs--; be--; }
    let at = index[bs];
    if (be > bs) contentRequests.push({ deleteContentRange: { range: { startIndex: at, endIndex: index[be] } } });
    if (r.pending || r.te === r.ts) continue;
    // Text that came back without being an addition (undoing a deletion): put it back now.
    // New section breaks and page breaks are inserted as Docs inserts them (each with its newline).
    const inserted = target.slice(r.ts, r.te).filter((t) => (t.k !== "block" || isNewSection(t)) && t.k !== "st");
    if (at >= end) {
      // Nothing can follow the final newline: what goes after it goes before it, newline first
      at = end - 1;
      const last = inserted[inserted.length - 1];
      if (last?.k === "nl") { inserted.pop(); inserted.unshift(last); }
    }
    let text = "";
    const styled: { from: number; to: number; style: DocsRequest }[] = [];
    let pos = at;
    for (let q = 0; q < inserted.length; q++) {
      const t = inserted[q];
      if (t.k === "block") {
        if (text) { contentRequests.push({ insertText: { location: { index: pos }, text } }); pos += text.length; text = ""; }
        contentRequests.push({ insertSectionBreak: { location: { index: pos }, sectionType: t.node.attrs?.sectionType === "continuous" ? "CONTINUOUS" : "NEXT_PAGE" } });
        pos += 2; // a newline and the break
        continue;
      }
      if (t.k === "pb") {
        if (text) { contentRequests.push({ insertText: { location: { index: pos }, text } }); pos += text.length; text = ""; }
        contentRequests.push({ insertPageBreak: { location: { index: pos } } });
        pos += 2; // the break and the newline Docs adds with it
        if (inserted[q + 1]?.k === "nl") q++;
        continue;
      }
      if (t.k === "fn") {
        if (text) { contentRequests.push({ insertText: { location: { index: pos }, text } }); pos += text.length; text = ""; }
        // Docs creates the footnote and its reference; the id arrives when the document is read back
        contentRequests.push({ createFootnote: { location: { index: pos } } });
        pos += 1;
        continue;
      }
      if (t.k === "img") {
        if (text) { contentRequests.push({ insertText: { location: { index: pos }, text } }); pos += text.length; text = ""; }
        if (insertableImage(t)) {
          contentRequests.push({ insertInlineImage: { location: { index: pos }, uri: t.attrs.src as string } });
          pos += 1;
        }
        continue;
      }
      // Docs drops soft line breaks sent through the API, so a line break becomes a new paragraph
      const ch = t.k === "c" ? t.c : "\n";
      if (t.k === "c") {
        styled.push({ from: pos + text.length, to: pos + text.length + 1, style: resolveTextStyle(styleFromMarks(withoutPending(t.marks))) });
      }
      text += ch;
    }
    if (text) { contentRequests.push({ insertText: { location: { index: pos }, text } }); pos += text.length; }
    for (const st of styled) contentRequests.push(textRequest(st.style, st.from, st.to));
    // A page break at the end of a paragraph: Docs adds a newline with it, so the paragraph's own
    // newline (which follows the break) goes, unless it is the final one, which cannot be deleted
    const last = inserted[inserted.length - 1];
    if (last?.k === "pb" && r.te < target.length && target[r.te].k === "nl" && match[r.te] === r.be) {
      if (finalNl(r.be)) extraNlAfter.add(r);
      else contentRequests.push({ deleteContentRange: { range: { startIndex: pos, endIndex: pos + 1 } } });
    }
  }

  // What the base becomes: the target without additions, with paragraph changes that wait for an
  // addition still at their saved values. Each paragraph remembers what Docs has for it after the
  // content changes: its own attrs when it already existed, those of the paragraph it was split
  // from when it is new (a newline copies the style of the paragraph it is inserted into).
  const saved: Tok[] = [];
  const docsAttrs = new Map<number, Record<string, unknown> | undefined>();
  const prevNl = (tokens: Tok[], from: number) => { for (let q = from; q >= 0; q--) { const t = tokens[q]; if (t.k === "nl") return t; } return undefined; };
  const regionAt = new Map<number, Region>();
  for (const r of regions) regionAt.set(r.ts, r);
  for (let j = 0; j < target.length; j++) {
    const r = regionAt.get(j);
    if (r && r.te > r.ts) {
      if (!r.pending) {
        const enclosing = (nextNl(base, r.be) ?? prevNl(base, r.bs - 1))?.attrs;
        for (let q = r.ts; q < r.te; q++) {
          const t = target[q];
          if (t.k === "img" && !insertableImage(t)) continue; // never reached the document
          if (isNewSection(t)) {
            // Docs puts a newline before the break: an empty paragraph, then the break itself
            saved.push({ k: "nl", attrs: enclosing ?? {} });
            docsAttrs.set(saved.length - 1, enclosing);
            saved.push({ k: "block", node: { ...t.node, attrs: { ...t.node.attrs, span: 1 } } });
            continue;
          }
          saved.push(stripPending(t));
          if (t.k === "nl") docsAttrs.set(saved.length - 1, enclosing);
          if (t.k === "pb" && target[q + 1]?.k !== "nl") {
            // Docs ends the paragraph after a page break
            saved.push({ k: "nl", attrs: enclosing ?? {} });
            docsAttrs.set(saved.length - 1, enclosing);
          }
        }
        if (extraNlAfter.has(r)) {
          // The newline Docs added with a page break before the final one stays as an empty paragraph
          saved.push({ k: "nl", attrs: enclosing ?? {} });
          docsAttrs.set(saved.length - 1, enclosing);
        }
      }
      j = r.te - 1;
      continue;
    }
    const i = match[j];
    if (i < 0) continue;
    const t = target[j];
    if (t.k === "nl") {
      saved.push(paragraphHasPending(target, j) ? base[i] : stripPending(t));
      docsAttrs.set(saved.length - 1, (base[i] as Extract<Tok, { k: "nl" }>).attrs);
    } else saved.push(stripPending(t));
  }

  // Paragraph styles and lists, over the saved document (its indices are the ones Docs has after the
  // content changes). Bullets first: removing them leaves an indent the paragraph style then resets.
  const sIndex = new Array<number>(saved.length + 1);
  const sParaStart = new Array<number>(saved.length);
  let sAt = firstIndex;
  let sStart = 0;
  for (let p = 0; p < saved.length; p++) {
    sIndex[p] = sAt;
    sAt += sizeOf(saved[p]);
    sParaStart[p] = sStart;
    if (saved[p].k === "nl" || saved[p].k === "block" || saved[p].k === "st") sStart = p + 1;
  }
  sIndex[saved.length] = sAt;
  const listRequests: DocsRequest[] = [];
  const paraRequests: DocsRequest[] = [];
  const changedLists = new Set<number>();
  for (let p = 0; p < saved.length; p++) {
    const t = saved[p];
    if (t.k !== "nl" || !docsAttrs.has(p)) continue;
    const pa = paragraphFromAttrs(docsAttrs.get(p));
    const pb = paragraphFromAttrs(t.attrs);
    const range = { startIndex: sIndex[sParaStart[p]], endIndex: sIndex[p] + 1 };
    const listChanged = (pa.list ?? null) !== (pb.list ?? null) || (pb.list && ((pa.level ?? 0) !== (pb.level ?? 0) || presetOf(pa) !== presetOf(pb)));
    if (listChanged) {
      if (pa.list && !pb.list) listRequests.push({ deleteParagraphBullets: { range } });
      if (pb.list) changedLists.add(p);
    }
    const d = paragraphDelta(pa, pb);
    if (d) paraRequests.push({ updateParagraphStyle: { range, paragraphStyle: d.style, fields: d.fields.join(",") } });
  }
  // A changed list item is re-made together with its whole run (consecutive items of its kind), so the
  // run stays one list with continuous numbering, each item at its own level. Runs are handled last
  // to first: the tabs that set levels come and go inside each run's requests.
  // Items of one run share a list type and preset: Docs makes one list per createParagraphBullets
  const kindAt = (q: number) => { const t = saved[q]; if (t.k !== "nl") return null; const pf = paragraphFromAttrs(t.attrs); return pf.list ? `${pf.list}|${presetOf(pf)}` : null; };
  const runOf = (j: number): [number, number] => {
    let s = j;
    let e = j;
    const type = kindAt(j);
    const nlBefore = (q: number) => { for (let k = q - 1; k >= 0; k--) { const t = saved[k]; if (t.k === "nl") return k; if (t.k === "block" || t.k === "st") return -1; } return -1; };
    const nlAfter = (q: number) => { for (let k = q + 1; k < saved.length; k++) { const t = saved[k]; if (t.k === "nl") return k; if (t.k === "block" || t.k === "st") return -1; } return -1; };
    for (let k = nlBefore(s); k >= 0 && kindAt(k) === type; k = nlBefore(k)) s = k;
    for (let k = nlAfter(e); k >= 0 && kindAt(k) === type; k = nlAfter(k)) e = k;
    return [s, e];
  };
  const runs: [number, number][] = [];
  for (const p of Array.from(changedLists)) {
    const r = runOf(p);
    if (!runs.some(([s]) => s === r[0])) runs.push(r);
  }
  runs.sort((a, b) => b[0] - a[0]);
  for (const [s, e] of runs) {
    const items: { start: number; end: number; level: number }[] = [];
    let preset = "";
    for (let q = s; q <= e; q++) {
      const t = saved[q];
      if (t.k !== "nl") continue;
      const pb = paragraphFromAttrs(t.attrs);
      if (!pb.list) continue;
      preset = presetOf(pb);
      items.push({ start: sIndex[sParaStart[q]], end: sIndex[q] + 1, level: pb.level ?? 0 });
    }
    if (!items.length) continue;
    listRequests.push({ deleteParagraphBullets: { range: { startIndex: items[0].start, endIndex: items[items.length - 1].end } } });
    listRequests.push(...bulletRequests(items, preset));
  }

  const requests = [...sectionRequests, ...styleRequests, ...contentRequests, ...listRequests, ...paraRequests];
  return { requests, saved: untokenize(saved) };
}

/** An image Docs can fetch: only these are ever inserted */
const insertableImage = (t: Tok) => t.k === "img" && typeof t.attrs.src === "string" && /^https:\/\//.test(t.attrs.src);

function stripPending(t: Tok): Tok {
  if (t.k === "c" || t.k === "img" || t.k === "br" || t.k === "pb") return { ...t, marks: withoutPending(t.marks), pending: false };
  // A section break just inserted covers its newline and itself until the document is read again
  if (isNewSection(t)) return { k: "block", node: { ...t.node, attrs: { ...t.node.attrs, span: 2 } } };
  return t;
}

/** A section break made in the editor, not yet in the document (the first section's hidden marker is never inserted) */
const isNewSection = (t: Tok): t is Extract<Tok, { k: "block" }> => t.k === "block" && t.node.attrs?.kind === "section" && !t.node.attrs?.bid && !t.node.attrs?.first;

function nextNl(tokens: Tok[], from: number): Extract<Tok, { k: "nl" }> | undefined {
  for (let q = from; q < tokens.length; q++) {
    const t = tokens[q];
    if (t.k === "nl") return t;
  }
  return undefined;
}

// ── Additions ───────────────────────────────────────────────────────────────

export interface Segment {
  /** Docs index in the saved document where the addition goes */
  at: number;
  /**
   * "inline": typed at `at`. "before": a new paragraph is opened at `at`
   * (the start of a paragraph) and the text typed into it.
   */
  mode: "inline" | "before";
  text: string;
  format: RichFormat;
  /** The target tokens this text came from, for showing progress */
  tokens: [number, number];
}

const DROPPED_BY_DOCS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uE000-\\uF8FF\\u2028\\u2029]");

/**
 * The additions, in document order, with where each goes in the saved
 * document. Call with the base as saved (no direct edits left to save).
 */
export function additions(baseDoc: EditorNode, targetDoc: EditorNode): { segments: Segment[]; text: string; boundaries: number[] } {
  const base = tokenize(baseDoc);
  const target = tokenize(targetDoc);
  const { regions, index } = diff(base, target);
  const segments: Segment[] = [];
  for (const r of regions) {
    if (!r.pending || r.te === r.ts) continue;
    const atParagraphStart = r.bs === 0 || base[r.bs - 1].k === "nl" || base[r.bs - 1].k === "block" || base[r.bs - 1].k === "st";
    const endsWithBreak = target[r.te - 1].k === "nl";
    const mode: Segment["mode"] = atParagraphStart && endsWithBreak ? "before" : "inline";
    const te = mode === "before" ? r.te - 1 : r.te;
    const seg = segmentText(target, r.ts, te);
    // The paragraph the text is typed into (or copied for a new one) as the document has it
    seg.format.base = paragraphFromAttrs(nextNl(base, r.bs)?.attrs);
    segments.push({ at: index[r.bs], mode, ...seg, tokens: [r.ts, te] });
  }
  let text = "";
  const boundaries: number[] = [];
  for (const s of segments) {
    if (text.length) boundaries.push(text.length);
    text += s.text;
  }
  return { segments, text, boundaries };
}

/** Text and formatting of target tokens [ts, te): line k is paragraph k */
function segmentText(target: Tok[], ts: number, te: number): { text: string; format: RichFormat } {
  let text = "";
  const runs: RunFormat[] = [];
  const images: ImageRef[] = [];
  const paragraphs: ParagraphFormat[] = [];
  const push = (len: number, style: RunStyle) => {
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.len += len;
    else runs.push({ len, ...style });
  };
  let lastStyle: RunStyle = {};
  let lineStart = true;
  for (let q = ts; q < te; q++) {
    const t = target[q];
    if (lineStart) {
      paragraphs.push(paragraphFromAttrs(nextNl(target, q)?.attrs));
      lineStart = false;
    }
    if (t.k === "nl" || t.k === "br") {
      const style = { ...lastStyle };
      delete style.link;
      text += "\n";
      push(1, style);
      lineStart = true;
      continue;
    }
    if (t.k === "block" || t.k === "st" || t.k === "fn") continue;
    const style = styleFromMarks(withoutPending(t.marks));
    lastStyle = style;
    if (t.k === "pb") {
      text += PAGE_BREAK;
      push(1, style);
      // Docs puts a page break at the end of a paragraph: what follows it starts a new one
      if (target[q + 1]?.k !== "nl") { text += "\n"; push(1, style); paragraphs.push(paragraphFromAttrs(nextNl(target, q)?.attrs)); }
      continue;
    }
    if (t.k === "img") {
      const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) || 0 : 0);
      const src = typeof t.attrs.src === "string" ? t.attrs.src : "";
      if (/^https?:\/\//i.test(src)) {
        images.push({ at: text.length, src, w: Math.round(num(t.attrs.width) * 0.75 * 10) / 10, h: Math.round(num(t.attrs.height) * 0.75 * 10) / 10 });
        text += OBJ;
      } else text += " ";
      push(1, style);
      continue;
    }
    let ch = t.c;
    // Keep one character per token: swap what Docs would drop, and a tab that would start a list item
    if (DROPPED_BY_DOCS.test(ch) || ch === OBJ) ch = " ";
    const atParagraphStart = q === 0 || target[q - 1].k === "nl" || target[q - 1].k === "block" || target[q - 1].k === "st";
    if (ch === "\t" && paragraphs[paragraphs.length - 1]?.list && atParagraphStart) ch = " ";
    text += ch;
    push(1, style);
  }
  if (lineStart) paragraphs.push(paragraphFromAttrs(nextNl(target, te)?.attrs));
  if (!paragraphs.length) paragraphs.push({ ...DEFAULT_PARAGRAPH });
  const format: RichFormat = { v: 1, paragraphs, runs };
  if (images.length) format.images = images;
  return { text, format };
}

// ── Reloading ───────────────────────────────────────────────────────────────

/**
 * The document as Google has it now, with the editor's additions put back
 * where they were. The Google Doc wins everywhere else.
 */
export function rebase(newBase: EditorNode, oldTarget: EditorNode): EditorNode {
  const base = tokenize(newBase);
  const target = adoptTables(base, tokenize(oldTarget));
  const { regions } = diff(base, target, false);
  const regionAt = new Map<number, Region>();
  for (const r of regions) regionAt.set(r.bs, r);
  const out: Tok[] = [];
  let i = 0;
  while (i <= base.length) {
    const r = regionAt.get(i);
    if (r) {
      // Base tokens the editor had lost stay, since Google has them; additions follow
      for (let q = r.bs; q < r.be; q++) out.push(base[q]);
      if (r.pending) for (let q = r.ts; q < r.te; q++) out.push(target[q]);
      i = r.be;
    }
    if (i < base.length) out.push(base[i]);
    i++;
  }
  return untokenize(out);
}

/**
 * Tables the editor made that the document now has: each takes the ids and
 * index spans of the next document table of the same shape, so its text
 * (typed before the table existed in the document) is kept as additions and
 * the next save carries on instead of seeing a different table.
 */
function adoptTables(base: Tok[], target: Tok[]): Tok[] {
  type St = Extract<Tok, { k: "st" }>;
  const tablesIn = (tokens: Tok[]) => {
    const out: { at: number[]; kinds: string[]; id: string }[] = [];
    let cur: { at: number[]; kinds: string[]; id: string } | null = null;
    tokens.forEach((t, i) => {
      if (t.k !== "st") return;
      if (t.kind === "table") cur = { at: [], kinds: [], id: t.id };
      if (!cur) return;
      cur.at.push(i);
      cur.kinds.push(t.kind);
      if (t.kind === "tableEnd") { out.push(cur); cur = null; }
    });
    return out;
  };
  const mine = tablesIn(target).filter((t) => t.id.startsWith("new"));
  if (!mine.length) return target;
  const known = new Set(target.filter((t): t is St => t.k === "st").map((t) => t.id));
  const theirs = tablesIn(base).filter((t) => !known.has(t.id));
  const out = target.slice();
  let k = 0;
  for (const m of mine) {
    while (k < theirs.length && theirs[k].kinds.join() !== m.kinds.join()) k++;
    if (k >= theirs.length) break;
    const b = theirs[k++];
    m.at.forEach((pos, n) => { out[pos] = base[b.at[n]]; });
  }
  return out;
}

/** After tables were created in the document: the editor's content with the document's ids and spans */
export function adoptStructure(newBase: EditorNode, target: EditorNode): EditorNode {
  return untokenize(adoptTables(tokenize(newBase), tokenize(target)));
}
