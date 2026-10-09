"use client";

import React, { useEffect } from "react";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import { segmentExtensions } from "./extensions";
import type { EditorNode } from "@/lib/rich-text";

/**
 * An editor for one Docs segment (a header, footer or footnote). Its
 * content is saved directly, like Docs autosaves, so nothing in it glows.
 */
export function useSegmentEditor(content: EditorNode[] | null, onChange: (doc: JSONContent) => void, onFocus: (e: Editor) => void): Editor | null {
  const editor = useEditor({
    extensions: segmentExtensions(),
    immediatelyRender: false,
    editorProps: { attributes: { class: "ss-doc ss-segment-doc", spellcheck: "true" } },
    onUpdate: ({ editor: e }) => onChange(e.getJSON()),
    onFocus: ({ editor: e }) => onFocus(e),
  });
  // New content from the document (opened, or read back) replaces the editor's, unless the user is typing in it
  useEffect(() => {
    if (!editor || !content) return;
    if (editor.isFocused) return;
    const next = { type: "doc", content };
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(next)) return;
    editor.commands.setContent(next as JSONContent, { emitUpdate: false });
  }, [editor, content]);
  return editor;
}

/** The live editor, or a static copy of its content for the other pages */
export function SegmentView({ editor, live, className }: { editor: Editor | null; live: boolean; className: string }) {
  const html = useEditorState({ editor, selector: ({ editor: e }) => (e ? e.getHTML() : "") }) ?? "";
  if (!editor) return null;
  if (live) return <div className={className}><EditorContent editor={editor} /></div>;
  return <div className={className} aria-hidden="true"><div className="ss-doc ss-segment-doc" dangerouslySetInnerHTML={{ __html: html }} /></div>;
}

/** One footnote: its number and an editor for its text */
export function FootnoteItem({ id, n, base, onChange, onFocus }: { id: string; n: number; base: EditorNode[]; onChange: (id: string, doc: JSONContent) => void; onFocus: (id: string, editor: Editor) => void }) {
  const editor = useSegmentEditor(base, (doc) => onChange(id, doc), (e) => onFocus(id, e));
  return (
    <div className="ss-footnote">
      <span className="ss-footnote-n" aria-hidden="true">{n}</span>
      <div className="min-w-0 flex-1">{editor && <EditorContent editor={editor} />}</div>
    </div>
  );
}
