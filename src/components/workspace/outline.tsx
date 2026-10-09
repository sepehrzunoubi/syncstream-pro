"use client";

import React from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";

const LEVEL: Record<string, number> = { title: 0, h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Docs' document outline: the headings, click to jump */
export function Outline({ editor }: { editor: Editor | null }) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return [] as { pos: number; level: number; text: string }[];
      const out: { pos: number; level: number; text: string }[] = [];
      e.state.doc.descendants((node, pos) => {
        if (node.type.name !== "paragraph") return node.type.name === "columnSection";
        const level = LEVEL[node.attrs.styleName as string];
        if (level == null) return false;
        const text = node.textContent.trim();
        if (text) out.push({ pos, level, text });
        return false;
      });
      return out;
    },
  }) ?? [];
  if (!editor) return null;
  return (
    <nav className="ss-outline" aria-label="Document outline">
      <h2 className="ss-outline-title">Outline</h2>
      {headings.length === 0 ? (
        <p className="ss-outline-empty">Headings that you add to the document will appear here.</p>
      ) : (
        <ul>
          {headings.map((h) => (
            <li key={h.pos} style={{ paddingLeft: 12 + Math.max(0, h.level - 1) * 12 }} data-level={h.level}>
              <button type="button" className="ss-outline-item" onClick={() => editor.chain().focus().setTextSelection(h.pos + 1).scrollIntoView().run()}>{h.text}</button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
