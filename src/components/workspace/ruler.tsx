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

type Drag = { kind: "left" | "first" | "right"; x: number } | null;

/** The Docs ruler: inch scale, grey margins, and draggable indent markers for the current paragraph. */
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
      if (!e) return { start: 0, first: 0, end: 0, list: false };
      const a = e.getAttributes("paragraph");
      const box = a.box as { start?: number; first?: number; marker?: number } | null;
      const list = !!a.list;
      // Exact indents in points: the box when the paragraph has one, else its steps
      const level = (a.level as number | null) ?? 0;
      const start = box ? box.start ?? (list ? 36 : 0) : list ? INDENT_PT * (level + 1) : ((a.indent as number) ?? 0) * INDENT_PT;
      const first = list ? start + (box?.marker ?? -18) : start + (box ? box.first ?? 0 : a.firstLine ? INDENT_PT : 0);
      return { start, first, end: (a.indentEnd as number | null) ?? 0, list };
    },
  });

  const leftX = M + px(para?.start ?? 0);
  const firstX = M + px(para?.first ?? 0);
  const rightX = W - MR - px(para?.end ?? 0);
  const shownLeft = drag?.kind === "left" ? drag.x : leftX;
  const shownFirst = drag?.kind === "first" ? drag.x : drag?.kind === "left" ? drag.x + (firstX - leftX) : firstX;
  const shownRight = drag?.kind === "right" ? drag.x : rightX;

  const toRulerX = (clientX: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return ((clientX - r.left) / r.width) * W;
  };
  const snap = (x: number) => M + Math.round((x - M) / GRID) * GRID;

  const start = (kind: NonNullable<Drag>["kind"]) => (e: React.PointerEvent) => {
    if (disabled || !editor) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ kind, x: kind === "left" ? leftX : kind === "first" ? firstX : rightX });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const x = snap(toRulerX(e.clientX));
    const lo = M;
    const hi = W - MR;
    if (drag.kind === "right") setDrag({ ...drag, x: Math.max(Math.max(shownLeft, shownFirst) + GRID, Math.min(hi, x)) });
    else if (drag.kind === "left") setDrag({ ...drag, x: Math.max(lo, Math.min(rightX - GRID - Math.max(0, firstX - leftX), x)) });
    else setDrag({ ...drag, x: Math.max(lo, Math.min(rightX - GRID, x)) });
  };
  const end = () => {
    if (!drag || !editor) return setDrag(null);
    if (drag.kind === "right") editor.chain().focus().setIndents({ end: toPt(W - MR - drag.x) }).run();
    else if (drag.kind === "left") editor.chain().focus().setIndents({ start: toPt(drag.x - M), first: toPt(drag.x - M + (firstX - leftX)) }).run();
    else editor.chain().focus().setIndents({ first: toPt(drag.x - M) }).run();
    setDrag(null);
  };

  const ticks: React.ReactNode[] = [];
  for (let i = 0; i <= W / 12; i++) {
    const x = i * 12;
    const fromMargin = x - M;
    if (fromMargin % 96 === 0) {
      const n = fromMargin / 96;
      if (n !== 0 && x > 0 && x < W) {
        ticks.push(
          <text key={`n${i}`} x={x} y={16} textAnchor="middle" fontSize={10} fill="#5f6368" fontFamily="Google Sans, Roboto, Arial, sans-serif">
            {Math.abs(n)}
          </text>
        );
      }
    } else {
      const h = fromMargin % 48 === 0 ? 6 : 3;
      ticks.push(<line key={`t${i}`} x1={x + 0.5} x2={x + 0.5} y1={12 - h / 2} y2={12 + h / 2} stroke="#80868b" strokeWidth={1} />);
    }
  }

  return (
    <div className="ss-ruler" aria-hidden="true" style={{ width: W }}>
      <svg ref={svgRef} width={W} height={24} viewBox={`0 0 ${W} 24`} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(null)}>
        <rect x={0} y={4} width={W} height={16} fill="#e1e3e1" rx={2} />
        <rect x={M} y={4} width={Math.max(0, W - M - MR)} height={16} fill="#fff" />
        {ticks}
        {!disabled && (
          <g style={{ transition: drag ? undefined : "transform 180ms cubic-bezier(.2,0,0,1)" }}>
            {/* first-line indent: bar */}
            <rect className="ss-marker" x={shownFirst - 6} y={0} width={12} height={4} rx={1} fill={BLUE} onPointerDown={start("first")} />
            {/* left indent: triangle */}
            <path className="ss-marker" d={`M ${shownLeft - 6} 5 L ${shownLeft + 6} 5 L ${shownLeft} 11 Z`} fill={BLUE} onPointerDown={start("left")} />
            {/* right indent */}
            <path className="ss-marker" d={`M ${shownRight - 6} 5 L ${shownRight + 6} 5 L ${shownRight} 11 Z`} fill={BLUE} onPointerDown={start("right")} />
          </g>
        )}
      </svg>
    </div>
  );
}
