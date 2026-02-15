"use client";

import React from "react";
import { Label } from "@/components/ui/label";
import { SliderWithTooltip } from "@/components/ui/slider";

interface SyncControlsProps {
  docs: { id: string; name: string; modifiedTime: string }[];
  selectedDocId: string;
  onSelectDoc: (id: string) => void;
  rhythm: string;
  onRhythmChange: (r: string) => void;
  durationMinutes: number;
  onDurationChange: (d: number) => void;
  disabled?: boolean;
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function SyncControls({
  docs,
  selectedDocId,
  onSelectDoc,
  rhythm,
  onRhythmChange,
  durationMinutes,
  onDurationChange,
  disabled,
}: SyncControlsProps) {
  return (
    <div className="flex flex-col gap-5 h-full">
      {/* Target Document */}
      <div>
        <Label className="mb-2.5 block">Target Document</Label>
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
        {selectedDocId && (
          <a
            href={`https://docs.google.com/document/d/${selectedDocId}/edit`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-2 text-[0.6rem] font-mono text-zinc-600 hover:text-blue-400 transition-colors"
          >
            Open in Docs &rarr;
          </a>
        )}
      </div>

      {/* Writing Rhythm */}
      <div>
        <Label className="mb-2.5 block">Writing Rhythm</Label>
        <div className="flex gap-1.5">
          {([
            { key: "human", title: "Human Pace", sub: "Minute-quota typing with typo simulation" },
            { key: "longform", title: "Long Form", sub: "2h+ sessions with research pauses" },
          ] as const).map(({ key, title, sub }) => (
            <button
              key={key}
              onClick={() => onRhythmChange(key)}
              disabled={disabled}
              className={`flex-1 px-3 py-2.5 rounded-lg text-left transition-all ${
                rhythm === key
                  ? "bg-blue-500/10 border border-blue-500/30 shadow-[0_0_10px_rgba(59,130,246,0.1)]"
                  : "bg-[#09090b] border border-white/[0.04] hover:border-white/[0.08]"
              } disabled:opacity-40`}
            >
              <div className={`text-[12px] font-semibold ${rhythm === key ? "text-blue-400" : "text-zinc-300"}`}>
                {title}
              </div>
              <div className="text-[10px] text-zinc-600 mt-0.5 leading-tight">
                {sub}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Duration — Tooltip Slider */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label>Duration</Label>
          <span className="text-[0.6rem] font-mono text-zinc-500">
            {formatDuration(durationMinutes)}
          </span>
        </div>
        <SliderWithTooltip
          value={[durationMinutes]}
          onValueChange={(v: number[]) => onDurationChange(v[0])}
          min={5}
          max={1440}
          step={5}
          disabled={disabled}
          formatValue={(v) => formatDuration(v)}
        />
        <div className="flex justify-between text-[0.5rem] text-zinc-700 mt-1.5 font-mono">
          <span>5m</span>
          <span>24h</span>
        </div>
      </div>
    </div>
  );
}
