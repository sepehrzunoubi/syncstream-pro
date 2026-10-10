/**
 * The draft: sync settings, and what was typed with no document open. It
 * is restored once the editor exists and saved to this device as it
 * changes; a document's additions are kept per document.
 */

import { useEffect, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
import type { EditorNode } from "@/lib/rich-text";
import { parsePageSetup, type PageSetup } from "@/lib/page-setup";
import { hasPending } from "@/lib/doc-model";
import { randomSeed } from "@/lib/prng";
import { takeStyleHandoff } from "@/components/style/style-store";
import type { BreaksMode } from "./sync-panel";
import { loadDocument } from "./doc-sync";
import { markAllAdded, plainToDoc } from "./doc-json";
import { loadDraft, readPageDefault, saveDraft, writeAdditions, type Draft } from "./storage";
import type { DocContent, DocRefs, Setter } from "./doc-state";

export function useDraft({ editor, refs, selectedDocId, setSelectedDocId, zoom, setZoom, pageless, setPageless, pageSetup, setPageSetup, docContent, docJSON, setDocJSON, setSnack }: {
  editor: Editor | null;
  refs: DocRefs;
  selectedDocId: string;
  setSelectedDocId: Setter<string>;
  zoom: number | "fit";
  setZoom: Setter<number | "fit">;
  pageless: boolean;
  setPageless: Setter<boolean>;
  pageSetup: PageSetup;
  setPageSetup: Setter<PageSetup>;
  docContent: DocContent | null;
  docJSON: JSONContent | null;
  setDocJSON: Setter<JSONContent | null>;
  setSnack: Setter<string | null>;
}) {
  const { legacyTextRef, revisionRef } = refs;
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [breaksMode, setBreaksMode] = useState<BreaksMode>("auto");
  const [customBreaks, setCustomBreaks] = useState<number[]>([]);
  const [typoFrequency, setTypoFrequency] = useState(0.5);
  const [startInMinutes, setStartInMinutes] = useState(0);
  const [seed, setSeed] = useState(() => randomSeed());
  const [draftLoaded, setDraftLoaded] = useState(false);

  // Restore the draft once the editor exists
  useEffect(() => {
    if (!editor || draftLoaded) return;
    const d = loadDraft();
    if (d.doc) {
      const text = markAllAdded(d.doc as EditorNode);
      if (d.selectedDocId) legacyTextRef.current = hasPending(text) ? text : null;
      else loadDocument(editor, text, false);
    }
    setDocJSON(editor.getJSON());
    if (d.selectedDocId) setSelectedDocId(d.selectedDocId);
    if (d.durationMinutes !== undefined) setDurationMinutes(d.durationMinutes);
    if (d.breaksMode) setBreaksMode(d.breaksMode);
    if (Array.isArray(d.customBreaks)) setCustomBreaks(d.customBreaks);
    if (typeof d.typoFrequency === "number") setTypoFrequency(d.typoFrequency);
    if (typeof d.zoom === "number" || d.zoom === "fit") setZoom(d.zoom);
    if (typeof d.pageless === "boolean") setPageless(d.pageless);
    const draftSetup = d.pageSetup ? parsePageSetup(d.pageSetup) : null;
    const def = readPageDefault();
    if (draftSetup) setPageSetup(draftSetup);
    else if (def) { setPageSetup(def.setup); if (typeof d.pageless !== "boolean") setPageless(def.pageless); }
    setDraftLoaded(true);
  }, [editor, draftLoaded, legacyTextRef, setDocJSON, setSelectedDocId, setZoom, setPageless, setPageSetup]);

  // Text handed over from the Style engine tab goes in at the end, as new text to sync
  useEffect(() => {
    if (!editor || !draftLoaded) return;
    const text = takeStyleHandoff();
    if (!text) return;
    editor.chain().focus("end").insertContent(plainToDoc(text).content ?? []).run();
    setDocJSON(editor.getJSON());
    setSnack("The text from the Style engine was added. It glows until a sync types it in.");
  }, [editor, draftLoaded, setDocJSON, setSnack]);

  useEffect(() => {
    if (!draftLoaded) return;
    const id = setTimeout(() => {
      try {
        const json = (docJSON ?? undefined) as EditorNode | undefined;
        saveDraft({
          // Text typed with no document stays here; additions to a document are kept per document
          doc: !selectedDocId && json ? (json as JSONContent) : undefined,
          selectedDocId,
          durationMinutes, breaksMode, customBreaks, typoFrequency, zoom, pageless,
          pageSetup: selectedDocId ? undefined : pageSetup,
        } satisfies Draft);
        if (json && docContent?.status === "ready" && docContent.docId === selectedDocId) {
          writeAdditions(selectedDocId, hasPending(json) ? { revisionId: revisionRef.current, doc: json } : null);
        }
      } catch { /* storage full or blocked */ }
    }, 400);
    return () => clearTimeout(id);
  }, [draftLoaded, docJSON, selectedDocId, durationMinutes, breaksMode, customBreaks, typoFrequency, zoom, pageless, pageSetup, docContent, revisionRef]);

  return { durationMinutes, setDurationMinutes, breaksMode, setBreaksMode, customBreaks, setCustomBreaks, typoFrequency, setTypoFrequency, startInMinutes, setStartInMinutes, seed, setSeed, draftLoaded };
}
