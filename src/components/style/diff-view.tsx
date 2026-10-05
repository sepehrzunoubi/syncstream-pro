"use client";

import React, { useMemo } from "react";
import { diffWords } from "@/lib/style-metrics";

/** The adapted text with what was removed struck through and what was added underlined */
export function DiffView({ before, after, className }: { before: string; after: string; className?: string }) {
  const ops = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <div className={`ss-diff ${className ?? ""}`} aria-label="Changes between the two texts">
      {ops.map((op, i) =>
        op.type === "equal" ? <span key={i}>{op.text}</span>
          : op.type === "delete" ? <del key={i} className="ss-diff-del">{op.text}</del>
            : <ins key={i} className="ss-diff-ins">{op.text}</ins>,
      )}
    </div>
  );
}
