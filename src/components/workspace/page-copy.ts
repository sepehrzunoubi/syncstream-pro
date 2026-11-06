/**
 * A copy the browser makes itself inlines the page's computed styles. The page draws every family in a
 * stack whose first face ("SS Space Arial", see space-faces.ts) exists only here, so another app would
 * name that as the text's font. The editor's own copy keeps each family's own stack (ClipboardHTML), so:
 *
 * - Ctrl+A outside a text field selects the document shown (the one being edited: the body, or a header
 *   or footer; the sync's read-only view while it shows), as in Docs, not the whole page;
 * - a copy whose selection takes in part of an editor without being inside it (one dragged in from the
 *   page's margin) copies that part as the editor copies it, the shown document's first;
 * - a copy in the read-only view (which ProseMirror leaves to the browser) is the editor's copy too;
 * - the headers and footers drawn on the other pages can't be selected (docs.css), as in Docs.
 *
 * Copied text has a line per paragraph, as Docs' has (COPY_TEXT).
 */

import { useEffect, useRef } from "react";
import { getTextBetween, getTextSerializersFromSchema } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";

/** Every editor on the page (TipTap keeps each on its element) */
function pageViews(): EditorView[] {
  const views: EditorView[] = [];
  for (const el of Array.from(document.querySelectorAll(".ProseMirror"))) {
    const view = (el as HTMLElement & { editor?: Editor }).editor?.view;
    if (view && !view.isDestroyed) views.push(view);
  }
  return views;
}

const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable=false])";

/** How a copy's text separates paragraphs: one newline each, as Docs' text/plain does */
export const COPY_TEXT = { blockSeparator: "\n" };

/** The part of the selection inside one editor (`first` tried first), copied as that editor copies */
export function editorCopyOf(range: Range, first?: EditorView | null): { html: string; text: string } | null {
  const views = pageViews();
  if (first && views.includes(first)) views.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
  for (const view of views) {
    const dom = view.dom;
    const inStart = dom.contains(range.startContainer);
    const inEnd = dom.contains(range.endContainer);
    if (inStart && inEnd && view.editable) return null; // the editor's own copy
    if (!range.intersectsNode(dom)) continue;
    const size = view.state.doc.content.size;
    const from = inStart ? view.posAtDOM(range.startContainer, range.startOffset) : 0;
    const to = inEnd ? view.posAtDOM(range.endContainer, range.endOffset) : size;
    if (to <= from) continue;
    const range0 = { from: Math.max(0, from), to: Math.min(size, to) };
    const { dom: html } = view.serializeForClipboard(view.state.doc.slice(range0.from, range0.to));
    // As TipTap writes the text of a copy, for this range (its serializer reads the editor's own selection)
    const text = getTextBetween(view.state.doc, range0, { ...COPY_TEXT, textSerializers: getTextSerializersFromSchema(view.state.schema) });
    return { html: html.innerHTML, text };
  }
  return null;
}

/** `shown`: the editor whose document is shown and edited (the body, a header or footer, the sync's view) */
export function usePageCopy(shown: Editor | null) {
  const ref = useRef(shown);
  ref.current = shown;
  const ready = !!shown;
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "a") return;
      const at = (e.target instanceof Element ? e.target : null) ?? document.activeElement;
      // A text field selects its own text; a dialog or menu keeps its keys
      if (at?.closest(`${FIELD}, [role=dialog], [role=menu], [role=listbox]`)) return;
      const editor = ref.current;
      if (!editor || editor.isDestroyed) return;
      e.preventDefault();
      if (editor.isEditable) { editor.chain().focus().selectAll().run(); return; }
      // The read-only view takes no focus: its text is selected on the page, and copied by onCopy
      document.getSelection()?.selectAllChildren(editor.view.dom);
    };
    const onCopy = (e: ClipboardEvent) => {
      if (e.defaultPrevented || !e.clipboardData) return;
      const sel = document.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) return;
      const editor = ref.current;
      const copy = editorCopyOf(sel.getRangeAt(0), editor && !editor.isDestroyed ? editor.view : null);
      if (!copy) return;
      e.clipboardData.setData("text/html", copy.html);
      e.clipboardData.setData("text/plain", copy.text);
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("copy", onCopy);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onCopy);
    };
  }, [ready]);
}
