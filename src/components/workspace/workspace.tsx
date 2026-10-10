"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useEditor, type JSONContent } from "@tiptap/react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Toolbar } from "./toolbar";
import { DocsMenubar } from "./menubar";
import { Ruler } from "./ruler";
import { Header, type HeaderUser } from "./header";
import { WorkspaceTabs } from "./workspace-tabs";
import { SyncRail } from "./sync-rail";
import { SyncPanel } from "./sync-panel";
import { JobPanel } from "./job-panel";
import { PagedSurface } from "./paged-surface";
import { installLineMetrics } from "./line-metrics";
import { FindBar } from "./find-bar";
import { Outline } from "./outline";
import { ContextMenu } from "./context-menu";
import { pageSize } from "@/lib/page-setup";
import { WordCount } from "./word-count";
import { measureRemoteImage, uploadImage } from "./image-upload";
import { isActive, statusLine } from "./job-status";
import { randomSeed } from "@/lib/prng";
import type { Editor } from "@tiptap/react";
import type { PublicJob } from "@/lib/sync-store";
import type { EditorNode } from "@/lib/rich-text";
import { countWords } from "@/lib/format";
import { bodyEditorProps, bodyExtensions, useEditorDebugHook, viewerEditorProps, viewerExtensions, type ImageFilesHandler } from "./editor-config";
import { useDocRefs, type DocContent } from "./doc-state";
import { Snackbar, useSnack } from "./snack";
import { useDocsList } from "./use-docs-list";
import { useDialogs, WorkspaceDialogs } from "./use-dialogs";
import { useAutosave } from "./use-autosave";
import { useHeaderFooters } from "./use-header-footers";
import { usePageSetup } from "./use-page-setup";
import { useDraft } from "./use-draft";
import { useDocLoader } from "./use-doc-loader";
import { useSyncJobs } from "./use-sync-jobs";

export function Workspace({ user, onSignOut, onReauth }: { user: HeaderUser | null; onSignOut: () => void; onReauth: () => void }) {
  const router = useRouter();
  const [snack, setSnack] = useSnack();
  const [scopeError, setScopeError] = useState(false);
  // Documents
  const { docs, selectedDocId, setSelectedDocId, isCreatingDoc, renameDoc, fetchDocs, createDoc } = useDocsList({ setSnack, setScopeError });
  const [docJSON, setDocJSON] = useState<JSONContent | null>(null);
  const dialogs = useDialogs();
  const [editingHf, setEditingHf] = useState<"header" | "footer" | null>(null);
  /** The header or footer editor being used, when one is; the body otherwise */
  const [segmentEditor, setSegmentEditor] = useState<Editor | null>(null);
  const [docContent, setDocContent] = useState<DocContent | null>(null);
  const refs = useDocRefs();
  refs.docContentRef.current = docContent;

  // Syncs
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [ready, setReady] = useState(false);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [composing, setComposing] = useState(true);
  const [railOpen, setRailOpen] = useState(false);
  const [wide, setWide] = useState(true);

  // Pasted or dropped image files are uploaded, then inserted (the handler is set below)
  const imageFilesRef = useRef<ImageFilesHandler>(() => {});

  const editor = useEditor({
    extensions: bodyExtensions,
    immediatelyRender: false,
    autofocus: "end",
    editorProps: bodyEditorProps(imageFilesRef),
    onUpdate: ({ editor: e }) => setDocJSON(e.getJSON()),
    onFocus: () => { setSegmentEditor(null); setEditingHf(null); },
  });

  // A read-only copy of the editor shows a running sync, paginated the same way
  const viewer = useEditor({
    extensions: viewerExtensions,
    immediatelyRender: false,
    editable: false,
    editorProps: viewerEditorProps(),
  });

  const focusedJob = !composing ? jobs.find((j) => j.id === focusedJobId) ?? null : null;
  // A sync typing into the selected document: editing it waits until that finishes
  const docBusy = !!selectedDocId && jobs.some((j) => isActive(j) && j.documentId === selectedDocId);
  useEffect(() => { editor?.setEditable(!docBusy); }, [editor, docBusy]);
  refs.docBusyRef.current = docBusy;

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
  useEffect(() => { installLineMetrics(); }, []);

  // ── The selected Google Doc, editable ──
  const { saveNow, saveState, setSaveState } = useAutosave({ editor, refs, docJSON, docContent, docBusy, setDocJSON, setSnack, setScopeError });
  const { setSegments, setHfSetup, setFootnotes, footnoteProps, headerFooters, openHeaderFooter } = useHeaderFooters({ editor, refs, saveNow, setSnack, setScopeError, editingHf, setEditingHf, setSegmentEditor });
  const page = usePageSetup({ editor, viewer, refs, saveNow, setSnack, setScopeError, ready, docContent });
  const { zoom, setZoom, canvasRef, pageless, pageSetup, geometry, textWidthPt, scale, effectivePageless } = page;
  const draft = useDraft({ editor, refs, selectedDocId, setSelectedDocId, zoom, setZoom, pageless, setPageless: page.setPageless, pageSetup, setPageSetup: page.setPageSetup, docContent, docJSON, setDocJSON, setSnack });
  const { durationMinutes, setDurationMinutes, breaksMode, setBreaksMode, customBreaks, setCustomBreaks, typoFrequency, setTypoFrequency, startInMinutes, setStartInMinutes, seed, setSeed, draftLoaded } = draft;
  const { loadDocContent } = useDocLoader({ editor, refs, saveNow, setSaveState, draftLoaded, composing, selectedDocId, docBusy, docContent, setDocContent, setDocJSON, setSnack, setScopeError, setPageSetup: page.setPageSetup, setSegments, setHfSetup, setFootnotes });
  useEditorDebugHook(editor);

  // Syncs
  const { now, busy, startError, hasText, preview, focusedSource, startSync, jobAction, dismissJob, editAsNew } = useSyncJobs({
    editor, viewer, refs, canvasRef, jobs, setJobs, setReady, focusedJob, focusedJobId, setFocusedJobId, setComposing,
    docs, selectedDocId, setSelectedDocId, docContent, docBusy, docJSON,
    settings: { durationMinutes, breaksMode, customBreaks, typoFrequency, startInMinutes, setStartInMinutes, seed, setSeed },
    fetchDocs, loadDocContent, saveNow, setDocJSON, setSnack, setScopeError,
  });

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
  }, [editor, setSnack]);
  imageFilesRef.current = insertImages;

  const insertImageUrl = useCallback(async (url: string) => {
    if (!editor) return;
    const { width, height } = await measureRemoteImage(url);
    editor.chain().focus().insertContent({ type: "image", attrs: { src: url, width, height } }).run();
  }, [editor]);

  // Header
  const subtitle = focusedJob
    ? statusLine(focusedJob)
    : !selectedDocId
      ? "Pick the Google Doc to type into"
      : docContent?.status === "loading"
        ? "Opening the document"
        : docContent?.status === "failed"
          ? `Couldn't open this document (${docContent.error}). Your new text will be added at its end. Try File > Refresh.`
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
    <div className="flex h-full flex-col">
    {dialogs.outlineOpen && !focusedJob && <Outline editor={editor} />}
    <SyncRail
      jobs={jobs}
      focusedJobId={focusedJobId}
      composing={composing}
      onCompose={() => { setComposing(true); if (!wide) setRailOpen(false); }}
      onFocus={(id) => { setFocusedJobId(id); setComposing(false); if (!wide) setRailOpen(false); }}
    />
    </div>
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
    if (!editor || (e.target as HTMLElement).closest(".ProseMirror, .ss-hf, .ss-footnotes")) return;
    e.preventDefault();
    // Clicking above or below the text puts the caret on the nearest line, like Docs
    const r = editor.view.dom.getBoundingClientRect();
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const hit = editor.view.posAtCoords({ left: clamp(e.clientX, r.left + 1, r.right - 1), top: clamp(e.clientY, r.top + 1, r.bottom - 1) });
    if (hit) editor.chain().focus().setTextSelection(hit.pos).run();
    else editor.commands.focus("end");
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
        tabs={<WorkspaceTabs active="sync" />}
        onRename={renameDoc}
        menubar={
          <DocsMenubar
            editor={segmentEditor ?? editor}
            editingDisabled={!!focusedJob}
            zoom={zoom}
            onZoom={setZoom}
            railOpen={railOpen}
            onToggleRail={() => setRailOpen((o) => !o)}
            onNewSync={() => setComposing(true)}
            onCreateDoc={createDoc}
            onRefreshDocs={refreshDocs}
            onOpenStyle={() => router.push("/dashboard/style")}
            docUrl={docUrlId ? `https://docs.google.com/document/d/${docUrlId}/edit` : null}
            onSignOut={onSignOut}
            onPageSetup={() => dialogs.setPageSetupOpen(true)}
            onCustomSpacing={() => dialogs.setSpacingOpen(true)}
            onBorders={() => dialogs.setBordersOpen(true)}
            onHeaderFooter={(which) => { void openHeaderFooter(which); }}
            onColumns={(n) => { if (n === "options") dialogs.setColumnsOpen(true); else editor?.chain().focus().setColumns({ columns: n, textWidth: textWidthPt }).run(); }}
            outlineOpen={dialogs.outlineOpen}
            onToggleOutline={() => dialogs.setOutlineOpen((o) => !o)}
            onShortcuts={() => dialogs.setShortcutsOpen(true)}
            docOpen={docContent?.status === "ready"}
          />
        }
      />

      <div className="ss-noprint flex-none px-4 pb-1">
        <Toolbar
          editor={focusedJob ? viewer : segmentEditor ?? editor}
          disabled={!!focusedJob}
          zoom={zoom}
          onZoom={setZoom}
          onInsertImages={insertImages}
          onInsertImageUrl={insertImageUrl}
          onCustomSpacing={() => dialogs.setSpacingOpen(true)}
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
          <FindBar editor={editor} />
          <div className="ss-ruler-row">
            <div style={{ zoom: scale }}>
              <Ruler editor={focusedJob ? viewer : segmentEditor ?? editor} disabled={!!focusedJob} geometry={geometry} />
            </div>
          </div>

          {focusedJob && (
            <motion.div key={focusedJob.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease }}>
              <PagedSurface editor={viewer} pageless={effectivePageless} scale={scale} pageColor={pageSetup.color} />
            </motion.div>
          )}
          <motion.div
            style={{ display: focusedJob ? "none" : undefined }}
            initial={{ opacity: 0, y: 12 }}
            animate={focusedJob ? { opacity: 0, y: 10 } : { opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease }}
          >
            <PagedSurface editor={editor} pageless={effectivePageless} scale={scale} pageColor={pageSetup.color} onMouseDown={onPageMouseDown} headerFooters={docContent?.status === "ready" ? headerFooters : undefined} footnotes={docContent?.status === "ready" ? footnoteProps : undefined} />
          </motion.div>
          <WordCount editor={focusedJob ? viewer : editor} />
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

      <WorkspaceDialogs editor={editor} dialogs={dialogs} pageSetup={pageSetup} pageless={pageless} onApplyPageSetup={page.applyPageSetup} onSetPageDefault={page.setPageDefault} textWidth={textWidthPt} />
      <ContextMenu editor={focusedJob ? null : editor} />
      {/* Print on the document's paper with its margins */}
      <style>{`@media print { @page { size: ${pageSize(pageSetup).w / 72}in ${pageSize(pageSetup).h / 72}in; margin: ${pageSetup.margins.top}pt ${pageSetup.margins.right}pt ${pageSetup.margins.bottom}pt ${pageSetup.margins.left}pt; } }`}</style>
      <Snackbar snack={snack} onDismiss={() => setSnack(null)} />
    </div>
    </MotionConfig>
  );
}
