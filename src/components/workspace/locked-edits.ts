/**
 * Editing across locked content, the way Google Docs does it.
 *
 * Locked paragraphs (section breaks, smart chips, a table of contents) and
 * tables that a selection reaches into from outside can't be changed here,
 * but the text around them can. When a selection spans editable text and
 * such blocks, Delete, Backspace, Cut and typing act on the editable parts
 * only: each is deleted (typed text goes where the selection began) and the
 * blocks stay in place, as separators between what is left.
 *
 * Docs needs a paragraph to end right before every section break and table
 * (and the body to end with one), so the paragraph just before a kept block
 * is emptied rather than removed; paragraphs before it in the selection go
 * whole, and text before the selection joins what is left, as any deletion
 * across paragraphs would.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

export const isLocked = (node: PMNode) => node.attrs.locked === true;

/** Locked paragraphs, at the top level and inside column sections */
export function lockedRanges(doc: PMNode): [number, number][] {
  const ranges: [number, number][] = [];
  doc.descendants((node, pos) => { if (isLocked(node)) { ranges.push([pos, pos + node.nodeSize]); return false; } return node.type.name === "columnSection"; });
  return ranges;
}

/**
 * The blocks a selection from `from` to `to` must leave alone: locked
 * paragraphs, and tables the selection reaches into from outside (a
 * selection inside one table edits it as usual).
 */
export function keptRanges(doc: PMNode, from: number, to: number): [number, number][] {
  const ranges: [number, number][] = [];
  doc.descendants((node, pos) => {
    const end = pos + node.nodeSize;
    if (isLocked(node)) { ranges.push([pos, end]); return false; }
    if (node.type.name === "table") {
      if (!(from >= pos && to <= end)) ranges.push([pos, end]);
      return false;
    }
    return node.type.name === "columnSection";
  });
  return ranges.filter(([a, b]) => a < to && b > from).sort((x, y) => x[0] - y[0]);
}

/** The end of the content of the last paragraph before `pos` (a position between blocks), or null */
function textblockEndBefore(doc: PMNode, pos: number): number | null {
  let $p = doc.resolve(pos);
  while ($p.depth > 0 && !$p.nodeBefore) $p = doc.resolve($p.before());
  let p = $p.pos;
  let node = $p.nodeBefore;
  // Step into a column section or table down to its last paragraph
  while (node && !node.isTextblock && node.lastChild) { p -= 1; node = node.lastChild; }
  return node?.isTextblock ? p - 1 : null;
}

/** True when the range holds something to delete: inline content, or a whole block (an empty paragraph) */
function hasContent(doc: PMNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (node.isInline) { found = true; return false; }
    if (pos >= from && pos + node.nodeSize <= to) { found = true; return false; }
    return true;
  });
  return found;
}

/**
 * The editable parts of a selection that reaches locked content, in
 * document order, each ending inside the last paragraph it may empty. Null
 * when the selection reaches nothing locked (the editor's usual commands
 * apply); empty when nothing in it can be edited.
 */
export function editableParts(state: EditorState): [number, number][] | null {
  const { selection, doc } = state;
  if (selection.empty || !(selection instanceof TextSelection || selection instanceof AllSelection)) return null;
  const { from, to } = selection;
  const kept = keptRanges(doc, from, to);
  if (!kept.length) return null;
  const gaps: [number, number][] = [];
  let cur = from;
  for (const [a, b] of kept) {
    if (a > cur) gaps.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (cur < to) gaps.push([cur, to]);
  const parts: [number, number][] = [];
  for (const [a, b] of gaps) {
    // A gap ending between blocks (at a kept block, or the end of the document) keeps the paragraph before it
    const end = doc.resolve(b).parent.isTextblock ? b : textblockEndBefore(doc, b);
    if (end != null && end > a && hasContent(doc, a, end)) parts.push([a, end]);
  }
  return parts;
}

/**
 * Delete the parts, last first so earlier positions stay valid, and put the
 * caret where the selection began (or at the first editable spot after it).
 * Returns the caret position in the transaction's document.
 */
export function deleteParts(tr: Transaction, parts: [number, number][]): number {
  for (const [a, b] of [...parts].reverse()) {
    const $a = tr.doc.resolve(a);
    if ($a.parent.isTextblock) {
      // From inside a paragraph: its text before joins what is left after, as in any deletion
      tr.delete(a, b);
      continue;
    }
    // From between blocks: the last paragraph is emptied (it stays), the blocks before it go whole
    const $b = tr.doc.resolve(b);
    const start = $b.start();
    if (b > start) tr.delete(start, b);
    if ($b.before() > a) tr.delete(a, $b.before());
  }
  const $caret = tr.doc.resolve(tr.mapping.map(parts[0][0], -1));
  const selection = TextSelection.near($caret, 1);
  tr.setSelection(selection);
  return selection.from;
}
