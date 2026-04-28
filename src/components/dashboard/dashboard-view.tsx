"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { HeroStatus } from "./hero-status";
import { SourceInput } from "./source-input";
import { SyncControls } from "./sync-controls";
import type { StreamEvent } from "@/lib/drip-engine";
import { cn } from "@/lib/utils";

type SyncStatus = "idle" | "syncing" | "paused" | "done" | "error";

export function DashboardView() {
  const [docs, setDocs] = useState<
    { id: string; name: string; modifiedTime: string }[]
  >([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreatingDoc, setIsCreatingDoc] = useState(false);
  const [scopeError, setScopeError] = useState(false);

  const [sourceText, setSourceText] = useState("");
  const [selectedDocId, setSelectedDocId] = useState("");
  const [rhythm, setRhythm] = useState("human");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [typoFrequency, setTypoFrequency] = useState(0.5);
  const [pauseVariance, setPauseVariance] = useState(0.5);

  // Schedule state
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduleCountdown, setScheduleCountdown] = useState(0);
  const scheduledTimeRef = useRef<number>(0);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [metrics, setMetrics] = useState<StreamEvent | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [nextSyncCountdown, setNextSyncCountdown] = useState(0);
  const [realWordCount, setRealWordCount] = useState(0);
  const [baselineWordCount, setBaselineWordCount] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isBooting, setIsBooting] = useState(false);
  const lastPauseResumeRef = useRef<number>(0);
  const startSyncRef = useRef<(resumeFromChar?: number) => Promise<void>>();

  // ── Persistent session blob ────────────────────────────────────────────
  // Single source of truth in localStorage for everything needed to restore the
  // dashboard after a tab close. Progress (charsSent, ETAs, action index) lives
  // on the SERVER only; the client just renders what /api/sync/status returns.
  type SyncSession = {
    jobId: string;
    sourceText: string;
    selectedDocId: string;
    rhythm: string;
    durationMinutes: number;
    typoFrequency: number;
    pauseVariance: number;
    baselineWordCount: number;
  };
  const SESSION_KEY = "syncstream_session";
  const SCHEDULE_KEY = "syncstream_schedule";

  const saveSession = (s: SyncSession) => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* quota */ }
  };
  const clearSession = () => {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem("syncstream_active_job");
      localStorage.removeItem("syncstream_progress");
      localStorage.removeItem("syncstream_settings");
    } catch { /* noop */ }
  };

  const saveJobId = (id: string | null) => {
    jobIdRef.current = id;
    setActiveJobId(id);
    if (!id) clearSession();
  };

  // On mount: restore persisted session and resume polling if a job is still alive
  useEffect(() => {
    let saved: SyncSession | null = null;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) saved = JSON.parse(raw) as SyncSession;
    } catch { saved = null; }

    // Restore a pending schedule even if there's no active job
    try {
      const schedRaw = localStorage.getItem(SCHEDULE_KEY);
      if (schedRaw) {
        const at = Number(schedRaw);
        if (Number.isFinite(at) && at > Date.now()) {
          scheduledTimeRef.current = at;
          setIsScheduled(true);
        } else {
          localStorage.removeItem(SCHEDULE_KEY);
        }
      }
    } catch { /* noop */ }

    if (!saved?.jobId) return;

    // Restore UI settings + source text up-front so the preview renders correctly
    setSourceText(saved.sourceText || "");
    if (saved.selectedDocId) setSelectedDocId(saved.selectedDocId);
    if (saved.rhythm) setRhythm(saved.rhythm);
    if (saved.durationMinutes) setDurationMinutes(saved.durationMinutes);
    if (typeof saved.typoFrequency === "number") setTypoFrequency(saved.typoFrequency);
    if (typeof saved.pauseVariance === "number") setPauseVariance(saved.pauseVariance);
    if (typeof saved.baselineWordCount === "number") setBaselineWordCount(saved.baselineWordCount);

    fetch(`/api/sync/status?jobId=${saved.jobId}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!data) { clearSession(); return; }
        if (data.event?.baselineWordCount != null) {
          setBaselineWordCount(data.event.baselineWordCount);
        }
        if (data.jobStatus === "running" || data.jobStatus === "pending") {
          jobIdRef.current = saved!.jobId;
          setActiveJobId(saved!.jobId);
          setMetrics(data.event);
          setSyncStatus("syncing");
        } else if (data.jobStatus === "paused") {
          jobIdRef.current = saved!.jobId;
          setActiveJobId(saved!.jobId);
          setMetrics(data.event);
          setSyncStatus("paused");
        } else if (data.jobStatus === "done") {
          setMetrics(data.event);
          setSyncStatus("done");
          clearSession();
        } else {
          clearSession();
        }
      })
      .catch(() => { clearSession(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch recent docs on mount
  const fetchDocs = useCallback(async (isRefresh = false) => {
    if (isRefresh) setIsRefreshing(true);
    try {
      const res = await fetch("/api/docs");
      if (res.status === 401) {
        setScopeError(true);
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch docs");
      const data = await res.json();
      setDocs(data.docs || []);
      if (data.docs?.length > 0 && !isRefresh) {
        setSelectedDocId(data.docs[0].id);
      }
    } catch (err) {
      console.error("Docs fetch error:", err);
    } finally {
      setDocsLoading(false);
      if (isRefresh) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  const handleCreateDoc = useCallback(async () => {
    setIsCreatingDoc(true);
    try {
      const res = await fetch("/api/docs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SyncStream Draft" }),
      });
      if (!res.ok) throw new Error("Failed to create doc");
      const doc = await res.json();
      // Add the new doc to the list and auto-select it
      setDocs((prev) => [{ id: doc.id, name: doc.name, modifiedTime: new Date().toISOString() }, ...prev]);
      setSelectedDocId(doc.id);
    } catch (err) {
      console.error("Create doc error:", err);
    } finally {
      setIsCreatingDoc(false);
    }
  }, []);

  const startSync = useCallback(async (resumeFromChar = 0) => {
    const textToSync = resumeFromChar > 0 ? sourceText.slice(resumeFromChar) : sourceText;
    if (!textToSync.trim() || !selectedDocId || isTransitioning) return;

    setIsTransitioning(true);

    // Cancel any pending schedule
    setIsScheduled(false);
    scheduledTimeRef.current = 0;

    // Cancel any previous background job
    if (jobIdRef.current) {
      fetch("/api/sync/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: jobIdRef.current }),
      }).catch(() => {});
      saveJobId(null);
    }

    // Capture baseline word count in target doc BEFORE sync starts
    let baseline = 0;
    try {
      const wcRes = await fetch(`/api/wordcount?documentId=${selectedDocId}`);
      if (wcRes.ok) {
        const wcData = await wcRes.json();
        baseline = wcData.wordCount || 0;
      }
    } catch { /* best effort */ }
    setBaselineWordCount(baseline);
    setRealWordCount(baseline);

    setSyncStatus("syncing");
    setMetrics(null);
    // Burst boot-up overlay: show loading until first real metrics arrive
    if (rhythm === "burst") setIsBooting(true);

    // Small delay to ensure UI updates before fetch starts
    await new Promise(r => setTimeout(r, 50));
    setIsTransitioning(false);

    // Scale duration proportionally for remaining text (human mode only)
    const remainingRatio = textToSync.length / Math.max(1, sourceText.length);
    const adjustedDuration = rhythm === "burst"
      ? durationMinutes
      : Math.max(1, Math.round(durationMinutes * remainingRatio));

    try {
      const res = await fetch("/api/sync/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: textToSync,
          documentId: selectedDocId,
          rhythm,
          durationMinutes: adjustedDuration,
          typoFrequency,
          pauseVariance,
        }),
      });

      if (res.status === 401) {
        setScopeError(true);
        setSyncStatus("error");
        return;
      }
      if (!res.ok) throw new Error(`Sync start failed: ${res.status}`);

      const data = await res.json();
      saveJobId(data.jobId);
      // Persist a single session blob so reload restores everything
      saveSession({
        jobId: data.jobId,
        sourceText: textToSync,
        selectedDocId,
        rhythm,
        durationMinutes: adjustedDuration,
        typoFrequency,
        pauseVariance,
        baselineWordCount: baseline,
      });
    } catch (err) {
      console.error("Sync start error:", err);
      setSyncStatus("error");
      setIsBooting(false);
      setIsTransitioning(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceText, selectedDocId, rhythm, durationMinutes, typoFrequency, pauseVariance, isTransitioning]);

  // Poll background job status while syncing
  useEffect(() => {
    if (syncStatus !== "syncing" || !activeJobId) return;

    const poll = async () => {
      const currentJobId = jobIdRef.current;
      if (!currentJobId) return;

      try {
        const res = await fetch(`/api/sync/status?jobId=${currentJobId}`);
        if (!res.ok) return;

        const data = await res.json();
        const event: StreamEvent = data.event;
        setMetrics(event);

        // Clear burst boot-up overlay once real progress starts
        if (isBooting && (event.actionIndex > 0 || (event.charsSent ?? 0) > 0)) {
          setIsBooting(false);
        }

        // Sync server-side baseline so word count is always accurate (survives tab close)
        if (event.baselineWordCount != null) {
          setBaselineWordCount(event.baselineWordCount);
        }

        // Stall detection: if server hasn't updated recently, the process
        // likely died (failed self-chain). Auto-recover by pausing then resuming.
        // V2 awareness: during mandatory pauses, currentPauseDelayMs tells us the
        // remaining pause time — use that + buffer as the threshold to avoid false positives.
        if (data.jobStatus === "running" && event.lastUpdate) {
          const staleness = Date.now() - event.lastUpdate;
          const activePauseMs = event.currentPauseDelayMs ?? 0;
          // If a mandatory pause is active, allow staleness up to the pause duration + 60s buffer.
          // Otherwise use the default 90s threshold.
          const stallThreshold = activePauseMs > 0
            ? Math.max(90_000, activePauseMs + 60_000)
            : 90_000;
          if (staleness > stallThreshold) {
            console.warn(`Sync job stalled (${Math.round(staleness / 1000)}s stale, threshold ${Math.round(stallThreshold / 1000)}s) — auto-recovering`);
            try {
              // Pause then resume to re-kick the process with a fresh generation
              await fetch("/api/sync/pause", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jobId: currentJobId }),
              });
              await new Promise(r => setTimeout(r, 500));
              await fetch("/api/sync/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jobId: currentJobId }),
              });
            } catch { /* best effort recovery */ }
            return; // skip normal processing this cycle
          }
        }

        if (data.jobStatus === "done") {
          setSyncStatus("done");
          // Final word count fetch so the stat is accurate on completion
          if (selectedDocId) {
            fetch(`/api/wordcount?documentId=${selectedDocId}`)
              .then(r => r.ok ? r.json() : null)
              .then(d => { if (d?.wordCount) setRealWordCount(d.wordCount); })
              .catch(() => {});
          }
          saveJobId(null);
        } else if (data.jobStatus === "error") {
          if (event.error?.includes("Insufficient")) {
            setScopeError(true);
          }
          setSyncStatus("error");
          saveJobId(null);
        } else if (data.jobStatus === "cancelled") {
          setSyncStatus("idle");
          saveJobId(null);
        } else if (data.jobStatus === "paused") {
          setSyncStatus("paused");
        }
      } catch {
        // Polling error — keep trying
      }
    };

    // Immediate first poll so stats update right away
    poll();
    const pollInterval = setInterval(poll, 2000);

    return () => clearInterval(pollInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStatus, activeJobId, sourceText.length, selectedDocId, isBooting]);

  const pauseSync = useCallback(async () => {
    if (isTransitioning || syncStatus !== "syncing") return;
    // Cooldown: prevent rapid pause/resume spam (2s)
    const now = Date.now();
    if (now - lastPauseResumeRef.current < 2000) return;
    lastPauseResumeRef.current = now;
    setIsTransitioning(true);

    if (jobIdRef.current) {
      try {
        await fetch("/api/sync/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: jobIdRef.current }),
        });
      } catch { /* best effort — polling will pick up server-side pause */ }
    }

    setSyncStatus("paused");
    setIsTransitioning(false);
  }, [isTransitioning, syncStatus]);

  const resumeSync = useCallback(async () => {
    if (isTransitioning || syncStatus !== "paused" || !jobIdRef.current) return;
    // Cooldown: prevent rapid pause/resume spam (2s)
    const now = Date.now();
    if (now - lastPauseResumeRef.current < 2000) return;
    lastPauseResumeRef.current = now;
    setIsTransitioning(true);

    try {
      const res = await fetch("/api/sync/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: jobIdRef.current }),
      });

      if (!res.ok) {
        console.error("Resume failed");
        setIsTransitioning(false);
        return;
      }

      setSyncStatus("syncing");
      setActiveJobId(jobIdRef.current);
    } catch (err) {
      console.error("Resume error:", err);
    } finally {
      setIsTransitioning(false);
    }
  }, [isTransitioning, syncStatus]);

  const resetSync = useCallback(() => {
    if (isTransitioning) return;
    setIsTransitioning(true);

    // Cancel any active background job
    if (jobIdRef.current) {
      fetch("/api/sync/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: jobIdRef.current }),
      }).catch(() => {});
      saveJobId(null);
    }

    setSyncStatus("idle");
    setMetrics(null);
    setSourceText("");
    setScopeError(false);
    setBaselineWordCount(0);
    setRealWordCount(0);
    setIsScheduled(false);
    setIsBooting(false);
    scheduledTimeRef.current = 0;
    try { localStorage.removeItem(SCHEDULE_KEY); } catch { /* noop */ }

    setIsTransitioning(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTransitioning]);

  const isBusy = syncStatus === "syncing";
  const isPaused = syncStatus === "paused";
  const controlsDisabled = isBusy || isPaused;

  // Progress: server's charsSent is absolute across pause/resume cycles —
  // it's the single source of truth. No client-side accumulator needed.
  const totalCharsSent = syncStatus === "done"
    ? (sourceText.length > 0 ? sourceText.length : (metrics?.totalChars ?? 0))
    : (metrics?.charsSent ?? 0);
  const effectiveTotalChars = sourceText.length > 0 ? sourceText.length : (metrics?.totalChars ?? 0);
  const pct = effectiveTotalChars > 0
    ? Math.min((totalCharsSent / effectiveTotalChars) * 100, 100)
    : 0;

  // Poll real-time word count from Google Doc during sync AND paused state
  useEffect(() => {
    const isActive = syncStatus === "syncing" || syncStatus === "paused";
    if (!isActive || !selectedDocId) {
      if (syncStatus === "idle") {
        setRealWordCount(0);
        setBaselineWordCount(0);
      }
      return;
    }
    
    const fetchWordCount = async () => {
      try {
        const res = await fetch(`/api/wordcount?documentId=${selectedDocId}`);
        if (res.ok) {
          const data = await res.json();
          const wc = data.wordCount || 0;
          setRealWordCount(wc);
        }
      } catch (err) {
        console.error("Word count fetch error:", err);
      }
    };
    
    fetchWordCount();
    // Poll every 3s during sync, every 10s when paused (less aggressive)
    const interval = syncStatus === "paused" ? 10000 : 3000;
    const id = setInterval(fetchWordCount, interval);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStatus, selectedDocId]);

  // Client-side countdown to next sync action — uses absolute timestamp from server
  useEffect(() => {
    if (syncStatus !== "syncing") {
      setNextSyncCountdown(0);
      return;
    }
    // Prefer absolute nextActionAt timestamp (survives tab close/reopen)
    // Fall back to relative nextDelayMs for backwards compat
    const targetTime = metrics?.nextActionAt
      ? metrics.nextActionAt
      : metrics?.nextDelayMs
        ? Date.now() + metrics.nextDelayMs
        : 0;
    if (!targetTime) {
      setNextSyncCountdown(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, targetTime - Date.now());
      setNextSyncCountdown(remaining);
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [syncStatus, metrics?.nextActionAt, metrics?.nextDelayMs, metrics?.actionIndex]);

  const nextSyncSec = (nextSyncCountdown / 1000).toFixed(1);

  // Source word count for Word Count stat — derived from restored sourceText
  const sourceWordCount = sourceText.trim()
    ? sourceText.trim().split(/\s+/).filter(w => w.length > 0).length
    : (metrics?.totalChars ? Math.round(metrics.totalChars / 5) : 0);

  // Keep startSyncRef pointing at the latest startSync
  useEffect(() => {
    startSyncRef.current = startSync;
  }, [startSync]);

  // Schedule timer effect — uses ref to avoid resetting on startSync identity changes
  useEffect(() => {
    if (!isScheduled) {
      setScheduleCountdown(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, scheduledTimeRef.current - Date.now());
      setScheduleCountdown(remaining);
      if (remaining <= 0) {
        setIsScheduled(false);
        startSyncRef.current?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isScheduled]);

  const handleScheduleSync = useCallback((delayMinutes: number) => {
    const at = Date.now() + delayMinutes * 60 * 1000;
    scheduledTimeRef.current = at;
    setIsScheduled(true);
    try { localStorage.setItem(SCHEDULE_KEY, String(at)); } catch { /* noop */ }
  }, []);

  const cancelSchedule = useCallback(() => {
    setIsScheduled(false);
    scheduledTimeRef.current = 0;
    try { localStorage.removeItem(SCHEDULE_KEY); } catch { /* noop */ }
  }, []);

  if (docsLoading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#09090b]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
          <span className="text-zinc-500 font-mono text-xs tracking-wider uppercase">
            Loading
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-transparent p-4 md:p-8 relative overflow-hidden">
      <div className="w-full max-w-7xl max-h-[92vh] p-4 md:p-6 pb-1 rounded-2xl border border-white/[0.06] bg-[#09090b]/80 backdrop-blur-sm flex flex-col gap-2.5 overflow-hidden relative shadow-2xl z-10">

        {/* ═══ Burst Boot-up Loading Overlay ═══ */}
        {isBooting && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#09090b]/90 backdrop-blur-md rounded-2xl">
            <div className="flex flex-col items-center gap-3">
              <div className="flex gap-1.5">
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-bounce [animation-delay:300ms]" />
              </div>
              <span className="text-zinc-500 font-mono text-xs tracking-wider uppercase">
                Preparing sync
              </span>
            </div>
          </div>
        )}

        {/* ═══ Neon Pulse Bar — 2px at very top ═══ */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-white/[0.02]">
          {(isBusy || isPaused) && (
            <div
              className={`h-full transition-all duration-500 ease-out ${
                isBusy ? "bg-blue-500 neon-pulse" : "bg-yellow-500/60"
              }`}
              style={{ width: `${pct}%` }}
            />
          )}
        </div>

        {/* ═══ Hero Status ═══ */}
        <HeroStatus
          status={syncStatus}
          metrics={metrics}
          scopeError={scopeError}
          progressPct={pct}
        />

        {/* ═══ Stats Row — 6 ultra-slim cards ═══ */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2 flex-shrink-0">
          <StatCard
            label="Status"
            value={syncStatus.charAt(0).toUpperCase() + syncStatus.slice(1)}
            active={isBusy}
          />
          <StatCard
            label="Progress"
            value={`${Math.round(pct)}%`}
            active={isBusy}
          />
          <StatCard
            label="Actions"
            value={
              metrics
                ? `${metrics.actionIndex + 1}/${metrics.totalActions}`
                : "0/0"
            }
            active={isBusy}
          />
          <StatCard
            label="Word Count"
            value={isBusy || syncStatus === "done" || isPaused
              ? `${Math.max(0, realWordCount - baselineWordCount).toLocaleString()}/${sourceWordCount.toLocaleString()}`
              : sourceWordCount > 0 ? `0/${sourceWordCount.toLocaleString()}` : "0/0"}
            active={isBusy}
          />
          <StatCard
            label="Next Sync"
            value={isBusy && nextSyncCountdown > 0 ? `${nextSyncSec}s` : "--"}
            active={isBusy}
          />
          <StatCard
            label={rhythm === "burst" ? "Next Pause" : "Next Typo"}
            value={
              rhythm === "burst"
                ? (isBusy && metrics?.nextPauseAction != null
                    ? `#${metrics.nextPauseAction + 1}`
                    : syncStatus === "done" ? "Done" : "--")
                : (isBusy && metrics?.nextTypoAction != null
                    ? `#${metrics.nextTypoAction + 1}`
                    : syncStatus === "done" ? "Done" : "--")
            }
            active={isBusy}
          />
        </div>

        {/* ═══ V2 Mandatory Pause Checklist ═══ */}
        {metrics?.mandatoryPauses && metrics.mandatoryPauses.length > 0 && (isBusy || isPaused || syncStatus === "done") && (
          <div className="card-sovereign px-3 py-1.5 flex items-center gap-2 flex-shrink-0">
            <span className="text-[0.5rem] font-bold uppercase tracking-[1.5px] text-zinc-600 whitespace-nowrap">
              Pause Checkpoints
            </span>
            <span className="text-[0.5rem] font-mono text-purple-400/70 whitespace-nowrap">
              {(metrics.completedPauses?.length ?? 0)}/{metrics.mandatoryPauses.length}
            </span>
            <div className="flex gap-1 ml-auto">
              {metrics.mandatoryPauses.map((mins, i) => {
                const done = metrics.completedPauses?.includes(i) ?? false;
                return (
                  <div
                    key={i}
                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono transition-all ${
                      done
                        ? "bg-white/[0.02] border border-white/[0.04] text-zinc-700 line-through"
                        : "bg-purple-500/8 border border-purple-500/20 text-purple-400"
                    }`}
                  >
                    <span className={`w-1 h-1 rounded-full flex-shrink-0 ${
                      done ? "bg-zinc-700" : "bg-purple-400 shadow-[0_0_4px_rgba(168,85,247,0.4)]"
                    }`} />
                    {mins}m
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══ Main Body — 7/5 split ═══ */}
        <div className="grid grid-cols-12 gap-2.5 auto-rows-min">

          {/* Left: Source Editor (7 cols) */}
          <div className="col-span-12 md:col-span-7 card-sovereign p-4 flex flex-col min-h-[300px]">
            {isBusy || syncStatus === "done" || isPaused ? (
              sourceText.length > 0 ? (
                <div className="flex-1 overflow-y-auto custom-scroll">
                  <div className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                    <span className="text-zinc-300">{sourceText.slice(0, totalCharsSent)}</span>
                    {totalCharsSent < sourceText.length && (
                      <>
                        <span className="bg-blue-500/20 text-blue-300 border-l-2 border-blue-500 animate-pulse">{sourceText.slice(totalCharsSent, totalCharsSent + 1)}</span>
                        <span className="text-zinc-700">{sourceText.slice(totalCharsSent + 1)}</span>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-2">
                  <div className="font-mono text-[13px] text-zinc-600">
                    {syncStatus === "done"
                      ? "Content streamed successfully."
                      : isPaused
                      ? `Sync paused at ${Math.round(pct)}%. Press Resume to continue.`
                      : "Content is being streamed\u2026"}
                  </div>
                  <div className="font-mono text-[11px] text-zinc-700">
                    {metrics ? `${metrics.actionIndex}/${metrics.totalActions} actions \u2022 ${Math.round(pct)}% complete` : ""}
                  </div>
                </div>
              )
            ) : (
              <SourceInput
                value={sourceText}
                onChange={setSourceText}
                disabled={controlsDisabled}
              />
            )}
          </div>

          {/* Right: Command Deck (5 cols) */}
          <div className="col-span-12 md:col-span-5 card-sovereign p-4 flex flex-col overflow-hidden">
            {docsLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-zinc-600 font-mono text-[13px] animate-pulse">
                  Loading documents\u2026
                </div>
              </div>
            ) : (
              <SyncControls
                docs={docs}
                selectedDocId={selectedDocId}
                onSelectDoc={setSelectedDocId}
                rhythm={rhythm}
                onRhythmChange={setRhythm}
                durationMinutes={durationMinutes}
                onDurationChange={setDurationMinutes}
                typoFrequency={typoFrequency}
                onTypoFrequencyChange={setTypoFrequency}
                pauseVariance={pauseVariance}
                onPauseVarianceChange={setPauseVariance}
                sourceText={sourceText}
                disabled={controlsDisabled}
                onRefreshDocs={() => fetchDocs(true)}
                onCreateDoc={handleCreateDoc}
                isCreatingDoc={isCreatingDoc}
                isRefreshing={isRefreshing}
                isScheduled={isScheduled}
                scheduleCountdown={scheduleCountdown}
                onScheduleSync={handleScheduleSync}
                onCancelSchedule={cancelSchedule}
              />
            )}
          </div>
        </div>

        {/* ═══ Action Bar ═══ */}
        <div className="flex items-center justify-center gap-3 py-3">
          {syncStatus === "idle" && (
            <button
              onClick={() => startSync(0)}
              disabled={!sourceText.trim() || !selectedDocId || isTransitioning}
              className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-30 disabled:pointer-events-none text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_0_20px_rgba(59,130,246,0.4)]"
            >
              {isTransitioning ? "Starting..." : "Start Sync"}
            </button>
          )}
          {syncStatus === "syncing" && (
            <button
              onClick={pauseSync}
              disabled={isTransitioning}
              className="px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-yellow-500/30 text-zinc-400 hover:text-yellow-400 text-[13px] font-semibold tracking-wide transition-all disabled:opacity-30 disabled:pointer-events-none"
            >
              {isTransitioning ? "Pausing..." : "Pause"}
            </button>
          )}
          {isPaused && (
            <>
              <button
                onClick={resumeSync}
                disabled={isTransitioning}
                className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_0_20px_rgba(59,130,246,0.4)] disabled:opacity-30 disabled:pointer-events-none"
              >
                {isTransitioning ? "Resuming..." : "Resume"}
              </button>
              <button
                onClick={resetSync}
                disabled={isTransitioning}
                className="px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-zinc-500/30 text-zinc-400 hover:text-zinc-300 text-[13px] font-semibold tracking-wide transition-all disabled:opacity-30 disabled:pointer-events-none"
              >
                New Sync
              </button>
            </>
          )}
          {(syncStatus === "done" || syncStatus === "error") && (
            <>
              <button
                onClick={resetSync}
                disabled={isTransitioning}
                className="px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-blue-500/30 text-zinc-400 hover:text-blue-400 text-[13px] font-semibold tracking-wide transition-all disabled:opacity-30 disabled:pointer-events-none"
              >
                New Sync
              </button>
              {syncStatus === "done" && selectedDocId && (
                <a
                  href={`https://docs.google.com/document/d/${selectedDocId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_0_20px_rgba(59,130,246,0.4)] no-underline"
                >
                  Open Document &rarr;
                </a>
              )}
            </>
          )}
        </div>


        {/* ═══ Error card ═══ */}
        {syncStatus === "error" && metrics?.error && !scopeError && (
          <div className="card-sovereign p-4 flex items-center gap-3 animate-in">
            <span className="inline-block px-2 py-0.5 rounded text-[0.55rem] font-bold tracking-widest uppercase font-mono bg-red-500/10 text-red-400 border border-red-500/20 flex-shrink-0">
              ERROR
            </span>
            <span className="text-zinc-500 text-[13px] truncate">{metrics.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  active,
}: {
  label: string;
  value: string;
  active: boolean;
}) {
  return (
    <div
      className={cn(
        "card-sovereign px-3 py-2.5 flex items-center justify-between",
        active && "border-blue-500/10"
      )}
    >
      <span className="text-[0.5rem] font-bold uppercase tracking-[1.5px] text-zinc-600">
        {label}
      </span>
      <span className="font-mono text-[13px] font-semibold text-zinc-300 tabular-nums">
        {value}
      </span>
    </div>
  );
}
