/**
 * Formulas, read just far enough to work with their cell references: which cells a formula reads
 * (so a sync never types it before them), the formula a shared formula stands for in each of its
 * cells, whether two formulas are the same one filled down or across, and Excel's spellings that
 * Google Sheets writes differently.
 */

import { cellName, colIndex, colName, type Rect } from "./model";

export const MAX_ROW = 1_048_575;
export const MAX_COL = 16_383;

interface RefPart { row: number | null; col: number | null; absRow: boolean; absCol: boolean }

export type Token =
  | { t: "text"; text: string }
  | { t: "func"; text: string }
  | { t: "name"; text: string }
  | { t: "ref"; sheet: string | null; sheetText: string; a: RefPart; b: RefPart | null };

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_.(])/;
const COLS = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.(])/;
const ROWS = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![A-Za-z0-9_.(])/;
const ERROR = /^#(N\/A|DIV\/0!|REF!|VALUE!|NAME\?|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)/i;
const IDENT = /^[A-Za-z_\\À-￿][A-Za-z0-9_.\\?À-￿]*/;
const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;

function cellPart(m: RegExpExecArray): RefPart | null {
  const col = colIndex(m[2]);
  const row = Number(m[4]) - 1;
  if (col < 0 || col > MAX_COL || row < 0 || row > MAX_ROW) return null;
  return { col, row, absCol: m[1] === "$", absRow: m[3] === "$" };
}

/** A reference at the start of `s` (after any sheet name): its token parts and how much text it took */
function readRef(s: string): { a: RefPart; b: RefPart | null; length: number } | null {
  const m = CELL.exec(s);
  if (m) {
    const a = cellPart(m);
    if (!a) return null;
    if (s[m[0].length] === ":") {
      const m2 = CELL.exec(s.slice(m[0].length + 1));
      const b = m2 ? cellPart(m2) : null;
      if (m2 && b) return { a, b, length: m[0].length + 1 + m2[0].length };
    }
    return { a, b: null, length: m[0].length };
  }
  const c = COLS.exec(s);
  if (c) {
    const c0 = colIndex(c[2]);
    const c1 = colIndex(c[4]);
    if (c0 < 0 || c1 < 0 || c0 > MAX_COL || c1 > MAX_COL) return null;
    return { a: { col: c0, row: null, absCol: c[1] === "$", absRow: false }, b: { col: c1, row: null, absCol: c[3] === "$", absRow: false }, length: c[0].length };
  }
  const r = ROWS.exec(s);
  if (r) {
    const r0 = Number(r[2]) - 1;
    const r1 = Number(r[4]) - 1;
    if (r0 < 0 || r1 < 0 || r0 > MAX_ROW || r1 > MAX_ROW) return null;
    return { a: { col: null, row: r0, absCol: false, absRow: r[1] === "$" }, b: { col: null, row: r1, absCol: false, absRow: r[3] === "$" }, length: r[0].length };
  }
  return null;
}

/** The formula (without its "=") as tokens; joining their text gives it back */
export function tokenize(formula: string): Token[] {
  const out: Token[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", text }); text = ""; } };
  const s = formula;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      // A string: "" inside it is one quote
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '"') { if (s[j + 1] === '"') { j += 2; continue; } break; }
        j++;
      }
      text += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      // A quoted sheet name, then "!" and a reference
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      const sheetText = s.slice(i, j + 1);
      if (s[j + 1] === "!") {
        const ref = readRef(s.slice(j + 2));
        if (ref) {
          flush();
          out.push({ t: "ref", sheet: sheetText.slice(1, -1).replace(/''/g, "'"), sheetText: sheetText + "!", a: ref.a, b: ref.b });
          i = j + 2 + ref.length;
          continue;
        }
      }
      text += sheetText;
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      // A table column or another workbook: kept as written
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "[") depth++;
        else if (s[j] === "]" && --depth === 0) break;
      }
      text += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "#") {
      const m = ERROR.exec(s.slice(i));
      if (m) { text += m[0]; i += m[0].length; continue; }
    }
    const rest = s.slice(i);
    // (a reference never starts in the middle of a word or a number)
    const prev = i > 0 ? s[i - 1] : "";
    const atStart = !/[A-Za-z0-9_.$\\]/.test(prev);
    if (atStart && (ch === "$" || /[A-Za-z0-9]/.test(ch))) {
      const ref = readRef(rest);
      if (ref) {
        flush();
        out.push({ t: "ref", sheet: null, sheetText: "", a: ref.a, b: ref.b });
        i += ref.length;
        continue;
      }
    }
    if (atStart) {
      const id = IDENT.exec(rest);
      if (id) {
        const after = rest[id[0].length];
        if (after === "!") {
          const ref = readRef(rest.slice(id[0].length + 1));
          if (ref) {
            flush();
            out.push({ t: "ref", sheet: id[0], sheetText: id[0] + "!", a: ref.a, b: ref.b });
            i += id[0].length + 1 + ref.length;
            continue;
          }
        }
        flush();
        out.push({ t: after === "(" ? "func" : "name", text: id[0] });
        i += id[0].length;
        continue;
      }
      const num = NUMBER.exec(rest);
      if (num) { text += num[0]; i += num[0].length; continue; }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function partText(p: RefPart): string {
  return (p.col == null ? "" : (p.absCol ? "$" : "") + colName(p.col)) + (p.row == null ? "" : (p.absRow ? "$" : "") + (p.row + 1));
}

function refText(tok: Extract<Token, { t: "ref" }>): string {
  return tok.sheetText + partText(tok.a) + (tok.b ? ":" + partText(tok.b) : "");
}

export function joinTokens(tokens: readonly Token[]): string {
  return tokens.map((t) => (t.t === "ref" ? refText(t) : t.text)).join("");
}

/** Functions Excel stores under a prefix: Google Sheets knows them by their plain name */
const EXCEL_PREFIX = /^(_xlfn\.|_xlws\.|_xlpm\.|_xludf\.)+/i;

/** The formula as Google Sheets takes it */
export function toSheetsFormula(formula: string): string {
  const f = formula.replace(/^=/, "");
  if (!/_xl/i.test(f)) return f;
  return joinTokens(tokenize(f).map((t) => (t.t === "func" || t.t === "name" ? { ...t, text: t.text.replace(EXCEL_PREFIX, "") } : t)));
}

function shiftPart(p: RefPart, dr: number, dc: number): RefPart | null {
  const row = p.row == null || p.absRow ? p.row : p.row + dr;
  const col = p.col == null || p.absCol ? p.col : p.col + dc;
  if ((row != null && (row < 0 || row > MAX_ROW)) || (col != null && (col < 0 || col > MAX_COL))) return null;
  return { ...p, row, col };
}

/** The formula moved `dr` rows down and `dc` columns right, as filling does: relative references move with it */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  if (!dr && !dc) return formula;
  return tokenize(formula).map((t) => {
    if (t.t !== "ref") return t.text;
    const a = shiftPart(t.a, dr, dc);
    const b = t.b ? shiftPart(t.b, dr, dc) : null;
    if (!a || (t.b && !b)) return "#REF!";
    return refText({ ...t, a, b });
  }).join("");
}

function partSignature(p: RefPart, r: number, c: number): string {
  const row = p.row == null ? "" : p.absRow ? `R${p.row}` : `R[${p.row - r}]`;
  const col = p.col == null ? "" : p.absCol ? `C${p.col}` : `C[${p.col - c}]`;
  return row + col;
}

/**
 * The formula as seen from the cell it is in: two cells with the same signature hold one formula,
 * filled from one to the other.
 */
export function formulaSignature(formula: string, r: number, c: number): string {
  return tokenize(formula).map((t) => {
    if (t.t !== "ref") return t.text.toUpperCase();
    return t.sheetText.toUpperCase() + partSignature(t.a, r, c) + (t.b ? ":" + partSignature(t.b, r, c) : "");
  }).join("");
}

export interface Precedent {
  /** The sheet named in the reference (null: the formula's own) */
  sheet: string | null;
  /** The cells read; a whole column or row reaches to the sheet's edge */
  rect: Rect;
}

/** The cells a formula reads, and the names it uses (defined names, among other words) */
export function precedents(formula: string): { refs: Precedent[]; names: string[] } {
  const refs: Precedent[] = [];
  const names: string[] = [];
  for (const t of tokenize(formula)) {
    if (t.t === "name") { names.push(t.text); continue; }
    if (t.t !== "ref") continue;
    const b = t.b ?? t.a;
    const r0 = Math.min(t.a.row ?? 0, b.row ?? 0);
    const r1 = Math.max(t.a.row ?? MAX_ROW, b.row ?? MAX_ROW);
    const c0 = Math.min(t.a.col ?? 0, b.col ?? 0);
    const c1 = Math.max(t.a.col ?? MAX_COL, b.col ?? MAX_COL);
    refs.push({ sheet: t.sheet, rect: [r0, c0, r1, c1] });
  }
  return { refs, names };
}

/** For messages: "B7" from a reference token's first cell */
export const refStart = (t: Extract<Token, { t: "ref" }>): string => (t.a.row != null && t.a.col != null ? cellName(t.a.row, t.a.col) : partText(t.a));
