/**
 * Compare & Sync for spreadsheets: the steps that bring a spreadsheet up to a reference workbook.
 *
 * `have` is the spreadsheet as it is now, `want` the reference. The reference's whole build
 * (order.ts) is planned and then cut down to what the spreadsheet is missing: cells whose value,
 * formula or note differ are typed, a look is set only where it differs, a tab the spreadsheet
 * doesn't have is built whole. Nothing only the spreadsheet has is removed. The order stays the
 * reference's own, so what is typed is typed the way the whole workbook would have been.
 */

import { layout, type Cell, type CellStyle, type Sheet, type Workbook } from "./model";
import { coverRects } from "./cover";
import { planSteps, type PlanSection } from "./order";
import { ASPECTS, aspectKey, hasAspect, type Aspect, type Step } from "./steps";

export interface CompareSummary {
  /** Tabs the spreadsheet doesn't have yet, by name */
  newSheets: string[];
  /** Cells to type (a value, formula or note that differs), and cells whose look changes, on tabs it has */
  cells: number;
  looks: number;
  /** What differs and is left as it is, in words */
  kept: string[];
}

export interface ComparePlan {
  steps: Step[];
  sections: PlanSection[];
  /** For each of the reference's sheets, the cells (by their place) a step types */
  typed: Set<number>[];
  summary: CompareSummary;
}

const key = (r: number, c: number) => r * 16384 + c;
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** A colour as the hex it is in its workbook (a theme colour through the workbook's theme) */
function hex(wb: Workbook, color: string | undefined): string {
  if (!color) return "";
  const v = color.startsWith("theme:") ? (wb.theme as Record<string, string | undefined> | undefined)?.[color.slice(6)] ?? color : color;
  return v.toLowerCase();
}

/** One part of a look as a value two workbooks can be compared by: defaults filled in, colours resolved */
function aspectValue(wb: Workbook, style: CellStyle | undefined, a: Aspect): string {
  const s = style ?? {};
  switch (a) {
    case "family": return (s.font?.family ?? wb.defaultFont.family).toLowerCase();
    case "size": return String(s.font?.size ?? wb.defaultFont.size);
    case "color": return hex(wb, s.font?.color) || "#000000";
    case "fill": return hex(wb, s.fill);
    case "borders": return s.borders ? canon(Object.fromEntries(Object.entries(s.borders).map(([side, b]) => [side, { ...b, color: hex(wb, b.color) }]))) : "";
    default: return hasAspect(s, a) ? aspectKey(s, a) : "";
  }
}

const same = (x: unknown, y: unknown): boolean =>
  typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)) : canon(x ?? null) === canon(y ?? null);

/** Whether the reference's cell holds something the spreadsheet's doesn't: its value, formula, error or note */
function holdsOther(want: Cell, have: Cell | undefined): boolean {
  if ((want.f ?? null) !== (have?.f ?? null)) return true;
  if (want.f == null && (!same(want.v, have?.v) || (want.e ?? null) !== (have?.e ?? null))) return true;
  return (want.note ?? "") !== (have?.note ?? "");
}

/** A sheet's cells and the looks of its blank ranges, by place */
function index(sheet: Sheet): { cells: Map<number, Cell>; look: (r: number, c: number) => number } {
  const cells = new Map<number, Cell>();
  for (const cell of sheet.cells) cells.set(key(cell.r, cell.c), cell);
  let spans: Map<number, number> | null = null;
  const look = (r: number, c: number): number => {
    const cell = cells.get(key(r, c));
    if (cell) return cell.s ?? 0;
    if (!spans) {
      spans = new Map();
      for (const span of sheet.spans ?? []) for (const [r0, c0, r1, c1] of span.rects) for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) spans.set(key(rr, cc), span.v);
    }
    return spans.get(key(r, c)) ?? 0;
  };
  return { cells, look };
}

/**
 * The steps that make `have` hold what `want` does. `tabs` says which of the spreadsheet's tabs can
 * be written (by lower-cased name): a reference sheet with no such tab is built whole, as a new one.
 */
export function compareSteps(have: Workbook, want: Workbook, tabs?: ReadonlySet<string>): ComparePlan {
  const full = planSteps(want);
  const match = want.sheets.map((sheet) => {
    const name = sheet.name.toLowerCase();
    const h = have.sheets.findIndex((x) => x.name.toLowerCase() === name);
    return h >= 0 && (!tabs || tabs.has(name)) ? h : -1;
  });
  const haveIndex = have.sheets.map(index);
  const typed = want.sheets.map(() => new Set<number>());
  const summary: CompareSummary = { newSheets: want.sheets.filter((_s, i) => match[i] < 0).map((s) => s.name), cells: 0, looks: 0, kept: [] };
  const kept = new Set<string>();
  const sizesOf = (sheet: Sheet, d: "r" | "c") => (d === "r" ? layout(sheet.rowPx, sheet.rowCount, sheet.defaultRowPx, sheet.hiddenRows).sizes : layout(sheet.colPx, sheet.colCount, sheet.defaultColPx, sheet.hiddenCols).sizes);
  const sizeCache = new Map<string, number[]>();
  const sizes = (wb: Workbook, s: number, d: "r" | "c") => { const k = `${wb === have ? "h" : "w"}${s}${d}`; let v = sizeCache.get(k); if (!v) { v = sizesOf(wb.sheets[s], d); sizeCache.set(k, v); } return v; };
  const themeDiffers = canon(have.theme ?? {}) !== canon(want.theme ?? {});
  const looked = new Set<string>();

  // Parts of a look the spreadsheet's cells have and the reference's don't: taken off, before the
  // reference's own looks are set, on each tab it has
  const clears = want.sheets.map((sheet, s): Step[] => {
    const h = match[s];
    if (h < 0) return [];
    const by = new Map<Aspect, Cell[]>();
    for (const cell of sheet.cells) {
      const theirs = have.styles[haveIndex[h].look(cell.r, cell.c)];
      if (!theirs) continue;
      const own = want.styles[cell.s ?? 0] ?? {};
      for (const a of ASPECTS) if (hasAspect(theirs, a) && !hasAspect(own, a) && aspectValue(have, theirs, a) !== aspectValue(want, own, a)) { const list = by.get(a); if (list) list.push(cell); else by.set(a, [cell]); }
    }
    return Array.from(by, ([a, cells]): Step => ({ k: "clear", s, a, rects: coverRects(cells.sort((x, y) => x.r - y.r || x.c - y.c)) }));
  });
  const cleared = new Set<number>();

  const out: Step[] = [];
  const newIndex = new Array<number>(full.steps.length).fill(-1);
  full.steps.forEach((step, k) => {
    const push = (st: Step) => { if (newIndex[k] < 0) newIndex[k] = out.length; out.push(st); };
    // (the first look or size step of a tab is where its clearing goes: after the typing of its first section)
    if ("s" in step && !cleared.has(step.s) && clears[step.s].length && (step.k === "fmt" || step.k === "merge" || step.k === "size" || step.k === "prop" || step.k === "dv")) {
      cleared.add(step.s);
      for (const c of clears[step.s]) { summary.looks += 0; out.push(c); }
    }
    if (step.k === "theme") { if (themeDiffers && have.sheets.length === 0) push(step); else if (themeDiffers) kept.add("The spreadsheet keeps its own theme colours and font."); return; }
    if (step.k === "pause") return;
    if (step.k === "calc") { if (canon(have.iterate ?? null) !== canon(want.iterate ?? null)) push(step); return; }
    if (step.k === "name") {
      const n = want.names?.[step.i];
      if (n && !(have.names ?? []).some((x) => x.name.toLowerCase() === n.name.toLowerCase())) push(step);
      return;
    }
    const s = step.s;
    const sheet = want.sheets[s];
    const h = match[s];
    if (h < 0) { push(step.k === "sheet" ? { ...step, mode: "add" } : step); return; }
    const mine = have.sheets[h];
    const idx = haveIndex[h];
    switch (step.k) {
      case "sheet":
        // (a tab it has is only made larger when the reference needs the room)
        if (sheet.rowCount > mine.rowCount || sheet.colCount > mine.colCount) push({ ...step, mode: "update" });
        return;
      case "base":
        if (step.what === "rows" ? sheet.defaultRowPx !== mine.defaultRowPx : step.what === "cols" ? sheet.defaultColPx !== mine.defaultColPx : want.defaultFont.size !== have.defaultFont.size) kept.add(`"${sheet.name}" keeps its own default row height, column width and font size.`);
        return;
      case "type": case "fill": case "paste": {
        const cells = step.cells.filter((i) => holdsOther(sheet.cells[i], idx.cells.get(key(sheet.cells[i].r, sheet.cells[i].c))));
        if (!cells.length) return;
        for (const i of cells) typed[s].add(i);
        summary.cells += cells.length;
        push({ ...step, cells });
        return;
      }
      case "fmt": {
        // A cell is in the step when this part of its own look differs (a step can set a range to its
        // commonest value before the cells that differ from it get theirs: the cell stays in both)
        const cells: Cell[] = [];
        for (const rect of step.rects) for (const cell of sheet.cells) {
          if (cell.r < rect[0] || cell.r > rect[2] || cell.c < rect[1] || cell.c > rect[3]) continue;
          if (aspectValue(have, have.styles[idx.look(cell.r, cell.c)], step.a) !== aspectValue(want, want.styles[cell.s ?? 0], step.a)) { cells.push(cell); const id = `${s}:${cell.r}:${cell.c}`; if (!looked.has(id)) { looked.add(id); summary.looks++; } }
        }
        if (cells.length) push({ ...step, rects: coverRects(cells.sort((a, b) => a.r - b.r || a.c - b.c)) });
        return;
      }
      case "span": {
        const span = sheet.spans?.[step.i];
        if (!span) return;
        const style = want.styles[span.v];
        const differs = span.rects.some(([r0, c0, r1, c1]) => {
          for (let r = r0; r <= Math.min(r1, mine.rowCount - 1); r++) for (let c = c0; c <= Math.min(c1, mine.colCount - 1); c++) {
            const theirs = have.styles[idx.look(r, c)];
            for (const a of ASPECTS) if (hasAspect(style, a) && aspectValue(want, style, a) !== aspectValue(have, theirs, a)) return true;
          }
          return r1 >= mine.rowCount || c1 >= mine.colCount;
        });
        if (differs) push(step);
        return;
      }
      case "band": push(step); return;
      case "runs": {
        const cell = sheet.cells[step.cell];
        const other = idx.cells.get(key(cell.r, cell.c));
        if (typed[s].has(step.cell) || canon([cell.runs, cell.link]) !== canon([other?.runs, other?.link])) push(step);
        return;
      }
      case "merge": {
        const mineMerges = new Set(mine.merges.map((m) => m.join()));
        const rects = step.rects.filter((r) => !mineMerges.has(r.join()));
        if (rects.length) push({ ...step, rects });
        return;
      }
      case "size": case "hide": {
        const a = sizes(want, s, step.d), b = sizes(have, h, step.d);
        let differs = false;
        for (let i = step.from; i <= step.to && !differs; i++) if (a[i] !== b[i]) differs = true;
        if (differs) push(step);
        return;
      }
      case "prop": {
        const differs = step.p === "gridlines" ? !!sheet.hideGridlines !== !!mine.hideGridlines
          : step.p === "freeze" ? (sheet.frozenRows ?? 0) !== (mine.frozenRows ?? 0) || (sheet.frozenCols ?? 0) !== (mine.frozenCols ?? 0)
          : step.p === "tab" ? hex(want, sheet.tabColor) !== hex(have, mine.tabColor) : !!sheet.hidden !== !!mine.hidden;
        if (differs) push(step);
        return;
      }
      case "dv": {
        const v = sheet.validations?.[step.i];
        if (v && !(mine.validations ?? []).some((x) => canon(x) === canon(v))) push(step);
        return;
      }
      case "filter": if (canon(sheet.filter) !== canon(mine.filter)) push(step); return;
      // Rules, groups, alternating colours and charts are made once a sheet: where the spreadsheet has
      // its own they are left as they are
      case "cf":
        if (!mine.conditional?.length) push(step); else if (canon(mine.conditional) !== canon(sheet.conditional)) kept.add(`"${sheet.name}" keeps its own conditional formatting.`);
        return;
      case "groups":
        if (!mine.groups?.length) push(step); else if (canon(mine.groups) !== canon(sheet.groups)) kept.add(`"${sheet.name}" keeps its own row and column groups.`);
        return;
      case "banding":
        if (!mine.banding?.length) push(step); else if (canon(mine.banding) !== canon(sheet.banding)) kept.add(`"${sheet.name}" keeps its own alternating colours.`);
        return;
      case "chart":
        if (!mine.charts?.length) push(step); else if (canon(mine.charts) !== canon(sheet.charts)) kept.add(`"${sheet.name}" keeps its own charts.`);
        return;
    }
  });

  // (a tab with nothing else to do still has its clearing)
  want.sheets.forEach((_sheet, s) => { if (!cleared.has(s)) out.push(...clears[s]); });
  // Sections: where each now starts, without the ones nothing is left of
  const sections: PlanSection[] = [];
  full.sections.forEach((sec, n) => {
    const end = n + 1 < full.sections.length ? full.sections[n + 1].at : full.steps.length;
    for (let k = sec.at; k < end; k++) if (newIndex[k] >= 0) { sections.push({ ...sec, at: newIndex[k] }); break; }
  });
  summary.kept = Array.from(kept);
  return { steps: out, sections, typed, summary };
}
