import { Extension, InputRule, Mark, type Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { DOMSerializer, type DOMOutputSpec, type Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { Pagination } from "./pagination";
import { DocSync, SyncAdd } from "./doc-sync";
import TextAlign from "@tiptap/extension-text-align";
import {
  cssColorToHex,
  cssFontToFamily,
  cssLengthToPt,
  fontStack,
  FONT_SIZES,
  INDENT_PT,
  LINE_SPACINGS,
  MAX_INDENT,
  NAMED_STYLES,
  roundSize,
  type Border,
  type Borders,
  type KeepOptions,
  type ListType,
  type NamedStyle,
} from "@/lib/rich-text";

/** Transactions that change text as a direct edit (find and replace, capitalisation): not additions */
export const DIRECT_META = "ssDirect";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docFormat: {
      setFont: (family: string) => ReturnType;
      setSize: (pt: number) => ReturnType;
      setNamedStyle: (style: NamedStyle) => ReturnType;
      indent: () => ReturnType;
      outdent: () => ReturnType;
      setFirstLine: (on: boolean) => ReturnType;
      setLineSpacing: (spacing: number) => ReturnType;
      /** Space above and below the paragraph, in points */
      setParagraphSpace: (space: { above?: number; below?: number }) => ReturnType;
      setKeep: (keep: Partial<KeepOptions>) => ReturnType;
      setBorders: (borders: Borders | null, shading: string | null) => ReturnType;
      /** Change the case of the selected text (a direct edit, not an addition) */
      setCapitalization: (mode: "lower" | "upper" | "title") => ReturnType;
      stepFontSize: (dir: 1 | -1) => ReturnType;
      clearFormatting: () => ReturnType;
      toggleList: (type: ListType) => ReturnType;
    };
  }
}

const TAG_STYLE: Record<string, NamedStyle> = { H1: "h1", H2: "h2", H3: "h3", H4: "h4", H5: "h5", H6: "h6" };

/** Docs' line height: the spacing times the font's natural line height (measured per font, see lineMetrics) */
const lineHeightCss = (spacing: number) => `--ss-spacing: ${Math.round((spacing / 100) * 1000) / 1000}; line-height: calc(var(--ss-spacing) * var(--ss-nlh, 1.15))`;

/** Borders and shading of a pasted paragraph, from its CSS */
function pastedBorders(el: HTMLElement): Borders | null {
  const out: Borders = {};
  const s = el.style;
  const sides: [keyof Borders, string, string][] = [["top", s.borderTopWidth, s.borderTopStyle], ["bottom", s.borderBottomWidth, s.borderBottomStyle], ["left", s.borderLeftWidth, s.borderLeftStyle], ["right", s.borderRightWidth, s.borderRightStyle]];
  for (const [side, w, style] of sides) {
    const width = cssLengthToPt(w) ?? 0;
    if (width <= 0 || style === "none" || style === "hidden") continue;
    const color = cssColorToHex(side === "top" ? s.borderTopColor : side === "bottom" ? s.borderBottomColor : side === "left" ? s.borderLeftColor : s.borderRightColor) ?? "#000000";
    const pad = cssLengthToPt(side === "top" ? s.paddingTop : side === "bottom" ? s.paddingBottom : side === "left" ? s.paddingLeft : s.paddingRight) ?? 0;
    out[side] = { width: Math.round(width * 100) / 100, color, dash: style === "dotted" ? "DOT" : style === "dashed" ? "DASH" : "SOLID", padding: Math.round(pad * 100) / 100 };
  }
  return Object.keys(out).length ? out : null;
}

const DASH_CSS: Record<Border["dash"], string> = { SOLID: "solid", DOT: "dotted", DASH: "dashed" };
function bordersCss(b: Borders): string[] {
  const css: string[] = [];
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const x = b[side];
    if (!x) continue;
    css.push(`border-${side}: ${x.width}pt ${DASH_CSS[x.dash]} ${x.color}`, `padding-${side}: ${x.padding}pt`);
  }
  if (b.between) css.push(`--ss-between: ${b.between.width}pt ${DASH_CSS[b.between.dash]} ${b.between.color}`, `--ss-between-pad: ${b.between.padding}pt`);
  return css;
}

/**
 * The exact indents and spacing of a pasted paragraph, in points, as Google
 * Docs and other editors put them in the clipboard. Paragraphs SyncStream
 * rendered itself with indent steps say so with data attributes and keep
 * those instead.
 */
function pastedBox(el: HTMLElement): { start: number; first: number; above: number | null; below: number | null } | null {
  if (el.hasAttribute("data-indent") || el.hasAttribute("data-first-line") || el.hasAttribute("data-list")) return null;
  const s = el.style;
  if (!s.marginLeft && !s.paddingLeft && !s.textIndent && !s.marginTop && !s.marginBottom) return null;
  const pt = (v: string) => { const n = cssLengthToPt(v); return n == null ? null : Math.max(-1000, Math.min(1000, Math.round(n * 2) / 2)); };
  const start = pt(s.marginLeft) ?? pt(s.paddingLeft) ?? 0;
  const first = pt(s.textIndent) ?? 0;
  return { start: Math.max(0, start), first, above: pt(s.marginTop), below: pt(s.marginBottom) };
}

/** Paragraphs carry the Google Docs paragraph properties we support. */
const DocParagraph = Paragraph.extend({
  parseHTML() {
    return [{ tag: "p" }, ...["h1", "h2", "h3", "h4", "h5", "h6"].map((tag) => ({ tag }))];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      styleName: {
        default: "normal",
        parseHTML: (el: HTMLElement) => {
          const data = el.getAttribute("data-style");
          if (data && data in NAMED_STYLES) return data;
          // Google Docs copies its Title and Subtitle styles as classes
          if (el.classList.contains("title")) return "title";
          if (el.classList.contains("subtitle")) return "subtitle";
          return TAG_STYLE[el.tagName] ?? "normal";
        },
        renderHTML: (a: { styleName?: string }) => (a.styleName && a.styleName !== "normal" ? { "data-style": a.styleName } : {}),
      },
      indent: {
        default: 0,
        parseHTML: (el: HTMLElement) => {
          const data = el.getAttribute("data-indent");
          if (data) return Math.min(MAX_INDENT, Math.max(0, parseInt(data, 10) || 0));
          // Pasted indents are kept exactly, in `box`
          return 0;
        },
        renderHTML: (a: { indent?: number }) =>
          a.indent ? { "data-indent": String(a.indent), style: `margin-left: ${(a.indent * INDENT_PT) / 72}in` } : {},
      },
      firstLine: {
        default: false,
        parseHTML: (el: HTMLElement) => el.hasAttribute("data-first-line"),
        renderHTML: (a: { firstLine?: boolean }) => (a.firstLine ? { "data-first-line": "", style: `text-indent: ${INDENT_PT / 72}in` } : {}),
      },
      list: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute("data-list");
          return v === "bullet" || v === "ordered" || v === "check" ? v : null;
        },
        renderHTML: (a: { list?: string | null }) => (a.list ? { "data-list": a.list } : {}),
      },
      // Part of the Google Doc the editor can't change (a table, a smart chip): shown, not editable
      locked: {
        default: false,
        keepOnSplit: false,
        parseHTML: () => false,
        renderHTML: (a: { locked?: boolean }) => (a.locked ? { "data-locked": "" } : {}),
      },
      /** Docs indices a locked paragraph covers, and its identity (not rendered) */
      span: { default: null, keepOnSplit: false, parseHTML: () => null, rendered: false },
      bid: { default: null, keepOnSplit: false, parseHTML: () => null, rendered: false },
      /** "section" for a section break */
      kind: {
        default: null,
        keepOnSplit: false,
        parseHTML: () => null,
        renderHTML: (a: { kind?: string | null }) => (a.kind ? { "data-kind": a.kind } : {}),
      },
      /** Which Docs list a paragraph belongs to, its level, and what Docs draws for it (labels are decorations) */
      listId: { default: null, parseHTML: () => null, rendered: false },
      level: { default: null, parseHTML: () => null, rendered: false },
      glyph: { default: null, parseHTML: () => null, rendered: false },
      /** Exact indents and spacing of a paragraph read from Docs, in points */
      box: {
        default: null,
        parseHTML: (el: HTMLElement) => pastedBox(el),
        renderHTML: (a: { box?: { start?: number; first?: number; marker?: number; above?: number | null; below?: number | null } | null; list?: string | null }) => {
          const b = a.box;
          if (!b) return {};
          const css: string[] = [];
          if (a.list) {
            css.push(`--ss-li-start: ${b.start ?? 36}pt`, `--ss-li-marker: ${b.marker ?? -18}pt`);
            return { style: css.concat(b.above != null ? [`margin-top: ${b.above}pt`] : [], b.below != null ? [`margin-bottom: ${b.below}pt`] : []).join("; "), "data-box": "" };
          } else {
            if (b.start) css.push(`margin-left: ${b.start}pt`);
            if (b.first) css.push(`text-indent: ${b.first}pt`);
          }
          if (b.above != null) css.push(`margin-top: ${b.above}pt`);
          if (b.below != null) css.push(`margin-bottom: ${b.below}pt`);
          return css.length ? { style: css.join("; ") } : {};
        },
      },
      lineSpacing: {
        default: 115,
        parseHTML: (el: HTMLElement) => {
          const data = el.getAttribute("data-spacing");
          if (data) return parseInt(data, 10) || 115;
          // Docs and browsers copy line spacing as 1.2 × the spacing
          const lh = parseFloat(el.style.lineHeight);
          if (!Number.isFinite(lh) || /px|pt|%/.test(el.style.lineHeight)) return 115;
          const pct = (lh / 1.2) * 100;
          const near = LINE_SPACINGS.find((s) => Math.abs(s.value - pct) <= 6);
          return near ? near.value : Math.max(50, Math.min(500, Math.round(pct)));
        },
        renderHTML: (a: { lineSpacing?: number }) => {
          const v = a.lineSpacing ?? 115;
          return { "data-spacing": String(v), style: lineHeightCss(v) };
        },
      },
      /** Keep with next, keep lines together, prevent single lines */
      keep: {
        default: null,
        parseHTML: () => null,
        renderHTML: (a: { keep?: KeepOptions | null }) => {
          const k = a.keep;
          if (!k) return {};
          const flags = [k.withNext ? "next" : "", k.linesTogether ? "lines" : "", k.singleLines === false ? "single" : ""].filter(Boolean);
          return flags.length ? { "data-keep": flags.join(" ") } : {};
        },
      },
      borders: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.hasAttribute("data-spacing") ? null : pastedBorders(el)),
        renderHTML: (a: { borders?: Borders | null }) => (a.borders ? { style: bordersCss(a.borders).join("; "), ...(a.borders.between ? { "data-between": "" } : {}) } : {}),
      },
      shading: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.hasAttribute("data-spacing") ? null : cssColorToHex(el.style.backgroundColor) ?? null),
        renderHTML: (a: { shading?: string | null }) => (a.shading ? { style: `background-color: ${a.shading}` } : {}),
      },
    };
  },
});

/** Font family and size (in points) on the textStyle mark. */
const FontAttributes = Extension.create({
  name: "fontAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (el: HTMLElement) => cssFontToFamily(el.style.fontFamily) ?? null,
            renderHTML: (a: { fontFamily?: string | null }) => (a.fontFamily ? { style: `font-family: ${fontStack(a.fontFamily)}`, "data-font": a.fontFamily } : {}),
          },
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const pt = cssLengthToPt(el.style.fontSize);
              return pt ? roundSize(pt) : null;
            },
            renderHTML: (a: { fontSize?: number | null }) => (a.fontSize ? { style: `font-size: ${a.fontSize}pt` } : {}),
          },
        },
      },
    ];
  },
});

function paragraphsInSelection(editor: { state: Editor["state"] }, from: number, to: number) {
  const found: { pos: number; attrs: Record<string, unknown> }[] = [];
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "paragraph") found.push({ pos, attrs: node.attrs });
  });
  return found;
}

/** Leaving a list, or starting a new one: Docs makes a new list, with default indents */
const NO_LIST = { list: null, listId: null, level: null, glyph: null, box: null };

/** Indent steps of a paragraph, counting exact indents read from Docs */
function stepsOf(a: Record<string, unknown>): number {
  const box = a.box as { start?: number } | null;
  if (box && typeof box.start === "number") return Math.max(0, Math.min(MAX_INDENT, Math.round(box.start / INDENT_PT)));
  return typeof a.indent === "number" ? a.indent : 0;
}

const DocFormat = Extension.create({
  name: "docFormat",
  addCommands() {
    const updateParagraphs =
      (fn: (attrs: Record<string, unknown>) => Record<string, unknown>) =>
      ({ tr, state, dispatch }: { tr: Editor["state"]["tr"]; state: Editor["state"]; dispatch?: unknown }) => {
        const { from, to } = state.selection;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === "paragraph") tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...fn(node.attrs) });
        });
        if (dispatch) (dispatch as (t: typeof tr) => void)(tr);
        return true;
      };
    return {
      setFont: (family) => ({ chain }) => chain().setMark("textStyle", { fontFamily: family }).run(),
      setSize: (pt) => ({ chain }) => chain().setMark("textStyle", { fontSize: roundSize(pt) }).run(),
      setNamedStyle: (style) => ({ chain, state }) => {
        // Like Docs: switching style drops explicit sizes so the style's size shows.
        const { $from, $to } = state.selection;
        return chain()
          .command(({ tr }) => {
            const start = $from.start();
            const end = $to.end();
            const markType = state.schema.marks.textStyle;
            state.doc.nodesBetween(start, end, (node, pos) => {
              if (!node.isText) return;
              const mark = node.marks.find((m) => m.type === markType);
              if (mark && mark.attrs.fontSize) {
                const from = Math.max(pos, start);
                const to = Math.min(pos + node.nodeSize, end);
                tr.removeMark(from, to, markType);
                const rest = { ...mark.attrs, fontSize: null };
                if (Object.values(rest).some((v) => v != null)) tr.addMark(from, to, markType.create(rest));
              }
            });
            return true;
          })
          .updateAttributes("paragraph", { styleName: style })
          .run();
      },
      indent: () => updateParagraphs((a) => (a.list ? {} : { indent: Math.min(MAX_INDENT, stepsOf(a) + 1), box: null })),
      outdent: () => updateParagraphs((a) => (a.list ? {} : { indent: Math.max(0, stepsOf(a) - 1), box: null })),
      setFirstLine: (on) => updateParagraphs((a) => (a.list ? {} : { indent: stepsOf(a), firstLine: on, box: null })),
      toggleList: (type) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection;
        const paras: { pos: number; attrs: Record<string, unknown> }[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === "paragraph") paras.push({ pos, attrs: node.attrs });
        });
        const allOn = paras.length > 0 && paras.every((p) => p.attrs.list === type);
        for (const p of paras) {
          tr.setNodeMarkup(p.pos, undefined, allOn ? { ...p.attrs, ...NO_LIST } : { ...p.attrs, ...NO_LIST, list: type, indent: 0, firstLine: false });
        }
        if (dispatch) dispatch(tr);
        return true;
      },
      setLineSpacing: (spacing) => updateParagraphs(() => ({ lineSpacing: spacing })),
      setParagraphSpace: (space) => updateParagraphs((a) => {
        // Exact spacing lives in the box; keep the paragraph's indents as they are
        const box = (a.box as { start?: number; first?: number; marker?: number; above?: number | null; below?: number | null } | null) ?? (a.list
          ? { start: 36, marker: -18 }
          : { start: stepsOf(a) * INDENT_PT, first: a.firstLine ? INDENT_PT : 0 });
        return { box: { ...box, above: space.above ?? box.above ?? null, below: space.below ?? box.below ?? null }, ...(a.list ? {} : { indent: 0, firstLine: false }) };
      }),
      setKeep: (keep) => updateParagraphs((a) => {
        const next = { ...((a.keep as KeepOptions | null) ?? {}), ...keep };
        // Docs' defaults need no record
        if (next.withNext === false) delete next.withNext;
        if (next.linesTogether === false) delete next.linesTogether;
        if (next.singleLines === true) delete next.singleLines;
        return { keep: Object.keys(next).length ? next : null };
      }),
      setBorders: (borders, shading) => updateParagraphs(() => ({ borders, shading })),
      setCapitalization: (mode) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection;
        if (from === to) return false;
        const convert = (s: string) => {
          if (mode === "lower") return s.toLowerCase();
          if (mode === "upper") return s.toUpperCase();
          return s.toLowerCase().replace(new RegExp("(^|[^\\p{L}\\p{N}'’])(\\p{L})", "gu"), (_m, before: string, ch: string) => before + ch.toUpperCase());
        };
        const edits: { from: number; to: number; text: string; marks: readonly import("@tiptap/pm/model").Mark[] }[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isText || !node.text) return;
          const s = Math.max(from, pos);
          const e = Math.min(to, pos + node.nodeSize);
          const text = node.text.slice(s - pos, e - pos);
          const next = convert(text);
          if (next !== text) edits.push({ from: s, to: e, text: next, marks: node.marks });
        });
        if (!edits.length) return false;
        for (const ed of edits.reverse()) tr.replaceWith(ed.from, ed.to, state.schema.text(ed.text, ed.marks));
        tr.setMeta(DIRECT_META, true);
        if (dispatch) dispatch(tr);
        return true;
      },
      stepFontSize: (dir) => ({ editor, chain }) => {
        const ts = editor.getAttributes("textStyle");
        const style = (editor.getAttributes("paragraph").styleName as NamedStyle) ?? "normal";
        const cur = (ts.fontSize as number) ?? NAMED_STYLES[style]?.size ?? 11;
        const next = dir > 0 ? FONT_SIZES.find((x) => x > cur) ?? cur + 1 : [...FONT_SIZES].reverse().find((x) => x < cur) ?? Math.max(1, cur - 1);
        return chain().setMark("textStyle", { fontSize: roundSize(next) }).run();
      },
      clearFormatting: () => ({ chain }) =>
        chain()
          .unsetFormattingMarks()
          .command(updateParagraphs(() => ({ indent: 0, firstLine: false, lineSpacing: 115, textAlign: null, ...NO_LIST, box: null, keep: null, borders: null, shading: null })))
          .run(),
    };
  },
  addInputRules() {
    const listRule = (find: RegExp, type: ListType) =>
      new InputRule({
        find,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          const para = $from.parent;
          if (para.type.name !== "paragraph" || para.attrs.list) return null;
          state.tr.delete(range.from, range.to);
          state.tr.setNodeMarkup($from.before(), undefined, { ...para.attrs, list: type, indent: 0, firstLine: false });
        },
      });
    // Like Docs' autocorrect: "* " or "- " starts a bulleted list, "1. " a numbered one, "[] " a checklist
    return [listRule(/^\s*[-*]\s$/, "bullet"), listRule(/^\s*1[.)]\s$/, "ordered"), listRule(/^\s*\[\s?\]\s$/, "check")];
  },
  addKeyboardShortcuts() {
    const inEmptyListItem = (editor: Editor) => {
      const { selection } = editor.state;
      const parent = selection.$from.parent;
      return selection.empty && parent.type.name === "paragraph" && parent.attrs.list && parent.content.size === 0;
    };
    return {
      Enter: ({ editor }) => {
        // Enter on an empty list item ends the list, as in Docs
        if (inEmptyListItem(editor)) return editor.commands.updateAttributes("paragraph", NO_LIST);
        return false;
      },
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        const parent = selection.$from.parent;
        if (selection.empty && selection.$from.parentOffset === 0 && parent.attrs.list) {
          return editor.commands.updateAttributes("paragraph", NO_LIST);
        }
        return false;
      },
      "Mod-Shift-7": ({ editor }) => editor.commands.toggleList("ordered"),
      "Mod-Shift-8": ({ editor }) => editor.commands.toggleList("bullet"),
      "Mod-Shift-9": ({ editor }) => editor.commands.toggleList("check"),
      "Mod-k": () => {
        window.dispatchEvent(new CustomEvent("ss-open-link"));
        return true;
      },
      Tab: ({ editor }) => {
        const { selection } = editor.state;
        if (selection.$from.parent.attrs.list && selection.$from.parentOffset === 0) return true; // no nested lists
        const paragraphs = paragraphsInSelection(editor, selection.from, selection.to);
        if (paragraphs.length > 1) return editor.commands.indent();
        const atStart = selection.empty && selection.$from.parentOffset === 0;
        if (atStart) {
          const attrs = paragraphs[0]?.attrs ?? {};
          const box = attrs.box as { first?: number } | null;
          return attrs.firstLine || (box?.first ?? 0) > 0 ? editor.commands.indent() : editor.commands.setFirstLine(true);
        }
        return editor.commands.insertContent("\t");
      },
      "Shift-Tab": ({ editor }) => {
        const { selection } = editor.state;
        const attrs = paragraphsInSelection(editor, selection.from, selection.to)[0]?.attrs ?? {};
        if (attrs.firstLine) return editor.commands.setFirstLine(false);
        return editor.commands.outdent();
      },
      "Mod-]": ({ editor }) => editor.commands.indent(),
      "Mod-[": ({ editor }) => editor.commands.outdent(),
      "Mod-\\": ({ editor }) => editor.commands.clearFormatting(),
      "Mod-Alt-0": ({ editor }) => editor.commands.setNamedStyle("normal"),
      "Mod-Alt-1": ({ editor }) => editor.commands.setNamedStyle("h1"),
      "Mod-Alt-2": ({ editor }) => editor.commands.setNamedStyle("h2"),
      "Mod-Alt-3": ({ editor }) => editor.commands.setNamedStyle("h3"),
      "Mod-Alt-4": ({ editor }) => editor.commands.setNamedStyle("h4"),
      "Mod-Alt-5": ({ editor }) => editor.commands.setNamedStyle("h5"),
      "Mod-Alt-6": ({ editor }) => editor.commands.setNamedStyle("h6"),
      "Mod-.": ({ editor }) => editor.commands.toggleMark("superscript"),
      "Mod-,": ({ editor }) => editor.commands.toggleMark("subscript"),
      "Mod-Shift-.": ({ editor }) => editor.commands.stepFontSize(1),
      "Mod-Shift-,": ({ editor }) => editor.commands.stepFontSize(-1),
    };
  },
});

/**
 * Google Docs copies an empty paragraph as a bare <br> between paragraphs,
 * and browsers add one after the copied content. The first becomes an empty
 * paragraph (which syncs as a new line); the trailing one is dropped.
 */
export function pastedEmptyLines(html: string): string {
  if (typeof DOMParser === "undefined" || !/<br\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const br of Array.from(doc.querySelectorAll("br"))) {
    const parent = br.parentElement;
    if (!parent) continue;
    const BLOCK = "p, h1, h2, h3, h4, h5, h6, div, ul, ol, table, blockquote";
    const blocks = Array.from(parent.children).some((c) => c.matches(BLOCK) || c.querySelector(BLOCK));
    if (!blocks) continue; // a line break inside a paragraph
    const last = !br.nextElementSibling && !(br.nextSibling?.textContent ?? "").trim();
    if (last || br.classList.contains("Apple-interchange-newline")) br.remove();
    else br.replaceWith(doc.createElement("p"));
  }
  return doc.body.innerHTML;
}

/**
 * Pasted HTML lists become list paragraphs (Docs stores lists as a property
 * of each paragraph). Nested lists are flattened to one level.
 */
export function flattenPastedLists(html: string): string {
  if (typeof DOMParser === "undefined" || !/<(ol|ul)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let list = doc.querySelector("ol, ul");
  let guard = 0;
  while (list && guard++ < 500) {
    const type = list.tagName === "OL" ? "ordered" : "bullet";
    for (const li of Array.from(list.children).filter((c) => c.tagName === "LI")) {
      // Keep nested lists after their item; they are handled in a later pass
      const nested = Array.from(li.querySelectorAll(":scope > ol, :scope > ul"));
      nested.forEach((n) => n.remove());
      const p = doc.createElement("p");
      const style = li.getAttribute("style");
      if (style) p.setAttribute("style", style);
      p.setAttribute("data-list", li.getAttribute("role") === "checkbox" || li.querySelector("input[type=checkbox]") ? "check" : type);
      p.innerHTML = li.innerHTML.replace(/^\s*<p[^>]*>|<\/p>\s*$/gi, "");
      list.parentNode?.insertBefore(p, list);
      for (const n of nested) list.parentNode?.insertBefore(n, list);
    }
    list.remove();
    list = doc.querySelector("ol, ul");
  }
  return doc.body.innerHTML;
}

/** Inline, resizable images, like Docs' in-line images */
const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = parseFloat(el.getAttribute("width") ?? el.style.width ?? "");
          return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
        },
        renderHTML: (a: { width?: number | null }) => (a.width ? { width: a.width } : {}),
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = parseFloat(el.getAttribute("height") ?? el.style.height ?? "");
          return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
        },
        renderHTML: (a: { height?: number | null }) => (a.height ? { height: a.height } : {}),
      },
    };
  },
}).configure({
  inline: true,
  allowBase64: false,
  resize: { enabled: true, directions: ["top-left", "top-right", "bottom-left", "bottom-right"], minWidth: 32, minHeight: 32, alwaysPreserveAspectRatio: true },
});

const DocHighlight = Highlight.extend({
  parseHTML() {
    return [
      ...(this.parent?.() ?? []),
      // A style rule, so it applies alongside the span rules of other marks
      {
        style: "background-color",
        getAttrs: (value: string | HTMLElement) => {
          const bg = typeof value === "string" ? value : "";
          // Not transparent: the keyword, or an rgba() with alpha 0
          return bg && !/^(transparent|inherit|initial|unset|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\))$/i.test(bg) ? { color: bg } : false;
        },
      },
    ];
  },
}).configure({ multicolor: true });

/** Superscript and subscript, one or the other, as Docs' Format > Text has them */
const Superscript = Mark.create({
  name: "superscript",
  excludes: "subscript",
  parseHTML: () => [{ tag: "sup" }, { style: "vertical-align", getAttrs: (v: string | HTMLElement) => (v === "super" ? {} : false) }],
  renderHTML: () => ["sup", 0],
});
const Subscript = Mark.create({
  name: "subscript",
  excludes: "superscript",
  parseHTML: () => [{ tag: "sub" }, { style: "vertical-align", getAttrs: (v: string | HTMLElement) => (v === "sub" ? {} : false) }],
  renderHTML: () => ["sub", 0],
});

/** The copied HTML Docs and other editors understand: real heading tags, sizes for Title and Subtitle */
const ClipboardHTML = Extension.create({
  name: "clipboardHTML",
  addProseMirrorPlugins() {
    const { schema } = this.editor;
    const base = DOMSerializer.fromSchema(schema);
    const HEADING_TAG: Record<string, string> = { h1: "h1", h2: "h2", h3: "h3" };
    const paragraph = (node: PMNode): DOMOutputSpec => {
      const spec = base.nodes.paragraph(node);
      if (!Array.isArray(spec)) return spec;
      const [, attrs, ...rest] = spec as [string, Record<string, string>, ...unknown[]];
      const style = node.attrs.styleName as string;
      const out = { ...attrs };
      const size = style === "title" || style === "subtitle" ? NAMED_STYLES[style].size : null;
      if (size) out.style = [out.style, `font-size: ${size}pt`].filter(Boolean).join("; ");
      return [HEADING_TAG[style] ?? "p", out, ...rest] as DOMOutputSpec;
    };
    const serializer = new DOMSerializer({ ...base.nodes, paragraph }, base.marks);
    return [new Plugin({ props: { clipboardSerializer: serializer } })];
  },
});

export const editorExtensions = [
  StarterKit.configure({
    paragraph: false,
    heading: false,
    blockquote: false,
    codeBlock: false,
    code: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
    horizontalRule: false,
    link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer", target: null } },
  }),
  DocParagraph,
  TextStyle,
  FontAttributes,
  Color,
  DocHighlight,
  Superscript,
  Subscript,
  DocImage,
  TextAlign.configure({ types: ["paragraph"], alignments: ["left", "center", "right", "justify"] }),
  DocFormat,
  Pagination,
  SyncAdd,
  DocSync,
  ClipboardHTML,
];

type InlineStyle = { fontFamily?: string; fontSize?: string; color?: string; backgroundColor?: string; fontWeight?: string; fontStyle?: string; textDecoration?: string; verticalAlign?: string };

/** What an element says about each inherited text property, from its tag and its own style */
function ownStyle(el: HTMLElement): InlineStyle {
  const out: InlineStyle = {};
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") out.fontWeight = "700";
  if (tag === "I" || tag === "EM") out.fontStyle = "italic";
  if (tag === "U") out.textDecoration = "underline";
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") out.textDecoration = "line-through";
  if (tag === "SUP") out.verticalAlign = "super";
  if (tag === "SUB") out.verticalAlign = "sub";
  // A value that defers to the parent says nothing; keep looking up
  const set = (v: string) => (v && !/^(inherit|initial|unset)$/i.test(v) ? v : undefined);
  const s = el.style;
  out.fontFamily = set(s.fontFamily);
  out.fontSize = set(s.fontSize);
  out.color = set(s.color);
  out.backgroundColor = set(s.backgroundColor) && !/^transparent$/i.test(s.backgroundColor) ? s.backgroundColor : undefined;
  out.fontWeight = set(s.fontWeight) ?? out.fontWeight;
  out.fontStyle = set(s.fontStyle) ?? out.fontStyle;
  out.textDecoration = set(s.textDecorationLine || s.textDecoration) ?? out.textDecoration;
  const va = set(s.verticalAlign);
  if (va === "super" || va === "sub") out.verticalAlign = va;
  return out;
}

/**
 * Give every piece of pasted text its full formatting, inherited from all
 * of its ancestors the way a browser works it out. The editor only reads a
 * run's own element, so without this a run whose font or size comes from a
 * paragraph or wrapper (common when copying from Google Docs and web pages)
 * would fall back to the default font.
 */
export function inlinePastedStyles(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  const keys: (keyof InlineStyle)[] = ["fontFamily", "fontSize", "color", "backgroundColor", "fontWeight", "fontStyle", "textDecoration", "verticalAlign"];
  const css: Record<keyof InlineStyle, string> = {
    fontFamily: "font-family",
    fontSize: "font-size",
    color: "color",
    backgroundColor: "background-color",
    fontWeight: "font-weight",
    fontStyle: "font-style",
    textDecoration: "text-decoration",
    verticalAlign: "vertical-align",
  };
  for (const text of texts) {
    if (!text.data || !text.parentElement) continue;
    // Whitespace between blocks isn't text anyone sees
    if (!text.data.trim() && /^(BODY|DIV|UL|OL|TABLE|TBODY|TR)$/.test(text.parentElement.tagName)) continue;
    const style: InlineStyle = {};
    for (let el: HTMLElement | null = text.parentElement; el && el !== doc.body; el = el.parentElement) {
      const own = ownStyle(el);
      for (const k of keys) if (style[k] == null && own[k] != null) style[k] = own[k];
    }
    const decl = keys.filter((k) => style[k] != null).map((k) => `${css[k]}: ${style[k]}`).join("; ");
    if (!decl) continue;
    const span = doc.createElement("span");
    span.setAttribute("style", decl);
    text.replaceWith(span);
    span.appendChild(text);
  }
  return doc.body.innerHTML;
}
