/**
 * Small transforms of editor JSON the workspace needs around loading and
 * saving a document: marking text as additions, keeping only additions, and
 * dropping what the editor would reject.
 */

import type { JSONContent } from "@tiptap/react";
import type { EditorNode } from "@/lib/rich-text";
import { PENDING_MARK } from "@/lib/doc-model";

/** Mark everything in a document as an addition (text from before this version, or a sync to redo) */
export function markAllAdded(doc: EditorNode): EditorNode {
  const mark = (n: EditorNode): EditorNode => {
    if (n.type === "text" || n.type === "image" || n.type === "hardBreak") {
      const marks = (n.marks ?? []).filter((m) => m.type !== PENDING_MARK);
      return { ...n, marks: [...marks, { type: PENDING_MARK }] };
    }
    return n.content ? { ...n, content: n.content.map(mark) } : n;
  };
  return mark(doc);
}

/** Only the additions of a document, for when the document itself can't be shown */
export function additionsOnly(doc: EditorNode): EditorNode {
  const content = (doc.content ?? [])
    .filter((p) => !p.attrs?.locked)
    .map((p) => ({ ...p, content: (p.content ?? []).filter((c) => c.marks?.some((m) => m.type === PENDING_MARK)) }))
    .filter((p) => p.content.length);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

export function plainToDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })),
  };
}

/** Drop what the editor would reject (empty text nodes), so one odd paragraph can't block the page */
export function sanitize(node: EditorNode): EditorNode | null {
  if (node.type === "text") return node.text ? node : null;
  if (!node.content) return node;
  return { ...node, content: node.content.map(sanitize).filter((n): n is EditorNode => n !== null) };
}
