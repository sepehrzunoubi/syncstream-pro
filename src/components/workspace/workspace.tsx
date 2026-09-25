"use client";

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, type JSONContent } from "@tiptap/react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { editorExtensions, flattenPastedLists } from "./extensions";
import { Toolbar } from "./toolbar";
import { DocsMenubar } from "./menubar";
import { Ruler } from "./ruler";
import { Header, type HeaderUser } from "./header";
import { SyncRail } from "./sync-rail";
import { SyncPanel, type BreaksMode } from "./sync-panel";
import { JobPanel } from "./job-panel";
import { PagedSurface } from "./paged-surface";
import { ProgressMarks, progressKey } from "./pagination";
import { measureRemoteImage, uploadImage } from "./image-upload";
import { isActive, statusLine } from "./job-status";
import { buildDripPlan } from "@/lib/drip-engine";
import { randomSeed } from "@/lib/prng";
import { richFromEditorJSON, richToEditorJSON, type EditorNode, type RichFormat } from "@/lib/rich-text";
import { loadDocument } from "./doc-sync";
import { additions, directEdits, hasPending, rebase, PENDING_MARK } from "@/lib/doc-model";
import type { PublicJob } from "@/lib/sync-store";
import { countWords, formatClock } from "@/lib/format";

type Doc = { id: string; name: string; modifiedTime: string };

const DRAFT_KEY = "syncstream_draft_v2";
const LEGACY_DRAFT_KEY = "syncstream_draft";

interface Draft {
  /** Text typed with no document selected (all of it is to be typed) */
  doc?: JSONContent;
  selectedDocId?: string;
  durationMinutes?: number | null;
  breaksMode?: BreaksMode;
  customBreaks?: number[];
  typoFrequency?: number;
  zoom?: number | "fit";
  pageless?: boolean;
}

/** Additions made to a document, kept per document until they are synced */
const ADDITIONS_PREFIX = "syncstream_additions_";
interface SavedAdditions { revisionId: string; doc: EditorNode }

function readAdditions(docId: string): SavedAdditions | null {
  try {
    const raw = localStorage.getItem(ADDITIONS_PREFIX + docId);
    return raw ? (JSON.parse(raw) as SavedAdditions) : null;
  } catch { return null; }
}

function writeAdditions(docId: string, value: SavedAdditions | null) {
  try {
    if (value) localStorage.setItem(ADDITIONS_PREFIX + docId, JSON.stringify(value));
    else localStorage.removeItem(ADDITIONS_PREFIX + docId);
  } catch { /* storage full or blocked */ }
}

/** Mark everything in a document as an addition (text from before this version, or a sync to redo) */
function markAllAdded(doc: EditorNode): EditorNode {
  const mark = (n: EditorNode): EditorNode => {
    if (n.type === "text" || n.type === "image" || n.type === "hardBreak") {
      const marks = (n.marks ?? []).filter((m) => m.type !== PENDING_MARK);
      return { ...n, marks: [...marks, { type: PENDING_MARK }] };
    }
    return n.content ? { ...n, content: n.content.map(mark) } : n;
  };
  return mark(doc);
}

/** Only the additions of a document, for when the document itself can't be shown */
function additionsOnly(doc: EditorNode): EditorNode {
  const content = (doc.content ?? [])
    .filter((p) => !p.attrs?.locked)
    .map((p) => ({ ...p, content: (p.content ?? []).filter((c) => c.marks?.some((m) => m.type === PENDING_MARK)) }))
    .filter((p) => p.content.length);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function plainToDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })),
  };
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as Draft;
    const legacy = localStorage.getItem(LEGACY_DRAFT_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as { sourceText?: string; selectedDocId?: string; typoFrequency?: number; durationMinutes?: number | null; customBreaks?: number[]; breaksMode?: BreaksMode };
      return { ...old, doc: old.sourceText ? plainToDoc(old.sourceText) : undefined };
    }
  } catch { /* unreadable draft */ }
  return {};
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = {} as T & { error?: string };
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

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

interface Source { text: string; format: RichFormat | null; context?: { doc?: EditorNode; ranges?: [number, number][] } | null }

/** What is known about the selected document's own content */
interface DocContent {
  docId: string;
  status: "loading" | "ready" | "failed";
  revisionId?: string;
}

export function Workspace({ user, onSignOut, onReauth }: { user: HeaderUser | null; onSignOut: () => void; onReauth: () => void }) {
  // Documents
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedDocId, setSelectedDocId] = useState("");
  const [isCreatingDoc, setIsCreatingDoc] = useState(false);
  const [scopeError, setScopeError] = useState(false);

  // Draft settings
  const [docJSON, setDocJSON] = useState<JSONContent | null>(null);
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [breaksMode, setBreaksMode] = useState<BreaksMode>("auto");
  const [customBreaks, setCustomBreaks] = useState<number[]>([]);
  const [typoFrequency, setTypoFrequency] = useState(0.5);
  const [startInMinutes, setStartInMinutes] = useState(0);
  const [seed, setSeed] = useState(() => randomSeed());
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const canvasRef = useRef<HTMLElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const [narrow, setNarrow] = useState(false);
  const [pageless, setPageless] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [docContent, setDocContent] = useState<DocContent | null>(null);
  const contentReq = useRef(0);
  const contentStale = useRef(false);
  /** The document as last saved to Google Docs, and its revision */
  const baseRef = useRef<EditorNode | null>(null);
  const revisionRef = useRef("");
  const legacyTextRef = useRef<EditorNode | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const savingRef = useRef<Promise<boolean> | null>(null);

  // Syncs
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [ready, setReady] = useState(false);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [composing, setComposing] = useState(true);
  const [sources, setSources] = useState<Record<string, Source>>({});
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [wide, setWide] = useState(true);

  // Pasted or dropped image files are uploaded, then inserted (the handler is set below)
  const imageFilesRef = useRef<(files: File[], at?: number) => void>(() => {});
  const imageFilesOf = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

  const editor = useEditor({
    extensions: editorExtensions,
    immediatelyRender: false,
    autofocus: "end",
    editorProps: {
      attributes: { class: "ss-doc", spellcheck: "true", "aria-label": "Text to sync" },
      transformPastedHTML: flattenPastedLists,
      handlePaste: (_view, event) => {
        const files = imageFilesOf(event.clipboardData?.files);
        if (!files.length) return false;
        event.preventDefault();
        imageFilesRef.current(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = imageFilesOf(event.dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        imageFilesRef.current(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => setDocJSON(e.getJSON()),
  });

  // A read-only copy of the editor shows a running sync, paginated the same way
  const viewer = useEditor({
    extensions: [...editorExtensions, ProgressMarks],
    immediatelyRender: false,
    editable: false,
    editorProps: { attributes: { class: "ss-doc", "aria-label": "Text being typed into Google Docs", "aria-readonly": "true" } },
  });

  const focusedJob = !composing ? jobs.find((j) => j.id === focusedJobId) ?? null : null;
  // A sync typing into the selected document: editing it waits until that finishes
  const docBusy = !!selectedDocId && jobs.some((j) => isActive(j) && j.documentId === selectedDocId);
  useEffect(() => { editor?.setEditable(!docBusy); }, [editor, docBusy]);
  const anyActive = jobs.some(isActive);
  const now = useNow(!!focusedJob && isActive(focusedJob));

  // Icons are ligatures in the Material Symbols font; reveal them once it has loaded
  const [iconsReady, setIconsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    document.fonts?.load('20px "Material Symbols Outlined"', "undo").then((faces) => { if (alive && faces.length) setIconsReady(true); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Layout: the syncs list is a column on wide screens and a drawer on narrow ones
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1200px)");
    const apply = () => { setWide(mq.matches); setRailOpen(mq.matches); };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // "Fit" zoom: shrink the 8.5in page to the space between the side columns.
  // Below 720px the page reflows instead (see docs.css), so no scaling there.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      setFitScale(w < 720 ? 1 : Math.min(1, (w - 48) / 816));
      setNarrow(w < 720);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
  const scale = zoom === "fit" ? fitScale : zoom / 100;
  // Narrow screens reflow the page, so page breaks would be wrong there
  const effectivePageless = pageless || narrow;
  useEffect(() => {
    editor?.commands.setPaginated(!effectivePageless);
    viewer?.commands.setPaginated(!effectivePageless);
  }, [editor, viewer, effectivePageless]);

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
    setDraftLoaded(true);
  }, [editor, draftLoaded]);

  useEffect(() => {
    if (!draftLoaded) return;
    const id = setTimeout(() => {
      try {
        const json = (docJSON ?? undefined) as EditorNode | undefined;
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          // Text typed with no document stays here; additions to a document are kept per document
          doc: !selectedDocId && json ? (json as JSONContent) : undefined,
          selectedDocId,
          durationMinutes, breaksMode, customBreaks, typoFrequency, zoom, pageless,
        } satisfies Draft));
        localStorage.removeItem(LEGACY_DRAFT_KEY);
        if (json && docContent?.status === "ready" && docContent.docId === selectedDocId) {
          writeAdditions(selectedDocId, hasPending(json) ? { revisionId: revisionRef.current, doc: json } : null);
        }
      } catch { /* storage full or blocked */ }
    }, 400);
    return () => clearTimeout(id);
  }, [draftLoaded, docJSON, selectedDocId, durationMinutes, breaksMode, customBreaks, typoFrequency, zoom, pageless, docContent]);

  // ── The selected Google Doc, editable ──
  const docContentRef = useRef<DocContent | null>(null);
  docContentRef.current = docContent;
  const docBusyRef = useRef(false);
  docBusyRef.current = docBusy;

  /**
   * Save direct edits (formatting, deleting) to the Google Doc. Additions
   * are left for a sync. Resolves false when the save failed.
   */
  const saveNow = useCallback(async (): Promise<boolean> => {
    while (savingRef.current) await savingRef.current;
    const content = docContentRef.current;
    const base = baseRef.current;
    if (!editor || !base || content?.status !== "ready" || docBusyRef.current) return true;
    const target = editor.getJSON() as EditorNode;
    const { requests, saved } = directEdits(base, target);
    if (!requests.length) return true;
    const run = (async () => {
      setSaveState("saving");
      const { ok, status, data } = await postJson<{ revisionId: string }>("/api/docs/edit", { documentId: content.docId, revisionId: revisionRef.current, requests });
      if (ok) {
        baseRef.current = saved;
        if (data.revisionId) revisionRef.current = data.revisionId;
        setSaveState("saved");
        return true;
      }
      setSaveState("error");
      if (status === 401) setScopeError(true);
      else setSnack(data.error || "Couldn't save that change to Google Docs");
      return false;
    })();
    savingRef.current = run;
    try {
      return await run;
    } finally {
      savingRef.current = null;
    }
  }, [editor]);

  /**
   * Show a Google Doc. `keep` is what the editor shows now: its additions are
   * put back into the fresh copy (nothing reloads if the doc hasn't changed).
   */
  const loadDocContent = useCallback(async (docId: string, keep?: EditorNode) => {
    if (!editor) return;
    const prev = docContentRef.current;
    if (prev?.status === "ready" && prev.docId !== docId) {
      // Leaving a document: save its edits and keep its additions
      await saveNow();
      const json = editor.getJSON() as EditorNode;
      writeAdditions(prev.docId, hasPending(json) ? { revisionId: revisionRef.current, doc: json } : null);
    }
    const req = ++contentReq.current;
    if (!keep) setDocContent({ docId, status: "loading" });
    try {
      const res = await fetch(`/api/docs/content?id=${encodeURIComponent(docId)}`);
      const data = (await res.json().catch(() => ({}))) as { nodes?: EditorNode[]; revisionId?: string; empty?: boolean; error?: string };
      if (res.status === 401) setScopeError(true);
      if (!res.ok || !Array.isArray(data.nodes)) throw new Error(data.error || "Couldn't open this document");
      if (req !== contentReq.current) return;
      const revision = data.revisionId ?? "";
      if (keep && revision === revisionRef.current && docContentRef.current?.docId === docId) return; // unchanged
      const fresh: EditorNode = { type: "doc", content: data.nodes };
      let target = fresh;
      if (keep) target = rebase(fresh, keep);
      else {
        const saved = readAdditions(docId);
        if (saved) target = saved.revisionId === revision ? saved.doc : rebase(fresh, saved.doc);
        else if (legacyTextRef.current) target = { type: "doc", content: [...(fresh.content ?? []), ...(legacyTextRef.current.content ?? [])] };
        legacyTextRef.current = null;
      }
      baseRef.current = fresh;
      revisionRef.current = revision;
      loadDocument(editor, target, !data.empty);
      setDocJSON(editor.getJSON());
      contentStale.current = false;
      setSaveState("idle");
      setDocContent({ docId, status: "ready", revisionId: revision });
      if (keep) setSnack("The document changed in Google Docs. SyncStream reloaded it and kept your new text.");
    } catch (err) {
      if (req !== contentReq.current) return;
      if (keep) return; // keep editing what is shown
      baseRef.current = null;
      loadDocument(editor, additionsOnly(editor.getJSON() as EditorNode), false);
      setDocJSON(editor.getJSON());
      setDocContent({ docId, status: "failed" });
      setSnack(`${err instanceof Error ? err.message : "Couldn't open this document"}. Your text will be added at the end of it.`);
    }
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
    if (docContent?.docId === selectedDocId && !contentStale.current) return;
    if (docBusy && docContent?.docId === selectedDocId) return;
    loadDocContent(selectedDocId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, draftLoaded, composing, selectedDocId, docBusy]);

  // Save direct edits shortly after they are made
  useEffect(() => {
    if (!docJSON || docContent?.status !== "ready" || docBusy) return;
    const id = setTimeout(() => { saveNow(); }, 700);
    return () => clearTimeout(id);
  }, [docJSON, docContent, docBusy, saveNow]);

  // Pick up changes made in Google Docs when coming back to this tab
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== "visible" || !editor) return;
      const content = docContentRef.current;
      if (content?.status !== "ready" || docBusyRef.current) return;
      if (!(await saveNow())) return;
      loadDocContent(content.docId, editor.getJSON() as EditorNode);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [editor, saveNow, loadDocContent]);

  // Snackbar auto-hide
  useEffect(() => {
    if (!snack) return;
    const id = setTimeout(() => setSnack(null), 6000);
    return () => clearTimeout(id);
  }, [snack]);

  // Documents
  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch("/api/docs");
      if (res.status === 401) { setScopeError(true); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { docs: Doc[] };
      setDocs(data.docs || []);
      setSelectedDocId((cur) => (cur && data.docs?.some((d) => d.id === cur) ? cur : data.docs?.[0]?.id ?? ""));
    } catch {
      setSnack("Couldn't load your Google Docs. Try Refresh list.");
    }
  }, []);

  const createDoc = useCallback(async () => {
    setIsCreatingDoc(true);
    try {
      const { ok, status, data } = await postJson<{ id: string; name: string }>("/api/docs/create", { title: "Untitled document" });
      if (status === 401) throw new Error("Your Google sign-in expired. Choose Reconnect Google account in the account menu.");
      if (!ok) throw new Error(data.error || "Couldn't create the document");
      setDocs((prev) => [{ id: data.id, name: data.name, modifiedTime: new Date().toISOString() }, ...prev]);
      setSelectedDocId(data.id);
      setSnack(`Created "${data.name}"`);
    } catch (err) {
      setSnack(err instanceof Error ? err.message : "Couldn't create the document");
    } finally {
      setIsCreatingDoc(false);
    }
  }, []);

  // Syncs
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchDocs(), fetchJobs()]).then(([, list]) => {
      if (cancelled) return;
      const active = list?.find(isActive);
      if (active) { setFocusedJobId(active.id); setComposing(false); }
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [fetchDocs, fetchJobs]);

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
  const deferredJSON = useDeferredValue(docJSON);
  // What a sync would type: the additions to the document, or everything when there is no document
  const toType = useMemo(() => {
    if (!deferredJSON) return { text: "", boundaries: [] as number[] };
    if (docContent?.status === "ready" && baseRef.current) {
      const a = additions(baseRef.current, deferredJSON as EditorNode);
      return { text: a.text, boundaries: a.boundaries };
    }
    return { text: richFromEditorJSON(deferredJSON as EditorNode).text, boundaries: [] as number[] };
  }, [deferredJSON, docContent]);
  const hasText = toType.text.trim().length > 0;
  const preview = useMemo(() => {
    if (!hasText) return null;
    return buildDripPlan(toType.text, {
      targetMinutes: durationMinutes,
      breaks: breaksMode === "auto" ? "auto" : breaksMode === "none" ? [] : customBreaks,
      typoFrequency,
      seed,
      ...(toType.boundaries.length ? { boundaries: toType.boundaries } : {}),
    });
  }, [toType, hasText, durationMinutes, breaksMode, customBreaks, typoFrequency, seed]);

  const upsertJob = (job: PublicJob) => setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));

  const startSync = useCallback(async () => {
    if (!editor || busy || !selectedDocId || docBusy) return;
    setBusy(true);
    setStartError(null);
    try {
      if (docContent?.docId === selectedDocId && docContent.status === "loading") throw new Error("The document is still opening. Try again in a moment.");
      let payload: Record<string, unknown>;
      let source: Source;
      const inDoc = docContent?.docId === selectedDocId && docContent.status === "ready" && !!baseRef.current;
      if (inDoc) {
        if (!(await saveNow())) throw new Error("Couldn't save your other changes to the document. Try again.");
        const target = editor.getJSON() as EditorNode;
        const { segments, text } = additions(baseRef.current!, target);
        if (!segments.length) throw new Error("Type the text you want to add first. New text glows until a sync types it in.");
        const ctx = { doc: target, ranges: segments.map((x) => x.tokens) };
        const context = JSON.stringify(ctx).length <= 350_000 ? ctx : null;
        payload = { segments: segments.map(({ at, mode, text: t, format }) => ({ at, mode, text: t, format })), revisionId: revisionRef.current, context };
        source = { text, format: null, context };
      } else {
        const current = richFromEditorJSON(editor.getJSON());
        if (!current.text.trim()) return;
        payload = { text: current.text, format: current.format };
        source = { text: current.text, format: current.format };
      }
      const doc = docs.find((d) => d.id === selectedDocId);
      const { ok, status, data } = await postJson<{ job: PublicJob; code?: string }>("/api/sync/start", {
        ...payload,
        documentId: selectedDocId,
        documentName: doc?.name,
        targetMinutes: durationMinutes,
        breaks: breaksMode === "auto" ? "auto" : breaksMode === "none" ? [] : customBreaks,
        typoFrequency,
        seed,
        startInMinutes,
      });
      if (status === 401) { setScopeError(true); return; }
      if (status === 409) await loadDocContent(selectedDocId, editor.getJSON() as EditorNode);
      if (!ok) throw new Error(data.error || `Couldn't start the sync (HTTP ${status})`);
      setSources((s) => ({ ...s, [data.job.id]: source }));
      setJobs((prev) => [data.job, ...prev]);
      setFocusedJobId(data.job.id);
      setComposing(false);
      // The additions now belong to the sync; the editor shows the document without them
      if (inDoc) {
        writeAdditions(selectedDocId, null);
        loadDocument(editor, baseRef.current!, true);
        contentStale.current = true;
      } else {
        loadDocument(editor, { type: "doc", content: [{ type: "paragraph" }] }, false);
      }
      setDocJSON(editor.getJSON());
      setStartInMinutes(0);
      setSeed(randomSeed());
      setSnack(startInMinutes > 0 ? `Sync scheduled for ${formatClock(data.job.startAt)}` : "Sync started");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Couldn't start the sync");
    } finally {
      setBusy(false);
    }
  }, [editor, busy, selectedDocId, docBusy, docs, durationMinutes, breaksMode, customBreaks, typoFrequency, seed, startInMinutes, docContent, loadDocContent, saveNow]);

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
  }, [busy, fetchJobs]);

  const dismissJob = useCallback(async (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    setFocusedJobId(null);
    setComposing(true);
    await postJson("/api/sync/dismiss", { jobId }).catch(() => {});
  }, []);

  const editAsNew = useCallback(async (job: PublicJob) => {
    const src = sources[job.id];
    setComposing(true);
    if (!src || !editor) { setSelectedDocId(job.documentId); return; }
    const sameDoc = job.documentId === selectedDocId && docContent?.status === "ready" && baseRef.current;
    if (sameDoc && src.context?.doc) {
      // Put the additions back where they were
      loadDocument(editor, rebase(baseRef.current!, src.context.doc), true);
    } else {
      const extra = markAllAdded(richToEditorJSON(src.text, src.format));
      const current = editor.getJSON() as EditorNode;
      if (sameDoc) loadDocument(editor, { type: "doc", content: [...(current.content ?? []), ...(extra.content ?? [])] }, true);
      else {
        // Opening the other document adds this text at its end
        legacyTextRef.current = extra;
        writeAdditions(job.documentId, null);
        setSelectedDocId(job.documentId);
      }
    }
    setDocJSON(editor.getJSON());
  }, [sources, editor, selectedDocId, docContent]);

  const insertImages = useCallback(async (files: File[], at?: number) => {
    if (!editor) return;
    setSnack(files.length > 1 ? `Uploading ${files.length} images` : "Uploading image");
    let pos = at;
    for (const file of files) {
      try {
        const { url, width, height } = await uploadImage(file);
        const node = { type: "image", attrs: { src: url, width, height } };
        if (pos != null) {
          editor.chain().focus().insertContentAt(pos, node).run();
          pos += 1;
        } else editor.chain().focus().insertContent(node).run();
      } catch (err) {
        setSnack(err instanceof Error ? err.message : "Couldn't add the image");
        return;
      }
    }
    setSnack(files.length > 1 ? "Images added" : "Image added");
  }, [editor]);
  imageFilesRef.current = insertImages;

  const insertImageUrl = useCallback(async (url: string) => {
    if (!editor) return;
    const { width, height } = await measureRemoteImage(url);
    editor.chain().focus().insertContent({ type: "image", attrs: { src: url, width, height } }).run();
  }, [editor]);

  // Header
  const focusedSource = focusedJob ? sources[focusedJob.id] : undefined;

  // Load the focused sync into the viewer, then move its caret as typing progresses
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!viewer || !focusedJob || !focusedSource) return;
    if (loadedRef.current !== focusedJob.id) {
      const ctx = focusedSource.context;
      if (ctx?.doc && ctx.ranges) loadDocument(viewer, ctx.doc, true);
      else loadDocument(viewer, richToEditorJSON(focusedSource.text, focusedSource.format), false);
      loadedRef.current = focusedJob.id;
    }
  }, [viewer, focusedJob, focusedSource]);
  const typed = focusedJob?.charsSent ?? 0;
  useEffect(() => {
    if (!viewer || !focusedJob || loadedRef.current !== focusedJob.id) return;
    const ranges = focusedSource?.context?.doc ? focusedSource.context.ranges ?? null : null;
    viewer.view.dispatch(viewer.state.tr.setMeta(progressKey, { typed, ranges }).setMeta("addToHistory", false));
    const frame = requestAnimationFrame(() => {
      const caret = viewer.view.dom.querySelector(".ss-caret");
      const canvas = canvasRef.current;
      if (!caret || !canvas) return;
      const r = caret.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      if (r.top < c.top + 60 || r.bottom > c.bottom - 60) {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        caret.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [viewer, focusedJob, typed, focusedSource]);
  const subtitle = focusedJob
    ? statusLine(focusedJob)
    : !selectedDocId
      ? "Pick the Google Doc to type into"
      : docContent?.status === "loading"
        ? "Opening the document"
        : docBusy
          ? "A sync is typing into this document. You can edit it when it finishes."
          : saveState === "saving"
            ? "Saving to Google Docs"
            : saveState === "error"
              ? "Couldn't save the last change"
              : docContent?.status === "ready"
                ? hasText
                  ? "New text glows. Start sync types it in."
                  : "Edits save to Google Docs. Type anywhere to add text."
                : draftLoaded
                  ? "Draft saved on this device"
                  : "";
  const primary = focusedJob
    ? { kind: "new" as const, label: "New sync", onClick: () => setComposing(true) }
    : {
        kind: "start" as const,
        label: busy ? "Starting" : startInMinutes > 0 ? "Schedule sync" : "Start sync",
        onClick: startSync,
        disabled: busy || !hasText || !selectedDocId || docBusy,
        title: docBusy ? "A sync is already typing into this document" : !hasText ? "Type or paste your text first" : !selectedDocId ? "Pick a Google Doc first" : undefined,
      };

  if (!ready) {
    return (
      <div className="ss-workspace items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#d3e3fd] border-t-[#0b57d0]" role="status" aria-label="Loading" />
      </div>
    );
  }

  const rail = (
    <SyncRail
      jobs={jobs}
      focusedJobId={focusedJobId}
      composing={composing}
      onCompose={() => { setComposing(true); if (!wide) setRailOpen(false); }}
      onFocus={(id) => { setFocusedJobId(id); setComposing(false); if (!wide) setRailOpen(false); }}
    />
  );

  const docUrlId = focusedJob ? focusedJob.documentId : selectedDocId;
  const refreshDocs = () => {
    fetchDocs();
    if (selectedDocId && !focusedJob && editor && docContent?.status === "ready") {
      saveNow().then(() => loadDocContent(selectedDocId, editor.getJSON() as EditorNode));
    } else if (selectedDocId && !focusedJob) loadDocContent(selectedDocId);
  };
  const ease = [0.2, 0, 0, 1] as const;

  // Clicking the page margins puts the caret at the end, like Docs
  const onPageMouseDown = (e: React.MouseEvent) => {
    if (!editor || (e.target as HTMLElement).closest(".ProseMirror")) return;
    e.preventDefault();
    editor.commands.focus("end");
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className={`ss-workspace ${iconsReady ? "ss-icons-ready" : ""}`}>
      <Header
        user={user}
        mode={focusedJob ? "job" : "draft"}
        docs={docs}
        selectedDocId={selectedDocId}
        onSelectDoc={setSelectedDocId}
        onCreateDoc={createDoc}
        onRefreshDocs={refreshDocs}
        isCreatingDoc={isCreatingDoc}
        jobDocName={focusedJob?.documentName}
        jobDocId={focusedJob?.documentId}
        subtitle={subtitle}
        primary={primary}
        onToggleRail={() => setRailOpen((o) => !o)}
        onReauth={onReauth}
        onSignOut={onSignOut}
        menubar={
          <DocsMenubar
            editor={editor}
            editingDisabled={!!focusedJob}
            zoom={zoom}
            onZoom={setZoom}
            railOpen={railOpen}
            onToggleRail={() => setRailOpen((o) => !o)}
            onNewSync={() => setComposing(true)}
            onCreateDoc={createDoc}
            onRefreshDocs={refreshDocs}
            docUrl={docUrlId ? `https://docs.google.com/document/d/${docUrlId}/edit` : null}
            onSignOut={onSignOut}
            pageless={pageless}
            onPageless={setPageless}
          />
        }
      />

      <div className="ss-noprint flex-none px-4 pb-1">
        <Toolbar
          editor={editor}
          disabled={!!focusedJob}
          zoom={zoom}
          onZoom={setZoom}
          onInsertImages={insertImages}
          onInsertImageUrl={insertImageUrl}
        />
      </div>

      <div className="ss-body flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
        <AnimatePresence initial={false}>
          {railOpen && wide && (
            <motion.div
              key="rail"
              className="h-full flex-none overflow-hidden"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 264, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease }}
            >
              {rail}
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {railOpen && !wide && (
            <motion.div key="drawer" className="fixed inset-0 z-50 flex" role="dialog" aria-label="Syncs">
              <motion.div
                className="h-full bg-[var(--ss-canvas)] pt-4 shadow-xl"
                initial={{ x: -280 }}
                animate={{ x: 0 }}
                exit={{ x: -280 }}
                transition={{ type: "spring", stiffness: 420, damping: 40 }}
              >
                {rail}
              </motion.div>
              <motion.button
                className="flex-1 bg-black/30"
                aria-label="Close syncs"
                onClick={() => setRailOpen(false)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <main ref={canvasRef} className="ss-canvas min-w-0 flex-none lg:h-full lg:flex-1">
          <div className="ss-ruler-row">
            <div style={{ zoom: scale }}>
              <Ruler editor={editor} disabled={!!focusedJob} />
            </div>
          </div>

          {focusedJob && (
            <motion.div key={focusedJob.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease }}>
              <PagedSurface editor={viewer} pageless={effectivePageless} scale={scale} />
            </motion.div>
          )}
          <motion.div
            style={{ display: focusedJob ? "none" : undefined }}
            initial={{ opacity: 0, y: 12 }}
            animate={focusedJob ? { opacity: 0, y: 10 } : { opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease }}
          >
            <PagedSurface editor={editor} pageless={effectivePageless} scale={scale} onMouseDown={onPageMouseDown} />
          </motion.div>
        </main>

        <aside className="flex-none bg-[var(--ss-surface)] lg:m-2 lg:mt-0 lg:h-[calc(100%-8px)] lg:w-[360px] lg:overflow-y-auto lg:overflow-x-hidden lg:rounded-2xl" aria-label={focusedJob ? "This sync" : "Sync settings"}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={focusedJob ? focusedJob.id : "draft"}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.18, ease }}
            >
              {focusedJob ? (
                <JobPanel
                  job={focusedJob}
                  now={now}
                  sourceWords={focusedSource ? countWords(focusedSource.text) : 0}
                  busy={busy}
                  canEditAsNew={!!focusedSource}
                  onPause={() => jobAction("pause", focusedJob.id)}
                  onResume={() => jobAction("resume", focusedJob.id)}
                  onCancel={() => jobAction("cancel", focusedJob.id)}
                  onDismiss={() => dismissJob(focusedJob.id)}
                  onEditAsNew={() => editAsNew(focusedJob)}
                />
              ) : (
                <SyncPanel
                  durationMinutes={durationMinutes}
                  onDurationChange={setDurationMinutes}
                  breaksMode={breaksMode}
                  onBreaksModeChange={setBreaksMode}
                  customBreaks={customBreaks}
                  onCustomBreaksChange={setCustomBreaks}
                  typoFrequency={typoFrequency}
                  onTypoFrequencyChange={setTypoFrequency}
                  startInMinutes={startInMinutes}
                  onStartInChange={setStartInMinutes}
                  preview={preview}
                  onShuffle={() => setSeed(randomSeed())}
                  disabled={busy}
                  scopeError={scopeError}
                  startError={startError}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </aside>
      </div>

      <AnimatePresence>
        {snack && (
          <motion.div
            key={snack}
            className="ss-snackbar"
            role="status"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 500, damping: 38 }}
          >
            <span className="text-[14px]">{snack}</span>
            <button onClick={() => setSnack(null)}>Dismiss</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
