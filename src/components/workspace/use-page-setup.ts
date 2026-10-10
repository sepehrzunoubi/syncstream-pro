/**
 * The page: its setup (paper, margins, pageless), zoom and fit, the
 * document's own fonts, and the page breaks pinned where Google starts
 * each page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { EditorNode } from "@/lib/rich-text";
import { NAMED_STYLE_ORDER } from "@/lib/rich-text";
import { DEFAULT_PAGE_SETUP, documentStyleRequest, pageGeometry, pageSize, samePageSetup, type PageSetup } from "@/lib/page-setup";
import { pageStartOffsets } from "@/lib/page-offsets";
import { tokenize } from "@/lib/doc-model";
import { tokenPositions } from "./pagination";
import { postJson } from "./api";
import { writePageDefault } from "./storage";
import type { DocContent, DocRefs, Setter } from "./doc-state";

export function usePageSetup({ editor, viewer, refs, saveNow, setSnack, setScopeError, ready, docContent }: {
  editor: Editor | null;
  viewer: Editor | null;
  refs: DocRefs;
  saveNow: () => Promise<boolean>;
  setSnack: Setter<string | null>;
  setScopeError: Setter<boolean>;
  ready: boolean;
  docContent: DocContent | null;
}) {
  const { docContentRef, revisionRef } = refs;
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const canvasRef = useRef<HTMLElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const [narrow, setNarrow] = useState(false);
  const [pageless, setPageless] = useState(false);
  const [pageSetup, setPageSetup] = useState<PageSetup>(DEFAULT_PAGE_SETUP);

  const geometry = useMemo(() => pageGeometry(pageSetup), [pageSetup]);
  /** Width of the text area in points, for column widths */
  const textWidthPt = pageSize(pageSetup).w - pageSetup.margins.left - pageSetup.margins.right;
  // "Fit" zoom: shrink the page to the space between the side columns.
  // Below 720px the page reflows instead (see docs.css), so no scaling there.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      setFitScale(w < 720 ? 1 : Math.min(1, (w - 48) / geometry.w));
      setNarrow(w < 720);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready, geometry.w]);
  useEffect(() => {
    editor?.commands.setPageGeometry(geometry);
    viewer?.commands.setPageGeometry(geometry);
  }, [editor, viewer, geometry]);
  const scale = zoom === "fit" ? fitScale : zoom / 100;
  // Narrow screens reflow the page, so page breaks would be wrong there
  const effectivePageless = pageless || narrow;
  useEffect(() => {
    editor?.commands.setPaginated(!effectivePageless);
    viewer?.commands.setPaginated(!effectivePageless);
  }, [editor, viewer, effectivePageless]);

  // ── Google's pagination ──
  // After the document is opened or saved, Drive's PDF of it says where Docs starts each page;
  // the preview pins its page breaks there and only measures what comes after
  const pagesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pagesRevision = useRef("");
  const pinGooglePages = useCallback(async (docId: string) => {
    if (!editor) return;
    let res: Response;
    try { res = await fetch(`/api/docs/pages?id=${encodeURIComponent(docId)}`); } catch { return; } // pins are optional
    if (!res.ok) return;
    const data = (await res.json().catch(() => ({}))) as { pages?: string[] };
    if (!Array.isArray(data.pages) || docContentRef.current?.docId !== docId) return;
    // The saved text, token by token, so each offset maps to a document position
    const positions = tokenPositions(editor.state.doc);
    const all = tokenize(editor.getJSON() as EditorNode);
    let body = "";
    const tokenAt: number[] = [];
    all.forEach((t, i) => {
      if ((t.k === "c" || t.k === "img" || t.k === "pb") && t.pending) return;
      const ch = t.k === "c" ? t.c : t.k === "nl" ? "\n" : t.k === "img" || t.k === "pb" || t.k === "fn" ? " " : "";
      for (let k = 0; k < ch.length; k++) tokenAt.push(i);
      body += ch;
    });
    const pins = pageStartOffsets(body, data.pages).map((o) => (o == null ? null : positions[tokenAt[o]])).filter((p): p is number => typeof p === "number");
    editor.commands.setPinnedBreaks(pins);
  }, [editor, docContentRef]);
  useEffect(() => {
    const content = docContent;
    if (content?.status !== "ready" || !content.revisionId || content.revisionId === pagesRevision.current) return;
    pagesRevision.current = content.revisionId;
    if (pagesTimer.current) clearTimeout(pagesTimer.current);
    pagesTimer.current = setTimeout(() => { void pinGooglePages(content.docId); }, 1500);
  }, [docContent, pinGooglePages]);
  useEffect(() => () => { if (pagesTimer.current) clearTimeout(pagesTimer.current); }, []);
  useEffect(() => { if (docContent?.status !== "ready") editor?.commands.setPinnedBreaks([]); }, [docContent?.status, editor]);

  // The page shows text that sets no font or size of its own in the document's own defaults
  const docDefaults = docContent?.status === "ready" ? docContent.defaults : undefined;
  useEffect(() => {
    for (const e of [editor, viewer]) {
      const dom = e?.view.dom as HTMLElement | undefined;
      if (!dom) continue;
      dom.style.setProperty("--ss-doc-font", docDefaults ? `"${docDefaults.fontFamily}", Arimo, sans-serif` : "");
      dom.style.setProperty("--ss-doc-size", docDefaults ? `${docDefaults.fontSize}pt` : "");
      for (const name of NAMED_STYLE_ORDER) {
        const s = docDefaults?.styles[name];
        dom.style.setProperty(`--ss-size-${name}`, s?.fontSize ? `${s.fontSize}pt` : "");
        dom.style.setProperty(`--ss-font-${name}`, s?.fontFamily ? `"${s.fontFamily}", Arimo, sans-serif` : "");
        dom.style.setProperty(`--ss-color-${name}`, s?.color ?? "");
      }
      dom.dataset.docFont = docDefaults?.fontFamily ?? "";
    }
  }, [editor, viewer, docDefaults]);

  /** Page setup from the dialog: shown here, and written to the open Google Doc */
  const applyPageSetup = useCallback(async (next: PageSetup, nextPageless: boolean) => {
    setPageless(nextPageless);
    const prev = pageSetup;
    if (samePageSetup(prev, next)) return;
    setPageSetup(next);
    const content = docContentRef.current;
    if (content?.status !== "ready") return;
    await saveNow();
    const { ok, status, data } = await postJson<{ revisionId: string }>("/api/docs/edit", {
      documentId: content.docId,
      revisionId: revisionRef.current,
      requests: [documentStyleRequest(next)],
    });
    if (ok) { if (data.revisionId) revisionRef.current = data.revisionId; return; }
    setPageSetup(prev);
    if (status === 401) setScopeError(true);
    setSnack(data.error || "Couldn't change the page setup in Google Docs");
  }, [pageSetup, saveNow, docContentRef, revisionRef, setScopeError, setSnack]);
  const setPageDefault = useCallback((setup: PageSetup, nextPageless: boolean) => {
    writePageDefault(setup, nextPageless);
    setSnack("New documents will use this page setup");
  }, [setSnack]);

  return { zoom, setZoom, canvasRef, pageless, setPageless, pageSetup, setPageSetup, geometry, textWidthPt, scale, effectivePageless, applyPageSetup, setPageDefault };
}
