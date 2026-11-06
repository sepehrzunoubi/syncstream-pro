"use client";

import React, { useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { INDENT_PT } from "@/lib/rich-text";
import { DEFAULT_GEOMETRY, type PageGeometry } from "./pagination";

// CSS pixels (96 per inch); the ruler snaps to a sixteenth of an inch, like Docs
const GRID = 6;
const BLUE = "#0b57d0";
const px = (pt: number) => (pt * 96) / 72;
const toPt = (x: number) => Math.round(((x * 72) / 96) * 100) / 100;

/** A marker being dragged, and where to: its distance in CSS pixels from its own margin */
type Drag = { kind: "start" | "first" | "end"; d: number } | null;

/**
 * The Docs ruler: inch scale, grey margins, and draggable indent markers for the current paragraph. The
 * start and first-line markers measure from the margin the paragraph's text starts at, the end marker
 * from the other one: in a right-to-left paragraph the ruler is mirrored, its inches counted from the right.
 */
export function Ruler({ editor, disabled, geometry = DEFAULT_GEOMETRY }: { editor: Editor | null; disabled?: boolean; geometry?: PageGeometry }) {
  // Page width and margins from the page setup
  const W = geometry.w;
  const M = geometry.left;
  const MR = geometry.right;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const para = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return { start: 0, first: 0, end: 0, list: false, rtl: false };
      const a = e.getAttributes("paragraph");
      const box = a.box as { start?: number; first?: number; marker?: number } | null;
      const list = !!a.list;
      // Exact indents in points: the box when the paragraph has one, else its steps
      const level = (a.level as number | null) ?? 0;
      const start = box ? box.start ?? (list ? 36 : 0) : list ? INDENT_PT * (level + 1) : ((a.indent as number) ?? 0) * INDENT_PT;
      const first = list ? start + (box?.marker ?? -18) : start + (box ? box.first ?? 0 : a.firstLine ? INDENT_PT : 0);
      return { start, first, end: (a.indentEnd as number | null) ?? 0, list, rtl: a.dir === "rtl" };
    },
  });
  const rtl = !!para?.rtl;
  // The text column's width; a distance from the start margin (or the end one) as a place on the ruler, and back
  const C = W - M - MR;
  const startX = (d: number) => (rtl ? W - MR - d : M + d);
  const endX = (d: number) => (rtl ? M + d : W - MR - d);
  const fromMargin = (kind: NonNullable<Drag>["kind"], x: number) => (kind === "end" ? (rtl ? x - M : W - MR - x) : rtl ? W - MR - x : x - M);

  const s = px(para?.start ?? 0);
  const f = px(para?.first ?? 0);
  const e = px(para?.end ?? 0);
  const shownStart = drag?.kind === "start" ? drag.d : s;
  const shownFirst = drag?.kind === "first" ? drag.d : drag?.kind === "start" ? drag.d + (f - s) : f;
  const shownEnd = drag?.kind === "end" ? drag.d : e;

  const toRulerX = (clientX: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return ((clientX - r.left) / r.width) * W;
  };
  const snap = (d: number) => Math.round(d / GRID) * GRID;

  const begin = (kind: NonNullable<Drag>["kind"]) => (ev: React.PointerEvent) => {
    if (disabled || !editor) return;
    ev.preventDefault();
    (ev.target as Element).setPointerCapture(ev.pointerId);
    setDrag({ kind, d: kind === "start" ? s : kind === "first" ? f : e });
  };
  const move = (ev: React.PointerEvent) => {
    if (!drag) return;
    const d = snap(fromMargin(drag.kind, toRulerX(ev.clientX)));
    const clamp = (hi: number) => Math.max(0, Math.min(hi, d));
    // Each marker stays inside the margins, a grid step short of the marker facing it
    if (drag.kind === "end") setDrag({ ...drag, d: clamp(C - Math.max(shownStart, shownFirst) - GRID) });
    else if (drag.kind === "start") setDrag({ ...drag, d: clamp(C - e - GRID - Math.max(0, f - s)) });
    else setDrag({ ...drag, d: clamp(C - e - GRID) });
  };
  const end = () => {
    if (!drag || !editor) return setDrag(null);
    if (drag.kind === "end") editor.chain().focus().setIndents({ end: toPt(drag.d) }).run();
    else if (drag.kind === "start") editor.chain().focus().setIndents({ start: toPt(drag.d), first: toPt(drag.d + (f - s)) }).run();
    else editor.chain().focus().setIndents({ first: toPt(drag.d) }).run();
    setDrag(null);
  };

  // Inches counted from the start margin, both ways
  const origin = rtl ? W - MR : M;
  const ticks: React.ReactNode[] = [];
  for (let k = -Math.ceil(W / 12); k <= Math.ceil(W / 12); k++) {
    const x = origin + (rtl ? -k : k) * 12;
    if (x < 0 || x > W) continue;
    const fromStart = k * 12;
    if (fromStart % 96 === 0) {
      const n = fromStart / 96;
      if (n !== 0 && x > 0 && x < W) {
        ticks.push(
          <text key={`n${k}`} x={x} y={16} textAnchor="middle" fontSize={10} fill="#5f6368" fontFamily="Google Sans, Roboto, Arial, sans-serif">
            {Math.abs(n)}
          </text>
        );
      }
    } else {
      const h = fromStart % 48 === 0 ? 6 : 3;
      ticks.push(<line key={`t${k}`} x1={x + 0.5} x2={x + 0.5} y1={12 - h / 2} y2={12 + h / 2} stroke="#80868b" strokeWidth={1} />);
    }
  }

  const xStart = startX(shownStart);
  const xFirst = startX(shownFirst);
  const xEnd = endX(shownEnd);
  return (
    <div className="ss-ruler" aria-hidden="true" style={{ width: W }}>
      <svg ref={svgRef} width={W} height={24} viewBox={`0 0 ${W} 24`} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(null)}>
        <rect x={0} y={4} width={W} height={16} fill="#e1e3e1" rx={2} />
        <rect x={M} y={4} width={Math.max(0, W - M - MR)} height={16} fill="#fff" />
        {ticks}
        {!disabled && (
          <g style={{ transition: drag ? undefined : "transform 180ms cubic-bezier(.2,0,0,1)" }}>
            {/* first-line indent: bar */}
            <rect className="ss-marker" data-marker="first" x={xFirst - 6} y={0} width={12} height={4} rx={1} fill={BLUE} onPointerDown={begin("first")} />
            {/* start indent (the left, left to right): triangle */}
            <path className="ss-marker" data-marker="start" d={`M ${xStart - 6} 5 L ${xStart + 6} 5 L ${xStart} 11 Z`} fill={BLUE} onPointerDown={begin("start")} />
            {/* end indent */}
            <path className="ss-marker" data-marker="end" d={`M ${xEnd - 6} 5 L ${xEnd + 6} 5 L ${xEnd} 11 Z`} fill={BLUE} onPointerDown={begin("end")} />
          </g>
        )}
      </svg>
    </div>
  );
}
