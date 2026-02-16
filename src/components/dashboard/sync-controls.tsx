"use client";

import React, { useMemo, useState } from "react";
import { RotateCw, Clock, Zap, Shuffle, Info, FilePlus } from "lucide-react";
import { Label } from "@/components/ui/label";
import { SliderWithTooltip } from "@/components/ui/slider";

// Discrete duration presets in minutes: 5m, 15m, 30m, 45m, 1h, 2h, 5h, 12h, 24h
const DURATION_PRESETS = [5, 15, 30, 45, 60, 120, 300, 720, 1440];

// Schedule delay presets in minutes
const SCHEDULE_PRESETS = [5, 10, 15, 30, 60, 120, 180, 360];

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
  pauseVariance: number;
  onPauseVarianceChange: (v: number) => void;
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
 * Estimate burst mode total duration client-side for the UI preview.
 * Mirrors the server-side algorithm: random sessions + pauses.
 */
function estimateBurstDuration(
  wordCount: number,
  pauseVariance: number
): { minMinutes: number; maxMinutes: number } {
  if (wordCount <= 0) return { minMinutes: 0, maxMinutes: 0 };
  const charCount = wordCount * 5;
  const activeCPM = 175;
  const activeMinutes = charCount / activeCPM;
  const avgSessionMinutes = 4.5;
  const sessions = Math.max(1, Math.ceil(activeMinutes / avgSessionMinutes));
  const gaps = Math.max(0, sessions - 1);
  // Pause range based on variance — matches engine
  const minPauseMin = 1 + pauseVariance * 29;  // 1 → 30
  const maxPauseMin = 5 + pauseVariance * 115; // 5 → 120
  const minTotal = Math.ceil(activeMinutes + gaps * minPauseMin);
  const maxTotal = Math.ceil(activeMinutes + gaps * maxPauseMin);
  return { minMinutes: Math.max(1, minTotal), maxMinutes: Math.max(1, maxTotal) };
}

const TYPO_PRESETS = [
  { label: "Rare", value: 0, desc: "~1 per 300 chars" },
  { label: "Low", value: 0.25, desc: "~1 per 235 chars" },
  { label: "Medium", value: 0.5, desc: "~1 per 170 chars" },
  { label: "High", value: 0.75, desc: "~1 per 105 chars" },
  { label: "Frequent", value: 1.0, desc: "~1 per 40 chars" },
];

const PAUSE_PRESETS = [
  { label: "Short", value: 0, desc: "1-5m breaks" },
  { label: "Moderate", value: 0.25, desc: "3-15m breaks" },
  { label: "Medium", value: 0.5, desc: "5-30m breaks" },
  { label: "Long", value: 0.75, desc: "10-60m breaks" },
  { label: "Extended", value: 1.0, desc: "30m-2h breaks" },
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
  pauseVariance,
  onPauseVarianceChange,
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
}: SyncControlsProps) {
  const [scheduleDelay, setScheduleDelay] = useState(1); // index into SCHEDULE_PRESETS

  const sourceWordCount = useMemo(() => {
    const trimmed = sourceText.trim();
    return trimmed ? trimmed.split(/\s+/).filter((w) => w.length > 0).length : 0;
  }, [sourceText]);

  const burstEstimate = useMemo(
    () => estimateBurstDuration(sourceWordCount, pauseVariance),
    [sourceWordCount, pauseVariance]
  );

  const isBurst = rhythm === "burst";

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Target Document */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <Label>Target Document</Label>
          <button
            onClick={onRefreshDocs}
            disabled={disabled || isRefreshing}
            className="p-1 rounded hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
              className="inline-flex items-center gap-1 text-[0.6rem] font-mono text-zinc-600 hover:text-blue-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
        <div className="flex gap-1.5">
          <button
            onClick={() => onRhythmChange("human")}
            disabled={disabled}
            className={`flex-1 px-3 py-2.5 rounded-lg text-left transition-all ${
              !isBurst
                ? "bg-blue-500/10 border border-blue-500/30 shadow-[0_0_10px_rgba(59,130,246,0.1)]"
                : "bg-[#09090b] border border-white/[0.04] hover:border-white/[0.08]"
            } disabled:opacity-40`}
          >
            <div className="flex items-center gap-1.5">
              <Zap className={`w-3 h-3 ${!isBurst ? "text-blue-400" : "text-zinc-500"}`} />
              <span className={`text-[12px] font-semibold ${!isBurst ? "text-blue-400" : "text-zinc-300"}`}>
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
            className={`flex-1 px-3 py-2.5 rounded-lg text-left transition-all ${
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
              Random sessions with natural gaps
            </div>
          </button>
        </div>
      </div>

      {/* ═══ Duration (Human Pace only) ═══ */}
      {!isBurst && (
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
            Auto-calculated from word count. Burst mode picks its own timing with random writing sessions and natural pauses.
          </p>
        </div>
      )}

      {/* ═══ Pause Length (Burst Mode only) ═══ */}
      {isBurst && (() => {
        const idx = closestPresetIndex(PAUSE_PRESETS, pauseVariance);
        return (
          <div>
            <div className="flex items-center justify-between mb-3">
              <Label className="inline-flex items-center">Pause Length<Tooltip text="Break time between typing sessions, like grabbing food or stepping away" /></Label>
              <span className="text-[0.6rem] font-mono text-zinc-500">
                {PAUSE_PRESETS[idx].label} · {PAUSE_PRESETS[idx].desc}
              </span>
            </div>
            <SliderWithTooltip
              value={[idx]}
              onValueChange={(v: number[]) => onPauseVarianceChange(PAUSE_PRESETS[v[0]].value)}
              min={0}
              max={PAUSE_PRESETS.length - 1}
              step={1}
              disabled={disabled}
              formatValue={(i) => PAUSE_PRESETS[i].label}
            />
            <div className="flex justify-between text-[0.5rem] text-zinc-700 mt-1.5 font-mono">
              <span>Short</span>
              <span>Extended</span>
            </div>
          </div>
        );
      })()}

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
              className="w-full px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
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
