"use client";

import React from "react";
import { motion } from "framer-motion";
import { EFFORT_OPTIONS, type Effort } from "@/lib/style-engine";
import type { CorpusReport } from "@/lib/style-metrics";
import type { StreamUsage } from "./style-api";

interface StylePanelProps {
  effort: Effort;
  onEffortChange: (e: Effort) => void;
  instructions: string;
  onInstructionsChange: (v: string) => void;
  report: CorpusReport | null;
  status: { configured: boolean; model: string } | null;
  usage: StreamUsage | null;
  disabled?: boolean;
  error?: string | null;
}

/** Engine settings and the measurements of the current style, on the right like the sync settings */
export function StylePanel(p: StylePanelProps) {
  const option = EFFORT_OPTIONS.find((o) => o.value === p.effort) ?? EFFORT_OPTIONS[1];
  const arrow = (a: number | string, b: number | string) => `${a} → ${b}`;
  const rows: [string, string][] = p.report
    ? [
        ["Words per sentence", arrow(p.report.input.meanSentenceWords, p.report.output.meanSentenceWords)],
        ["Sentence length spread", arrow(p.report.input.sentenceCharsStd, p.report.output.sentenceCharsStd)],
        ["Words per clause", arrow(p.report.input.wordsPerClause, p.report.output.wordsPerClause)],
        ["Short : long sentences", arrow(p.report.input.pacingRatio, p.report.output.pacingRatio)],
        ["Transitions per sentence", arrow(p.report.input.transitions.perSentence, p.report.output.transitions.perSentence)],
        ["Commas per sentence", arrow(p.report.input.punctuation.commasPerSentence, p.report.output.punctuation.commasPerSentence)],
        ["Length ratio", `${p.report.lengthRatio}×`],
        ["Kept verbatim", `${Math.round(p.report.edits.retention * 100)}%`],
      ]
    : [];

  return (
    <div className="flex flex-col gap-4 px-5 pt-4">
      <h2 className="text-[16px] font-medium leading-6">Engine settings</h2>

      {p.status && !p.status.configured && (
        <div role="alert" className="rounded-lg bg-[#fce8e6] p-4 text-[14px] leading-5 text-[#8c1d18]">
          The Style engine isn&apos;t set up on this server. Add <code className="font-mono text-[13px]">ANTHROPIC_API_KEY</code> to the environment and redeploy.
        </div>
      )}

      <div>
        <label className="ss-field-label" htmlFor="ss-effort">Effort</label>
        <select id="ss-effort" className="ss-select" disabled={p.disabled} value={p.effort} onChange={(e) => p.onEffortChange(e.target.value as Effort)}>
          {EFFORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <p className="ss-field-help">{option.help}</p>
      </div>

      <div>
        <label className="ss-field-label" htmlFor="ss-instructions">Notes for the engine</label>
        <textarea
          id="ss-instructions"
          className="ss-textarea"
          rows={4}
          disabled={p.disabled}
          value={p.instructions}
          placeholder="Audience, register, anything that must never change"
          onChange={(e) => p.onInstructionsChange(e.target.value)}
        />
        <p className="ss-field-help">Sent with the pairs when analyzing and with every transformation.</p>
      </div>

      {p.error && (
        <p role="alert" className="rounded-lg bg-[#fce8e6] p-3 text-[13px] leading-5 text-[#8c1d18]">{p.error}</p>
      )}

      <div className="sticky bottom-0 -mx-5 -mt-3 bg-[linear-gradient(to_bottom,transparent,var(--ss-surface)_12px)] px-5 pb-4 pt-3">
        <motion.section layout transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }} className="rounded-xl bg-[var(--ss-soft)] p-4" aria-live="polite">
          {p.report ? (
            <>
              <div className="text-[22px] leading-7">{p.report.pairs} {p.report.pairs === 1 ? "pair" : "pairs"} measured</div>
              <div className="text-[14px] text-[var(--ss-text-2)]">Source → target, averaged</div>
              <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1.5 text-[13px]">
                {rows.map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="text-[var(--ss-text-2)]">{k}</dt>
                    <dd className="text-right tabular-nums">{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
              {p.report.output.transitions.phrases.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {p.report.output.transitions.phrases.slice(0, 8).map((t) => (
                    <span key={t.phrase} className="rounded-md bg-white px-2 py-0.5 text-[12px] text-[var(--ss-text-2)]">{t.phrase} ×{t.count}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-[14px] text-[var(--ss-text-2)]">Fill in a pair with both halves to measure the style.</p>
          )}
          {(p.usage || p.status?.configured) && (
            <p className="mt-3 text-[12px] leading-4 text-[var(--ss-text-3)]">
              {p.usage
                ? `Last request: ${p.usage.inputTokens.toLocaleString()} tokens in${p.usage.cachedTokens ? ` (${p.usage.cachedTokens.toLocaleString()} cached)` : ""}, ${p.usage.outputTokens.toLocaleString()} out · ${p.usage.model}`
                : `Runs on ${p.status?.model}.`}
            </p>
          )}
        </motion.section>
      </div>
    </div>
  );
}
