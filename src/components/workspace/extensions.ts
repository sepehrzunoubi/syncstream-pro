import { Extension, InputRule, type Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { Pagination } from "./pagination";
import TextAlign from "@tiptap/extension-text-align";
import {
  cssFontToFamily,
  cssLengthToPt,
  cssLineHeight,
  fontStack,
  INDENT_PT,
  LINE_SPACINGS,
  MAX_INDENT,
  NAMED_STYLES,
  roundSize,
  type ListType,
  type NamedStyle,
} from "@/lib/rich-text";

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
      clearFormatting: () => ReturnType;
      toggleList: (type: ListType) => ReturnType;
    };
  }
}

const TAG_STYLE: Record<string, NamedStyle> = { H1: "h1", H2: "h2", H3: "h3", H4: "h3", H5: "h3", H6: "h3" };

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
          return TAG_STYLE[el.tagName] ?? "normal";
        },
        renderHTML: (a: { styleName?: string }) => (a.styleName && a.styleName !== "normal" ? { "data-style": a.styleName } : {}),
      },
      indent: {
        default: 0,
        parseHTML: (el: HTMLElement) => {
          const data = el.getAttribute("data-indent");
          if (data) return Math.min(MAX_INDENT, Math.max(0, parseInt(data, 10) || 0));
          const pt = cssLengthToPt(el.style.marginLeft) ?? cssLengthToPt(el.style.paddingLeft) ?? 0;
          return Math.min(MAX_INDENT, Math.max(0, Math.round(pt / INDENT_PT)));
        },
        renderHTML: (a: { indent?: number }) =>
          a.indent ? { "data-indent": String(a.indent), style: `margin-left: ${(a.indent * INDENT_PT) / 72}in` } : {},
      },
      firstLine: {
        default: false,
        parseHTML: (el: HTMLElement) => el.hasAttribute("data-first-line") || (cssLengthToPt(el.style.textIndent) ?? 0) > 1,
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
      lineSpacing: {
        default: 115,
        parseHTML: (el: HTMLElement) => {
          const data = el.getAttribute("data-spacing");
          if (data) return parseInt(data, 10) || 115;
          const lh = parseFloat(el.style.lineHeight);
          if (!Number.isFinite(lh) || /px|pt|%/.test(el.style.lineHeight)) return 115;
          const pct = (lh / 1.2) * 100;
          const near = LINE_SPACINGS.find((s) => Math.abs(s.value - pct) <= 6);
          return near ? near.value : Math.max(50, Math.min(500, Math.round(pct)));
        },
        renderHTML: (a: { lineSpacing?: number }) => {
          const v = a.lineSpacing ?? 115;
          return { "data-spacing": String(v), style: `line-height: ${cssLineHeight(v)}` };
        },
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
            renderHTML: (a: { fontFamily?: string | null }) => (a.fontFamily ? { style: `font-family: ${fontStack(a.fontFamily)}` } : {}),
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
      indent: () => updateParagraphs((a) => (a.list ? {} : { indent: Math.min(MAX_INDENT, ((a.indent as number) ?? 0) + 1) })),
      outdent: () => updateParagraphs((a) => (a.list ? {} : { indent: Math.max(0, ((a.indent as number) ?? 0) - 1) })),
      setFirstLine: (on) => updateParagraphs((a) => (a.list ? {} : { firstLine: on })),
      toggleList: (type) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection;
        const paras: { pos: number; attrs: Record<string, unknown> }[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === "paragraph") paras.push({ pos, attrs: node.attrs });
        });
        const allOn = paras.length > 0 && paras.every((p) => p.attrs.list === type);
        for (const p of paras) {
          tr.setNodeMarkup(p.pos, undefined, allOn ? { ...p.attrs, list: null } : { ...p.attrs, list: type, indent: 0, firstLine: false });
        }
        if (dispatch) dispatch(tr);
        return true;
      },
      setLineSpacing: (spacing) => updateParagraphs(() => ({ lineSpacing: spacing })),
      clearFormatting: () => ({ chain }) =>
        chain()
          .unsetAllMarks()
          .command(updateParagraphs(() => ({ indent: 0, firstLine: false, lineSpacing: 115, textAlign: null, list: null })))
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
        if (inEmptyListItem(editor)) return editor.commands.updateAttributes("paragraph", { list: null });
        return false;
      },
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        const parent = selection.$from.parent;
        if (selection.empty && selection.$from.parentOffset === 0 && parent.attrs.list) {
          return editor.commands.updateAttributes("paragraph", { list: null });
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
          return attrs.firstLine ? editor.commands.indent() : editor.commands.setFirstLine(true);
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
    };
  },
});

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
  Highlight.configure({ multicolor: true }),
  DocImage,
  TextAlign.configure({ types: ["paragraph"], alignments: ["left", "center", "right", "justify"] }),
  DocFormat,
  Pagination,
];
