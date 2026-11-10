"use client";

import React, { useMemo } from "react";
import { cellKey, type Chart, type ChartSource, type Workbook } from "@/lib/sheets/model";
import { cssColor } from "./display";

/** Google Sheets' own series colours, in the order it hands them out */
const PALETTE = ["#4285f4", "#ea4335", "#fbbc04", "#34a853", "#ff6d01", "#46bdc6", "#7baaf7", "#f07b72", "#fcd04f", "#71c287"];
const FONT = "Roboto, Arial, sans-serif";

const cellMaps = new WeakMap<object, Map<number, number | string | boolean | undefined>>();
/** What the workbook's cells held when it was saved, by sheet and position */
function valueAt(wb: Workbook, sheet: number, r: number, c: number): number | string | boolean | undefined {
  const s = wb.sheets[sheet];
  if (!s) return undefined;
  let map = cellMaps.get(s);
  if (!map) { map = new Map(s.cells.map((cell) => [cellKey(cell.r, cell.c), cell.v])); cellMaps.set(s, map); }
  return map.get(cellKey(r, c));
}

/** A range's cells in order, down a column or along a row */
function read(wb: Workbook, src: ChartSource): (number | string | boolean | undefined)[] {
  const [r0, c0, r1, c1] = src.rect;
  const out: (number | string | boolean | undefined)[] = [];
  if (c0 === c1) for (let r = r0; r <= r1; r++) out.push(valueAt(wb, src.sheet, r, c0));
  else for (let c = c0; c <= c1; c++) out.push(valueAt(wb, src.sheet, r0, c));
  return out;
}

/** A round number at or above `max`, and the steps up to it */
function niceScale(min: number, max: number): { lo: number; hi: number; step: number } {
  if (!(max > min)) { max = min + 1; }
  const lo0 = Math.min(0, min);
  const raw = (max - lo0) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return { lo: Math.floor(lo0 / step) * step, hi: Math.ceil(max / step) * step, step };
}

const short = (n: number): string => (Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${+(n / 1e3).toFixed(1)}K` : String(+n.toFixed(2)));

interface Data { labels: string[]; series: { name: string; values: (number | null)[]; color: string; type: "COLUMN" | "LINE" | "AREA" }[]; xs: (number | null)[] }

function dataOf(wb: Workbook, chart: Chart): Data {
  const head = chart.headers ? 1 : 0;
  const domain = chart.domain ? read(wb, chart.domain).slice(head) : [];
  const series = chart.series.map((s, i) => {
    const cells = read(wb, s.src);
    const kind = chart.type === "COMBO" ? s.type ?? "COLUMN" : chart.type === "LINE" || chart.type === "SCATTER" ? "LINE" : chart.type === "AREA" ? "AREA" : "COLUMN";
    return {
      name: head && cells[0] != null ? String(cells[0]) : `Series ${i + 1}`,
      values: cells.slice(head).map((v) => (typeof v === "number" ? v : null)),
      color: cssColor(wb, s.color) ?? PALETTE[i % PALETTE.length],
      type: kind as "COLUMN" | "LINE" | "AREA",
    };
  });
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const labels = Array.from({ length: n }, (_x, i) => (domain[i] == null ? "" : String(domain[i])));
  return { labels, series, xs: domain.map((v) => (typeof v === "number" ? v : null)) };
}

/** A chart drawn the way Google Sheets draws one from the same ranges: close in look, not its renderer */
export function SheetChart({ wb, chart, left, top }: { wb: Workbook; chart: Chart; left: number; top: number }) {
  const [w, h] = chart.size;
  const data = useMemo(() => dataOf(wb, chart), [wb, chart]);
  const body = useMemo(() => {
    const titleH = chart.title ? 34 : 12;
    const legend = chart.legend ?? "RIGHT";
    const names = chart.type === "PIE" ? data.labels : data.series.map((s) => s.name);
    const legendW = legend === "RIGHT" || legend === "LEFT" ? Math.min(w * 0.3, 28 + Math.max(0, ...names.map((n) => n.length)) * 6.5) : 0;
    const legendH = legend === "TOP" || legend === "BOTTOM" ? 22 : 0;
    const plot = {
      x: (legend === "LEFT" ? legendW : 0) + (chart.type === "PIE" ? 12 : chart.type === "BAR" ? 78 : 52) + (chart.yTitle && chart.type !== "BAR" ? 16 : 0),
      y: titleH + (legend === "TOP" ? legendH : 0),
      r: w - (legend === "RIGHT" ? legendW : 0) - 14,
      b: h - (legend === "BOTTOM" ? legendH : 0) - (chart.type === "PIE" ? 12 : 30) - (chart.xTitle ? 16 : 0),
    };
    const pw = Math.max(10, plot.r - plot.x), ph = Math.max(10, plot.b - plot.y);
    const out: React.ReactNode[] = [];
    const n = data.labels.length;

    if (chart.type === "PIE") {
      const values = (data.series[0]?.values ?? []).map((v) => Math.max(0, v ?? 0));
      const total = values.reduce((a, b) => a + b, 0) || 1;
      const cx = plot.x + pw / 2, cy = plot.y + ph / 2, radius = Math.min(pw, ph) / 2;
      let angle = -Math.PI / 2;
      values.forEach((v, i) => {
        const sweep = (v / total) * Math.PI * 2;
        const a0 = angle, a1 = angle + sweep;
        angle = a1;
        if (sweep <= 0) return;
        const p = (a: number, rad: number) => `${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`;
        const inner = radius * (chart.hole ?? 0);
        const large = sweep > Math.PI ? 1 : 0;
        const d = sweep >= Math.PI * 2 - 1e-6
          ? `M${cx - radius},${cy}a${radius},${radius} 0 1,0 ${radius * 2},0a${radius},${radius} 0 1,0 ${-radius * 2},0`
          : inner > 0
            ? `M${p(a0, radius)}A${radius},${radius} 0 ${large},1 ${p(a1, radius)}L${p(a1, inner)}A${inner},${inner} 0 ${large},0 ${p(a0, inner)}Z`
            : `M${cx},${cy}L${p(a0, radius)}A${radius},${radius} 0 ${large},1 ${p(a1, radius)}Z`;
        out.push(<path key={`s${i}`} d={d} fill={PALETTE[i % PALETTE.length]} stroke="#fff" strokeWidth={1} />);
      });
    } else {
      const horizontal = chart.type === "BAR";
      const stacked = !!chart.stacked;
      const percent = chart.stacked === "PERCENT_STACKED";
      const totals = Array.from({ length: n }, (_x, i) => data.series.reduce((s, ser) => s + Math.abs(ser.values[i] ?? 0), 0));
      const valueOf = (ser: Data["series"][number], i: number) => { const v = ser.values[i]; return v == null ? null : percent ? (totals[i] ? v / totals[i] : 0) : v; };
      const all: number[] = [];
      if (stacked) for (let i = 0; i < n; i++) all.push(percent ? 1 : data.series.reduce((s, ser) => s + Math.max(0, ser.values[i] ?? 0), 0));
      else for (const ser of data.series) for (let i = 0; i < ser.values.length; i++) { const v = valueOf(ser, i); if (v != null) all.push(v); }
      const scale = niceScale(Math.min(0, ...all), Math.max(1e-9, ...all));
      const span = scale.hi - scale.lo || 1;
      const along = (v: number) => (horizontal ? plot.x + ((v - scale.lo) / span) * pw : plot.b - ((v - scale.lo) / span) * ph);
      // The value axis: its lines and numbers
      for (let v = scale.lo; v <= scale.hi + scale.step / 2; v += scale.step) {
        const at = along(v);
        out.push(horizontal
          ? <line key={`g${v}`} x1={at} x2={at} y1={plot.y} y2={plot.b} stroke={v === 0 ? "#333" : "#e0e0e0"} strokeWidth={1} />
          : <line key={`g${v}`} x1={plot.x} x2={plot.r} y1={at} y2={at} stroke={v === 0 ? "#333" : "#e0e0e0"} strokeWidth={1} />);
        out.push(horizontal
          ? <text key={`t${v}`} x={at} y={plot.b + 15} textAnchor="middle" fontSize={11} fill="#5f6368">{percent ? `${Math.round(v * 100)}%` : short(v)}</text>
          : <text key={`t${v}`} x={plot.x - 6} y={at + 4} textAnchor="end" fontSize={11} fill="#5f6368">{percent ? `${Math.round(v * 100)}%` : short(v)}</text>);
      }
      if (chart.type === "SCATTER") {
        const xs = data.xs.filter((x): x is number => x != null);
        const xScale = niceScale(Math.min(0, ...xs), Math.max(1e-9, ...xs));
        const xAt = (x: number) => plot.x + ((x - xScale.lo) / (xScale.hi - xScale.lo || 1)) * pw;
        for (let v = xScale.lo; v <= xScale.hi + xScale.step / 2; v += xScale.step) out.push(<text key={`x${v}`} x={xAt(v)} y={plot.b + 15} textAnchor="middle" fontSize={11} fill="#5f6368">{short(v)}</text>);
        data.series.forEach((ser, si) => ser.values.forEach((v, i) => { const x = data.xs[i]; if (v != null && x != null) out.push(<circle key={`p${si}-${i}`} cx={xAt(x)} cy={along(v)} r={3.5} fill={ser.color} />); }));
      } else {
        const band = (horizontal ? ph : pw) / Math.max(1, n);
        const bars = data.series.filter((s) => s.type === "COLUMN");
        const barW = stacked ? band * 0.6 : (band * 0.7) / Math.max(1, bars.length);
        const centre = (i: number) => (horizontal ? plot.y : plot.x) + band * (i + 0.5);
        const base = new Array<number>(n).fill(0);
        data.series.forEach((ser, si) => {
          if (ser.type === "COLUMN") {
            const k = bars.indexOf(ser);
            ser.values.forEach((_raw, i) => {
              const v = valueOf(ser, i);
              if (v == null) return;
              const from = stacked ? base[i] : 0;
              const to = from + v;
              if (stacked) base[i] = to;
              const a = along(Math.min(from, to)), b = along(Math.max(from, to));
              const off = stacked ? -barW / 2 : -(barW * bars.length) / 2 + k * barW;
              out.push(horizontal
                ? <rect key={`b${si}-${i}`} x={Math.min(a, b)} y={centre(i) + off} width={Math.abs(b - a)} height={Math.max(1, barW - 1)} fill={ser.color} />
                : <rect key={`b${si}-${i}`} x={centre(i) + off} y={Math.min(a, b)} width={Math.max(1, barW - 1)} height={Math.abs(b - a)} fill={ser.color} />);
            });
          } else {
            const points: string[] = [];
            ser.values.forEach((_raw, i) => {
              const v = valueOf(ser, i);
              if (v == null) return;
              const to = stacked && ser.type === "AREA" ? (base[i] += v) : v;
              points.push(`${centre(i)},${along(to)}`);
            });
            if (ser.type === "AREA" && points.length) out.push(<polygon key={`a${si}`} points={`${points[0].split(",")[0]},${along(0)} ${points.join(" ")} ${points[points.length - 1].split(",")[0]},${along(0)}`} fill={ser.color} opacity={0.3} />);
            out.push(<polyline key={`l${si}`} points={points.join(" ")} fill="none" stroke={ser.color} strokeWidth={2} />);
          }
        });
        // The labels along the category axis, as many as fit
        const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((horizontal ? ph : pw) / (horizontal ? 16 : 56)))));
        data.labels.forEach((label, i) => {
          if (i % every || !label) return;
          const shown = label.length > 12 ? label.slice(0, 11) + "…" : label;
          out.push(horizontal
            ? <text key={`c${i}`} x={plot.x - 6} y={centre(i) + 4} textAnchor="end" fontSize={11} fill="#5f6368">{shown}</text>
            : <text key={`c${i}`} x={centre(i)} y={plot.b + 15} textAnchor="middle" fontSize={11} fill="#5f6368">{shown}</text>);
        });
      }
      const xTitle = horizontal ? chart.yTitle : chart.xTitle, yTitle = horizontal ? chart.xTitle : chart.yTitle;
      if (xTitle) out.push(<text key="xt" x={plot.x + pw / 2} y={plot.b + 32} textAnchor="middle" fontSize={12} fontStyle="italic" fill="#222">{xTitle}</text>);
      if (yTitle) out.push(<text key="yt" transform={`translate(${(legend === "LEFT" ? legendW : 0) + 13},${plot.y + ph / 2}) rotate(-90)`} textAnchor="middle" fontSize={12} fontStyle="italic" fill="#222">{yTitle}</text>);
    }

    if (legend !== "NONE" && names.length) {
      const swatch = (i: number) => (chart.type === "PIE" ? PALETTE[i % PALETTE.length] : data.series[i]?.color ?? PALETTE[i % PALETTE.length]);
      if (legend === "RIGHT" || legend === "LEFT") {
        const x = legend === "RIGHT" ? w - legendW + 6 : 8;
        names.slice(0, Math.floor((h - titleH - 10) / 18)).forEach((name, i) => {
          out.push(<rect key={`ls${i}`} x={x} y={titleH + 6 + i * 18} width={10} height={10} fill={swatch(i)} />);
          out.push(<text key={`lt${i}`} x={x + 15} y={titleH + 15 + i * 18} fontSize={11} fill="#222">{name.length > 22 ? name.slice(0, 21) + "…" : name}</text>);
        });
      } else {
        let x = 16;
        const y = legend === "TOP" ? titleH + 2 : h - 18;
        names.forEach((name, i) => {
          if (x > w - 60) return;
          out.push(<rect key={`ls${i}`} x={x} y={y} width={10} height={10} fill={swatch(i)} />);
          out.push(<text key={`lt${i}`} x={x + 15} y={y + 9} fontSize={11} fill="#222">{name}</text>);
          x += 30 + name.length * 6.5;
        });
      }
    }
    return out;
  }, [chart, data, w, h]);

  return (
    <svg className="sx-chart" data-testid="sx-chart" data-chart={chart.type} role="img" aria-label={chart.title ? `Chart: ${chart.title}` : "Chart"} width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ left, top, fontFamily: FONT }}>
      <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="#fff" stroke="#dadce0" />
      {chart.title && <text x={14} y={22} fontSize={16} fill="#757575">{chart.title.length > Math.floor(w / 9) ? chart.title.slice(0, Math.floor(w / 9) - 1) + "…" : chart.title}</text>}
      {body}
    </svg>
  );
}
