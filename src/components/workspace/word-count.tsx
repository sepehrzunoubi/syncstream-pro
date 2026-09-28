"use client";

import React from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { countWords } from "@/lib/format";
import { PENDING_MARK } from "@/lib/doc-model";

/** Text as Docs counts it: paragraphs and line breaks separate words, images count as nothing */
const leaf = (node: PMNode) => (node.type.name === "hardBreak" ? "\n" : "");
const chars = (text: string) => text.replace(/\n/g, "").length;
const fmt = (n: number) => n.toLocaleString();

/**
 * Always-on word and character count, where Docs shows its word count box.
 * With a selection it counts the selection; new (glowing) text is counted too.
 */
export function WordCount({ editor }: { editor: Editor | null }) {
  const c = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const { doc, selection } = e.state;
      const all = doc.textBetween(0, doc.content.size, "\n", leaf);
      let added = "";
      let last = -1;
      doc.descendants((node, pos) => {
        if (!node.isText || !node.marks.some((m) => m.type.name === PENDING_MARK)) return;
        added += (last === pos ? "" : " ") + node.text;
        last = pos + node.nodeSize;
      });
      const sel = selection.empty ? null : doc.textBetween(selection.from, selection.to, "\n", leaf);
      return {
        words: countWords(all),
        chars: chars(all),
        selWords: sel == null ? null : countWords(sel),
        selChars: sel == null ? null : chars(sel),
        addedWords: countWords(added),
      };
    },
  });
  if (!c) return null;
  return (
    <div className="ss-wordcount-row ss-noprint">
      <div className="ss-wordcount" role="status" aria-live="polite" title="Word count">
        {c.selWords != null ? (
          <>
            <span>{fmt(c.selWords)} of {fmt(c.words)} words</span>
            <span className="ss-wordcount-sep" />
            <span>{fmt(c.selChars ?? 0)} of {fmt(c.chars)} characters</span>
          </>
        ) : (
          <>
            <span>{fmt(c.words)} {c.words === 1 ? "word" : "words"}</span>
            <span className="ss-wordcount-sep" />
            <span>{fmt(c.chars)} {c.chars === 1 ? "character" : "characters"}</span>
          </>
        )}
        {c.addedWords > 0 && (
          <>
            <span className="ss-wordcount-sep" />
            <span className="ss-wordcount-new">{fmt(c.addedWords)} new</span>
          </>
        )}
      </div>
    </div>
  );
}
