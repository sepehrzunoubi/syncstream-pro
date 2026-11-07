"use client";

/**
 * Manual breaks while composing: the breaks placed on the page (marks on their words), placing new
 * ones, the list in the panel and the popover a pill opens.
 *
 * Placing is something the user asks for, on the page in front of them: it starts when they type a
 * length or press "Place on page", and ends with Done, Esc, another document or tab, another Breaks
 * mode, or anything that takes the page away (a sync starting or shown, one typing into it). It is
 * never restored from saved settings, and only runs on an open page that has new text to break.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { parseBreakLength } from "@/lib/breaks";
import { BREAK_PILL_EVENT, breakUiKey, clearBreaks, removeBreak, setBreak, setBreakUi, type BreakPillDetail, type BreakRange } from "./break-marks";
import { escapeIsFree } from "./keys";
import type { BreaksMode, ManualBreakRow } from "./sync-panel";
import type { Setter } from "./doc-state";

export const BREAKS_CLEARED = "Breaks cleared";

export interface BreakPopover { from: number; to: number; minutes: number; rect: DOMRect }

/** The page's breaks as the plugin tracks them */
const rangesOf = (editor: Editor): BreakRange[] => breakUiKey.getState(editor.state)?.ranges ?? [];
const sameRows = (a: ManualBreakRow[], b: ManualBreakRow[] | null) => !!b && a.length === b.length && a.every((r, i) => r.id === b[i].id && r.from === b[i].from && r.to === b[i].to && r.minutes === b[i].minutes && r.word === b[i].word);

export function useManualBreaks({ editor, breaksMode, breakLength, setBreakLength, docKey, active, canPlace: open, setSnack }: {
  editor: Editor | null;
  breaksMode: BreaksMode;
  breakLength: string;
  setBreakLength: Setter<string>;
  /** The document and tab on the page: placing, the popover and Undo belong to it alone */
  docKey: string;
  /** Composing on an editable page: no sync shown, none starting, none typing into this document */
  active: boolean;
  /** The page is open: its document has loaded, or there is none */
  canPlace: boolean;
  setSnack: Setter<string | null>;
}) {
  const minutes = parseBreakLength(breakLength);
  const manual = breaksMode === "manual";
  // New words a break can follow, as the page has them now (not once typing pauses)
  const hasNew = useEditorState({ editor, selector: ({ editor: e }: { editor: Editor | null }) => !!e && !!breakUiKey.getState(e.state)?.hasNew }) ?? false;
  const canPlace = open && hasNew;
  // The page placing was asked for on; null when it wasn't
  const [placingFor, setPlacingFor] = useState<string | null>(null);
  const placing = manual && active && canPlace && minutes != null && placingFor === docKey ? minutes : null;
  const now = useRef({ docKey, canPlace, active, manual });
  now.current = { docKey, canPlace, active, manual };

  const startPlacing = useCallback(() => {
    const n = now.current;
    if (n.manual && n.active && n.canPlace) setPlacingFor(n.docKey);
  }, []);
  const endPlacing = useCallback(() => setPlacingFor(null), []);
  const togglePlacing = useCallback(() => { if (placing != null) endPlacing(); else startPlacing(); }, [placing, startPlacing, endPlacing]);
  /** The length field changed: a length that reads is a request to place it */
  const editLength = useCallback((v: string) => {
    setBreakLength(v);
    if (parseBreakLength(v) != null) startPlacing();
  }, [setBreakLength, startPlacing]);
  // Anything that takes the page away ends placing; it doesn't come back by itself
  useEffect(() => { if (!active || !canPlace) setPlacingFor(null); }, [active, canPlace]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    setBreakUi(editor.view, { placing, placeLive: false, hover: null, showBreaks: manual });
  }, [editor, placing, manual]);
  useEffect(() => {
    if (placing == null) return;
    const onKey = (e: KeyboardEvent) => { if (escapeIsFree(e, ["#ss-break-length"])) setPlacingFor(null); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [placing]);

  const rows = useEditorState({
    editor,
    selector: ({ editor: e }: { editor: Editor | null }): ManualBreakRow[] => (e ? rangesOf(e).map((r) => ({ ...r, word: e.state.doc.textBetween(r.from, r.to) })) : []),
    equalityFn: sameRows,
  }) ?? [];

  /** A break as it is now (the row may be from before the last change) */
  const current = useCallback((r: BreakRange): BreakRange | null => {
    if (!editor) return null;
    const all = rangesOf(editor);
    return (r.id != null ? all.find((x) => x.id === r.id) : null) ?? all.find((x) => x.from === r.from && x.to === r.to) ?? null;
  }, [editor]);
  const remove = useCallback((r: BreakRange) => { const c = current(r); if (editor && c) removeBreak(editor, c.from, c.to); }, [editor, current]);

  // Clear all, and its Undo: the breaks it took, moved along with any edit since
  const undoRef = useRef<BreakRange[] | null>(null);
  const dropUndo = useCallback(() => {
    undoRef.current = null;
    setSnack((s) => (s === BREAKS_CLEARED ? null : s));
  }, [setSnack]);
  const clear = useCallback(() => {
    if (!editor) return;
    undoRef.current = rangesOf(editor);
    clearBreaks(editor);
    setSnack(BREAKS_CLEARED);
  }, [editor, setSnack]);
  const undoClear = useCallback(() => {
    const ranges = undoRef.current;
    undoRef.current = null;
    setSnack(null);
    if (!editor || !ranges?.length) return;
    const type = editor.schema.marks.syncBreak;
    const size = editor.state.doc.content.size;
    let tr = editor.state.tr;
    for (const r of ranges) if (r.from < r.to && r.to <= size) tr = tr.addMark(r.from, r.to, type.create({ minutes: r.minutes }));
    editor.view.dispatch(tr);
  }, [editor, setSnack]);
  const hover = useCallback((r: BreakRange | null) => {
    if (!editor) return;
    const c = r && current(r);
    setBreakUi(editor.view, { flash: c ? { from: c.from, to: c.to } : null });
  }, [editor, current]);
  const jump = useCallback((r: BreakRange) => {
    const c = current(r);
    if (!editor || !c) return;
    const { node } = editor.view.domAtPos(c.from);
    (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setBreakUi(editor.view, { flash: { from: c.from, to: c.to } });
  }, [editor, current]);

  // A pill on the page opens its popover
  const [popover, setPopover] = useState<BreakPopover | null>(null);
  useEffect(() => {
    if (!manual) return;
    const onPill = (e: Event) => {
      const d = (e as CustomEvent<BreakPillDetail>).detail;
      if (d.live || d.from < 0 || !editor || d.dom !== editor.view.dom) return;
      setPopover({ from: d.from, to: d.to, minutes: d.minutes, rect: d.rect });
    };
    window.addEventListener(BREAK_PILL_EVENT, onPill);
    return () => window.removeEventListener(BREAK_PILL_EVENT, onPill);
  }, [editor, manual]);
  const changeLength = useCallback((p: BreakPopover, m: number) => {
    if (editor && p.to <= editor.state.doc.content.size) setBreak(editor, p.from, p.to, m);
    setPopover(null);
  }, [editor]);
  const removeAt = useCallback((p: BreakPopover) => {
    if (editor && p.to <= editor.state.doc.content.size) removeBreak(editor, p.from, p.to);
    setPopover(null);
  }, [editor]);

  // The popover and Undo hold places in the page: any change to it moves them. A popover closes (its
  // pill may have moved or gone); Undo's breaks move with the text, and go when the page is replaced
  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({ transaction: tr }: { transaction: Transaction }) => {
      if (!tr.docChanged) return;
      setPopover(null);
      const u = undoRef.current;
      if (!u) return;
      const moved = u.map((r) => ({ ...r, from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })).filter((r) => r.to > r.from);
      if (moved.length) undoRef.current = moved;
      else dropUndo();
    };
    editor.on("transaction", onTransaction);
    return () => { editor.off("transaction", onTransaction); };
  }, [editor, dropUndo]);
  // Another document, tab or mode: nothing of the last one carries over
  useEffect(() => {
    setPlacingFor(null);
    setPopover(null);
    dropUndo();
  }, [docKey, breaksMode, dropUndo]);

  return {
    minutes, placing, canPlace: active && canPlace, startPlacing, endPlacing, togglePlacing, editLength, rows, remove, clear, undoClear, hover, jump,
    popover, closePopover: useCallback(() => setPopover(null), []), changeLength, removeAt,
  };
}
