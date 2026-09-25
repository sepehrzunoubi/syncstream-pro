"use client";

import React from "react";
import { Check } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { PublicJob } from "@/lib/sync-store";
import { formatClock, formatSpan, formatWait } from "@/lib/format";
import { isActive, isFinished, progressOf, statusTitle } from "./job-status";

interface JobPanelProps {
  job: PublicJob;
  now: number;
  sourceWords: number;
  busy: boolean;
  canEditAsNew: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onEditAsNew: () => void;
}

export function JobPanel({ job, now, sourceWords, busy, canEditAsNew, onPause, onResume, onCancel, onDismiss, onEditAsNew }: JobPanelProps) {
  const pct = progressOf(job);
  const running = job.status === "running" || job.status === "pending";
  const typedWords = Math.max(0, (job.liveWordCount ?? job.baselineWordCount) - job.baselineWordCount);
  const remaining = job.status === "scheduled" ? job.startAt - now : (job.etaTargetAt ?? now) - now;
  const nextEdit = running && job.nextActionAt ? job.nextActionAt - now : null;
  const nextBreak = running && job.nextBreakAt != null && job.nextBreakAt > now ? job.nextBreakAt - now : null;

  const rows: [string, string][] = [];
  if (job.status === "scheduled") rows.push(["Starts", formatClock(job.startAt)]);
  if (isActive(job) && job.status !== "paused" && job.etaTargetAt) rows.push(["Finishes around", formatClock(job.etaTargetAt)]);
  if (job.status === "done" && job.finishedAt) rows.push(["Finished", formatClock(job.finishedAt)]);
  if (nextEdit != null && nextEdit > 0) rows.push(["Next edit", `in ${formatWait(nextEdit)}`]);
  if (nextBreak != null) rows.push(["Next break", `in ${formatWait(nextBreak)}`]);
  rows.push(["Words typed", `${typedWords.toLocaleString()} of ${sourceWords.toLocaleString()}`]);
  rows.push(["Edits", `${Math.min(job.currentAction, job.totalActions).toLocaleString()} of ${job.totalActions.toLocaleString()}`]);
  if (job.status === "paused" && job.pausedAt) rows.push(["Paused", formatClock(job.pausedAt)]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-[22px] leading-7">{statusTitle(job)}</h2>
        {isActive(job) && job.status !== "paused" && remaining > 0 && (
          <p className="mt-1 text-[14px] text-[var(--ss-text-2)]">
            {job.status === "scheduled" ? `Starts in ${formatWait(remaining)}` : `About ${formatSpan(remaining / 60_000)} left`}
          </p>
        )}
        <div className="mt-4 flex items-center gap-3">
          <div className="ss-progress flex-1" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Typed">
            <motion.div initial={false} animate={{ width: `${pct}%` }} transition={{ type: "spring", stiffness: 90, damping: 20 }} />
          </div>
          <span className="w-10 text-right text-[14px] tabular-nums text-[var(--ss-text-2)]">{Math.round(pct)}%</span>
        </div>
      </div>

      {job.status === "error" && job.error && (
        <p role="alert" className="rounded-lg bg-[#fce8e6] p-3 text-[13px] leading-5 text-[#8c1d18]">{job.error}</p>
      )}

      <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[14px]">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-[var(--ss-text-2)]">{k}</dt>
            <dd className="text-right tabular-nums">{v}</dd>
          </React.Fragment>
        ))}
      </dl>

      {job.breaks.length > 0 && (
        <div>
          <h3 className="mb-2 text-[14px] font-medium">Breaks</h3>
          <ul className="flex flex-col gap-1.5">
            {job.breaks.map((m, i) => {
              const done = job.completedBreaks.includes(i);
              return (
                <li key={i} className="flex items-center gap-2 text-[14px]">
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full transition-colors duration-300 ${done ? "bg-[#c4eed0] text-[#0d652d]" : "border border-[var(--ss-divider)]"}`}>
                    <AnimatePresence>
                      {done && (
                        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: "spring", stiffness: 600, damping: 26 }}>
                          <Check className="h-3.5 w-3.5" />
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                  <span className={done ? "text-[var(--ss-text-3)]" : ""}>{formatSpan(m)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <motion.div layout className="flex flex-wrap items-center gap-2">
        {(running || job.status === "scheduled") && (
          <button className="ss-btn ss-btn-tonal" onClick={onPause} disabled={busy}>Pause</button>
        )}
        {job.status === "paused" && (
          <button className="ss-btn ss-btn-filled" onClick={onResume} disabled={busy}>Resume</button>
        )}
        <a className="ss-btn ss-btn-outlined" href={`https://docs.google.com/document/d/${job.documentId}/edit`} target="_blank" rel="noopener noreferrer">
          Open in Google Docs
        </a>
        {isActive(job) && <button className="ss-btn ss-btn-danger" onClick={onCancel} disabled={busy}>Cancel sync</button>}
        {isFinished(job) && canEditAsNew && job.status !== "done" && (
          <button className="ss-btn ss-btn-text" onClick={onEditAsNew}>Edit as new sync</button>
        )}
        {isFinished(job) && <button className="ss-btn ss-btn-text" onClick={onDismiss}>Remove from list</button>}
      </motion.div>

      {isActive(job) && (
        <p className="text-[12px] leading-4 text-[var(--ss-text-3)]">This sync runs on our server. You can close this tab or turn off your computer.</p>
      )}
    </div>
  );
}
