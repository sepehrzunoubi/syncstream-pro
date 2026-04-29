"use client";

import React, { useMemo, useState } from "react";
import { RotateCw, Clock, Zap, Shuffle, Info, FilePlus, Timer, Sliders, Plus, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { SliderWithTooltip } from "@/components/ui/slider";

// Discrete duration presets in minutes: 5m, 15m, 30m, 45m, 1h, 2h, 5h, 12h, 24h
const DURATION_PRESETS = [5, 15, 30, 45, 60, 120, 300, 720, 1440];

// Schedule delay presets in minutes
const SCHEDULE_PRESETS = [5, 10, 15, 30, 60, 120, 180, 360];

// Custom-mode pause catalog (minutes). Must match server validation list.
const CUSTOM_PAUSE_CATALOG = [4, 10, 15, 30, 45, 60, 90, 120, 180];
const MAX_CUSTOM_PAUSES = 4;

interface SyncControlsProps {
  docs: { id: string; name: string; modifiedTime: string }[];
  selectedDocId: string;
  onSelectDoc: (id: string) => void;
  rhythm: string;
  onRhythmChange: (r: string) => void;
  durationMinutes: number;
  onDurationChange: (d: number) => void;
  typoFrequency: number;
  onTypoFrequencyChange: (f: number) => void;
  pauseVariance?: number;
  onPauseVarianceChange?: (v: number) => void;
  sourceText: string;
  disabled?: boolean;
  onRefreshDocs?: () => void;
  onCreateDoc?: () => void;
  isCreatingDoc?: boolean;
  isRefreshing?: boolean;
  isScheduled?: boolean;
  scheduleCountdown?: number;
  onScheduleSync?: (delayMinutes: number) => void;
  onCancelSchedule?: () => void;
  customPauses?: number[];
  onCustomPausesChange?: (p: number[]) => void;
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Preview mandatory pause schedule for burst mode (mirrors drip-engine logic).
 */
function getBurstPausePreview(wordCount: number): number[] {
  if (wordCount <= 0) return [];
  if (wordCount <= 100) return [3, 5, 7];          // 3 pauses, engine range 1-8
  if (wordCount <= 300) return [4, 6, 8, 10];       // 4 pauses, engine range 2-12
  if (wordCount <= 700) return [4, 6, 9, 11, 14];   // 5 pauses, engine range 2-15
  if (wordCount <= 1500) return [5, 8, 11, 15, 18]; // 5 pauses, engine range 3-20
  return [8, 12, 16, 20, 24];                        // 5 pauses, engine range 5-25
}

/**
 * Compute min/max sum of N distinct values from [lo..hi] (mirrors engine's pickUnique).
 */
function pauseSumRange(lo: number, hi: number, count: number): { min: number; max: number } {
  let minSum = 0, maxSum = 0;
  for (let i = 0; i < count; i++) {
    minSum += lo + i;        // smallest N distinct: lo, lo+1, ...
    maxSum += hi - i;        // largest N distinct: hi, hi-1, ...
  }
  return { min: minSum, max: maxSum };
}

function estimateBurstDuration(
  wordCount: number
): { minMinutes: number; maxMinutes: number } {
  if (wordCount <= 0) return { minMinutes: 0, maxMinutes: 0 };

  // Pause ranges matching the engine's getMandatoryPauses (pickUnique)
  let pauseRange: { min: number; max: number };
  if (wordCount <= 100)       pauseRange = pauseSumRange(1, 8, 3);
  else if (wordCount <= 300)  pauseRange = pauseSumRange(2, 12, 4);
  else if (wordCount <= 700)  pauseRange = pauseSumRange(2, 15, 5);
  else if (wordCount <= 1500) pauseRange = pauseSumRange(3, 20, 5);
  else                        pauseRange = pauseSumRange(5, 25, 5);

  // Engine picks ONE random chunk size per plan via randInt(8,25).
  // Use midpoint (16 chars) for chunk count, then vary the per-chunk delays.
  const charCount = wordCount * 5;
  const chunkSize = 16;
  const numChunks = Math.max(1, Math.ceil(charCount / chunkSize));
  const delays = Math.max(0, numChunks - 1); // first chunk has no delay

  // Thinking pauses REPLACE normal delays (not additive). Engine: every 4-8 chunks → 15-50s
  const minThinkCount = Math.floor(delays / 9); // ~1 per 8 chunks (conservative)
  const maxThinkCount = Math.floor(delays / 5); // ~1 per 4 chunks (aggressive)

  // Min: few thinking pauses (15s each), rest are fast normal delays (2s)
  const minTypingMs = (delays - minThinkCount) * 2_000 + minThinkCount * 15_000;
  // Max: many thinking pauses (50s each), rest are slow normal delays (8s)
  const maxTypingMs = (delays - maxThinkCount) * 8_000 + maxThinkCount * 50_000;

  return {
    minMinutes: Math.max(1, Math.ceil((minTypingMs / 60_000) + pauseRange.min)),
    maxMinutes: Math.max(1, Math.ceil((maxTypingMs / 60_000) + pauseRange.max)),
  };
}

const TYPO_PRESETS = [
  { label: "Rare", value: 0, desc: "~1 per 300 chars" },
  { label: "Low", value: 0.25, desc: "~1 per 235 chars" },
  { label: "Medium", value: 0.5, desc: "~1 per 170 chars" },
  { label: "High", value: 0.75, desc: "~1 per 105 chars" },
  { label: "Frequent", value: 1.0, desc: "~1 per 40 chars" },
];


function Tooltip({ text }: { text: string }) {
  return (
    <span className="relative group inline-flex ml-1.5 cursor-help">
      <Info className="w-3 h-3 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
      <span className="absolute bottom-full right-0 mb-1.5 px-3 py-2 rounded-md bg-zinc-900 border border-white/[0.08] text-[10px] text-zinc-400 leading-relaxed max-w-[140px] text-left opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50 shadow-lg">
        {text}
      </span>
    </span>
  );
}

function closestPresetIndex<T extends { value: number }>(presets: T[], val: number): number {
  return presets.reduce((closest, p, idx) =>
    Math.abs(p.value - val) < Math.abs(presets[closest].value - val) ? idx : closest, 0);
}

export function SyncControls({
  docs,
  selectedDocId,
  onSelectDoc,
  rhythm,
  onRhythmChange,
  durationMinutes,
  onDurationChange,
  typoFrequency,
  onTypoFrequencyChange,
  sourceText,
  disabled,
  onRefreshDocs,
  onCreateDoc,
  isCreatingDoc,
  isRefreshing,
  isScheduled,
  scheduleCountdown,
  onScheduleSync,
  onCancelSchedule,
  customPauses = [],
  onCustomPausesChange,
}: SyncControlsProps) {
  const [scheduleDelay, setScheduleDelay] = useState(1); // index into SCHEDULE_PRESETS

  const sourceWordCount = useMemo(() => {
    const trimmed = sourceText.trim();
    return trimmed ? trimmed.split(/\s+/).filter((w) => w.length > 0).length : 0;
  }, [sourceText]);

  const burstEstimate = useMemo(
    () => estimateBurstDuration(sourceWordCount),
    [sourceWordCount]
  );

  const burstPauses = useMemo(
    () => getBurstPausePreview(sourceWordCount),
    [sourceWordCount]
  );

  // Custom mode: count sentences from source text (mirrors engine splitter)
  const sentenceCount = useMemo(() => {
    const trimmed = sourceText.trim();
    if (!trimmed) return 0;
    const matches = trimmed.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+\n+|[^.!?\n]+$/g);
    return matches?.filter((s) => s.trim().length > 0).length || 1;
  }, [sourceText]);

  const customBaseMinutes = sentenceCount; // 1 sentence per minute
  const customPauseTotal = customPauses.reduce((s, p) => s + p, 0);
  const customFinalMinutes = customBaseMinutes + customPauseTotal;

  const addCustomPause = (mins: number) => {
    if (!onCustomPausesChange) return;
    if (customPauses.length >= MAX_CUSTOM_PAUSES) return;
    onCustomPausesChange([...customPauses, mins]);
  };
  const removeCustomPause = (idx: number) => {
    if (!onCustomPausesChange) return;
    onCustomPausesChange(customPauses.filter((_, i) => i !== idx));
  };

  const isBurst = rhythm === "burst";
  const isCustom = rhythm === "custom";

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Target Document */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <Label>Target Document</Label>
          <button
            onClick={onRefreshDocs}
            disabled={disabled || isRefreshing}
            className="p-1 rounded hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:pointer-events-none"
            title="Refresh document list"
          >
            <RotateCw className={`h-3.5 w-3.5 text-zinc-500 hover:text-blue-400 transition-colors ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <select
          value={selectedDocId}
          onChange={(e) => onSelectDoc(e.target.value)}
          disabled={disabled}
          className="w-full bg-[#09090b] border border-white/[0.06] rounded-lg px-3 py-2.5 pr-8 text-[13px] text-zinc-300 font-mono focus:border-blue-500/50 focus:outline-none disabled:opacity-40 transition-colors appearance-none cursor-pointer"
        >
          <option value="">Select a document...</option>
          {docs.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-3 mt-2">
          {selectedDocId && (
            <a
              href={`https://docs.google.com/document/d/${selectedDocId}/edit`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[0.6rem] font-mono text-zinc-600 hover:text-blue-400 transition-colors"
            >
              Open in Docs &rarr;
            </a>
          )}
          {onCreateDoc && (
            <button
              onClick={onCreateDoc}
              disabled={disabled || isCreatingDoc}
              className="inline-flex items-center gap-1 text-[0.6rem] font-mono text-zinc-600 hover:text-blue-400 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <FilePlus className={`w-3 h-3 ${isCreatingDoc ? 'animate-pulse' : ''}`} />
              {isCreatingDoc ? "Creating…" : "New Doc"}
            </button>
          )}
        </div>
      </div>

      {/* ═══ Writing Rhythm ═══ */}
      <div>
        <Label className="mb-2.5 block">Writing Rhythm</Label>
        <div className="grid grid-cols-3 gap-1.5">
          <button
            onClick={() => onRhythmChange("human")}
            disabled={disabled}
            className={`px-2.5 py-2.5 rounded-lg text-left transition-all ${
              rhythm === "human"
                ? "bg-blue-500/10 border border-blue-500/30 shadow-[0_0_10px_rgba(59,130,246,0.1)]"
                : "bg-[#09090b] border border-white/[0.04] hover:border-white/[0.08]"
            } disabled:opacity-40`}
          >
            <div className="flex items-center gap-1.5">
              <Zap className={`w-3 h-3 ${rhythm === "human" ? "text-blue-400" : "text-zinc-500"}`} />
              <span className={`text-[12px] font-semibold ${rhythm === "human" ? "text-blue-400" : "text-zinc-300"}`}>
                Human Pace
              </span>
            </div>
            <div className="text-[10px] text-zinc-600 mt-0.5 leading-tight">
              Constant sync over a set duration
            </div>
          </button>
          <button
            onClick={() => onRhythmChange("burst")}
            disabled={disabled}
            className={`px-2.5 py-2.5 rounded-lg text-left transition-all relative ${
              isBurst
                ? "bg-purple-500/10 border border-purple-500/30 shadow-[0_0_10px_rgba(168,85,247,0.1)]"
                : "bg-[#09090b] border border-white/[0.04] hover:border-white/[0.08]"
            } disabled:opacity-40`}
          >
            <div className="flex items-center gap-1.5">
              <Shuffle className={`w-3 h-3 ${isBurst ? "text-purple-400" : "text-zinc-500"}`} />
              <span className={`text-[12px] font-semibold ${isBurst ? "text-purple-400" : "text-zinc-300"}`}>
                Burst Mode
              </span>
            </div>
            <div className="text-[10px] text-zinc-600 mt-0.5 leading-tight">
              Mandatory pause checkpoints · micro-typing
            </div>
          </button>
          <button
            onClick={() => onRhythmChange("custom")}
            disabled={disabled}
            className={`px-2.5 py-2.5 rounded-lg text-left transition-all relative ${
              isCustom
                ? "bg-emerald-500/10 border border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.1)]"
                : "bg-[#09090b] border border-white/[0.04] hover:border-white/[0.08]"
            } disabled:opacity-40`}
          >
            <div className="flex items-center gap-1.5">
              <Sliders className={`w-3 h-3 ${isCustom ? "text-emerald-400" : "text-zinc-500"}`} />
              <span className={`text-[12px] font-semibold ${isCustom ? "text-emerald-400" : "text-zinc-300"}`}>
                Custom
              </span>
            </div>
            <div className="text-[10px] text-zinc-600 mt-0.5 leading-tight">
              1 sentence/min · pick your own pauses
            </div>
          </button>
        </div>
      </div>

      {/* ═══ Duration (Human Pace only) ═══ */}
      {!isBurst && !isCustom && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <Label className="inline-flex items-center">Duration<Tooltip text="Total time to spread typing over" /></Label>
            <span className="text-[0.6rem] font-mono text-zinc-500">
              {formatDuration(durationMinutes)}
            </span>
          </div>
          <SliderWithTooltip
            value={[DURATION_PRESETS.indexOf(durationMinutes)]}
            onValueChange={(v: number[]) => onDurationChange(DURATION_PRESETS[v[0]])}
            min={0}
            max={DURATION_PRESETS.length - 1}
            step={1}
            disabled={disabled}
            formatValue={(idx) => formatDuration(DURATION_PRESETS[idx])}
          />
          <div className="flex justify-between text-[0.5rem] text-zinc-700 mt-1.5 font-mono">
            <span>5m</span>
            <span>24h</span>
          </div>
        </div>
      )}

      {/* ═══ Burst Mode Estimated Time ═══ */}
      {isBurst && (
        <div className="rounded-lg border border-purple-500/15 bg-purple-500/[0.03] px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[0.6rem] font-bold uppercase tracking-[1.5px] text-zinc-500">
              Est. Duration
            </span>
            <span className="text-[12px] font-mono font-semibold text-purple-400 tabular-nums">
              {sourceWordCount > 0
                ? `${formatDuration(burstEstimate.minMinutes)} – ${formatDuration(burstEstimate.maxMinutes)}`
                : "--"}
            </span>
          </div>
          <p className="text-[10px] text-zinc-600 mt-1 leading-tight">
            Mandatory pause checkpoints create realistic version-history gaps. Auto-calculated from word count.
          </p>

          {/* Mandatory Pause Preview */}
          {sourceWordCount > 0 && (
            <div className="mt-2.5 pt-2 border-t border-purple-500/10">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Timer className="w-3 h-3 text-purple-400/60" />
                <span className="text-[9px] font-bold uppercase tracking-[1.5px] text-zinc-600">
                  Required Pauses ({burstPauses.length})
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {burstPauses.map((mins, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-1.5 py-0.5 rounded bg-purple-500/8 border border-purple-500/15 text-[10px] font-mono text-purple-400/80"
                  >
                    {mins}m
                  </span>
                ))}
              </div>
              <p className="text-[9px] text-zinc-700 mt-1.5 leading-tight">
                Each pause must complete before sync finishes. Order is randomized.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ═══ Custom Mode Builder ═══ */}
      {isCustom && (
        <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.03] px-3 py-2.5">
          {/* Base ETA from sentence count */}
          <div className="flex items-center justify-between">
            <span className="text-[0.6rem] font-bold uppercase tracking-[1.5px] text-zinc-500">
              Base ETA
            </span>
            <span className="text-[12px] font-mono font-semibold text-emerald-400 tabular-nums">
              {sentenceCount > 0
                ? `${sentenceCount} ${sentenceCount === 1 ? "sentence" : "sentences"} · ${formatDuration(customBaseMinutes)}`
                : "--"}
            </span>
          </div>
          <p className="text-[10px] text-zinc-600 mt-1 leading-tight">
            One sentence per minute. Add up to {MAX_CUSTOM_PAUSES} pauses below to extend the schedule.
          </p>

          {/* Pause catalog */}
          <div className="mt-2.5 pt-2 border-t border-emerald-500/10">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Plus className="w-3 h-3 text-emerald-400/60" />
              <span className="text-[9px] font-bold uppercase tracking-[1.5px] text-zinc-600">
                Pause Catalog
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {CUSTOM_PAUSE_CATALOG.map((mins) => {
                const cartFull = customPauses.length >= MAX_CUSTOM_PAUSES;
                return (
                  <button
                    key={mins}
                    onClick={() => addCustomPause(mins)}
                    disabled={disabled || cartFull}
                    className="inline-flex items-center px-2 py-0.5 rounded bg-[#09090b] border border-white/[0.06] text-[10px] font-mono text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-400 transition-colors disabled:opacity-30 disabled:pointer-events-none"
                  >
                    {formatDuration(mins)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Cart */}
          <div className="mt-2.5 pt-2 border-t border-emerald-500/10">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <Timer className="w-3 h-3 text-emerald-400/60" />
                <span className="text-[9px] font-bold uppercase tracking-[1.5px] text-zinc-600">
                  Your Pauses ({customPauses.length}/{MAX_CUSTOM_PAUSES})
                </span>
              </div>
            </div>
            {customPauses.length === 0 ? (
              <p className="text-[10px] text-zinc-700 leading-tight">
                No pauses added — sync will run at the base ETA.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {customPauses.map((mins, i) => (
                  <button
                    key={i}
                    onClick={() => removeCustomPause(i)}
                    disabled={disabled}
                    className="group inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-[10px] font-mono text-emerald-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    title="Click to remove"
                  >
                    {formatDuration(mins)}
                    <X className="w-2.5 h-2.5 opacity-60 group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            )}
            <p className="text-[9px] text-zinc-700 mt-1.5 leading-tight">
              Pauses fire in the order added, evenly spaced between sentences.
            </p>
          </div>

          {/* Final ETA */}
          <div className="mt-2.5 pt-2 border-t border-emerald-500/10 flex items-center justify-between">
            <span className="text-[0.6rem] font-bold uppercase tracking-[1.5px] text-zinc-500">
              Final ETA
            </span>
            <span className="text-[13px] font-mono font-bold text-emerald-300 tabular-nums">
              {sentenceCount > 0 ? formatDuration(customFinalMinutes) : "--"}
            </span>
          </div>
        </div>
      )}

      {/* Pause Length removed — burst mode is now fully automatic */}

      {/* ═══ Typo Frequency (both modes) ═══ */}
      {(() => {
        const idx = closestPresetIndex(TYPO_PRESETS, typoFrequency);
        return (
          <div>
            <div className="flex items-center justify-between mb-3">
              <Label className="inline-flex items-center">Typo Frequency<Tooltip text="How often realistic typos are injected and corrected" /></Label>
              <span className="text-[0.6rem] font-mono text-zinc-500">
                {TYPO_PRESETS[idx].label} · {TYPO_PRESETS[idx].desc}
              </span>
            </div>
            <SliderWithTooltip
              value={[idx]}
              onValueChange={(v: number[]) => onTypoFrequencyChange(TYPO_PRESETS[v[0]].value)}
              min={0}
              max={TYPO_PRESETS.length - 1}
              step={1}
              disabled={disabled}
              formatValue={(i) => TYPO_PRESETS[i].label}
            />
            <div className="flex justify-between text-[0.5rem] text-zinc-700 mt-1.5 font-mono">
              <span>Rare</span>
              <span>Frequent</span>
            </div>
          </div>
        );
      })()}

      {/* ═══ Smart Schedule ═══ */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-[0.6rem] font-bold uppercase tracking-[1.5px] text-zinc-500">
            Smart Schedule
          </span>
        </div>

        {isScheduled ? (
          <div className="text-center">
            <div className="text-lg font-mono font-bold text-blue-400 tabular-nums mb-1.5">
              {formatCountdown(scheduleCountdown ?? 0)}
            </div>
            <p className="text-[10px] text-zinc-500 mb-2.5">Sync starts automatically</p>
            <button
              onClick={onCancelSchedule}
              className="w-full px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-zinc-800 border border-white/[0.06] text-zinc-400 hover:text-red-400 hover:border-red-500/20 transition-all"
            >
              Cancel Schedule
            </button>
          </div>
        ) : (
          <>
            <div className="mb-2.5">
              <SliderWithTooltip
                value={[scheduleDelay]}
                onValueChange={(v: number[]) => setScheduleDelay(v[0])}
                min={0}
                max={SCHEDULE_PRESETS.length - 1}
                step={1}
                disabled={disabled}
                formatValue={(idx) => formatDuration(SCHEDULE_PRESETS[idx])}
              />
              <div className="flex justify-between text-[0.5rem] text-zinc-700 mt-1 font-mono">
                <span>5m</span>
                <span>6h</span>
              </div>
            </div>
            <button
              onClick={() => onScheduleSync?.(SCHEDULE_PRESETS[scheduleDelay])}
              disabled={disabled}
              className="w-full px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-all disabled:opacity-30 disabled:pointer-events-none"
            >
              Start in {formatDuration(SCHEDULE_PRESETS[scheduleDelay])}
            </button>
            <p className="text-[10px] text-zinc-600 mt-2 leading-tight">
              Delays sync start to simulate typing at a specific time
            </p>
          </>
        )}
      </div>
    </div>
  );
}
