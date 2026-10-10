"use client";

/**
 * Headers, footers and footnotes: each a Docs segment with its own editor,
 * saved directly (nothing in them glows), plus Insert > Headers & footers.
 */

import React, { useCallback, useMemo, useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
import type { EditorNode } from "@/lib/rich-text";
import { segmentEdits } from "@/lib/doc-model";
import { useSegmentEditor } from "./segment-editor";
import type { HeaderFooters } from "./paged-surface";
import { postJson } from "./api";
import type { DocRefs, Setter } from "./doc-state";

/** A header or footer: a Docs segment with the content as last saved */
export type Segment = { id: string; base: EditorNode[] };
export type Segments = { header: Segment | null; footer: Segment | null; firstPageHeader: Segment | null; firstPageFooter: Segment | null };
export type HfSetup = { useFirstPage: boolean; marginHeader: number; marginFooter: number };

export function useHeaderFooters({ editor, refs, saveNow, setSnack, setScopeError, editingHf, setEditingHf, setSegmentEditor }: {
  editor: Editor | null;
  refs: DocRefs;
  saveNow: () => Promise<boolean>;
  setSnack: Setter<string | null>;
  setScopeError: Setter<boolean>;
  editingHf: "header" | "footer" | null;
  setEditingHf: Setter<"header" | "footer" | null>;
  setSegmentEditor: Setter<Editor | null>;
}) {
  const { docContentRef, revisionRef } = refs;
  const [segments, setSegments] = useState<Segments>({ header: null, footer: null, firstPageHeader: null, firstPageFooter: null });
  const [hfSetup, setHfSetup] = useState<HfSetup>({ useFirstPage: false, marginHeader: 36, marginFooter: 36 });
  const [footnotes, setFootnotes] = useState<Record<string, EditorNode[]>>({});
  const footnotesRef = useRef(footnotes);
  footnotesRef.current = footnotes;

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const segmentTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveSegment = useCallback(async (key: keyof Segments, doc: JSONContent) => {
    const seg = segmentsRef.current[key];
    const content = docContentRef.current;
    if (!seg || content?.status !== "ready") return;
    const target = doc as EditorNode;
    const { requests } = segmentEdits({ type: "doc", content: seg.base }, target, seg.id);
    if (!requests.length) return;
    const { ok, status, data } = await postJson<{ revisionId: string }>("/api/docs/edit", { documentId: content.docId, revisionId: revisionRef.current, requests });
    if (ok) {
      if (data.revisionId) revisionRef.current = data.revisionId;
      setSegments((s) => (s[key] && s[key]!.id === seg.id ? { ...s, [key]: { id: seg.id, base: target.content ?? [] } } : s));
      return;
    }
    if (status === 401) setScopeError(true);
    setSnack(data.error || "Couldn't save the header or footer to Google Docs");
  }, [docContentRef, revisionRef, setScopeError, setSnack]);
  const segmentChanged = useCallback((key: keyof Segments) => (doc: JSONContent) => {
    clearTimeout(segmentTimers.current[key]);
    segmentTimers.current[key] = setTimeout(() => { void saveSegment(key, doc); }, 600);
  }, [saveSegment]);
  const segmentFocused = (which: "header" | "footer") => (e: Editor) => { setSegmentEditor(e); setEditingHf(which); };
  const footnoteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveFootnote = useCallback(async (id: string, doc: JSONContent) => {
    const base = footnotesRef.current[id];
    const content = docContentRef.current;
    if (!base || content?.status !== "ready") return;
    const { requests } = segmentEdits({ type: "doc", content: base }, doc as EditorNode, id);
    if (!requests.length) return;
    const { ok, status, data } = await postJson<{ revisionId: string }>("/api/docs/edit", { documentId: content.docId, revisionId: revisionRef.current, requests });
    if (ok) {
      if (data.revisionId) revisionRef.current = data.revisionId;
      setFootnotes((f) => (f[id] ? { ...f, [id]: (doc as EditorNode).content ?? [] } : f));
      return;
    }
    if (status === 401) setScopeError(true);
    setSnack(data.error || "Couldn't save the footnote to Google Docs");
  }, [docContentRef, revisionRef, setScopeError, setSnack]);
  const footnoteProps = useMemo(() => ({
    items: Object.entries(footnotes).map(([id, base]) => ({ id, base })),
    onChange: (id: string, doc: JSONContent) => { clearTimeout(footnoteTimers.current[id]); footnoteTimers.current[id] = setTimeout(() => { void saveFootnote(id, doc); }, 600); },
    onFocus: (_id: string, e: Editor) => { setSegmentEditor(e); setEditingHf(null); },
  }), [footnotes, saveFootnote, setSegmentEditor, setEditingHf]);
  const headerEditor = useSegmentEditor(segments.header?.base ?? null, segmentChanged("header"), segmentFocused("header"));
  const footerEditor = useSegmentEditor(segments.footer?.base ?? null, segmentChanged("footer"), segmentFocused("footer"));
  const firstHeaderEditor = useSegmentEditor(segments.firstPageHeader?.base ?? null, segmentChanged("firstPageHeader"), segmentFocused("header"));
  const firstFooterEditor = useSegmentEditor(segments.firstPageFooter?.base ?? null, segmentChanged("firstPageFooter"), segmentFocused("footer"));

  /** Docs requests for the open document, with the replies (ids of what was created) */
  const docEdit = useCallback(async (requests: Record<string, unknown>[]): Promise<Record<string, unknown>[] | null> => {
    const content = docContentRef.current;
    if (content?.status !== "ready") { setSnack("Open a Google Doc first"); return null; }
    await saveNow();
    const { ok, status, data } = await postJson<{ revisionId: string; replies?: Record<string, unknown>[] }>("/api/docs/edit", { documentId: content.docId, revisionId: revisionRef.current, requests });
    if (!ok) {
      if (status === 401) setScopeError(true);
      setSnack(data.error || "Couldn't change the document");
      return null;
    }
    if (data.revisionId) revisionRef.current = data.revisionId;
    return data.replies ?? [];
  }, [saveNow, docContentRef, revisionRef, setScopeError, setSnack]);

  /** Insert > Headers & footers: make the header or footer if the document has none, then edit it */
  const openHeaderFooter = useCallback(async (which: "header" | "footer") => {
    const cur = segmentsRef.current;
    const first = hfSetup.useFirstPage;
    const key = which === "header" ? (first ? "firstPageHeader" : "header") : first ? "firstPageFooter" : "footer";
    if (!cur[key]) {
      const req = which === "header" ? { createHeader: { type: first ? "FIRST_PAGE" : "DEFAULT" } } : { createFooter: { type: first ? "FIRST_PAGE" : "DEFAULT" } };
      const replies = await docEdit([req]);
      if (!replies) return;
      const reply = replies[0] as { createHeader?: { headerId?: string }; createFooter?: { footerId?: string } } | undefined;
      const id = reply?.createHeader?.headerId ?? reply?.createFooter?.footerId;
      if (!id) { setSnack("Google Docs didn't return the new " + which); return; }
      setSegments((s) => ({ ...s, [key]: { id, base: [{ type: "paragraph", attrs: {}, content: [] }] } }));
    }
    setEditingHf(which);
    const ed = which === "header" ? (first ? firstHeaderEditor : headerEditor) : first ? firstFooterEditor : footerEditor;
    setTimeout(() => ed?.commands.focus("end"), 50);
  }, [docEdit, hfSetup.useFirstPage, headerEditor, footerEditor, firstHeaderEditor, firstFooterEditor, setEditingHf, setSnack]);

  const removeHeaderFooter = useCallback(async (which: "header" | "footer") => {
    const cur = segmentsRef.current;
    const keys = which === "header" ? (["header", "firstPageHeader"] as const) : (["footer", "firstPageFooter"] as const);
    const requests = keys.map((k) => cur[k]).filter(Boolean).map((seg) => (which === "header" ? { deleteHeader: { headerId: seg!.id } } : { deleteFooter: { footerId: seg!.id } }));
    if (!requests.length) return;
    if (!(await docEdit(requests))) return;
    setSegments((s) => ({ ...s, [keys[0]]: null, [keys[1]]: null }));
    setEditingHf(null);
    setSegmentEditor(null);
    editor?.commands.focus();
  }, [docEdit, editor, setEditingHf, setSegmentEditor]);

  const setHeaderFooterOptions = useCallback(async (next: Partial<HfSetup>) => {
    const merged = { ...hfSetup, ...next };
    const style: Record<string, unknown> = {};
    const fields: string[] = [];
    if (next.useFirstPage != null) { style.useFirstPageHeaderFooter = next.useFirstPage; fields.push("useFirstPageHeaderFooter"); }
    if (next.marginHeader != null) { style.marginHeader = { magnitude: next.marginHeader, unit: "PT" }; fields.push("marginHeader"); }
    if (next.marginFooter != null) { style.marginFooter = { magnitude: next.marginFooter, unit: "PT" }; fields.push("marginFooter"); }
    const requests: Record<string, unknown>[] = [{ updateDocumentStyle: { documentStyle: style, fields: fields.join(",") } }];
    // Different first page: Docs keeps a separate header and footer for it
    const cur = segmentsRef.current;
    if (next.useFirstPage && !cur.firstPageHeader && cur.header) requests.push({ createHeader: { type: "FIRST_PAGE" } });
    if (next.useFirstPage && !cur.firstPageFooter && cur.footer) requests.push({ createFooter: { type: "FIRST_PAGE" } });
    const replies = await docEdit(requests);
    if (!replies) return;
    setHfSetup(merged);
    // Only add what was created: a header saved meanwhile keeps its new base
    setSegments((s) => {
      const created = { ...s };
      for (const r of replies as { createHeader?: { headerId?: string }; createFooter?: { footerId?: string } }[]) {
        if (r.createHeader?.headerId) created.firstPageHeader = { id: r.createHeader.headerId, base: [{ type: "paragraph", attrs: {}, content: [] }] };
        if (r.createFooter?.footerId) created.firstPageFooter = { id: r.createFooter.footerId, base: [{ type: "paragraph", attrs: {}, content: [] }] };
      }
      return created;
    });
  }, [docEdit, hfSetup]);

  const headerFooters: HeaderFooters = {
    header: segments.header ? headerEditor : null,
    footer: segments.footer ? footerEditor : null,
    firstPageHeader: segments.firstPageHeader ? firstHeaderEditor : null,
    firstPageFooter: segments.firstPageFooter ? firstFooterEditor : null,
    useFirstPage: hfSetup.useFirstPage,
    marginHeader: hfSetup.marginHeader,
    marginFooter: hfSetup.marginFooter,
    editing: editingHf,
    onDoubleClick: (which) => { void openHeaderFooter(which); },
    options: editingHf ? (
      <div className="ss-hf-options" onMouseDown={(e) => e.stopPropagation()}>
        <label className="ss-checkbox text-[12px]"><input type="checkbox" checked={hfSetup.useFirstPage} onChange={(e) => { void setHeaderFooterOptions({ useFirstPage: e.target.checked }); }} /> Different first page</label>
        <label className="flex items-center gap-2 text-[12px]">{editingHf === "header" ? "Header from top" : "Footer from bottom"}
          <input className="ss-input" style={{ width: 64, height: 28 }} defaultValue={String(Math.round(((editingHf === "header" ? hfSetup.marginHeader : hfSetup.marginFooter) / 72) * 100) / 100)} aria-label="Margin in inches"
            onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 0) void setHeaderFooterOptions(editingHf === "header" ? { marginHeader: v * 72 } : { marginFooter: v * 72 }); }} />
          <span className="text-[var(--ss-text-3)]">in</span>
        </label>
        <button type="button" className="ss-btn ss-btn-text" style={{ height: 28 }} onClick={() => { void removeHeaderFooter(editingHf); }}>Remove {editingHf}</button>
      </div>
    ) : null,
  };

  return { setSegments, setHfSetup, setFootnotes, footnoteProps, headerFooters, openHeaderFooter };
}
