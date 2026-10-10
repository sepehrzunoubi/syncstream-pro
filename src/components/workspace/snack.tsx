"use client";

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Setter } from "./doc-state";

/** The snackbar's message: hints from the editor show here, and it hides itself */
export function useSnack(): [string | null, Setter<string | null>] {
  const [snack, setSnack] = useState<string | null>(null);
  useEffect(() => {
    const onHint = () => setSnack(`Use ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"}V to paste, or ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"}Shift+V to paste without formatting`);
    const onLocked = () => setSnack("That part of the document can't be changed here. Tables' shapes, chips and section breaks are edited in Google Docs.");
    window.addEventListener("ss-paste-hint", onHint);
    window.addEventListener("ss-locked-hint", onLocked);
    return () => { window.removeEventListener("ss-paste-hint", onHint); window.removeEventListener("ss-locked-hint", onLocked); };
  }, []);
  // Snackbar auto-hide
  useEffect(() => {
    if (!snack) return;
    const id = setTimeout(() => setSnack(null), 6000);
    return () => clearTimeout(id);
  }, [snack]);
  return [snack, setSnack];
}

export function Snackbar({ snack, onDismiss }: { snack: string | null; onDismiss: () => void }) {
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
          <button onClick={onDismiss}>Dismiss</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
