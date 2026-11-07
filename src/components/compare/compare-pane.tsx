"use client";

/**
 * One read-only page of the comparison: "Your document · after the sync" or "Reference". It draws
 * a document with the editor's own extensions and pages, in its own page setup and named styles
 * (each pane has its own: the workspace's page setup is one shared state), fit to the pane.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, type Editor } from "@tiptap/react";
import type { DocDefaults } from "@/lib/doc-import";
import type { EditorNode } from "@/lib/rich-text";
import { NAMED_STYLE_ORDER } from "@/lib/rich-text";
import { DEFAULT_PAGE_SETUP, pageGeometry, type PageSetup } from "@/lib/page-setup";
import { editorExtensions } from "../workspace/extensions";
import { tokenPositions } from "../workspace/pagination";
import { PagedSurface } from "../workspace/paged-surface";
import { loadDocument } from "../workspace/doc-sync";
import { COPY_TEXT } from "../workspace/page-copy";
import { screenStack } from "../workspace/space-faces";
import { fontsIn, loadFonts } from "../workspace/web-fonts";
import { fontMetrics } from "../workspace/line-metrics";
import { CompareMarks, setCompareMarks } from "./compare-marks";
import { tokenRange } from "./compare-view";

export const paneExtensions = [...editorExtensions, CompareMarks];

/** A read-only editor for a pane */
export function usePaneEditor(label: string): Editor | null {
  return useEditor({
    extensions: paneExtensions,
    immediatelyRender: false,
    editable: false,
    editorProps: { attributes: { class: "ss-doc", "aria-label": label, "aria-readonly": "true" } },
    coreExtensionOptions: { clipboardTextSerializer: COPY_TEXT },
  });
}

export interface PaneSetup { pageSetup: PageSetup; pageless: boolean; defaults?: DocDefaults }

/** Token ranges to draw on the pane, from the engine */
export interface PaneMarks {
  copied?: [number, number][];
  skipped?: [number, number][];
  /** First tokens of whole new blocks (tables) */
  blocks?: number[];
}

/** The page shows text that sets no font or size of its own in the document's named styles (as use-page-setup does for the editor) */
function applyDefaults(editor: Editor, d: DocDefaults | undefined) {
  const dom = editor.view.dom as HTMLElement;
  dom.style.setProperty("--ss-doc-font", d ? screenStack(d.fontFamily) : "");
  dom.style.setProperty("--ss-doc-size", d ? `${d.fontSize}pt` : "");
  for (const name of NAMED_STYLE_ORDER) {
    const s = d?.styles[name];
    dom.style.setProperty(`--ss-size-${name}`, s?.fontSize ? `${s.fontSize}pt` : "");
    dom.style.setProperty(`--ss-font-${name}`, s?.fontFamily ? screenStack(s.fontFamily) : "");
    dom.style.setProperty(`--ss-color-${name}`, s?.color ?? "");
  }
  dom.dataset.docFont = d?.fontFamily ?? "";
  if (d?.spacingMode === "NEVER_COLLAPSE") dom.dataset.docSm = "never";
  else delete dom.dataset.docSm;
  if (d) dom.dataset.docDefaults = JSON.stringify(d);
  else delete dom.dataset.docDefaults;
}

interface ComparePaneProps {
  editor: Editor | null;
  /** "Your document · after the sync" or "Reference" */
  title: string;
  /** The tab shown, in a document with more than one */
  tabTitle?: string | null;
  /** Beside the title: what the highlight means */
  legend?: React.ReactNode;
  doc: EditorNode | null;
  /** Changes when the document shown should be loaded again */
  docKey: string;
  glow: boolean;
  setup: PaneSetup | null;
  zoom: number | "fit";
  marks?: PaneMarks;
  loading?: boolean;
  /** Shown instead of a page (nothing to show yet, or a tab that isn't copied) */
  placeholder?: React.ReactNode;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  /** Over the page, kept in view (the bar shown while placing breaks) */
  overlay?: React.ReactNode;
  /** Called once a document is in and drawn */
  onLoaded?: () => void;
  className?: string;
}

export function ComparePane(p: ComparePaneProps) {
  const { editor, doc, docKey, glow, setup, zoom, marks, onLoaded } = p;
  const [width, setWidth] = useState(0);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = p.scrollerRef.current;
    if (!el) return;
    const measure = () => { setWidth(el.clientWidth); setNarrow(window.matchMedia("(max-width: 720px)").matches); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.scrollerRef]);

  const pageSetup = setup?.pageSetup ?? DEFAULT_PAGE_SETUP;
  const geometry = useMemo(() => pageGeometry(pageSetup), [pageSetup]);
  const pageless = !!setup?.pageless || narrow;
  // Fit: the page shrinks to the pane; on a phone the page reflows instead, as the editor's does
  const fit = narrow ? 1 : width ? Math.min(1, Math.max(0.2, (width - 40) / geometry.w)) : 0.5;
  const scale = zoom === "fit" || narrow ? fit : zoom / 100;

  useEffect(() => { editor?.commands.setPageGeometry(geometry); }, [editor, geometry]);
  useEffect(() => { editor?.commands.setPaginated(!pageless); }, [editor, pageless]);
  useEffect(() => { if (editor && !editor.isDestroyed) applyDefaults(editor, setup?.defaults); }, [editor, setup?.defaults]);

  // The document, loaded once per key; the fonts it uses come with it
  const loadedKey = useRef<string | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const d = docRef.current;
    if (!d) { loadedKey.current = null; return; }
    if (loadedKey.current === docKey) return;
    loadDocument(editor, d, glow);
    loadedKey.current = docKey;
    const defaults = setup?.defaults;
    const fonts = fontsIn(d, defaults ? [defaults.fontFamily, ...Object.values(defaults.styles).map((s) => s?.fontFamily ?? "")] : []);
    loadFonts(fonts);
    fontMetrics(fonts.keys());
  }, [editor, docKey, glow, setup?.defaults]);

  // Highlights, drawn on the document now in the pane
  const marksKey = JSON.stringify(marks ?? null);
  useEffect(() => {
    if (!editor || editor.isDestroyed || loadedKey.current !== docKey) return;
    const positions = tokenPositions(editor.state.doc);
    const size = editor.state.doc.content.size;
    const ranges = (list?: [number, number][]) => (list ?? []).map((r) => tokenRange(positions, r, size)).filter((r): r is { from: number; to: number } => !!r);
    const blocks = (marks?.blocks ?? []).map((t) => positions[t]).filter((x): x is number => typeof x === "number");
    setCompareMarks(editor.view, { copied: ranges(marks?.copied), skipped: ranges(marks?.skipped), blocks, flash: null });
    onLoaded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, docKey, marksKey]);

  const showPage = !!doc && !p.placeholder;
  return (
    <section className={`ss-cmp-pane ${p.className ?? ""}`} aria-label={p.title}>
      <div className="ss-cmp-pane-head">
        <span className="ss-cmp-pane-title">{p.title}</span>
        {p.tabTitle && <span className="ss-cmp-pane-tab" title={`Tab: ${p.tabTitle}`}><span className="ss-cmp-pane-dot" aria-hidden="true">·</span>{p.tabTitle}</span>}
        {p.legend && <span className="ss-cmp-legend">{p.legend}</span>}
      </div>
      <div ref={p.scrollerRef} className="ss-cmp-scroll ss-canvas" onScroll={p.onScroll} tabIndex={0} role="region" aria-label={`${p.title}${p.tabTitle ? `, ${p.tabTitle}` : ""}, scroll with the arrow keys`} aria-busy={p.loading || undefined}>
        {p.overlay}
        {p.loading && <PageSkeleton scale={fit} w={narrow ? Math.max(0, width - 16) / fit : geometry.w} />}
        {!p.loading && p.placeholder}
        <div style={{ display: showPage && !p.loading ? undefined : "none" }}>
          <PagedSurface editor={editor} pageless={pageless} scale={scale} pageColor={pageSetup.color} />
        </div>
      </div>
    </section>
  );
}

/** Grey lines on a white page while the documents are read */
function PageSkeleton({ scale, w }: { scale: number; w: number }) {
  const lines = [92, 100, 96, 100, 64, 0, 100, 98, 100, 86, 0, 100, 94, 72];
  return (
    <div className="ss-cmp-skeleton" style={{ width: w * scale, height: w * scale * 1.2 }} aria-hidden="true">
      <div className="ss-cmp-skel-title" />
      {lines.map((l, i) => <div key={i} className="ss-cmp-skel-line" style={{ width: `${l}%`, opacity: l ? 1 : 0 }} />)}
    </div>
  );
}
