/**
 * The compare engine as the page uses it (src/lib/compare.ts runs in the browser for the preview,
 * and on the server at start from fresh reads). One place for the page's calls into it.
 */

import { applyBreaks, breaksFromMerged, compareDocs } from "@/lib/compare";
import type { CompareBreak, CompareLoadResponse, CompareResult, TabCompare } from "@/lib/compare-types";
import type { EditorNode } from "@/lib/rich-text";

export type Compared = { ok: true; result: CompareResult } | { ok: false; error: string };

/** The comparison of what was loaded, with these changes left out */
export function runCompare(data: CompareLoadResponse, skip: string[]): Compared {
  try {
    return { ok: true, result: compareDocs(data.left, data.right, { tabMap: data.tabMap, skip }) };
  } catch (err) {
    console.error("compare failed", err);
    return { ok: false, error: "Couldn't compare these documents. Try again, or tell us which ones they were." };
  }
}

/** A tab's merged document with its Manual breaks on their words */
export function withBreaks(tab: TabCompare, breaks: CompareBreak[]): EditorNode {
  const mine = breaks.filter((b) => b.rightTabId === tab.rightTabId);
  if (!mine.length) return tab.merged;
  try { return applyBreaks(tab, mine); } catch { return tab.merged; }
}

/** The breaks placed on a tab's page, as the start sends them */
export function breaksOf(tab: TabCompare, page: EditorNode): CompareBreak[] {
  try { return breaksFromMerged(tab, page); } catch { return []; }
}
