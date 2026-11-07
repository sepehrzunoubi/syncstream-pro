/**
 * Showing the selected Google Doc: fetching it, putting kept additions
 * back into it, and reloading it when it changes in Google Docs.
 */

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
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

/** How long to wait before trying again to open a document Google was too busy or slow to give */
const RETRY_MS = [1500, 4000, 9000];
/** Reloads after this many saves in a row failed while the document changed in Google Docs */
const MAX_FAILED_SAVES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const join = (a: EditorNode | null, b: EditorNode | null): EditorNode | null => (a && b ? { type: "doc", content: [...(a.content ?? []), ...(b.content ?? [])] } : a ?? b);

export function useDocLoader({ editor, refs, saveNow, setSaveState, draftLoaded, composing, selectedDocId, selectedTabId, setSelectedTabId, docBusy, docContent, setDocContent, setDocJSON, setSnack, setScopeError, setPageSetup, setPageless, setSegments, setHfSetup, setFootnotes, createdDocRef }: {
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
  /** A document just made here: it takes the caret once it is open */
  createdDocRef?: MutableRefObject<string | null>;
}) {
  const { docContentRef, baseRef, revisionRef, legacyTextRef, contentReq, contentStale, savingRef, docBusyRef, tabRef } = refs;
  const failedSaves = useRef(0);
  /** The document being opened (not a reload of the one shown), while it opens */
  const opening = useRef<string | null>(null);

  /**
   * Show a Google Doc: the tab asked for (tabRef), or its first. `keep` is what the editor shows
   * now: its additions are put back into the fresh copy (nothing reloads if the doc hasn't changed).
   */
  const loadDocContent = useCallback(async (docId: string, keep?: EditorNode) => {
    if (!editor) return;
    // A reload of the page shown never gets in the way of another document opening
    if (keep && opening.current && opening.current !== docId) return;
    if (!keep) opening.current = docId;
    const done = () => { if (!keep && opening.current === docId) opening.current = null; };
    const prev = docContentRef.current;
    const tab = tabRef.current;
    if (prev?.status === "ready" && (prev.docId !== docId || (!!tab && !!prev.tabId && prev.tabId !== tab))) {
      // Leaving a document or tab: save its edits and keep its additions
      await saveNow();
      const json = editor.getJSON() as EditorNode;
      writeAdditions(prev.docId, hasPending(json) ? { revisionId: revisionRef.current, doc: json } : null, shownTab(prev));
    }
    const req = ++contentReq.current;
    // Text typed before a document was open becomes additions to it: with no document at all, or in
    // this one when it couldn't be opened. Never what the page shows of another document (its
    // additions are kept with it; it may still be on the page while this one opens)
    const carry = !prev || (prev.docId === docId && prev.status === "failed");
    const savedHere = readAdditions(docId, { id: tab || null });
    if (!keep && carry && !savedHere) {
      const json = editor.getJSON() as EditorNode;
      // (the page of a document that couldn't be opened already shows the text carried into it)
      if (hasPending(json)) legacyTextRef.current = prev ? additionsOnly(json) : join(legacyTextRef.current, additionsOnly(json));
    }
    if (!keep) setDocContent({ docId, tabId: tab || null, tabs: prev?.docId === docId ? prev.tabs : undefined, status: "loading" });
    try {
      const startedWith = revisionRef.current;
      type Content = { nodes?: EditorNode[]; revisionId?: string; empty?: boolean; pageSetup?: unknown; error?: string; tabs?: DocTab[]; tabId?: string | null; tabGone?: boolean };
      let data: Content = {};
      // Google busy or slow (a 429, a 5xx, no answer): it stays "opening" and tries again a few times
      for (let attempt = 0; ; attempt++) {
        let res: Response | null = null;
        try {
          res = await fetch(`/api/docs/content?id=${encodeURIComponent(docId)}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`);
          data = (await res.json().catch(() => ({}))) as Content;
        } catch { data = { error: "You're offline, or Google can't be reached" }; }
        if (req !== contentReq.current) return;
        if (keep && opening.current && opening.current !== docId) return;
        if (res?.status === 401) setScopeError(true);
        if (res?.ok && Array.isArray(data.nodes)) break;
        const again = !res || res.status === 429 || res.status >= 500;
        if (keep || !again || attempt >= RETRY_MS.length) throw new Error(data.error || "Couldn't open this document");
        const wait = Number(res?.headers.get("Retry-After"));
        await sleep(Math.min(20_000, Math.max(RETRY_MS[attempt], Number.isFinite(wait) ? wait * 1000 : 0)));
        if (req !== contentReq.current) return;
      }
      const nodes = data.nodes!;
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
      const fresh: EditorNode = { type: "doc", content: groupColumns(nodes) };
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
      failedSaves.current = 0;
      done();
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
      // Show only this document's new text, still glowing (kept from before, or typed before it was
      // opened); a sync would add it at the end of the document
      const own = savedHere?.doc && hasPending(savedHere.doc) ? additionsOnly(savedHere.doc) : null;
      const shown = join(legacyTextRef.current, own) ?? { type: "doc", content: [{ type: "paragraph" }] };
      try { loadDocument(editor, shown, true); } catch { loadDocument(editor, { type: "doc", content: [{ type: "paragraph" }] }, true); }
      setDocJSON(editor.getJSON());
      setDocContent({ docId, tabId: tab || null, tabs: prev?.docId === docId ? prev.tabs : undefined, status: "failed", error: err instanceof Error ? err.message : "Couldn't open this document" });
      done();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, saveNow]);

  // Open the selected document (again after a sync into it finishes). It also runs when what the page
  // shows changes, so a page left showing another document than the one picked (a reload of the old one
  // landing last) opens the picked one again instead of staying stuck on the other
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
    // Already opening it
    if (docContent?.docId === selectedDocId && sameTab && docContent.status === "loading") return;
    if (docBusy && docContent?.docId === selectedDocId && sameTab) return;
    tabRef.current = selectedTabId;
    loadDocContent(selectedDocId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, draftLoaded, composing, selectedDocId, selectedTabId, docBusy, docContent?.docId, docContent?.tabId, docContent?.status]);

  // A document just made takes the caret once it is open, as a new document does in Docs (unless the
  // user has gone on to type somewhere else meanwhile)
  useEffect(() => {
    if (!createdDocRef?.current || !editor || docContent?.status !== "ready" || docContent.docId !== createdDocRef.current) return;
    createdDocRef.current = null;
    const a = document.activeElement;
    if (a && a !== document.body && a.matches("input, textarea, select, [contenteditable='true']") && !editor.view.dom.contains(a)) return;
    // Once the page is editable again (it unlocks as this same change lands)
    requestAnimationFrame(() => { if (!editor.isDestroyed && editor.isEditable) editor.commands.focus("end"); });
  }, [docContent, editor, createdDocRef]);

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
        // A change that can't be saved (refused, or a conflict) mustn't keep Google's newer copy away for
        // good: after a few tries the page reloads from Google Docs, keeping the new text
        if (!(await saveNow())) {
          if (++failedSaves.current < MAX_FAILED_SAVES) return;
          setSnack("Couldn't save your last change, and the document changed in Google Docs. SyncStream reloaded it from there and kept your new text.");
        }
        failedSaves.current = 0;
        loadDocContent(content.docId, editor.getJSON() as EditorNode);
      } finally {
        checking = false;
      }
    };
    const onVisible = () => { void refresh(true); };
    const id = setInterval(() => { void refresh(false); }, 6000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [editor, saveNow, loadDocContent, docContentRef, docBusyRef, revisionRef, setSnack]);

  return { loadDocContent };
}

/**
 * The page can't be changed while it is locked (a document opening, a sync typing into it or starting).
 * A caret it had when it locked comes back when it unlocks; never by scrolling the page, and never away
 * from somewhere else the user has gone to meanwhile.
 */
export function usePageLock(editor: Editor | null, locked: boolean) {
  const refocus = useRef(false);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (locked) {
      if (editor.isFocused) refocus.current = true;
      editor.setEditable(false);
      return;
    }
    editor.setEditable(true);
    if (!refocus.current) return;
    refocus.current = false;
    const a = document.activeElement;
    if (!a || a === document.body) editor.commands.focus(null, { scrollIntoView: false });
  }, [editor, locked]);
}
