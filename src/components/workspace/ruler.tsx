"use client";

import React, { useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { MAX_INDENT } from "@/lib/rich-text";

// Page geometry in CSS pixels (96 per inch): 8.5in page, 1in margins, 0.5in indent steps
const W = 816;
const M = 96;
const STEP = 48;
const BLUE = "#0b57d0";

type Drag = { kind: "left" | "first"; x: number } | null;

/** The Docs ruler: inch scale, grey margins, and draggable indent markers for the current paragraph. */
export function Ruler({ editor, disabled }: { editor: Editor | null; disabled?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const para = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return { indent: 0, firstLine: false };
      const a = e.getAttributes("paragraph");
      return { indent: (a.indent as number) ?? 0, firstLine: !!a.firstLine };
    },
  });

  const leftX = M + (para?.indent ?? 0) * STEP;
  const firstX = leftX + (para?.firstLine ? STEP : 0);
  const shownLeft = drag?.kind === "left" ? drag.x : leftX;
  const shownFirst = drag?.kind === "first" ? drag.x : drag?.kind === "left" ? drag.x + (firstX - leftX) : firstX;

  const toRulerX = (clientX: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return ((clientX - r.left) / r.width) * W;
  };
  const snapLeft = (x: number) => M + Math.max(0, Math.min(MAX_INDENT, Math.round((x - M) / STEP))) * STEP;

  const start = (kind: "left" | "first") => (e: React.PointerEvent) => {
    if (disabled || !editor) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ kind, x: kind === "left" ? leftX : firstX });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const x = toRulerX(e.clientX);
    setDrag({ ...drag, x: drag.kind === "left" ? snapLeft(x) : Math.max(leftX, Math.min(W - M, x)) });
  };
  const end = () => {
    if (!drag || !editor) return setDrag(null);
    if (drag.kind === "left") {
      const level = Math.round((drag.x - M) / STEP);
      editor.chain().focus().updateAttributes("paragraph", { indent: level }).run();
    } else {
      editor.chain().focus().setFirstLine(drag.x - leftX >= STEP / 2).run();
    }
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
    <div className="ss-ruler" aria-hidden="true">
      <svg ref={svgRef} width={W} height={24} viewBox={`0 0 ${W} 24`} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(null)}>
        <rect x={0} y={4} width={W} height={16} fill="#e1e3e1" rx={2} />
        <rect x={M} y={4} width={W - 2 * M} height={16} fill="#fff" />
        {ticks}
        {!disabled && (
          <g style={{ transition: drag ? undefined : "transform 180ms cubic-bezier(.2,0,0,1)" }}>
            {/* first-line indent: bar */}
            <rect className="ss-marker" x={shownFirst - 6} y={0} width={12} height={4} rx={1} fill={BLUE} onPointerDown={start("first")} />
            {/* left indent: triangle */}
            <path className="ss-marker" d={`M ${shownLeft - 6} 5 L ${shownLeft + 6} 5 L ${shownLeft} 11 Z`} fill={BLUE} onPointerDown={start("left")} />
            {/* right indent (fixed) */}
            <path d={`M ${W - M - 6} 5 L ${W - M + 6} 5 L ${W - M} 11 Z`} fill={BLUE} />
          </g>
        )}
      </svg>
    </div>
  );
}
