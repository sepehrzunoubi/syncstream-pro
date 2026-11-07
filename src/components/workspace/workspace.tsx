"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, type JSONContent } from "@tiptap/react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Toolbar } from "./toolbar";
import { DocsMenubar } from "./menubar";
import { Ruler } from "./ruler";
import { docsUrl, Header, RENAME_EVENT, type HeaderStatus, type HeaderUser } from "./header";
import { Sidebar } from "./sidebar";
import { BREAKS_CLEARED, useManualBreaks } from "./use-manual-breaks";
import { useLiveBreaks } from "./use-live-breaks";
import { BreakPopover, PlacingBar } from "./break-ui";
import { SyncPanel } from "./sync-panel";
import { JobPanel } from "./job-panel";
import { PagedSurface } from "./paged-surface";
import { fontMetrics, installLineMetrics } from "./line-metrics";
import { FindBar } from "./find-bar";
import { ContextMenu } from "./context-menu";
import { pageSize } from "@/lib/page-setup";
import { WordCount } from "./word-count";
import { measureRemoteImage, uploadImage } from "./image-upload";
import { isActive, statusLine } from "./job-status";
import { Icon } from "./icon";
import { randomSeed } from "@/lib/prng";
import type { Editor } from "@tiptap/react";
import type { PublicJob } from "@/lib/sync-store";
import type { EditorNode } from "@/lib/rich-text";
import { countWords } from "@/lib/format";
import { bodyEditorProps, bodyExtensions, DOCS_RULES, useEditorDebugHook, viewerEditorProps, viewerExtensions, type ImageFilesHandler } from "./editor-config";
import { COPY_TEXT, usePageCopy } from "./page-copy";
import { useDocRefs, type DocContent } from "./doc-state";
import { Snackbar, useSnack } from "./snack";
import { useDocsList } from "./use-docs-list";
import { useDialogs, WorkspaceDialogs } from "./use-dialogs";
import { useAutosave } from "./use-autosave";
import { useHeaderFooters } from "./use-header-footers";
import { stepZoom, usePageSetup } from "./use-page-setup";
import { useDraft } from "./use-draft";
import { useDocLoader } from "./use-doc-loader";
import { fontsIn, loadFonts } from "./web-fonts";
import { useSyncJobs } from "./use-sync-jobs";

export function Workspace({ user, onSignOut, onReauth }: { user: HeaderUser | null; onSignOut: () => void; onReauth: () => void }) {
  const [snack, setSnack] = useSnack();
  const [scopeError, setScopeError] = useState(false);
  // Documents
  const { docs, selectedDocId, setSelectedDocId, selectedTabId, setSelectedTabId, isCreatingDoc, renameDoc, fetchDocs, createDoc } = useDocsList({ setSnack, setScopeError });
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
  // Docs' word count box is off until asked for (Tools > Word count)
  const [wordCountOpen, setWordCountOpen] = useState(false);

  // Pasted or dropped image files are uploaded, then inserted (the handler is set below)
  const imageFilesRef = useRef<ImageFilesHandler>(() => {});

  const editor = useEditor({
    extensions: bodyExtensions,
    immediatelyRender: false,
    autofocus: "end",
    editorProps: bodyEditorProps(imageFilesRef),
    ...DOCS_RULES,
    onUpdate: ({ editor: e }) => setDocJSON(e.getJSON()),
    onFocus: () => { setSegmentEditor(null); setEditingHf(null); },
  });

  // A read-only copy of the editor shows a running sync, paginated the same way
  const viewer = useEditor({
    extensions: viewerExtensions,
    immediatelyRender: false,
    editable: false,
    editorProps: viewerEditorProps(),
    coreExtensionOptions: { clipboardTextSerializer: COPY_TEXT },
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

  // Layout: the sidebar is a column on wide screens (open unless it was hidden) and a drawer on narrow ones
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1200px)");
    const apply = () => { setWide(mq.matches); setRailOpen(mq.matches && readFlag(SIDEBAR_KEY, true)); };
    apply();
    setWordCountOpen(readFlag(WORD_COUNT_KEY, false));
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const toggleRail = useCallback(() => setRailOpen((o) => { if (wide) writeFlag(SIDEBAR_KEY, !o); return !o; }), [wide]);
  const toggleWordCount = useCallback(() => setWordCountOpen((o) => { writeFlag(WORD_COUNT_KEY, !o); return !o; }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyC") { e.preventDefault(); toggleWordCount(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleWordCount]);
  useEffect(() => { installLineMetrics(); }, []);

  // ── The selected Google Doc, editable ──
  const { saveNow, saveState, setSaveState } = useAutosave({ editor, refs, docJSON, docContent, docBusy, setDocJSON, setSnack, setScopeError });
  const { setSegments, setHfSetup, setFootnotes, footnoteProps, headerFooters, openHeaderFooter } = useHeaderFooters({ editor, refs, saveNow, setSnack, setScopeError, editingHf, setEditingHf, setSegmentEditor });
  const page = usePageSetup({ editor, viewer, refs, saveNow, setSnack, setScopeError, ready, docContent });
  const { zoom, setZoom, canvasRef, pageless, pageSetup, geometry, textWidthPt, scale, effectivePageless } = page;
  // Ctrl + and Ctrl − zoom the document, not the whole window (the browser's own zoom), one of Docs'
  // zoom levels at a time; Ctrl 0 goes back to fitting the page to the window
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const up = e.key === "+" || e.key === "=" || e.code === "NumpadAdd";
      const down = e.key === "-" || e.key === "_" || e.code === "NumpadSubtract";
      if (!up && !down && e.key !== "0" && e.code !== "Numpad0") return;
      e.preventDefault();
      if (!up && !down) { setZoom("fit"); return; }
      setZoom(stepZoom(Math.round(scale * 100), up ? 1 : -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scale, setZoom]);
  const draft = useDraft({ editor, refs, selectedDocId, setSelectedDocId, selectedTabId, zoom, setZoom, pageless, setPageless: page.setPageless, pageSetup, setPageSetup: page.setPageSetup, docContent, docJSON, setDocJSON });
  const { durationMinutes, setDurationMinutes, breaksMode, setBreaksMode, breakLength, setBreakLength, typoFrequency, setTypoFrequency, startInMinutes, setStartInMinutes, seed, setSeed, draftLoaded } = draft;
  const { loadDocContent } = useDocLoader({ editor, refs, saveNow, setSaveState, draftLoaded, composing, selectedDocId, selectedTabId, setSelectedTabId, docBusy, docContent, setDocContent, setDocJSON, setSnack, setScopeError, setPageSetup: page.setPageSetup, setPageless: page.setPageless, setSegments, setHfSetup, setFootnotes });
  useEditorDebugHook(editor);
  usePageCopy(focusedJob ? viewer : segmentEditor ?? editor);
  // Any font the document or a paste uses is loaded, so the page draws it as Docs will
  const defaultFonts = docContent?.status === "ready" ? docContent.defaults : undefined;
  useEffect(() => {
    const extra = defaultFonts ? [defaultFonts.fontFamily, ...Object.values(defaultFonts.styles).map((s) => s?.fontFamily ?? "")] : [];
    const fonts = fontsIn(docJSON as EditorNode | null, extra);
    loadFonts(fonts);
    // Each font's line height, so the page spaces lines as Docs does in it
    fontMetrics(fonts.keys());
  }, [docJSON, defaultFonts]);

  // Syncs
  const { now, busy, startError, hasText, preview, focusedSource, startSync, jobAction, dismissJob, editAsNew } = useSyncJobs({
    editor, viewer, refs, canvasRef, jobs, setJobs, setReady, focusedJob, focusedJobId, setFocusedJobId, setComposing,
    docs, selectedDocId, setSelectedDocId, docContent, docBusy, docJSON,
    settings: { durationMinutes, breaksMode, breakLength, typoFrequency, startInMinutes, setStartInMinutes, seed, setSeed },
    fetchDocs, loadDocContent, saveNow, setDocJSON, setSnack, setScopeError,
  });
  const breaks = useManualBreaks({ editor, breaksMode, breakLength, active: !focusedJob && !docBusy && !busy, setSnack });
  const upsertJob = useCallback((job: PublicJob) => setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j))), [setJobs]);
  const live = useLiveBreaks({ viewer, job: focusedJob ?? null, source: focusedSource, now, upsertJob, setSnack });

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

  // Header: the cloud badge beside the title, with words when something needs attention
  const status: HeaderStatus | null = focusedJob
    ? { text: statusLine(focusedJob), icon: "sync" }
    : !selectedDocId
      ? { text: "Pick the Google Doc to type into", icon: "cloud_off", visible: true }
      : docContent?.status === "loading"
        ? { text: "Opening the document", icon: "cloud_sync" }
        : docContent?.status === "failed"
          ? { text: `Couldn't open this document (${docContent.error}). Your new text will be added at its end. Try File > Open > Refresh list.`, icon: "cloud_off", visible: true }
        : docBusy
          ? { text: "A sync is typing into this document. You can edit it when it finishes.", icon: "lock", visible: true }
          : saveState === "saving"
            ? { text: "Saving to Google Docs", icon: "cloud_sync" }
            : saveState === "error"
              ? { text: "Couldn't save the last change", icon: "cloud_off", visible: true }
              : docContent?.status === "ready"
                ? { text: hasText ? "New text glows. Start sync types it in." : "Edits save to Google Docs. Type anywhere to add text.", icon: "cloud_done" }
                : draftLoaded
                  ? { text: "Draft saved on this device", icon: "cloud_done" }
                  : null;
  const primary = focusedJob
    ? { kind: "back" as const, label: "Back to editing", onClick: () => setComposing(true) }
    : {
        kind: "start" as const,
        label: busy ? "Starting" : startInMinutes > 0 ? "Schedule sync" : "Start sync",
        onClick: startSync,
        disabled: busy || !hasText || !selectedDocId || docBusy,
        title: docBusy ? "A sync is already typing into this document" : !hasText ? "Type or paste your text first" : !selectedDocId ? "Pick a Google Doc first" : undefined,
      };
  // New Google Doc: made, then opened on the page, ready to sync, from wherever the workspace is
  const newDoc = useCallback(() => {
    setComposing(true);
    if (!wide) setRailOpen(false);
    void createDoc();
  }, [createDoc, wide]);
  // The browser tab names the document, as Docs' does
  const tabTitle = focusedJob?.documentName ?? docs.find((d) => d.id === selectedDocId)?.name;
  useEffect(() => { document.title = tabTitle ? `${tabTitle} - SyncStream` : "SyncStream"; }, [tabTitle]);

  // The page sits where Docs puts it: centred in the window when there's room beside the sidebar and
  // the panel, otherwise as near the centre as it fits
  const pageW = effectivePageless ? 0 : geometry.w * scale;
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !pageW) { setShift(0); return; }
    const place = () => {
      const r = el.getBoundingClientRect();
      const centred = r.left + (r.width - pageW) / 2;
      const want = (window.innerWidth - 22) / 2 - pageW / 2;
      const lo = r.left + 5;
      const hi = r.right - 17 - pageW;
      setShift(hi < lo ? 0 : Math.round(Math.min(hi, Math.max(lo, want)) - centred));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => { ro.disconnect(); window.removeEventListener("resize", place); };
  }, [canvasRef, pageW, railOpen, ready]);

  if (!ready) {
    return (
      <div className="ss-workspace items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#d3e3fd] border-t-[#0b57d0]" role="status" aria-label="Loading" />
      </div>
    );
  }

  const rail = (
    <Sidebar
      tabs={docContent?.tabs ?? null}
      currentTab={docContent?.tabId}
      tabsDisabled={docContent?.status === "loading"}
      onSelectTab={(id) => { setComposing(true); if (id && id !== docContent?.tabId) setSelectedTabId(id); if (!wide) setRailOpen(false); }}
      editor={focusedJob ? null : editor}
      jobs={jobs}
      focusedJobId={focusedJobId}
      composing={composing}
      onFocusJob={(id) => { setFocusedJobId(id); setComposing(false); if (!wide) setRailOpen(false); }}
      onNewDoc={newDoc}
      isCreatingDoc={isCreatingDoc}
      onDismissJob={(id) => { void dismissJob(id); }}
      onHide={toggleRail}
    />
  );

  const docUrlId = focusedJob ? focusedJob.documentId : selectedDocId;
  // The tab, in a document with more than one: the sync's, or the one shown
  const shownTabInfo = docContent?.docId === selectedDocId && (docContent.tabs?.length ?? 0) > 1 ? docContent.tabs!.find((t) => t.id === docContent.tabId) : undefined;
  const headerTab = focusedJob
    ? (focusedJob.tabId && focusedJob.tabTitle ? { id: focusedJob.tabId, title: focusedJob.tabTitle } : null)
    : shownTabInfo ? { id: shownTabInfo.id, title: shownTabInfo.title } : null;
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
        onNewDoc={newDoc}
        onRefreshDocs={refreshDocs}
        isCreatingDoc={isCreatingDoc}
        jobDocName={focusedJob?.documentName}
        jobDocId={focusedJob?.documentId}
        tab={headerTab}
        status={status}
        primary={primary}
        onReauth={onReauth}
        onSignOut={onSignOut}
        onRename={renameDoc}
        menubar={
          <DocsMenubar
            editor={segmentEditor ?? editor}
            editingDisabled={!!focusedJob}
            zoom={zoom}
            onZoom={setZoom}
            sidebarOpen={railOpen}
            onToggleSidebar={toggleRail}
            onNewDoc={newDoc}
            isCreatingDoc={isCreatingDoc}
            docs={docs}
            selectedDocId={selectedDocId}
            onSelectDoc={(id) => { setComposing(true); setSelectedDocId(id); }}
            onRefreshDocs={refreshDocs}
            onRename={!focusedJob && docs.some((d) => d.id === selectedDocId) ? () => window.dispatchEvent(new Event(RENAME_EVENT)) : null}
            docUrl={docUrlId ? docsUrl(docUrlId, headerTab?.id) : null}
            wordCountOpen={wordCountOpen}
            onToggleWordCount={toggleWordCount}
            onPageSetup={() => dialogs.setPageSetupOpen(true)}
            onCustomSpacing={() => dialogs.setSpacingOpen(true)}
            onBorders={() => dialogs.setBordersOpen(true)}
            onHeaderFooter={(which) => { void openHeaderFooter(which); }}
            onColumns={(n) => { if (n === "options") dialogs.setColumnsOpen(true); else editor?.chain().focus().setColumns({ columns: n, textWidth: textWidthPt }).run(); }}
            onShortcuts={() => dialogs.setShortcutsOpen(true)}
            docOpen={docContent?.status === "ready"}
          />
        }
      />

      <div className="ss-noprint ss-toolbar-wrap">
        <Toolbar
          editor={focusedJob ? viewer : segmentEditor ?? editor}
          disabled={!!focusedJob}
          zoom={zoom}
          scale={scale}
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
              className="ss-rail-docked h-full flex-none overflow-hidden"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 296, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease }}
            >
              {rail}
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {railOpen && !wide && (
            <motion.div key="drawer" className="fixed inset-0 z-50 flex" role="dialog" aria-label="Tabs & outlines">
              <motion.div
                className="h-full bg-[var(--ss-canvas)] shadow-xl"
                initial={{ x: -300 }}
                animate={{ x: 0 }}
                exit={{ x: -300 }}
                transition={{ type: "spring", stiffness: 420, damping: 40 }}
              >
                {rail}
              </motion.div>
              <motion.button
                className="flex-1 bg-black/30"
                aria-label="Close tabs & outlines"
                onClick={() => setRailOpen(false)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <main ref={canvasRef} className="ss-canvas relative min-w-0 flex-none lg:h-full lg:flex-1">
          {!railOpen && (
            <button className="ss-icon-btn ss-side-open ss-noprint" onClick={toggleRail} title="Show tabs & outlines" aria-label="Show tabs & outlines">
              <Icon name="notes" size={24} />
            </button>
          )}
          <FindBar editor={editor} />
          <AnimatePresence>
            {!focusedJob && breaks.placing != null && <PlacingBar key="placing" minutes={breaks.placing} onDone={breaks.endPlacing} />}
            {focusedJob && live.placing != null && <PlacingBar key="placing-live" live minutes={live.placing} onDone={live.endPlacing} />}
          </AnimatePresence>
          <div className="ss-ruler-row">
            <div style={{ zoom: scale, position: "relative", left: shift / (scale || 1) }}>
              <Ruler editor={focusedJob ? viewer : segmentEditor ?? editor} disabled={!!focusedJob} geometry={geometry} />
            </div>
          </div>

          {focusedJob && (
            <motion.div key={focusedJob.id} style={{ position: "relative", left: shift }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease }}>
              <PagedSurface editor={viewer} pageless={effectivePageless} scale={scale} pageColor={pageSetup.color} />
            </motion.div>
          )}
          <motion.div
            style={{ display: focusedJob ? "none" : undefined, position: "relative", left: shift }}
            initial={{ opacity: 0, y: 12 }}
            animate={focusedJob ? { opacity: 0, y: 10 } : { opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease }}
          >
            <PagedSurface editor={editor} pageless={effectivePageless} scale={scale} pageColor={pageSetup.color} onMouseDown={onPageMouseDown} headerFooters={docContent?.status === "ready" ? headerFooters : undefined} footnotes={docContent?.status === "ready" ? footnoteProps : undefined} />
          </motion.div>
          {wordCountOpen && <WordCount editor={focusedJob ? viewer : editor} />}
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
                  live={live}
                />
              ) : (
                <SyncPanel
                  durationMinutes={durationMinutes}
                  onDurationChange={setDurationMinutes}
                  breaksMode={breaksMode}
                  onBreaksModeChange={setBreaksMode}
                  breakLength={breakLength}
                  onBreakLengthChange={setBreakLength}
                  manualBreaks={breaks.rows}
                  onRemoveBreak={breaks.remove}
                  onClearBreaks={breaks.clear}
                  onHoverBreak={breaks.hover}
                  onJumpToBreak={breaks.jump}
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
      <Snackbar snack={snack} action={snack === BREAKS_CLEARED ? { label: "Undo", run: breaks.undoClear } : null} onDismiss={() => setSnack(null)} />
      {breaks.popover && (
        <BreakPopover
          key={`${breaks.popover.from}-${breaks.popover.to}`}
          rect={breaks.popover.rect}
          minutes={breaks.popover.minutes}
          onSave={(m) => breaks.changeLength(breaks.popover!, m)}
          onRemove={() => breaks.removeAt(breaks.popover!)}
          onClose={breaks.closePopover}
        />
      )}
      {live.popover && (
        <BreakPopover
          key={`live-${live.popover.row.at}`}
          rect={live.popover.rect}
          minutes={live.popover.row.minutes}
          title={live.popover.row.state === "now" ? "The break it's on now" : undefined}
          onSave={(m) => { const r = live.popover!.row; if (r.state === "now") void live.setCurrentLength(m); else if (r.at != null) void live.changeLength(r.at, m); live.closePopover(); }}
          onRemove={live.popover.row.state === "ahead" ? () => { const r = live.popover!.row; if (r.at != null) void live.remove(r.at); live.closePopover(); } : undefined}
          extra={live.popover.row.state === "now" ? <button type="button" className="ss-link-btn" onClick={() => { void live.endNow(); live.closePopover(); }}>End now</button> : undefined}
          onClose={live.closePopover}
        />
      )}
    </div>
    </MotionConfig>
  );
}

const SIDEBAR_KEY = "ss_sidebar";
const WORD_COUNT_KEY = "ss_word_count";
function readFlag(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === "1"; } catch { return fallback; }
}
function writeFlag(key: string, on: boolean) {
  try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* storage blocked */ }
}
