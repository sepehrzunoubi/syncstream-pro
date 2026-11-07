/**
 * Syncs: the list of jobs and their polling, the preview of what a sync
 * would type, starting, pausing, resuming, cancelling and dismissing one,
 * editing a finished one as new text, and the viewer that follows a
 * running sync.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
import type { PublicJob } from "@/lib/sync-store";
import type { EditorNode } from "@/lib/rich-text";
import { isInsertableImageSrc, richFromEditorJSON, richToEditorJSON } from "@/lib/rich-text";
import { additions, BREAK_MARK, breakAnchors, PENDING_MARK, rebase, segmentCharTokens } from "@/lib/doc-model";
import { withAnchors, type BreakAnchor } from "@/lib/breaks";
import { sourceAnchors } from "./break-marks";
import { buildDripPlan } from "@/lib/drip-engine";
import { randomSeed } from "@/lib/prng";
import { formatClock } from "@/lib/format";
import { LOAD_META, loadDocument } from "./doc-sync";
import { progressKey } from "./pagination";
import { isActive } from "./job-status";
import type { BreaksMode } from "./sync-panel";
import { postJson } from "./api";
import { markAllAdded, withoutMark } from "./doc-json";
import { writeAdditions } from "./storage";
import { shownTab, type Doc, type DocContent, type DocRefs, type Setter, type Source, type SourceView } from "./doc-state";
import { isUploadingImage } from "./pasted-images";

function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export interface SyncSettings {
  durationMinutes: number | null;
  breaksMode: BreaksMode;
  /** Manual: the length in the Break length field (the breaks themselves are marks on the page) */
  breakLength?: string;
  typoFrequency: number;
  startInMinutes: number;
  setStartInMinutes: Setter<number>;
  seed: number;
  setSeed: Setter<number>;
}

export function useSyncJobs({ editor, viewer, refs, canvasRef, jobs, setJobs, setReady, focusedJob, focusedJobId, setFocusedJobId, composing, setComposing, docs, selectedDocId, setSelectedDocId, docContent, docBusy, docJSON, settings, fetchDocs, loadDocContent, saveNow, setDocJSON, setSnack, setScopeError }: {
  editor: Editor | null;
  viewer: Editor | null;
  refs: DocRefs;
  canvasRef: MutableRefObject<HTMLElement | null>;
  jobs: PublicJob[];
  setJobs: Setter<PublicJob[]>;
  setReady: Setter<boolean>;
  focusedJob: PublicJob | null;
  focusedJobId: string | null;
  setFocusedJobId: Setter<string | null>;
  /** Editing (false: a sync is shown) */
  composing?: boolean;
  setComposing: Setter<boolean>;
  docs: Doc[];
  selectedDocId: string;
  setSelectedDocId: (id: string | ((cur: string) => string), tabId?: string) => void;
  docContent: DocContent | null;
  docBusy: boolean;
  docJSON: JSONContent | null;
  settings: SyncSettings;
  fetchDocs: () => Promise<void>;
  loadDocContent: (docId: string, keep?: EditorNode) => Promise<void>;
  saveNow: () => Promise<boolean>;
  setDocJSON: Setter<JSONContent | null>;
  setSnack: Setter<string | null>;
  setScopeError: Setter<boolean>;
}) {
  const { baseRef, revisionRef, legacyTextRef, contentStale } = refs;
  const { durationMinutes, breaksMode, typoFrequency, startInMinutes, setStartInMinutes, seed, setSeed } = settings;
  const [sources, setSources] = useState<Record<string, Source>>({});
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** The first list of syncs is in: a sync missing from the list is gone, not loading */
  const ready = useRef(false);
  const selectedRef = useRef(selectedDocId);
  selectedRef.current = selectedDocId;
  const anyActive = jobs.some(isActive);
  const now = useNow(!!focusedJob && isActive(focusedJob));

  // A start that failed is about that document and that text: another document or tab, or an
  // edit to the text, and it no longer applies
  const shownTabId = docContent?.docId === selectedDocId ? docContent.tabId ?? null : null;
  useEffect(() => { setStartError(null); }, [selectedDocId, shownTabId]);
  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({ transaction: tr }: { transaction: { docChanged: boolean; getMeta: (k: string) => unknown } }) => {
      if (tr.docChanged && !tr.getMeta(LOAD_META)) setStartError(null);
    };
    editor.on("transaction", onTransaction);
    return () => { editor.off("transaction", onTransaction); };
  }, [editor]);

  // The sync shown went away (removed in another tab, or gone from the list): back to editing, so
  // the page and the header show the same document again
  useEffect(() => {
    if (composing === false && !focusedJob && ready.current) {
      setFocusedJobId(null);
      setComposing(true);
    }
  }, [composing, focusedJob, setFocusedJobId, setComposing]);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/list");
      if (!res.ok) return undefined;
      const data = (await res.json()) as { jobs: PublicJob[] };
      setJobs(data.jobs);
      return data.jobs;
    } catch {
      return undefined;
    }
  }, [setJobs]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchDocs(), fetchJobs()]).then(([, list]) => {
      if (cancelled) return;
      const active = list?.find(isActive);
      if (active) { setFocusedJobId(active.id); setComposing(false); }
      ready.current = true;
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [fetchDocs, fetchJobs, setFocusedJobId, setComposing, setReady]);

  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(fetchJobs, 4000);
    const onVisible = () => { if (document.visibilityState === "visible") fetchJobs(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [anyActive, fetchJobs]);

  useEffect(() => {
    if (!focusedJobId || sources[focusedJobId]) return;
    let cancelled = false;
    fetch(`/api/sync/source?jobId=${focusedJobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.sourceText != null) setSources((s) => ({ ...s, [focusedJobId]: { text: d.sourceText, format: d.format ?? null, context: d.context ?? null } })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [focusedJobId, sources]);

  // Preview: the same seed the server will use, so this is the schedule that runs
  // The preview of what a sync would type diffs the whole document: once typing pauses, not per keystroke
  const [deferredJSON, setDeferredJSON] = useState(docJSON);
  useEffect(() => {
    const id = setTimeout(() => setDeferredJSON(docJSON), 300);
    return () => clearTimeout(id);
  }, [docJSON]);
  // What a sync would type: the additions to the document, or everything when there is no document
  // and where its Manual breaks start in it
  const toType = useMemo(() => {
    if (!deferredJSON) return { text: "", boundaries: [] as number[], anchors: [] as BreakAnchor[] };
    if (docContent?.status === "ready" && baseRef.current) {
      const a = additions(baseRef.current, deferredJSON as EditorNode);
      return { text: a.text, boundaries: a.boundaries, anchors: breakAnchors(deferredJSON as EditorNode, a.segments) };
    }
    let anchors: BreakAnchor[] = [];
    try { if (editor) anchors = sourceAnchors(editor.schema.nodeFromJSON(deferredJSON)); } catch { /* a page the schema can't read has no breaks */ }
    return { text: richFromEditorJSON(deferredJSON as EditorNode).text, boundaries: [] as number[], anchors };
  }, [deferredJSON, docContent, baseRef, editor]);
  const hasText = toType.text.trim().length > 0;
  const preview = useMemo(() => {
    if (!hasText) return null;
    // Manual: the natural pace, and the breaks placed on the page (no Total time to fit)
    const manual = breaksMode === "manual";
    const plan = buildDripPlan(toType.text, {
      targetMinutes: manual ? null : durationMinutes,
      breaks: breaksMode === "auto" ? "auto" : [],
      typoFrequency,
      seed,
      ...(toType.boundaries.length ? { boundaries: toType.boundaries } : {}),
    });
    return manual ? withAnchors(plan, toType.anchors) : plan;
  }, [toType, hasText, durationMinutes, breaksMode, typoFrequency, seed]);

  const upsertJob = (job: PublicJob) => setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));

  const startSync = useCallback(async () => {
    if (!editor || busy || !selectedDocId || docBusy) return;
    if (docContent?.docId !== selectedDocId || docContent.status === "loading") { setStartError("The document is still opening. Try again in a moment."); return; }
    setBusy(true);
    setStartError(null);
    // Nothing is typed or pasted while the sync starts: what it takes is what the page then shows
    editor.setEditable(false, false);
    // Where it starts from: if another document or tab is shown by the time it answers, what it says is
    // about this one, not that one
    const from = { docId: selectedDocId, tabId: docContent.tabId ?? null, name: docs.find((d) => d.id === selectedDocId)?.name };
    const stillHere = () => selectedRef.current === from.docId && refs.docContentRef.current?.docId === from.docId && (refs.docContentRef.current.tabId ?? null) === from.tabId;
    try {
      // An image the sync can't insert (yet): it would be left out. Looked for in what the sync takes
      const checkImages = () => {
        let blocked: string | null = null;
        editor.state.doc.descendants((n) => {
          if (blocked || n.type.name !== "image") return !blocked;
          const src: unknown = n.attrs.src;
          if (isUploadingImage(src)) blocked = "A pasted image is still uploading. Try again in a moment.";
          else if (n.marks.some((m) => m.type.name === PENDING_MARK) && !isInsertableImageSrc(src)) {
            blocked = typeof src === "string" && /^https?:\/\//i.test(src)
              ? "An image's web address is too long for Google Docs. Take it out, or paste the image itself."
              : "An image in the text isn't on the web, so the sync can't add it to the document. Take it out, or paste the image itself.";
          }
          return !blocked;
        });
        if (blocked) throw new Error(blocked);
      };
      let payload: Record<string, unknown>;
      let source: Source;
      let manualAnchors: BreakAnchor[] = [];
      const inDoc = docContent?.docId === selectedDocId && docContent.status === "ready" && !!baseRef.current;
      const startedOn = inDoc ? { docId: docContent!.docId, tabId: docContent!.tabId ?? null } : null;
      if (inDoc) {
        if (!(await saveNow())) throw new Error("Couldn't save your other changes to the document. Try again.");
        checkImages();
        const target = editor.getJSON() as EditorNode;
        const { segments, text } = additions(baseRef.current!, target);
        if (!segments.length) throw new Error("Type the text you want to add first. New text glows until a sync types it in.");
        manualAnchors = breakAnchors(target, segments);
        const ctx = { doc: target, ranges: segments.map((x) => x.tokens) };
        const context = JSON.stringify(ctx).length <= 350_000 ? ctx : null;
        payload = { segments: segments.map(({ at, mode, text: t, format }) => ({ at, mode, text: t, format })), revisionId: revisionRef.current, context };
        source = { text, format: null, context };
      } else {
        checkImages();
        const current = richFromEditorJSON(editor.getJSON());
        if (!current.text.trim()) return;
        manualAnchors = sourceAnchors(editor.state.doc);
        payload = { text: current.text, format: current.format };
        source = { text: current.text, format: current.format };
      }
      const doc = docs.find((d) => d.id === selectedDocId);
      // The tab shown, or (the document couldn't be read) the one asked for
      const tabId = (docContent?.docId === selectedDocId ? docContent.tabId : null) || refs.tabRef.current || undefined;
      const { ok, status, data } = await postJson<{ job: PublicJob; code?: string }>("/api/sync/start", {
        ...payload,
        documentId: selectedDocId,
        documentName: doc?.name,
        tabId,
        targetMinutes: breaksMode === "manual" ? null : durationMinutes,
        breaks: breaksMode === "auto" ? "auto" : breaksMode === "manual" ? manualAnchors : [],
        typoFrequency,
        seed,
        startInMinutes,
      });
      if (status === 401) { setScopeError(true); return; }
      // The document changed in Google Docs: reload it with the additions in place, unless the page has
      // moved on to another one (that one's load mustn't be replaced by this one)
      if (status === 409 && stillHere()) await loadDocContent(selectedDocId, editor.getJSON() as EditorNode);
      if (!ok) throw new Error(data.error || `Couldn't start the sync (HTTP ${status})`);
      setSources((s) => ({ ...s, [data.job.id]: source }));
      setJobs((prev) => [data.job, ...prev]);
      setFocusedJobId(data.job.id);
      setComposing(false);
      // The additions now belong to the sync; the editor shows the document without them. Unless
      // another tab or document opened while it started: that one's own new text stays where it is
      if (inDoc) {
        writeAdditions(selectedDocId, null, shownTab(docContent));
        const now = refs.docContentRef.current;
        if (now?.docId === startedOn!.docId && (now.tabId ?? null) === startedOn!.tabId) {
          loadDocument(editor, baseRef.current!, true);
          contentStale.current = true;
        }
      } else {
        loadDocument(editor, { type: "doc", content: [{ type: "paragraph" }] }, false);
      }
      setDocJSON(editor.getJSON());
      setStartInMinutes(0);
      setSeed(randomSeed());
      const noBreaks = breaksMode === "manual" && manualAnchors.length === 0 ? ", with no breaks" : "";
      setSnack(startInMinutes > 0 ? `Sync scheduled for ${formatClock(data.job.startAt)}${noBreaks}` : `Sync started${noBreaks}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't start the sync";
      if (stillHere()) setStartError(msg);
      else setSnack(`Couldn't start the sync into ${from.name ? `"${from.name}"` : "the other document"}: ${msg}`);
    } finally {
      // The page unlocks with this (usePageLock), unless the sync now typing into it, or a document
      // opening, keeps it locked
      setBusy(false);
    }
  }, [editor, busy, selectedDocId, docBusy, docs, durationMinutes, breaksMode, typoFrequency, seed, startInMinutes, docContent, loadDocContent, saveNow, baseRef, revisionRef, contentStale, refs.tabRef, refs.docContentRef, setJobs, setFocusedJobId, setComposing, setDocJSON, setStartInMinutes, setSeed, setSnack, setScopeError]);

  const jobAction = useCallback(async (path: "pause" | "resume" | "cancel", jobId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const { ok, data } = await postJson<{ job: PublicJob }>(`/api/sync/${path}`, { jobId });
      if (!ok) throw new Error(data.error || `Couldn't ${path} the sync`);
      upsertJob(data.job);
      setSnack(path === "pause" ? "Sync paused" : path === "resume" ? "Sync resumed" : "Sync cancelled");
    } catch (err) {
      setSnack(err instanceof Error ? err.message : `Couldn't ${path} the sync`);
      fetchJobs();
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, fetchJobs]);

  const dismissJob = useCallback(async (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    // Removing another sync from the list leaves the one shown where it is
    if (jobId === focusedJobId) {
      setFocusedJobId(null);
      setComposing(true);
    }
    await postJson("/api/sync/dismiss", { jobId }).catch(() => {});
  }, [focusedJobId, setJobs, setFocusedJobId, setComposing]);

  const editAsNew = useCallback(async (job: PublicJob) => {
    const src = sources[job.id];
    setComposing(true);
    if (!src || !editor) { setSelectedDocId(job.documentId, job.tabId ?? ""); return; }
    const sameDoc = job.documentId === selectedDocId && (!job.tabId || job.tabId === docContent?.tabId) && docContent?.status === "ready" && baseRef.current;
    if (sameDoc && src.context?.doc) {
      // Put the additions back where they were
      loadDocument(editor, rebase(baseRef.current!, src.context.doc), true);
    } else {
      const extra = markAllAdded(richToEditorJSON(src.text, src.format));
      const current = editor.getJSON() as EditorNode;
      if (sameDoc) loadDocument(editor, { type: "doc", content: [...(current.content ?? []), ...(extra.content ?? [])] }, true);
      else {
        // Opening the other document adds this text at its end, after any new text kept for it there
        legacyTextRef.current = legacyTextRef.current ? { type: "doc", content: [...(legacyTextRef.current.content ?? []), ...(extra.content ?? [])] } : extra;
        setSelectedDocId(job.documentId, job.tabId ?? "");
      }
    }
    setDocJSON(editor.getJSON());
  }, [sources, editor, selectedDocId, docContent, baseRef, legacyTextRef, setComposing, setSelectedDocId, setDocJSON]);

  const focusedSource = focusedJob ? sources[focusedJob.id] : undefined;

  // A sync typing into several tabs: where each tab's text is in the source
  const tabParts = useMemo(() => {
    const tabs = focusedSource?.context?.tabs;
    if (!tabs?.length) return null;
    let from = 0;
    return tabs.map((t) => {
      const chars = segmentCharTokens(t.doc, t.ranges);
      const part = { ...t, chars, from, to: from + chars.reduce((n, c) => n + c.length, 0) };
      from = part.to;
      return part;
    });
  }, [focusedSource]);
  const typed = focusedJob?.charsSent ?? 0;
  // The live page follows the tab being typed (a finished sync shows its last)
  const tabIndex = tabParts ? (() => { const i = tabParts.findIndex((p) => typed < p.to); return i < 0 ? tabParts.length - 1 : i; })() : -1;
  const part = tabParts && tabIndex >= 0 ? tabParts[tabIndex] : null;
  /** What the live page shows: the whole source, or the tab being typed */
  const view = useMemo((): SourceView | null => {
    if (!focusedSource) return null;
    if (!part) return { source: focusedSource, from: 0, to: focusedSource.text.length, tab: -1 };
    return { source: { text: focusedSource.text, format: null, context: { doc: part.doc, ranges: part.ranges } }, from: part.from, to: part.to, tab: tabIndex };
  }, [focusedSource, part, tabIndex]);

  // Load the focused sync into the viewer, then move its caret as typing progresses
  const loadedRef = useRef<string | null>(null);
  const viewKey = focusedJob ? `${focusedJob.id}#${tabIndex}` : null;
  useEffect(() => {
    if (!viewer || !focusedJob || !view || !viewKey) return;
    if (loadedRef.current !== viewKey) {
      const ctx = view.source.context;
      // (breaks placed before the start are shown from the job, which has them as they are now)
      if (ctx?.doc && ctx.ranges) loadDocument(viewer, withoutMark(ctx.doc as EditorNode, BREAK_MARK), true);
      else loadDocument(viewer, richToEditorJSON(view.source.text, view.source.format), false);
      loadedRef.current = viewKey;
    }
  }, [viewer, focusedJob, view, viewKey]);
  // Which token each typed character comes from, once per sync (and tab)
  const chars = useMemo(() => {
    if (part) return part.chars;
    const ctx = focusedSource?.context;
    return ctx?.doc && ctx.ranges ? segmentCharTokens(ctx.doc, ctx.ranges) : null;
  }, [focusedSource, part]);
  useEffect(() => {
    if (!viewer || !focusedJob || !view || loadedRef.current !== viewKey) return;
    const ctx = view.source.context;
    const ranges = ctx?.doc ? ctx.ranges ?? null : null;
    // Typed so far in the tab shown
    const shown = Math.max(0, Math.min(typed - view.from, view.to - view.from));
    viewer.view.dispatch(viewer.state.tr.setMeta(progressKey, { typed: shown, ranges, chars }).setMeta("addToHistory", false));
    const frame = requestAnimationFrame(() => {
      const caret = viewer.view.dom.querySelector(".ss-caret");
      const canvas = canvasRef.current;
      // A break's popover open on the page stays where it is (it would close if the page scrolled)
      if (!caret || !canvas || document.querySelector(".ss-brk-popover")) return;
      const r = caret.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      if (r.top < c.top + 60 || r.bottom > c.bottom - 60) {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        caret.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [viewer, focusedJob, typed, view, viewKey, chars, canvasRef]);

  /** For the panel: each tab of a sync typing into several, and how far it is */
  const tabProgress = useMemo(() => tabParts?.map((p, i) => ({ id: p.tabId, title: p.title || `Tab ${i + 1}`, state: (typed >= p.to ? "done" : i === tabIndex ? "typing" : "next") as "done" | "typing" | "next" })) ?? null, [tabParts, typed, tabIndex]);

  return { now, busy, startError, hasText, preview, focusedSource, view, tabProgress, startSync, jobAction, dismissJob, editAsNew };
}
