"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import { ExternalLink, FileSpreadsheet, Upload } from "lucide-react";
import type { PublicJob } from "@/lib/sync-store";
import { cellName, typedText, workbookStats, type Workbook } from "@/lib/sheets/model";
import { isOldExcel, readXlsx, XlsxError } from "@/lib/sheets/xlsx";
import { CompareKind } from "../compare/kind-switch";
import { buildSheetPlan, type SheetPlan } from "@/lib/sheets/plan";
import { activeSheet, buildTimeline, finalView, viewAt, type Timeline } from "@/lib/sheets/timeline";
import type { PlanSection } from "@/lib/sheets/order";
import type { Step } from "@/lib/sheets/steps";
import { randomSeed } from "@/lib/prng";
import { AccountMenu, type HeaderUser } from "../workspace/header";
import { SectionSwitch } from "../compare/section-switch";
import { Snackbar, useSnack } from "../workspace/snack";
import { postJson } from "../workspace/api";
import { isActive, statusLine } from "../workspace/job-status";
import { loadFonts } from "../workspace/web-fonts";
import { SheetGrid, type GridSelection } from "./sheet-grid";
import { workbookFonts } from "./display";
import { DraftPanel, JobPanel, SyncList, type SheetSettings } from "./sheet-panels";
import { clearDraft, loadDraft, saveDraft } from "./draft";

/** What a running sync is building, as /api/sheets/source gives it */
interface JobSource { workbook: Workbook; steps: Step[]; sections: PlanSection[]; delays: number[]; totalMs: number; timeline: Timeline; baseline?: true }

/** A Google Sheet a Compare & Sync can write to: one SyncStream made */
export interface CompareTarget { id: string; name: string }

export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const ACCEPT = ".xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

/**
 * An old .xls workbook as the .xlsx Google Sheets makes of it (POST /api/sheets/import): Google
 * converts the file in the person's own Drive, and the page reads what it became.
 */
async function convertOldExcel(bytes: Uint8Array, fileName: string): Promise<Uint8Array> {
  const res = await fetch(`/api/sheets/import?name=${encodeURIComponent(fileName)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes as BodyInit });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new XlsxError("oldExcel", data.error || "This older Excel file couldn't be converted just now. Try again, or save it as .xlsx and upload that.");
  }
  return new Uint8Array(await res.arrayBuffer());
}
/** The build preview plays the whole sync in about this long */
const PLAY_MS = 40_000;
const PLAY_TICK_MS = 80;

export function SheetsWorkspace({ user, onSignOut, onReauth, compare = false }: { user: HeaderUser | null; onSignOut: () => void; onReauth: () => void; compare?: boolean }) {
  const [snack, setSnack] = useSnack();
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [name, setName] = useState("");
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [settings, setSettings] = useState<SheetSettings>({ targetMinutes: null, startInMinutes: 0, seed: 1, breaks: [] });
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState<GridSelection | null>({ r: 0, c: 0 });
  /** The build preview: how many steps are shown done (null: all of them) */
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [ready, setReady] = useState(false);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, JobSource | "missing">>({});
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [converting, setConverting] = useState(false);

  // ── Compare & Sync: the Google Sheet to bring up to the workbook, and what it holds now ──
  const [targets, setTargets] = useState<CompareTarget[]>([]);
  const [target, setTarget] = useState<CompareTarget | null>(null);
  const [have, setHave] = useState<Workbook | null>(null);
  const [haveBusy, setHaveBusy] = useState(false);
  const [haveError, setHaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!compare) return;
    let cancelled = false;
    // The spreadsheets SyncStream made are the ones it may write to: its history lists them
    fetch("/api/history").then((res) => (res.ok ? res.json() : null)).then((data: { entries?: { kind: string; documentId: string; documentName: string; status: string }[] } | null) => {
      if (cancelled || !data?.entries) return;
      const seen = new Set<string>();
      setTargets(data.entries.filter((e) => e.kind === "sheet" && e.documentId && !seen.has(e.documentId) && !!seen.add(e.documentId)).map((e) => ({ id: e.documentId, name: e.documentName })));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [compare]);
  const pickTarget = useCallback(async (next: CompareTarget | null) => {
    setTarget(next);
    setHave(null);
    setHaveError(null);
    if (!next) return;
    setHaveBusy(true);
    try {
      const res = await fetch(`/api/sheets/export?id=${encodeURIComponent(next.id)}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "The spreadsheet couldn't be read just now. Try again.");
      setHave(await readXlsx(new Uint8Array(await res.arrayBuffer()), `${next.name}.xlsx`));
      setStep(null);
      setSettings((st) => ({ ...st, breaks: [] }));
    } catch (err) {
      setHaveError(err instanceof Error ? err.message : "The spreadsheet couldn't be read.");
      setTarget(null);
    } finally {
      setHaveBusy(false);
    }
  }, []);

  // ── The workbook ──
  const openFile = useCallback(async (file: File) => {
    setFileError(null);
    setReading(true);
    try {
      let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
      let fileName = file.name;
      // An .xls is converted by Google Sheets itself; what it makes of the file is what is shown and synced
      if (isOldExcel(bytes) && /\.xl[st]$/i.test(fileName)) {
        setConverting(true);
        bytes = await convertOldExcel(bytes, fileName);
        fileName = fileName.replace(/\.xl[st]$/i, ".xlsx");
      }
      const wb = await readXlsx(bytes, fileName);
      setWorkbook(wb);
      setName(wb.name);
      setTab(Math.max(0, wb.sheets.findIndex((s) => !s.hidden)));
      setSelected({ r: 0, c: 0 });
      setStep(null);
      setPlaying(false);
      setFocusedJobId(null);
      setStartError(null);
      setSettings((s) => ({ ...s, seed: randomSeed(), breaks: [] }));
    } catch (err) {
      setFileError(err instanceof XlsxError ? err.message : "This file couldn't be read as an Excel workbook.");
    } finally {
      setReading(false);
      setConverting(false);
    }
  }, []);
  const pickFile = useCallback(() => fileInput.current?.click(), []);

  // The workbook being prepared survives a reload, on this device
  const draftLoaded = useRef(false);
  useEffect(() => {
    const draft = loadDraft();
    if (draft) { setWorkbook(draft.workbook); setName(draft.name); setSettings((s) => ({ ...s, ...draft.settings })); setTab(Math.max(0, draft.workbook.sheets.findIndex((sh) => !sh.hidden))); }
    else setSettings((s) => ({ ...s, seed: randomSeed() }));
    draftLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!draftLoaded.current) return;
    const id = setTimeout(() => { if (workbook) saveDraft({ workbook, name, settings }); else clearDraft(); }, 400);
    return () => clearTimeout(id);
  }, [workbook, name, settings]);

  const plan = useMemo<SheetPlan | null>(() => (workbook && (!compare || have) ? buildSheetPlan(workbook, { targetMinutes: settings.targetMinutes, seed: settings.seed, breaks: settings.breaks, ...(compare && have ? { have } : {}) }) : null), [workbook, compare, have, settings.targetMinutes, settings.seed, settings.breaks]);
  const timeline = useMemo(() => (workbook && plan ? buildTimeline(workbook, plan.steps, compare) : null), [workbook, plan, compare]);
  useEffect(() => { if (workbook) loadFonts(workbookFonts(workbook)); }, [workbook]);

  // ── Syncs ──
  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/list");
      if (!res.ok) return undefined;
      const data = (await res.json()) as { jobs: PublicJob[] };
      const mine = data.jobs.filter((j) => j.kind === "sheet");
      setJobs(mine);
      return mine;
    } catch { return undefined; }
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetchJobs().then((list) => {
      if (cancelled) return;
      // A link to one sync (from the history) opens it; otherwise a running one shows, as in the editor
      const asked = new URLSearchParams(window.location.search).get("job");
      const open = list?.find((j) => j.id === asked) ?? (loadDraft() ? undefined : list?.find(isActive));
      if (open) setFocusedJobId(open.id);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [fetchJobs]);
  const anyActive = jobs.some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(fetchJobs, 2500);
    return () => clearInterval(id);
  }, [anyActive, fetchJobs]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyActive]);

  const focusedJob = jobs.find((j) => j.id === focusedJobId) ?? null;
  const source = focusedJob ? sources[focusedJob.id] : undefined;
  useEffect(() => {
    if (!focusedJob || sources[focusedJob.id]) return;
    const id = focusedJob.id;
    let cancelled = false;
    fetch(`/api/sheets/source?jobId=${encodeURIComponent(id)}`).then(async (res) => {
      if (cancelled) return;
      if (!res.ok) { setSources((s) => ({ ...s, [id]: "missing" })); return; }
      const data = (await res.json()) as Omit<JobSource, "timeline">;
      loadFonts(workbookFonts(data.workbook));
      setSources((s) => ({ ...s, [id]: { ...data, timeline: buildTimeline(data.workbook, data.steps, !!data.baseline) } }));
    }).catch(() => { if (!cancelled) setSources((s) => ({ ...s, [id]: "missing" })); });
    return () => { cancelled = true; };
  }, [focusedJob, sources]);

  const startSync = useCallback(async () => {
    if (!workbook || !plan || busy || (compare && (!target || !have))) return;
    setBusy(true);
    setStartError(null);
    const timeZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
    const { ok, status, data } = await postJson<{ job?: PublicJob }>("/api/sheets/start", { workbook, name: name.trim() || workbook.name, targetMinutes: settings.targetMinutes, seed: plan.seed, startInMinutes: settings.startInMinutes, timeZone, breaks: settings.breaks, ...(compare && target && have ? { target: target.id, have } : {}) });
    setBusy(false);
    if (!ok || !data.job) {
      setStartError(status === 401 ? "Your Google sign-in expired. Reconnect your Google account from the account menu, then start again." : data.error ?? "Couldn't start the sync. Try again.");
      return;
    }
    const job = data.job;
    setJobs((list) => [job, ...list.filter((j) => j.id !== job.id)]);
    setSources((s) => ({ ...s, [job.id]: { workbook, steps: plan.steps, sections: plan.sections, delays: plan.actions.map((a) => a.delayMs), totalMs: plan.totalMs, timeline: timeline ?? buildTimeline(workbook, plan.steps, compare), ...(compare ? { baseline: true as const } : {}) } }));
    setFocusedJobId(job.id);
    setPlaying(false);
    setStep(null);
    // The next sync of this workbook gets a schedule of its own
    setSettings((s) => ({ ...s, startInMinutes: 0, seed: randomSeed() }));
    setSnack(settings.startInMinutes > 0 ? "Sync scheduled. It runs on our server, so you can close this tab." : compare ? "Sync started: the missing parts are being typed into your spreadsheet. It keeps going if you close this tab." : "Sync started in a new Google Sheet. It keeps going if you close this tab.");
  }, [workbook, plan, timeline, busy, name, settings, setSnack, compare, target, have]);

  const jobAction = useCallback(async (action: "pause" | "resume" | "cancel", jobId: string) => {
    const { ok, data } = await postJson<{ job?: PublicJob }>(`/api/sync/${action}`, { jobId });
    if (ok && data.job) setJobs((list) => list.map((j) => (j.id === jobId ? data.job! : j)));
    else setSnack(data.error ?? "That didn't work. Try again.");
    void fetchJobs();
  }, [fetchJobs, setSnack]);
  const dismissJob = useCallback(async (jobId: string) => {
    setJobs((list) => list.filter((j) => j.id !== jobId));
    if (focusedJobId === jobId) setFocusedJobId(null);
    await postJson("/api/sync/dismiss", { jobId });
  }, [focusedJobId]);

  // ── What is on the page ──
  const live = focusedJob && source && source !== "missing" ? source : null;
  const shownBook = focusedJob ? live?.workbook ?? null : workbook;
  const shownTimeline = focusedJob ? live?.timeline ?? null : timeline;
  const done = focusedJob ? (focusedJob.status === "done" ? Infinity : focusedJob.currentAction) : step ?? Infinity;
  const following = focusedJob ? isActive(focusedJob) : step != null;
  // The tab follows the sync while it is being followed
  const followedTab = shownTimeline && following ? activeSheet(shownTimeline, Math.min(done, shownTimeline.steps)) : null;
  useEffect(() => { if (followedTab != null) setTab(followedTab); }, [followedTab]);
  const safeTab = shownBook ? Math.min(tab, shownBook.sheets.length - 1) : 0;
  const view = useMemo(() => {
    if (!shownBook) return null;
    return shownTimeline && done < shownTimeline.steps ? viewAt(shownBook, shownTimeline, done, safeTab) : finalView(shownBook, safeTab);
  }, [shownBook, shownTimeline, done, safeTab]);
  const tabs = useMemo(() => {
    if (!shownBook) return [];
    return shownBook.sheets.map((s, i) => {
      const v = shownTimeline && done < shownTimeline.steps ? viewAt(shownBook, shownTimeline, done, i) : null;
      return { index: i, name: s.name, exists: v ? v.exists : true, hidden: v ? v.hidden : !!s.hidden, color: v ? v.tabColor : s.tabColor };
    });
  }, [shownBook, shownTimeline, done]);

  // The preview plays the build, start to finish
  useEffect(() => {
    if (!playing || !plan) return;
    const per = Math.max(1, Math.ceil(plan.steps.length / (PLAY_MS / PLAY_TICK_MS)));
    const id = setInterval(() => {
      setStep((s) => {
        const next = (s ?? 0) + per;
        if (next >= plan.steps.length) { setPlaying(false); return null; }
        return next;
      });
    }, PLAY_TICK_MS);
    return () => clearInterval(id);
  }, [playing, plan]);
  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p) setStep((s) => (s == null ? 0 : s));
      return !p;
    });
  }, []);
  const scrub = useCallback((to: number | null) => { setPlaying(false); setStep(to); }, []);

  // The cell picked, for the formula bar
  const selectedCell = useMemo(() => {
    if (!view || !selected) return null;
    const i = view.sheet.cells.findIndex((c) => c.r === selected.r && c.c === selected.c);
    return i >= 0 && view.typed(i) ? view.sheet.cells[i] : null;
  }, [view, selected]);
  const formulaText = selectedCell ? typedText(selectedCell) : "";

  const tabTitle = focusedJob?.documentName ?? (workbook ? name || workbook.name : null);
  useEffect(() => { document.title = tabTitle ? `${tabTitle} - SyncStream` : "Sheets - SyncStream"; }, [tabTitle]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void openFile(file);
  };

  if (!ready) {
    return (
      <div className="ss-workspace items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#d3e3fd] border-t-[#0b57d0]" role="status" aria-label="Loading" />
      </div>
    );
  }

  const stats = workbook ? workbookStats(workbook) : null;
  const status = focusedJob
    ? statusLine(focusedJob).replace(/^Typing/, "Building").replace(/typed$/, "built")
    : converting ? "Google Sheets is converting this .xls file"
    : reading ? "Reading the workbook"
    : workbook && compare ? (haveBusy ? "Reading your spreadsheet" : target && have ? `What "${target.name}" is missing is typed into it when the sync starts` : "Pick the Google Sheet to bring up to this reference")
    : workbook ? "A new Google Sheet is made for it when the sync starts"
    : compare ? "Upload the reference workbook, then pick the Google Sheet to bring up to it"
    : "Upload an Excel workbook to sync it into a new Google Sheet";
  const canStart = !!workbook && !!plan && !busy && !reading && (!compare || (!!target && !!have && plan.steps.length > 0));

  return (
    <MotionConfig reducedMotion="user">
      <div className="ss-workspace ss-icons-ready sx-workspace" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop}>
        <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" aria-label="Excel workbook" data-testid="sx-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openFile(f); }} />
        <header className="ss-header">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sync-icon.png" alt="" className="ss-header-logo" />
          <div className="ss-header-main">
            <div className="ss-title-row">
              {focusedJob ? (
                <span className="ss-title ss-title-static"><span className="truncate">{focusedJob.documentName}</span></span>
              ) : compare ? (
                <><h1 className="ss-title ss-title-static"><span className="truncate">Compare &amp; Sync</span></h1><CompareKind active="sheets" /></>
              ) : workbook ? (
                <input className="sx-title-input" value={name} aria-label="Name of the new Google Sheet" title="The new Google Sheet's name" maxLength={200} onChange={(e) => setName(e.target.value)} onBlur={() => { if (!name.trim()) setName(workbook.name); }} />
              ) : (
                <span className="ss-title ss-title-static"><span className="truncate">Sheets</span></span>
              )}
              <div className="ss-badges">
                {focusedJob && (
                  <a href={sheetUrl(focusedJob.documentId)} target="_blank" rel="noopener noreferrer" className="ss-badge" title="Open in Google Sheets" aria-label="Open in Google Sheets">
                    <ExternalLink className="h-[18px] w-[18px]" aria-hidden="true" />
                  </a>
                )}
              </div>
            </div>
            <div className="sx-status" data-ss-status title={status}>{status}</div>
          </div>
          <div className="ss-header-actions">
            <SectionSwitch active={compare ? "compare" : "sheets"} />
            {!focusedJob && workbook && (
              <button className="ss-btn ss-btn-outlined ss-shrink-md" onClick={pickFile} disabled={reading} title="Upload another workbook" aria-label="Upload another workbook">
                <Upload className="h-[18px] w-[18px]" aria-hidden="true" />
                <span className="ss-shrink-label">Replace file</span>
              </button>
            )}
            {focusedJob ? (
              <button className="ss-btn ss-btn-outlined" onClick={() => setFocusedJobId(null)}>{workbook ? "Back to the workbook" : "New sync"}</button>
            ) : (
              <button className="ss-btn ss-btn-tonal" onClick={() => { void startSync(); }} disabled={!canStart} title={!workbook ? "Upload a workbook first" : undefined}>
                {busy ? "Starting" : settings.startInMinutes > 0 ? "Schedule sync" : "Start sync"}
              </button>
            )}
            <AccountMenu user={user} onReauth={onReauth} onSignOut={onSignOut} />
          </div>
        </header>

        <div className="sx-formula-bar ss-noprint">
          <div className="sx-namebox" aria-label="Selected cell">{view && selected ? cellName(selected.r, selected.c) : ""}</div>
          <div className="sx-fx" aria-hidden="true">fx</div>
          <div className="sx-formula" data-testid="sx-formula" aria-label="Cell contents" title={formulaText}>{formulaText}</div>
        </div>

        <div className="sx-main">
          <SyncList jobs={jobs} focusedJobId={focusedJobId} onFocus={setFocusedJobId} onDismiss={(id) => { void dismissJob(id); }} onNew={() => { setFocusedJobId(null); if (!workbook) pickFile(); }} hasDraft={!!workbook} draftName={name || workbook?.name || ""} />

          <main className="sx-stage" aria-busy={reading || undefined}>
            {view && shownBook ? (
              <>
                <SheetGrid key={`${focusedJob?.id ?? "draft"}-${safeTab}`} wb={shownBook} view={view} pending={!focusedJob && compare ? plan?.compare?.typed[safeTab] : undefined} selected={selected} onSelect={setSelected} follow={following} label={`${shownBook.sheets[safeTab].name} sheet`} />
                <div className="sx-tabbar" role="tablist" aria-label="Sheets">
                  {tabs.filter((t) => t.exists).map((t) => (
                    <button key={t.index} type="button" role="tab" aria-selected={t.index === safeTab} className="sx-sheet-tab" data-hidden={t.hidden || undefined} onClick={() => { setTab(t.index); setSelected({ r: 0, c: 0 }); }} title={t.hidden ? `${t.name} (hidden)` : t.name}>
                      {t.color && <span className="sx-tab-color" style={{ background: t.color.startsWith("theme:") ? shownBook.theme?.[t.color.slice(6) as keyof NonNullable<Workbook["theme"]>] : t.color }} />}
                      <span className="truncate">{t.name}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : focusedJob ? (
              <div className="sx-empty">
                {source === "missing"
                  ? <p className="sx-empty-text">This sync&apos;s spreadsheet is no longer kept here. It is in your Drive: open it in Google Sheets.</p>
                  : <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#d3e3fd] border-t-[#0b57d0]" role="status" aria-label="Loading" />}
              </div>
            ) : (
              <div className="sx-empty">
                <div className="sx-upload" data-dragging={dragging || undefined}>
                  <span className="sx-upload-icon"><FileSpreadsheet className="h-8 w-8" strokeWidth={1.5} aria-hidden="true" /></span>
                  <h1 className="sx-upload-title">{compare ? "Bring a spreadsheet up to date" : "Sync an Excel workbook into Google Sheets"}</h1>
                  {compare && <p className="sx-upload-text">Upload the reference workbook, then pick the Google Sheet to update. SyncStream finds what the reference has and your spreadsheet doesn&apos;t, and types only that, the way a person would. Nothing only your spreadsheet has is removed.</p>}
                  <p className="sx-upload-text" hidden={compare}>Upload an Excel workbook (.xlsx, or an older .xls, which Google Sheets converts first). SyncStream shows it here exactly as it is, then builds it in a new Google Sheet the way a person would: labels, numbers and formulas in order, section by section, then the formatting.</p>
                  <button type="button" className="ss-btn ss-btn-filled" onClick={pickFile} disabled={reading}>
                    <Upload className="h-[18px] w-[18px]" aria-hidden="true" />
                    {converting ? "Converting" : reading ? "Reading" : "Upload workbook"}
                  </button>
                  <p className="sx-upload-hint">or drop the file anywhere on this page</p>
                  {fileError && <p role="alert" className="sx-upload-error">{fileError}</p>}
                </div>
              </div>
            )}
            {dragging && (view || focusedJob) && <div className="sx-drop-veil">Drop the workbook to open it</div>}
          </main>

          <aside className="sx-panel" aria-label={focusedJob ? "This sync" : "Sync settings"}>
            {focusedJob ? (
              <JobPanel job={focusedJob} now={now} steps={live?.steps ?? null} sections={live?.sections ?? null} workbook={live?.workbook ?? null}
                onPause={() => { void jobAction("pause", focusedJob.id); }} onResume={() => { void jobAction("resume", focusedJob.id); }} onCancel={() => { void jobAction("cancel", focusedJob.id); }} onDismiss={() => { void dismissJob(focusedJob.id); }} />
            ) : (
              <DraftPanel workbook={workbook} stats={stats} plan={plan} settings={settings} onSettings={setSettings} step={step} playing={playing} onTogglePlay={togglePlay} onScrub={scrub}
                onJump={(section) => { scrub(section.at + 1); setTab(section.sheet); }} onPick={pickFile} reading={reading} fileError={workbook ? fileError : null} startError={startError} busy={busy}
                compare={compare ? { targets, target, onTarget: (t: CompareTarget | null) => { void pickTarget(t); }, busy: haveBusy, error: haveError, ready: !!have } : undefined} />
            )}
          </aside>
        </div>
        <Snackbar snack={snack} onDismiss={() => setSnack(null)} />
      </div>
    </MotionConfig>
  );
}

