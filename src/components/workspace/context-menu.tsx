"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Dialog } from "./dialog";

function modKey() { return /Mac|iPhone|iPad/.test(typeof navigator === "undefined" ? "" : navigator.platform) ? "⌘" : "Ctrl+"; }

/** Docs' right-click menu on the page */
export function ContextMenu({ editor }: { editor: Editor | null }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onMenu = (e: MouseEvent) => { e.preventDefault(); setAt({ x: e.clientX, y: e.clientY }); };
    dom.addEventListener("contextmenu", onMenu);
    return () => dom.removeEventListener("contextmenu", onMenu);
  }, [editor]);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey); window.removeEventListener("scroll", close, true); };
  }, [at]);
  if (!at || !editor) return null;
  const mod = modKey();
  const empty = editor.state.selection.empty;
  const run = (fn: () => void) => () => { setAt(null); editor.commands.focus(); fn(); };
  const item = (label: string, shortcut: string | null, onClick: () => void, disabled = false) => (
    <button type="button" role="menuitem" className="ss-menu-item" disabled={disabled} onMouseDown={(e) => e.stopPropagation()} onClick={run(onClick)}>
      <span className="ss-check" /><span className="min-w-0 flex-1 truncate text-left">{label}</span>{shortcut && <span className="ss-shortcut">{shortcut}</span>}
    </button>
  );
  const left = Math.min(at.x, window.innerWidth - 260);
  const top = Math.min(at.y, window.innerHeight - 320);
  return createPortal(
    <div className="ss-menu ss-context-menu" role="menu" style={{ position: "fixed", left, top, zIndex: 60 }} onMouseDown={(e) => e.stopPropagation()}>
      {item("Cut", `${mod}X`, () => document.execCommand("cut"), empty)}
      {item("Copy", `${mod}C`, () => document.execCommand("copy"), empty)}
      {item("Paste", `${mod}V`, () => window.dispatchEvent(new CustomEvent("ss-paste-hint")))}
      {item("Paste without formatting", `${mod}Shift+V`, () => window.dispatchEvent(new CustomEvent("ss-paste-hint")))}
      {item("Delete", null, () => editor.commands.deleteSelection(), empty)}
      <div className="ss-menu-sep" />
      {item("Link", `${mod}K`, () => window.dispatchEvent(new CustomEvent("ss-open-link")))}
      <div className="ss-menu-sep" />
      {item("Select all", `${mod}A`, () => editor.commands.selectAll())}
    </div>,
    document.body
  );
}

const GROUPS: { title: string; rows: [string, string][] }[] = [
  { title: "Common actions", rows: [["Cut", "Ctrl+X"], ["Copy", "Ctrl+C"], ["Paste", "Ctrl+V"], ["Paste without formatting", "Ctrl+Shift+V"], ["Undo", "Ctrl+Z"], ["Redo", "Ctrl+Y"], ["Insert or edit link", "Ctrl+K"], ["Find", "Ctrl+F"], ["Find and replace", "Ctrl+H"], ["Print", "Ctrl+P"], ["Select all", "Ctrl+A"], ["Keyboard shortcuts", "Ctrl+/"]] },
  { title: "Text formatting", rows: [["Bold", "Ctrl+B"], ["Italic", "Ctrl+I"], ["Underline", "Ctrl+U"], ["Strikethrough", "Alt+Shift+5"], ["Superscript", "Ctrl+."], ["Subscript", "Ctrl+,"], ["Clear formatting", "Ctrl+\\"], ["Increase font size", "Ctrl+Shift+."], ["Decrease font size", "Ctrl+Shift+,"]] },
  { title: "Paragraph formatting", rows: [["Increase indent", "Ctrl+]"], ["Decrease indent", "Ctrl+["], ["Normal text", "Ctrl+Alt+0"], ["Heading 1 to 6", "Ctrl+Alt+1 to 6"], ["Left align", "Ctrl+Shift+L"], ["Center align", "Ctrl+Shift+E"], ["Right align", "Ctrl+Shift+R"], ["Justify", "Ctrl+Shift+J"], ["Numbered list", "Ctrl+Shift+7"], ["Bulleted list", "Ctrl+Shift+8"], ["Checklist", "Ctrl+Shift+9"], ["Nest a list item", "Tab"], ["Outdent a list item", "Shift+Tab"]] },
  { title: "Inserting", rows: [["Page break", "Ctrl+Enter"], ["Footnote", "Ctrl+Alt+F"], ["New line in the same paragraph", "Shift+Enter"]] },
];

/** Help > Keyboard shortcuts (Ctrl+/) */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mod = modKey();
  const show = (s: string) => (mod === "⌘" ? s.replace(/Ctrl\+/g, "⌘") : s);
  return (
    <Dialog open={open} title="Keyboard shortcuts" onClose={onClose} width={560} footer={<><span className="flex-1" /><button type="button" className="ss-btn ss-btn-filled" onClick={onClose}>Done</button></>}>
      <div className="ss-shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>{g.rows.map(([label, keys]) => (<div key={label}><dt>{label}</dt><dd>{show(keys)}</dd></div>))}</dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
