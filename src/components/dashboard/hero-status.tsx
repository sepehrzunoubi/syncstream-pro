"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { StreamEvent } from "@/lib/drip-engine";

interface HeroStatusProps {
  status: "idle" | "syncing" | "paused" | "done" | "error";
  metrics: StreamEvent | null;
  scopeError?: boolean;
  /** Progress percentage computed by the parent (accounts for pause/resume cycles) */
  progressPct?: number;
}

function formatHMS(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function HeroStatus({
  status,
  metrics,
  scopeError,
  progressPct,
}: HeroStatusProps) {
  // Use parent-computed pct if available (accounts for pause/resume), else fallback
  const pct = progressPct ?? (metrics
    ? Math.min((metrics.charsSent / metrics.totalChars) * 100, 100)
    : 0);

  // Use server-sent ETA and smooth it client-side between SSE events
  const [remaining, setRemaining] = useState(0);
  const lastEtaRef = React.useRef<{ eta: number; receivedAt: number }>({ eta: 0, receivedAt: 0 });

  // When we get a new eta from the server, snapshot it
  useEffect(() => {
    if (status === "syncing" && metrics?.eta != null) {
      lastEtaRef.current = { eta: metrics.eta, receivedAt: Date.now() };
    }
  }, [status, metrics?.eta, metrics?.actionIndex]);

  // Smooth countdown between server updates — freeze on pause
  useEffect(() => {
    if (status === "paused") {
      // Keep the last known remaining value frozen — don't reset or tick
      return;
    }
    if (status !== "syncing") {
      setRemaining(0);
      return;
    }
    const tick = () => {
      const { eta, receivedAt } = lastEtaRef.current;
      if (!receivedAt) { setRemaining(0); return; }
      const elapsed = Date.now() - receivedAt;
      setRemaining(Math.max(0, eta - elapsed));
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [status]);

  // Scope error state
  if (scopeError) {
    return (
      <div className="card-sovereign-glow p-4 flex items-center justify-between">
        <div>
          <span className="inline-block px-2 py-0.5 rounded text-[0.55rem] font-bold tracking-widest uppercase font-mono bg-red-500/10 text-red-400 border border-red-500/20 mr-3">
            SCOPE ERROR
          </span>
          <span className="text-[13px] text-zinc-400">
            Insufficient permissions. Grant <span className="font-mono text-zinc-300">documents</span> write access.
          </span>
        </div>
        <a
          href="/api/auth/login"
          className="px-4 py-1.5 rounded-md bg-blue-500 text-white text-xs font-semibold tracking-wide hover:bg-blue-400 transition-colors shadow-[0_0_10px_rgba(59,130,246,0.2)]"
        >
          Re-authorize
        </a>
      </div>
    );
  }

  const activity = metrics?.activity ?? "Idle";

  return (
    <div className="flex items-center gap-6 px-5 py-4 card-sovereign relative overflow-hidden flex-shrink-0">
      {/* Status dot + activity */}
      <div className="flex items-center gap-2.5 flex-shrink-0">
        <div
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            status === "idle" && "bg-zinc-600",
            status === "syncing" && "bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.6)] animate-pulse",
            status === "paused" && "bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.6)]",
            status === "done" && "bg-emerald-500",
            status === "error" && "bg-red-500"
          )}
        />
        <div className="flex flex-col">
          <span className="text-[0.6rem] font-bold uppercase tracking-[2px] text-zinc-500 font-mono">
            {status}
          </span>
          {status === "syncing" && (
            <span className="text-[0.5rem] text-zinc-600 font-mono truncate max-w-[100px]">
              {activity}
            </span>
          )}
          {status === "paused" && (
            <span className="text-[0.5rem] text-yellow-500/70 font-mono">
              Waiting to resume
            </span>
          )}
        </div>
      </div>

      {/* Total ETA countdown */}
      <div className="flex-shrink-0">
        <div className="text-[0.5rem] font-bold uppercase tracking-[1.5px] text-zinc-600 mb-0.5">
          Remaining
        </div>
        <div
          className={cn(
            "font-mono text-2xl font-bold leading-none tracking-wider tabular-nums",
            status === "syncing"
              ? "text-blue-400 drop-shadow-[0_0_20px_rgba(96,165,250,0.4)]"
              : status === "paused"
              ? "text-yellow-400/60"
              : "text-zinc-700"
          )}
        >
          {status === "syncing"
            ? formatHMS(remaining)
            : status === "paused" && remaining > 0
            ? formatHMS(remaining)
            : "--:--:--"}
        </div>
      </div>

      {/* Progress bar — inline */}
      <div className="flex-1 min-w-0">
        <div className="h-[2px] bg-white/[0.04] rounded-full overflow-hidden">
          <motion.div
            className={cn(
              "h-full rounded-full bg-blue-500",
              status === "syncing" && "neon-pulse"
            )}
            initial={{ width: "0%" }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[0.5rem] font-mono text-zinc-600 tabular-nums">
            {pct.toFixed(1)}%
          </span>
          {status === "syncing" && metrics?.wpm ? (
            <span className="text-[0.5rem] font-mono text-zinc-600 tabular-nums">
              {metrics.wpm} WPM
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
