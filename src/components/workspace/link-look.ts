/**
 * A link's look is its text's own style, as in Docs: a link copied from a
 * document keeps its colour and underline, even when it has neither. Docs
 * gives a link its look when it is made (blue, underlined), and so does the
 * editor: text that becomes a link here (the link dialog, a typed or pasted
 * web address) is coloured and underlined then, as Docs would. Undo and redo
 * put back what was there, look included.
 */
import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { AddMarkStep } from "@tiptap/pm/transform";
import { Plugin, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { LINK_COLOR } from "@/lib/rich-text";

/** Marks for text that becomes a link: underlined, in Docs' link colour, its font and size kept */
export function linkLookMarks(schema: Schema, node: PMNode | null) {
  const ts = schema.marks.textStyle;
  const underline = schema.marks.underline;
  const own = node?.marks.find((m) => m.type === ts);
  return [
    ...(ts ? [ts.create({ ...(own?.attrs ?? {}), color: LINK_COLOR })] : []),
    ...(underline ? [underline.create()] : []),
  ];
}

/** The look Docs gives new links, for text the steps of `trs` made a link; null when they made none */
export function lookForNewLinks(trs: readonly Transaction[], state: EditorState): Transaction | null {
  const link = state.schema.marks.link;
  if (!link) return null;
  // Ranges of the final document that became links
  const made: [number, number][] = [];
  trs.forEach((tr, t) => {
    if (isHistoryTransaction(tr)) return;
    const toFinal = (pos: number, assoc: number, from: number) => {
      let p = tr.mapping.slice(from).map(pos, assoc);
      for (const later of trs.slice(t + 1)) p = later.mapping.map(p, assoc);
      return p;
    };
    tr.steps.forEach((step, i) => {
      if (!(step instanceof AddMarkStep) || step.mark.type !== link) return;
      tr.docs[i].nodesBetween(step.from, step.to, (node, pos) => {
        if (!node.isText || link.isInSet(node.marks)) return;
        const a = Math.max(pos, step.from);
        const b = Math.min(pos + node.nodeSize, step.to);
        // A link given a new address was taken off first: what counts is whether the text was a link
        // before this transaction (text it typed is new)
        const back = tr.mapping.slice(0, i).invert();
        const ba = back.map(a, 1);
        const bb = back.map(b, -1);
        if (ba >= bb) { made.push([toFinal(a, 1, i), toFinal(b, -1, i)]); return; }
        tr.before.nodesBetween(ba, bb, (was, at) => {
          if (!was.isText || link.isInSet(was.marks)) return;
          made.push([toFinal(Math.max(at, ba), 1, 0), toFinal(Math.min(at + was.nodeSize, bb), -1, 0)]);
        });
      });
    });
  });
  const out = state.tr;
  for (const [from, to] of made) {
    if (from >= to) continue;
    state.doc.nodesBetween(from, to, (now, at) => {
      if (!now.isText || !link.isInSet(now.marks)) return;
      const a = Math.max(at, from);
      const b = Math.min(at + now.nodeSize, to);
      for (const m of linkLookMarks(state.schema, now)) out.addMark(a, b, m);
    });
  }
  return out.docChanged ? out : null;
}

export const LinkLook = Extension.create({
  name: "linkLook",
  addProseMirrorPlugins() {
    return [new Plugin({ appendTransaction: (trs, _old, state) => lookForNewLinks(trs, state) })];
  },
});
