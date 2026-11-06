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
import { Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Extension } from "@tiptap/core";
import { namedStyleText, type DocDefaults } from "@/lib/doc-import";
import { DOCS_SLICE_TYPE, mergeSliceWithHtml, readDocsSlice, readDocsSliceParts, sliceParagraphs, sliceText } from "@/lib/docs-slice";
import { cssColorToHex, cssFontToFamily, DEFAULT_FONT, effectiveIndent, INDENT_PT, NAMED_STYLES, paragraphFromAttrs, type EditorNode, type NamedStyle } from "@/lib/rich-text";
import { flattenPastedLists, inlinePastedStyles, pastedColumnWidths, pastedEmptyLines } from "./extensions";
import { pastedImageSources } from "./pasted-images";

export const imageFilesOf = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

/** HTML Google Docs put on the clipboard */
export const isDocsHTML = (html: string) => /id="docs-internal-guid-/.test(html);

/**
 * Docs writes a space it must keep (at either end of a run, or next to another space) as the
 * entity &nbsp;, and a real non-breaking space as the character itself. Parsing makes both the
 * same character, so the real ones are marked first (a noncharacter, never in text) and each is
 * put back once the HTML is read (docsText): the entities are spaces, the marks non-breaking.
 */
const REAL_NBSP = "\ufdd0";
export const docsSpaces = (html: string) => (isDocsHTML(html) && html.includes("\u00a0") ? html.replace(/>([^<]+)</g, (m, t: string) => (t.includes("\u00a0") ? `>${t.replace(/\u00a0/g, REAL_NBSP)}<` : m)) : html);
const docsText = (t: string) => (/[\u00a0\ufdd0]/.test(t) ? t.replace(/\u00a0/g, " ").replace(/\ufdd0/g, "\u00a0") : t);

/** The fragment with every text changed by `fn` (the same fragment when nothing changes) */
function mapText(f: Fragment, fn: (t: string) => string): Fragment {
  let changed = false;
  const out: PMNode[] = [];
  f.forEach((n) => {
    if (n.isText) {
      const t = fn(n.text ?? "");
      if (t !== n.text) { changed = true; out.push(n.type.schema.text(t, n.marks)); } else out.push(n);
    } else if (n.content.size) {
      const c = mapText(n.content, fn);
      if (c !== n.content) { changed = true; out.push(n.copy(c)); } else out.push(n);
    } else out.push(n);
  });
  return changed ? Fragment.from(out) : f;
}

// (docsSpaces first: it reads the HTML's own text, which a transform through the DOM writes as &nbsp;)
export const transformPastedHTML = (html: string) => inlinePastedStyles(flattenPastedLists(pastedEmptyLines(pastedColumnWidths(docsSpaces(pastedImageSources(html))))));

/**
 * Whether a copy from Docs ends with a whole paragraph (its newline copied), and whether that is known.
 * Docs' own copy says, even one this can't read. Its text/plain ends with a newline whenever more
 * than one paragraph was copied, so for those it can't; there only an empty paragraph at the end (a
 * <br>) shows it. Within one paragraph, text/plain ends with a newline only when that paragraph's was
 * copied. Without Docs' copy (Safari) the HTML can't always tell: in 56 copies of 16 documents spanning
 * paragraphs a trailing <br> is right for 45; the rest end with a newline the HTML doesn't show
 * (Ctrl+A copies among them), so a copy without one is not known to end mid-paragraph.
 */
export function docsCopyEnd(html: string, slice: string | null | undefined, plain: string, paragraphs: number): { ends: boolean; known: boolean } {
  const text = slice ? sliceText(slice) : null;
  if (text != null) return { ends: text.endsWith("\n"), known: true };
  if (paragraphs <= 1) return { ends: /\n$/.test(plain.replace(/\r\n?/g, "\n")), known: true };
  const br = /<br\s*\/?>\s*(<\/b>)?\s*(<br class="Apple-interchange-newline">)?\s*$/i.test(html.trim());
  return { ends: br, known: br };
}

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
    // A line break or an image inside a run carries the run's marks (pasted HTML spells them out), so it is restyled with it
    if (!node.isInline) { nodes.push(node); return; }
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
      // <mark> without a colour is yellow; white is no highlight (as a Google Doc reads)
      const hex = typeof m.attrs.color === "string" && m.attrs.color ? cssColorToHex(m.attrs.color) : "#ffff00";
      return hex && hex !== "#ffffff" ? [m.type.create({ ...m.attrs, color: hex })] : [];
    });
    if (Object.values(next).some((v) => v != null)) marks = schema.marks.textStyle.create(next).addToSet(marks);
    nodes.push(node.mark(marks));
  });
  return Fragment.from(nodes);
}

const styleOf = (p: PMNode) => ((p.attrs.styleName as NamedStyle | undefined) ?? "normal") as NamedStyle;

type Attrs = Record<string, unknown>;
type Box = { start?: number; first?: number; marker?: number; above?: number | null; below?: number | null };

/** A paragraph's space above and below as the page draws it: its own, or its named style's */
function spaceOf(a: Attrs): [number, number] {
  const box = a.box as Box | null;
  const named = NAMED_STYLES[typeof a.styleName === "string" && a.styleName in NAMED_STYLES ? (a.styleName as NamedStyle) : "normal"].space;
  return [typeof box?.above === "number" ? box.above : named[0], typeof box?.below === "number" ? box.below : named[1]];
}

/** Whether a list item has no space next to another list item (Docs' COLLAPSE_LISTS; see docs.css) */
const collapses = (a: Attrs, defaults: DocDefaults) =>
  !!a.list && a.spacingMode !== "NEVER_COLLAPSE" && (a.spacingMode === "COLLAPSE_LISTS" || defaults.spacingMode !== "NEVER_COLLAPSE");

/** Where a paragraph's text starts (a list item's, after its glyph), in points */
function textStart(a: Attrs): number {
  const p = paragraphFromAttrs(a);
  return p.list ? (p.exact?.start ?? INDENT_PT * ((p.level ?? 0) + 1)) : effectiveIndent(p).start;
}

/** The same paragraph with this space above and below, its indents as they are */
function withSpace(a: Attrs, above: number, below: number): Attrs {
  const box = a.box as Box | null;
  if (a.list) return { ...a, box: { start: textStart(a), marker: typeof box?.marker === "number" ? box.marker : -18, above, below } };
  if (box) return { ...a, box: { ...box, above, below } };
  const { start, first } = effectiveIndent(paragraphFromAttrs(a));
  return { ...a, indent: 0, firstLine: false, box: { start, first: first - start, above, below } };
}

/** What a paragraph split from another doesn't take with it (the paragraph's keepOnSplit: false attributes) */
const NOT_SPLIT = { locked: false, span: null, bid: null, kind: null, sectionType: null, first: null, columns: null, spacing: null, line: null, textWidth: null };
const NOT_LISTED = { list: null, listId: null, level: null, glyph: null, glyphStyle: null, preset: null };

/**
 * Docs drops a soft line break sent through its API, so the sync types each line break that is
 * pasted as a new paragraph (see segmentText in doc-model). Each one between from and to becomes
 * that paragraph here, drawn as the break was: the line after it starts where the paragraph's text
 * does (a list item's after its glyph, with no glyph of its own), with no first-line indent and no
 * space between the lines; the paragraph's space above stays with its first line and its space
 * below with its last. A list item that had no space next to the item after it still has none. So
 * the page shows the paragraphs the Doc will have, as Docs will draw them. With `only`, just the break
 * at that position.
 */
export function breaksAsParagraphs(tr: Transaction, from: number, to: number, defaults: DocDefaults, only?: number): Transaction {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  const found: { pos: number; node: PMNode; breaks: number[] }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type !== paragraph) return !node.isTextblock;
    const breaks: number[] = [];
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      if (child.type.name === "hardBreak" && at >= from && at < to && (only == null || at === only)) breaks.push(at);
    });
    if (breaks.length && !node.attrs.locked) found.push({ pos, node, breaks });
    return false;
  });
  const start = tr.steps.length;
  // From the last, so the positions before each change stay as they were
  for (const { pos, node, breaks } of found.reverse()) {
    const a = node.attrs as Attrs;
    const [above, below] = spaceOf(a);
    const steps = tr.steps.length;
    // A list item next to another in the body (as docs.css draws them): each has no space there, as its mode says
    const next = tr.doc.resolve(pos + node.nodeSize).nodeAfter;
    const listed = !!a.list && !!next?.attrs.list && tr.doc.resolve(pos).depth === 0;
    const last = listed && collapses(a, defaults) ? 0 : below;
    // A list item's next line goes on with its list (ParagraphFormat.cont)
    const line = (b: number): Attrs => ({ ...a, ...NOT_SPLIT, ...NOT_LISTED, ...(a.list ? { listCont: true } : {}), softBreak: true, indent: 0, firstLine: false, box: { start: textStart(a), first: 0, above: 0, below: b } });
    breaks.slice().reverse().forEach((at, k) => {
      tr.delete(at, at + 1);
      tr.split(at, 1, [{ type: paragraph, attrs: line(k === 0 ? last : 0) }]);
    });
    tr.setNodeMarkup(pos, undefined, withSpace(a, above, 0));
    // Its last line isn't a list item: the item after it keeps the no space above it had (if it was pasted too)
    if (listed && next && collapses(next.attrs as Attrs, defaults)) {
      const at = tr.mapping.slice(steps).map(pos + node.nodeSize, 1);
      if (at < tr.mapping.slice(start).map(to, 1)) tr.setNodeMarkup(at, undefined, withSpace(next.attrs as Attrs, 0, spaceOf(next.attrs as Attrs)[1]));
    }
  }
  return tr;
}

/**
 * Content dropped on the page (dragged from elsewhere, or moved within it, which types it again) has
 * its line breaks made the paragraphs the sync will make, as pasted content does. ProseMirror selects
 * what it dropped.
 */
export const DroppedBreaks = Extension.create({
  name: "droppedBreaks",
  addProseMirrorPlugins() {
    let view: EditorView | null = null;
    return [new Plugin({
      view: (v) => { view = v; return {}; },
      appendTransaction: (trs, _old, state) => {
        if (!view || !trs.some((tr) => tr.getMeta("uiEvent") === "drop")) return null;
        const tr = breaksAsParagraphs(state.tr, state.selection.from, state.selection.to, destinationDefaults(view));
        return tr.docChanged ? tr : null;
      },
    })];
  },
});

const isBreakLine = (n: PMNode | null | undefined): n is PMNode => !!n && n.type.name === "paragraph" && n.attrs.softBreak === true && !n.attrs.locked && !n.attrs.list;

/** A Shift+Enter line break, made the paragraph the sync will make of it and drawn as the break (breaksAsParagraphs) */
function typeLineBreak(view: EditorView): boolean {
  const { state } = view;
  const { $from } = state.selection;
  const br = state.schema.nodes.hardBreak;
  if (!br || $from.parent.type.name !== "paragraph" || $from.parent.attrs.locked) return false;
  const marks = state.storedMarks ?? $from.marks();
  const tr = state.tr.replaceSelectionWith(br.create(), true);
  const $at = tr.selection.$from;
  const pos = $at.before($at.depth);
  const end = pos + $at.parent.nodeSize;
  // The paragraph after it too: a list item there keeps the no space above it had. Only this break: the
  // line breaks the document has of its own (Docs' U+000B, read as they are) stay as they are
  const after = tr.doc.resolve(end).nodeAfter;
  breaksAsParagraphs(tr, pos, end + (after?.nodeSize ?? 0), destinationDefaults(view), $at.pos - 1);
  if (marks.length) tr.setStoredMarks(marks);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Enter in a paragraph that has line breaks (one of its lines, see breaksAsParagraphs): in Docs those
 * lines are one paragraph (list item), so Enter starts its next one, with its look: a list item's next
 * item, numbered on. The part before the caret ends the paragraph, with its space below; the lines
 * after the caret are the new paragraph's own
 */
function enterInBrokenParagraph(view: EditorView): boolean {
  const { state } = view;
  const { $from, $to } = state.selection;
  const node = $from.parent;
  if ($from.parent !== $to.parent || node.type.name !== "paragraph" || node.attrs.locked) return false;
  const container = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  // The paragraph the lines belong to, and its last line
  let h = index;
  while (h >= 0 && isBreakLine(container.child(h))) h--;
  let l = index;
  while (l + 1 < container.childCount && isBreakLine(container.child(l + 1))) l++;
  const onLine = h < index;
  if (h < 0 || (!onLine && l === index)) return false; // no line breaks: Enter as ever
  const head = container.child(h);
  if (head.type.name !== "paragraph" || head.attrs.locked) return false;
  const a = head.attrs as Attrs;
  const [above] = spaceOf(a);
  const below = spaceOf(container.child(l).attrs as Attrs)[1];
  const more = l > index;
  // Two list items next to each other: no space between them, as their mode says
  const listed = !!a.list && collapses(a, destinationDefaults(view));
  const marks = state.storedMarks ?? $from.marks();
  // Enter at the end of a title or heading opens a Normal text paragraph, as in Docs (and DocFormat's Enter)
  const atEnd = !more && $to.parentOffset === node.content.size;
  const toNormal = atEnd && !a.list && typeof a.styleName === "string" && a.styleName !== "normal";
  const tr = state.tr.deleteSelection();
  const at = tr.selection.from;
  const box = a.box as Box | null;
  const next = toNormal ? { ...a, ...NOT_SPLIT, styleName: "normal", box: box ? { ...box, above: null, below: null } : null } : withSpace({ ...a, ...NOT_SPLIT }, listed ? 0 : above, more ? 0 : below);
  tr.split(at, 1, [{ type: head.type, attrs: next }]);
  const leftPos = tr.doc.resolve(at).before();
  const left = tr.doc.nodeAt(leftPos)!;
  tr.setNodeMarkup(leftPos, undefined, withSpace(left.attrs as Attrs, onLine ? 0 : above, listed ? 0 : below));
  if (marks.length) tr.setStoredMarks(marks);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Backspace at the start of a line after a line break, or Delete at the end of the paragraph before it,
 * takes the break out, as in Docs: the lines are one again, and the joined paragraph has the space
 * below the line had (its paragraph's, when it was the last)
 */
function joinLine(view: EditorView, dir: -1 | 1): boolean {
  const { state } = view;
  if (!state.selection.empty) return false;
  const $c = state.selection.$from;
  if ($c.parent.type.name !== "paragraph") return false;
  let at: number;
  if (dir < 0) {
    if ($c.parentOffset !== 0 || !isBreakLine($c.parent)) return false;
    at = $c.before();
  } else {
    if ($c.parentOffset !== $c.parent.content.size) return false;
    at = $c.after();
    if (!isBreakLine(state.doc.resolve(at).nodeAfter)) return false;
  }
  const $at = state.doc.resolve(at);
  const before = $at.nodeBefore;
  const line = $at.nodeAfter;
  if (!before || !line || before.type.name !== "paragraph" || before.attrs.locked) return false;
  const tr = state.tr.join(at);
  const pos = at - before.nodeSize;
  tr.setNodeMarkup(pos, undefined, withSpace(before.attrs as Attrs, spaceOf(before.attrs as Attrs)[0], spaceOf(line.attrs as Attrs)[1]));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Line breaks typed as Docs makes them (it drops one sent through its API, so each is the paragraph the
 * sync makes of it, drawn as the break): Shift+Enter adds one, Enter on a line after one starts the
 * next paragraph or list item, Backspace and Delete take one out. Ahead of DocSync, whose Shift+Enter
 * (a new paragraph) headers and footers keep.
 */
export const LineBreaks = Extension.create({
  name: "lineBreaks",
  priority: 1001,
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => typeLineBreak(this.editor.view),
      Enter: () => enterInBrokenParagraph(this.editor.view),
      // With a modifier too (a word back or on, Shift+Backspace): at a line break each takes it out
      Backspace: () => joinLine(this.editor.view, -1),
      "Shift-Backspace": () => joinLine(this.editor.view, -1),
      "Mod-Backspace": () => joinLine(this.editor.view, -1),
      "Alt-Backspace": () => joinLine(this.editor.view, -1),
      Delete: () => joinLine(this.editor.view, 1),
      "Mod-Delete": () => joinLine(this.editor.view, 1),
      "Alt-Delete": () => joinLine(this.editor.view, 1),
    };
  },
});

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
  // Tables can go between the pasted paragraphs (into the body, not a cell); the paste starts and ends with a paragraph
  if (!paragraphs.length || [paragraphs[0], paragraphs[paragraphs.length - 1]].some((p) => p.type !== paragraph)) return false;
  const tables = paragraphs.some((p) => p.type !== paragraph);
  if (paragraphs.some((p) => p.type !== paragraph && p.type.name !== "table") || (tables && $from.depth !== 1)) return false;
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
      // Text within one paragraph: the paragraph keeps its own format. Over a selection reaching into later
      // paragraphs that is the first one's (as when typing over it), so the text is restyled for that one
      const into = $from.parent;
      tr.replaceSelection(new Slice(into === $to.parent || !tail ? joined : restyleText(tail.content, styleOf(tail), styleOf(into), defaults), 0, 0));
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
    breaksAsParagraphs(tr, tr.mapping.map($from.pos, -1), tr.mapping.map($to.pos, 1), defaults);
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

/**
 * A list item's glyph style from Docs' HTML (its <li>'s style, see flattenPastedLists) without what
 * the item's named style gives. Docs' HTML never says a glyph is highlighted; Docs highlights it
 * with the whole item, so an item highlighted from end to end has its glyph highlighted too.
 */
function docsGlyph(p: PMNode, defaults: DocDefaults): PMNode {
  const raw = p.attrs.glyphStyle as Record<string, unknown> | null;
  if (!p.attrs.list || !raw) return p;
  const style = namedStyleText(defaults, styleOf(p));
  const g: Record<string, unknown> = { ...raw };
  if (g.font === style.font) delete g.font;
  if (g.size === style.size) delete g.size;
  if (g.color === style.color) delete g.color;
  const bgs = new Set<string | null>();
  p.forEach((c) => { if (c.isText && c.text?.trim()) bgs.add((c.marks.find((m) => m.type.name === "highlight")?.attrs.color as string | undefined) ?? null); });
  const [bg] = Array.from(bgs);
  if (bgs.size === 1 && bg) g.bg = bg;
  return p.type.create({ ...p.attrs, glyphStyle: g }, p.content, p.marks);
}

function hasBreak(content: Fragment): boolean {
  let found = false;
  content.descendants((n) => { if (n.type.name === "hardBreak") found = true; return !found; });
  return found;
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
  const html = data.getData("text/html");
  const docs = isDocsHTML(html);
  // Docs' spaces as the document has them (see docsSpaces)
  const read = slice;
  if (docs) { const content = mapText(slice.content, docsText); if (content !== slice.content) slice = new Slice(content, slice.openStart, slice.openEnd); }
  // The selection replaced with a slice, its line breaks the paragraphs the sync makes of them
  const replaced = (content: Slice) => {
    const { from, to } = view.state.selection;
    const tr = view.state.tr.replaceSelection(content);
    return breaksAsParagraphs(tr, tr.mapping.map(from, -1), tr.mapping.map(to, 1), destinationDefaults(view)).scrollIntoView().setMeta("paste", true).setMeta("preventAutolink", true);
  };
  // ProseMirror's own paste, of the slice as read here
  const pmPaste = () => {
    if (slice === read && !hasBreak(slice.content)) return false;
    view.dispatch(replaced(slice).setMeta("uiEvent", "paste"));
    event.preventDefault();
    return true;
  };
  // Text from inside one paragraph: a paragraph that doesn't end, so it takes the destination's format
  const inline = slice.content.childCount > 0 && Array.from({ length: slice.content.childCount }, (_, i) => slice.content.child(i)).every((n) => n.isInline);
  const first = inline ? view.state.schema.nodes.paragraph.create(null, slice.content) : slice.content.firstChild;
  // Values that repeat what each paragraph's style gives aren't formatting of their own
  const defaults = destinationDefaults(view);
  // Docs' copy that can't be read whole (a table, an image or chip in it): each block it has as it says,
  // and from the HTML what only that has (see mergeSliceWithHtml)
  if (docs && raw && first) {
    try {
      const parts = readDocsSliceParts(raw);
      if (parts) {
        const html: PMNode[] = [];
        if (inline) html.push(first); else slice.content.forEach((n) => html.push(n));
        const own = html.map((p) => (p.type.name === "paragraph" ? docsGlyph(p.copy(restyleText(p.content, styleOf(p), styleOf(p), defaults)), defaults) : p));
        const merged = mergeSliceWithHtml(parts, sliceParagraphs(parts, defaults), own.map((n) => n.toJSON() as EditorNode));
        const schema = view.state.schema;
        const nodes = (merged ?? []).map((n) => schema.nodeFromJSON(n));
        let ends = parts.endsWithParagraph;
        // A copy that ends with a table (Ctrl+A of a document that does): what follows the table is the
        // paragraph pasted into, with its own format, as in Docs
        const into = view.state.selection.$to.parent;
        if (nodes[nodes.length - 1]?.type.name === "table") { nodes.push(schema.nodes.paragraph.create(into.type === schema.nodes.paragraph ? into.attrs : null)); ends = false; }
        if (merged && insertParagraphs(view, nodes, ends, defaults)) {
          event.preventDefault();
          return true;
        }
      }
    } catch (err) {
      console.error("Couldn't read the Google Docs copy with its HTML; pasting the HTML:", err);
    }
  }
  if (first?.type.name !== "paragraph") return pmPaste();
  const parsed: PMNode[] = [];
  if (inline) parsed.push(first); else slice.content.forEach((n) => parsed.push(n));
  // Docs' HTML has its spaces right already (see docsSpaces); others' are put right from text/plain
  const spaced = docs ? parsed : plainSpaces(parsed, plain);
  const paragraphs = spaced.map((p) => (p.type.name === "paragraph" ? p.copy(restyleText(p.content, styleOf(p), styleOf(p), defaults)) : p)).map((p) => (docs ? docsGlyph(p, defaults) : p));
  // Docs' HTML: paragraphs go in as Docs pastes them, ending as Docs' copy says (see docsCopyEnd)
  const end = inline ? { ends: false, known: true } : docsCopyEnd(html, raw, plain, paragraphs.length);
  if ((docs || inline) && insertParagraphs(view, paragraphs, docs ? end.ends : false, defaults, docs ? end.known : true)) {
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
  if (paragraphs.every((p, i) => p.eq(parsed[i]))) return pmPaste();
  // ProseMirror's own paste, with the spaces put right
  const fixed = new Slice(Fragment.from(paragraphs), slice.openStart, slice.openEnd);
  view.dispatch(replaced(fixed));
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
