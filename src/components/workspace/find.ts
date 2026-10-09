/**
 * Find and replace, as in Docs: every match is highlighted, one is current,
 * and replacing is a direct edit of the document (never an addition).
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { DIRECT_META } from "./extensions";

export interface FindOptions {
  query: string;
  matchCase: boolean;
  regex: boolean;
  /** Treat "é" and "e" alike */
  ignoreDiacritics: boolean;
}

export interface FindState extends FindOptions {
  matches: { from: number; to: number }[];
  current: number;
  /** Whether the query is a bad regular expression */
  error: boolean;
}

export const findKey = new PluginKey<FindState>("ssFind");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    find: {
      setFind: (options: Partial<FindOptions> | null) => ReturnType;
      findNext: () => ReturnType;
      findPrevious: () => ReturnType;
      replaceCurrent: (text: string) => ReturnType;
      replaceAll: (text: string) => ReturnType;
    };
  }
}

const EMPTY: FindState = { query: "", matchCase: false, regex: false, ignoreDiacritics: false, matches: [], current: -1, error: false };

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The document's text with a position for every character, so matches map back */
function textOf(doc: PMNode): { text: string; pos: number[] } {
  let text = "";
  const pos: number[] = [];
  doc.descendants((node, p) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) { text += node.text[i]; pos.push(p + i); }
    } else if (node.isBlock && text.length && text[text.length - 1] !== "\n") {
      text += "\n";
      pos.push(p);
    }
    return true;
  });
  return { text, pos };
}

function search(doc: PMNode, o: FindOptions): { matches: FindState["matches"]; error: boolean } {
  if (!o.query) return { matches: [], error: false };
  const { text, pos } = textOf(doc);
  // Diacritics are stripped character for character, so positions line up
  const hay = o.ignoreDiacritics ? Array.from(text).map((c) => strip(c)[0] ?? c).join("") : text;
  const needle = o.ignoreDiacritics ? strip(o.query) : o.query;
  let re: RegExp;
  try {
    re = new RegExp(o.regex ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.matchCase ? "gu" : "giu");
  } catch {
    return { matches: [], error: true };
  }
  const matches: FindState["matches"] = [];
  for (let m = re.exec(hay); m; m = re.exec(hay)) {
    if (!m[0].length) { re.lastIndex++; if (re.lastIndex > hay.length) break; continue; }
    const from = pos[m.index];
    const to = pos[m.index + m[0].length - 1] + 1;
    // No match across paragraphs
    if (!text.slice(m.index, m.index + m[0].length).includes("\n")) matches.push({ from, to });
    if (matches.length >= 5000) break;
  }
  return { matches, error: false };
}

function decorate(doc: PMNode, st: FindState): DecorationSet {
  return DecorationSet.create(doc, st.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === st.current ? "ss-find-current" : "ss-find-match" })));
}

/** The match at or after the selection, so Next starts from where the user is */
function nearest(matches: FindState["matches"], state: EditorState): number {
  if (!matches.length) return -1;
  const at = state.selection.from;
  const i = matches.findIndex((m) => m.from >= at);
  return i < 0 ? 0 : i;
}

export const Find = Extension.create({
  name: "find",
  addCommands() {
    return {
      setFind: (options) => ({ tr, state, dispatch }) => {
        const prev = findKey.getState(state) ?? EMPTY;
        const next: FindOptions = options ? { ...prev, ...options } : { ...EMPTY };
        const { matches, error } = search(state.doc, next);
        const current = options ? (prev.query === next.query && prev.current >= 0 && prev.current < matches.length ? prev.current : nearest(matches, state)) : -1;
        if (dispatch) dispatch(tr.setMeta(findKey, { ...next, matches, current, error } satisfies FindState).setMeta("addToHistory", false));
        return true;
      },
      findNext: () => ({ tr, state, dispatch }) => {
        const st = findKey.getState(state);
        if (!st?.matches.length) return false;
        const current = (st.current + 1) % st.matches.length;
        const m = st.matches[current];
        tr.setMeta(findKey, { ...st, current }).setMeta("addToHistory", false).setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
        if (dispatch) dispatch(tr);
        return true;
      },
      findPrevious: () => ({ tr, state, dispatch }) => {
        const st = findKey.getState(state);
        if (!st?.matches.length) return false;
        const current = (st.current - 1 + st.matches.length) % st.matches.length;
        const m = st.matches[current];
        tr.setMeta(findKey, { ...st, current }).setMeta("addToHistory", false).setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
        if (dispatch) dispatch(tr);
        return true;
      },
      replaceCurrent: (text) => ({ tr, state, dispatch }) => {
        const st = findKey.getState(state);
        if (!st?.matches.length || st.current < 0) return false;
        const m = st.matches[st.current];
        const marks = state.doc.resolve(m.from).marks();
        if (text) tr.replaceWith(m.from, m.to, state.schema.text(text, marks));
        else tr.delete(m.from, m.to);
        tr.setMeta(DIRECT_META, true);
        if (dispatch) dispatch(tr);
        return true;
      },
      replaceAll: (text) => ({ tr, state, dispatch }) => {
        const st = findKey.getState(state);
        if (!st?.matches.length) return false;
        for (const m of [...st.matches].reverse()) {
          const marks = state.doc.resolve(m.from).marks();
          if (text) tr.replaceWith(m.from, m.to, state.schema.text(text, marks));
          else tr.delete(m.from, m.to);
        }
        tr.setMeta(DIRECT_META, true);
        if (dispatch) dispatch(tr);
        return true;
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-f": () => { window.dispatchEvent(new CustomEvent("ss-find", { detail: "bar" })); return true; },
      "Mod-h": () => { window.dispatchEvent(new CustomEvent("ss-find", { detail: "dialog" })); return true; },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState & { deco: DecorationSet }>({
        key: findKey as unknown as PluginKey<FindState & { deco: DecorationSet }>,
        state: {
          init: (_c, state) => ({ ...EMPTY, deco: DecorationSet.create(state.doc, []) }),
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(findKey) as FindState | undefined;
            if (meta) return { ...meta, deco: decorate(tr.doc, meta) };
            if (!tr.docChanged || !value.query) return value;
            // The document changed under the search: find again, keeping the current match where it was
            const { matches, error } = search(state.doc, value);
            const current = matches.length ? Math.min(Math.max(0, value.current), matches.length - 1) : -1;
            const next = { ...value, matches, current, error };
            return { ...next, deco: decorate(tr.doc, next) };
          },
        },
        props: { decorations: (state) => (findKey.getState(state) as (FindState & { deco: DecorationSet }) | undefined)?.deco },
      }),
    ];
  },
});
