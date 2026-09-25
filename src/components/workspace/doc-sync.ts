/**
 * Editing a Google Doc that already has text.
 *
 * The whole document is editable. Text the user types or pastes is an
 * addition: it gets the syncAdd mark, glows, and is typed into the Google
 * Doc by a sync. Everything else the user does (formatting, deleting) is a
 * direct edit that the workspace saves to the Google Doc right away.
 * Locked paragraphs (tables, smart chips) are shown but can't be changed.
 */

import { Extension, Mark, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { listLabels } from "@/lib/list-labels";
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceStep } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorNode } from "@/lib/rich-text";
import { PENDING_MARK } from "@/lib/doc-model";

/** Transactions that load a document: not additions, not undoable */
export const LOAD_META = "ssLoad";
export const docSyncKey = new PluginKey<{ glow: boolean }>("ssDocSync");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docSync: {
      /** Remove formatting marks, keeping additions additions */
      unsetFormattingMarks: () => ReturnType;
    };
  }
}

/** The mark on added text. It never comes from pasted HTML: the plugin adds it. */
export const SyncAdd = Mark.create({
  name: PENDING_MARK,
  inclusive: true,
  parseHTML: () => [],
  renderHTML: () => ["span", { class: "ss-add" }, 0],
});

const isLocked = (node: PMNode) => node.attrs.locked === true;

function lockedRanges(doc: PMNode): [number, number][] {
  const ranges: [number, number][] = [];
  doc.forEach((node, pos) => { if (isLocked(node)) ranges.push([pos, pos + node.nodeSize]); });
  return ranges;
}

/** True when a step of the transaction would change a locked paragraph */
function touchesLocked(tr: Transaction): boolean {
  for (let i = 0; i < tr.steps.length; i++) {
    const ranges = lockedRanges(tr.docs[i]);
    if (!ranges.length) continue;
    const hit = (from: number, to: number) => ranges.some(([a, b]) => (from === to ? from > a && from < b : from < b && to > a));
    const step = tr.steps[i];
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      if (hit(step.from, step.to)) return true;
      continue;
    }
    if (step instanceof AttrStep) {
      if (ranges.some(([a, b]) => step.pos >= a && step.pos < b)) return true;
      continue;
    }
    const s = step as unknown as { pos?: number };
    let bad = false;
    step.getMap().forEach((oldStart, oldEnd) => { if (hit(oldStart, oldEnd)) bad = true; });
    if (bad) return true;
    if (typeof s.pos === "number" && ranges.some(([a, b]) => s.pos! >= a && s.pos! < b)) return true;
  }
  return false;
}

/** Replace the editor's content with a loaded document (not an addition, not undoable) */
export function loadDocument(editor: Editor, json: EditorNode, glow: boolean) {
  const doc = editor.schema.nodeFromJSON(json);
  const { state, view } = editor;
  const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
  tr.setMeta(LOAD_META, true).setMeta("addToHistory", false).setMeta(docSyncKey, { glow });
  view.dispatch(tr);
}

export function setGlow(editor: Editor, glow: boolean) {
  if ((docSyncKey.getState(editor.state)?.glow ?? false) === glow) return;
  editor.view.dispatch(editor.state.tr.setMeta(docSyncKey, { glow }).setMeta("addToHistory", false));
}

/** List numbers as Docs shows them, drawn as decorations so they follow every edit */
function labelDecorations(doc: PMNode): DecorationSet {
  const paras: { pos: number; node: PMNode }[] = [];
  doc.forEach((node, pos) => paras.push({ pos, node }));
  const labels = listLabels(paras.map(({ node }) => node.attrs as { list?: string; listId?: string; level?: number }));
  const decos: Decoration[] = [];
  paras.forEach(({ pos, node }, i) => {
    const label = labels[i];
    if (label != null) decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-label": label }));
  });
  return DecorationSet.create(doc, decos);
}

const listLabelKey = new PluginKey<DecorationSet>("ssListLabels");

export const DocSync = Extension.create({
  name: "docSync",

  addCommands() {
    return {
      unsetFormattingMarks: () => ({ tr, state }) => {
        for (const range of state.selection.ranges) {
          for (const type of Object.values(state.schema.marks)) {
            if (type.name !== PENDING_MARK) tr.removeMark(range.$from.pos, range.$to.pos, type);
          }
        }
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const pendingType = (state: EditorState) => state.schema.marks[PENDING_MARK];
    return [
      new Plugin<DecorationSet>({
        key: listLabelKey,
        state: {
          init: (_config, state) => labelDecorations(state.doc),
          apply: (tr, value, _old, state) => (tr.docChanged ? labelDecorations(state.doc) : value),
        },
        props: { decorations: (state) => listLabelKey.getState(state) },
      }),
      new Plugin({
        key: docSyncKey,
        state: {
          init: () => ({ glow: false }),
          apply: (tr, value) => (tr.getMeta(docSyncKey) as { glow: boolean } | undefined) ?? value,
        },
        filterTransaction(tr) {
          if (!tr.docChanged || tr.getMeta(LOAD_META)) return true;
          return !touchesLocked(tr);
        },
        // Whatever is typed or pasted becomes an addition
        appendTransaction(transactions, _old, newState) {
          const type = pendingType(newState);
          if (!type) return null;
          const ranges: [number, number][] = [];
          transactions.forEach((tr, t) => {
            if (!tr.docChanged || tr.getMeta(LOAD_META) || tr.getMeta("history$") || tr.getMeta("ssAddMarked")) return;
            tr.steps.forEach((step, i) => {
              if (!(step instanceof ReplaceStep) || step.slice.size === 0) return;
              step.getMap().forEach((_os, _oe, newStart, newEnd) => {
                if (newEnd <= newStart) return;
                // Into the final document's coordinates
                let from = newStart;
                let to = newEnd;
                const rest = tr.mapping.slice(i + 1);
                from = rest.map(from, -1);
                to = rest.map(to, 1);
                for (let k = t + 1; k < transactions.length; k++) {
                  from = transactions[k].mapping.map(from, -1);
                  to = transactions[k].mapping.map(to, 1);
                }
                if (to > from) ranges.push([from, to]);
              });
            });
          });
          if (!ranges.length) return null;
          const tr = newState.tr;
          for (const [from, to] of ranges) tr.addMark(from, Math.min(to, tr.doc.content.size), type.create());
          if (!tr.docChanged) return null;
          return tr.setMeta("ssAddMarked", true);
        },
        props: {
          attributes: (state: EditorState): Record<string, string> => (docSyncKey.getState(state)?.glow ? { class: "ss-glow" } : {}),
        },
      }),
    ];
  },
});
