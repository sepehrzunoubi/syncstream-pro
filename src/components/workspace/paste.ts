/**
 * Pasting into the body editor: image files are uploaded, formatted
 * paragraphs keep their own formatting as Docs does, and plain text takes
 * the formatting of the paragraph it lands in.
 */

import { Fragment, Slice, type ResolvedPos } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { flattenPastedLists, inlinePastedStyles, pastedEmptyLines } from "./extensions";

export const imageFilesOf = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

export const transformPastedHTML = (html: string) => inlinePastedStyles(flattenPastedLists(pastedEmptyLines(html)));

export function handlePaste(view: EditorView, event: ClipboardEvent, slice: Slice, onImageFiles: (files: File[]) => void): boolean {
  const files = imageFilesOf(event.clipboardData?.files);
  if (files.length) {
    event.preventDefault();
    onImageFiles(files);
    return true;
  }
  // Pasting formatted paragraphs into an empty one (or over whole paragraphs) keeps every
  // pasted paragraph's own formatting, as Docs does; ProseMirror would merge the first into
  // the paragraph being replaced. Plain text (no HTML, or paste without formatting) keeps the
  // destination's formatting instead, also as Docs does.
  const hasHTML = !!event.clipboardData?.types.includes("text/html") && !(view as unknown as { input: { shiftKey: boolean } }).input.shiftKey;
  const { $from, $to } = view.state.selection;
  const first = slice.content.firstChild;
  const target = $from.parent;
  const wholeParagraphs = $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size;
  if (hasHTML && wholeParagraphs && slice.openStart > 0 && first?.type.name === "paragraph" && target.type.name === "paragraph" && !target.attrs.locked && $from.depth === 1 && $to.depth === 1) {
    const tr = view.state.tr.replace($from.before(), $to.after(), new Slice(slice.content, 0, 0)).scrollIntoView();
    view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste"));
    event.preventDefault();
    return true;
  }
  return false;
}

// Plain text takes the formatting of the paragraph it lands in
export function clipboardTextParser(text: string, $context: ResolvedPos): Slice {
  const schema = $context.doc.type.schema;
  const parent = $context.parent.type.name === "paragraph" ? $context.parent : null;
  const nodes = text.split(/\r\n?|\n/).map((line) => schema.nodes.paragraph.create(parent ? { ...parent.attrs, locked: false, span: null, bid: null, kind: null } : null, line ? schema.text(line, $context.marks()) : null));
  return new Slice(Fragment.from(nodes), 1, 1);
}
