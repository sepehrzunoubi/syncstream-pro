import { Extension, type Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import { TextStyle } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import { Placeholder } from "@tiptap/extensions";
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
      indent: () => updateParagraphs((a) => ({ indent: Math.min(MAX_INDENT, ((a.indent as number) ?? 0) + 1) })),
      outdent: () => updateParagraphs((a) => ({ indent: Math.max(0, ((a.indent as number) ?? 0) - 1) })),
      setFirstLine: (on) => updateParagraphs(() => ({ firstLine: on })),
      setLineSpacing: (spacing) => updateParagraphs(() => ({ lineSpacing: spacing })),
      clearFormatting: () => ({ chain }) =>
        chain()
          .unsetAllMarks()
          .command(updateParagraphs(() => ({ indent: 0, firstLine: false, lineSpacing: 115, textAlign: null })))
          .run(),
    };
  },
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        const { selection } = editor.state;
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
 * Lists are not supported in the Docs output, so pasted lists become plain
 * paragraphs that keep their bullet or number as text.
 */
export function flattenPastedLists(html: string): string {
  if (typeof DOMParser === "undefined" || !/<(ol|ul)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let list = doc.querySelector("ol, ul");
  let guard = 0;
  while (list && guard++ < 500) {
    let n = parseInt(list.getAttribute("start") ?? "1", 10) || 1;
    const ordered = list.tagName === "OL";
    for (const li of Array.from(list.children).filter((c) => c.tagName === "LI")) {
      const p = doc.createElement("p");
      const style = li.getAttribute("style");
      if (style) p.setAttribute("style", style);
      p.innerHTML = `${ordered ? `${n++}. ` : "• "}${li.innerHTML}`;
      list.parentNode?.insertBefore(p, list);
    }
    list.remove();
    list = doc.querySelector("ol, ul");
  }
  return doc.body.innerHTML;
}

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
    link: false,
  }),
  DocParagraph,
  TextStyle,
  FontAttributes,
  TextAlign.configure({ types: ["paragraph"], alignments: ["left", "center", "right", "justify"] }),
  DocFormat,
  Placeholder.configure({ placeholder: "Type or paste your text" }),
];
