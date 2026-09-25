"use client";

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { editorExtensions, flattenPastedLists } from "./extensions";
import { Toolbar } from "./toolbar";
import { DocsMenubar } from "./menubar";
import { Ruler } from "./ruler";
import { Header, type HeaderUser } from "./header";
import { SyncRail } from "./sync-rail";
import { SyncPanel, type BreaksMode } from "./sync-panel";
import { JobPanel } from "./job-panel";
import { ProgressPage } from "./progress-page";
import { isActive, statusLine } from "./job-status";
import { buildDripPlan } from "@/lib/drip-engine";
import { randomSeed } from "@/lib/prng";
import { richFromEditorJSON, richToEditorJSON, type RichFormat } from "@/lib/rich-text";
import type { PublicJob } from "@/lib/sync-store";
import { countWords, formatClock } from "@/lib/format";

type Doc = { id: string; name: string; modifiedTime: string };

const DRAFT_KEY = "syncstream_draft_v2";
const LEGACY_DRAFT_KEY = "syncstream_draft";

interface Draft {
  doc?: JSONContent;
  selectedDocId?: string;
  durationMinutes?: number | null;
  breaksMode?: BreaksMode;
  customBreaks?: number[];
  typoFrequency?: number;
  zoom?: number | "fit";
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

interface Source { text: string; format: RichFormat | null }

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
  const [draftLoaded, setDraftLoaded] = useState(false);

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

  const editor = useEditor({
    extensions: editorExtensions,
    immediatelyRender: false,
    autofocus: "end",
    editorProps: {
      attributes: { class: "ss-doc", spellcheck: "true", "aria-label": "Text to sync" },
      transformPastedHTML: flattenPastedLists,
    },
    onUpdate: ({ editor: e }) => setDocJSON(e.getJSON()),
  });

  const focusedJob = !composing ? jobs.find((j) => j.id === focusedJobId) ?? null : null;
  const anyActive = jobs.some(isActive);
  const now = useNow(!!focusedJob && isActive(focusedJob));

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
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
  const scale = zoom === "fit" ? fitScale : zoom / 100;

  // Restore the draft once the editor exists
  useEffect(() => {
    if (!editor || draftLoaded) return;
    const d = loadDraft();
    if (d.doc) editor.commands.setContent(d.doc, { emitUpdate: false });
    setDocJSON(editor.getJSON());
    if (d.selectedDocId) setSelectedDocId(d.selectedDocId);
    if (d.durationMinutes !== undefined) setDurationMinutes(d.durationMinutes);
    if (d.breaksMode) setBreaksMode(d.breaksMode);
    if (Array.isArray(d.customBreaks)) setCustomBreaks(d.customBreaks);
    if (typeof d.typoFrequency === "number") setTypoFrequency(d.typoFrequency);
    if (typeof d.zoom === "number" || d.zoom === "fit") setZoom(d.zoom);
    setDraftLoaded(true);
  }, [editor, draftLoaded]);

  useEffect(() => {
    if (!draftLoaded) return;
    const id = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ doc: docJSON ?? undefined, selectedDocId, durationMinutes, breaksMode, customBreaks, typoFrequency, zoom } satisfies Draft));
        localStorage.removeItem(LEGACY_DRAFT_KEY);
      } catch { /* storage full or blocked */ }
    }, 400);
    return () => clearTimeout(id);
  }, [draftLoaded, docJSON, selectedDocId, durationMinutes, breaksMode, customBreaks, typoFrequency, zoom]);

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
      .then((d) => { if (!cancelled && d?.sourceText != null) setSources((s) => ({ ...s, [focusedJobId]: { text: d.sourceText, format: d.format ?? null } })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [focusedJobId, sources]);

  // Preview: the same seed the server will use, so this is the schedule that runs
  const deferredJSON = useDeferredValue(docJSON);
  const rich = useMemo(() => richFromEditorJSON(deferredJSON ?? undefined), [deferredJSON]);
  const hasText = rich.text.trim().length > 0;
  const preview = useMemo(() => {
    if (!hasText) return null;
    return buildDripPlan(rich.text, {
      targetMinutes: durationMinutes,
      breaks: breaksMode === "auto" ? "auto" : breaksMode === "none" ? [] : customBreaks,
      typoFrequency,
      seed,
    });
  }, [rich.text, hasText, durationMinutes, breaksMode, customBreaks, typoFrequency, seed]);

  const upsertJob = (job: PublicJob) => setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));

  const startSync = useCallback(async () => {
    if (!editor || busy) return;
    const current = richFromEditorJSON(editor.getJSON());
    if (!current.text.trim() || !selectedDocId) return;
    setBusy(true);
    setStartError(null);
    try {
      const doc = docs.find((d) => d.id === selectedDocId);
      const { ok, status, data } = await postJson<{ job: PublicJob }>("/api/sync/start", {
        text: current.text,
        format: current.format,
        documentId: selectedDocId,
        documentName: doc?.name,
        targetMinutes: durationMinutes,
        breaks: breaksMode === "auto" ? "auto" : breaksMode === "none" ? [] : customBreaks,
        typoFrequency,
        seed,
        startInMinutes,
      });
      if (status === 401) { setScopeError(true); return; }
      if (!ok) throw new Error(data.error || `Couldn't start the sync (HTTP ${status})`);
      setSources((s) => ({ ...s, [data.job.id]: { text: current.text, format: current.format } }));
      setJobs((prev) => [data.job, ...prev]);
      setFocusedJobId(data.job.id);
      setComposing(false);
      editor.commands.clearContent(true);
      setStartInMinutes(0);
      setSeed(randomSeed());
      setSnack(startInMinutes > 0 ? `Sync scheduled for ${formatClock(data.job.startAt)}` : "Sync started");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Couldn't start the sync");
    } finally {
      setBusy(false);
    }
  }, [editor, busy, selectedDocId, docs, durationMinutes, breaksMode, customBreaks, typoFrequency, seed, startInMinutes]);

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

  const editAsNew = useCallback((job: PublicJob) => {
    const src = sources[job.id];
    if (src && editor) editor.commands.setContent(richToEditorJSON(src.text, src.format) as JSONContent, { emitUpdate: true });
    setSelectedDocId(job.documentId);
    setComposing(true);
  }, [sources, editor]);

  // Header
  const focusedSource = focusedJob ? sources[focusedJob.id] : undefined;
  const subtitle = focusedJob
    ? statusLine(focusedJob)
    : !selectedDocId
      ? "Pick the Google Doc to type into"
      : draftLoaded
        ? "Draft saved on this device"
        : "";
  const primary = focusedJob
    ? { kind: "new" as const, label: "New sync", onClick: () => setComposing(true) }
    : {
        kind: "start" as const,
        label: busy ? "Starting" : startInMinutes > 0 ? "Schedule sync" : "Start sync",
        onClick: startSync,
        disabled: busy || !hasText || !selectedDocId,
        title: !hasText ? "Type or paste your text first" : !selectedDocId ? "Pick a Google Doc first" : undefined,
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
  const ease = [0.2, 0, 0, 1] as const;

  // Clicking the page margins puts the caret at the end, like Docs
  const onPageMouseDown = (e: React.MouseEvent) => {
    if (!editor || (e.target as HTMLElement).closest(".ProseMirror")) return;
    e.preventDefault();
    editor.commands.focus("end");
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="ss-workspace">
      <Header
        user={user}
        mode={focusedJob ? "job" : "draft"}
        docs={docs}
        selectedDocId={selectedDocId}
        onSelectDoc={setSelectedDocId}
        onCreateDoc={createDoc}
        onRefreshDocs={fetchDocs}
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
            onRefreshDocs={fetchDocs}
            docUrl={docUrlId ? `https://docs.google.com/document/d/${docUrlId}/edit` : null}
            onSignOut={onSignOut}
          />
        }
      />

      <div className="flex-none px-4 pb-1">
        <Toolbar editor={editor} disabled={!!focusedJob} zoom={zoom} onZoom={setZoom} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
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
              {focusedSource ? (
                <ProgressPage text={focusedSource.text} format={focusedSource.format} typed={focusedJob.charsSent} scale={scale} />
              ) : (
                <div className="ss-page" style={{ zoom: scale }} />
              )}
            </motion.div>
          )}
          <motion.div
            className="ss-page"
            style={{ zoom: scale, display: focusedJob ? "none" : undefined }}
            initial={{ opacity: 0, y: 12 }}
            animate={focusedJob ? { opacity: 0, y: 10 } : { opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease }}
            onMouseDown={onPageMouseDown}
          >
            <EditorContent editor={editor} />
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
