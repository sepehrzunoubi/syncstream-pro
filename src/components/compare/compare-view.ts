/**
 * What the Compare & Sync page says and draws about a comparison: tab statuses, target choices,
 * plain-language lines for what is left alone, the text a sync will type, and how token ranges
 * of the engine land on the page.
 */

import type { Change, ChangeKind, CompareSide, CompareTab, Kept, TabCompare, TabMap, TabTarget, Unsupported } from "@/lib/compare-types";
import type { EditorNode } from "@/lib/rich-text";
import { afterWord, BREAK_MARK, PENDING_MARK, tokenize } from "@/lib/doc-model";

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
  if (!leftTab) return null;
  // A blank "Tab 1" takes the reference tab's name, as the automatic match does
  const rename = leftTab.doc.empty && isDefaultTabTitle(leftTab.title) && leftTab.title.trim() !== rightTab.title.trim() ? rightTab.title : undefined;
  return { kind: "tab", leftTabId: leftTab.id, ...(rename ? { rename } : {}) };
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
