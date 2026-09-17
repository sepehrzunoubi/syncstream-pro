"use client";

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { formatHMS } from "@/lib/format";
import type { JobStatus } from "@/lib/sync-store";

interface HeroStatusProps {
  status: JobStatus | "idle";
  activity?: string;
  /** Wall-clock target for the countdown: the ETA while running, the start time while scheduled */
  targetAt?: number;
  progressPct: number;
  wpm?: number;
  scopeError?: boolean;
}

export function HeroStatus({ status, activity, targetAt, progressPct, wpm, scopeError }: HeroStatusProps) {
  const [remaining, setRemaining] = useState(0);
  const counting = status === "running" || status === "pending" || status === "scheduled";

  useEffect(() => {
    if (!counting || !targetAt) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(Math.max(0, targetAt - Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [counting, targetAt]);

  if (scopeError) {
    return (
      <div className="card-sovereign-glow p-4 flex items-center justify-between">
        <div>
          <span className="inline-block px-2 py-0.5 rounded text-[0.55rem] font-bold tracking-widest uppercase font-mono bg-red-500/10 text-red-400 border border-red-500/20 mr-3">
            Scope error
          </span>
          <span className="text-[13px] text-zinc-400">
            Google did not grant document access. Re-authorize to continue.
          </span>
        </div>
        <a
          href="/api/auth/login"
          className="px-4 py-1.5 rounded-md bg-blue-500 text-white text-xs font-semibold tracking-wide hover:bg-blue-400 transition-colors"
        >
          Re-authorize
        </a>
      </div>
    );
  }

  const label = status === "idle" ? "Ready" : status;
  const remainingLabel = status === "scheduled" ? "Starts in" : "Remaining";

  return (
    <div className="flex items-center gap-6 px-5 py-4 card-sovereign relative overflow-hidden flex-shrink-0">
      <div className="flex items-center gap-2.5 flex-shrink-0 min-w-[120px]">
        <div
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            status === "idle" && "bg-zinc-600",
            (status === "running" || status === "pending") && "bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.6)] animate-pulse",
            status === "scheduled" && "bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.6)]",
            status === "paused" && "bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.6)]",
            status === "done" && "bg-emerald-500",
            (status === "error" || status === "cancelled") && "bg-red-500"
          )}
        />
        <div className="flex flex-col">
          <span className="text-[0.6rem] font-bold uppercase tracking-[2px] text-zinc-500 font-mono">{label}</span>
          {activity && status !== "idle" && (
            <span className="text-[0.5rem] text-zinc-600 font-mono truncate max-w-[140px]">{activity}</span>
          )}
        </div>
      </div>

      <div className="flex-shrink-0">
        <div className="text-[0.5rem] font-bold uppercase tracking-[1.5px] text-zinc-600 mb-0.5">{remainingLabel}</div>
        <div
          className={cn(
            "font-mono text-2xl font-bold leading-none tracking-wider tabular-nums",
            status === "running" || status === "pending"
              ? "text-blue-400 drop-shadow-[0_0_20px_rgba(96,165,250,0.4)]"
              : status === "scheduled"
                ? "text-purple-300"
                : status === "paused"
                  ? "text-yellow-400/60"
                  : "text-zinc-700"
          )}
        >
          {counting && targetAt ? formatHMS(remaining) : "--:--:--"}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <div className="h-[2px] bg-white/[0.04] rounded-full overflow-hidden">
          <motion.div
            className={cn("h-full rounded-full bg-blue-500", status === "running" && "neon-pulse")}
            initial={{ width: "0%" }}
            animate={{ width: `${progressPct}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[0.5rem] font-mono text-zinc-600 tabular-nums">{progressPct.toFixed(1)}%</span>
          {status === "running" && wpm ? (
            <span className="text-[0.5rem] font-mono text-zinc-600 tabular-nums">{wpm} WPM</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
