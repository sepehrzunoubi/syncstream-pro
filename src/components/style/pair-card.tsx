"use client";

import React, { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import type { StylePair } from "@/lib/style-engine";
import { pairReport } from "@/lib/style-metrics";
import { DiffView } from "./diff-view";

interface PairCardProps {
  pair: StylePair;
  index: number;
  disabled?: boolean;
  canRemove: boolean;
  onChange: (pair: StylePair) => void;
  onRemove: () => void;
}

/** One training pair: the source text, its adapted version, and what changed between them */
export function PairCard({ pair, index, disabled, canRemove, onChange, onRemove }: PairCardProps) {
  const [showChanges, setShowChanges] = useState(false);
  const ready = pair.input.trim().length > 0 && pair.output.trim().length > 0;
  const report = useMemo(() => (ready ? pairReport(pair.input.trim(), pair.output.trim()) : null), [ready, pair.input, pair.output]);
  const arrow = (a: number | string, b: number | string) => `${a} → ${b}`;

  return (
    <section className="ss-card" aria-label={`Pair ${index + 1}`}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        <h3 className="text-[14px] font-medium">Pair {index + 1}</h3>
        <div className="flex items-center gap-1">
          {report && (
            <button className="ss-chip" data-selected={showChanges ? "true" : undefined} onClick={() => setShowChanges((v) => !v)} aria-pressed={showChanges}>
              {showChanges ? "Hide changes" : "Show changes"}
            </button>
          )}
          <button className="ss-icon-btn h-8 w-8 rounded-full" onClick={onRemove} disabled={disabled || !canRemove} title="Remove this pair" aria-label="Remove this pair">
            <Trash2 className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>

      <div className="grid gap-3 px-4 pb-3 pt-2 md:grid-cols-2">
        <label className="block">
          <span className="ss-field-label">Source text</span>
          <textarea
            className="ss-textarea"
            rows={7}
            value={pair.input}
            disabled={disabled}
            placeholder="The text as it was written"
            spellCheck={false}
            onChange={(e) => onChange({ ...pair, input: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="ss-field-label">Adapted version</span>
          <textarea
            className="ss-textarea"
            rows={7}
            value={pair.output}
            disabled={disabled}
            placeholder="The same text in the target style"
            spellCheck={false}
            onChange={(e) => onChange({ ...pair, output: e.target.value })}
          />
        </label>
      </div>

      {report ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 text-[12px] leading-4 text-[var(--ss-text-2)]">
          <span>Words {arrow(report.input.words, report.output.words)}</span>
          <span>Sentences {arrow(report.input.sentences, report.output.sentences)}</span>
          <span>Words/sentence {arrow(report.input.meanSentenceWords, report.output.meanSentenceWords)}</span>
          <span>Words/clause {arrow(report.input.wordsPerClause, report.output.wordsPerClause)}</span>
          <span>Transitions {arrow(report.input.transitions.count, report.output.transitions.count)}</span>
          <span>{Math.round(report.edits.retention * 100)}% kept verbatim, {report.edits.substitutions} substitutions</span>
          {report.edits.droppedNames.length > 0 && (
            <span className="text-[#8c5a00]">Not repeated: {report.edits.droppedNames.slice(0, 6).join(", ")}{report.edits.droppedNames.length > 6 ? "…" : ""}</span>
          )}
        </div>
      ) : (
        <p className="px-4 pb-3 text-[12px] leading-4 text-[var(--ss-text-3)]">Fill in both halves to measure this pair.</p>
      )}

      {showChanges && report && (
        <div className="border-t border-[var(--ss-divider)] px-4 py-3">
          <DiffView before={pair.input.trim()} after={pair.output.trim()} />
        </div>
      )}
    </section>
  );
}
