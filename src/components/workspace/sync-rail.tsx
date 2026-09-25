"use client";

import React from "react";
import { Plus } from "lucide-react";
import type { PublicJob } from "@/lib/sync-store";
import { isActive, progressOf, statusLine } from "./job-status";

interface SyncRailProps {
  jobs: PublicJob[];
  focusedJobId: string | null;
  composing: boolean;
  onCompose: () => void;
  onFocus: (id: string) => void;
}

const DOT: Record<PublicJob["status"], string> = {
  scheduled: "#8e918f",
  pending: "#0b57d0",
  running: "#0b57d0",
  paused: "#b06000",
  done: "#146c2e",
  error: "#b3261e",
  cancelled: "#8e918f",
};

export function SyncRail({ jobs, focusedJobId, composing, onCompose, onFocus }: SyncRailProps) {
  const active = jobs.filter(isActive);
  const finished = jobs.filter((j) => !isActive(j));
  return (
    <nav className="flex h-full w-[264px] flex-none flex-col overflow-y-auto px-3 pb-4" aria-label="Syncs">
      <div className="flex h-10 items-center justify-between pl-3">
        <h2 className="text-[14px] font-medium">Syncs</h2>
        <button className="ss-icon-btn h-9 w-9 rounded-full" onClick={onCompose} title="New sync" aria-label="New sync">
          <Plus className="h-5 w-5" />
        </button>
      </div>

      <RailItem selected={composing} onClick={onCompose} title="New sync" line="Draft on this device" />

      {active.length > 0 && <div className="mt-4 px-3 pb-1 text-[12px] text-[var(--ss-text-3)]">In progress</div>}
      {active.map((j) => (
        <RailItem key={j.id} selected={!composing && j.id === focusedJobId} onClick={() => onFocus(j.id)} title={j.documentName} line={statusLine(j)} dot={DOT[j.status]} progress={progressOf(j)} />
      ))}

      {finished.length > 0 && <div className="mt-4 px-3 pb-1 text-[12px] text-[var(--ss-text-3)]">Earlier</div>}
      {finished.map((j) => (
        <RailItem key={j.id} selected={!composing && j.id === focusedJobId} onClick={() => onFocus(j.id)} title={j.documentName} line={statusLine(j)} dot={DOT[j.status]} />
      ))}

      {jobs.length === 0 && (
        <p className="mt-4 px-3 text-[12px] leading-4 text-[var(--ss-text-3)]">
          Syncs you start appear here. They keep running on the server after you close this tab.
        </p>
      )}
    </nav>
  );
}

function RailItem({ selected, onClick, title, line, dot, progress }: { selected: boolean; onClick: () => void; title: string; line: string; dot?: string; progress?: number }) {
  return (
    <button
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={`relative flex w-full items-start gap-3 rounded-2xl px-3 py-2 text-left transition-colors ${selected ? "bg-[#d3e3fd] text-[var(--ss-on-pressed)]" : "hover:bg-[var(--ss-hover)]"}`}
    >
      {dot && <span className="mt-[7px] h-2 w-2 flex-none rounded-full" style={{ background: dot }} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] leading-5">{title}</span>
        <span className="block truncate text-[12px] leading-4 text-[var(--ss-text-2)]">{line}</span>
        {progress != null && (
          <span className="ss-progress mt-1.5 block" aria-hidden="true"><span className="block h-full bg-[var(--ss-blue)]" style={{ width: `${progress}%` }} /></span>
        )}
      </span>
    </button>
  );
}
