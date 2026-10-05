"use client";

import React from "react";
import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { StyleProfile } from "@/lib/style-engine";
import { usablePairs } from "@/lib/style-engine";
import { formatClock } from "@/lib/format";

interface StyleRailProps {
  profiles: StyleProfile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export function profileLine(p: StyleProfile): string {
  const n = usablePairs(p.pairs).length;
  const pairs = `${n} ${n === 1 ? "pair" : "pairs"}`;
  return p.analysis && p.analyzedAt ? `${pairs} · profile from ${formatClock(p.analyzedAt)}` : `${pairs} · not analyzed yet`;
}

/** The list of saved styles, on the left like the list of syncs */
export function StyleRail({ profiles, selectedId, onSelect, onCreate }: StyleRailProps) {
  return (
    <nav className="flex h-full w-[264px] flex-none flex-col overflow-y-auto px-3 pb-4" aria-label="Styles">
      <div className="flex h-10 items-center justify-between pl-3">
        <h2 className="text-[14px] font-medium">Styles</h2>
        <button className="ss-icon-btn h-9 w-9 rounded-full" onClick={onCreate} title="New style" aria-label="New style">
          <Plus className="h-5 w-5" />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {profiles.map((p) => (
          <motion.div
            key={p.id}
            layout="position"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          >
            <button
              onClick={() => onSelect(p.id)}
              aria-current={p.id === selectedId ? "true" : undefined}
              className={`relative flex w-full items-start gap-3 rounded-2xl px-3 py-2 text-left transition-colors duration-150 ${p.id === selectedId ? "text-[var(--ss-on-pressed)]" : "hover:bg-[var(--ss-hover)]"}`}
            >
              {p.id === selectedId && (
                <motion.span layoutId="ss-style-rail-active" className="absolute inset-0 rounded-2xl bg-[#d3e3fd]" transition={{ type: "spring", stiffness: 520, damping: 42 }} />
              )}
              <span className="relative mt-[7px] h-2 w-2 flex-none rounded-full" style={{ background: p.analysis ? "#146c2e" : "#8e918f" }} />
              <span className="relative min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-5">{p.name || "Untitled style"}</span>
                <span className="block truncate text-[12px] leading-4 text-[var(--ss-text-2)]">{profileLine(p)}</span>
              </span>
            </button>
          </motion.div>
        ))}
      </AnimatePresence>

      {profiles.length === 0 && (
        <p className="mt-4 px-3 text-[12px] leading-4 text-[var(--ss-text-3)]">
          Styles you create appear here. They are kept on this device.
        </p>
      )}
    </nav>
  );
}
