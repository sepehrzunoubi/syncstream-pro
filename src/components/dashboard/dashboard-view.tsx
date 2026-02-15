"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { HeroStatus } from "./hero-status";
import { SourceInput } from "./source-input";
import { SyncControls } from "./sync-controls";
import type { StreamEvent } from "@/lib/drip-engine";
import { cn } from "@/lib/utils";

type SyncStatus = "idle" | "syncing" | "done" | "error";

export function DashboardView() {
  const [docs, setDocs] = useState<
    { id: string; name: string; modifiedTime: string }[]
  >([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [scopeError, setScopeError] = useState(false);

  const [sourceText, setSourceText] = useState("");
  const [selectedDocId, setSelectedDocId] = useState("");
  const [rhythm, setRhythm] = useState("human");
  const [durationMinutes, setDurationMinutes] = useState(30);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [metrics, setMetrics] = useState<StreamEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const syncStartRef = useRef<number>(0);

  // Fetch recent docs on mount
  useEffect(() => {
    async function fetchDocs() {
      try {
        const res = await fetch("/api/docs");
        if (res.status === 401) {
          setScopeError(true);
          return;
        }
        if (!res.ok) throw new Error("Failed to fetch docs");
        const data = await res.json();
        setDocs(data.docs || []);
        if (data.docs?.length > 0) {
          setSelectedDocId(data.docs[0].id);
        }
      } catch (err) {
        console.error("Docs fetch error:", err);
      } finally {
        setDocsLoading(false);
      }
    }
    fetchDocs();
  }, []);

  const startSync = useCallback(async () => {
    if (!sourceText.trim() || !selectedDocId) return;

    setSyncStatus("syncing");
    setMetrics(null);
    syncStartRef.current = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: sourceText,
          documentId: selectedDocId,
          rhythm,
          durationMinutes,
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

              if (event.type === "done") {
                setSyncStatus("done");
              } else if (event.type === "error") {
                // Check for scope error
                if (event.error?.includes("Insufficient")) {
                  setScopeError(true);
                }
                setSyncStatus("error");
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
      }
    }
  }, [sourceText, selectedDocId, rhythm, durationMinutes]);

  const stopSync = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSyncStatus("idle");
  }, []);

  const resetSync = useCallback(() => {
    setSyncStatus("idle");
    setMetrics(null);
    setSourceText("");
    setScopeError(false);
  }, []);

  const isBusy = syncStatus === "syncing";
  const pct = metrics
    ? Math.min((metrics.charsSent / metrics.totalChars) * 100, 100)
    : 0;

  return (
    <div className="flex flex-1">
      <div className="p-2 md:p-5 rounded-tl-2xl border border-white/[0.04] bg-[#09090b] flex flex-col gap-2.5 flex-1 w-full h-full overflow-y-auto relative">

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
          syncStartTime={syncStartRef.current}
          durationMinutes={durationMinutes}
        />

        {/* ═══ Stats Row — 6 ultra-slim cards ═══ */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          <StatCard
            label="Status"
            value={syncStatus.toUpperCase()}
            active={isBusy}
          />
          <StatCard
            label="Progress"
            value={
              metrics
                ? `${Math.min(Math.round((metrics.charsSent / metrics.totalChars) * 100), 100)}%`
                : "0%"
            }
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
            label="Chars"
            value={(metrics?.charsSent ?? 0).toLocaleString()}
            active={isBusy}
          />
          <StatCard
            label="WPM"
            value={metrics?.wpm ? String(metrics.wpm) : "--"}
            active={isBusy}
          />
          <StatCard
            label="Activity"
            value={metrics?.activity ?? "Idle"}
            active={isBusy}
          />
        </div>

        {/* ═══ Main Body — 7/5 split ═══ */}
        <div className="grid grid-cols-12 gap-2.5 flex-1 min-h-0">

          {/* Left: Source Editor (7 cols) */}
          <div className="col-span-12 md:col-span-7 card-sovereign p-4 flex flex-col min-h-[300px]">
            {isBusy || syncStatus === "done" ? (
              <div className="flex flex-col items-center justify-center h-full">
                <div className="font-mono text-[13px] text-zinc-600">
                  {syncStatus === "done"
                    ? "Content streamed successfully."
                    : "Content is being streamed\u2026"}
                </div>
              </div>
            ) : (
              <SourceInput
                value={sourceText}
                onChange={setSourceText}
                disabled={isBusy}
              />
            )}
          </div>

          {/* Right: Command Deck (5 cols) */}
          <div className="col-span-12 md:col-span-5 card-sovereign p-4 flex flex-col">
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
                disabled={isBusy}
              />
            )}
          </div>
        </div>

        {/* ═══ Action Bar ═══ */}
        <div className="flex items-center justify-center gap-3 py-1">
          {syncStatus === "idle" && (
            <button
              onClick={startSync}
              disabled={!sourceText.trim() || !selectedDocId}
              className="px-6 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-30 disabled:cursor-not-allowed text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_0_20px_rgba(59,130,246,0.4)]"
            >
              Start Sync
            </button>
          )}
          {syncStatus === "syncing" && (
            <button
              onClick={stopSync}
              className="px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-red-500/30 text-zinc-400 hover:text-red-400 text-[13px] font-semibold tracking-wide transition-all"
            >
              Stop
            </button>
          )}
          {(syncStatus === "done" || syncStatus === "error") && (
            <button
              onClick={resetSync}
              className="px-6 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-blue-500/30 text-zinc-400 hover:text-blue-400 text-[13px] font-semibold tracking-wide transition-all"
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
