import { Extension, InputRule, Mark, mergeAttributes, Node, type Editor } from "@tiptap/core";
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
import { DocsLineBreaks } from "./line-breaks";
import { LinkLook } from "./link-look";
import { Find } from "./find";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import {
  cssColorToHex,
  cssFontToFamily,
  cssLengthToPt,
  canonicalKeep,
  cleanStyle,
  effectiveKeep,
  fontStack,
  fontWeightOf,
  FONT_SIZES,
  INDENT_PT,
  keepFlags,
  LINE_SPACINGS,
  LINK_COLOR,
  MAX_INDENT,
  MAX_LIST_LEVEL,
  NAMED_STYLES,
  namedKeep,
  presetOf,
  presetType,
  roundSize,
  sameKeep,
  type Border,
  type Borders,
  type KeepOptions,
  type ListType,
  type NamedStyle,
} from "@/lib/rich-text";
import { presetForLevels, type Glyph } from "@/lib/list-labels";
import { docKeeps } from "@/lib/doc-import";

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
      /**
       * Docs' left-to-right and right-to-left text: the paragraph's direction. Like Docs it keeps the
       * alignment by the paragraph's sides, so text aligned to its start moves with it to the other side
       */
      setDirection: (dir: "ltr" | "rtl") => ReturnType;
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

/** Whether an element's paragraph runs right to left, as its HTML says */
const isRtl = (el: HTMLElement | null | undefined) => !!el && (el.getAttribute("dir") ?? el.style.direction).toLowerCase() === "rtl";
/** The page side a paragraph's text starts on, and the one it ends on */
const startSide = (dir: unknown) => (dir === "rtl" ? "right" : "left");
const endSide = (dir: unknown) => (dir === "rtl" ? "left" : "right");

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
 * those instead. A list item keeps its spacing; its indent is its level's
 * (Docs' HTML nests lists half an inch a level) unless SyncStream's own copy
 * gives the exact one.
 */
type PastedBox = { start: number; first?: number; marker?: number; above: number | null; below: number | null };
function pastedBox(el: HTMLElement): PastedBox | null {
  const s = el.style;
  const pt = (v: string) => { const n = cssLengthToPt(v); return n == null ? null : Math.max(-1000, Math.min(1000, Math.round(n * 2) / 2)); };
  if (el.hasAttribute("data-list")) {
    const exact = pt(s.getPropertyValue("--ss-li-start"));
    let above = pt(s.marginTop);
    let below = pt(s.marginBottom);
    if (cssColorToHex(el.getAttribute("data-shading") ?? s.backgroundColor) && !(pt(s.paddingLeft) ?? 0) && !(pt(s.paddingRight) ?? 0)) {
      if ((pt(s.paddingTop) ?? 0) > 0) above = (above ?? 0) + pt(s.paddingTop)!;
      if ((pt(s.paddingBottom) ?? 0) > 0) below = (below ?? 0) + pt(s.paddingBottom)!;
    }
    if (exact == null && above == null && below == null) return null;
    const level = Math.max(0, Math.min(MAX_LIST_LEVEL, parseInt(el.getAttribute("data-level") ?? "0", 10) || 0));
    return { start: exact ?? INDENT_PT * (level + 1), marker: pt(s.getPropertyValue("--ss-li-marker")) ?? -18, above, below };
  }
  if (el.hasAttribute("data-indent") || el.hasAttribute("data-first-line")) return null;
  // The indent is on the side the text starts on: the right, in a right-to-left paragraph
  const rtl = isRtl(el);
  const marginStart = rtl ? s.marginRight : s.marginLeft;
  const paddingStart = rtl ? s.paddingRight : s.paddingLeft;
  if (!marginStart && !paddingStart && !s.textIndent && !s.marginTop && !s.marginBottom) return null;
  // Padding is an indent only on a plain paragraph: on a shaded or bordered one it is the shading's or the
  // border's (Docs writes a border's padding even for an invisible border, and the space of a shaded
  // paragraph next to another as padding, so the shading covers it)
  const framed = !!cssColorToHex(el.getAttribute("data-shading") ?? s.backgroundColor) || !!s.borderLeftStyle || !!s.borderTopStyle || !!s.borderBottomStyle;
  const start = pt(marginStart) ?? (framed ? null : pt(paddingStart)) ?? 0;
  const first = pt(s.textIndent) ?? 0;
  let above = pt(s.marginTop), below = pt(s.marginBottom);
  if (framed && !(pt(s.paddingLeft) ?? 0) && !(pt(s.paddingRight) ?? 0)) {
    if (!s.borderTopStyle && (pt(s.paddingTop) ?? 0) > 0) above = (above ?? 0) + pt(s.paddingTop)!;
    if (!s.borderBottomStyle && (pt(s.paddingBottom) ?? 0) > 0) below = (below ?? 0) + pt(s.paddingBottom)!;
  }
  return { start: Math.max(0, start), first, above, below };
}

/** Paragraphs carry the Google Docs paragraph properties we support. */
/**
 * The largest size a paragraph's text has, as a length (max(1em, …) when some of it is the paragraph's own
 * size): Docs puts a line's spacing beyond single below its text, by the text's size (see docs.css,
 * --ss-shift), not the paragraph style's. Only paragraphs with text of a size of its own get one.
 */
/** An empty paragraph's look: its newline's font and size (see the nl attribute) */
function newlineLook(node: PMNode): { font?: string; size?: number } | null {
  if (node.childCount || !Array.isArray(node.attrs.nl)) return null;
  const ts = (node.attrs.nl as { type?: string; attrs?: { fontFamily?: unknown; fontSize?: unknown } }[]).find((m) => m?.type === "textStyle")?.attrs;
  const font = typeof ts?.fontFamily === "string" && ts.fontFamily ? ts.fontFamily : undefined;
  const size = typeof ts?.fontSize === "number" && ts.fontSize > 0 ? ts.fontSize : undefined;
  return { ...(font ? { font } : {}), ...(size ? { size } : {}) };
}

export function lineSize(node: PMNode): string | null {
  if (!node.childCount) { const nl = newlineLook(node)?.size; return nl ? `${nl}pt` : null; }
  const sizes = new Set<number>();
  let own = false;
  node.forEach((c) => {
    if (!c.isText) return;
    const size = c.marks.find((m) => m.type.name === "textStyle")?.attrs.fontSize;
    if (typeof size === "number" && size > 0) sizes.add(size);
    else own = true;
  });
  if (!sizes.size) return null;
  const list = [...(own ? ["1em"] : []), ...Array.from(sizes).sort((a, b) => b - a).map((v) => `${v}pt`)];
  return list.length > 1 ? `max(${list.join(", ")})` : list[0];
}

/**
 * The font and size a paragraph's text all has, when it has one of its own. Docs sizes each line by
 * the text on it; the browser makes every line at least as tall as the paragraph's own font at its
 * size, so a paragraph whose text is all another font or size takes that as its own.
 */
export function textLook(node: PMNode): { font?: string; size?: number } {
  const empty = newlineLook(node);
  if (empty) return empty;
  const fonts = new Set<string | null>();
  const sizes = new Set<number | null>();
  node.forEach((c) => {
    if (!c.isText) return;
    const ts = c.marks.find((m) => m.type.name === "textStyle")?.attrs;
    fonts.add(typeof ts?.fontFamily === "string" && ts.fontFamily ? ts.fontFamily : null);
    sizes.add(typeof ts?.fontSize === "number" && ts.fontSize > 0 ? ts.fontSize : null);
  });
  const [font] = Array.from(fonts);
  const [size] = Array.from(sizes);
  return { ...(fonts.size === 1 && font ? { font } : {}), ...(sizes.size === 1 && size ? { size } : {}) };
}

function lineSizes(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph") return true;
    const size = lineSize(node);
    const look = textLook(node);
    const attrs: Record<string, string> = {};
    const style = [size ? `--ss-line-size: ${size}` : "", look.size ? `font-size: ${look.size}pt` : ""].filter(Boolean).join("; ");
    if (style) attrs.style = style;
    if (look.font) attrs["data-font"] = look.font;
    if (Object.keys(attrs).length) decorations.push(Decoration.node(pos, pos + node.nodeSize, attrs));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

const DocParagraph = Paragraph.extend({
  /**
   * The paragraph's text is in a span of its own, which draws it where Docs puts it in its lines (see
   * docs.css, .ss-text): the paragraph's box, its shading and borders, and where a click lands stay where
   * the paragraph is laid out
   */
  renderHTML({ HTMLAttributes }) {
    return ["p", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), ["span", { class: "ss-text" }, 0]];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      state: { init: (_c, state) => lineSizes(state.doc), apply: (tr, old) => (tr.docChanged ? lineSizes(tr.doc) : old) },
      props: { decorations(state) { return this.getState(state); } },
    }), new Plugin({
      // The caret in an empty line with a look of its own (nl): text typed there takes it, as in Docs
      appendTransaction: (trs, _old, state) => {
        if (!trs.some((tr) => tr.selectionSet || tr.docChanged) || state.storedMarks || !state.selection.empty) return null;
        const para = state.selection.$from.parent;
        if (para.type.name !== "paragraph" || para.childCount || !Array.isArray(para.attrs.nl)) return null;
        const marks = (para.attrs.nl as unknown[]).flatMap((m) => { try { return [state.schema.markFromJSON(m)]; } catch { return []; } });
        return marks.length ? state.tr.setStoredMarks(marks) : null;
      },
    })];
  },
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
        renderHTML: (a: { indent?: number; dir?: string | null }) =>
          a.indent ? { "data-indent": String(a.indent), style: `margin-${startSide(a.dir)}: ${(a.indent * INDENT_PT) / 72}in` } : {},
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
      /**
       * The text style Docs draws the item's glyph in (its bullet style), when the document or a copy
       * from Docs gives one; without it the glyph takes the item's first character's (see doc-sync.ts).
       * A new item made with Enter starts without one, as the sync makes it.
       */
      glyphStyle: {
        default: null,
        keepOnSplit: false,
        parseHTML: (el: HTMLElement) => { try { const v = el.getAttribute("data-glyph-style"); return v ? cleanStyle(JSON.parse(v)) : null; } catch { return null; } },
        renderHTML: (a: { glyphStyle?: Record<string, unknown> | null; list?: string | null }) => (a.list && a.glyphStyle ? { "data-glyph-style": JSON.stringify(a.glyphStyle) } : {}),
      },
      /** Docs list style of a list made here */
      preset: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-preset"),
        renderHTML: (a: { preset?: string | null; list?: string | null }) => (a.list && a.preset ? { "data-preset": a.preset } : {}),
      },
      /** Indent at the end of the line (the right, left to right), in points */
      indentEnd: {
        default: null,
        parseHTML: (el: HTMLElement) => { const v = cssLengthToPt(isRtl(el) ? el.style.marginLeft : el.style.marginRight); return v && v > 0 ? Math.round(v * 100) / 100 : null; },
        renderHTML: (a: { indentEnd?: number | null; dir?: string | null }) => (a.indentEnd ? { style: `margin-${endSide(a.dir)}: ${a.indentEnd}pt` } : {}),
      },
      /**
       * Docs' paragraph direction: "rtl" for a right-to-left paragraph. Its alignment (textAlign) is where it
       * sits on the page, its indents are on its own sides, and a paragraph split from it keeps it, as in Docs
       */
      dir: {
        default: null,
        parseHTML: (el: HTMLElement) => (isRtl(el) ? "rtl" : null),
        renderHTML: (a: { dir?: string | null }) => (a.dir === "rtl" ? { dir: "rtl" } : {}),
      },
      /**
       * The next line of a list item that had a line break (see ParagraphFormat.cont): no glyph, and the
       * list goes on after it. A paragraph made from it with Enter sits in the list too, as in Docs
       */
      listCont: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.hasAttribute("data-cont") && !el.hasAttribute("data-list") ? true : null),
        renderHTML: (a: { listCont?: boolean | null; list?: string | null }) => (a.listCont && !a.list ? { "data-cont": "" } : {}),
      },
      /**
       * The line after a line break in the paragraph before (see breaksAsParagraphs): the editor's own
       * record, so typing treats it as the break it is drawn as and a copy gives other apps the break
       */
      /**
       * The look of an empty paragraph's newline (marks), from Docs: the line is as tall as its font and
       * size make it, and text typed there takes that look, as in Docs
       */
      nl: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          try {
            const v: unknown = JSON.parse(el.getAttribute("data-nl") ?? "null");
            return Array.isArray(v) && v.every((m) => m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string") ? v : null;
          } catch { return null; }
        },
        renderHTML: (a: { nl?: unknown[] | null }) => (Array.isArray(a.nl) && a.nl.length ? { "data-nl": JSON.stringify(a.nl) } : {}),
      },
      softBreak: {
        default: null,
        keepOnSplit: false,
        parseHTML: (el: HTMLElement) => (el.hasAttribute("data-br") ? true : null),
        renderHTML: (a: { softBreak?: boolean | null }) => (a.softBreak ? { "data-br": "" } : {}),
      },
      /** Exact indents and spacing of a paragraph read from Docs, in points */
      box: {
        default: null,
        parseHTML: (el: HTMLElement) => pastedBox(el),
        renderHTML: (a: { box?: { start?: number; first?: number; marker?: number; above?: number | null; below?: number | null } | null; list?: string | null; dir?: string | null }) => {
          const b = a.box;
          if (!b) return {};
          const css: string[] = [];
          if (a.list) {
            css.push(`--ss-li-start: ${b.start ?? 36}pt`, `--ss-li-marker: ${b.marker ?? -18}pt`);
            return { style: css.concat(b.above != null ? [`margin-top: ${b.above}pt`] : [], b.below != null ? [`margin-bottom: ${b.below}pt`] : []).join("; "), "data-box": "" };
          } else {
            if (b.start) css.push(`margin-${startSide(a.dir)}: ${b.start}pt`);
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
          const fromDocs = !!el.closest('[id^="docs-internal-guid-"]');
          const near = LINE_SPACINGS.find((s) => Math.abs(s.value - pct) <= (fromDocs ? 0.5 : 6));
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
        // Options of its own, even none, are data-keep; with none of its own the page reads its named style's
        renderHTML: (a: { keep?: KeepOptions | null }) => (a.keep ? { "data-keep": keepFlags(a.keep).join(" ") } : {}),
      },
      /** Docs' spacing mode of its own (see ParagraphFormat.spacingMode); the page reads it as data-sm */
      spacingMode: {
        default: null,
        parseHTML: () => null,
        renderHTML: (a: { spacingMode?: string | null }) => (a.spacingMode === "NEVER_COLLAPSE" ? { "data-sm": "never" } : a.spacingMode === "COLLAPSE_LISTS" ? { "data-sm": "collapse" } : {}),
      },
      borders: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.hasAttribute("data-spacing") ? null : pastedBorders(el)),
        renderHTML: (a: { borders?: Borders | null }) => (a.borders ? { style: bordersCss(a.borders).join("; "), ...(a.borders.between ? { "data-between": "" } : {}) } : {}),
      },
      shading: {
        default: null,
        parseHTML: (el: HTMLElement) => { if (el.hasAttribute("data-spacing")) return null; const c = cssColorToHex(el.getAttribute("data-shading") ?? el.style.backgroundColor); return c && c !== "#ffffff" ? c : null; },
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
          /**
           * A weighted font's weight (Light 300, Medium 500, SemiBold 600...), as Docs' weightedFontFamily
           * has it. 700 and above is bold (the bold mark), which Docs keeps separately.
           */
          fontWeight: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const w = fontWeightOf(el.style.fontWeight);
              return w && w < 700 ? w : w && w > 700 ? w : null;
            },
            renderHTML: (a: { fontWeight?: number | null }) => (a.fontWeight ? { style: `font-weight: ${a.fontWeight}`, "data-weight": String(a.fontWeight) } : {}),
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
const NO_LIST = { list: null, listId: null, level: null, glyph: null, preset: null, box: null, listCont: null };

/** Whether two list items are of one list: one Docs list, or a list made here in one Docs list style */
function sameList(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (!a.list || a.list !== b.list || (a.listId ?? null) !== (b.listId ?? null)) return false;
  return !!a.listId || presetOf(a as { list?: ListType; preset?: string }) === presetOf(b as { list?: ListType; preset?: string });
}

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
        const isLine = (p: { pos: number; node: typeof state.doc }) => !isList(p) && !!p.node.attrs.listCont;
        // The item past a list item's next lines (step -1 or 1), when it is in the same list: the items after
        // such lines are restyled too, as the list they are in
        const across = (k: number, step: number) => {
          let j = k + step;
          while (j >= 0 && j < paras.length && isLine(paras[j])) j += step;
          return j !== k + step && j >= 0 && j < paras.length && isList(paras[j]) && sameList(paras[j].node.attrs, paras[k].node.attrs) ? j : -1;
        };
        const hit = new Set<number>();
        paras.forEach((p, i) => {
          if (!inSel(p)) return;
          let at = i;
          // The caret on a list item's next line is in that item's list
          if (isLine(p)) { while (at > 0 && isLine(paras[at - 1])) at--; at -= 1; if (at < 0 || !isList(paras[at])) return; }
          else if (!isList(p)) return;
          let s = at;
          let e = at;
          for (;;) { if (s > 0 && isList(paras[s - 1])) s--; else { const j = across(s, -1); if (j < 0) break; s = j; } }
          for (;;) { if (e < paras.length - 1 && isList(paras[e + 1])) e++; else { const j = across(e, 1); if (j < 0) break; e = j; } }
          for (let k = s; k <= e; k++) if (isList(paras[k])) hit.add(k);
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
        if (allOn) {
          // Items that lose their bullets between two items of one list stay in it, as in Docs (its
          // deleteParagraphBullets keeps the list): the items after them count on
          const off = new Set(paras.map((p) => p.pos));
          const starts = new Map<PMNode, number[]>();
          for (const p of paras) {
            const $p = tr.doc.resolve(p.pos);
            const parent = $p.parent;
            const at = $p.index();
            let pos = starts.get(parent);
            if (!pos) { pos = []; let x = $p.start(); parent.forEach((c) => { pos!.push(x); x += c.nodeSize; }); starts.set(parent, pos); }
            // Paragraphs between items: other lines of theirs, and the ones losing their bullets now
            const plain = (i: number) => { const n = parent.child(i); return n.type.name === "paragraph" && !n.attrs.list && (!!n.attrs.listCont || off.has(pos![i])); };
            let b = at - 1;
            while (b >= 0 && plain(b)) b--;
            let a = at + 1;
            while (a < parent.childCount && plain(a)) a++;
            if (b >= 0 && a < parent.childCount && sameList(parent.child(b).attrs, parent.child(a).attrs)) tr.setNodeMarkup(p.pos, undefined, { ...tr.doc.nodeAt(p.pos)!.attrs, listCont: true });
          }
        }
        if (dispatch) dispatch(tr);
        return true;
      },
      setLineSpacing: (spacing) => updateParagraphs(() => ({ lineSpacing: spacing })),
      setDirection: (dir) => updateParagraphs((a) => {
        const next = dir === "rtl" ? "rtl" : null;
        if ((a.dir ?? null) === next) return {};
        const flip: Record<string, string> = { left: "right", right: "left" };
        return { dir: next, textAlign: typeof a.textAlign === "string" ? flip[a.textAlign] ?? a.textAlign : null };
      }),
      setParagraphSpace: (space) => updateParagraphs((a) => {
        // Exact spacing lives in the box; keep the paragraph's indents as they are
        const box = (a.box as { start?: number; first?: number; marker?: number; above?: number | null; below?: number | null } | null) ?? (a.list
          ? { start: 36, marker: -18 }
          : { start: stepsOf(a) * INDENT_PT, first: a.firstLine ? INDENT_PT : 0 });
        return { box: { ...box, above: space.above ?? box.above ?? null, below: space.below ?? box.below ?? null }, ...(a.list ? {} : { indent: 0, firstLine: false }) };
      }),
      // From the options the paragraph has (its own, else its style's); what its style gives needs no record
      setKeep: (keep) => updateParagraphs((a) => {
        const style = ((a.styleName as NamedStyle | null) ?? "normal") as NamedStyle;
        const keeps = docKeeps(this.editor.view.dom);
        const next = canonicalKeep({ ...effectiveKeep(a.keep as KeepOptions | null, style, keeps), ...keep });
        return { keep: sameKeep(next, namedKeep(style, keeps)) ? null : next };
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
          .command(updateParagraphs(() => ({ indent: 0, firstLine: false, lineSpacing: 115, textAlign: null, ...NO_LIST, box: null, indentEnd: null, keep: null, borders: null, shading: null, spacingMode: null })))
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
 * including at the end of the copy; other pages get one from the browser
 * after the copied content. Each of Docs' becomes an empty paragraph (which
 * syncs as a new line); the browser's trailing one is dropped.
 */
export function pastedEmptyLines(html: string): string {
  if (typeof DOMParser === "undefined" || !/<br\b/i.test(html)) return html;
  const fromDocs = /id="docs-internal-guid-/.test(html);
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const br of Array.from(doc.querySelectorAll("br"))) {
    const parent = br.parentElement;
    if (!parent) continue;
    const BLOCK = "p, h1, h2, h3, h4, h5, h6, div, ul, ol, table, blockquote";
    const blocks = Array.from(parent.children).some((c) => c.matches(BLOCK) || c.querySelector(BLOCK));
    if (!blocks) continue; // a line break inside a paragraph
    const last = !br.nextElementSibling && !(br.nextSibling?.textContent ?? "").trim();
    if ((last && !fromDocs) || br.classList.contains("Apple-interchange-newline")) br.remove();
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
  type Item = { p: HTMLElement; level: number; glyph: Glyph | null };
  const lengthPt = (v: string | null | undefined) => (v ? cssLengthToPt(v) ?? null : null);
  // `outer`: how far the enclosing lists inset their items, in points, when they all say (Docs' copies do)
  const flatten = (list: Element, depth: number, out: (Element | Item)[], outer: number | null) => {
    const type = list.tagName === "OL" ? "ordered" : "bullet";
    const pad = lengthPt((list as HTMLElement).style.paddingInlineStart || (list as HTMLElement).style.paddingLeft);
    const inset = outer != null && pad != null ? outer + pad : null;
    for (const child of Array.from(list.children)) {
      if (child.tagName === "OL" || child.tagName === "UL") { flatten(child, depth + 1, out, inset); continue; }
      if (child.tagName !== "LI") { out.push(child); continue; }
      const li = child as HTMLElement;
      const nested = Array.from(li.children).filter((c) => c.tagName === "OL" || c.tagName === "UL");
      nested.forEach((n) => n.remove());
      // A Docs checklist item: the tick is an image of the box, and "checked" is drawn as a line through the text
      const checkbox = li.getAttribute("role") === "checkbox";
      for (const img of Array.from(li.querySelectorAll('img[aria-roledescription="checkbox"]'))) img.remove();
      if (checkbox && li.getAttribute("aria-checked") === "true") {
        for (const el of [li, ...Array.from(li.querySelectorAll<HTMLElement>("[style]"))]) {
          const d = el.style.textDecorationLine || el.style.textDecoration;
          if (/line-through/.test(d)) el.style.textDecoration = d.replace(/line-through/g, "").trim() || "none";
        }
      }
      const inner = li.children.length === 1 && li.firstElementChild?.tagName === "P" ? (li.firstElementChild as HTMLElement) : null;
      const p = doc.createElement("p");
      // The item's own paragraph keeps what it says about itself (SyncStream's copies say a lot)
      for (const a of Array.from(inner?.attributes ?? [])) if (a.name !== "role" && a.name !== "style") p.setAttribute(a.name, a.value);
      const style = [li.getAttribute("style"), inner?.getAttribute("style")].filter(Boolean).join("; ");
      if (style) p.setAttribute("style", style);
      // A right-to-left item: its insets are on the right
      const rtl = isRtl(li) || isRtl(inner);
      if (rtl) p.setAttribute("dir", "rtl");
      if (li.hasAttribute("aria-level") && !p.hasAttribute("data-box")) {
        // Docs' copy: the lists inset the item (48px a level) and the item's margin moves its glyph,
        // its padding the text: glyph at inset + margin - 18pt, text at inset + margin + padding
        if (inset != null) {
          const ml = lengthPt(rtl ? li.style.marginRight : li.style.marginLeft) ?? 0;
          const pl = lengthPt(rtl ? li.style.paddingRight : li.style.paddingLeft) ?? 0;
          // A checklist's box is drawn as an image before the text (17.6px + 3px), not as a marker
          const start = inset + ml + pl + (checkbox ? 15 : 0);
          const glyph = checkbox ? start - 18 : inset + ml - 18;
          p.style.setProperty("--ss-li-start", `${start}pt`);
          p.style.setProperty("--ss-li-marker", `${glyph - start}pt`);
        }
        // The item's own style is its glyph's (Docs' bullet style); a highlight never shows there
        if (!p.hasAttribute("data-glyph-style")) {
          const g: Record<string, unknown> = {};
          const font = cssFontToFamily(li.style.fontFamily);
          if (font) g.font = font;
          const size = lengthPt(li.style.fontSize);
          if (size) g.size = roundSize(size);
          const color = cssColorToHex(li.style.color);
          if (color) g.color = color;
          const w = fontWeightOf(li.style.fontWeight);
          if (w && w >= 700) g.b = 1; else if (w && w !== 400) g.w = w;
          if (li.style.fontStyle === "italic") g.i = 1;
          if (Object.keys(g).length) p.setAttribute("data-glyph-style", JSON.stringify(g));
        }
      }
      const aria = parseInt(li.getAttribute("aria-level") ?? "", 10);
      const level = p.hasAttribute("data-level") ? parseInt(p.getAttribute("data-level")!, 10) || 0 : Number.isFinite(aria) ? Math.max(0, aria - 1) : depth;
      if (level > 0) p.setAttribute("data-level", String(level));
      if (!p.hasAttribute("data-list")) {
        p.setAttribute("data-list", li.getAttribute("role") === "checkbox" || li.querySelector("input[type=checkbox]") ? "check" : type);
        p.setAttribute("data-pasted-list", "");
      }
      p.innerHTML = inner ? inner.innerHTML : li.innerHTML.replace(/^\s*<p[^>]*>|<\/p>\s*$/gi, "");
      out.push({ p, level, glyph: glyphOfListStyle(li.style.listStyleType || (li.parentElement as HTMLElement | null)?.style.listStyleType || "", type) });
      for (const n of nested) flatten(n, depth + 1, out, inset);
    }
  };
  const top = Array.from(doc.querySelectorAll("ol, ul")).filter((l) => !l.parentElement?.closest("ol, ul"));
  // The last numbered list: its last element and the number its last top-level item shows
  let numbered: { end: Element; count: number; preset: string | null } | null = null;
  for (const list of top) {
    const out: (Element | Item)[] = [];
    flatten(list, 0, out, 0);
    // A list pasted from elsewhere is drawn in the Docs list style closest to its glyphs, as Docs would make it
    const items = out.filter((x): x is Item => !(x instanceof Element));
    // A checklist has one Docs style (its items have no glyph to match)
    for (const i of items) if (i.p.getAttribute("data-list") === "check" && !i.p.hasAttribute("data-preset")) i.p.setAttribute("data-preset", "BULLET_CHECKBOX");
    for (const kind of ["bullet", "ordered"]) {
      const own = items.filter((i) => i.p.getAttribute("data-list") === kind && !i.p.hasAttribute("data-preset"));
      if (!own.length) continue;
      const levels: (Glyph | null)[] = [];
      const weights: number[] = [];
      for (const i of own) { levels[i.level] ??= i.glyph; weights[i.level] = (weights[i.level] ?? 0) + 1; }
      if (!levels.some(Boolean)) continue;
      const preset = presetForLevels(kind, levels, weights);
      for (const i of own) i.p.setAttribute("data-preset", preset);
    }
    for (const el of out) list.parentNode?.insertBefore(el instanceof Element ? el : el.p, list);
    list.remove();
    if (list.tagName !== "OL") continue;
    // Docs copies one list with paragraphs between its items as lists that start where the one before
    // left off (<ol start="3">): those paragraphs are the list's next lines, so it counts on, here and
    // in the doc the sync makes (see markListLines)
    const top0 = items.filter((i) => i.level === 0 && i.p.getAttribute("data-list") === "ordered");
    if (!top0.length) continue;
    const preset = top0[0].p.getAttribute("data-preset");
    const start = parseInt(list.getAttribute("start") ?? "", 10);
    let count = top0.length;
    if (numbered && start > 1 && start === numbered.count + 1 && numbered.preset === preset) {
      const first = out[0] instanceof Element ? out[0] : out[0].p;
      const between: Element[] = [];
      let el = numbered.end.nextElementSibling;
      while (el && el !== first && /^(P|H[1-6])$/.test(el.tagName) && !el.hasAttribute("data-list")) { between.push(el); el = el.nextElementSibling; }
      if (el === first) {
        for (const b of between) b.setAttribute("data-cont", "");
        count += numbered.count;
      }
    }
    const last = out[out.length - 1];
    numbered = { end: last instanceof Element ? last : last.p, count, preset };
  }
  return doc.body.innerHTML;
}

/** What a CSS list-style-type draws, as a Docs list glyph */
function glyphOfListStyle(type: string, kind: string): Glyph | null {
  const t = type.trim().toLowerCase();
  const symbol: Record<string, string> = { disc: "●", circle: "○", square: "■" };
  const numbered: Record<string, string> = { decimal: "DECIMAL", "decimal-leading-zero": "ZERO_DECIMAL", "lower-alpha": "ALPHA", "lower-latin": "ALPHA", "upper-alpha": "UPPER_ALPHA", "upper-latin": "UPPER_ALPHA", "lower-roman": "ROMAN", "upper-roman": "UPPER_ROMAN" };
  if (symbol[t]) return { symbol: symbol[t] };
  if (numbered[t]) return { type: numbered[t], format: null };
  // A string glyph: list-style-type: "❖ "
  const quoted = /^["'](.+?)\s*["']$/.exec(type.trim());
  if (quoted) return { symbol: quoted[1] };
  return kind === "bullet" && !t ? null : null;
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
        parseHTML: (el: HTMLElement) => cssColorToHex(el.getAttribute("data-bg") ?? el.style.backgroundColor) ?? null,
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

/**
 * Bold as Docs reads it: a weight of 700 or more. Lighter weights (Medium 500,
 * SemiBold 600) are the font's own weight, not bold. No Markdown shortcuts:
 * Docs doesn't turn **text** into bold by default, typed or pasted.
 */
const DocBold = Mark.create({
  name: "bold",
  parseHTML() {
    const heavy = (v: string) => /^(bold(er)?)$/i.test(v.trim()) || (/^\d{3}$/.test(v.trim()) && parseInt(v, 10) >= 700);
    return [
      { tag: "strong", getAttrs: (node: HTMLElement) => (node.style.fontWeight && !heavy(node.style.fontWeight) ? false : null) },
      { tag: "b", getAttrs: (node: HTMLElement) => (node.style.fontWeight && !heavy(node.style.fontWeight) ? false : null) },
      // Docs wraps everything it copies in <b style="font-weight:normal">; a lighter weight clears bold
      { style: "font-weight", clearMark: (mark) => mark.type.name === "bold", getAttrs: (v: string | HTMLElement) => (typeof v === "string" && !heavy(v) ? null : false) },
      { style: "font-weight", getAttrs: (v: string | HTMLElement) => (typeof v === "string" && heavy(v) ? null : false) },
    ];
  },
  renderHTML: () => ["strong", 0],
  addCommands() {
    return {
      setBold: () => ({ commands }) => commands.setMark(this.name),
      toggleBold: () => ({ commands }) => commands.toggleMark(this.name),
      unsetBold: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-b": () => this.editor.commands.toggleBold(), "Mod-B": () => this.editor.commands.toggleBold() };
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
      const [, attrs, ...inner] = spec as [string, Record<string, string>, ...unknown[]];
      // The text's own span is the page's (see DocParagraph): a copy has the text right in the paragraph
      const rest = inner.map((c) => (Array.isArray(c) && c[0] === "span" && (c[1] as { class?: string })?.class === "ss-text" ? 0 : c));
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
        // Top-level items of the open numbered list, and of the one a list item's next line goes on from
        let shown = 0;
        let carried = 0;
        let lastItem: Record<string, unknown> | null = null;
        // The last paragraph written, which a line after a line break goes back into
        let lastBlock: HTMLElement | null = null;
        fragment.forEach((node) => {
          // The line after a line break (see breaksAsParagraphs) is the break in the paragraph before, for
          // other apps (Docs pastes it as one), with the space below it had
          if (node.type.name === "paragraph" && node.attrs.softBreak && lastBlock) {
            const el = serializer.serializeNode(node, options) as HTMLElement;
            lastBlock.appendChild(doc.createElement("br"));
            while (el.firstChild) lastBlock.appendChild(el.firstChild);
            const below = (node.attrs.box as { below?: number | null } | null)?.below;
            if (typeof below === "number") lastBlock.style.marginBottom = `${below}pt`;
            return;
          }
          if (node.type.name === "paragraph" && node.attrs.list) {
            const level = Math.max(0, Number(node.attrs.level ?? 0));
            const tag = node.attrs.list === "ordered" ? "ol" : "ul";
            stack = stack.slice(0, level + 1);
            for (let i = stack.length; i <= level; i++) {
              const list = doc.createElement(i === level ? tag : "ul");
              // A list that goes on after its next lines starts where it left off, as Docs copies it
              if (i === 0) {
                shown = carried && lastItem && sameList(lastItem, node.attrs) ? carried : 0;
                if (shown && tag === "ol") list.setAttribute("start", String(shown + 1));
              }
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
              if (level === 0) shown = 0;
            }
            const li = doc.createElement("li");
            li.setAttribute("aria-level", String(level + 1));
            if (node.attrs.list === "check") li.setAttribute("role", "checkbox");
            const el = serializer.serializeNode(node, options);
            li.appendChild(el);
            lastBlock = el instanceof HTMLElement ? el : null;
            stack[level].appendChild(li);
            if (level === 0 && tag === "ol") { shown++; lastItem = node.attrs; }
            carried = 0;
          } else {
            // A list item's next line: the numbered list goes on after it
            if (node.type.name === "paragraph" && node.attrs.listCont) { if (stack[0]?.tagName.toLowerCase() === "ol") carried = shown; }
            else carried = 0;
            stack = [];
            const el = serializer.serializeNode(node, options);
            out.appendChild(el);
            lastBlock = node.type.name === "paragraph" && el instanceof HTMLElement ? el : null;
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
    paragraph: false, heading: false, blockquote: false, codeBlock: false, code: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, horizontalRule: false, bold: false,
    link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer", target: null } },
  }),
  DocParagraph,
  DocBold,
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
  LinkLook,
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
    bold: false,
    link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer", target: null } },
  }),
  DocParagraph,
  DocBold,
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
  DocsLineBreaks,
  LinkLook,
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
  // A transparent background (Docs spells it out on every run, browsers' copies as rgba(…, 0)) is none of
  // its own: an inline parent's highlight still shows through it
  out.backgroundColor = set(s.backgroundColor) && !/^transparent$|rgba\([^)]*,\s*0(\.0+)?\s*\)$/i.test(s.backgroundColor) ? s.backgroundColor : undefined;
  out.fontWeight = set(s.fontWeight) ?? out.fontWeight;
  out.fontStyle = set(s.fontStyle) ?? out.fontStyle;
  out.textDecoration = set(s.textDecorationLine || s.textDecoration) ?? out.textDecoration;
  const va = set(s.verticalAlign);
  if (va === "super" || va === "sub") out.verticalAlign = va;
  return out;
}

/** A CSS colour as the canvas reads it: "#rrggbb" (or rgba() with transparency) */
function canvasColor(v: string): string {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return v;
    ctx.fillStyle = "#010203";
    ctx.fillStyle = v;
    // An unknown colour leaves the canvas's as it was
    return ctx.fillStyle === "#010203" && !/^#010203$/i.test(v.trim()) ? v : ctx.fillStyle;
  } catch { return v; }
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
  const BLOCK = /^(P|H[1-6]|LI|UL|OL|DIV|TD|TH|TR|TBODY|TABLE|BLOCKQUOTE|BODY)$/;
  // Colours as rgb(): a named colour ("red") or hsl() reads like any other
  const rgb = (v: string | undefined) => (!v || /^(#|rgb)/i.test(v) || v === "transparent" ? v : canvasColor(v));
  for (const text of texts) {
    if (!text.data || !text.parentElement) continue;
    // Whitespace between blocks isn't text anyone sees
    if (!text.data.trim() && /^(BODY|DIV|UL|OL|TABLE|TBODY|TR)$/.test(text.parentElement.tagName)) continue;
    const style: InlineStyle = {};
    let scale = 1;
    for (let el: HTMLElement | null = text.parentElement; el && el !== doc.body; el = el.parentElement) {
      const own = ownStyle(el);
      // A paragraph's or cell's background is its shading, not the text's highlight
      if (BLOCK.test(el.tagName)) own.backgroundColor = undefined;
      // A relative size scales the size it inherits; Docs draws super- and subscript at 0.6em, which is
      // the offset's look, not the text's size
      if (own.fontSize && /(em|%)\s*$/.test(own.fontSize)) {
        const offset = own.verticalAlign === "super" || own.verticalAlign === "sub" || el.tagName === "SUP" || el.tagName === "SUB";
        if (style.fontSize == null && !offset) scale *= parseFloat(own.fontSize) / (/%\s*$/.test(own.fontSize) ? 100 : 1);
        own.fontSize = undefined;
      }
      for (const k of keys) if (style[k] == null && own[k] != null) style[k] = own[k];
      // A link with no colour or underline of its own (from inside it) looks as a link does: Docs'
      // copies always say how theirs look; other pages' bare links get the look Docs gives a new link
      if (el.tagName === "A" && el.hasAttribute("href")) {
        style.color ??= LINK_COLOR;
        style.textDecoration ??= "underline";
      }
    }
    if (style.fontSize && scale !== 1) { const pt = cssLengthToPt(style.fontSize); if (pt) style.fontSize = `${Math.round(pt * scale * 10) / 10}pt`; }
    style.color = rgb(style.color);
    style.backgroundColor = rgb(style.backgroundColor);
    const decl = keys.filter((k) => style[k] != null).map((k) => `${css[k]}: ${style[k]}`).join("; ");
    if (!decl) continue;
    const span = doc.createElement("span");
    span.setAttribute("style", decl);
    text.replaceWith(span);
    span.appendChild(text);
  }
  // A paragraph's or a cell's background is its shading: kept for the paragraph (or cell), and taken
  // out of its style so the highlight rule doesn't paint its text with it
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("p[style], h1[style], h2[style], h3[style], h4[style], h5[style], h6[style], li[style], td[style], th[style]"))) {
    const bg = el.style.backgroundColor;
    if (!bg) continue;
    el.setAttribute(/^T[DH]$/.test(el.tagName) ? "data-bg" : "data-shading", bg);
    el.style.removeProperty("background-color");
  }
  return doc.body.innerHTML;
}
