"use client";

import React from "react";
import { Check } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { PublicJob } from "@/lib/sync-store";
import { formatClock, formatSpan, formatWait } from "@/lib/format";
import { isActive, isFinished, progressOf, statusTitle } from "./job-status";
import { docsUrl } from "./header";
import type { useLiveBreaks } from "./use-live-breaks";
import { describeBreak, formatBreak } from "@/lib/breaks";
import { X } from "lucide-react";

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
  /** The breaks of a sync that can still change them */
  live?: ReturnType<typeof useLiveBreaks>;
  /** A sync typing into several tabs: each, in typing order, and how far it is */
  tabs?: { id: string; title: string; state: "done" | "typing" | "next" }[] | null;
}

export function JobPanel({ job, now, sourceWords, busy, canEditAsNew, onPause, onResume, onCancel, onDismiss, onEditAsNew, live, tabs }: JobPanelProps) {
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
    <div className="flex flex-col gap-5 px-5 pb-5 pt-4">
      <div>
        <h2 className="text-[22px] leading-7">{statusTitle(job)}</h2>
        {isActive(job) && job.status !== "paused" && remaining > 0 && (
          <p className="mt-1 text-[14px] text-[var(--ss-text-2)]">
            {job.status === "scheduled" ? `Starts in ${formatWait(remaining)}` : `About ${formatSpan(remaining / 60_000)} left`}
          </p>
        )}
        <div className="mt-3 flex items-center gap-3">
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

      {tabs && tabs.length > 1 && (
        <div>
          <h3 className="mb-2 text-[14px] font-medium">Tabs</h3>
          <ol className="ss-job-tabs" aria-label="Tabs, in the order they are typed">
            {tabs.map((t, i) => (
              <li key={i} data-state={t.state}>
                <span className="ss-job-tab-dot" aria-hidden>{t.state === "done" ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="text-[12px] text-[var(--ss-text-2)]">{t.state === "done" ? "Done" : t.state === "typing" ? (isActive(job) ? "Typing" : "Stopped here") : "Next"}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {live?.canEdit ? <LiveBreaks live={live} job={job} /> : job.breaks.length > 0 && (
        <div>
          <h3 className="mb-2 text-[14px] font-medium">Breaks</h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
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
        <a className="ss-btn ss-btn-outlined" href={docsUrl(job.documentId, job.tabId)} target="_blank" rel="noopener noreferrer">
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

/** A running sync's breaks, changeable after what it is typing now */
function LiveBreaks({ live, job }: { live: NonNullable<JobPanelProps["live"]>; job: PublicJob }) {
  const typed = live.breakLength.trim().length > 0;
  const placing = live.placing != null;
  const ahead = live.rows.filter((r) => r.state === "ahead");
  const current = live.rows.find((r) => r.state === "now");
  return (
    <section aria-label="Breaks">
      <h3 className="mb-2 text-[14px] font-medium">Breaks</h3>
      {current && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-[#fef7e0] px-3 py-2 text-[13px] text-[#5c4300]">
          <span>On a {formatBreak(current.minutes)} break{job.status === "paused" ? " (paused)" : ""}</span>
          <button type="button" className="ss-link-btn" disabled={live.sending} onClick={live.endNow}>End now</button>
        </div>
      )}
      {live.rows.length > 0 && (
        <ul className="ss-brk-list" aria-label="This sync's breaks">
          {live.rows.map((r) => (
            <li key={`${r.index}-${r.at}`} data-state={r.state}>
              <span className="ss-brk-row cursor-default">
                <span className="ss-brk-chip" data-state={r.state}>{r.state === "done" ? `✓ ${formatBreak(r.minutes)}` : formatBreak(r.minutes)}</span>
                <span className="truncate text-[var(--ss-text-2)]">{r.state === "done" ? "Taken" : r.state === "now" ? "On it now" : r.state === "locked" ? "Being typed now" : r.word ? `after “${r.word}”` : `After ${r.at != null ? Math.round(((r.at) / Math.max(1, job.totalChars)) * 100) : 0}% of the text`}</span>
              </span>
              {r.state === "ahead" && r.at != null && (
                <button type="button" className="ss-icon-btn ss-brk-remove" disabled={live.sending} onClick={() => live.remove(r.at!)} aria-label={`Remove the ${formatBreak(r.minutes)} break`} title="Remove">
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {ahead.length > 0 && (
        <div className="mt-1 flex justify-end">
          <button type="button" className="ss-link-btn text-[12px]" disabled={live.sending} onClick={live.clearFuture}>Clear breaks ahead</button>
        </div>
      )}
      <label className="ss-field-label mt-3" htmlFor="ss-live-break-length">Add a break</label>
      <div className="flex items-center gap-2">
        <input
          id="ss-live-break-length"
          className="ss-input min-w-0 flex-1"
          placeholder="e.g. 33m"
          autoComplete="off"
          spellCheck={false}
          value={live.breakLength}
          aria-invalid={typed && live.minutes == null ? true : undefined}
          onChange={(e) => live.setBreakLength(e.target.value)}
        />
        <button
          type="button"
          className={`ss-btn ${placing ? "ss-btn-tonal" : "ss-btn-outlined"} flex-none px-4`}
          aria-pressed={placing}
          disabled={live.minutes == null}
          onClick={live.togglePlacing}
        >
          Place on page
        </button>
      </div>
      <p className="ss-field-help" data-error={typed && live.minutes == null ? "true" : undefined}>
        {live.minutes == null
          ? typed ? "Try 33m or 1h 5m." : "Type a length, then click a word the sync hasn't typed yet."
          : placing ? `${describeBreak(live.minutes)}. Click a word not typed yet on the page.` : `${describeBreak(live.minutes)}. Press Place on page, then click a word not typed yet.`}
      </p>
    </section>
  );
}
