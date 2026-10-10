/**
 * Direct edits (formatting, deleting) are saved to the Google Doc shortly
 * after they are made, like Docs autosaves. Additions are left for a sync.
 */

import { useCallback, useEffect, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
import type { EditorNode } from "@/lib/rich-text";
import { adoptStructure, directEdits, groupColumns, rebase, signature } from "@/lib/doc-model";
import { loadDocument } from "./doc-sync";
import { postJson } from "./api";
import type { DocContent, DocRefs, Setter } from "./doc-state";

export type SaveState = "idle" | "saving" | "saved" | "error";

/** Structural saves (table shape) read the document back and save again; this many rounds at most */
const MAX_STRUCTURAL_ROUNDS = 3;

export function useAutosave({ editor, refs, docJSON, docContent, docBusy, setDocJSON, setSnack, setScopeError }: {
  editor: Editor | null;
  refs: DocRefs;
  docJSON: JSONContent | null;
  docContent: DocContent | null;
  docBusy: boolean;
  setDocJSON: Setter<JSONContent | null>;
  setSnack: Setter<string | null>;
  setScopeError: Setter<boolean>;
}) {
  const { docContentRef, baseRef, revisionRef, savingRef, docBusyRef } = refs;
  const [saveState, setSaveState] = useState<SaveState>("idle");

  /**
   * Read the document back after a save. If Google applied the edit
   * differently from what the editor expected, reload it (keeping the new
   * text) so later edits land in the right places.
   */
  /** The document as Google has it now, or null when it can't be read */
  const fetchFresh = useCallback(async (docId: string): Promise<EditorNode | null> => {
    try {
      const res = await fetch(`/api/docs/content?id=${encodeURIComponent(docId)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { nodes?: EditorNode[]; revisionId?: string };
      if (!Array.isArray(data.nodes) || docContentRef.current?.docId !== docId) return null;
      if (data.revisionId) revisionRef.current = data.revisionId;
      return { type: "doc", content: groupColumns(data.nodes) };
    } catch { return null; }
  }, [docContentRef, revisionRef]);

  const verifyAgainstGoogle = useCallback(async (docId: string) => {
    try {
      const fresh = await fetchFresh(docId);
      if (!fresh || !editor) return;
      if (signature(fresh) === signature(baseRef.current)) return;
      console.warn("Google Docs applied an edit differently than expected; reloading the document");
      baseRef.current = fresh;
      loadDocument(editor, rebase(fresh, editor.getJSON() as EditorNode), true);
      setDocJSON(editor.getJSON());
      setSnack("Google Docs applied that change a little differently, so SyncStream reloaded the document. Your new text is kept.");
    } catch { /* the next save or reload catches up */ }
  }, [editor, fetchFresh, baseRef, setDocJSON, setSnack]);

  /**
   * Save direct edits (formatting, deleting) to the Google Doc. Additions
   * are left for a sync. Resolves false when the save failed.
   */
  const saveNow = useCallback(async (round = 0): Promise<boolean> => {
    while (savingRef.current) await savingRef.current;
    const content = docContentRef.current;
    const base = baseRef.current;
    if (!editor || !base || content?.status !== "ready" || docBusyRef.current) return true;
    const target = editor.getJSON() as EditorNode;
    const { requests, saved, structural } = directEdits(base, target);
    if (!requests.length) return true;
    const run = (async () => {
      setSaveState("saving");
      const { ok, status, data } = await postJson<{ revisionId: string }>("/api/docs/edit", { documentId: content.docId, revisionId: revisionRef.current, requests });
      if (ok) {
        if (data.revisionId) revisionRef.current = data.revisionId;
        if (structural) {
          // Tables changed shape: read the document back, give the editor's tables the ids Google
          // assigned, and only then save whatever else changed (text in the new cells stays an addition).
          // A read that keeps coming back without the change (a stale or failing read) must not make
          // the editor send the same table request again and again: after a few rounds, trust the
          // save and let the next verification or reload reconcile.
          const fresh = round < MAX_STRUCTURAL_ROUNDS ? await fetchFresh(content.docId) : null;
          if (round >= MAX_STRUCTURAL_ROUNDS) {
            console.warn("Google Docs did not return the table change after several reads; keeping the editor's version");
            baseRef.current = saved;
            setSaveState("saved");
            return true;
          }
          if (fresh) {
            baseRef.current = fresh;
            loadDocument(editor, adoptStructure(fresh, editor.getJSON() as EditorNode), true);
            setDocJSON(editor.getJSON());
          } else baseRef.current = saved;
          setSaveState("saved");
          return "again" as const;
        }
        baseRef.current = saved;
        setSaveState("saved");
        await verifyAgainstGoogle(content.docId);
        return true;
      }
      setSaveState("error");
      if (status === 401) setScopeError(true);
      else setSnack(data.error || "Couldn't save that change to Google Docs");
      return false;
    })();
    const once = run.then((r) => r !== false);
    savingRef.current = once;
    let result: boolean | "again";
    try {
      result = await run;
    } finally {
      savingRef.current = null;
    }
    return result === "again" ? saveNow(round + 1) : result;
  }, [editor, verifyAgainstGoogle, fetchFresh, savingRef, docContentRef, baseRef, docBusyRef, revisionRef, setDocJSON, setScopeError, setSnack]);

  // Save direct edits shortly after they are made
  useEffect(() => {
    if (!docJSON || docContent?.status !== "ready" || docBusy) return;
    const id = setTimeout(() => { saveNow(); }, 700);
    return () => clearTimeout(id);
  }, [docJSON, docContent, docBusy, saveNow]);

  return { saveNow, saveState, setSaveState };
}
