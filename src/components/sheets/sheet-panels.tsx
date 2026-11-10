"use client";

import React from "react";
import { Coffee, ExternalLink, FileSpreadsheet, Pause, Play, Shuffle, Table2, Upload } from "lucide-react";
import type { PublicJob } from "@/lib/sync-store";
import type { Workbook, WorkbookStats } from "@/lib/sheets/model";
import type { SheetBreak, SheetPlan } from "@/lib/sheets/plan";
import type { PlanSection } from "@/lib/sheets/order";
import { stepLabel, type Step } from "@/lib/sheets/steps";
import { formatClock, formatCountdown, formatSpan } from "@/lib/format";
import { isActive, progressOf, statusLine } from "../workspace/job-status";
import { Menu, MenuItem } from "../workspace/menu";

export interface SheetSettings { targetMinutes: number | null; startInMinutes: number; seed: number; breaks: SheetBreak[] }

const DURATION_OPTIONS: (number | null)[] = [null, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
const START_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 180, 360, 720];
const BREAK_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];

const DOT: Record<PublicJob["status"], string> = { scheduled: "#8e918f", pending: "#0b57d0", running: "#0b57d0", paused: "#b06000", done: "#146c2e", error: "#b3261e", cancelled: "#8e918f" };
const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
/** A sync's one-line status, in a spreadsheet's words */
export const sheetStatus = (job: PublicJob) => statusLine(job).replace(/^Typing/, "Building").replace(/typed$/, "built");

/** When each step happens, from the start: starts[i] is the wait before step i has run out */
function stepTimes(plan: SheetPlan): number[] {
  const out = new Array<number>(plan.actions.length + 1);
  out[0] = 0;
  plan.actions.forEach((a, i) => { out[i + 1] = out[i] + a.delayMs; });
  return out;
}

const sectionName = (wb: Workbook | null, s: PlanSection): string => {
  const rows = s.rows[0] === s.rows[1] ? `row ${s.rows[0] + 1}` : `rows ${s.rows[0] + 1}-${s.rows[1] + 1}`;
  const sheet = wb && wb.sheets.length > 1 ? `${wb.sheets[s.sheet]?.name} · ` : "";
  return `${sheet}${s.title ? `${s.title} (${rows})` : rows[0].toUpperCase() + rows.slice(1)}`;
};

// ── The list of spreadsheet syncs ──────────────────────────────────────────

export function SyncList({ jobs, focusedJobId, onFocus, onDismiss, onNew, hasDraft, draftName }: {
  jobs: PublicJob[]; focusedJobId: string | null; onFocus: (id: string | null) => void; onDismiss: (id: string) => void; onNew: () => void; hasDraft: boolean; draftName: string;
}) {
  const active = jobs.filter(isActive);
  const finished = jobs.filter((j) => !isActive(j));
  const row = (j: PublicJob) => {
    const progress = isActive(j) ? progressOf(j) : null;
    return (
      <div key={j.id} className="ss-sync-row">
        <button type="button" onClick={() => onFocus(j.id)} aria-current={j.id === focusedJobId ? "true" : undefined} className="ss-sync-item">
          <span className="ss-sync-dot" style={{ background: DOT[j.status] }} />
          <span className="min-w-0 flex-1">
            <span className="ss-sync-name">{j.documentName}</span>
            <span className="ss-sync-line">{sheetStatus(j)}</span>
            {progress != null && <span className="ss-progress mt-1.5 block" aria-hidden="true"><span className="block h-full bg-[var(--ss-blue)]" style={{ width: `${progress}%`, transition: "width 600ms" }} /></span>}
          </span>
        </button>
        <Menu align="end" label={`More for ${j.documentName}`} trigger={
          <button type="button" className="ss-icon-btn ss-sync-more" aria-label={`More for ${j.documentName}`} title="More"><span aria-hidden="true">⋮</span></button>
        }>
          <MenuItem icon={<ExternalLink className="h-[18px] w-[18px]" />} onSelect={() => window.open(sheetUrl(j.documentId), "_blank", "noopener")}>Open in Google Sheets</MenuItem>
          {!isActive(j) && <MenuItem onSelect={() => onDismiss(j.id)}>Remove from list</MenuItem>}
        </Menu>
      </div>
    );
  };
  return (
    <nav className="sx-rail ss-sidebar" aria-label="Spreadsheet syncs">
      <h2 className="ss-side-heading">Spreadsheet syncs</h2>
      <button type="button" className="ss-doc-tab ss-new-doc" onClick={onNew} aria-current={focusedJobId == null && hasDraft ? "page" : undefined}>
        <span className="ss-doc-tab-icon">{hasDraft ? <Table2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> : <Upload className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />}</span>
        <span className="ss-doc-tab-label">{hasDraft ? draftName || "Workbook" : "Upload workbook"}</span>
      </button>
      {active.length > 0 && <div className="ss-side-label">In progress</div>}
      {active.map(row)}
      {finished.length > 0 && <div className="ss-side-label">Earlier</div>}
      {finished.map(row)}
      {jobs.length === 0 && <p className="ss-side-empty">Spreadsheet syncs you start show up here. They keep running after you close this tab.</p>}
    </nav>
  );
}

// ── Before a sync: the workbook, its settings and how it will be built ─────

export function DraftPanel(p: {
  workbook: Workbook | null; stats: WorkbookStats | null; plan: SheetPlan | null; settings: SheetSettings; onSettings: (s: SheetSettings) => void;
  step: number | null; playing: boolean; onTogglePlay: () => void; onScrub: (to: number | null) => void; onJump: (s: PlanSection) => void;
  onPick: () => void; reading: boolean; fileError: string | null; startError: string | null; busy: boolean;
}) {
  const { workbook, stats, plan, settings } = p;
  const times = React.useMemo(() => (plan ? stepTimes(plan) : []), [plan]);
  if (!workbook || !plan || !stats) {
    return (
      <div className="flex flex-col gap-3 px-5 pt-4">
        <h2 className="text-[16px] font-medium leading-6">Sync settings</h2>
        <p className="text-[14px] leading-5 text-[var(--ss-text-2)]">Upload a workbook to see how long its sync takes and the order it is built in.</p>
        <ul className="sx-carries">
          <li>Values and formulas, each formula written only once the cells it reads are in</li>
          <li>Fonts, sizes, colours, fills, borders, number formats, alignment and wrapping</li>
          <li>Merged cells, column widths, row heights, frozen panes, hidden rows and columns</li>
          <li>Every sheet of the workbook, notes, links, dropdowns, conditional formatting</li>
        </ul>
      </div>
    );
  }
  const startAt = Date.now() + settings.startInMinutes * 60_000;
  const shown = p.step ?? plan.steps.length;
  const away = plan.steps.filter((s) => s.k === "pause").length;
  const breakOf = (section: number) => settings.breaks.find((b) => b.section === section);
  const setBreak = (section: number, minutes: number | null) => p.onSettings({ ...settings, breaks: [...settings.breaks.filter((b) => b.section !== section), ...(minutes ? [{ section, minutes }] : [])].sort((a, b) => a.section - b.section) });
  const current = p.step != null && p.step > 0 ? plan.steps[p.step - 1] : null;
  return (
    <div className="flex flex-col gap-4 px-5 pt-4">
      <h2 className="text-[16px] font-medium leading-6">Sync settings</h2>

      <section className="sx-file-card">
        <span className="sx-file-icon"><FileSpreadsheet className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium leading-5">{workbook.name}</div>
          <div className="text-[12px] leading-4 text-[var(--ss-text-2)]" data-testid="sx-stats">
            {stats.sheets} {stats.sheets === 1 ? "sheet" : "sheets"} · {stats.cells.toLocaleString()} {stats.cells === 1 ? "cell" : "cells"} · {stats.formulas.toLocaleString()} {stats.formulas === 1 ? "formula" : "formulas"}
          </div>
        </div>
        <button type="button" className="ss-link-btn text-[13px]" onClick={p.onPick} disabled={p.reading}>Replace</button>
      </section>
      {p.fileError && <p role="alert" className="rounded-lg bg-[#fce8e6] p-3 text-[13px] leading-5 text-[#8c1d18]">{p.fileError}</p>}
      {workbook.warnings.length > 0 && (
        <div className="rounded-lg bg-[#fef7e0] px-3 py-2 text-[13px] leading-5 text-[#5c4300]" data-testid="sx-warnings">
          {workbook.warnings.map((w) => <p key={w} className="py-0.5">{w}</p>)}
        </div>
      )}

      <div>
        <label className="ss-field-label" htmlFor="sx-duration">Total time</label>
        <select id="sx-duration" className="ss-select" disabled={p.busy} value={settings.targetMinutes ?? ""} onChange={(e) => p.onSettings({ ...settings, targetMinutes: e.target.value === "" ? null : Number(e.target.value) })}>
          {DURATION_OPTIONS.map((m) => <option key={m ?? "auto"} value={m ?? ""}>{m == null ? "Natural pace" : formatSpan(m)}</option>)}
        </select>
        <p className="ss-field-help">
          {settings.targetMinutes == null ? "Typed and formatted at a person's pace, with a pause before each new section."
            : plan.totalMs > plan.naturalMs + 60_000 ? "The rest of the time is spent away from the sheet, between sections."
            : "The pauses to think get shorter or longer to fit."}
        </p>
      </div>
      <div>
        <label className="ss-field-label" htmlFor="sx-start">Start</label>
        <select id="sx-start" className="ss-select" disabled={p.busy} value={settings.startInMinutes} onChange={(e) => p.onSettings({ ...settings, startInMinutes: Number(e.target.value) })}>
          {START_OPTIONS.map((m) => <option key={m} value={m}>{m === 0 ? "Right away" : `In ${formatSpan(m)}`}</option>)}
        </select>
        <p className="ss-field-help">{settings.startInMinutes === 0 ? "Runs on our server, so you can close this tab." : `Starts at ${formatClock(startAt)}, even if this tab is closed.`}</p>
      </div>
      {p.startError && <p role="alert" className="rounded-lg bg-[#fce8e6] p-3 text-[13px] leading-5 text-[#8c1d18]">{p.startError}</p>}

      <section className="rounded-xl bg-[var(--ss-soft)] p-4" aria-live="polite">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[22px] leading-7" data-testid="sx-total">{formatSpan(plan.totalMs / 60_000)}</div>
            <div className="text-[14px] text-[var(--ss-text-2)]">Finishes around {formatClock(startAt + plan.totalMs)}</div>
          </div>
          <button className="ss-icon-btn h-9 w-9 rounded-full" onClick={() => p.onSettings({ ...settings, seed: Math.floor(Math.random() * 0xffffffff) >>> 0 })} disabled={p.busy} title="Try a different schedule" aria-label="Try a different schedule">
            <Shuffle className="h-[18px] w-[18px]" />
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2">
          {([["Steps", plan.steps.length - away], ["Formulas", stats.formulas], [settings.breaks.length ? "Breaks" : "Times away", away]] as const).map(([label, value]) => (
            <div key={label} className="flex flex-col-reverse">
              <dt className="text-[12px] leading-4 text-[var(--ss-text-2)]">{label}</dt>
              <dd className="text-[16px] leading-6 tabular-nums">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        {!plan.fitsTarget && (
          <p className="mt-3 rounded-lg bg-[#fef7e0] px-3 py-2 text-[13px] leading-5 text-[#5c4300]">
            This workbook can&apos;t be built faster than {formatSpan(plan.minMs / 60_000)}: Google Sheets takes one edit a second at most.
          </p>
        )}
      </section>

      <section aria-label="Build order">
        <div className="flex items-center justify-between">
          <h3 className="ss-field-label mb-0" title="Sections in the order they are built. The cup adds a break before one.">How it will be built</h3>
          <button type="button" className="ss-btn ss-btn-text h-8" onClick={p.onTogglePlay} aria-pressed={p.playing} data-testid="sx-play">
            {p.playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
            {p.playing ? "Pause" : "Play"}
          </button>
        </div>
        <input type="range" className="sx-scrub" min={0} max={plan.steps.length} value={shown} aria-label="Step of the build" data-testid="sx-scrub"
          onChange={(e) => { const v = Number(e.target.value); p.onScrub(v >= plan.steps.length ? null : v); }} />
        <p className="ss-field-help mt-1" data-testid="sx-step">
          {p.step == null ? "The finished sheet. Drag to see it at any point of the sync."
            : p.step === 0 ? "Before the first step: an empty Google Sheet."
            : `Step ${p.step.toLocaleString()} of ${plan.steps.length.toLocaleString()}, ${formatSpan(times[p.step] / 60_000)} in: ${current ? stepLabel(workbook, current) : ""}`}
        </p>
        <ol className="sx-sections">
          {plan.sections.map((s, i) => {
            const end = i + 1 < plan.sections.length ? plan.sections[i + 1].at : plan.steps.length;
            const on = p.step != null && p.step > s.at && p.step <= end;
            const pause = breakOf(i);
            return (
              <li key={`${s.sheet}-${s.at}`}>
                {pause && (
                  <div className="sx-break" data-testid="sx-break">
                    <span className="sx-break-dot" aria-hidden="true" />
                    <label className="sr-only" htmlFor={`sx-break-${i}`}>Break before section {i + 1}</label>
                    <span>Break</span>
                    <select id={`sx-break-${i}`} className="sx-break-select" disabled={p.busy} value={pause.minutes} onChange={(e) => setBreak(i, Number(e.target.value))}>
                      {(BREAK_OPTIONS.includes(pause.minutes) ? BREAK_OPTIONS : [...BREAK_OPTIONS, pause.minutes].sort((a, b) => a - b)).map((m) => <option key={m} value={m}>{formatSpan(m)}</option>)}
                    </select>
                    <button type="button" className="sx-break-x" onClick={() => setBreak(i, null)} disabled={p.busy} aria-label={`Remove the break before section ${i + 1}`} title="Remove this break">×</button>
                  </div>
                )}
                <div className="sx-section-row">
                  <button type="button" className="sx-section" aria-current={on ? "step" : undefined} onClick={() => p.onJump(s)} title="Show the sheet as this section starts">
                    <span className="sx-section-n">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{sectionName(workbook, s)}</span>
                    <span className="sx-section-t">{formatSpan(times[s.at] / 60_000)}</span>
                  </button>
                  {i > 0 && !pause && (
                    <button type="button" className="sx-break-add" onClick={() => setBreak(i, 15)} disabled={p.busy} aria-label={`Add a break before section ${i + 1}`} title="Take a break before this section">
                      <Coffee className="h-[14px] w-[14px]" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
      <div className="h-2" />
    </div>
  );
}

// ── A running or finished sync ─────────────────────────────────────────────

const TITLE: Record<PublicJob["status"], string> = { scheduled: "Scheduled", pending: "Starting", running: "Building the sheet", paused: "Paused", done: "Finished", error: "Stopped", cancelled: "Cancelled" };

export function JobPanel({ job, now, steps, sections, workbook, onPause, onResume, onCancel, onDismiss }: {
  job: PublicJob; now: number; steps: Step[] | null; sections: PlanSection[] | null; workbook: Workbook | null;
  onPause: () => void; onResume: () => void; onCancel: () => void; onDismiss: () => void;
}) {
  const active = isActive(job);
  const pct = Math.round(job.status === "done" ? 100 : progressOf(job));
  const away = job.status === "running" && /^(Away|On a break)/.test(job.activity);
  const left = job.etaTargetAt != null ? Math.max(0, job.etaTargetAt - now) : null;
  const current = sections ? sections.reduce((best, s, i) => (s.at <= Math.max(0, job.currentAction - 1) ? i : best), -1) : -1;
  return (
    <div className="flex flex-col gap-4 px-5 pt-4">
      <h2 className="text-[16px] font-medium leading-6" data-testid="sx-job-title">{away ? (/^On a break/.test(job.activity) ? "On a break" : "Away from the sheet") : TITLE[job.status]}</h2>
      <section className="rounded-xl bg-[var(--ss-soft)] p-4" aria-live="polite">
        <div className="flex items-baseline justify-between">
          <div className="text-[22px] leading-7 tabular-nums">{pct}%</div>
          <div className="text-[13px] text-[var(--ss-text-2)] tabular-nums">Step {Math.min(job.currentAction, job.totalActions).toLocaleString()} of {job.totalActions.toLocaleString()}</div>
        </div>
        <div className="ss-progress mt-2" aria-hidden="true"><div style={{ width: `${pct}%`, transition: "width 600ms" }} /></div>
        <p className="mt-3 text-[14px] leading-5">
          {job.status === "running" ? job.activity
            : job.status === "scheduled" ? `Starts at ${formatClock(job.startAt)}`
            : job.status === "done" ? `Finished at ${job.finishedAt ? formatClock(job.finishedAt) : ""}`
            : job.status === "paused" ? job.error ?? "Paused. Resume to carry on from here."
            : job.status === "error" ? job.error ?? "Something went wrong."
            : job.status === "cancelled" ? "Cancelled. What was built stays in the Google Sheet."
            : "Starting"}
        </p>
        {active && job.status !== "paused" && left != null && (
          <p className="mt-1 text-[13px] text-[var(--ss-text-2)]">{job.status === "scheduled" ? "Takes" : "About"} {formatCountdown(left)}{job.status === "scheduled" ? "" : " left"}{job.etaTargetAt ? `, done around ${formatClock(job.etaTargetAt)}` : ""}</p>
        )}
      </section>

      {job.refused && job.refused.count > 0 && (
        <div className="rounded-lg bg-[#fef7e0] px-3 py-2 text-[13px] leading-5 text-[#5c4300]" data-testid="sx-refused">
          <p>Google Sheets refused {job.refused.count} {job.refused.count === 1 ? "edit" : "edits"}. {job.refused.count === 1 ? "It was" : "They were"} left out and the sync went on:</p>
          <ul className="mt-1 list-disc pl-4">{job.refused.notes.map((n) => <li key={n} className="break-words">{n}</li>)}</ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <a className="ss-btn ss-btn-outlined" href={sheetUrl(job.documentId)} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="h-[18px] w-[18px]" aria-hidden="true" />
          Open in Google Sheets
        </a>
        {(job.status === "running" || job.status === "pending" || job.status === "scheduled") && <button type="button" className="ss-btn ss-btn-outlined" onClick={onPause}>Pause</button>}
        {job.status === "paused" && <button type="button" className="ss-btn ss-btn-tonal" onClick={onResume}>Resume</button>}
        {active && <button type="button" className="ss-btn ss-btn-danger" onClick={onCancel}>Cancel</button>}
        {!active && <button type="button" className="ss-btn ss-btn-text" onClick={onDismiss}>Remove from list</button>}
      </div>
      <p className="ss-field-help -mt-1">
        {active ? "It runs on our server: close this tab and it keeps going. In Google Sheets, File > Version history shows it being built."
          : job.status === "done" ? "In Google Sheets, File > Version history shows how it was built." : ""}
      </p>

      {sections && sections.length > 0 && (
        <section aria-label="Sections">
          <h3 className="ss-field-label">Sections</h3>
          <ol className="sx-sections">
            {sections.map((s, i) => {
              const state = job.status === "done" || i < current ? "done" : i === current && active ? "now" : "ahead";
              return (
                <li key={`${s.sheet}-${s.at}`}>
                  <div className="sx-section" data-state={state} aria-current={state === "now" ? "step" : undefined}>
                    <span className="sx-section-n">{state === "done" ? "✓" : i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{sectionName(workbook, s)}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {steps && job.status === "running" && job.currentAction < steps.length && workbook && (
        <p className="ss-field-help">Next: {stepLabel(workbook, steps[job.currentAction])}</p>
      )}
      <div className="h-2" />
    </div>
  );
}
