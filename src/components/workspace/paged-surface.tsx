"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import type { EditorNode } from "@/lib/rich-text";
import { DEFAULT_GEOMETRY, PAGE_GAP, paginationKey } from "./pagination";
import { SegmentView, FootnoteItem } from "./segment-editor";

/** Footnotes of the open document, with where each reference is */
export interface FootnotesProps {
  items: { id: string; base: EditorNode[] }[];
  onChange: (id: string, doc: JSONContent) => void;
  onFocus: (id: string, editor: Editor) => void;
}

/** Header and footer editors and where they sit, from the document's page setup */
export interface HeaderFooters {
  header: Editor | null;
  footer: Editor | null;
  firstPageHeader: Editor | null;
  firstPageFooter: Editor | null;
  useFirstPage: boolean;
  /** Points from the page edge */
  marginHeader: number;
  marginFooter: number;
  /** Which is being edited, for its outline and options */
  editing: "header" | "footer" | null;
  onDoubleClick: (which: "header" | "footer") => void;
  /** Docs' options under the one being edited */
  options?: React.ReactNode;
}

/** The editor on white sheets of the document's paper size, or one continuous sheet when pageless. */
export function PagedSurface({
  editor,
  pageless,
  scale,
  pageColor,
  onMouseDown,
  headerFooters,
  footnotes,
}: {
  editor: Editor | null;
  pageless: boolean;
  scale: number;
  /** Page colour from the page setup; null for white */
  pageColor?: string | null;
  onMouseDown?: (e: React.MouseEvent) => void;
  headerFooters?: HeaderFooters;
  footnotes?: FootnotesProps;
}) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const s = e ? paginationKey.getState(e.state) : null;
      // Which page each footnote reference is on: the breaks before it
      const refPages: Record<string, number> = {};
      if (e && s?.enabled) {
        e.state.doc.descendants((node, pos) => {
          if (node.type.name === "footnoteRef" && typeof node.attrs.fid === "string") refPages[node.attrs.fid] = s.breaks.filter((b) => b.pos <= pos).length;
        });
      }
      return { pages: s?.pages ?? 1, geometry: s?.geometry ?? DEFAULT_GEOMETRY, refPages: JSON.stringify(refPages) };
    },
  });
  const pages = st?.pages ?? 1;
  const refPages = useMemo(() => JSON.parse(st?.refPages ?? "{}") as Record<string, number>, [st?.refPages]);
  // Footnotes in reference order, numbered as the text numbers them
  const footnoteOrder = useMemo(() => {
    const order: { id: string; n: number; page: number }[] = [];
    if (!footnotes || !editor) return order;
    let n = 0;
    editor.state.doc.descendants((node) => { if (node.type.name === "footnoteRef" && typeof node.attrs.fid === "string") order.push({ id: node.attrs.fid, n: ++n, page: refPages[node.attrs.fid] ?? 0 }); });
    return order;
  }, [footnotes, editor, refPages]);
  // The space footnotes take at the bottom of each page is kept clear of text
  const areaRefs = useRef<Record<number, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!editor || pageless) return;
    const report = () => {
      const reserves: number[] = [];
      for (const [k, el] of Object.entries(areaRefs.current)) if (el) reserves[Number(k)] = el.getBoundingClientRect().height / (scale || 1) + 8;
      editor.commands.setPageReserves(Array.from({ length: pages }, (_, i) => reserves[i] ?? 0));
    };
    report();
    const ro = new ResizeObserver(report);
    for (const el of Object.values(areaRefs.current)) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [editor, pageless, pages, footnoteOrder, scale]);
  const g = st?.geometry ?? DEFAULT_GEOMETRY;
  const stride = g.h + PAGE_GAP;
  const px = (pt: number) => Math.round((pt * 96) / 72);
  const vars = {
    "--ss-page-w": `${g.w}px`,
    "--ss-page-h": `${g.h}px`,
    "--ss-m-top": `${g.top}px`,
    "--ss-m-bottom": `${g.bottom}px`,
    "--ss-m-left": `${g.left}px`,
    "--ss-m-right": `${g.right}px`,
    "--ss-page-color": pageColor ?? "#fff",
  } as React.CSSProperties;

  return (
    <div
      className={`ss-pages ${pageless ? "ss-pageless" : ""}`}
      style={{ ...vars, zoom: scale, height: pageless ? undefined : pages * stride - PAGE_GAP }}
    >
      {pageless ? (
        <div className="ss-sheet" style={{ top: 0 }} />
      ) : (
        Array.from({ length: pages }, (_, k) => {
          const hf = headerFooters;
          const first = k === 0 && !!hf?.useFirstPage;
          const header = first ? hf?.firstPageHeader ?? null : hf?.header ?? null;
          const footer = first ? hf?.firstPageFooter ?? null : hf?.footer ?? null;
          // The editor lives on the first page that shows it; later pages show copies
          const liveHeader = header ? (first ? k === 0 : k === (hf?.useFirstPage ? 1 : 0)) : false;
          const liveFooter = footer ? (first ? k === 0 : k === (hf?.useFirstPage ? 1 : 0)) : false;
          return (
            <div key={k} className="ss-sheet" style={{ top: k * stride }}>
              {/* Double-clicking a page margin opens its header or footer, as in Docs */}
              {hf && <div className="ss-hf-zone" style={{ top: 0, height: g.top }} onDoubleClick={() => hf.onDoubleClick("header")} />}
              {hf && <div className="ss-hf-zone" style={{ bottom: 0, height: g.bottom }} onDoubleClick={() => hf.onDoubleClick("footer")} />}
              {hf && header && (
                <div className={`ss-hf ss-hf-header ${hf.editing === "header" ? "ss-hf-editing" : ""}`} style={{ top: px(hf.marginHeader), left: g.left, right: g.right }} onDoubleClick={() => hf.onDoubleClick("header")}>
                  <SegmentView editor={header} live={liveHeader} className="ss-hf-body" />
                  {liveHeader && hf.editing === "header" && hf.options}
                </div>
              )}
              {footnotes && footnoteOrder.some((f) => f.page === k) && (
                <div className="ss-footnotes" style={{ bottom: g.bottom, left: g.left }} ref={(el) => { areaRefs.current[k] = el; }}>
                  {footnoteOrder.filter((f) => f.page === k).map((f) => {
                    const item = footnotes.items.find((x) => x.id === f.id);
                    return item ? <FootnoteItem key={f.id} id={f.id} n={f.n} base={item.base} onChange={footnotes.onChange} onFocus={footnotes.onFocus} /> : null;
                  })}
                </div>
              )}
              {hf && footer && (
                <div className={`ss-hf ss-hf-footer ${hf.editing === "footer" ? "ss-hf-editing" : ""}`} style={{ bottom: px(hf.marginFooter), left: g.left, right: g.right }} onDoubleClick={() => hf.onDoubleClick("footer")}>
                  {liveFooter && hf.editing === "footer" && hf.options}
                  <SegmentView editor={footer} live={liveFooter} className="ss-hf-body" />
                </div>
              )}
            </div>
          );
        })
      )}
      <div className="ss-sheet-content" onMouseDown={onMouseDown}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
