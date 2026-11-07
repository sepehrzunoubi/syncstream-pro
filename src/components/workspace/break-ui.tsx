"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { describeBreak, formatBreak, parseBreakLength } from "@/lib/breaks";
import { aBreakOf } from "./break-marks";

/** A slim bar floating at the top of the canvas: what a click on the page does now, or what it waits for */
export function CanvasBar({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="ss-placing-bar ss-noprint"
      role="status"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** While a click places a break */
export function PlacingBar({ minutes, live, onDone }: { minutes: number; live?: boolean; onDone: () => void }) {
  return (
    <CanvasBar>
      <span className="ss-brk-chip">{formatBreak(minutes)}</span>
      <span>{aBreakOf(minutes)} starts after the word you click{live ? ", in text not typed yet" : ""}</span>
      <button type="button" className="ss-link-btn" onClick={onDone}>Done</button>
    </CanvasBar>
  );
}

/** While the document asked for opens: the page under it is the one before, and waits */
export function OpeningBar() {
  return (
    <CanvasBar>
      <span className="h-4 w-4 flex-none animate-spin rounded-full border-2 border-[#d3e3fd] border-t-[#0b57d0]" aria-hidden />
      <span>Opening the document</span>
    </CanvasBar>
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
  useEffect(() => { input.current?.focus({ preventScroll: true }); input.current?.select(); }, []);
  useEffect(() => {
    const outside = (e: Event) => !ref.current?.contains(e.target as Node);
    const onDown = (e: MouseEvent) => { if (outside(e)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // It is placed by its pill when it opened: once the page scrolls or the window resizes, it would
    // point at another word
    const onMove = (e: Event) => { if (outside(e)) onClose(); };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onClose);
    };
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
