"use client";

import React from "react";
import { Shuffle, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { MAX_CUSTOM_BREAKS, type DripPlan } from "@/lib/drip-engine";
import { formatClock, formatSpan } from "@/lib/format";
import { Menu, MenuItem } from "./menu";

export type BreaksMode = "auto" | "none" | "custom";

export const DURATION_OPTIONS: (number | null)[] = [null, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
export const START_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 180, 360, 720];
export const BREAK_CATALOG = [5, 10, 15, 30, 45, 60, 90, 120, 180];
export const TYPO_OPTIONS = [
  { label: "Rare", value: 0 },
  { label: "Low", value: 0.25 },
  { label: "Medium", value: 0.5 },
  { label: "High", value: 0.75 },
  { label: "Very high", value: 1 },
];

interface SyncPanelProps {
  durationMinutes: number | null;
  onDurationChange: (v: number | null) => void;
  breaksMode: BreaksMode;
  onBreaksModeChange: (v: BreaksMode) => void;
  customBreaks: number[];
  onCustomBreaksChange: (v: number[]) => void;
  typoFrequency: number;
  onTypoFrequencyChange: (v: number) => void;
  startInMinutes: number;
  onStartInChange: (v: number) => void;
  preview: DripPlan | null;
  onShuffle: () => void;
  disabled?: boolean;
  scopeError?: boolean;
  startError?: string | null;
}

export function SyncPanel(p: SyncPanelProps) {
  const typoIdx = TYPO_OPTIONS.reduce((best, o, i) => (Math.abs(o.value - p.typoFrequency) < Math.abs(TYPO_OPTIONS[best].value - p.typoFrequency) ? i : best), 0);
  const startAt = Date.now() + p.startInMinutes * 60_000;
  const plan = p.preview;
  const typos = plan ? plan.actions.filter((a) => a.kind === "typo").length : 0;
  const edits = plan ? plan.actions.filter((a) => a.kind !== "pause").length : 0;

  return (
    <div className="flex flex-col gap-4 px-5 pt-4">
      <h2 className="text-[16px] font-medium leading-6">Sync settings</h2>

      {p.scopeError && (
        <div className="rounded-lg bg-[#fce8e6] p-4 text-[14px] text-[#8c1d18]">
          Google didn&apos;t give SyncStream access to your documents.
          <a href="/api/auth/login" className="mt-2 block font-medium text-[#8c1d18] underline">Reconnect Google account</a>
        </div>
      )}

      <div>
        <label className="ss-field-label" htmlFor="ss-duration">Total time</label>
        <select id="ss-duration" className="ss-select" disabled={p.disabled} value={p.durationMinutes ?? ""} onChange={(e) => p.onDurationChange(e.target.value === "" ? null : Number(e.target.value))}>
          {DURATION_OPTIONS.map((m) => (
            <option key={m ?? "auto"} value={m ?? ""}>{m == null ? "Natural pace" : formatSpan(m)}</option>
          ))}
        </select>
        <p className="ss-field-help">
          {p.durationMinutes == null
            ? "About 35 words a minute, with short pauses."
            : p.breaksMode === "auto"
              ? "Speed varies a little and breaks fill the rest."
              : "Typing speeds up or slows down to fit."}
        </p>
      </div>

      <div>
        <span className="ss-field-label" id="ss-breaks-label">Breaks</span>
        <div className="ss-segmented" role="group" aria-labelledby="ss-breaks-label">
          {([["auto", "Automatic"], ["none", "None"], ["custom", "Choose"]] as const).map(([v, label]) => (
            <button key={v} aria-pressed={p.breaksMode === v} disabled={p.disabled} onClick={() => p.onBreaksModeChange(v)}>
              {p.breaksMode === v && <motion.span layoutId="ss-breaks-pill" className="ss-seg-pill" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
              <span className="ss-seg-label">{label}</span>
            </button>
          ))}
        </div>
        {p.breaksMode === "custom" ? (
          <motion.div className="mt-2 flex flex-wrap gap-1.5" layout>
            <AnimatePresence mode="popLayout" initial={false}>
              {p.customBreaks.map((m, i) => (
                <motion.button
                  key={`${i}-${m}`}
                  layout
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  transition={{ type: "spring", stiffness: 520, damping: 34 }}
                  className="ss-chip"
                  data-selected="true"
                  disabled={p.disabled}
                  onClick={() => p.onCustomBreaksChange(p.customBreaks.filter((_, k) => k !== i))}
                  aria-label={`Remove ${formatSpan(m)} break`}
                >
                  {formatSpan(m)}
                  <X className="h-3.5 w-3.5" />
                </motion.button>
              ))}
            </AnimatePresence>
            {p.customBreaks.length < MAX_CUSTOM_BREAKS && (
              <Menu label="Add a break" trigger={<button className="ss-chip" disabled={p.disabled}>Add a break</button>}>
                {BREAK_CATALOG.map((m) => (
                  <MenuItem key={m} onSelect={() => p.onCustomBreaksChange([...p.customBreaks, m])}>{formatSpan(m)}</MenuItem>
                ))}
              </Menu>
            )}
            <motion.p layout className="ss-field-help w-full">Breaks happen in this order, spread through the text.</motion.p>
          </motion.div>
        ) : (
          <p className="ss-field-help">
            {p.breaksMode === "auto" ? "A few longer pauses, based on how long the text is." : "Only short pauses between sentences."}
          </p>
        )}
      </div>

      <div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="ss-field-label" htmlFor="ss-typos">Typos</label>
            <select id="ss-typos" className="ss-select" disabled={p.disabled} value={typoIdx} onChange={(e) => p.onTypoFrequencyChange(TYPO_OPTIONS[Number(e.target.value)].value)}>
              {TYPO_OPTIONS.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="ss-field-label" htmlFor="ss-start">Start</label>
            <select id="ss-start" className="ss-select" disabled={p.disabled} value={p.startInMinutes} onChange={(e) => p.onStartInChange(Number(e.target.value))}>
              {START_OPTIONS.map((m) => <option key={m} value={m}>{m === 0 ? "Right away" : `In ${formatSpan(m)}`}</option>)}
            </select>
          </div>
        </div>
        <p className="ss-field-help">
          {p.startInMinutes === 0 ? "Runs on our server, so you can close this tab." : `Starts at ${formatClock(startAt)}, even if this tab is closed.`}
        </p>
      </div>

      {p.startError && (
        <p role="alert" className="rounded-lg bg-[#fce8e6] p-3 text-[13px] leading-5 text-[#8c1d18]">{p.startError}</p>
      )}

      {/* Pinned to the bottom of the panel so the plan stays visible on short screens */}
      <div className="sticky bottom-0 -mx-5 -mt-3 bg-[linear-gradient(to_bottom,transparent,var(--ss-surface)_12px)] px-5 pb-4 pt-3">
      <motion.section layout transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }} className="rounded-xl bg-[var(--ss-soft)] p-4" aria-live="polite">
        {plan ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="relative h-7 overflow-hidden">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={formatSpan(plan.totalMs / 60_000)}
                      className="text-[22px] leading-7"
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -12 }}
                      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                    >
                      {formatSpan(plan.totalMs / 60_000)}
                    </motion.div>
                  </AnimatePresence>
                </div>
                <div className="text-[14px] text-[var(--ss-text-2)]">Finishes around {formatClock(startAt + plan.totalMs)}</div>
              </div>
              <button className="ss-icon-btn h-9 w-9 rounded-full" onClick={p.onShuffle} disabled={p.disabled} title="Try a different schedule" aria-label="Try a different schedule">
                <Shuffle className="h-[18px] w-[18px]" />
              </button>
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2">
              {([["Edits", edits], ["Typos", typos], ["Breaks", plan.breaks.length]] as const).map(([label, value]) => (
                <div key={label} className="flex flex-col-reverse">
                  <dt className="text-[12px] leading-4 text-[var(--ss-text-2)]">{label}</dt>
                  <dd className="text-[16px] leading-6 tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            {plan.breaks.length > 0 && p.breaksMode !== "custom" && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {plan.breaks.map((m, i) => (
                  <span key={i} className="rounded-md bg-white px-2 py-0.5 text-[12px] text-[var(--ss-text-2)]">{formatSpan(m)}</span>
                ))}
              </div>
            )}
            <AnimatePresence initial={false}>
            {plan.targetMs != null && !plan.fitsTarget && (
              <motion.p
                key="warn"
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: "auto", marginTop: 16 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
                className="overflow-hidden rounded-lg bg-[#fef7e0] px-3 text-[13px] leading-5 text-[#5c4300]"
              >
                <span className="block py-3">
                {plan.totalMs < plan.targetMs
                  ? `This text can't be stretched to ${formatSpan(plan.targetMs / 60_000)} ${p.breaksMode === "none" ? "without breaks" : "with these breaks"}. Choose automatic breaks to fill the time, or pick a shorter total.`
                  : `These breaks alone take longer than ${formatSpan(plan.targetMs / 60_000)}. Remove a break or pick a longer total.`}
                </span>
              </motion.p>
            )}
            </AnimatePresence>
          </>
        ) : (
          <p className="text-[14px] text-[var(--ss-text-2)]">Type or paste your text on the page to see how long it will take.</p>
        )}
      </motion.section>
      </div>
    </div>
  );
}
