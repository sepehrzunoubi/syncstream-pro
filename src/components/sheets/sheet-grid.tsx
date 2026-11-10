"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cellKey, cellName, colName, type Border, type Cell, type CellStyle, type FontStyle, type Rect, type Workbook } from "@/lib/sheets/model";
import type { SheetView } from "@/lib/sheets/timeline";
import { conditionalLooks, type ConditionalLook } from "@/lib/sheets/conditional";
import { CELL_PADDING, INDENT_PX } from "@/lib/sheets/steps";
import { cssColor, cssFont, shownValue } from "./display";
import { SheetChart } from "./sheet-chart";

/** Google Sheets' own measures: the row numbers' column, the column letters' row */
export const ROW_HEADER_W = 46;
export const COL_HEADER_H = 24;
const OVERSCAN_ROWS = 8;
const OVERSCAN_COLS = 3;

export interface GridSelection { r: number; c: number }

interface GridProps {
  wb: Workbook;
  view: SheetView;
  selected: GridSelection | null;
  onSelect: (sel: GridSelection) => void;
  /** Keep what the sync last touched in sight */
  follow?: boolean;
  /** Names the grid for assistive tech and tests */
  label: string;
}

/** The first index whose end is past `at`: the row or column at that pixel */
function indexAt(offsets: number[], at: number): number {
  let lo = 0, hi = offsets.length - 2;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= at) lo = mid + 1; else hi = mid; }
  return Math.max(0, lo);
}

const BORDER_CSS: Record<Border["style"], { width: number; style: string }> = {
  SOLID: { width: 1, style: "solid" }, SOLID_MEDIUM: { width: 2, style: "solid" }, SOLID_THICK: { width: 3, style: "solid" },
  DASHED: { width: 1, style: "dashed" }, DOTTED: { width: 1, style: "dotted" }, DOUBLE: { width: 3, style: "double" },
};

function fontCss(wb: Workbook, font: FontStyle | undefined, fallback: { family: string; size: number }, own = true): React.CSSProperties {
  const css: React.CSSProperties = {};
  if (own || font?.family) css.fontFamily = cssFont(font?.family ?? fallback.family);
  if (own || font?.size) css.fontSize = `${font?.size ?? fallback.size}pt`;
  if (font?.bold) css.fontWeight = 700;
  if (font?.italic) css.fontStyle = "italic";
  const deco = [font?.underline ? "underline" : "", font?.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) css.textDecoration = deco;
  const color = cssColor(wb, font?.color);
  if (color) css.color = color;
  return css;
}

/** The cell's text, in runs when part of it has a look of its own */
function cellText(wb: Workbook, cell: Cell, text: string, rich: boolean, fallback: { family: string; size: number }): React.ReactNode {
  if (!rich || (!cell.runs?.length && !cell.link)) return text;
  const runs = cell.runs?.length ? cell.runs : [{ at: 0, font: {} as FontStyle }];
  const link: React.CSSProperties = cell.link ? { color: "#1155cc", textDecoration: "underline" } : {};
  return runs.map((run, i) => {
    const end = i + 1 < runs.length ? runs[i + 1].at : text.length;
    return <span key={i} style={{ ...link, ...fontCss(wb, run.font, fallback, false) }}>{text.slice(run.at, end)}</span>;
  });
}

/** What every part of the grid needs to draw cells: the sheet, and where things are in it */
interface Scene {
  wb: Workbook;
  view: SheetView;
  rowSpans: Map<number, [number, number]>;
  cellAt: Map<number, number>;
  mergeOf: Map<number, Rect>;
  looks: Map<number, ConditionalLook> | null;
}

interface RegionProps {
  scene: Scene;
  /** Rows drawn, inclusive */
  r0: number;
  r1: number;
  /** Columns the gridlines span, inclusive */
  c0: number;
  c1: number;
  selection: Rect | null;
}

/**
 * The cells of some rows: gridlines, fills, text, borders, the selection and what the sync last
 * touched. The main grid is one region; frozen rows and columns are regions of their own that stay
 * put above it.
 */
const Region = React.memo(function Region({ scene, r0, r1, c0, c1, selection }: RegionProps) {
  const { wb, view, rowSpans, cellAt, mergeOf, looks } = scene;
  const { sheet, rows, cols } = view;
  const fills: React.ReactNode[] = [];
  const texts: React.ReactNode[] = [];
  const lines: React.ReactNode[] = [];
  const shows = (i: number): boolean => {
    const cell = sheet.cells[i];
    if (cell.spill) { const a = cellAt.get(cellKey(cell.spill[0], cell.spill[1])); return a != null && view.typed(a); }
    return view.typed(i);
  };
  const hasText = (i: number): boolean => { const cell = sheet.cells[i]; return shows(i) && (cell.e != null || (cell.v != null && cell.v !== "")); };

  if (!view.hideGridlines) {
    const x0 = cols.offsets[c0], x1 = cols.offsets[c1 + 1], y0 = rows.offsets[r0], y1 = rows.offsets[r1 + 1];
    for (let r = r0; r <= r1; r++) if (rows.sizes[r]) fills.push(<div key={`h${r}`} className="sx-gridline" style={{ left: x0, top: rows.offsets[r + 1] - 1, width: x1 - x0, height: 1 }} />);
    for (let c = c0; c <= c1; c++) if (cols.sizes[c]) fills.push(<div key={`v${c}`} className="sx-gridline" style={{ left: cols.offsets[c + 1] - 1, top: y0, width: 1, height: y1 - y0 }} />);
  }
  // Merged areas hide the gridlines inside them
  for (const rect of view.merges) {
    if (rect[2] < r0 || rect[0] > r1) continue;
    const i = cellAt.get(cellKey(rect[0], rect[1]));
    const fill = i != null ? cssColor(wb, looks?.get(i)?.fill ?? view.styleOf(i)?.fill) : undefined;
    fills.push(<div key={`m${rect.join()}`} className="sx-fill" style={{ left: cols.offsets[rect[1]], top: rows.offsets[rect[0]], width: cols.offsets[rect[3] + 1] - cols.offsets[rect[1]] - (fill ? 0 : 1), height: rows.offsets[rect[2] + 1] - rows.offsets[rect[0]] - (fill ? 0 : 1), background: fill ?? "#fff" }} />);
  }

  for (let r = r0; r <= r1; r++) {
    const span = rowSpans.get(r);
    if (!span || !rows.sizes[r]) continue;
    for (let i = span[0]; i < span[1]; i++) {
      const cell = sheet.cells[i];
      const c = cell.c;
      if (c >= sheet.colCount) continue;
      const merge = mergeOf.get(cellKey(r, c));
      const anchor = !merge || (merge[0] === r && merge[1] === c);
      const style: CellStyle | undefined = view.styleOf(i);
      const look = looks?.get(i);
      const left = cols.offsets[c], top = rows.offsets[r];
      const width = merge && anchor ? cols.offsets[merge[3] + 1] - left : cols.sizes[c];
      const height = merge && anchor ? rows.offsets[merge[2] + 1] - top : rows.sizes[r];

      // Borders, drawn on the gridlines; a merged cell's inner sides have none
      if (style?.borders && cols.sizes[c]) {
        const b = style.borders;
        const w = cols.sizes[c], h = rows.sizes[r];
        const line = (side: "top" | "bottom" | "left" | "right", border: Border) => {
          if (merge && ((side === "top" && r > merge[0]) || (side === "bottom" && r < merge[2]) || (side === "left" && c > merge[1]) || (side === "right" && c < merge[3]))) return;
          const css = BORDER_CSS[border.style];
          const color = cssColor(wb, border.color) ?? "#000";
          const back = Math.floor(css.width / 2);
          const horizontal = side === "top" || side === "bottom";
          const at = side === "top" ? top - 1 - back : side === "bottom" ? top + h - 1 - back : side === "left" ? left - 1 - back : left + w - 1 - back;
          lines.push(<div key={`b${i}${side}`} className="sx-border" style={horizontal
            ? { left: left - 1, top: at, width: w + 1, borderTop: `${css.width}px ${css.style} ${color}` }
            : { left: at, top: top - 1, height: h + 1, borderLeft: `${css.width}px ${css.style} ${color}` }} />);
        };
        if (b.top) line("top", b.top);
        if (b.bottom) line("bottom", b.bottom);
        if (b.left) line("left", b.left);
        if (b.right) line("right", b.right);
      }
      if (!anchor || !cols.sizes[c]) continue;
      const fill = cssColor(wb, look?.fill ?? style?.fill);
      if (fill && !merge) fills.push(<div key={`f${i}`} className="sx-fill" style={{ left, top, width, height, background: fill }} />);
      if (cell.note && view.typed(i)) lines.push(<div key={`n${i}`} className="sx-note" style={{ left: left + width - 8, top }} title={cell.note} />);
      // A filter's first row carries its buttons
      const f = view.filter;
      if (f && r === f[0] && c >= f[1] && c <= f[3] && width > 22) lines.push(<div key={`q${i}`} className="sx-filter-btn" style={{ left: left + width - 19, top: top + Math.max(1, height - 19) }} aria-hidden="true" />);
      if (!hasText(i)) continue;

      const shown = shownValue(cell, style);
      const align = style?.hAlign ? (style.hAlign.toLowerCase() as "left" | "center" | "right") : shown.align;
      const wraps = style?.wrap === "WRAP";
      // Text runs over the empty cells beside it, up to the next cell that shows something
      let clipLeft = left, clipRight = left + width;
      if (shown.overflows && !wraps && style?.wrap !== "CLIP" && !merge && !style?.rotation) {
        if (align !== "right") {
          let limit = sheet.colCount;
          for (let j = i + 1; j < span[1]; j++) if (hasText(j) || mergeOf.has(cellKey(r, sheet.cells[j].c))) { limit = sheet.cells[j].c; break; }
          for (let cc = c + 1; cc < limit; cc++) if (mergeOf.has(cellKey(r, cc))) { limit = cc; break; }
          clipRight = Math.min(cols.offsets[Math.min(limit, sheet.colCount)], left + width + 2400);
        }
        if (align !== "left") {
          let limit = -1;
          for (let j = i - 1; j >= span[0]; j--) if (hasText(j) || mergeOf.has(cellKey(r, sheet.cells[j].c))) { limit = sheet.cells[j].c; break; }
          for (let cc = c - 1; cc > limit; cc--) if (mergeOf.has(cellKey(r, cc))) { limit = cc; break; }
          clipLeft = Math.max(cols.offsets[limit + 1], left - 2400);
        }
      }
      const v = style?.vAlign ?? "BOTTOM";
      const font = fontCss(wb, look ? { ...(style?.font ?? {}), ...(look.color ? { color: look.color } : {}), ...(look.bold ? { bold: true } : {}), ...(look.italic ? { italic: true } : {}), ...(look.underline ? { underline: true } : {}), ...(look.strike ? { strike: true } : {}) } : style?.font, view.defaultFont);
      if (shown.color && !look?.color) font.color = shown.color;
      const rotate = style?.rotation;
      const indent = (style?.indent ?? 0) * INDENT_PX;
      const inner: React.CSSProperties = {
        // (the last pixel of a column is its gridline: text keeps clear of it)
        left: left - clipLeft, width: width - 1, height,
        justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
        alignItems: v === "TOP" ? "flex-start" : v === "MIDDLE" ? "center" : "flex-end",
        textAlign: align, whiteSpace: wraps ? "pre-wrap" : "pre", ...(wraps ? { overflowWrap: "anywhere" as const } : {}), ...font,
        ...(indent ? (align === "right" ? { paddingRight: CELL_PADDING.right + indent } : { paddingLeft: CELL_PADDING.left + indent }) : {}),
      };
      const body = cellText(wb, cell, shown.text, view.rich(i), view.defaultFont);
      texts.push(
        <div key={`t${i}`} className="sx-clip" style={{ left: clipLeft, top, width: clipRight - clipLeft - 1, height: height - 1 }}>
          <div className="sx-text" data-cell={cellName(r, c)} style={inner}>
            {rotate === "vertical" ? <span style={{ writingMode: "vertical-rl", textOrientation: "upright", letterSpacing: "-2px" }}>{body}</span>
              : typeof rotate === "number" ? <span style={{ display: "inline-block", transform: `rotate(${-rotate}deg)`, transformOrigin: "center" }}>{body}</span>
              : wraps ? <span style={{ minWidth: 0, maxWidth: "100%" }}>{body}</span> : body}
          </div>
        </div>
      );
    }
  }
  const box = (rect: Rect) => ({ left: cols.offsets[rect[1]] - 1, top: rows.offsets[rect[0]] - 1, width: cols.offsets[Math.min(rect[3], sheet.colCount - 1) + 1] - cols.offsets[rect[1]] + 1, height: rows.offsets[Math.min(rect[2], sheet.rowCount - 1) + 1] - rows.offsets[rect[0]] + 1 });
  return (
    <>
      {fills}
      {texts}
      {lines}
      {view.focus.filter((f) => f[2] >= r0 && f[0] <= r1).map((f, i) => <div key={`focus${i}`} className="sx-focus" style={box(f)} />)}
      {selection && selection[2] >= r0 && selection[0] <= r1 && <div className="sx-selection" data-testid="sx-selection" style={box(selection)} />}
    </>
  );
});

export function SheetGrid({ wb, view, selected, onSelect, follow, label }: GridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [port, setPort] = useState({ left: 0, top: 0, width: 1200, height: 700 });
  const frame = useRef(0);
  const { sheet, rows, cols } = view;
  const totalW = cols.offsets[cols.offsets.length - 1];
  const totalH = rows.offsets[rows.offsets.length - 1];

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setPort((p) => (p.left === el.scrollLeft && p.top === el.scrollTop && p.width === el.clientWidth && p.height === el.clientHeight ? p : { left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight }));
  }, []);
  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  }, [measure]);
  useLayoutEffect(() => {
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(frame.current); };
  }, [measure]);

  // Cells by row, what each merged cell belongs to, and what conditional formatting paints
  const rowSpans = useMemo(() => {
    const spans = new Map<number, [number, number]>();
    sheet.cells.forEach((c, i) => { const s = spans.get(c.r); if (s) s[1] = i + 1; else spans.set(c.r, [i, i + 1]); });
    return spans;
  }, [sheet]);
  const cellAt = useMemo(() => { const m = new Map<number, number>(); sheet.cells.forEach((c, i) => m.set(cellKey(c.r, c.c), i)); return m; }, [sheet]);
  const merges = view.merges;
  const mergeOf = useMemo(() => {
    const m = new Map<number, Rect>();
    for (const rect of merges) for (let r = rect[0]; r <= rect[2]; r++) for (let c = rect[1]; c <= rect[3]; c++) m.set(cellKey(r, c), rect);
    return m;
  }, [merges]);
  const allLooks = useMemo(() => conditionalLooks(sheet, wb.theme ?? {}), [sheet, wb.theme]);
  const looks = view.conditional && allLooks.size ? allLooks : null;
  const scene = useMemo<Scene>(() => ({ wb, view, rowSpans, cellAt, mergeOf, looks }), [wb, view, rowSpans, cellAt, mergeOf, looks]);

  const frozenRows = Math.min(view.frozenRows, sheet.rowCount - 1);
  const frozenCols = Math.min(view.frozenCols, sheet.colCount - 1);
  const frozenH = rows.offsets[frozenRows];
  const frozenW = cols.offsets[frozenCols];

  // Frozen rows and columns take room at the top and left: what scrolls starts after them
  const r0 = Math.max(0, indexAt(rows.offsets, port.top + frozenH) - OVERSCAN_ROWS);
  const r1 = Math.min(sheet.rowCount - 1, indexAt(rows.offsets, port.top + port.height) + OVERSCAN_ROWS);
  const c0 = Math.max(0, indexAt(cols.offsets, port.left + frozenW) - OVERSCAN_COLS);
  const c1 = Math.min(sheet.colCount - 1, indexAt(cols.offsets, port.left + port.width) + OVERSCAN_COLS);

  /** The rectangle of a cell, or of the merged area it is part of */
  const rectOf = useCallback((r: number, c: number): Rect => mergeOf.get(cellKey(r, c)) ?? [r, c, r, c], [mergeOf]);

  const pick = (e: React.MouseEvent) => {
    const el = scroller.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    // A click on a frozen row or column is on the cell shown there, wherever the rest has scrolled to
    const px = e.clientX - box.left - ROW_HEADER_W, py = e.clientY - box.top - COL_HEADER_H;
    const x = px < frozenW ? px : px + el.scrollLeft;
    const y = py < frozenH ? py : py + el.scrollTop;
    if (x < 0 || y < 0 || x >= totalW || y >= totalH) return;
    const m = rectOf(indexAt(rows.offsets, y), indexAt(cols.offsets, x));
    onSelect({ r: m[0], c: m[1] });
  };

  const reveal = useCallback((rect: Rect, smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    const left = cols.offsets[rect[1]], right = cols.offsets[Math.min(rect[3], rect[1] + 12) + 1], top = rows.offsets[rect[0]], bottom = rows.offsets[Math.min(rect[2], rect[0] + 20) + 1];
    const viewW = el.clientWidth - ROW_HEADER_W, viewH = el.clientHeight - COL_HEADER_H;
    let toLeft = el.scrollLeft, toTop = el.scrollTop;
    if (rect[1] >= frozenCols) {
      if (left < el.scrollLeft + frozenW) toLeft = Math.max(0, left - frozenW - 60);
      else if (right > el.scrollLeft + viewW) toLeft = Math.max(0, Math.min(left - frozenW - 60, right - viewW + 60));
    }
    if (rect[0] >= frozenRows) {
      if (top < el.scrollTop + frozenH) toTop = Math.max(0, top - frozenH - 80);
      else if (bottom > el.scrollTop + viewH) toTop = Math.max(0, bottom - viewH + 120);
    }
    if (toLeft !== el.scrollLeft || toTop !== el.scrollTop) el.scrollTo({ left: toLeft, top: toTop, behavior: smooth ? "smooth" : "auto" });
  }, [cols, rows, frozenCols, frozenRows, frozenW, frozenH]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!selected || e.ctrlKey || e.metaKey || e.altKey) return;
    const m = rectOf(selected.r, selected.c);
    let { r, c } = selected;
    const step = (from: number, by: number, sizes: number[]) => { let i = from + by; while (i > 0 && i < sizes.length - 1 && !sizes[i]) i += by; return i; };
    if (e.key === "ArrowDown" || e.key === "Enter") r = step(m[2], 1, rows.sizes);
    else if (e.key === "ArrowUp") r = step(m[0], -1, rows.sizes);
    else if (e.key === "ArrowRight" || e.key === "Tab") c = step(m[3], 1, cols.sizes);
    else if (e.key === "ArrowLeft") c = step(m[1], -1, cols.sizes);
    else return;
    e.preventDefault();
    r = Math.max(0, Math.min(sheet.rowCount - 1, r));
    c = Math.max(0, Math.min(sheet.colCount - 1, c));
    const to = rectOf(r, c);
    onSelect({ r: to[0], c: to[1] });
    reveal([to[0], to[1], to[0], to[1]], false);
  };

  // A running sync, or the preview playing: what it just touched stays in sight
  const focus = view.focus;
  const focusKey = focus.map((f) => f.join()).join(";");
  useEffect(() => {
    if (follow && focus.length) reveal(focus[0], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, focusKey, reveal]);

  const selection = selected && selected.r < sheet.rowCount && selected.c < sheet.colCount ? rectOf(selected.r, selected.c) : null;
  const colHead = (c: number) => (
    <div key={c} className="sx-colhead" data-on={(!!selection && c >= selection[1] && c <= selection[3]) || undefined} style={{ left: cols.offsets[c], width: cols.sizes[c] }}>{colName(c)}</div>
  );
  const rowHead = (r: number) => (
    <div key={r} className="sx-rowhead" data-on={(!!selection && r >= selection[0] && r <= selection[2]) || undefined} style={{ top: rows.offsets[r], height: rows.sizes[r] }}>{r + 1}</div>
  );
  const colHeads: React.ReactNode[] = [];
  for (let c = c0; c <= c1; c++) if (cols.sizes[c]) colHeads.push(colHead(c));
  const rowHeads: React.ReactNode[] = [];
  for (let r = r0; r <= r1; r++) if (rows.sizes[r]) rowHeads.push(rowHead(r));
  const frozenColHeads: React.ReactNode[] = [];
  for (let c = 0; c < frozenCols; c++) if (cols.sizes[c]) frozenColHeads.push(colHead(c));
  const frozenRowHeads: React.ReactNode[] = [];
  for (let r = 0; r < frozenRows; r++) if (rows.sizes[r]) frozenRowHeads.push(rowHead(r));

  return (
    <div ref={scroller} className="sx-grid" onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-label={label} aria-rowcount={sheet.rowCount} aria-colcount={sheet.colCount}>
      <div className="sx-top" style={{ width: ROW_HEADER_W + totalW, height: COL_HEADER_H }}>
        <div className="sx-corner" style={{ width: ROW_HEADER_W, height: COL_HEADER_H }} />
        {frozenCols > 0 && <div className="sx-pin" style={{ left: ROW_HEADER_W, zIndex: 2 }}><div className="sx-pinned" style={{ width: frozenW, height: COL_HEADER_H }}>{frozenColHeads}</div></div>}
        <div className="sx-colheads" style={{ left: ROW_HEADER_W, width: totalW, height: COL_HEADER_H }}>{colHeads}</div>
      </div>
      <div className="sx-body" style={{ width: ROW_HEADER_W + totalW, height: totalH }} onMouseDown={pick}>
        <div className="sx-rowheads" style={{ width: ROW_HEADER_W, height: totalH }}>
          {frozenRows > 0 && <div className="sx-pin-top" style={{ top: COL_HEADER_H, zIndex: 2 }}><div className="sx-pinned" style={{ width: ROW_HEADER_W, height: frozenH }}>{frozenRowHeads}</div></div>}
          {rowHeads}
        </div>
        {/* Frozen panes: the same cells, drawn again in strips that don't scroll away */}
        {frozenRows > 0 && frozenCols > 0 && (
          <div className="sx-pin sx-pin-both" style={{ left: ROW_HEADER_W, top: COL_HEADER_H, zIndex: 5 }}>
            <div className="sx-pinned sx-frozen" data-testid="sx-frozen-corner" style={{ width: frozenW, height: frozenH }}><Region scene={scene} r0={0} r1={frozenRows - 1} c0={0} c1={frozenCols - 1} selection={selection} /></div>
          </div>
        )}
        {frozenCols > 0 && (
          <div className="sx-pin" style={{ left: ROW_HEADER_W, zIndex: 3 }}>
            <div className="sx-pinned sx-frozen sx-frozen-cols" data-testid="sx-frozen-cols" style={{ width: frozenW, height: totalH }}><Region scene={scene} r0={r0} r1={r1} c0={0} c1={frozenCols - 1} selection={selection} /></div>
          </div>
        )}
        {frozenRows > 0 && (
          <div className="sx-pin-top" style={{ top: COL_HEADER_H, zIndex: 4 }}>
            <div className="sx-pinned sx-frozen sx-frozen-rows" data-testid="sx-frozen-rows" style={{ left: ROW_HEADER_W, width: totalW, height: frozenH }}><Region scene={scene} r0={0} r1={frozenRows - 1} c0={c0} c1={c1} selection={selection} /></div>
          </div>
        )}
        <div className="sx-cells" style={{ left: ROW_HEADER_W, width: totalW, height: totalH }}>
          <Region scene={scene} r0={r0} r1={r1} c0={c0} c1={c1} selection={selection} />
          {view.charts.map((chart, i) => <SheetChart key={i} wb={wb} chart={chart} left={cols.offsets[Math.min(chart.at[1], sheet.colCount - 1)] + chart.at[2]} top={rows.offsets[Math.min(chart.at[0], sheet.rowCount - 1)] + chart.at[3]} />)}
        </div>
      </div>
    </div>
  );
}
