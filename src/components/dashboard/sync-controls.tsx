"use client";

import React from "react";
import { RotateCw, FilePlus, Shuffle, Timer, X, Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import { SliderWithTooltip } from "@/components/ui/slider";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import { formatClock, formatDuration } from "@/lib/format";
import { MAX_CUSTOM_BREAKS, type DripPlan } from "@/lib/drip-engine";

/** Index 0 = natural pace, the rest are target durations in minutes */
export const DURATION_PRESETS: (number | null)[] = [null, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
/** Index 0 = start now, the rest are delays in minutes */
export const START_PRESETS = [0, 5, 10, 15, 30, 60, 120, 180, 360, 720];
export const BREAK_CATALOG = [5, 10, 15, 30, 45, 60, 90, 120, 180];
export const TYPO_PRESETS = [
  { label: "Rare", value: 0 },
  { label: "Low", value: 0.25 },
  { label: "Medium", value: 0.5 },
  { label: "High", value: 0.75 },
  { label: "Frequent", value: 1 },
];

export type BreaksMode = "auto" | "none" | "custom";

interface SyncControlsProps {
  docs: { id: string; name: string; modifiedTime: string }[];
  selectedDocId: string;
  onSelectDoc: (id: string) => void;
  durationMinutes: number | null;
  onDurationChange: (minutes: number | null) => void;
  breaksMode: BreaksMode;
  onBreaksModeChange: (mode: BreaksMode) => void;
  customBreaks: number[];
  onCustomBreaksChange: (breaks: number[]) => void;
  typoFrequency: number;
  onTypoFrequencyChange: (value: number) => void;
  startInMinutes: number;
  onStartInChange: (minutes: number) => void;
  preview: DripPlan | null;
  onShuffle: () => void;
  disabled?: boolean;
  onRefreshDocs: () => void;
  onCreateDoc: () => void;
  isCreatingDoc: boolean;
  isRefreshing: boolean;
}

function closestIndex(values: number[], v: number): number {
  return values.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(values[best] - v) ? i : best), 0);
}

function Hint({ text }: { text: string }) {
  // Rendered in a portal with collision handling, so it never gets clipped by
  // the scrolling panel or pushed off the screen.
  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <button type="button" className="inline-flex ml-1.5 align-middle cursor-help" aria-label="More information">
            <Info className="w-3 h-3 text-zinc-600 hover:text-zinc-400 transition-colors" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-[100] max-w-[240px] rounded-md bg-zinc-900 border border-white/[0.08] px-3 py-2 text-[11px] text-zinc-400 leading-relaxed normal-case tracking-normal font-normal shadow-lg animate-in fade-in-0 zoom-in-95"
          >
            {text}
            <TooltipPrimitive.Arrow className="fill-zinc-900" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          disabled={disabled}
          className={cn(
            "px-2 py-1.5 rounded-md text-[11px] font-semibold border transition-colors disabled:opacity-40",
            value === o.value
              ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
              : "bg-[#09090b] border-white/[0.05] text-zinc-500 hover:text-zinc-300 hover:border-white/[0.1]"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SyncControls(props: SyncControlsProps) {
  const {
    docs, selectedDocId, onSelectDoc,
    durationMinutes, onDurationChange,
    breaksMode, onBreaksModeChange, customBreaks, onCustomBreaksChange,
    typoFrequency, onTypoFrequencyChange,
    startInMinutes, onStartInChange,
    preview, onShuffle, disabled,
    onRefreshDocs, onCreateDoc, isCreatingDoc, isRefreshing,
  } = props;

  const durationIdx = Math.max(0, DURATION_PRESETS.indexOf(durationMinutes));
  const startIdx = closestIndex(START_PRESETS, startInMinutes);
  const typoIdx = closestIndex(TYPO_PRESETS.map((t) => t.value), typoFrequency);

  const startAt = Date.now() + startInMinutes * 60_000;
  const finishAt = preview ? startAt + preview.totalMs : null;
  const typoCount = preview ? preview.actions.filter((a) => a.kind === "typo").length : 0;
  const editCount = preview ? preview.actions.filter((a) => a.kind !== "pause").length : 0;

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pr-1">
      {/* Target document */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <Label>Target document</Label>
          <button
            onClick={onRefreshDocs}
            disabled={disabled || isRefreshing}
            className="p-1 rounded hover:bg-white/[0.04] transition-colors disabled:opacity-40"
            title="Refresh document list"
          >
            <RotateCw className={cn("h-3.5 w-3.5 text-zinc-500 hover:text-blue-400 transition-colors", isRefreshing && "animate-spin")} />
          </button>
        </div>
        <select
          value={selectedDocId}
          onChange={(e) => onSelectDoc(e.target.value)}
          disabled={disabled}
          className="w-full bg-[#09090b] border border-white/[0.06] rounded-lg px-3 py-2.5 pr-8 text-[13px] text-zinc-300 font-mono focus:border-blue-500/50 focus:outline-none disabled:opacity-40 transition-colors appearance-none cursor-pointer"
        >
          <option value="">Select a document…</option>
          {docs.map((doc) => (
            <option key={doc.id} value={doc.id}>{doc.name}</option>
          ))}
        </select>
        <div className="flex items-center gap-3 mt-2">
          {selectedDocId && (
            <a
              href={`https://docs.google.com/document/d/${selectedDocId}/edit`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[0.6rem] font-mono text-zinc-600 hover:text-blue-400 transition-colors"
            >
              Open in Docs &rarr;
            </a>
          )}
          <button
            onClick={onCreateDoc}
            disabled={disabled || isCreatingDoc}
            className="inline-flex items-center gap-1 text-[0.6rem] font-mono text-zinc-600 hover:text-blue-400 transition-colors disabled:opacity-40"
          >
            <FilePlus className={cn("w-3 h-3", isCreatingDoc && "animate-pulse")} />
            {isCreatingDoc ? "Creating…" : "New doc"}
          </button>
        </div>
      </div>

      {/* Duration */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label className="inline-flex items-center">
            Total time
            <Hint text="Auto types at a natural pace. A longer target adds away-time between paragraphs rather than slowing each keystroke. A shorter target drops breaks and types faster, down to a realistic floor." />
          </Label>
          <span className="text-[0.6rem] font-mono text-zinc-500">
            {durationMinutes == null ? "Auto · natural pace" : formatDuration(durationMinutes)}
          </span>
        </div>
        <SliderWithTooltip
          value={[durationIdx]}
          onValueChange={(v) => onDurationChange(DURATION_PRESETS[v[0]])}
          min={0}
          max={DURATION_PRESETS.length - 1}
          step={1}
          disabled={disabled}
          formatValue={(i) => (DURATION_PRESETS[i] == null ? "Auto" : formatDuration(DURATION_PRESETS[i] as number))}
        />
        <div className="flex justify-between text-[0.5rem] text-zinc-700 mt-1.5 font-mono">
          <span>Auto</span>
          <span>24h</span>
        </div>
      </div>

      {/* Breaks */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <Label className="inline-flex items-center">
            Breaks
            <Hint text="Longer gaps that show up as pauses in version history. Auto picks a few based on the text length. Custom lets you choose exactly which ones." />
          </Label>
        </div>
        <Segmented
          value={breaksMode}
          onChange={onBreaksModeChange}
          disabled={disabled}
          options={[
            { value: "auto", label: "Auto" },
            { value: "none", label: "None" },
            { value: "custom", label: "Custom" },
          ]}
        />
        {breaksMode === "custom" && (
          <div className="mt-2.5 rounded-lg border border-white/[0.05] bg-white/[0.02] p-2.5">
            <div className="flex flex-wrap gap-1 mb-2">
              {BREAK_CATALOG.map((m) => (
                <button
                  key={m}
                  onClick={() => onCustomBreaksChange([...customBreaks, m])}
                  disabled={disabled || customBreaks.length >= MAX_CUSTOM_BREAKS}
                  className="px-2 py-0.5 rounded bg-[#09090b] border border-white/[0.06] text-[10px] font-mono text-zinc-300 hover:border-blue-500/40 hover:text-blue-400 transition-colors disabled:opacity-30"
                >
                  +{formatDuration(m)}
                </button>
              ))}
            </div>
            {customBreaks.length === 0 ? (
              <p className="text-[10px] text-zinc-600">Pick up to {MAX_CUSTOM_BREAKS} breaks. They run in this order, spread through the text.</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {customBreaks.map((m, i) => (
                  <button
                    key={`${m}-${i}`}
                    onClick={() => onCustomBreaksChange(customBreaks.filter((_, k) => k !== i))}
                    disabled={disabled}
                    className="group inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/25 text-[10px] font-mono text-blue-300 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
                    title="Remove"
                  >
                    {formatDuration(m)}
                    <X className="w-2.5 h-2.5 opacity-60 group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Typos */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label>Typos</Label>
          <span className="text-[0.6rem] font-mono text-zinc-500">{TYPO_PRESETS[typoIdx].label}</span>
        </div>
        <SliderWithTooltip
          value={[typoIdx]}
          onValueChange={(v) => onTypoFrequencyChange(TYPO_PRESETS[v[0]].value)}
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

      {/* Start time */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label className="inline-flex items-center">
            Start
            <Hint text="Scheduled syncs run on the server. You can close the tab or turn off your computer." />
          </Label>
          <span className="text-[0.6rem] font-mono text-zinc-500">
            {startInMinutes === 0 ? "Now" : `In ${formatDuration(startInMinutes)} · ${formatClock(startAt)}`}
          </span>
        </div>
        <SliderWithTooltip
          value={[startIdx]}
          onValueChange={(v) => onStartInChange(START_PRESETS[v[0]])}
          min={0}
          max={START_PRESETS.length - 1}
          step={1}
          disabled={disabled}
          formatValue={(i) => (START_PRESETS[i] === 0 ? "Now" : `In ${formatDuration(START_PRESETS[i])}`)}
        />
        <div className="flex justify-between text-[0.5rem] text-zinc-700 mt-1.5 font-mono">
          <span>Now</span>
          <span>12h</span>
        </div>
      </div>

      {/* Plan preview */}
      <div className="rounded-lg border border-blue-500/15 bg-blue-500/[0.03] px-3 py-2.5 mt-auto">
        <div className="flex items-center justify-between">
          <span className="text-[0.6rem] font-bold uppercase tracking-[1.5px] text-zinc-500 inline-flex items-center gap-1.5">
            <Timer className="w-3 h-3 text-blue-400/70" />
            Plan
          </span>
          <button
            onClick={onShuffle}
            disabled={disabled || !preview}
            className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-500 hover:text-blue-400 transition-colors disabled:opacity-30"
            title="Generate a different schedule"
          >
            <Shuffle className="w-3 h-3" /> Shuffle
          </button>
        </div>
        {preview ? (
          <>
            <div className="mt-1.5 text-[13px] font-mono font-semibold text-blue-300 tabular-nums">
              {formatDuration(preview.totalMs / 60_000)}
              <span className="text-zinc-500 font-normal text-[11px]"> · finishes {finishAt ? formatClock(finishAt) : "--"}</span>
            </div>
            <div className="mt-1 text-[10px] text-zinc-500 font-mono">
              {editCount} edits · {typoCount} typos · {preview.breaks.length} {preview.breaks.length === 1 ? "break" : "breaks"}
            </div>
            {preview.breaks.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {preview.breaks.map((m, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/15 text-[10px] font-mono text-blue-300/80">
                    {formatDuration(m)}
                  </span>
                ))}
              </div>
            )}
            {preview.targetMs != null && !preview.fitsTarget ? (
              <p className="text-[10px] text-amber-400/90 mt-1.5 leading-relaxed">
                {formatDuration(preview.targetMs / 60_000)} requested, but {breaksMode === "none" ? "without breaks" : "with these breaks"} this text takes{" "}
                {preview.totalMs < preview.targetMs ? "at most" : "at least"} {formatDuration(preview.totalMs / 60_000)}.{" "}
                {preview.totalMs < preview.targetMs
                  ? breaksMode === "none"
                    ? "Set breaks to Auto to fill the time, or lower the total time."
                    : "Add longer breaks, set breaks to Auto, or lower the total time."
                  : "Remove some breaks or raise the total time."}
              </p>
            ) : (
              <p className="text-[9px] text-zinc-600 mt-1.5">This exact schedule will run.</p>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-[11px] text-zinc-600">Paste some text to see the schedule.</p>
        )}
      </div>
    </div>
  );
}
