"use client";

import React from "react";
import { EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { PAGE, PAGE_STRIDE, paginationKey } from "./pagination";

/** The editor on white US Letter sheets, or one continuous sheet when pageless. */
export function PagedSurface({
  editor,
  pageless,
  scale,
  onMouseDown,
}: {
  editor: Editor | null;
  pageless: boolean;
  scale: number;
  onMouseDown?: (e: React.MouseEvent) => void;
}) {
  const pages = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? paginationKey.getState(e.state)?.pages ?? 1 : 1),
  }) ?? 1;

  return (
    <div
      className={`ss-pages ${pageless ? "ss-pageless" : ""}`}
      style={{ zoom: scale, height: pageless ? undefined : pages * PAGE_STRIDE - PAGE.gap }}
    >
      {pageless ? (
        <div className="ss-sheet" style={{ top: 0 }} />
      ) : (
        Array.from({ length: pages }, (_, k) => <div key={k} className="ss-sheet" style={{ top: k * PAGE_STRIDE }} />)
      )}
      <div className="ss-sheet-content" onMouseDown={onMouseDown}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
