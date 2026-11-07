/**
 * Compare & Sync: the shapes shared by the compare engine (compare.ts), its routes
 * (/api/compare/load, /api/compare/start) and the Compare & Sync page.
 *
 * LEFT is the document that gets the changes; RIGHT is the reference it is brought up to. The
 * engine finds what RIGHT has that LEFT doesn't and gives, per reference tab, LEFT's content
 * with the missing content put where RIGHT has it, marked as pending additions (`syncAdd`), so the
 * ordinary sync types it, and LEFT's text that RIGHT has too in RIGHT's look (written when the sync
 * starts). Nothing of LEFT is ever deleted or moved.
 */

import type { EditorNode } from "./rich-text";
import type { ImportedDoc, ImportedSegment } from "./doc-import";
import type { PageSetup } from "./page-setup";

/** One tab of a document as compare reads it */
export interface CompareTab {
  id: string;
  title: string;
  /** How deep it is nested (0 at the top) */
  level: number;
  /** The tab it is nested under, null at the top */
  parentId: string | null;
  emoji?: string;
  /** Its place in the document's tab order (parents before their children) */
  index: number;
  /** The tab's content. RIGHT's tabs are imported against the named styles of the tab they go into. */
  doc: ImportedDoc;
}

export interface CompareSide {
  documentId: string;
  name: string;
  revisionId: string;
  tabs: CompareTab[];
}

/** Where a reference tab's content goes */
export type TabTarget =
  /** Into a tab LEFT has. `rename`: LEFT's tab is blank with a default title ("Tab 1") and takes the reference title. */
  | { kind: "tab"; leftTabId: string; rename?: string }
  /** Into a new tab, made when the sync starts, nested where the reference has it */
  | { kind: "new"; title: string; emoji?: string; parentRightTabId: string | null }
  | { kind: "skip" };

/** Reference tab id → where its content goes */
export type TabMap = Record<string, TabTarget>;

export type ChangeKind =
  | "text" // words inside a paragraph LEFT has
  | "paragraph" // whole paragraphs
  | "list" // list items
  | "table" // a whole table
  | "row" // rows added to a table LEFT has
  | "cell" // text inside a table cell LEFT has
  | "image"
  | "pageBreak"
  | "footnote"
  | "header"
  | "footer"
  | "tab" // a new tab
  | "rename" // a blank "Tab 1" takes the reference tab's title
  | "pageSetup" // a blank or new tab takes the reference's page size and margins
  | "format"; // text your document has takes the reference's look (bold, colour, highlight, font, heading, list…)

export interface Change {
  /** Stable for the same two revisions and tab map */
  id: string;
  kind: ChangeKind;
  rightTabId: string;
  /** Words it adds */
  words: number;
  /** A short preview of what it adds */
  preview: string;
  /** Where it goes, for people: "after “Intro”", "at the start", "in a new tab" */
  where: string;
  /** Typed over time by the sync, or set up when the sync starts (tabs, table structure, footnotes, headers) */
  when: "typed" | "start";
  /** Token range in the tab's merged document (doc-model tokenize order), when it has one */
  merged: [number, number] | null;
  /** Token range in the reference tab's document, when it has one */
  right: [number, number] | null;
  /** Reference paragraphs whose look your paragraphs next to it take with it (a heading above added text) */
  restyle?: [number, number][];
}

/** Differences the sync leaves alone */
export type KeptKind =
  | "onlyLeft" // text LEFT has and RIGHT doesn't
  | "formatting" // same text, different look, where it can't be copied (a smart chip's)
  | "paragraphStyle" // same paragraph, different heading/alignment/spacing, where it can't be copied
  | "spelling" // a word spelled a little differently (typo, case, quotes)
  | "moved" // content LEFT has, in another place
  | "spacing" // blank lines or spaces only
  | "tableShape" // a table with other columns or merged cells
  | "header"
  | "footer"
  | "pageSetup"
  | "footnoteText"
  | "leftTab"; // a tab only LEFT has

export interface Kept {
  kind: KeptKind;
  rightTabId: string | null;
  leftTabId: string | null;
  count: number;
  sample?: string;
}

/** Reference content Google Docs gives no way to create; skipped, or copied as its text */
export type UnsupportedKind = "rule" | "toc" | "equation" | "drawing" | "chip" | "floatingImage" | "image" | "checkbox" | "columns" | "other";

export interface Unsupported {
  kind: UnsupportedKind;
  rightTabId: string;
  count: number;
  sample?: string;
  /** Copied as plain text instead (a chip's text) */
  asText?: boolean;
}

export interface TabCompare {
  rightTabId: string;
  rightTitle: string;
  target: TabTarget;
  /** LEFT's tab as it is (an empty document for a new tab): never changed */
  base: EditorNode;
  /** `base` plus the reference's missing content, marked pending; skipped changes left out */
  merged: EditorNode;
  /** For each token of `merged` (doc-model tokenize order): the reference token it copies, or -1 for LEFT's own */
  origin: number[];
  changes: Change[];
  kept: Kept[];
  unsupported: Unsupported[];
  /** Reference token ranges that will be copied (their words or their look), for highlighting the reference */
  rightCopied: [number, number][];
  /** Token ranges of `merged`: your paragraphs that take the reference's look */
  restyled?: [number, number][];
  /** For a new or blank tab: the reference's page setup and headers/footers to create when the sync starts */
  setup?: { pageSetup?: PageSetup; header?: ImportedSegment; footer?: ImportedSegment };
  stats: { words: number; images: number; tables: number; footnotes: number; changes: number; skipped: number; presentPct: number };
}

export interface CompareResult {
  /** In typing order: the reference's tab order, top to bottom */
  tabs: TabCompare[];
  /** LEFT's tabs nothing goes into */
  leftOnlyTabs: { id: string; title: string }[];
  totals: { words: number; images: number; tables: number; footnotes: number; changes: number; newTabs: number; presentPct: number };
}

export interface CompareOptions {
  /** Where each reference tab goes; missing entries are matched automatically */
  tabMap?: TabMap;
  /** Change ids to leave out */
  skip?: string[];
}

/** A manual break placed on a word the sync will type: after reference token `rightToken` of `rightTabId` */
export interface CompareBreak {
  rightTabId: string;
  rightToken: number;
  minutes: number;
}

/** GET /api/compare/load?left=&right=[&map=<json TabMap>] */
export interface CompareLoadResponse {
  left: CompareSide;
  right: CompareSide;
  /** The tab map used to import the reference (automatic where none was given) */
  tabMap: TabMap;
  /** LEFT's edit rights: false when the user can only view it */
  canEdit: boolean;
}

/** POST /api/compare/start */
export interface CompareStartBody {
  leftId: string;
  rightId: string;
  /** The revisions compared: a change since gives 409 so the user reviews again */
  leftRevision: string;
  rightRevision: string;
  tabMap: TabMap;
  skip: string[];
  breaksMode: "auto" | "none" | "manual";
  documentName?: string;
  /** Manual breaks */
  breaks: CompareBreak[];
  /** Automatic mode's total time; null in Manual (natural pace) */
  targetMinutes: number | null;
  /** 0..1, as the sync settings send it */
  typoFrequency: number;
  startInMinutes: number;
  seed: number;
}
