/**
 * The compare panes' highlights: on the reference, the parts the sync will copy (in the glow new
 * text has) and the parts left out; on your document, the text that takes the reference's look; on
 * both, a change pointed out from the list flashes. Drawn as
 * decorations, so the documents themselves never change.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export type Range = { from: number; to: number };

interface CompareMarksState {
  copied: Range[];
  skipped: Range[];
  /** Text that takes the reference's look */
  restyled: Range[];
  /** Whole blocks (tables) that are new, outlined as one */
  blocks: number[];
  flash: (Range & { n: number }) | null;
  decos: DecorationSet;
}

export const compareMarksKey = new PluginKey<CompareMarksState>("ssCompareMarks");
type Patch = Partial<Pick<CompareMarksState, "copied" | "skipped" | "restyled" | "blocks" | "flash">>;

/**
 * Inline decorations only on text: one over an image (or another node drawn by a node view) makes
 * the view draw it again without its size. An image is pointed out through its paragraph instead.
 */
function decorate(doc: Parameters<typeof DecorationSet.create>[0], r: Range, cls: string, extra: Record<string, string>, out: Decoration[]) {
  const imageBlocks = new Set<number>();
  doc.nodesBetween(r.from, r.to, (node, pos, parent) => {
    if (node.isText) {
      const a = Math.max(pos, r.from), b = Math.min(pos + node.nodeSize, r.to);
      if (b > a) out.push(Decoration.inline(a, b, { class: cls, ...extra }));
      return false;
    }
    if (node.type.name === "image" && parent) {
      const $pos = doc.resolve(pos);
      imageBlocks.add($pos.before($pos.depth));
    }
    return true;
  });
  for (const at of imageBlocks) {
    const block = doc.nodeAt(at);
    if (block) out.push(Decoration.node(at, at + block.nodeSize, { class: `${cls}-img`, ...extra }));
  }
}

function build(doc: Parameters<typeof DecorationSet.create>[0], s: Omit<CompareMarksState, "decos">): DecorationSet {
  const size = doc.content.size;
  const decos: Decoration[] = [];
  const clip = (r: Range) => ({ from: Math.max(0, Math.min(r.from, size)), to: Math.max(0, Math.min(r.to, size)) });
  for (const r of s.copied) { const c = clip(r); if (c.to > c.from) decorate(doc, c, "ss-cmp-copy", {}, decos); }
  for (const r of s.skipped) { const c = clip(r); if (c.to > c.from) decorate(doc, c, "ss-cmp-skip", {}, decos); }
  for (const r of s.restyled) { const c = clip(r); if (c.to > c.from) decorate(doc, c, "ss-cmp-restyle", {}, decos); }
  for (const pos of s.blocks) {
    const node = pos >= 0 && pos < size ? doc.nodeAt(pos) : null;
    if (node && node.isBlock) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "ss-cmp-block" }));
  }
  if (s.flash) {
    const c = clip(s.flash);
    // A new attribute each time, so a second click on the same change flashes it again
    if (c.to > c.from) decorate(doc, c, "ss-cmp-flash", { "data-flash": String(s.flash.n) }, decos);
  }
  return DecorationSet.create(doc, decos);
}

export const CompareMarks = Extension.create({
  name: "compareMarks",
  addProseMirrorPlugins() {
    return [
      new Plugin<CompareMarksState>({
        key: compareMarksKey,
        state: {
          init: () => ({ copied: [], skipped: [], restyled: [], blocks: [], flash: null, decos: DecorationSet.empty }),
          apply: (tr, value, _old, state) => {
            const patch = tr.getMeta(compareMarksKey) as Patch | undefined;
            // A new document clears what was drawn on the last one
            if (tr.docChanged && !patch) {
              const loaded = tr.steps.some((s) => (s as unknown as { slice?: { size: number } }).slice?.size);
              if (loaded) return { copied: [], skipped: [], restyled: [], blocks: [], flash: null, decos: DecorationSet.empty };
              return { ...value, decos: value.decos.map(tr.mapping, tr.doc) };
            }
            if (!patch) return value;
            const next = { ...value, ...patch };
            return { ...next, decos: build(state.doc, next) };
          },
        },
        props: { decorations: (state) => compareMarksKey.getState(state)?.decos },
      }),
    ];
  },
});

export function setCompareMarks(view: EditorView, patch: Patch) {
  view.dispatch(view.state.tr.setMeta(compareMarksKey, patch).setMeta("addToHistory", false));
}
