import { Extension, InputRule, Mark, Node, type Editor } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { DOMSerializer, type DOMOutputSpec, type Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { Pagination } from "./pagination";
import { DocSync, SyncAdd } from "./doc-sync";
import { Find } from "./find";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
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
  MAX_LIST_LEVEL,
  NAMED_STYLES,
  presetType,
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
      toggleList: (type: ListType, preset?: string) => ReturnType;
      /** Docs list style for the current list run */
      setListPreset: (preset: string) => ReturnType;
      /** Exact indents in points (the ruler): text start, first line offset, right indent */
      setIndents: (indents: { start?: number; first?: number; end?: number }) => ReturnType;
      /** Docs' Ctrl+Enter: the text after the cursor starts on the next page */
      insertPageBreak: () => ReturnType;
      /** A section break after the current paragraph (saved to the document right away) */
      insertSectionBreak: (type: "next" | "continuous") => ReturnType;
      /** Docs' Ctrl+Alt+F: a footnote reference here; Docs creates the footnote when it is saved */
      insertFootnote: () => ReturnType;
      /** Format > Columns for the section the selection is in; textWidth in points */
      setColumns: (layout: { columns: number; spacing?: number; line?: boolean; textWidth: number }) => ReturnType;
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
  addKeyboardShortcuts() {
    // Docs' Ctrl+Alt+0: Normal text (the stock paragraph shortcut would only keep the node a paragraph)
    return { "Mod-Alt-0": () => this.editor.commands.setNamedStyle("normal") };
  },
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
      /** A section break's kind: "next" (next page) or "continuous" */
      sectionType: {
        default: null,
        keepOnSplit: false,
        parseHTML: () => null,
        renderHTML: (a: { sectionType?: string | null }) => (a.sectionType ? { "data-section": a.sectionType } : {}),
      },
      /** The document's first section has a hidden marker; its columns live here too */
      first: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: (a: { first?: boolean | null }) => (a.first ? { "data-first": "" } : {}) },
      columns: { default: null, keepOnSplit: false, parseHTML: () => null, rendered: false },
      spacing: { default: null, keepOnSplit: false, parseHTML: () => null, rendered: false },
      line: { default: null, keepOnSplit: false, parseHTML: () => null, rendered: false },
      textWidth: { default: null, keepOnSplit: false, parseHTML: () => null, rendered: false },
      /** Which Docs list a paragraph belongs to, its level, and what Docs draws for it (labels are decorations) */
      listId: { default: null, parseHTML: () => null, rendered: false },
      level: {
        default: null,
        parseHTML: (el: HTMLElement) => { const v = parseInt(el.getAttribute("data-level") ?? "", 10); return Number.isFinite(v) ? Math.max(0, Math.min(MAX_LIST_LEVEL, v)) : null; },
        renderHTML: (a: { level?: number | null; list?: string | null }) => (a.list && a.level ? { "data-level": String(a.level) } : {}),
      },
      glyph: { default: null, parseHTML: () => null, rendered: false },
      /** Docs list style of a list made here */
      preset: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-preset"),
        renderHTML: (a: { preset?: string | null; list?: string | null }) => (a.list && a.preset ? { "data-preset": a.preset } : {}),
      },
      /** Right indent in points */
      indentEnd: {
        default: null,
        parseHTML: (el: HTMLElement) => { const v = cssLengthToPt(el.style.marginRight); return v && v > 0 ? Math.round(v * 100) / 100 : null; },
        renderHTML: (a: { indentEnd?: number | null }) => (a.indentEnd ? { style: `margin-right: ${a.indentEnd}pt` } : {}),
      },
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
          // Docs and browsers copy line spacing as 1.2 × the spacing; Word as a percentage of
          // lines; Chrome sometimes as a length, read against the element's own font size
          const raw = el.style.lineHeight;
          const lh = parseFloat(raw);
          if (!Number.isFinite(lh) || lh <= 0) return 115;
          let pct: number;
          if (/%\s*$/.test(raw)) pct = lh;
          else if (/px|pt/.test(raw)) {
            const fs = parseFloat(el.style.fontSize);
            const sameUnit = /px/.test(raw) === /px/.test(el.style.fontSize);
            if (!Number.isFinite(fs) || fs <= 0 || !sameUnit) return 115;
            pct = (lh / fs / 1.2) * 100;
          } else pct = (lh / 1.2) * 100;
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
const NO_LIST = { list: null, listId: null, level: null, glyph: null, preset: null, box: null };

/** A list item at a new level. An item read from a Docs list becomes one of our lists in the same style. */
function localList(a: Record<string, unknown>, level: number): Record<string, unknown> {
  const glyph = a.glyph as { type?: string | null; symbol?: string | null } | null;
  const preset = (a.preset as string | null) ?? (a.list === "ordered" ? presetFromGlyph(glyph?.type) : a.list === "check" ? "BULLET_CHECKBOX" : "BULLET_DISC_CIRCLE_SQUARE");
  return { level, preset, listId: null, glyph: null, box: null };
}
function presetFromGlyph(type: string | null | undefined): string {
  switch (type) {
    case "UPPER_ALPHA": return "NUMBERED_UPPERALPHA_ALPHA_ROMAN";
    case "UPPER_ROMAN": return "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL";
    case "ZERO_DECIMAL": return "NUMBERED_ZERODECIMAL_ALPHA_ROMAN";
    default: return "NUMBERED_DECIMAL_ALPHA_ROMAN";
  }
}

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
      // On a list item, indenting changes its level, as in Docs (an item of a Docs list becomes one of ours)
      indent: () => updateParagraphs((a) => (a.list ? localList(a, Math.min(MAX_LIST_LEVEL, ((a.level as number | null) ?? 0) + 1)) : { indent: Math.min(MAX_INDENT, stepsOf(a) + 1), box: null })),
      outdent: () => updateParagraphs((a) => (a.list ? localList(a, Math.max(0, ((a.level as number | null) ?? 0) - 1)) : { indent: Math.max(0, stepsOf(a) - 1), box: null })),
      setListPreset: (preset) => ({ tr, state, dispatch }) => {
        const type = presetType(preset);
        if (!type) return false;
        // The whole run of consecutive list items the selection touches takes the style
        const { from, to } = state.selection;
        const paras: { pos: number; node: typeof state.doc }[] = [];
        state.doc.forEach((node, pos) => paras.push({ pos, node }));
        const inSel = (p: { pos: number; node: typeof state.doc }) => p.pos < to && p.pos + p.node.nodeSize > from;
        const isList = (p: { pos: number; node: typeof state.doc }) => !!p.node.attrs.list;
        const hit = new Set<number>();
        paras.forEach((p, i) => {
          if (!inSel(p) || !isList(p)) return;
          let s = i;
          let e = i;
          while (s > 0 && isList(paras[s - 1])) s--;
          while (e < paras.length - 1 && isList(paras[e + 1])) e++;
          for (let k = s; k <= e; k++) hit.add(k);
        });
        for (const k of Array.from(hit)) {
          const p = paras[k];
          tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, list: type, preset, listId: null, glyph: null, level: (p.node.attrs.level as number | null) ?? 0 });
        }
        if (dispatch) dispatch(tr);
        return hit.size > 0;
      },
      setIndents: (indents) => updateParagraphs((a) => {
        const out: Record<string, unknown> = {};
        if (indents.end != null) out.indentEnd = indents.end > 0 ? Math.round(indents.end * 100) / 100 : null;
        if (indents.start == null && indents.first == null) return out;
        const cur = (a.box as { start?: number; first?: number; marker?: number; above?: number | null; below?: number | null } | null) ?? null;
        const r = (v: number) => Math.round(v * 100) / 100;
        if (a.list) {
          const start = r(indents.start ?? cur?.start ?? 36);
          const marker = r((indents.first ?? (cur ? (cur.start ?? 36) + (cur.marker ?? -18) : 18)) - start);
          return { ...out, box: { ...(cur ?? {}), start, marker } };
        }
        const start = r(indents.start ?? cur?.start ?? stepsOf(a) * INDENT_PT);
        const first = r((indents.first ?? (cur ? (cur.start ?? 0) + (cur.first ?? 0) : start + (a.firstLine ? INDENT_PT : 0))) - start);
        return { ...out, box: { ...(cur ?? {}), start, first }, indent: 0, firstLine: false };
      }),
      setFirstLine: (on) => updateParagraphs((a) => (a.list ? {} : { indent: stepsOf(a), firstLine: on, box: null })),
      toggleList: (type, preset) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection;
        const paras: { pos: number; attrs: Record<string, unknown> }[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === "paragraph") paras.push({ pos, attrs: node.attrs });
        });
        const allOn = paras.length > 0 && paras.every((p) => p.attrs.list === type && (!preset || p.attrs.preset === preset));
        for (const p of paras) {
          tr.setNodeMarkup(p.pos, undefined, allOn ? { ...p.attrs, ...NO_LIST } : { ...p.attrs, ...NO_LIST, list: type, preset: preset ?? null, level: 0, indent: 0, firstLine: false });
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
      insertPageBreak: () => ({ tr, state, dispatch }) => {
        if (state.selection.$from.parent.attrs.locked) return false;
        // The break replaces the selection and the paragraph splits right after it, in one transaction:
        // splitting as a second command would map the caret through the insertion and land one place late
        const { from } = state.selection;
        tr.replaceSelectionWith(state.schema.nodes.pageBreak.create());
        tr.split(from + 1);
        if (dispatch) dispatch(tr.scrollIntoView());
        return true;
      },
      setColumns: (layout) => ({ tr, state, dispatch }) => {
        // The section marker before the selection (the first section's hidden one is made if missing)
        const { $from } = state.selection;
        const top = $from.depth ? $from.before(1) : $from.pos;
        let markerPos: number | null = null;
        state.doc.forEach((node, pos) => { if (pos <= top && node.type.name === "paragraph" && node.attrs.kind === "section") markerPos = pos; });
        const attrs = { columns: Math.max(1, Math.min(3, layout.columns)), spacing: layout.spacing ?? 36, line: layout.line ?? false, textWidth: layout.textWidth };
        if (markerPos == null) {
          const marker = state.schema.nodes.paragraph.create({ locked: true, kind: "section", first: true, span: 0, sectionType: "next", ...attrs });
          tr.insert(0, marker);
        } else {
          const node = state.doc.nodeAt(markerPos)!;
          tr.setNodeMarkup(markerPos, undefined, { ...node.attrs, ...attrs });
        }
        tr.setMeta("ssRegroup", true);
        if (dispatch) dispatch(tr);
        return true;
      },
      insertFootnote: () => ({ chain, state }) => {
        if (state.selection.$from.parent.attrs.locked || state.selection.$from.parent.type.name !== "paragraph") return false;
        return chain().insertContent({ type: "footnoteRef", attrs: { fid: null } }).run();
      },
      insertSectionBreak: (type) => ({ tr, state, dispatch }) => {
        const { $to } = state.selection;
        if ($to.parent.attrs.locked) return false;
        const node = state.schema.nodes.paragraph.create({ locked: true, kind: "section", sectionType: type });
        const at = $to.after();
        tr.insert(at, node);
        // A paragraph to type into always follows the break
        if (!tr.doc.resolve(at + node.nodeSize).nodeAfter) tr.insert(at + node.nodeSize, state.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, at + node.nodeSize + 1));
        if (dispatch) dispatch(tr.scrollIntoView());
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
          .command(updateParagraphs(() => ({ indent: 0, firstLine: false, lineSpacing: 115, textAlign: null, ...NO_LIST, box: null, indentEnd: null, keep: null, borders: null, shading: null })))
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
        // Enter at the end of a title or heading opens a Normal text paragraph, as in Docs
        const { selection } = editor.state;
        const parent = selection.$from.parent;
        if (selection.empty && parent.type.name === "paragraph" && parent.attrs.styleName !== "normal" && !parent.attrs.list && !parent.attrs.locked && parent.content.size > 0 && selection.$from.parentOffset === parent.content.size) {
          return editor.chain().splitBlock().updateAttributes("paragraph", { styleName: "normal" }).run();
        }
        return false;
      },
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        const parent = selection.$from.parent;
        if (selection.empty && selection.$from.parentOffset === 0 && parent.attrs.list) {
          // Docs: a nested item outdents first, then loses its bullet
          return (parent.attrs.level ?? 0) > 0 ? editor.commands.outdent() : editor.commands.updateAttributes("paragraph", NO_LIST);
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
        if (editor.isActive("table")) return editor.commands.goToNextCell() || editor.chain().addRowAfter().goToNextCell().run();
        // At the start of a list item, Tab nests it one level deeper, as in Docs
        if (selection.$from.parent.attrs.list && selection.$from.parentOffset === 0) return editor.commands.indent();
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
        if (editor.isActive("table")) return editor.commands.goToPreviousCell();
        const attrs = paragraphsInSelection(editor, selection.from, selection.to)[0]?.attrs ?? {};
        if (attrs.firstLine && !attrs.list) return editor.commands.setFirstLine(false);
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
      "Mod-Enter": ({ editor }) => editor.commands.insertPageBreak(),
      "Alt-Shift-5": ({ editor }) => editor.commands.toggleStrike(),
      "Mod-/": () => { window.dispatchEvent(new CustomEvent("ss-shortcuts")); return true; },
      "Mod-Alt-f": ({ editor }) => editor.commands.insertFootnote(),
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
 * of each paragraph), in document order, each at its nesting level. Docs
 * wraps an item's text in a <p> that carries the paragraph's alignment and
 * spacing and marks the level with aria-level; other sources nest <ul>/<ol>.
 */
export function flattenPastedLists(html: string): string {
  if (typeof DOMParser === "undefined" || !/<(ol|ul)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const flatten = (list: Element, depth: number, out: Element[]) => {
    const type = list.tagName === "OL" ? "ordered" : "bullet";
    for (const child of Array.from(list.children)) {
      if (child.tagName === "OL" || child.tagName === "UL") { flatten(child, depth + 1, out); continue; }
      if (child.tagName !== "LI") { out.push(child); continue; }
      const li = child;
      const nested = Array.from(li.children).filter((c) => c.tagName === "OL" || c.tagName === "UL");
      nested.forEach((n) => n.remove());
      const inner = li.children.length === 1 && li.firstElementChild?.tagName === "P" ? li.firstElementChild : null;
      const p = doc.createElement("p");
      const style = [li.getAttribute("style"), inner?.getAttribute("style")].filter(Boolean).join("; ");
      if (style) p.setAttribute("style", style);
      const aria = parseInt(li.getAttribute("aria-level") ?? "", 10);
      const level = Number.isFinite(aria) ? Math.max(0, aria - 1) : depth;
      if (level > 0) p.setAttribute("data-level", String(level));
      p.setAttribute("data-list", li.getAttribute("role") === "checkbox" || li.querySelector("input[type=checkbox]") ? "check" : type);
      p.innerHTML = inner ? inner.innerHTML : li.innerHTML.replace(/^\s*<p[^>]*>|<\/p>\s*$/gi, "");
      out.push(p);
      for (const n of nested) flatten(n, depth + 1, out);
    }
  };
  const top = Array.from(doc.querySelectorAll("ol, ul")).filter((l) => !l.parentElement?.closest("ol, ul"));
  for (const list of top) {
    const out: Element[] = [];
    flatten(list, 0, out);
    for (const el of out) list.parentNode?.insertBefore(el, list);
    list.remove();
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
        // The document's own proportions, kept when the image is narrowed to fit the page
        renderHTML: (a: { width?: number | null; height?: number | null }) => (a.height ? { height: a.height, ...(a.width ? { style: `aspect-ratio: ${a.width} / ${a.height}` } : {}) } : {}),
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

/** A page break: what follows starts on the next page. One Docs index, like an image. */
const PageBreak = Node.create({
  name: "pageBreak",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "span[data-page-break]" }],
  renderHTML: () => ["span", { "data-page-break": "", class: "ss-page-break", contenteditable: "false" }, ["span", { class: "ss-page-break-label" }, "Page break"]],
});

/**
 * Docs tables. A table, row or cell read from a document keeps its identity
 * (tid, rid, cid) and the Docs indices its start occupies (span); ones made
 * here have none until the document is read back.
 */
const idAttr = (name: string) => ({ [name]: { default: null, parseHTML: () => null, rendered: false } });
const spanAttr = { span: { default: null, parseHTML: () => null, rendered: false }, endSpan: { default: null, parseHTML: () => null, rendered: false } };
const DocTable = Table.extend({
  addAttributes() { return { ...this.parent?.(), ...idAttr("tid"), ...spanAttr }; },
}).configure({ resizable: false, HTMLAttributes: { class: "ss-table" } });
const DocTableRow = TableRow.extend({ addAttributes() { return { ...this.parent?.(), ...idAttr("rid"), ...spanAttr }; } });
const DocTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...idAttr("cid"),
      ...spanAttr,
      background: {
        default: null,
        parseHTML: (el: HTMLElement) => cssColorToHex(el.style.backgroundColor) ?? null,
        renderHTML: (a: { background?: string | null }) => (a.background ? { style: `background-color: ${a.background}` } : {}),
      },
    };
  },
});
// Header cells from pasted HTML become ordinary cells (Docs has none)
const DocTableHeader = TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...idAttr("cid"), ...spanAttr }; } });

/**
 * The blocks of a section laid out in columns. Only a view: the document
 * model sees its children as ordinary blocks after the section break.
 */
const ColumnSection = Node.create({
  name: "columnSection",
  group: "block",
  content: "(paragraph | table)+",
  addAttributes() {
    return {
      columns: { default: 2, parseHTML: () => null, rendered: false },
      spacing: { default: 36, parseHTML: () => null, rendered: false },
      line: { default: false, parseHTML: () => null, rendered: false },
    };
  },
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: ({ node }) => ["div", { "data-columns": String(node.attrs.columns), class: "ss-section-cols", style: `--ss-cols: ${node.attrs.columns}; --ss-col-gap: ${node.attrs.spacing}pt; --ss-col-rule: ${node.attrs.line ? "1px solid #000" : "none"}` }, 0],
});

/** A footnote's reference in the text: a superscript number. Its text lives in the footnote editor. */
const FootnoteRef = Node.create({
  name: "footnoteRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      fid: { default: null, parseHTML: () => null, rendered: false },
      n: { default: null, parseHTML: () => null, rendered: false },
    };
  },
  parseHTML: () => [{ tag: "sup[data-footnote]" }],
  renderHTML: ({ node }) => ["sup", { "data-footnote": node.attrs.fid ?? "", class: "ss-fn-ref", contenteditable: "false" }],
  addProseMirrorPlugins() {
    // Numbered in document order, as Docs numbers them
    const number = (doc: PMNode) => {
      const decos: Decoration[] = [];
      let n = 0;
      doc.descendants((node, pos) => { if (node.type.name === "footnoteRef") decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-n": String(++n) })); });
      return DecorationSet.create(doc, decos);
    };
    return [new Plugin<DecorationSet>({
      state: { init: (_c, state) => number(state.doc), apply: (tr, value) => (tr.docChanged ? number(tr.doc) : value) },
      props: { decorations(state) { return this.getState(state); } },
    })];
  },
});

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
/** Text colour that is only an attribute when the element has one (a styled span with no colour gets none) */
const DocColor = Color.extend({
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        color: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.color?.replace(/['"]+/g, "") || null,
          renderHTML: (attrs: { color?: string | null }) => (attrs.color ? { style: `color: ${attrs.color}` } : {}),
        },
      },
    }];
  },
});

const SmallCaps = Mark.create({
  name: "smallCaps",
  parseHTML: () => [
    { style: "font-variant", getAttrs: (v: string | HTMLElement) => (typeof v === "string" && /small-caps/.test(v) ? {} : false) },
    { style: "font-variant-caps", getAttrs: (v: string | HTMLElement) => (v === "small-caps" ? {} : false) },
  ],
  renderHTML: () => ["span", { style: "font-variant: small-caps" }, 0],
});

/**
 * The copied HTML Docs and other editors understand: real heading tags, sizes
 * for Title and Subtitle, plain line-height numbers (Docs' 1.2 × spacing), real
 * <ul>/<ol>/<li> lists nested by level, and no label text for page breaks. The
 * data-* attributes stay, so pasting back into SyncStream is exact.
 */
const ClipboardHTML = Extension.create({
  name: "clipboardHTML",
  addProseMirrorPlugins() {
    const { schema } = this.editor;
    const base = DOMSerializer.fromSchema(schema);
    const HEADING_TAG: Record<string, string> = { h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6" };
    const paragraph = (node: PMNode): DOMOutputSpec => {
      const spec = base.nodes.paragraph(node);
      if (!Array.isArray(spec)) return spec;
      const [, attrs, ...rest] = spec as [string, Record<string, string>, ...unknown[]];
      const style = node.attrs.styleName as string;
      const out = { ...attrs };
      const spacing = typeof node.attrs.lineSpacing === "number" ? node.attrs.lineSpacing : 115;
      out.style = (out.style ?? "").replace(/--ss-spacing:[^;]*;\s*line-height:[^;]*/, `line-height: ${Math.round((spacing / 100) * 1.2 * 100) / 100}`);
      const size = style === "title" || style === "subtitle" ? NAMED_STYLES[style].size : null;
      if (size) out.style = [out.style, `font-size: ${size}pt`].filter(Boolean).join("; ");
      return [HEADING_TAG[style] ?? "p", out, ...rest] as DOMOutputSpec;
    };
    const pageBreak = (): DOMOutputSpec => ["span", { "data-page-break": "", style: "display: block; page-break-before: always" }];
    const serializer = new DOMSerializer({ ...base.nodes, paragraph, pageBreak }, base.marks);
    const grouped = {
      serializeFragment(fragment: PMNode["content"], options: { document?: Document } = {}): DocumentFragment {
        const doc = options.document ?? document;
        const out = doc.createDocumentFragment();
        // stack[i] is the open list element at level i
        let stack: HTMLElement[] = [];
        fragment.forEach((node) => {
          if (node.type.name === "paragraph" && node.attrs.list) {
            const level = Math.max(0, Number(node.attrs.level ?? 0));
            const tag = node.attrs.list === "ordered" ? "ol" : "ul";
            stack = stack.slice(0, level + 1);
            for (let i = stack.length; i <= level; i++) {
              const list = doc.createElement(i === level ? tag : "ul");
              if (i === 0) out.appendChild(list);
              else {
                let li = stack[i - 1].lastElementChild as HTMLElement | null;
                if (!li) { li = doc.createElement("li"); stack[i - 1].appendChild(li); }
                li.appendChild(list);
              }
              stack.push(list);
            }
            if (stack[level].tagName.toLowerCase() !== tag) {
              const list = doc.createElement(tag);
              stack[level].parentNode?.insertBefore(list, stack[level].nextSibling);
              stack[level] = list;
              stack = stack.slice(0, level + 1);
            }
            const li = doc.createElement("li");
            li.setAttribute("aria-level", String(level + 1));
            if (node.attrs.list === "check") li.setAttribute("role", "checkbox");
            li.appendChild(serializer.serializeNode(node, options));
            stack[level].appendChild(li);
          } else {
            stack = [];
            out.appendChild(serializer.serializeNode(node, options));
          }
        });
        return out;
      },
    };
    return [new Plugin({ props: { clipboardSerializer: grouped as unknown as DOMSerializer } })];
  },
});

/** What a header, footer or footnote editor offers: the body's formatting, no pages, no additions */
export const segmentExtensions = () => [
  StarterKit.configure({
    paragraph: false, heading: false, blockquote: false, codeBlock: false, code: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, horizontalRule: false,
    link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer", target: null } },
  }),
  DocParagraph,
  TextStyle,
  FontAttributes,
  DocColor,
  DocHighlight,
  Superscript,
  Subscript,
  SmallCaps,
  DocImage,
  TextAlign.configure({ types: ["paragraph"], alignments: ["left", "center", "right", "justify"] }),
  DocFormat,
  ClipboardHTML,
];

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
  DocColor,
  DocHighlight,
  Superscript,
  Subscript,
  SmallCaps,
  PageBreak,
  FootnoteRef,
  ColumnSection,
  DocTable,
  DocTableRow,
  DocTableCell,
  DocTableHeader,
  DocImage,
  TextAlign.configure({ types: ["paragraph"], alignments: ["left", "center", "right", "justify"] }),
  DocFormat,
  Pagination,
  SyncAdd,
  DocSync,
  ClipboardHTML,
  Find,
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
