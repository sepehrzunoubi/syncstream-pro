"use client";

import React from "react";
import { Shuffle, X } from "lucide-react";
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
    <div className="flex flex-col gap-6 p-6">
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
            ? "Types at about 35 words a minute, with pauses between sentences."
            : p.breaksMode === "auto"
              ? "Typing speeds up or slows down a little, and breaks fill the rest of the time."
              : "Typing speeds up or slows down to fit, within realistic limits."}
        </p>
      </div>

      <div>
        <span className="ss-field-label" id="ss-breaks-label">Breaks</span>
        <div className="ss-segmented" role="group" aria-labelledby="ss-breaks-label">
          {([["auto", "Automatic"], ["none", "None"], ["custom", "Choose"]] as const).map(([v, label]) => (
            <button key={v} aria-pressed={p.breaksMode === v} disabled={p.disabled} onClick={() => p.onBreaksModeChange(v)}>{label}</button>
          ))}
        </div>
        {p.breaksMode === "custom" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {p.customBreaks.map((m, i) => (
              <button key={`${m}-${i}`} className="ss-chip" data-selected="true" disabled={p.disabled} onClick={() => p.onCustomBreaksChange(p.customBreaks.filter((_, k) => k !== i))} aria-label={`Remove ${formatSpan(m)} break`}>
                {formatSpan(m)}
                <X className="h-4 w-4" />
              </button>
            ))}
            {p.customBreaks.length < MAX_CUSTOM_BREAKS && (
              <Menu label="Add a break" trigger={<button className="ss-chip" disabled={p.disabled}>Add a break</button>}>
                {BREAK_CATALOG.map((m) => (
                  <MenuItem key={m} onSelect={() => p.onCustomBreaksChange([...p.customBreaks, m])}>{formatSpan(m)}</MenuItem>
                ))}
              </Menu>
            )}
            <p className="ss-field-help w-full">Breaks happen in this order, spread through the text.</p>
          </div>
        ) : (
          <p className="ss-field-help">
            {p.breaksMode === "auto" ? "A few longer pauses, based on how long the text is." : "No long pauses. Only the short ones between sentences and paragraphs."}
          </p>
        )}
      </div>

      <div>
        <label className="ss-field-label" htmlFor="ss-typos">Typos</label>
        <select id="ss-typos" className="ss-select" disabled={p.disabled} value={typoIdx} onChange={(e) => p.onTypoFrequencyChange(TYPO_OPTIONS[Number(e.target.value)].value)}>
          {TYPO_OPTIONS.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
        </select>
        <p className="ss-field-help">Each typo is typed, noticed, deleted and corrected.</p>
      </div>

      <div>
        <label className="ss-field-label" htmlFor="ss-start">Start</label>
        <select id="ss-start" className="ss-select" disabled={p.disabled} value={p.startInMinutes} onChange={(e) => p.onStartInChange(Number(e.target.value))}>
          {START_OPTIONS.map((m) => <option key={m} value={m}>{m === 0 ? "Right away" : `In ${formatSpan(m)}`}</option>)}
        </select>
        <p className="ss-field-help">
          {p.startInMinutes === 0 ? "Runs on our server, so you can close this tab." : `Starts at ${formatClock(startAt)}, even if this tab is closed.`}
        </p>
      </div>

      <section className="rounded-xl bg-[var(--ss-soft)] p-4" aria-live="polite">
        {plan ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[22px] leading-7">{formatSpan(plan.totalMs / 60_000)}</div>
                <div className="text-[14px] text-[var(--ss-text-2)]">Finishes around {formatClock(startAt + plan.totalMs)}</div>
              </div>
              <button className="ss-icon-btn h-9 w-9 rounded-full" onClick={p.onShuffle} disabled={p.disabled} title="Try a different schedule" aria-label="Try a different schedule">
                <Shuffle className="h-[18px] w-[18px]" />
              </button>
            </div>
            <dl className="mt-4 grid grid-cols-[1fr_auto] gap-y-1.5 text-[14px]">
              <dt className="text-[var(--ss-text-2)]">Edits</dt><dd className="tabular-nums">{edits}</dd>
              <dt className="text-[var(--ss-text-2)]">Typos</dt><dd className="tabular-nums">{typos}</dd>
              <dt className="text-[var(--ss-text-2)]">Breaks</dt><dd className="tabular-nums">{plan.breaks.length}</dd>
            </dl>
            {plan.breaks.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {plan.breaks.map((m, i) => (
                  <span key={i} className="rounded-md bg-white px-2 py-0.5 text-[12px] text-[var(--ss-text-2)]">{formatSpan(m)}</span>
                ))}
              </div>
            )}
            {plan.targetMs != null && !plan.fitsTarget && (
              <p className="mt-4 rounded-lg bg-[#fef7e0] p-3 text-[13px] leading-5 text-[#5c4300]">
                {plan.totalMs < plan.targetMs
                  ? `This text can't be stretched to ${formatSpan(plan.targetMs / 60_000)} ${p.breaksMode === "none" ? "without breaks" : "with these breaks"}. Choose automatic breaks to fill the time, or pick a shorter total.`
                  : `These breaks alone take longer than ${formatSpan(plan.targetMs / 60_000)}. Remove a break or pick a longer total.`}
              </p>
            )}
          </>
        ) : (
          <p className="text-[14px] text-[var(--ss-text-2)]">Type or paste your text on the page to see how long it will take.</p>
        )}
      </section>

      {p.startError && (
        <p role="alert" className="rounded-lg bg-[#fce8e6] p-3 text-[13px] leading-5 text-[#8c1d18]">{p.startError}</p>
      )}
    </div>
  );
}
