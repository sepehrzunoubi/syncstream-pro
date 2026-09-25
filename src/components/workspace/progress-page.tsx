"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { cssLineHeight, fontStack, INDENT_PT, plainFormat, DEFAULT_PARAGRAPH, type RichFormat, type RunFormat, type ParagraphFormat } from "@/lib/rich-text";

interface Segment { start: number; end: number; run: RunFormat }
interface Para { start: number; end: number; format: ParagraphFormat; segments: Segment[] }

function layout(text: string, format: RichFormat | null): Para[] {
  const fmt = format ?? plainFormat(text);
  const paras: Para[] = [];
  let pos = 0;
  text.split("\n").forEach((line, i) => {
    paras.push({ start: pos, end: pos + line.length, format: fmt.paragraphs[i] ?? DEFAULT_PARAGRAPH, segments: [] });
    pos += line.length + 1;
  });
  let runStart = 0;
  let pi = 0;
  for (const run of fmt.runs) {
    const runEnd = runStart + run.len;
    while (pi < paras.length && paras[pi].end < runStart) pi++;
    for (let k = pi; k < paras.length && paras[k].start < runEnd; k++) {
      const s = Math.max(runStart, paras[k].start);
      const e = Math.min(runEnd, paras[k].end);
      if (e > s) paras[k].segments.push({ start: s, end: e, run });
    }
    runStart = runEnd;
  }
  return paras;
}

function spanStyle(run: RunFormat): React.CSSProperties {
  const deco = [run.u ? "underline" : "", run.s ? "line-through" : ""].filter(Boolean).join(" ");
  return {
    fontFamily: run.font ? fontStack(run.font) : undefined,
    fontSize: run.size ? `${run.size}pt` : undefined,
    fontWeight: run.b ? 700 : undefined,
    fontStyle: run.i ? "italic" : undefined,
    textDecoration: deco || undefined,
  };
}

function paraStyle(p: ParagraphFormat): React.CSSProperties {
  return {
    marginLeft: p.indent ? `${(p.indent * INDENT_PT) / 72}in` : undefined,
    textIndent: p.firstLine ? `${INDENT_PT / 72}in` : undefined,
    textAlign: p.align === "left" ? undefined : p.align,
    lineHeight: cssLineHeight(p.spacing),
  };
}

/** The source rendered like the Google Doc it becomes, with the typed part in black. */
export function ProgressPage({ text, format, typed, scale }: { text: string; format: RichFormat | null; typed: number; scale: number }) {
  const paras = useMemo(() => layout(text, format), [text, format]);
  const caretRef = useRef<HTMLSpanElement>(null);
  const done = typed >= text.length;

  useEffect(() => {
    const el = caretRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 120 || r.bottom > window.innerHeight - 60) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  }, [typed]);

  let caretPlaced = done;
  return (
    <div className="ss-page" style={{ zoom: scale }}>
      <div className="ss-doc" aria-readonly="true" aria-label="Text being typed into Google Docs">
        {paras.map((p, i) => {
          const children: React.ReactNode[] = [];
          const wantsCaret = !caretPlaced && typed >= p.start && typed <= p.end;
          for (const seg of p.segments) {
            const style = spanStyle(seg.run);
            if (typed >= seg.end) children.push(<span key={seg.start} style={style}>{text.slice(seg.start, seg.end)}</span>);
            else if (typed <= seg.start) {
              if (wantsCaret && !caretPlaced && typed === seg.start) { children.push(<span key={`c${seg.start}`} ref={caretRef} className="ss-caret" />); caretPlaced = true; }
              children.push(<span key={seg.start} style={style} className="ss-untyped">{text.slice(seg.start, seg.end)}</span>);
            } else {
              children.push(<span key={seg.start} style={style}>{text.slice(seg.start, typed)}</span>);
              children.push(<span key={`c${seg.start}`} ref={caretRef} className="ss-caret" />);
              caretPlaced = true;
              children.push(<span key={`u${seg.start}`} style={style} className="ss-untyped">{text.slice(typed, seg.end)}</span>);
            }
          }
          if (wantsCaret && !caretPlaced) { children.push(<span key="c-end" ref={caretRef} className="ss-caret" />); caretPlaced = true; }
          if (p.segments.length === 0) children.push(<br key="br" />);
          return (
            <p key={i} data-style={p.format.style === "normal" ? undefined : p.format.style} style={paraStyle(p.format)}>
              {children}
            </p>
          );
        })}
      </div>
    </div>
  );
}
