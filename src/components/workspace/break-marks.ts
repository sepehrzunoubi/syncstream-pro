/**
 * Manual breaks on the page. A break is a mark on the word it follows (so it moves with the text,
 * goes when the word is deleted and comes back with Undo), drawn as a thin underline with a small
 * pill above the word's end, like "33m". The pill is a zero-size widget: it never moves text, and
 * it is neither copied nor printed nor synced into the Google Doc.
 *
 * While placing, hovering a new (glowing) word shows where the break would go; a click puts it
 * there without moving the cursor. On the live page of a running sync the same pills show where
 * its breaks are, with their state (done, on now, ahead, being typed).
 */

import { Extension, Mark, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { afterWord, BREAK_MARK, PENDING_MARK } from "@/lib/doc-model";
import { richFromEditorJSON, type EditorNode } from "@/lib/rich-text";
import { formatBreak } from "@/lib/breaks";

/** A break on the live page of a running sync */
export interface LiveBreak {
  /** Document position the break follows */
  pos: number;
  /** Source offset of the break, as the job has it */
  at: number;
  minutes: number;
  state: "done" | "now" | "ahead" | "locked";
  label: string;
  title: string;
}

interface BreakUiState {
  /** Placing: the length (minutes) a click puts after a word */
  placing: number | null;
  /** Placing on the live page instead of marking words (the job's breaks change, not the text) */
  placeLive: boolean;
  hover: { from: number; to: number; reason: string | null } | null;
  /** The live page's breaks; null on the editable page */
  live: LiveBreak[] | null;
  /** A break to point out (its row in the list is hovered) */
  flash: { from: number; to: number } | null;
}

export const breakUiKey = new PluginKey<BreakUiState>("ssBreakUi");
const INITIAL: BreakUiState = { placing: null, placeLive: false, hover: null, live: null, flash: null };

/** Asks the page to edit a break: from a pill click */
export const BREAK_PILL_EVENT = "ss-break-pill";
/** A click while placing on the live page: the source offset is worked out by the page */
export const BREAK_PLACE_EVENT = "ss-break-place";
export interface BreakPillDetail { from: number; to: number; minutes: number; rect: DOMRect; live?: LiveBreak }

export const SyncBreak = Mark.create({
  name: BREAK_MARK,
  inclusive: false,
  addAttributes() {
    return { minutes: { default: 5, rendered: false } };
  },
  // Never from pasted HTML: a break is placed, not pasted
  parseHTML: () => [],
  renderHTML: () => ["span", { class: "ss-brk" }, 0],
});

export interface BreakRange { from: number; to: number; minutes: number }

/** The breaks on the page, in order: each marked word's range and length */
export function breakRanges(doc: PMNode): BreakRange[] {
  const out: BreakRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = node.marks.find((x) => x.type.name === BREAK_MARK);
    if (!m) return;
    const last = out[out.length - 1];
    if (last && last.to === pos && last.minutes === m.attrs.minutes) last.to = pos + node.nodeSize;
    else out.push({ from: pos, to: pos + node.nodeSize, minutes: Number(m.attrs.minutes) || 5 });
  });
  return out;
}

const WORD = /[\p{L}\p{N}\p{M}'’_\-.,;:!?)"\]»”]/u;

/** The word at `pos` (letters, digits and the punctuation stuck to them), or null off any word */
export function wordAt(doc: PMNode, pos: number): { from: number; to: number } | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const block = $pos.parent;
  if (!block.isTextblock) return null;
  const start = $pos.start();
  // The block's text, one character per position (anything else is a stop)
  let text = "";
  block.forEach((child) => { text += child.isText ? child.text! : "\u0000".repeat(child.nodeSize); });
  let i = $pos.parentOffset;
  if (!WORD.test(text[i] ?? "") && WORD.test(text[i - 1] ?? "")) i--;
  if (!WORD.test(text[i] ?? "")) return null;
  let a = i;
  let b = i + 1;
  while (a > 0 && WORD.test(text[a - 1])) a--;
  while (b < text.length && WORD.test(text[b])) b++;
  return { from: start + a, to: start + b };
}

/** Why a break can't go after this word, or null when it can */
export function breakRefusal(doc: PMNode, from: number, to: number): string | null {
  let pending = true;
  doc.nodesBetween(from, to, (node) => { if (node.isText && !node.marks.some((m) => m.type.name === PENDING_MARK)) pending = false; });
  if (!pending) return "Only new text can take a break";
  // Something new must be typed after it
  let after = false;
  doc.nodesBetween(to, doc.content.size, (node, pos) => {
    if (after) return false;
    if (node.isText && node.marks.some((m) => m.type.name === PENDING_MARK)) {
      const start = Math.max(pos, to);
      if (node.text!.slice(start - pos).trim()) after = true;
    }
    return !after;
  });
  return after ? null : "Nothing is typed after the last word";
}

/**
 * Where each break starts in the source of a sync that types the whole page (no document to type
 * into): the page's text cut after the break's word is exactly what is typed before it.
 */
export function sourceAnchors(doc: PMNode): { at: number; minutes: number }[] {
  const ranges = breakRanges(doc);
  if (!ranges.length) return [];
  const text = richFromEditorJSON(doc.toJSON() as EditorNode).text;
  const out = new Map<number, number>();
  for (const r of ranges) {
    const before = richFromEditorJSON(doc.cut(0, r.to).toJSON() as EditorNode).text.length;
    const at = afterWord(text, before - 1);
    if (before > 0 && at < text.length) out.set(at, r.minutes);
  }
  return Array.from(out, ([at, minutes]) => ({ at, minutes })).sort((a, b) => a.at - b.at);
}

/** Put a break of `minutes` after the word [from, to), or change its length */
export function setBreak(editor: Editor, from: number, to: number, minutes: number): void {
  const type = editor.schema.marks[BREAK_MARK];
  const tr = editor.state.tr.removeMark(from, to, type).addMark(from, to, type.create({ minutes }));
  editor.view.dispatch(tr);
}

export function removeBreak(editor: Editor, from: number, to: number): void {
  editor.view.dispatch(editor.state.tr.removeMark(from, to, editor.schema.marks[BREAK_MARK]));
}

/** Take every break off the page, as one step Undo brings back */
export function clearBreaks(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.removeMark(0, editor.state.doc.content.size, editor.schema.marks[BREAK_MARK]));
}

export function setBreakUi(view: EditorView, patch: Partial<BreakUiState>): void {
  view.dispatch(view.state.tr.setMeta(breakUiKey, patch).setMeta("addToHistory", false));
}

function pill(label: string, attrs: Record<string, string>): HTMLElement {
  const anchor = document.createElement("span");
  anchor.className = "ss-brk-anchor";
  anchor.contentEditable = "false";
  anchor.setAttribute("aria-hidden", "true");
  const el = document.createElement("span");
  el.className = "ss-brk-pill";
  el.textContent = label;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  anchor.appendChild(el);
  return anchor;
}

function decorations(state: EditorState): DecorationSet {
  const ui = breakUiKey.getState(state) ?? INITIAL;
  const decos: Decoration[] = [];
  if (ui.live) {
    for (const b of ui.live) {
      decos.push(Decoration.widget(b.pos, () => pill(b.label, { "data-state": b.state, "data-at": String(b.at), "data-minutes": String(b.minutes), title: b.title }), { side: -1, key: `live-${b.at}-${b.minutes}-${b.state}-${b.label}`, ignoreSelection: true }));
    }
  } else {
    for (const r of breakRanges(state.doc)) {
      decos.push(Decoration.widget(r.to, () => pill(formatBreak(r.minutes), { "data-from": String(r.from), "data-to": String(r.to), "data-minutes": String(r.minutes), title: `A ${formatBreak(r.minutes)} break starts after this word. Click to change it.` }), { side: -1, key: `brk-${r.from}-${r.to}-${r.minutes}`, ignoreSelection: true }));
    }
  }
  if (ui.flash) decos.push(Decoration.inline(ui.flash.from, ui.flash.to, { class: "ss-brk-flash" }));
  if (ui.placing != null && ui.hover) {
    const { from, to, reason } = ui.hover;
    decos.push(Decoration.inline(from, to, { class: reason ? "ss-brk-ghost ss-brk-ghost-no" : "ss-brk-ghost" }));
    if (!reason) decos.push(Decoration.widget(to, () => pill(formatBreak(ui.placing!), { "data-ghost": "true" }), { side: -1, key: `ghost-${to}-${ui.placing}`, ignoreSelection: true }));
  }
  return DecorationSet.create(state.doc, decos);
}

/** Where a pointer is, as a word and whether a break can go after it */
function hoverAt(view: EditorView, event: MouseEvent, live: boolean): BreakUiState["hover"] {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const word = wordAt(view.state.doc, hit.pos);
  if (!word) return null;
  const reason = live ? liveRefusal(view, word.to) : breakRefusal(view.state.doc, word.from, word.to);
  return { ...word, reason };
}

/** On the live page only text not typed yet (and not being typed) can take a new break */
function liveRefusal(view: EditorView, to: number): string | null {
  let untyped = false;
  view.dom.querySelectorAll(".ss-untyped").forEach((el) => {
    if (untyped) return;
    const pos = view.posAtDOM(el, 0);
    if (pos >= to - 1) untyped = true;
  });
  return untyped ? null : "That part is already typed";
}

export const BreakMarks = Extension.create({
  name: "breakMarks",
  addProseMirrorPlugins() {
    return [
      new Plugin<BreakUiState>({
        key: breakUiKey,
        state: {
          init: () => INITIAL,
          apply: (tr: Transaction, value) => {
            const patch = tr.getMeta(breakUiKey) as Partial<BreakUiState> | undefined;
            let next = patch ? { ...value, ...patch } : value;
            if (tr.docChanged && (next.hover || next.flash)) next = { ...next, hover: null, flash: null };
            return next;
          },
        },
        props: {
          decorations,
          handleDOMEvents: {
            mousedown: (view, event) => {
              const target = event.target as HTMLElement;
              const pillEl = target.closest?.(".ss-brk-pill") as HTMLElement | null;
              if (pillEl && !pillEl.dataset.ghost) {
                event.preventDefault();
                const ui = breakUiKey.getState(view.state)!;
                const live = ui.live?.find((b) => String(b.at) === pillEl.dataset.at);
                const detail: BreakPillDetail = { from: Number(pillEl.dataset.from ?? -1), to: Number(pillEl.dataset.to ?? -1), minutes: Number(pillEl.dataset.minutes), rect: pillEl.getBoundingClientRect(), live };
                window.dispatchEvent(new CustomEvent(BREAK_PILL_EVENT, { detail }));
                return true;
              }
              const ui = breakUiKey.getState(view.state)!;
              if (ui.placing == null || event.button !== 0) return false;
              const hover = hoverAt(view, event, ui.placeLive);
              if (!hover) return false;
              // Placing never moves the cursor or types anything
              event.preventDefault();
              if (hover.reason) return true;
              if (ui.placeLive) {
                window.dispatchEvent(new CustomEvent(BREAK_PLACE_EVENT, { detail: { from: hover.from, to: hover.to, minutes: ui.placing } }));
                return true;
              }
              const type = view.state.schema.marks[BREAK_MARK];
              view.dispatch(view.state.tr.removeMark(hover.from, hover.to, type).addMark(hover.from, hover.to, type.create({ minutes: ui.placing })));
              return true;
            },
            mousemove: (view, event) => {
              const ui = breakUiKey.getState(view.state)!;
              if (ui.placing == null) return false;
              const hover = hoverAt(view, event, ui.placeLive);
              const same = hover && ui.hover && hover.from === ui.hover.from && hover.to === ui.hover.to && hover.reason === ui.hover.reason;
              if (!same && (hover || ui.hover)) setBreakUi(view, { hover });
              view.dom.classList.toggle("ss-placing-no", !!hover?.reason);
              view.dom.title = hover?.reason ?? "";
              return false;
            },
            mouseleave: (view) => {
              const ui = breakUiKey.getState(view.state)!;
              if (ui.hover) setBreakUi(view, { hover: null });
              view.dom.classList.remove("ss-placing-no");
              view.dom.title = "";
              return false;
            },
          },
          attributes: (state): Record<string, string> => ((breakUiKey.getState(state) ?? INITIAL).placing != null ? { class: "ss-placing" } : {}),
        },
      }),
    ];
  },
});
