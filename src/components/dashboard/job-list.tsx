"use client";

import React from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PublicJob } from "@/lib/sync-store";
import { formatClock } from "@/lib/format";

interface JobListProps {
  jobs: PublicJob[];
  focusedJobId: string | null;
  composing: boolean;
  onFocus: (id: string) => void;
  onCompose: () => void;
  onDismiss: (id: string) => void;
}

const STATUS_DOT: Record<PublicJob["status"], string> = {
  scheduled: "bg-purple-400",
  pending: "bg-blue-500 animate-pulse",
  running: "bg-blue-500 animate-pulse",
  paused: "bg-yellow-500",
  done: "bg-emerald-500",
  error: "bg-red-500",
  cancelled: "bg-zinc-600",
};

export function JobList({ jobs, focusedJobId, composing, onFocus, onCompose, onDismiss }: JobListProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto flex-shrink-0 pb-0.5">
      <button
        onClick={onCompose}
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 rounded-lg border text-[12px] font-semibold whitespace-nowrap transition-colors",
          composing
            ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
            : "bg-[#09090b] border-white/[0.06] text-zinc-400 hover:text-zinc-200 hover:border-white/[0.12]"
        )}
      >
        <Plus className="w-3.5 h-3.5" />
        New sync
      </button>
      {jobs.map((job) => {
        const pct = job.totalChars > 0 ? Math.min(100, (job.charsSent / job.totalChars) * 100) : 0;
        const focused = !composing && job.id === focusedJobId;
        const finished = job.status === "done" || job.status === "error" || job.status === "cancelled";
        return (
          <div
            key={job.id}
            role="button"
            tabIndex={0}
            onClick={() => onFocus(job.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onFocus(job.id); }}
            className={cn(
              "group relative flex items-center gap-2.5 pl-3 pr-2 py-1.5 rounded-lg border whitespace-nowrap cursor-pointer transition-colors min-w-[180px]",
              focused
                ? "bg-white/[0.06] border-white/[0.12]"
                : "bg-[#09090b] border-white/[0.05] hover:border-white/[0.1]"
            )}
          >
            <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", STATUS_DOT[job.status])} />
            <div className="flex flex-col min-w-0">
              <span className="text-[12px] font-medium text-zinc-200 truncate max-w-[160px]">{job.documentName}</span>
              <span className="text-[10px] font-mono text-zinc-600">
                {job.status === "scheduled"
                  ? `starts ${formatClock(job.startAt)}`
                  : finished
                    ? job.status
                    : `${job.status} · ${Math.round(pct)}%`}
              </span>
            </div>
            {finished && (
              <button
                onClick={(e) => { e.stopPropagation(); onDismiss(job.id); }}
                className="ml-1 p-1 rounded text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
                title="Remove from list"
                aria-label="Remove from list"
              >
                <X className="w-3 h-3" />
              </button>
            )}
            {!finished && (
              <div className="absolute left-0 right-0 bottom-0 h-[2px] bg-white/[0.03] rounded-b-lg overflow-hidden">
                <div className="h-full bg-blue-500/60" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
