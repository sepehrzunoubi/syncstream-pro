"use client";

import React from "react";
import { EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { DEFAULT_GEOMETRY, PAGE_GAP, paginationKey } from "./pagination";
import { SegmentView } from "./segment-editor";

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
}: {
  editor: Editor | null;
  pageless: boolean;
  scale: number;
  /** Page colour from the page setup; null for white */
  pageColor?: string | null;
  onMouseDown?: (e: React.MouseEvent) => void;
  headerFooters?: HeaderFooters;
}) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const s = e ? paginationKey.getState(e.state) : null;
      return { pages: s?.pages ?? 1, geometry: s?.geometry ?? DEFAULT_GEOMETRY };
    },
  });
  const pages = st?.pages ?? 1;
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
