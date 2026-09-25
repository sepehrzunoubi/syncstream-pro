/**
 * Syncing into a document that already has text.
 *
 * The document's own paragraphs are loaded as locked paragraphs: they show
 * exactly where the new text will go but cannot be changed from here. The
 * paragraphs that are not locked form the sync region, the text that will be
 * typed. It is highlighted, and clicking the document moves it.
 */

import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { AddMarkStep, AttrStep, RemoveMarkStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { EditorNode } from "@/lib/rich-text";
import type { Anchor, LockedAnchors } from "@/lib/doc-import";

/** Transactions carrying this meta may change locked paragraphs (loading a document) */
export const ALLOW_LOCKED = "ssAllowLocked";
export const syncRegionKey = new PluginKey<{ placing: boolean }>("ssSyncRegion");

/** Placing mode: hovering the document shows where the text can go, and a click moves it there */
export function isPlacing(state: EditorState): boolean {
  return syncRegionKey.getState(state)?.placing ?? false;
}

export function setPlacing(editor: Editor, placing: boolean) {
  if (isPlacing(editor.state) === placing) return;
  editor.view.dispatch(editor.state.tr.setMeta(syncRegionKey, { placing }).setMeta("addToHistory", false));
}
const PLACEHOLDER = "Type or paste the text to sync here";

const isLocked = (node: PMNode) => node.attrs.locked === true;

function lockedRanges(doc: PMNode): [number, number][] {
  const ranges: [number, number][] = [];
  doc.forEach((node, pos) => { if (isLocked(node)) ranges.push([pos, pos + node.nodeSize]); });
  return ranges;
}

/** Top-level positions of the sync region's paragraphs */
function regionOf(doc: PMNode): { pos: number; node: PMNode; index: number }[] {
  const out: { pos: number; node: PMNode; index: number }[] = [];
  doc.forEach((node, pos, index) => { if (!isLocked(node)) out.push({ pos, node, index }); });
  return out;
}

export function hasLocked(doc: PMNode): boolean {
  let found = false;
  doc.forEach((node) => { if (isLocked(node)) found = true; });
  return found;
}

/** True when a step of the transaction would change a locked paragraph */
function touchesLocked(tr: Transaction): boolean {
  for (let i = 0; i < tr.steps.length; i++) {
    const ranges = lockedRanges(tr.docs[i]);
    if (!ranges.length) continue;
    // Inserting at a paragraph boundary is fine; anything inside a locked one is not
    const hit = (from: number, to: number) =>
      ranges.some(([a, b]) => (from === to ? from > a && from < b : from < b && to > a));
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
    // Node mark steps and other position-only steps
    if (typeof s.pos === "number" && ranges.some(([a, b]) => s.pos! >= a && s.pos! < b)) return true;
  }
  return false;
}

/** The anchor the region is at: after the locked paragraph above it, else before the one below */
export function regionAnchor(doc: PMNode): Anchor | null {
  const region = regionOf(doc);
  if (!region.length || !hasLocked(doc)) return null;
  const first = region[0].index;
  const last = region[region.length - 1].index;
  const above = first > 0 ? doc.child(first - 1) : null;
  const below = last + 1 < doc.childCount ? doc.child(last + 1) : null;
  const a = (above?.attrs.anchors as LockedAnchors | null)?.after;
  if (a) return a;
  return (below?.attrs.anchors as LockedAnchors | null)?.before ?? null;
}

/** The region as a document of its own (what gets typed), and the locked paragraphs around it */
export function splitRegion(json: EditorNode): { region: EditorNode; before: EditorNode[]; after: EditorNode[] } {
  const before: EditorNode[] = [];
  const after: EditorNode[] = [];
  const region: EditorNode[] = [];
  for (const node of json.content ?? []) {
    if (node.attrs?.locked) (region.length ? after : before).push(node);
    else region.push(node);
  }
  return { region: { type: "doc", content: region.length ? region : [{ type: "paragraph" }] }, before, after };
}

const sameAnchor = (a: Anchor | null | undefined, b: Anchor | null | undefined) => !!a && !!b && a.mode === b.mode && a.at === b.at;

/** Where the region sits, remembered in a way that survives reloading the document */
export interface RegionPlace {
  anchor: Anchor | null;
  revisionId?: string;
  /** Text of the locked paragraphs directly above and below it */
  above: string | null;
  below: string | null;
}

const nodeText = (n: EditorNode): string => (n.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : c.content ? nodeText(c) : " ")).join("");

export function regionPlace(json: EditorNode, anchor: Anchor | null, revisionId?: string): RegionPlace | null {
  const { before, after } = splitRegion(json);
  if (!before.length && !after.length) return null;
  return { anchor, revisionId, above: before.length ? nodeText(before[before.length - 1]) : null, below: after.length ? nodeText(after[0]) : null };
}

/** Index in `locked` to put the region at, for a remembered place */
function placeIndex(locked: EditorNode[], place: RegionPlace | null | undefined, revisionId: string | undefined): number {
  if (place) {
    if (place.anchor && place.revisionId && place.revisionId === revisionId) {
      const i = locked.findIndex((n) => sameAnchor((n.attrs?.anchors as LockedAnchors | null)?.after, place.anchor));
      if (i >= 0) return i + 1;
      const j = locked.findIndex((n) => sameAnchor((n.attrs?.anchors as LockedAnchors | null)?.before, place.anchor));
      if (j >= 0) return j;
    }
    // The document changed: find the same neighbours by their text
    if (place.above != null && place.above.trim()) {
      const i = locked.findIndex((n, k) => nodeText(n) === place.above && (place.below == null || k + 1 >= locked.length || nodeText(locked[k + 1]) === place.below));
      const loose = i >= 0 ? i : locked.findIndex((n) => nodeText(n) === place.above);
      if (loose >= 0) return loose + 1;
    }
    if (place.below != null && place.below.trim()) {
      const j = locked.findIndex((n) => nodeText(n) === place.below);
      if (j >= 0) return j;
    }
  }
  // By default, after the last paragraph that has something in it
  let at = locked.length;
  while (at > 0 && !(locked[at - 1].content ?? []).length) at--;
  return at === 0 ? locked.length : at;
}

/**
 * Replace the editor's content with locked paragraphs and the region, placed
 * at `place` (an index into `locked`, or a remembered place). Not undoable:
 * it is a load, not an edit.
 */
export function composeDocument(editor: Editor, locked: EditorNode[], region: EditorNode[], place?: RegionPlace | number | null, revisionId?: string) {
  const regionNodes = region.length ? region : [{ type: "paragraph" }];
  const at = typeof place === "number" ? Math.max(0, Math.min(locked.length, place)) : placeIndex(locked, place, revisionId);
  const content = [...locked.slice(0, at), ...regionNodes, ...locked.slice(at)];
  const doc = editor.schema.nodeFromJSON({ type: "doc", content });
  const { state, view } = editor;
  const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
  tr.setMeta(ALLOW_LOCKED, true).setMeta("addToHistory", false);
  if (editor.isEditable) tr.setMeta(syncRegionKey, { placing: locked.length > 0 && typeof place !== "number" && region.every((n) => !(n.content ?? []).length) });
  const region0 = regionOf(tr.doc);
  if (region0.length && editor.isEditable) {
    const last = region0[region0.length - 1];
    tr.setSelection(TextSelection.near(tr.doc.resolve(last.pos + last.node.nodeSize - 1), -1));
  }
  view.dispatch(tr);
}

/** Replace just the region's content, keeping it where it is */
export function setRegion(editor: Editor, region: EditorNode[]) {
  const json = editor.getJSON() as EditorNode;
  const { before, after } = splitRegion(json);
  composeDocument(editor, [...before, ...after], region, before.length);
}

/** Put the caret at the end of the sync region */
export function focusRegionEnd(editor: Editor) {
  const region = regionOf(editor.state.doc);
  if (!region.length) return;
  const last = region[region.length - 1];
  const tr = editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(last.pos + last.node.nodeSize - 1), -1));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

/** Move the region next to the locked paragraph at `targetPos` */
function moveRegion(view: EditorView, targetPos: number, side: "before" | "after") {
  const { state } = view;
  const region = regionOf(state.doc);
  const target = state.doc.nodeAt(targetPos);
  if (!target) return;
  const nodes = region.length ? region.map((r) => r.node) : [state.schema.nodes.paragraph.create()];
  const tr = state.tr;
  for (let k = region.length - 1; k >= 0; k--) tr.delete(region[k].pos, region[k].pos + region[k].node.nodeSize);
  const insertAt = tr.mapping.map(side === "before" ? targetPos : targetPos + target.nodeSize, side === "before" ? -1 : 1);
  tr.insert(insertAt, Fragment.from(nodes));
  const size = nodes.reduce((n, node) => n + node.nodeSize, 0);
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + size - 1), -1));
  tr.setMeta(ALLOW_LOCKED, true).setMeta(syncRegionKey, { placing: false });
  view.dispatch(tr);
  view.focus();
}

/** Which side of a locked paragraph a pointer is on, and whether the region can go there */
function placement(view: EditorView, p: HTMLElement, clientY: number) {
  const pos = view.posAtDOM(p, 0) - 1;
  const node = pos >= 0 ? view.state.doc.nodeAt(pos) : null;
  if (!node || !isLocked(node)) return null;
  const rect = p.getBoundingClientRect();
  const side: "before" | "after" = clientY < rect.top + rect.height / 2 ? "before" : "after";
  const anchors = node.attrs.anchors as LockedAnchors | null;
  if (!anchors?.[side]) return null;
  // Already there?
  const $pos = view.state.doc.resolve(pos);
  const index = $pos.index();
  const neighbour = side === "before" ? (index > 0 ? view.state.doc.child(index - 1) : null) : index + 1 < view.state.doc.childCount ? view.state.doc.child(index + 1) : null;
  const here = !!neighbour && !isLocked(neighbour);
  return { pos, side, rect, here };
}

function regionIsEmpty(doc: PMNode): boolean {
  const region = regionOf(doc);
  return region.every((r) => r.node.content.size === 0);
}

export const SyncRegion = Extension.create({
  name: "syncRegion",
  priority: 1100,

  addKeyboardShortcuts() {
    return {
      // Select all selects the text to sync, not the document around it
      "Mod-a": ({ editor }) => {
        const { doc } = editor.state;
        if (!hasLocked(doc)) return false;
        const region = regionOf(doc);
        if (!region.length) return false;
        const first = region[0];
        const last = region[region.length - 1];
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, first.pos + 1, last.pos + last.node.nodeSize - 1)));
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: syncRegionKey,
        state: {
          init: () => ({ placing: false }),
          apply: (tr, value) => {
            const meta = tr.getMeta(syncRegionKey) as { placing: boolean } | undefined;
            if (meta) return meta;
            // Typing into the text accepts where it is
            if (value.placing && tr.docChanged && !tr.getMeta(ALLOW_LOCKED)) return { placing: false };
            // Nothing to place when there is no document around the text
            return value.placing && !hasLocked(tr.doc) ? { placing: false } : value;
          },
        },
        filterTransaction(tr) {
          if (!tr.docChanged || tr.getMeta(ALLOW_LOCKED)) return true;
          if (touchesLocked(tr)) return false;
          // Keep at least one paragraph to type into
          if (hasLocked(tr.doc) && !regionOf(tr.doc).length) return false;
          return true;
        },
        props: {
          attributes: (state: EditorState): Record<string, string> =>
            hasLocked(state.doc) ? { class: isPlacing(state) ? "ss-has-locked ss-placing" : "ss-has-locked" } : {},
          decorations(state) {
            if (!hasLocked(state.doc)) return DecorationSet.empty;
            const region = regionOf(state.doc);
            if (region.length !== 1 || region[0].node.content.size > 0) return DecorationSet.empty;
            const { pos, node } = region[0];
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: "ss-region-empty", "data-placeholder": PLACEHOLDER })]);
          },
          handleDOMEvents: {
            mousedown(view, event) {
              if (!view.editable || event.button !== 0 || !isPlacing(view.state)) return false;
              const p = (event.target as HTMLElement).closest?.("p[data-locked]") as HTMLElement | null;
              if (!p || !view.dom.contains(p)) return false;
              event.preventDefault();
              const place = placement(view, p, event.clientY);
              if (place && !place.here) moveRegion(view, place.pos, place.side);
              else focusView(view);
              return true;
            },
          },
        },
        view(editorView) {
          const line = document.createElement("div");
          line.className = "ss-insert-line";
          line.setAttribute("aria-hidden", "true");
          const pill = document.createElement("span");
          pill.className = "ss-insert-pill";
          line.appendChild(pill);
          // The editor's element is moved into the page when it mounts, so attach lazily
          const hostEl = () => {
            const host = editorView.dom.parentElement;
            if (host && line.parentElement !== host) {
              if (getComputedStyle(host).position === "static") host.style.position = "relative";
              host.appendChild(line);
            }
            return host;
          };
          const hide = () => line.removeAttribute("data-show");
          const onMove = (event: MouseEvent) => {
            const host = hostEl();
            if (!editorView.editable || !host || !isPlacing(editorView.state)) return hide();
            const p = (event.target as HTMLElement).closest?.("p[data-locked]") as HTMLElement | null;
            if (!p) return hide();
            const place = placement(editorView, p, event.clientY);
            if (!place || place.here) return hide();
            const hostRect = host.getBoundingClientRect();
            const scale = host.offsetWidth ? hostRect.width / host.offsetWidth : 1;
            const y = ((place.side === "before" ? place.rect.top : place.rect.bottom) - hostRect.top) / scale;
            line.style.top = `${Math.round(y - 1)}px`;
            // Span the text column, whatever the paragraph's own indent
            const dom = editorView.dom as HTMLElement;
            const cs = getComputedStyle(dom);
            const domRect = dom.getBoundingClientRect();
            const left = (domRect.left - hostRect.left) / scale + (parseFloat(cs.paddingLeft) || 0);
            const width = domRect.width / scale - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
            line.style.left = `${Math.round(left)}px`;
            line.style.width = `${Math.round(width)}px`;
            pill.textContent = regionIsEmpty(editorView.state.doc) ? "Sync here" : "Move here";
            line.setAttribute("data-show", "");
          };
          editorView.dom.addEventListener("mousemove", onMove);
          editorView.dom.addEventListener("mouseleave", hide);
          return {
            update: hide,
            destroy() {
              editorView.dom.removeEventListener("mousemove", onMove);
              editorView.dom.removeEventListener("mouseleave", hide);
              line.remove();
            },
          };
        },
      }),
    ];
  },
});

function focusView(view: EditorView) {
  if (!view.hasFocus()) view.focus();
}
