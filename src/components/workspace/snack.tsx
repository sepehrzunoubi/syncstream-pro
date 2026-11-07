"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Setter } from "./doc-state";

/** Something went wrong: it stays until it is dismissed or another message takes its place */
const PROBLEM = /^(Couldn['’]t|Can['’]t|Google didn['’]t|Google is taking too long|Your Google sign-in|You['’]re offline)/;

/** How long a message shows: long enough to read it (null: until dismissed) */
export function snackDuration(text: string): number | null {
  if (PROBLEM.test(text)) return null;
  return Math.min(15_000, Math.max(6000, text.length * 60));
}

/**
 * The snackbar's message: hints from the editor show here, and it hides itself. The same message
 * again shows for its full time again.
 */
export function useSnack(): [string | null, Setter<string | null>] {
  const [state, setState] = useState<{ text: string; n: number } | null>(null);
  const setSnack: Setter<string | null> = useCallback((next) => {
    setState((cur) => {
      const text = typeof next === "function" ? next(cur?.text ?? null) : next;
      if (text == null) return null;
      // An update that leaves it as it is (setSnack((s) => s)) doesn't start it over
      if (typeof next === "function" && cur && text === cur.text) return cur;
      return { text, n: (cur?.n ?? 0) + 1 };
    });
  }, []);
  const snack = state?.text ?? null;
  useEffect(() => {
    const onHint = () => setSnack(`Use ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"}V to paste, or ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"}Shift+V to paste without formatting`);
    const onLocked = () => setSnack("That part of the document can't be changed here. Tables' shapes, chips and section breaks are edited in Google Docs.");
    const onImageFailed = (e: Event) => setSnack(`Couldn't add a pasted image${(e as CustomEvent<string | null>).detail ? `: ${(e as CustomEvent<string | null>).detail}` : ""}. It was left out.`);
    window.addEventListener("ss-paste-hint", onHint);
    window.addEventListener("ss-locked-hint", onLocked);
    window.addEventListener("ss-image-failed", onImageFailed);
    return () => { window.removeEventListener("ss-paste-hint", onHint); window.removeEventListener("ss-locked-hint", onLocked); window.removeEventListener("ss-image-failed", onImageFailed); };
  }, [setSnack]);
  // Snackbar auto-hide
  useEffect(() => {
    if (!state) return;
    const ms = snackDuration(state.text);
    if (ms == null) return;
    const id = setTimeout(() => setState((cur) => (cur === state ? null : cur)), ms);
    return () => clearTimeout(id);
  }, [state]);
  return [snack, setSnack];
}

export function Snackbar({ snack, action, onDismiss }: { snack: string | null; action?: { label: string; run: () => void } | null; onDismiss: () => void }) {
  return (
    <AnimatePresence>
      {snack && (
        <motion.div
          key={snack}
          className="ss-snackbar"
          role="status"
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
          transition={{ type: "spring", stiffness: 500, damping: 38 }}
        >
          <span className="text-[14px]">{snack}</span>
          {action && <button onClick={action.run}>{action.label}</button>}
          <button onClick={onDismiss}>Dismiss</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
