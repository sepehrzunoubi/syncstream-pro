"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { describeBreak, formatBreak, parseBreakLength } from "@/lib/breaks";

/** The slim bar on the canvas while a click places a break */
export function PlacingBar({ minutes, live, onDone }: { minutes: number; live?: boolean; onDone: () => void }) {
  return (
    <motion.div
      className="ss-placing-bar ss-noprint"
      role="status"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
    >
      <span className="ss-brk-chip">{formatBreak(minutes)}</span>
      <span>Click {live ? "a word not typed yet" : "a word"}: the {describeBreak(minutes)} break starts after it</span>
      <button type="button" className="ss-link-btn" onClick={onDone}>Done</button>
    </motion.div>
  );
}

/** A break's length and Remove, by its pill on the page */
export function BreakPopover({ rect, minutes, title, onSave, onRemove, onClose, extra }: {
  rect: DOMRect;
  minutes: number;
  title?: string;
  onSave: (minutes: number) => void;
  onRemove?: () => void;
  onClose: () => void;
  /** More actions (the break on now: End now) */
  extra?: React.ReactNode;
}) {
  const [value, setValue] = useState(formatBreak(minutes));
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const parsed = parseBreakLength(value);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("mousedown", onDown, true); window.removeEventListener("keydown", onKey, true); };
  }, [onClose]);
  const width = 248;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
  const below = rect.bottom + 8 + 150 < window.innerHeight;
  const style: React.CSSProperties = below ? { left, top: rect.bottom + 6, width } : { left, bottom: window.innerHeight - rect.top + 6, width };
  return (
    <motion.div
      ref={ref}
      className="ss-brk-popover"
      role="dialog"
      aria-label="Break"
      style={style}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
    >
      {title && <div className="mb-2 text-[13px] text-[var(--ss-text-2)]">{title}</div>}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (parsed != null) onSave(parsed); }}
      >
        <input
          ref={input}
          className="ss-input h-9"
          aria-label="Break length"
          value={value}
          aria-invalid={parsed == null ? true : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="ss-btn ss-btn-tonal h-9 px-4" disabled={parsed == null || parsed === minutes}>Save</button>
      </form>
      <p className="ss-field-help" data-error={parsed == null ? "true" : undefined}>{parsed == null ? "Try 33m or 1h 5m." : describeBreak(parsed)}</p>
      {(onRemove || extra) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {extra ?? <span />}
          {onRemove && <button type="button" className="ss-link-btn text-[#b3261e]" onClick={onRemove}>Remove</button>}
        </div>
      )}
    </motion.div>
  );
}
