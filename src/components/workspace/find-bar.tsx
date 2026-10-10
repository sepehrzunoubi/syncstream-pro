"use client";

import React, { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Icon } from "./icon";
import { Dialog } from "./dialog";
import { findKey, type FindState } from "./find";

/** Docs' find bar (Ctrl+F) and Find and replace dialog (Ctrl+H) */
export function FindBar({ editor }: { editor: Editor | null }) {
  const [mode, setMode] = useState<"closed" | "bar" | "dialog">("closed");
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [diacritics, setDiacritics] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const st = useEditorState({ editor, selector: ({ editor: e }) => (e ? findKey.getState(e.state) ?? null : null) }) as FindState | null;

  useEffect(() => {
    const onOpen = (e: Event) => {
      const kind = (e as CustomEvent<string>).detail === "dialog" ? "dialog" : "bar";
      // Start from the selected text, as Docs does
      if (editor && !editor.state.selection.empty) {
        const sel = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");
        if (sel && !sel.includes("\n")) setQuery(sel);
      }
      setMode(kind);
    };
    window.addEventListener("ss-find", onOpen);
    // From anywhere in the workspace, as in Docs (the editor's own keymap already handled it when focused)
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "f" || e.key === "h") { e.preventDefault(); onOpen(new CustomEvent("ss-find", { detail: e.key === "f" ? "bar" : "dialog" })); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("ss-find", onOpen); window.removeEventListener("keydown", onKey); };
  }, [editor]);

  // The input takes focus as soon as the bar or dialog is on screen
  useEffect(() => {
    if (mode === "closed") return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [mode]);
  useEffect(() => {
    if (!editor) return;
    if (mode === "closed") { editor.commands.setFind(null); return; }
    editor.commands.setFind({ query, matchCase, regex, ignoreDiacritics: diacritics });
  }, [editor, mode, query, matchCase, regex, diacritics]);

  const close = () => { setMode("closed"); editor?.commands.focus(); };
  const next = () => editor?.commands.findNext();
  const prev = () => editor?.commands.findPrevious();
  const count = st?.matches.length ?? 0;
  const counter = query ? (count ? `${(st?.current ?? -1) + 1} of ${count}` : "No results") : "";
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  if (mode === "bar") {
    return (
      <div className="ss-find-anchor"><div className="ss-find-bar" role="search" aria-label="Find in document">
        <input ref={inputRef} className="ss-find-input" placeholder="Find in document" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} aria-label="Find in document" />
        <span className={`ss-find-count ${query && !count ? "ss-find-none" : ""}`}>{counter}</span>
        <button type="button" className="ss-icon-btn" onClick={prev} disabled={!count} aria-label="Previous match" title="Previous match (Shift+Enter)"><Icon name="keyboard_arrow_up" /></button>
        <button type="button" className="ss-icon-btn" onClick={next} disabled={!count} aria-label="Next match" title="Next match (Enter)"><Icon name="keyboard_arrow_down" /></button>
        <button type="button" className="ss-icon-btn" onClick={() => { setMode("dialog"); setTimeout(() => inputRef.current?.focus(), 0); }} aria-label="More options" title="More options"><Icon name="more_vert" /></button>
        <button type="button" className="ss-icon-btn" onClick={close} aria-label="Close" title="Close"><Icon name="close" /></button>
      </div></div>
    );
  }
  if (mode !== "dialog") return null;
  return (
    <Dialog open title="Find and replace" onClose={close} width={520} footer={
      <>
        <button type="button" className="ss-btn ss-btn-outlined" disabled={!count} onClick={() => { editor?.commands.replaceCurrent(replacement); }}>Replace</button>
        <button type="button" className="ss-btn ss-btn-outlined" disabled={!count} onClick={() => { editor?.commands.replaceAll(replacement); }}>Replace all</button>
        <span className="flex-1" />
        <button type="button" className="ss-btn ss-btn-outlined" disabled={!count} onClick={prev}>Previous</button>
        <button type="button" className="ss-btn ss-btn-outlined" disabled={!count} onClick={next}>Next</button>
        <button type="button" className="ss-btn ss-btn-filled" onClick={close}>Done</button>
      </>
    }>
      <div className="flex flex-col gap-4">
        <label className="grid grid-cols-[110px_1fr] items-center gap-3">
          <span className="text-[14px]">Find</span>
          <span className="relative flex items-center">
            <input ref={inputRef} className="ss-input pr-20" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} aria-label="Find" />
            <span className={`absolute right-3 text-[12px] ${query && !count ? "text-[var(--ss-danger)]" : "text-[var(--ss-text-3)]"}`}>{counter}</span>
          </span>
        </label>
        <label className="grid grid-cols-[110px_1fr] items-center gap-3">
          <span className="text-[14px]">Replace with</span>
          <input className="ss-input" value={replacement} onChange={(e) => setReplacement(e.target.value)} aria-label="Replace with" />
        </label>
        <div className="ml-[122px] flex flex-col gap-2 text-[14px]">
          <label className="ss-checkbox"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
          <label className="ss-checkbox"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Match using regular expressions{st?.error && <span className="ml-2 text-[12px] text-[var(--ss-danger)]">Invalid expression</span>}</label>
          <label className="ss-checkbox"><input type="checkbox" checked={diacritics} onChange={(e) => setDiacritics(e.target.checked)} /> Ignore Latin diacritics (e.g. ä = a, E = É)</label>
        </div>
      </div>
    </Dialog>
  );
}
