/**
 * The charts of a worksheet, read from its drawing part into the terms Google Sheets draws charts
 * in: a kind (column, bar, line, area, scatter, pie, or a mix), the ranges its series and labels
 * come from, titles, legend, and where it sits on the sheet.
 */

import { child, children, find, parseXml, type XmlNode } from "./xml";
import type { Zip } from "./zip";
import { layout, parseRange, type Chart, type ChartSource, type ChartType, type Color, type Rect, type Sheet } from "./model";
import { readRels } from "./xlsx-parts";

const EMU_PER_PX = 9525;

const KINDS: Record<string, "COLUMN" | "LINE" | "AREA" | "PIE" | "SCATTER"> = {
  barChart: "COLUMN", bar3DChart: "COLUMN", lineChart: "LINE", line3DChart: "LINE", areaChart: "AREA", area3DChart: "AREA",
  pieChart: "PIE", pie3DChart: "PIE", doughnutChart: "PIE", ofPieChart: "PIE", scatterChart: "SCATTER",
};
const UNSUPPORTED = ["radarChart", "bubbleChart", "stockChart", "surfaceChart", "surface3DChart"];
const LEGEND: Record<string, NonNullable<Chart["legend"]>> = { r: "RIGHT", tr: "RIGHT", l: "LEFT", t: "TOP", b: "BOTTOM" };

export interface ChartContext {
  zip: Zip;
  /** Sheets by name (lower case) → their place in the workbook */
  sheetIndex: ReadonlyMap<string, number>;
  /** A colour element's colour (the workbook's palette) */
  color(node: XmlNode | undefined): Color | undefined;
  warnings: Set<string>;
}

/** "'My sheet'!$B$2:$B$9" → the sheet and cells it names (one area on one sheet, or nothing) */
function sourceOf(ctx: ChartContext, formula: string | undefined): ChartSource | null {
  if (!formula) return null;
  const m = /^(?:'((?:[^']|'')+)'|([^'!(),]+))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/.exec(formula.trim());
  if (!m) return null;
  const sheet = ctx.sheetIndex.get((m[1] ?? m[2]).replace(/''/g, "'").toLowerCase());
  const rect = parseRange(m[3].replace(/\$/g, ""));
  return sheet == null || !rect ? null : { sheet, rect };
}

const refOf = (node: XmlNode | undefined): string | undefined => child(child(node, "strRef") ?? child(node, "numRef") ?? child(node, "multiLvlStrRef"), "f")?.text;

/** The text of a chart or axis title */
function titleText(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const parts: string[] = [];
  const walk = (n: XmlNode) => { if (n.tag === "t") parts.push(n.text); for (const c of n.children) walk(c); };
  const rich = find(node, "rich");
  if (rich) walk(rich);
  const text = parts.join("").trim();
  return text ? text.slice(0, 300) : undefined;
}

/** Whether `name` is the one cell just before `values` (above a column of them, left of a row) */
function isHeaderOf(name: ChartSource | null, values: ChartSource): boolean {
  if (!name || name.sheet !== values.sheet) return false;
  const [nr, nc, nr1, nc1] = name.rect;
  if (nr !== nr1 || nc !== nc1) return false;
  const [r0, c0, r1, c1] = values.rect;
  if (c0 === c1) return nc === c0 && nr === r0 - 1;
  if (r0 === r1) return nr === r0 && nc === c0 - 1;
  return false;
}

/** A range grown by the cell before it (its header) */
function withHeader(src: ChartSource): ChartSource {
  const [r0, c0, r1, c1] = src.rect;
  const rect: Rect = c0 === c1 ? [r0 - 1, c0, r1, c1] : [r0, c0 - 1, r1, c1];
  return { sheet: src.sheet, rect };
}

function readChart(ctx: ChartContext, xml: string): Omit<Chart, "at" | "size"> | null {
  const chart = find(parseXml(xml), "chart");
  const plot = child(chart, "plotArea");
  if (!chart || !plot) return null;
  if (plot.children.some((c) => UNSUPPORTED.includes(c.tag))) {
    ctx.warnings.add("Radar, bubble, stock and surface charts aren't copied: Google Sheets' chart tools don't take them from a file.");
    return null;
  }
  const groups = plot.children.filter((c) => KINDS[c.tag]);
  if (!groups.length) return null;

  const series: { src: ChartSource; name: ChartSource | null; type: "COLUMN" | "LINE" | "AREA"; color?: Color }[] = [];
  let domain: ChartSource | null = null;
  let type: ChartType | null = null;
  let stacked: Chart["stacked"];
  let hole: number | undefined;
  const kinds = new Set<string>();
  for (const group of groups) {
    let kind = KINDS[group.tag];
    const bar = group.tag.startsWith("bar") && child(group, "barDir")?.attrs.val === "bar";
    const grouping = child(group, "grouping")?.attrs.val;
    if (grouping === "stacked") stacked = "STACKED";
    else if (grouping === "percentStacked") stacked = "PERCENT_STACKED";
    if (group.tag === "doughnutChart") hole = 0.5;
    for (const ser of children(group, "ser")) {
      const values = sourceOf(ctx, refOf(child(ser, kind === "SCATTER" ? "yVal" : "val")));
      if (!values) continue;
      const labels = sourceOf(ctx, refOf(child(ser, kind === "SCATTER" ? "xVal" : "cat")));
      if (labels && !domain) domain = labels;
      const shape = child(ser, "spPr");
      const fill = child(shape, "solidFill") ?? child(child(shape, "ln"), "solidFill");
      const color = fill ? ctx.color(child(fill, "srgbClr") ? { tag: "color", attrs: { rgb: child(fill, "srgbClr")!.attrs.val ?? "" }, children: [], text: "" } : undefined) : undefined;
      series.push({ src: values, name: sourceOf(ctx, refOf(child(ser, "tx"))), type: kind === "LINE" || kind === "SCATTER" ? "LINE" : kind === "AREA" ? "AREA" : "COLUMN", ...(color ? { color } : {}) });
    }
    if (kind === "COLUMN" && bar) kind = "COLUMN";
    kinds.add(bar ? "BAR" : kind);
    type = type == null ? (bar ? "BAR" : kind) : type;
  }
  if (!series.length || !type) return null;
  if (kinds.size > 1) type = kinds.has("PIE") || kinds.has("SCATTER") || kinds.has("BAR") ? type : "COMBO";
  if (type === "PIE") series.length = 1;

  // When every series is named by the cell just before its values, the ranges take that cell in
  const headed = series.every((s) => isHeaderOf(s.name, s.src));
  const firstRect = series[0].src.rect;
  const room = firstRect[1] === firstRect[3] ? firstRect[0] > 0 : firstRect[1] > 0;
  const headers: 0 | 1 = headed && room ? 1 : 0;
  // (the labels grow the same way, so every range stays as long as the others)
  const domainRoom = domain ? (domain.rect[1] === domain.rect[3] ? domain.rect[0] > 0 : domain.rect[1] > 0) : true;
  const useHeaders = headers === 1 && domainRoom;

  const out: Omit<Chart, "at" | "size"> = {
    type,
    series: series.map((s) => ({ src: useHeaders ? withHeader(s.src) : s.src, ...(type === "COMBO" ? { type: s.type } : {}), ...(s.color ? { color: s.color } : {}) })),
  };
  if (domain) out.domain = useHeaders ? withHeader(domain) : domain;
  if (useHeaders) out.headers = 1;
  if (stacked && type !== "PIE" && type !== "SCATTER") out.stacked = stacked;
  if (hole) out.hole = hole;
  const title = titleText(child(chart, "title"));
  if (title) out.title = title;
  const legend = child(chart, "legend");
  out.legend = legend ? LEGEND[child(legend, "legendPos")?.attrs.val ?? "r"] ?? "RIGHT" : "NONE";
  const xTitle = titleText(child(child(plot, "catAx") ?? child(plot, "dateAx") ?? children(plot, "valAx")[type === "SCATTER" ? 0 : 99], "title"));
  const valAxes = children(plot, "valAx");
  const yTitle = titleText(child(valAxes[type === "SCATTER" ? 1 : 0], "title"));
  if (xTitle) out.xTitle = xTitle;
  if (yTitle) out.yTitle = yTitle;
  return out;
}

/** The charts in a sheet's drawing part, placed in the sheet's own pixels */
export async function readCharts(ctx: ChartContext, drawingPart: string, sheet: Sheet): Promise<Chart[]> {
  const xml = await ctx.zip.text(drawingPart);
  if (!xml) return [];
  const root = parseXml(xml).children[0];
  if (!root) return [];
  const rels = await readRels(ctx.zip, drawingPart);
  // Columns take their width and a gridline on screen (see timeline.ts); rows their height
  const cols = layout(sheet.colPx, Math.max(sheet.colCount, 200), sheet.defaultColPx, sheet.hiddenCols).sizes.map((px) => (px > 0 ? px + 1 : 0));
  const rows = layout(sheet.rowPx, Math.max(sheet.rowCount, 2000), sheet.defaultRowPx, sheet.hiddenRows).sizes;
  const offset = (sizes: number[], index: number) => { let at = 0; for (let i = 0; i < index && i < sizes.length; i++) at += sizes[i]; return at; };
  const num = (node: XmlNode | undefined, tag: string) => Number(child(node, tag)?.text ?? 0) || 0;
  const charts: Chart[] = [];
  for (const anchor of root.children) {
    if (!/Anchor$/.test(anchor.tag)) continue;
    const frame = child(anchor, "graphicFrame");
    const relId = find(frame, "chart")?.attrs["r:id"];
    const rel = relId ? rels.get(relId) : undefined;
    if (!frame || !rel || rel.external) continue;
    const chartXml = await ctx.zip.text(rel.target);
    const spec = chartXml ? readChart(ctx, chartXml) : null;
    if (!spec) continue;
    const from = child(anchor, "from");
    const to = child(anchor, "to");
    const ext = child(anchor, "ext");
    const r = num(from, "row"), c = num(from, "col");
    const dx = Math.round(num(from, "colOff") / EMU_PER_PX), dy = Math.round(num(from, "rowOff") / EMU_PER_PX);
    let w = 600, h = 371;
    if (to) {
      w = offset(cols, num(to, "col")) + num(to, "colOff") / EMU_PER_PX - (offset(cols, c) + dx);
      h = offset(rows, num(to, "row")) + num(to, "rowOff") / EMU_PER_PX - (offset(rows, r) + dy);
    } else if (ext) { w = Number(ext.attrs.cx) / EMU_PER_PX; h = Number(ext.attrs.cy) / EMU_PER_PX; }
    if (!(w > 20 && h > 20)) { w = 600; h = 371; }
    charts.push({ at: [Math.min(r, sheet.rowCount - 1), Math.min(c, sheet.colCount - 1), Math.max(0, dx), Math.max(0, dy)], size: [Math.round(Math.min(w, 4000)), Math.round(Math.min(h, 4000))], ...spec });
  }
  return charts;
}
