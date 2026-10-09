"use client";

import React from "react";
import { EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { DEFAULT_GEOMETRY, PAGE_GAP, paginationKey } from "./pagination";

/** The editor on white sheets of the document's paper size, or one continuous sheet when pageless. */
export function PagedSurface({
  editor,
  pageless,
  scale,
  pageColor,
  onMouseDown,
}: {
  editor: Editor | null;
  pageless: boolean;
  scale: number;
  /** Page colour from the page setup; null for white */
  pageColor?: string | null;
  onMouseDown?: (e: React.MouseEvent) => void;
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
        Array.from({ length: pages }, (_, k) => <div key={k} className="ss-sheet" style={{ top: k * stride }} />)
      )}
      <div className="ss-sheet-content" onMouseDown={onMouseDown}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
