/**
 * Lines break where Docs breaks them. Docs wraps at spaces and after dashes, but never after
 * the hyphen inside a word: "up-to-date" moves to the next line whole. A browser breaks after
 * any hyphen, so the same paragraph would wrap (and paginate) differently on the page.
 *
 * Each hyphen between two characters is drawn together with the character after it, in a span
 * that doesn't wrap. That takes away only the break after the hyphen: a word longer than the
 * line still breaks where it has to, as it does in Docs.
 */

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** A hyphen with something other than a space on both sides; the group is the character after it */
const HYPHEN = /(?<=\S)-(?=(\S))/gu;
const KEEP = { class: "ss-nobreak" };

/** The hyphens of one paragraph (start: the position of its first character) */
export function hyphenRanges(block: PMNode, start: number): [number, number][] {
  // One character per position: text as it is, anything else inline as a break
  let text = "";
  block.forEach((child) => {
    text += child.isText ? child.text! : "\n".repeat(child.nodeSize);
  });
  const out: [number, number][] = [];
  for (const m of text.matchAll(HYPHEN)) out.push([start + m.index, start + m.index + 1 + m[1].length]);
  return out;
}

function decorate(block: PMNode, start: number): Decoration[] {
  return hyphenRanges(block, start).map(([from, to]) => Decoration.inline(from, to, KEEP));
}

function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    decos.push(...decorate(node, pos + 1));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** The old set moved through the change, with the paragraphs the change touched worked out again */
function update(set: DecorationSet, tr: Transaction): DecorationSet {
  let next = set.map(tr.mapping, tr.doc);
  const size = tr.doc.content.size;
  tr.mapping.maps.forEach((map, i) => {
    const later = tr.mapping.slice(i + 1);
    map.forEach((_oldFrom, _oldTo, from, to) => {
      const a = Math.max(0, Math.min(size, later.map(from, -1)));
      const b = Math.max(a, Math.min(size, later.map(to, 1)));
      tr.doc.nodesBetween(a, b, (node, pos) => {
        if (!node.isTextblock) return true;
        const start = pos + 1;
        next = next.remove(next.find(start, start + node.content.size));
        next = next.add(tr.doc, decorate(node, start));
        return false;
      });
    });
  });
  return next;
}

const key = new PluginKey<DecorationSet>("ssLineBreaks");

export const DocsLineBreaks = Extension.create({
  name: "docsLineBreaks",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => build(state.doc),
          apply: (tr, set) => (tr.docChanged ? update(set, tr) : set),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
