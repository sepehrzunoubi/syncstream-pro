/**
 * How the body editor and the read-only viewer are set up: their
 * extensions, their DOM attributes, and the paste and drop handlers.
 */

import { useEffect, type MutableRefObject } from "react";
import type { Editor, EditorOptions } from "@tiptap/react";
import { editorExtensions } from "./extensions";
import { ProgressMarks } from "./pagination";
import { clipboardTextParser, DroppedBreaks, handlePaste, imageFilesOf, LineBreaks, transformPastedHTML } from "./paste";

export const bodyExtensions = [...editorExtensions, DroppedBreaks, LineBreaks];

/**
 * Typing and pasting behave as in Google Docs: lists start from "* " and
 * "1. " (Docs' list detection), but Markdown marks typed or pasted
 * (*italic*, ~~strike~~) stay text, as Docs keeps them. URLs in pasted
 * plain text become links, as in Docs; formatted text keeps the links it has.
 */
export const DOCS_RULES: Pick<EditorOptions, "enableInputRules" | "enablePasteRules"> = { enableInputRules: ["docFormat"], enablePasteRules: ["link"] };
/** A read-only copy of the editor shows a running sync, paginated the same way */
export const viewerExtensions = [...editorExtensions, ProgressMarks];

/** Pasted or dropped image files are uploaded, then inserted; the handler is set by the workspace once it exists */
export type ImageFilesHandler = (files: File[], at?: number) => void;

export function bodyEditorProps(imageFilesRef: MutableRefObject<ImageFilesHandler>): EditorOptions["editorProps"] {
  return {
    attributes: { class: "ss-doc", spellcheck: "true", "aria-label": "Text to sync" },
    transformPastedHTML,
    handlePaste: (view, event, slice) => handlePaste(view, event, slice, (files) => imageFilesRef.current(files)),
    clipboardTextParser,
    handleDrop: (view, event, _slice, moved) => {
      if (moved) return false;
      const files = imageFilesOf(event.dataTransfer?.files);
      if (!files.length) return false;
      event.preventDefault();
      imageFilesRef.current(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
      return true;
    },
  };
}

export function viewerEditorProps(): EditorOptions["editorProps"] {
  return { attributes: { class: "ss-doc", "aria-label": "Text being typed into Google Docs", "aria-readonly": "true" } };
}

/** For browser automation: window.ssEditor when localStorage.ss_debug is set */
export function useEditorDebugHook(editor: Editor | null) {
  useEffect(() => {
    try { if (editor && localStorage.getItem("ss_debug")) (window as unknown as { ssEditor?: unknown }).ssEditor = editor; } catch { /* storage blocked */ }
  }, [editor]);
}
