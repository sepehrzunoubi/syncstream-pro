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
  const abortRef = useRef<AbortController | null>(null);
  const syncStartRef = useRef<number>(0);
  const [nextSyncCountdown, setNextSyncCountdown] = useState(0);
  const [realWordCount, setRealWordCount] = useState(0);
  const [pausedCharsSent, setPausedCharsSent] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const lastCharsSentRef = useRef<number>(0);
  const startSyncRef = useRef<(resumeFromChar?: number) => Promise<void>>();

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

  const startSync = useCallback(async (resumeFromChar = 0) => {
    const textToSync = resumeFromChar > 0 ? sourceText.slice(resumeFromChar) : sourceText;
    if (!textToSync.trim() || !selectedDocId || isTransitioning) return;

    setIsTransitioning(true);

    // Cancel any pending schedule
    setIsScheduled(false);
    scheduledTimeRef.current = 0;

    // Clean up any previous controller before creating a new one
    abortRef.current?.abort();
    abortRef.current = null;

    setSyncStatus("syncing");
    setMetrics(null);
    lastCharsSentRef.current = 0;
    syncStartRef.current = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;

    // Small delay to ensure UI updates before fetch starts
    await new Promise(r => setTimeout(r, 50));
    setIsTransitioning(false);

    // Scale duration proportionally for remaining text (human mode only)
    const remainingRatio = textToSync.length / Math.max(1, sourceText.length);
    const adjustedDuration = rhythm === "burst"
      ? durationMinutes
      : Math.max(1, Math.round(durationMinutes * remainingRatio));

    try {
      const res = await fetch("/api/stream", {
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
        signal: controller.signal,
      });

      if (res.status === 401) {
        setScopeError(true);
        setSyncStatus("error");
        return;
      }
      if (!res.ok) throw new Error(`Stream failed: ${res.status}`);
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event: StreamEvent = JSON.parse(line.slice(6));
              setMetrics(event);
              // Track last known charsSent for accurate pause snapshots
              lastCharsSentRef.current = event.charsSent ?? 0;

              if (event.type === "done") {
                setSyncStatus("done");
                // Mark all chars as sent (absolute position)
                setPausedCharsSent(sourceText.length);
                lastCharsSentRef.current = 0;
              } else if (event.type === "error") {
                if (event.error?.includes("Insufficient")) {
                  setScopeError(true);
                }
                setSyncStatus("error");
                lastCharsSentRef.current = 0;
                abortRef.current = null;
              }
            } catch {
              // skip malformed events
            }
          }
        }
      }

      setSyncStatus((prev) => (prev === "syncing" ? "done" : prev));
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("Stream error:", err);
        setSyncStatus("error");
        lastCharsSentRef.current = 0;
      }
    } finally {
      setIsTransitioning(false);
    }
  }, [sourceText, selectedDocId, rhythm, durationMinutes, typoFrequency, pauseVariance, isTransitioning]);

  const pauseSync = useCallback(() => {
    if (isTransitioning || syncStatus !== "syncing") return;
    setIsTransitioning(true);

    abortRef.current?.abort();
    abortRef.current = null;

    // Save absolute position: previous paused position + chars sent in this session
    const currentSessionChars = lastCharsSentRef.current;
    setPausedCharsSent((prev) => prev + currentSessionChars);
    lastCharsSentRef.current = 0;

    setSyncStatus("paused");
    setIsTransitioning(false);
  }, [isTransitioning, syncStatus]);

  const resumeSync = useCallback(() => {
    if (isTransitioning || syncStatus !== "paused") return;
    startSync(pausedCharsSent);
  }, [startSync, pausedCharsSent, isTransitioning, syncStatus]);

  const resetSync = useCallback(() => {
    if (isTransitioning) return;
    setIsTransitioning(true);

    abortRef.current?.abort();
    abortRef.current = null;
    setSyncStatus("idle");
    setMetrics(null);
    setSourceText("");
    setScopeError(false);
    setPausedCharsSent(0);
    lastCharsSentRef.current = 0;
    setIsScheduled(false);
    scheduledTimeRef.current = 0;

    setIsTransitioning(false);
  }, [isTransitioning]);

  const isBusy = syncStatus === "syncing";
  const isPaused = syncStatus === "paused";
  const controlsDisabled = isBusy || isPaused;

  // Progress: absolute position in source text
  // When syncing: pausedCharsSent (from previous sessions) + current session chars
  // When paused/done: pausedCharsSent is already the absolute position
  const totalCharsSent = syncStatus === "syncing"
    ? pausedCharsSent + (metrics?.charsSent ?? 0)
    : pausedCharsSent;
  const pct = sourceText.length > 0
    ? Math.min((totalCharsSent / sourceText.length) * 100, 100)
    : 0;

  // Poll real-time word count from Google Doc during sync
  useEffect(() => {
    if (syncStatus !== "syncing" || !selectedDocId) {
      if (syncStatus === "idle") setRealWordCount(0);
      return;
    }
    
    const fetchWordCount = async () => {
      try {
        const res = await fetch(`/api/wordcount?documentId=${selectedDocId}`);
        if (res.ok) {
          const data = await res.json();
          setRealWordCount(data.wordCount || 0);
        }
      } catch (err) {
        console.error("Word count fetch error:", err);
      }
    };
    
    fetchWordCount();
    const id = setInterval(fetchWordCount, 2000); // poll every 2s
    return () => clearInterval(id);
  }, [syncStatus, selectedDocId]);

  // Client-side countdown to next sync action
  useEffect(() => {
    if (syncStatus !== "syncing" || !metrics?.nextDelayMs) {
      setNextSyncCountdown(0);
      return;
    }
    const targetTime = Date.now() + metrics.nextDelayMs;
    const tick = () => {
      const remaining = Math.max(0, targetTime - Date.now());
      setNextSyncCountdown(remaining);
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [syncStatus, metrics?.nextDelayMs, metrics?.actionIndex]);

  const nextSyncSec = (nextSyncCountdown / 1000).toFixed(1);

  // Source word count for Word Count stat and Est. WPM
  const sourceWordCount = sourceText.trim() ? sourceText.trim().split(/\s+/).filter(w => w.length > 0).length : 0;
  const estWPM = sourceWordCount > 0 && durationMinutes > 0
    ? Math.round(sourceWordCount / durationMinutes)
    : 0;

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
    scheduledTimeRef.current = Date.now() + delayMinutes * 60 * 1000;
    setIsScheduled(true);
  }, []);

  const cancelSchedule = useCallback(() => {
    setIsScheduled(false);
    scheduledTimeRef.current = 0;
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
      <div className="w-full max-w-7xl max-h-[85vh] p-4 md:p-6 rounded-2xl border border-white/[0.06] bg-[#09090b]/80 backdrop-blur-sm flex flex-col gap-2.5 overflow-y-auto relative shadow-2xl z-10">

        {/* ═══ Neon Pulse Bar — 2px at very top ═══ */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-white/[0.02]">
          {isBusy && (
            <div
              className="h-full bg-blue-500 neon-pulse transition-all duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>

        {/* ═══ Hero Status ═══ */}
        <HeroStatus
          status={syncStatus}
          metrics={metrics}
          scopeError={scopeError}
        />

        {/* ═══ Stats Row — 6 ultra-slim cards ═══ */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
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
            value={isBusy || syncStatus === "done" || isPaused ? `${realWordCount.toLocaleString()}/${sourceWordCount.toLocaleString()}` : sourceWordCount > 0 ? `0/${sourceWordCount.toLocaleString()}` : "0/0"}
            active={isBusy}
          />
          <StatCard
            label="Next Sync"
            value={isBusy && nextSyncCountdown > 0 ? `${nextSyncSec}s` : "--"}
            active={isBusy}
          />
          <StatCard
            label="Est. WPM"
            value={isBusy && metrics?.wpm ? String(metrics.wpm) : estWPM > 0 ? String(estWPM) : "--"}
            active={isBusy}
          />
        </div>

        {/* ═══ Main Body — 7/5 split ═══ */}
        <div className="grid grid-cols-12 gap-2.5 auto-rows-min">

          {/* Left: Source Editor (7 cols) */}
          <div className="col-span-12 md:col-span-7 card-sovereign p-4 flex flex-col min-h-[300px]">
            {isBusy || syncStatus === "done" || isPaused ? (
              <div className="flex flex-col items-center justify-center h-full">
                <div className="font-mono text-[13px] text-zinc-600">
                  {syncStatus === "done"
                    ? "Content streamed successfully."
                    : isPaused
                    ? `Sync paused at ${Math.round(pct)}%. Press Resume to continue.`
                    : "Content is being streamed\u2026"}
                </div>
              </div>
            ) : (
              <SourceInput
                value={sourceText}
                onChange={setSourceText}
                disabled={controlsDisabled}
              />
            )}
          </div>

          {/* Right: Command Deck (5 cols) */}
          <div className="col-span-12 md:col-span-5 card-sovereign p-4 flex flex-col overflow-y-auto">
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
        <div className="flex items-center justify-center gap-3 py-1">
          {syncStatus === "idle" && (
            <button
              onClick={() => startSync(0)}
              disabled={!sourceText.trim() || !selectedDocId || isTransitioning}
              className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-30 disabled:cursor-not-allowed text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_0_20px_rgba(59,130,246,0.4)]"
            >
              {isTransitioning ? "Starting..." : "Start Sync"}
            </button>
          )}
          {syncStatus === "syncing" && (
            <button
              onClick={pauseSync}
              disabled={isTransitioning}
              className="px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-yellow-500/30 text-zinc-400 hover:text-yellow-400 text-[13px] font-semibold tracking-wide transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isTransitioning ? "Pausing..." : "Pause"}
            </button>
          )}
          {isPaused && (
            <>
              <button
                onClick={resumeSync}
                disabled={isTransitioning}
                className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_0_20px_rgba(59,130,246,0.4)] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {isTransitioning ? "Resuming..." : "Resume"}
              </button>
              <button
                onClick={resetSync}
                disabled={isTransitioning}
                className="px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-zinc-500/30 text-zinc-400 hover:text-zinc-300 text-[13px] font-semibold tracking-wide transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                New Sync
              </button>
            </>
          )}
          {(syncStatus === "done" || syncStatus === "error") && (
            <button
              onClick={resetSync}
              disabled={isTransitioning}
              className="px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-blue-500/30 text-zinc-400 hover:text-blue-400 text-[13px] font-semibold tracking-wide transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              New Sync
            </button>
          )}
        </div>

        {/* ═══ Done card ═══ */}
        {syncStatus === "done" && selectedDocId && (
          <div className="card-sovereign p-4 text-center animate-in">
            <span className="inline-block px-2 py-0.5 rounded text-[0.55rem] font-bold tracking-widest uppercase font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 mb-2">
              COMPLETE
            </span>
            <p className="text-zinc-500 text-[13px] mb-1">
              All content streamed successfully.
            </p>
            <a
              href={`https://docs.google.com/document/d/${selectedDocId}/edit`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline text-[13px] font-mono"
            >
              Open Document &rarr;
            </a>
          </div>
        )}

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
