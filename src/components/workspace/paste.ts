/**
 * Pasting into the body editor: image files are uploaded, formatted
 * paragraphs keep their own formatting as Docs does, and plain text takes
 * the formatting of the paragraph it lands in.
 *
 * A copy from Google Docs is pasted from Docs' own copy of the selection
 * (see docs-slice.ts), exactly as Docs pastes it into another document;
 * its HTML is the fallback, then other HTML, then plain text.
 */

import { Fragment, Slice, type Mark, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { namedStyleText, type DocDefaults } from "@/lib/doc-import";
import { DOCS_SLICE_TYPE, readDocsSlice, sliceParagraphs } from "@/lib/docs-slice";
import { cssColorToHex, cssFontToFamily, DEFAULT_FONT, NAMED_STYLES, type NamedStyle } from "@/lib/rich-text";
import { flattenPastedLists, inlinePastedStyles, pastedEmptyLines } from "./extensions";

export const imageFilesOf = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

export const transformPastedHTML = (html: string) => inlinePastedStyles(flattenPastedLists(pastedEmptyLines(html)));

/** HTML Google Docs put on the clipboard */
export const isDocsHTML = (html: string) => /id="docs-internal-guid-/.test(html);

/** The destination document's named styles, as the workspace shows them (see use-page-setup) */
function destinationDefaults(view: EditorView): DocDefaults {
  try {
    const raw = (view.dom as HTMLElement).dataset.docDefaults;
    if (raw) return JSON.parse(raw) as DocDefaults;
  } catch { /* not set yet */ }
  return { fontFamily: DEFAULT_FONT, fontSize: NAMED_STYLES.normal.size, lineSpacing: 115, styles: {} };
}

/**
 * Text moved from a paragraph of one style into one of another keeps how it
 * looks: its font, size and colour, its own or its old style's, are marks
 * unless the new style gives them. Highlights and colours are kept as hex.
 * With the same style on both sides this only drops marks that repeat what
 * the style gives (pasted HTML spells every value out).
 */
export function restyleText(content: Fragment, from: NamedStyle, to: NamedStyle, defaults: DocDefaults): Fragment {
  const was = namedStyleText(defaults, from);
  const now = namedStyleText(defaults, to);
  const nodes: PMNode[] = [];
  content.forEach((node) => {
    if (!node.isText) { nodes.push(node); return; }
    const schema = node.type.schema;
    const ts = node.marks.find((m) => m.type.name === "textStyle");
    const a = (ts?.attrs ?? {}) as Record<string, unknown>;
    const weight = a.fontWeight ?? null;
    const font = (typeof a.fontFamily === "string" ? cssFontToFamily(a.fontFamily) : undefined) ?? was.font;
    const size = typeof a.fontSize === "number" ? a.fontSize : was.size;
    const color = (typeof a.color === "string" ? cssColorToHex(a.color) : undefined) ?? was.color;
    const next = { ...a, fontFamily: font !== now.font || weight ? font : null, fontSize: size !== now.size ? size : null, color: color !== now.color ? color : null, fontWeight: weight };
    let marks: readonly Mark[] = node.marks.filter((m) => m.type.name !== "textStyle").flatMap((m) => {
      if (m.type.name !== "highlight") return [m];
      const hex = typeof m.attrs.color === "string" ? cssColorToHex(m.attrs.color) : "#ffff00";
      return hex ? [m.type.create({ ...m.attrs, color: hex })] : [];
    });
    if (Object.values(next).some((v) => v != null)) marks = schema.marks.textStyle.create(next).addToSet(marks);
    nodes.push(node.mark(marks));
  });
  return Fragment.from(nodes);
}

const styleOf = (p: PMNode) => ((p.attrs.styleName as NamedStyle | undefined) ?? "normal") as NamedStyle;

/**
 * Put pasted paragraphs where the selection is, the way Docs does. In Docs
 * a paragraph's format belongs to its newline: the paragraph the paste
 * starts in takes the format of the first pasted paragraph (its newline is
 * the pasted one), and the text after the selection stays in its own
 * paragraph with its own format, even when there is none: a copy that ends
 * with a paragraph's newline leaves the paragraph it went into after it,
 * as Docs does (Ctrl+A of a document that ends with an empty paragraph,
 * pasted into an empty one, comes out the same paragraph for paragraph).
 * A copy whose last paragraph is partly copied, pasted over whole
 * paragraphs (or into an empty one), replaces them: that last paragraph
 * keeps its own format.
 *
 * Only pasted content is inserted: text already there is left in place (it
 * would otherwise count as an addition and be typed into the Doc again).
 * The text goes in as copied: no paste rules, and no URL turned into a link
 * that wasn't one. False when the selection isn't plain paragraphs side by side.
 *
 * `endKnown` is false when the copy can't say whether its last paragraph's
 * newline was copied (HTML: Docs' text/plain ends with a newline whenever
 * a copy spans paragraphs). Pasted into an empty paragraph (or over whole
 * ones), such a copy replaces them, its last paragraph in its own format,
 * whichever it was.
 */
export function insertParagraphs(view: EditorView, paragraphs: PMNode[], endsWithParagraph: boolean, defaults = destinationDefaults(view), endKnown = true): boolean {
  const { state } = view;
  const { $from, $to } = state.selection;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraphs.length || paragraphs.some((p) => p.type !== paragraph)) return false;
  if ($from.parent.type !== paragraph || $to.parent.type !== paragraph || $from.depth !== $to.depth || $from.node(-1) !== $to.node(-1)) return false;
  let locked = false;
  state.doc.nodesBetween($from.before(), $to.after(), (n) => { if (n.attrs.locked) locked = true; return !locked; });
  if (locked) return false;

  const complete = endsWithParagraph ? paragraphs : paragraphs.slice(0, -1);
  const tail = endsWithParagraph ? null : paragraphs[paragraphs.length - 1];
  const tr = state.tr;
  try {
    // A partly copied last paragraph that joins text already there takes that paragraph's format
    const joined = tail ? restyleText(tail.content, styleOf(tail), styleOf($to.parent), defaults) : Fragment.empty;
    if (!complete.length) {
      // Text within one paragraph: the paragraph keeps its own format
      tr.replaceSelection(new Slice(joined, 0, 0));
    } else if ((tail || !endKnown) && $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size) {
      // Nothing of the paragraphs pasted over is left: a last, partly copied paragraph keeps its own format
      const out = tail ? [...complete, tail] : complete;
      const start = $from.before();
      tr.replaceWith(start, $to.after(), out);
      const end = start + out.reduce((n, p) => n + p.nodeSize, 0) - 1;
      tr.setSelection(TextSelection.create(tr.doc, end));
    } else {
      const own = $to.parent.attrs;
      const from = $from.pos;
      tr.deleteSelection();
      const at = tr.mapping.map(from, -1);
      const parts = [...complete, paragraph.create(null, joined)];
      tr.replace(at, at, new Slice(Fragment.from(parts), 1, 1));
      // The paragraph the paste began in now ends with the first pasted newline; the last keeps its own
      const $start = tr.doc.resolve(at);
      const firstPos = $start.before();
      tr.setNodeMarkup(firstPos, undefined, complete[0].attrs);
      let pos = firstPos;
      for (let k = 0; k < parts.length - 1; k++) pos += tr.doc.nodeAt(pos)!.nodeSize;
      tr.setNodeMarkup(pos, undefined, own);
      tr.setSelection(TextSelection.create(tr.doc, pos + 1 + (tail?.content.size ?? 0)));
    }
  } catch (err) {
    console.error("Couldn't paste these paragraphs as Docs would:", err);
    return false;
  }
  view.dispatch(tr.scrollIntoView().setMeta("paste", true).setMeta("preventAutolink", true));
  return true;
}

/**
 * Copies put non-breaking spaces in their HTML where the text has ordinary
 * ones (Docs does, to keep runs of spaces). The clipboard's text/plain has
 * the real characters: where the pasted paragraphs read the same as it, each
 * non-breaking space the text has as a space becomes one again. When the two
 * don't line up, the paragraphs are left as they are.
 */
export function plainSpaces(paragraphs: PMNode[], plain: string): PMNode[] {
  const text = plain.replace(/\r\n?/g, "\n");
  let at = 0;
  let changed = false;
  const fixed: { node: PMNode; content: PMNode[] | null }[] = [];
  for (let k = 0; k < paragraphs.length; k++) {
    const p = paragraphs[k];
    if (k > 0) {
      if (text[at] !== "\n") return paragraphs;
      at++;
    }
    let own: PMNode[] | null = null;
    const parts: PMNode[] = [];
    let ok = true;
    p.forEach((child) => {
      if (!ok) return;
      if (!child.isText) {
        // A line break reads as a newline; anything else (an image) as one character
        if (child.type.name === "hardBreak") { if (text[at] !== "\n" && text[at] !== "\u000b") ok = false; }
        at++;
        parts.push(child);
        return;
      }
      const t = child.text ?? "";
      let out = "";
      for (const ch of t) {
        const want = text[at++];
        if (ch === want) out += ch;
        else if (ch === "\u00a0" && want === " ") out += " ";
        else { ok = false; return; }
      }
      if (out !== t) { own = parts; changed = true; parts.push(child.type.schema.text(out, child.marks)); }
      else parts.push(child);
    });
    if (!ok) return paragraphs;
    fixed.push({ node: p, content: own ? parts : null });
  }
  if (text.slice(at).replace(/\n/g, "") !== "" || !changed) return paragraphs;
  return fixed.map(({ node, content }) => (content ? node.copy(Fragment.from(content)) : node));
}

export function handlePaste(view: EditorView, event: ClipboardEvent, slice: Slice, onImageFiles: (files: File[]) => void): boolean {
  const data = event.clipboardData;
  const files = imageFilesOf(data?.files);
  if (files.length) {
    event.preventDefault();
    onImageFiles(files);
    return true;
  }
  // Paste without formatting: plain text takes the destination's formatting, as in Docs
  if ((view as unknown as { input: { shiftKey: boolean } }).input.shiftKey) return false;
  const plain = data?.getData("text/plain") ?? "";

  // A copy from Google Docs: Docs' own copy of it, read exactly
  const raw = data?.types.includes(DOCS_SLICE_TYPE) ? data.getData(DOCS_SLICE_TYPE) : "";
  if (raw) {
    try {
      const copied = readDocsSlice(raw, plain);
      if (copied) {
        const schema = view.state.schema;
        const nodes = sliceParagraphs(copied, destinationDefaults(view)).map((n) => schema.nodeFromJSON(n));
        if (insertParagraphs(view, nodes, copied.endsWithParagraph)) {
          event.preventDefault();
          return true;
        }
      }
    } catch (err) {
      console.error("Couldn't read the Google Docs copy; pasting its HTML:", err);
    }
  }

  if (!data?.types.includes("text/html")) return false;
  const first = slice.content.firstChild;
  if (first?.type.name !== "paragraph") return false;
  const parsed: PMNode[] = [];
  slice.content.forEach((n) => parsed.push(n));
  // Values that repeat what each paragraph's style gives aren't formatting of their own
  const defaults = destinationDefaults(view);
  const paragraphs = plainSpaces(parsed, plain).map((p) => (p.type.name === "paragraph" ? p.copy(restyleText(p.content, styleOf(p), styleOf(p), defaults)) : p));
  // Docs' HTML: paragraphs go in as Docs pastes them. Whether the last newline was copied is the
  // slice's to say: its text ends with one whenever the copy spans paragraphs
  if (isDocsHTML(data.getData("text/html")) && insertParagraphs(view, paragraphs, /\n$/.test(plain.replace(/\r\n?/g, "\n")), defaults, false)) {
    event.preventDefault();
    return true;
  }
  // Other formatted paragraphs pasted into an empty one (or over whole paragraphs) keep their own
  // formatting, as Docs does; ProseMirror would merge the first into the paragraph being replaced
  const { $from, $to } = view.state.selection;
  const wholeParagraphs = $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size;
  if (wholeParagraphs && slice.openStart > 0 && insertParagraphs(view, paragraphs, true, defaults, false)) {
    event.preventDefault();
    return true;
  }
  if (paragraphs.every((p, i) => p.eq(parsed[i]))) return false;
  // ProseMirror's own paste, with the spaces put right
  const fixed = new Slice(Fragment.from(paragraphs), slice.openStart, slice.openEnd);
  view.dispatch(view.state.tr.replaceSelection(fixed).scrollIntoView().setMeta("paste", true).setMeta("preventAutolink", true));
  event.preventDefault();
  return true;
}

// Plain text takes the formatting of the paragraph it lands in
export function clipboardTextParser(text: string, $context: ResolvedPos): Slice {
  const schema = $context.doc.type.schema;
  const parent = $context.parent.type.name === "paragraph" ? $context.parent : null;
  const nodes = text.split(/\r\n?|\n/).map((line) => schema.nodes.paragraph.create(parent ? { ...parent.attrs, locked: false, span: null, bid: null, kind: null } : null, line ? schema.text(line, $context.marks()) : null));
  return new Slice(Fragment.from(nodes), 1, 1);
}
