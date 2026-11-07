"use client";

/**
 * Manual breaks while composing: the breaks placed on the page (marks on their words), placing new
 * ones as soon as a length reads, the list in the panel and the popover a pill opens.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { parseBreakLength } from "@/lib/breaks";
import { BREAK_PILL_EVENT, breakRanges, clearBreaks, removeBreak, setBreak, setBreakUi, type BreakPillDetail, type BreakRange } from "./break-marks";
import type { BreaksMode, ManualBreakRow } from "./sync-panel";
import type { Setter } from "./doc-state";

export const BREAKS_CLEARED = "Breaks cleared";

export interface BreakPopover { from: number; to: number; minutes: number; rect: DOMRect }

export function useManualBreaks({ editor, breaksMode, breakLength, active, setSnack }: {
  editor: Editor | null;
  breaksMode: BreaksMode;
  breakLength: string;
  /** Composing (not viewing a sync) with an editable page */
  active: boolean;
  setSnack: Setter<string | null>;
}) {
  const minutes = parseBreakLength(breakLength);
  const manual = breaksMode === "manual";
  // Placing is on as soon as a length reads; Done or Esc turns it off until the length changes
  const [placingOff, setPlacingOff] = useState(false);
  useEffect(() => { setPlacingOff(false); }, [breakLength, breaksMode]);
  const placing = manual && active && minutes != null && !placingOff ? minutes : null;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    setBreakUi(editor.view, { placing, placeLive: false, hover: null });
  }, [editor, placing]);
  useEffect(() => {
    if (placing == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPlacingOff(true); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing]);

  const rows = useEditorState({
    editor,
    selector: ({ editor: e }): ManualBreakRow[] => (e ? breakRanges(e.state.doc).map((r) => ({ ...r, word: e.state.doc.textBetween(r.from, r.to) })) : []),
    equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  }) ?? [];

  const remove = useCallback((r: BreakRange) => { if (editor) removeBreak(editor, r.from, r.to); }, [editor]);
  const undoRef = useRef<BreakRange[] | null>(null);
  const clear = useCallback(() => {
    if (!editor) return;
    undoRef.current = breakRanges(editor.state.doc);
    clearBreaks(editor);
    setSnack(BREAKS_CLEARED);
  }, [editor, setSnack]);
  const undoClear = useCallback(() => {
    if (!editor || !undoRef.current) return;
    const type = editor.schema.marks.syncBreak;
    let tr = editor.state.tr;
    for (const r of undoRef.current) if (r.to <= tr.doc.content.size) tr = tr.addMark(r.from, r.to, type.create({ minutes: r.minutes }));
    editor.view.dispatch(tr);
    undoRef.current = null;
    setSnack(null);
  }, [editor, setSnack]);
  const hover = useCallback((r: BreakRange | null) => { if (editor) setBreakUi(editor.view, { flash: r ? { from: r.from, to: r.to } : null }); }, [editor]);
  const jump = useCallback((r: BreakRange) => {
    if (!editor) return;
    const { node } = editor.view.domAtPos(r.from);
    (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setBreakUi(editor.view, { flash: { from: r.from, to: r.to } });
  }, [editor]);

  // A pill on the page opens its popover
  const [popover, setPopover] = useState<BreakPopover | null>(null);
  useEffect(() => {
    const onPill = (e: Event) => {
      const d = (e as CustomEvent<BreakPillDetail>).detail;
      if (d.live || d.from < 0) return;
      setPopover({ from: d.from, to: d.to, minutes: d.minutes, rect: d.rect });
    };
    window.addEventListener(BREAK_PILL_EVENT, onPill);
    return () => window.removeEventListener(BREAK_PILL_EVENT, onPill);
  }, []);
  const changeLength = useCallback((p: BreakPopover, m: number) => { if (editor) setBreak(editor, p.from, p.to, m); setPopover(null); }, [editor]);
  const removeAt = useCallback((p: BreakPopover) => { if (editor) removeBreak(editor, p.from, p.to); setPopover(null); }, [editor]);

  return {
    minutes, placing, endPlacing: () => setPlacingOff(true), rows, remove, clear, undoClear, hover, jump,
    popover, closePopover: () => setPopover(null), changeLength, removeAt,
  };
}
