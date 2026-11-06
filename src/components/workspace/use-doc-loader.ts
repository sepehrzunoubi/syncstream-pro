/**
 * Showing the selected Google Doc: fetching it, putting kept additions
 * back into it, and reloading it when it changes in Google Docs.
 */

import { useCallback, useEffect } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
import type { EditorNode } from "@/lib/rich-text";
import { parsePageSetup, type PageSetup } from "@/lib/page-setup";
import type { DocDefaults } from "@/lib/doc-import";
import { groupColumns, hasPending, rebase } from "@/lib/doc-model";
import { loadDocument } from "./doc-sync";
import { additionsOnly, sanitize } from "./doc-json";
import { readAdditions, writeAdditions } from "./storage";
import { shownTab, type DocContent, type DocRefs, type Setter } from "./doc-state";
import type { DocTab } from "@/lib/doc-tabs";
import type { SaveState } from "./use-autosave";
import type { HfSetup, Segment, Segments } from "./use-header-footers";

export function useDocLoader({ editor, refs, saveNow, setSaveState, draftLoaded, composing, selectedDocId, selectedTabId, setSelectedTabId, docBusy, docContent, setDocContent, setDocJSON, setSnack, setScopeError, setPageSetup, setPageless, setSegments, setHfSetup, setFootnotes }: {
  editor: Editor | null;
  refs: DocRefs;
  saveNow: () => Promise<boolean>;
  setSaveState: Setter<SaveState>;
  draftLoaded: boolean;
  composing: boolean;
  selectedDocId: string;
  /** The tab of it asked for ("": its first) */
  selectedTabId: string;
  setSelectedTabId: Setter<string>;
  docBusy: boolean;
  docContent: DocContent | null;
  setDocContent: Setter<DocContent | null>;
  setDocJSON: Setter<JSONContent | null>;
  setSnack: Setter<string | null>;
  setScopeError: Setter<boolean>;
  setPageSetup: Setter<PageSetup>;
  setPageless: Setter<boolean>;
  setSegments: Setter<Segments>;
  setHfSetup: Setter<HfSetup>;
  setFootnotes: Setter<Record<string, EditorNode[]>>;
}) {
  const { docContentRef, baseRef, revisionRef, legacyTextRef, contentReq, contentStale, savingRef, docBusyRef, retried, tabRef } = refs;

  /**
   * Show a Google Doc: the tab asked for (tabRef), or its first. `keep` is what the editor shows
   * now: its additions are put back into the fresh copy (nothing reloads if the doc hasn't changed).
   */
  const loadDocContent = useCallback(async (docId: string, keep?: EditorNode) => {
    if (!editor) return;
    const prev = docContentRef.current;
    const tab = tabRef.current;
    if (prev?.status === "ready" && (prev.docId !== docId || (!!tab && !!prev.tabId && prev.tabId !== tab))) {
      // Leaving a document or tab: save its edits and keep its additions
      await saveNow();
      const json = editor.getJSON() as EditorNode;
      writeAdditions(prev.docId, hasPending(json) ? { revisionId: revisionRef.current, doc: json } : null, shownTab(prev));
    }
    const req = ++contentReq.current;
    // Text typed before a document was open becomes additions to it
    if (!keep && prev?.status !== "ready" && !readAdditions(docId, { id: tab || null })) {
      const json = editor.getJSON() as EditorNode;
      if (hasPending(json)) legacyTextRef.current = additionsOnly(json);
    }
    if (!keep) setDocContent({ docId, tabId: tab || null, tabs: prev?.docId === docId ? prev.tabs : undefined, status: "loading" });
    try {
      const startedWith = revisionRef.current;
      const res = await fetch(`/api/docs/content?id=${encodeURIComponent(docId)}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`);
      const data = (await res.json().catch(() => ({}))) as { nodes?: EditorNode[]; revisionId?: string; empty?: boolean; pageSetup?: unknown; error?: string; tabs?: DocTab[]; tabId?: string | null; tabGone?: boolean };
      if (res.status === 401) setScopeError(true);
      if (!res.ok || !Array.isArray(data.nodes)) throw new Error(data.error || "Couldn't open this document");
      if (req !== contentReq.current) return;
      const revision = data.revisionId ?? "";
      const tabId = typeof data.tabId === "string" ? data.tabId : null;
      const tabs = Array.isArray(data.tabs) ? data.tabs : [];
      if (keep && revision === revisionRef.current && docContentRef.current?.docId === docId && (docContentRef.current.tabId ?? null) === tabId) return; // unchanged
      // A save landed while this copy was fetched: it is already stale, the next check reloads
      if (keep && (revisionRef.current !== startedWith || savingRef.current)) return;
      // The document's own page setup, headers and footers
      const docSetup = parsePageSetup(data.pageSetup);
      if (docSetup) setPageSetup(docSetup);
      // A pageless document shows as one continuous page, as in Docs
      const mode = (data as { pageless?: unknown }).pageless;
      if (typeof mode === "boolean") setPageless(mode);
      const seg = (v: unknown): Segment | null => (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && Array.isArray((v as { nodes?: unknown }).nodes) ? { id: (v as { id: string }).id, base: (v as { nodes: EditorNode[] }).nodes } : null);
      const d = data as { header?: unknown; footer?: unknown; firstPageHeader?: unknown; firstPageFooter?: unknown; useFirstPage?: unknown; marginHeader?: unknown; marginFooter?: unknown };
      setSegments({ header: seg(d.header), footer: seg(d.footer), firstPageHeader: seg(d.firstPageHeader), firstPageFooter: seg(d.firstPageFooter) });
      setHfSetup({ useFirstPage: d.useFirstPage === true, marginHeader: typeof d.marginHeader === "number" ? d.marginHeader : 36, marginFooter: typeof d.marginFooter === "number" ? d.marginFooter : 36 });
      const fns = (data as { footnotes?: Record<string, unknown> }).footnotes ?? {};
      const next: Record<string, EditorNode[]> = {};
      for (const [id, v] of Object.entries(fns)) { const s = seg(v); if (s) next[id] = s.base; }
      setFootnotes(next);
      const fresh: EditorNode = { type: "doc", content: groupColumns(data.nodes) };
      // A tab deleted in Google Docs: its new text isn't put back into another tab's paragraphs.
      // It goes at the end of the tab opened instead, still glowing, and the message says so
      let orphan: EditorNode | null = null;
      if (data.tabGone) {
        const left = keep ? (editor.getJSON() as EditorNode) : tab ? readAdditions(docId, { id: tab })?.doc : null;
        if (left && hasPending(left)) orphan = additionsOnly(left);
        if (tab) writeAdditions(docId, null, { id: tab });
      }
      const append = (doc: EditorNode, extra: EditorNode | null): EditorNode => (extra ? { type: "doc", content: [...(doc.content ?? []), ...(extra.content ?? [])] } : doc);
      let target = fresh;
      if (keep && !data.tabGone) target = rebase(fresh, editor.getJSON() as EditorNode);
      else {
        const saved = readAdditions(docId, { id: tabId, first: tabs[0]?.id === tabId });
        // Google's copy is the truth: only the glowing additions come back from last time. Text
        // carried over (typed before a document was open, or a sync's text to edit again) goes at the end
        if (saved) target = rebase(fresh, saved.doc);
        target = append(target, legacyTextRef.current);
        legacyTextRef.current = null;
      }
      target = append(target, orphan);
      try {
        loadDocument(editor, target, true);
      } catch (err) {
        console.error("The editor couldn't show this document as is:", err);
        const clean = sanitize(target) ?? fresh;
        try { loadDocument(editor, clean, true); } catch { loadDocument(editor, sanitize(fresh) ?? fresh, true); }
      }
      baseRef.current = fresh;
      revisionRef.current = revision;
      setDocJSON(editor.getJSON());
      contentStale.current = false;
      setSaveState("idle");
      setDocContent({ docId, tabId, tabs, status: "ready", revisionId: revision, defaults: (data as { defaults?: DocDefaults }).defaults });
      // From now on the tab is asked for by its id, so it stays this one if the tabs are reordered
      tabRef.current = tabId ?? "";
      setSelectedTabId(tabId ?? "");
      if (data.tabGone) setSnack(orphan ? "That tab was deleted in Google Docs, so SyncStream opened the first tab. The new text you had in the deleted tab is at the end here, still glowing: delete it if it doesn't belong." : "That tab is no longer in the document, so SyncStream opened its first tab.");
      else if (keep) setSnack("The document changed in Google Docs. SyncStream reloaded it and kept your new text.");
    } catch (err) {
      if (req !== contentReq.current) return;
      if (keep) return; // keep editing what is shown
      console.error("Couldn't open the document:", err);
      baseRef.current = null;
      // Show only the new text, still glowing; a sync would add it at the end of the document
      loadDocument(editor, legacyTextRef.current ?? additionsOnly(editor.getJSON() as EditorNode), true);
      setDocJSON(editor.getJSON());
      setDocContent({ docId, tabId: tab || null, tabs: prev?.docId === docId ? prev.tabs : undefined, status: "failed", error: err instanceof Error ? err.message : "Couldn't open this document" });
      // One automatic retry: most failures are a slow or expired Google response
      if (!retried.current.has(docId)) {
        retried.current.add(docId);
        setTimeout(() => { if (docContentRef.current?.docId === docId && docContentRef.current.status === "failed") loadDocContent(docId); }, 2000);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, saveNow]);

  // Open the selected document (again after a sync into it finishes)
  useEffect(() => {
    if (!editor || !draftLoaded || !composing) return;
    if (!selectedDocId) {
      if (docContentRef.current) {
        baseRef.current = null;
        loadDocument(editor, additionsOnly(editor.getJSON() as EditorNode), false);
        setDocContent(null);
      }
      return;
    }
    const sameTab = !selectedTabId || (docContent?.tabId ?? "") === selectedTabId;
    if (docContent?.docId === selectedDocId && sameTab && !contentStale.current) return;
    if (docBusy && docContent?.docId === selectedDocId && sameTab) return;
    tabRef.current = selectedTabId;
    loadDocContent(selectedDocId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, draftLoaded, composing, selectedDocId, selectedTabId, docBusy]);

  // Mirror changes made in Google Docs: on coming back to this tab, and every few seconds while
  // it is visible (the doc may be open side by side), reload when Google's revision moved on
  useEffect(() => {
    let checking = false;
    const refresh = async (force: boolean) => {
      if (checking || document.visibilityState !== "visible" || !editor) return;
      const content = docContentRef.current;
      if (content?.status !== "ready" || docBusyRef.current) return;
      checking = true;
      try {
        if (!force) {
          const res = await fetch(`/api/docs/revision?id=${encodeURIComponent(content.docId)}`);
          if (!res.ok) return;
          const data = (await res.json().catch(() => ({}))) as { revisionId?: string };
          if (!data.revisionId || data.revisionId === revisionRef.current) return;
          if (docContentRef.current?.docId !== content.docId) return;
        }
        if (!(await saveNow())) return;
        loadDocContent(content.docId, editor.getJSON() as EditorNode);
      } finally {
        checking = false;
      }
    };
    const onVisible = () => { void refresh(true); };
    const id = setInterval(() => { void refresh(false); }, 6000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [editor, saveNow, loadDocContent, docContentRef, docBusyRef, revisionRef]);

  return { loadDocContent };
}
