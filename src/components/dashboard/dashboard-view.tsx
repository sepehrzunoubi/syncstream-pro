"use client";

import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { HeroStatus } from "./hero-status";
import { SourceInput } from "./source-input";
import { SyncControls, type BreaksMode } from "./sync-controls";
import { JobList } from "./job-list";
import { buildDripPlan } from "@/lib/drip-engine";
import { randomSeed } from "@/lib/prng";
import type { PublicJob } from "@/lib/sync-store";
import { cn } from "@/lib/utils";
import { countWords, formatClock, formatCountdown, formatDuration } from "@/lib/format";

type Doc = { id: string; name: string; modifiedTime: string };

const DRAFT_KEY = "syncstream_draft";
const ACTIVE = new Set<PublicJob["status"]>(["scheduled", "pending", "running", "paused"]);
const isActive = (j: PublicJob) => ACTIVE.has(j.status);

interface Draft {
  sourceText?: string;
  selectedDocId?: string;
  durationMinutes?: number | null;
  breaksMode?: BreaksMode;
  customBreaks?: number[];
  typoFrequency?: number;
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : {};
  } catch {
    return {};
  }
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = {} as T & { error?: string };
  try { data = await res.json(); } catch { /* no body */ }
  return { ok: res.ok, status: res.status, data };
}

/** A ticking "now" while something is counting down. */
function useNow(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export function DashboardView() {
  // ── Documents ──
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreatingDoc, setIsCreatingDoc] = useState(false);
  const [scopeError, setScopeError] = useState(false);

  // ── Composer ──
  const [sourceText, setSourceText] = useState("");
  const [selectedDocId, setSelectedDocId] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [breaksMode, setBreaksMode] = useState<BreaksMode>("auto");
  const [customBreaks, setCustomBreaks] = useState<number[]>([]);
  const [typoFrequency, setTypoFrequency] = useState(0.5);
  const [startInMinutes, setStartInMinutes] = useState(0);
  const [seed, setSeed] = useState(() => randomSeed());
  const [draftLoaded, setDraftLoaded] = useState(false);

  // ── Jobs ──
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [composing, setComposing] = useState(true);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const focusedJob = !composing ? jobs.find((j) => j.id === focusedJobId) ?? null : null;
  const anyActive = jobs.some(isActive);
  const now = useNow(!!focusedJob && isActive(focusedJob));

  // ── Draft persistence ──
  useEffect(() => {
    const d = loadDraft();
    if (d.sourceText) setSourceText(d.sourceText);
    if (d.selectedDocId) setSelectedDocId(d.selectedDocId);
    if (d.durationMinutes !== undefined) setDurationMinutes(d.durationMinutes);
    if (d.breaksMode) setBreaksMode(d.breaksMode);
    if (Array.isArray(d.customBreaks)) setCustomBreaks(d.customBreaks);
    if (typeof d.typoFrequency === "number") setTypoFrequency(d.typoFrequency);
    setDraftLoaded(true);
  }, []);
  useEffect(() => {
    if (!draftLoaded) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ sourceText, selectedDocId, durationMinutes, breaksMode, customBreaks, typoFrequency } satisfies Draft));
    } catch { /* quota */ }
  }, [draftLoaded, sourceText, selectedDocId, durationMinutes, breaksMode, customBreaks, typoFrequency]);

  // ── Documents ──
  const fetchDocs = useCallback(async (refresh = false) => {
    if (refresh) setIsRefreshing(true);
    try {
      const res = await fetch("/api/docs");
      if (res.status === 401) { setScopeError(true); return; }
      if (!res.ok) throw new Error(`docs ${res.status}`);
      const data = await res.json();
      setDocs(data.docs || []);
      setSelectedDocId((cur) => (cur && data.docs?.some((d: Doc) => d.id === cur) ? cur : data.docs?.[0]?.id ?? ""));
    } catch (err) {
      console.error("Docs fetch error:", err);
    } finally {
      setDocsLoading(false);
      if (refresh) setIsRefreshing(false);
    }
  }, []);
  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const handleCreateDoc = useCallback(async () => {
    setIsCreatingDoc(true);
    try {
      const { ok, data } = await postJson<{ id: string; name: string }>("/api/docs/create", { title: "SyncStream Draft" });
      if (!ok) throw new Error(data.error || "Failed to create doc");
      setDocs((prev) => [{ id: data.id, name: data.name, modifiedTime: new Date().toISOString() }, ...prev]);
      setSelectedDocId(data.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create document");
    } finally {
      setIsCreatingDoc(false);
    }
  }, []);

  // ── Jobs: load, poll, restore ──
  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/list");
      if (!res.ok) return;
      const data = (await res.json()) as { jobs: PublicJob[] };
      setJobs(data.jobs);
      return data.jobs;
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchJobs().then((list) => {
      if (cancelled || !list) return;
      setJobsLoaded(true);
      const active = list.find(isActive);
      if (active) { setFocusedJobId(active.id); setComposing(false); }
    });
    return () => { cancelled = true; };
  }, [fetchJobs]);

  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(fetchJobs, 4000);
    const onVisible = () => { if (document.visibilityState === "visible") fetchJobs(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [anyActive, fetchJobs]);

  // Source text of the focused job, for the live preview
  useEffect(() => {
    if (!focusedJobId || sources[focusedJobId] !== undefined) return;
    let cancelled = false;
    fetch(`/api/sync/source?jobId=${focusedJobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.sourceText != null) setSources((s) => ({ ...s, [focusedJobId]: d.sourceText })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [focusedJobId, sources]);

  // ── Plan preview (same seed the server will use) ──
  const deferredText = useDeferredValue(sourceText);
  const preview = useMemo(() => {
    if (!deferredText.trim()) return null;
    return buildDripPlan(deferredText, {
      targetMinutes: durationMinutes,
      breaks: breaksMode === "auto" ? "auto" : breaksMode === "none" ? [] : customBreaks,
      typoFrequency,
      seed,
    });
  }, [deferredText, durationMinutes, breaksMode, customBreaks, typoFrequency, seed]);

  // ── Actions ──
  const updateJob = (job: PublicJob) => setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));

  const startSync = useCallback(async () => {
    if (!sourceText.trim() || !selectedDocId || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const doc = docs.find((d) => d.id === selectedDocId);
      const { ok, status, data } = await postJson<{ job: PublicJob }>("/api/sync/start", {
        text: sourceText,
        documentId: selectedDocId,
        documentName: doc?.name,
        targetMinutes: durationMinutes,
        breaks: breaksMode === "auto" ? "auto" : breaksMode === "none" ? [] : customBreaks,
        typoFrequency,
        seed,
        startInMinutes,
      });
      if (status === 401) { setScopeError(true); return; }
      if (!ok) throw new Error(data.error || `Sync start failed (HTTP ${status})`);
      setSources((s) => ({ ...s, [data.job.id]: sourceText }));
      setJobs((prev) => [data.job, ...prev]);
      setFocusedJobId(data.job.id);
      setComposing(false);
      setSourceText("");
      setStartInMinutes(0);
      setSeed(randomSeed());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start sync");
    } finally {
      setBusy(false);
    }
  }, [sourceText, selectedDocId, busy, docs, durationMinutes, breaksMode, customBreaks, typoFrequency, seed, startInMinutes]);

  const jobAction = useCallback(async (path: "pause" | "resume" | "cancel", jobId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const { ok, data } = await postJson<{ job: PublicJob }>(`/api/sync/${path}`, { jobId });
      if (!ok) throw new Error(data.error || `Failed to ${path}`);
      updateJob(data.job);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to ${path}`);
      fetchJobs();
    } finally {
      setBusy(false);
    }
  }, [busy, fetchJobs]);

  const dismissJob = useCallback(async (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    if (focusedJobId === jobId) { setFocusedJobId(null); setComposing(true); }
    await postJson("/api/sync/dismiss", { jobId }).catch(() => {});
  }, [focusedJobId]);

  const reuseAsNew = useCallback((job: PublicJob) => {
    const text = sources[job.id];
    if (text) setSourceText(text);
    setSelectedDocId(job.documentId);
    setComposing(true);
  }, [sources]);

  // ── Derived display values ──
  const focusedSource = focusedJob ? sources[focusedJob.id] ?? "" : "";
  const pct = focusedJob && focusedJob.totalChars > 0 ? Math.min(100, (focusedJob.charsSent / focusedJob.totalChars) * 100) : 0;
  const isRunning = !!focusedJob && (focusedJob.status === "running" || focusedJob.status === "pending");
  const sourceWords = focusedJob ? countWords(focusedSource) : countWords(sourceText);
  const typedWords = focusedJob ? Math.max(0, (focusedJob.liveWordCount ?? focusedJob.baselineWordCount) - focusedJob.baselineWordCount) : 0;
  const nextEditMs = focusedJob?.nextActionAt && isRunning ? Math.max(0, focusedJob.nextActionAt - now) : null;
  const nextBreakMs = focusedJob?.nextBreakAt != null && isActive(focusedJob) && focusedJob.status !== "paused" ? focusedJob.nextBreakAt - now : null;
  const heroTarget = focusedJob ? (focusedJob.status === "scheduled" ? focusedJob.startAt : focusedJob.etaTargetAt) : undefined;
  const errorText = actionError ?? (focusedJob?.status === "error" ? focusedJob.error : null);

  if (docsLoading || !jobsLoaded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#09090b]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
          <span className="text-zinc-500 font-mono text-xs tracking-wider uppercase">Loading</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-transparent p-4 md:p-8 relative overflow-hidden">
      <div className="w-full max-w-7xl max-h-[92vh] p-4 md:p-6 pb-1 rounded-2xl border border-white/[0.06] bg-[#09090b]/80 backdrop-blur-sm flex flex-col gap-2.5 overflow-hidden relative shadow-2xl z-10">
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-white/[0.02]">
          {focusedJob && isActive(focusedJob) && (
            <div
              className={cn("h-full transition-all duration-500 ease-out", isRunning ? "bg-blue-500 neon-pulse" : "bg-yellow-500/60")}
              style={{ width: `${pct}%` }}
            />
          )}
        </div>

        <HeroStatus
          status={focusedJob ? focusedJob.status : "idle"}
          activity={focusedJob?.activity}
          targetAt={heroTarget}
          progressPct={pct}
          wpm={focusedJob?.wpm}
          scopeError={scopeError}
        />

        {/* Stats */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2 flex-shrink-0">
          <StatCard label="Status" value={focusedJob ? focusedJob.status : "ready"} active={isRunning} />
          <StatCard label="Progress" value={`${Math.round(pct)}%`} active={isRunning} />
          <StatCard label="Edits" value={focusedJob ? `${Math.min(focusedJob.currentAction, focusedJob.totalActions)}/${focusedJob.totalActions}` : preview ? `0/${preview.actions.length}` : "0/0"} active={isRunning} />
          <StatCard label="Words" value={`${typedWords.toLocaleString()}/${sourceWords.toLocaleString()}`} active={isRunning} />
          <StatCard label="Next edit" value={nextEditMs != null ? `${(nextEditMs / 1000).toFixed(1)}s` : "--"} active={isRunning} />
          <StatCard label="Next break" value={nextBreakMs != null ? (nextBreakMs <= 0 ? "now" : formatCountdown(nextBreakMs)) : "--"} active={isRunning} />
        </div>

        {/* Break checklist */}
        {focusedJob && focusedJob.breaks.length > 0 && (
          <div className="card-sovereign px-3 py-1.5 flex items-center gap-2 flex-shrink-0">
            <span className="text-[0.5rem] font-bold uppercase tracking-[1.5px] text-zinc-600 whitespace-nowrap">Breaks</span>
            <span className="text-[0.5rem] font-mono text-blue-400/70 whitespace-nowrap">
              {focusedJob.completedBreaks.length}/{focusedJob.breaks.length}
            </span>
            <div className="flex gap-1 ml-auto flex-wrap justify-end">
              {focusedJob.breaks.map((mins, i) => {
                const done = focusedJob.completedBreaks.includes(i);
                return (
                  <span
                    key={i}
                    className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono",
                      done ? "bg-white/[0.02] border border-white/[0.04] text-zinc-700 line-through" : "bg-blue-500/8 border border-blue-500/20 text-blue-300"
                    )}
                  >
                    <span className={cn("w-1 h-1 rounded-full", done ? "bg-zinc-700" : "bg-blue-400")} />
                    {formatDuration(mins)}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        <JobList
          jobs={jobs}
          focusedJobId={focusedJobId}
          composing={composing}
          onFocus={(id) => { setFocusedJobId(id); setComposing(false); setActionError(null); }}
          onCompose={() => { setComposing(true); setActionError(null); }}
          onDismiss={dismissJob}
        />

        {/* Main body */}
        <div className="grid grid-cols-12 gap-2.5 flex-1 min-h-0">
          <div className="col-span-12 md:col-span-7 card-sovereign p-4 flex flex-col min-h-[300px]">
            {focusedJob ? (
              focusedSource ? (
                <div className="flex-1 overflow-y-auto custom-scroll">
                  <div className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                    <span className="text-zinc-300">{focusedSource.slice(0, focusedJob.charsSent)}</span>
                    {focusedJob.charsSent < focusedSource.length && (
                      <>
                        <span className="bg-blue-500/20 text-blue-300 border-l-2 border-blue-500 animate-pulse">{focusedSource.slice(focusedJob.charsSent, focusedJob.charsSent + 1)}</span>
                        <span className="text-zinc-700">{focusedSource.slice(focusedJob.charsSent + 1)}</span>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full font-mono text-[13px] text-zinc-600">Loading text…</div>
              )
            ) : (
              <SourceInput value={sourceText} onChange={setSourceText} disabled={busy} />
            )}
          </div>

          <div className="col-span-12 md:col-span-5 card-sovereign p-4 flex flex-col overflow-hidden">
            {focusedJob ? (
              <JobDetails job={focusedJob} />
            ) : (
              <SyncControls
                docs={docs}
                selectedDocId={selectedDocId}
                onSelectDoc={setSelectedDocId}
                durationMinutes={durationMinutes}
                onDurationChange={setDurationMinutes}
                breaksMode={breaksMode}
                onBreaksModeChange={setBreaksMode}
                customBreaks={customBreaks}
                onCustomBreaksChange={setCustomBreaks}
                typoFrequency={typoFrequency}
                onTypoFrequencyChange={setTypoFrequency}
                startInMinutes={startInMinutes}
                onStartInChange={setStartInMinutes}
                preview={preview}
                onShuffle={() => setSeed(randomSeed())}
                disabled={busy}
                onRefreshDocs={() => fetchDocs(true)}
                onCreateDoc={handleCreateDoc}
                isCreatingDoc={isCreatingDoc}
                isRefreshing={isRefreshing}
              />
            )}
          </div>
        </div>

        {/* Action bar */}
        <div className="flex items-center justify-center gap-3 py-3">
          {!focusedJob && (
            <button
              onClick={startSync}
              disabled={!sourceText.trim() || !selectedDocId || busy}
              className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-30 disabled:pointer-events-none text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_0_20px_rgba(59,130,246,0.4)]"
            >
              {busy ? "Starting…" : startInMinutes > 0 ? `Schedule for ${formatClock(Date.now() + startInMinutes * 60_000)}` : "Start sync"}
            </button>
          )}
          {focusedJob && (focusedJob.status === "running" || focusedJob.status === "pending" || focusedJob.status === "scheduled") && (
            <>
              <SecondaryButton onClick={() => jobAction("pause", focusedJob.id)} disabled={busy} tone="yellow">Pause</SecondaryButton>
              <SecondaryButton onClick={() => jobAction("cancel", focusedJob.id)} disabled={busy} tone="red">Cancel</SecondaryButton>
            </>
          )}
          {focusedJob?.status === "paused" && (
            <>
              <PrimaryButton onClick={() => jobAction("resume", focusedJob.id)} disabled={busy}>Resume</PrimaryButton>
              <SecondaryButton onClick={() => jobAction("cancel", focusedJob.id)} disabled={busy} tone="red">Cancel</SecondaryButton>
            </>
          )}
          {focusedJob && (focusedJob.status === "done" || focusedJob.status === "error" || focusedJob.status === "cancelled") && (
            <>
              {focusedJob.status === "done" && (
                <a
                  href={`https://docs.google.com/document/d/${focusedJob.documentId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-[13px] font-semibold tracking-wide transition-all no-underline"
                >
                  Open document &rarr;
                </a>
              )}
              {focusedJob.status !== "done" && focusedSource && (
                <SecondaryButton onClick={() => reuseAsNew(focusedJob)} tone="blue">Edit as new sync</SecondaryButton>
              )}
              <SecondaryButton onClick={() => dismissJob(focusedJob.id)}>Dismiss</SecondaryButton>
            </>
          )}
        </div>

        {errorText && !scopeError && (
          <div className="card-sovereign p-4 flex items-start gap-3 animate-in">
            <span className="inline-block px-2 py-0.5 rounded text-[0.55rem] font-bold tracking-widest uppercase font-mono bg-red-500/10 text-red-400 border border-red-500/20 flex-shrink-0">
              Error
            </span>
            <span className="text-zinc-400 text-[13px] break-words">{errorText}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function JobDetails({ job }: { job: PublicJob }) {
  const rows: [string, string][] = [
    ["Document", job.documentName],
    ["Created", formatClock(job.createdAt)],
    [job.status === "scheduled" ? "Starts" : "Started", formatClock(job.status === "scheduled" ? job.startAt : job.startedAt ?? job.startAt)],
    [job.status === "done" ? "Finished" : "Expected finish", job.finishedAt ? formatClock(job.finishedAt) : job.etaTargetAt ? formatClock(job.etaTargetAt) : "--"],
    ["Breaks", job.breaks.length ? job.breaks.map((m) => formatDuration(m)).join(" · ") : "none"],
    ["Characters", `${job.charsSent.toLocaleString()} / ${job.totalChars.toLocaleString()}`],
  ];
  if (job.pausedAt && job.status === "paused") rows.push(["Paused", formatClock(job.pausedAt)]);
  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="text-[0.6rem] font-bold uppercase tracking-[2px] text-neutral-500">This sync</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-zinc-600 font-mono text-[10px] uppercase tracking-wider self-center">{k}</dt>
            <dd className="text-zinc-300 font-mono truncate">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      <a
        href={`https://docs.google.com/document/d/${job.documentId}/edit`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[0.6rem] font-mono text-zinc-600 hover:text-blue-400 transition-colors"
      >
        Open in Docs &rarr;
      </a>
      <p className="mt-auto text-[10px] text-zinc-600 leading-relaxed">
        This sync runs on the server. You can close this tab, switch to another sync, or start a new one; it keeps going.
      </p>
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_0_20px_rgba(59,130,246,0.4)] disabled:opacity-30 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick, disabled, tone }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; tone?: "yellow" | "red" | "blue" }) {
  const hover = tone === "yellow" ? "hover:border-yellow-500/30 hover:text-yellow-400" : tone === "red" ? "hover:border-red-500/30 hover:text-red-400" : "hover:border-blue-500/30 hover:text-blue-400";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn("px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] text-zinc-400 text-[13px] font-semibold tracking-wide transition-all disabled:opacity-30 disabled:pointer-events-none", hover)}
    >
      {children}
    </button>
  );
}

function StatCard({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className={cn("card-sovereign px-3 py-2.5 flex items-center justify-between", active && "border-blue-500/10")}>
      <span className="text-[0.5rem] font-bold uppercase tracking-[1.5px] text-zinc-600">{label}</span>
      <span className="font-mono text-[13px] font-semibold text-zinc-300 tabular-nums capitalize">{value}</span>
    </div>
  );
}
