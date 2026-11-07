/**
 * What the Compare & Sync page says and draws about a comparison: tab statuses, target choices,
 * plain-language lines for what is left alone, the text a sync will type, and how token ranges
 * of the engine land on the page.
 */

import type { Change, ChangeKind, CompareSide, CompareTab, Kept, TabCompare, TabMap, TabTarget, Unsupported } from "@/lib/compare-types";
import type { EditorNode } from "@/lib/rich-text";
import { afterWord, BREAK_MARK, PENDING_MARK, tokenize, type Tok } from "@/lib/doc-model";

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A tab Docs names itself, which a reference tab may take over when it is blank */
export const isDefaultTabTitle = (title: string) => /^Tab \d+$/i.test(title.trim()) || /^Untitled tab$/i.test(title.trim());

/** The editor document for a list of nodes (never empty: the schema wants a paragraph) */
export const docOf = (nodes: EditorNode[] | undefined): EditorNode => ({ type: "doc", content: nodes?.length ? nodes : [{ type: "paragraph" }] });

export type TabTone = "add" | "new" | "done" | "off";

/** How a reference tab stands: what the sidebar says under its name */
export function tabStatus(tab: TabCompare, skip: ReadonlySet<string>): { label: string; tone: TabTone } {
  if (tab.target.kind === "skip") return { label: "Not copied", tone: "off" };
  const open = tab.changes.filter((c) => !skip.has(c.id));
  if (tab.target.kind === "new") return { label: open.length ? "New tab" : "New tab · empty", tone: "new" };
  if (!open.length) return { label: tab.changes.length ? "Nothing to copy" : "Up to date", tone: "done" };
  const typed = open.filter((c) => c.kind !== "rename" && c.kind !== "pageSetup").length;
  return { label: typed ? plural(typed, "addition") : "Small changes", tone: "add" };
}

/** A target as the select's value */
export function targetValue(t: TabTarget | undefined): string {
  if (!t) return "";
  return t.kind === "tab" ? `tab:${t.leftTabId}` : t.kind;
}

/** The target a select value stands for */
export function targetFor(value: string, rightTab: CompareTab, left: CompareSide): TabTarget | null {
  if (value === "skip") return { kind: "skip" };
  if (value === "new") return { kind: "new", title: rightTab.title, ...(rightTab.emoji ? { emoji: rightTab.emoji } : {}), parentRightTabId: rightTab.parentId };
  if (!value.startsWith("tab:")) return null;
  const leftTab = left.tabs.find((t) => t.id === value.slice(4));
  // A tab picked by hand keeps its name (only the automatic match renames a blank "Tab 1"), as the routes do
  return leftTab ? { kind: "tab", leftTabId: leftTab.id } : null;
}

/** Which reference tab each of your tabs is taken by, so a select can say so */
export function takenBy(map: TabMap, right: CompareSide): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of right.tabs) {
    const target = map[t.id];
    if (target?.kind === "tab") out.set(target.leftTabId, t.id);
  }
  return out;
}

const COUNTED: Partial<Record<Kept["kind"], (n: number) => string>> = {
  onlyLeft: (n) => `${plural(n, "part")} only your document has stay${n === 1 ? "s" : ""} as ${n === 1 ? "it is" : "they are"}`,
  formatting: (n) => `${plural(n, "part")} with the same words but a different look keep${n === 1 ? "s" : ""} your look`,
  paragraphStyle: (n) => `${plural(n, "paragraph")} styled differently (heading, alignment or spacing) keep${n === 1 ? "s" : ""} your style`,
  spelling: (n) => `${plural(n, "word")} spelled a little differently ${n === 1 ? "isn't" : "aren't"} typed again`,
  moved: (n) => `${plural(n, "part")} your document has in another place ${n === 1 ? "isn't" : "aren't"} copied twice`,
  spacing: (n) => `${plural(n, "difference")} in blank lines or spaces ${n === 1 ? "is" : "are"} left alone`,
  tableShape: (n) => `${plural(n, "table")} with other columns or merged cells: only the matching cells are filled`,
  footnoteText: (n) => `${plural(n, "footnote")} worded differently keep${n === 1 ? "s" : ""} your wording`,
  leftTab: (n) => `${plural(n, "tab")} only your document has stay${n === 1 ? "s" : ""} as ${n === 1 ? "it is" : "they are"}`,
};

/** What the sync leaves alone, in plain words */
export function keptLine(k: Kept): string {
  switch (k.kind) {
    case "header": return "Your header stays as it is";
    case "footer": return "Your footer stays as it is";
    case "pageSetup": return "Your page size and margins stay as they are";
    default: return (COUNTED[k.kind] ?? ((n: number) => plural(n, "difference") + " left alone"))(Math.max(1, k.count));
  }
}

const UNSUPPORTED: Record<Unsupported["kind"], [string, string]> = {
  rule: ["horizontal line", "horizontal lines"],
  toc: ["table of contents", "tables of contents"],
  equation: ["equation", "equations"],
  drawing: ["drawing", "drawings"],
  chip: ["smart chip", "smart chips"],
  floatingImage: ["image placed beside the text", "images placed beside the text"],
  image: ["image that couldn't be read", "images that couldn't be read"],
  checkbox: ["ticked checkbox", "ticked checkboxes"],
  columns: ["column layout", "column layouts"],
  other: ["part Google Docs can't add", "parts Google Docs can't add"],
};

/** What can't be copied, in plain words */
export function unsupportedLine(u: Unsupported): string {
  const n = Math.max(1, u.count);
  const [one, many] = UNSUPPORTED[u.kind] ?? UNSUPPORTED.other;
  const what = plural(n, one, many);
  if (u.asText) return `${what}: copied as ${n === 1 ? "its" : "their"} text`;
  if (u.kind === "checkbox") return `${what}: copied unticked`;
  return `${what}: Google Docs gives no way to add ${n === 1 ? "it" : "them"}, so ${n === 1 ? "it's" : "they're"} skipped`;
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  text: "Words",
  paragraph: "Paragraphs",
  list: "List items",
  table: "Table",
  row: "Table rows",
  cell: "Table cell",
  image: "Image",
  pageBreak: "Page break",
  footnote: "Footnote",
  header: "Header",
  footer: "Footer",
  tab: "New tab",
  rename: "Tab name",
  pageSetup: "Page setup",
};

/** A line of a change in the list: a paragraph it adds, or what a structure is */
export interface ChangeLine {
  text: string;
  /** text: words the sync types; heading or item: a heading or list item it types; desc: a description ("A table, …") */
  kind: "text" | "heading" | "item" | "desc";
}

/** How a change reads in the list */
export interface ChangeView {
  /** What it adds: its first paragraphs, one per line, or what it is */
  lines: ChangeLine[];
  /** What kind of thing it is, counted: "Paragraph", "3 list items", "Table" */
  label: string;
  /** Where it goes, when that says something the label doesn't */
  where: string;
  /** All of it on one line, for screen readers */
  summary: string;
}

/** The reference tab a change comes from, as the list reads it */
export interface ChangeSource {
  tokens: Tok[];
  footnotes?: Record<string, { nodes: EditorNode[] }>;
}

const HEADING_STYLES = new Set(["title", "subtitle", "h1", "h2", "h3", "h4", "h5", "h6"]);
const STYLE_LABEL: Record<string, string> = { title: "Title", subtitle: "Subtitle", h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", h5: "Heading", h6: "Heading" };
const clean = (s: string) => s.replace(/[\s ]+/g, " ").trim();
/** Leading punctuation of words put inside a sentence goes ("…, and it held" reads as "…and it held") */
const inSentence = (s: string) => {
  const t = s.replace(/^[\s,.;:)\]}]+/, "");
  return t && t !== s.trim() ? `…${t}` : t;
};
const textOf = (nodes: EditorNode[] | undefined): string => clean((nodes ?? []).map((n) => (n.text ?? "") + textOf(n.content) + (n.type === "paragraph" ? " " : "")).join(""));

interface Read { paras: { text: string; style: string; item: boolean; images: number }[]; tables: string[][][]; fids: string[] }

/** The paragraphs, tables and footnotes in tokens [a, b) */
function readRange(tokens: Tok[], a: number, b: number): Read {
  const out: Read = { paras: [], tables: [], fids: [] };
  let text = "";
  let images = 0;
  let depth = 0;
  // A range that starts inside a table (rows added to one) reads as a table of its own
  let table: string[][] | null = null;
  const row = () => table?.[table.length - 1];
  for (let i = Math.max(0, a); i < Math.min(b, tokens.length); i++) {
    const t = tokens[i];
    if (t.k === "c") text += t.c;
    else if (t.k === "br") text += " ";
    else if (t.k === "img") images++;
    else if (t.k === "fn") { if (t.fid) out.fids.push(t.fid); }
    else if (t.k === "nl") {
      const cell = row();
      if (depth > 0 || (table && cell)) { if (cell?.length) cell[cell.length - 1] = clean(`${cell[cell.length - 1]} ${text}`); }
      else out.paras.push({ text: clean(text), style: String(t.attrs.styleName ?? "normal"), item: !!t.attrs.list, images });
      text = "";
      images = 0;
    } else if (t.k === "st") {
      if (t.kind === "table") { depth++; if (depth === 1) { table = []; out.tables.push(table); } }
      else if (t.kind === "tableEnd") { depth = Math.max(0, depth - 1); if (!depth) table = null; }
      else if (depth <= 1 && t.kind === "row") { if (!table) { table = []; out.tables.push(table); } table.push([]); }
      else if (depth <= 1 && t.kind === "cell") row()?.push("");
    }
  }
  if (clean(text) || images) out.paras.push({ text: clean(text), style: "normal", item: false, images });
  return out;
}

const tableShape = (rows: string[][]) => `${plural(rows.length, "row")} by ${plural(Math.max(0, ...rows.map((r) => r.length)), "column")}`;
const rowLine = (r: string[]) => r.filter(Boolean).join(" · ");

/**
 * How a change reads in the list: the paragraphs it adds one per line (a table as its shape, an
 * image as "An image"), what kind of thing it is, counted, and where it goes.
 */
export function describeChange(c: Change, src: ChangeSource | null): ChangeView {
  const fallback = changeTitle(c);
  const view = (lines: ChangeLine[], label: string, where = c.where): ChangeView => {
    const shown = lines.length ? lines : [{ text: fallback, kind: "desc" as const }];
    return { lines: shown, label, where, summary: shown.map((l) => l.text).join("; ").replace(/[\s.;:,]+$/, "") };
  };
  switch (c.kind) {
    case "tab": return view([{ text: c.preview || "A new tab", kind: "text" }], "New tab", c.where === "as a new tab" ? "" : c.where);
    case "rename": return view([{ text: `${c.where || "A blank tab"} becomes “${c.preview}”`, kind: "desc" }], "Tab name", "");
    case "pageSetup": return view([{ text: c.preview || "Page size and margins", kind: "desc" }], "Page setup", "");
    case "pageBreak": return view([{ text: "A page break", kind: "desc" }], "Page break");
    case "header":
    case "footer": return view([c.preview.trim() ? { text: clean(c.preview), kind: "text" } : { text: `An empty ${c.kind}`, kind: "desc" }], CHANGE_LABEL[c.kind], "");
    default: break;
  }
  if (!src || !c.right) return view([{ text: c.kind === "text" ? inSentence(clean(c.preview)) : clean(c.preview), kind: c.preview.trim() ? "text" : "desc" }], CHANGE_LABEL[c.kind]);
  const r = readRange(src.tokens, c.right[0], c.right[1]);
  if (c.kind === "footnote") {
    const words = r.fids.map((id) => textOf(src.footnotes?.[id]?.nodes)).find(Boolean);
    return view([words ? { text: words, kind: "text" } : { text: "A footnote", kind: "desc" }], "Footnote");
  }
  if (c.kind === "table" && r.tables.length) {
    const t = r.tables[0];
    const lines: ChangeLine[] = [{ text: `A table, ${tableShape(t)}`, kind: "desc" }];
    const head = t.length ? rowLine(t[0]) : "";
    if (head) lines.push({ text: head, kind: "text" });
    return view(lines, "Table");
  }
  if (c.kind === "row" && r.tables.length) {
    const rows = r.tables.flat();
    const lines = rows.map(rowLine).filter(Boolean).slice(0, 2).map((text) => ({ text, kind: "text" as const }));
    return view(lines.length ? lines : [{ text: rows.length === 1 ? "An empty row" : `${rows.length} empty rows`, kind: "desc" }], rows.length === 1 ? "Table row" : plural(rows.length, "table row"));
  }
  const paras = r.paras.filter((p) => p.text || p.images);
  const lines: ChangeLine[] = [];
  for (const p of paras) {
    if (lines.length === 2) break;
    if (!p.text) { lines.push({ text: p.images > 1 ? `${p.images} images` : "An image", kind: "desc" }); continue; }
    lines.push({ text: c.kind === "text" && !lines.length ? inSentence(p.text) : p.text, kind: HEADING_STYLES.has(p.style) ? "heading" : p.item ? "item" : "text" });
  }
  for (const t of r.tables) if (lines.length < 2) lines.push({ text: `A table, ${tableShape(t)}`, kind: "desc" });
  const n = paras.length;
  const label = c.kind === "text" ? "Words"
    : c.kind === "cell" ? "Table cell"
    : c.kind === "image" || (n === 1 && !paras[0].text) ? (r.paras.reduce((k, p) => k + p.images, 0) > 1 ? "Images" : "Image")
    : n <= 1 ? (STYLE_LABEL[paras[0]?.style] ?? (paras[0]?.item || c.kind === "list" ? "List item" : "Paragraph"))
    : paras.every((p) => p.item) ? plural(n, "list item")
    : plural(n, "paragraph");
  return view(lines, label);
}

/** One line for a change in the list: what it adds, where */
export function changeTitle(c: Change): string {
  const p = c.preview.trim();
  if (p) return p;
  switch (c.kind) {
    case "image": return "An image";
    case "pageBreak": return "A page break";
    case "table": return "A table";
    case "row": return "Table rows";
    case "footnote": return "A footnote";
    case "header": return "The header";
    case "footer": return "The footer";
    case "pageSetup": return "Page size and margins";
    default: return CHANGE_LABEL[c.kind];
  }
}

/**
 * The text a sync of these merged tabs types, back to back in typing order, and where its Manual
 * breaks start in it: close enough to the server's for the time it will take.
 */
export function typedText(docs: EditorNode[]): { text: string; anchors: { at: number; minutes: number }[] } {
  let text = "";
  const ends: { k: number; minutes: number }[] = [];
  for (const doc of docs) {
    let line = false;
    let brk: number | null = null;
    for (const t of tokenize(doc)) {
      const marks = t.k === "c" || t.k === "img" || t.k === "pb" ? t.marks : null;
      const pending = !!marks?.some((m) => m.type === PENDING_MARK);
      const minutes = Number(marks?.find((m) => m.type === BREAK_MARK)?.attrs?.minutes);
      if (brk != null && !(pending && minutes > 0)) { ends.push({ k: text.length - 1, minutes: brk }); brk = null; }
      if (t.k === "nl") { if (line) text += "\n"; line = false; continue; }
      if (!pending) continue;
      text += t.k === "c" ? t.c : " ";
      line = true;
      if (minutes > 0) brk = minutes;
    }
    if (brk != null) ends.push({ k: text.length - 1, minutes: brk });
  }
  const anchors = new Map<number, number>();
  for (const e of ends) {
    const at = afterWord(text, e.k);
    if (e.k >= 0 && at < text.length) anchors.set(at, e.minutes);
  }
  return { text, anchors: Array.from(anchors, ([at, minutes]) => ({ at, minutes })) };
}

/**
 * Pairs of token indices that show the same content in both panes (merged → reference): where
 * each copied run starts and ends. Scrolling one pane keeps the other at the same content.
 */
export function anchorPairs(origin: number[], max = 400): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < origin.length) {
    if (origin[i] < 0) { i++; continue; }
    let j = i;
    while (j + 1 < origin.length && origin[j + 1] === origin[j] + 1) j++;
    out.push([i, origin[i]], [j + 1, origin[j] + 1]);
    i = j + 1;
  }
  // Only pairs in order on both sides
  const mono: [number, number][] = [];
  for (const p of out) { const last = mono[mono.length - 1]; if (!last || (p[0] >= last[0] && p[1] >= last[1])) mono.push(p); }
  if (mono.length <= max) return mono;
  const step = mono.length / max;
  return Array.from({ length: max }, (_, k) => mono[Math.floor(k * step)]);
}

/** A token range [start, end) as document positions, through the page's token positions */
export function tokenRange(positions: number[], range: [number, number] | null, docSize: number): { from: number; to: number } | null {
  if (!range || !positions.length) return null;
  const a = Math.max(0, Math.min(range[0], positions.length - 1));
  const b = Math.max(a + 1, Math.min(range[1], positions.length));
  const from = Math.min(positions[a], docSize);
  const to = Math.min(positions[b - 1] + 1, docSize);
  return to > from ? { from, to } : null;
}

/**
 * Where y of one pane sits in the other: between the anchors around it, in proportion. `a` and `b`
 * are the anchors' heights in each pane, in order; the pane ends are anchors too.
 */
export function mapOffset(y: number, a: number[], b: number[], endA: number, endB: number): number {
  const xs = [0, ...a, endA];
  const ys = [0, ...b, endB];
  let k = 0;
  while (k < xs.length - 2 && xs[k + 1] <= y) k++;
  const span = xs[k + 1] - xs[k];
  const t = span > 0 ? Math.min(1, Math.max(0, (y - xs[k]) / span)) : 0;
  return ys[k] + t * (ys[k + 1] - ys[k]);
}
