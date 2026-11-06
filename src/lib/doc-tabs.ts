/**
 * Document tabs. Docs read without includeTabsContent gives only the first tab's content, and a
 * write with no tabId goes to the first tab. So the document is always read with every tab, the
 * one to show or type into is picked out of it in the shape the rest of the code reads (body,
 * lists, styles, headers, footers, footnotes and objects at the top), and every write to any other
 * tab names it in each place Docs takes a tabId.
 */

import type { docs_v1 } from "googleapis";

export interface DocTab {
  id: string;
  title: string;
  /** How deep it is nested under other tabs (0 at the top) */
  level: number;
  emoji?: string;
}

/** A tab id as Docs gives them ("t.0", "t.abc123") */
export const isTabId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(v);

/** Every tab in the order Docs lists them, child tabs after their parent */
function flatten(tabs: docs_v1.Schema$Tab[] | undefined, out: docs_v1.Schema$Tab[] = []): docs_v1.Schema$Tab[] {
  for (const t of tabs ?? []) {
    out.push(t);
    flatten(t.childTabs, out);
  }
  return out;
}

export function docTabs(doc: docs_v1.Schema$Document): DocTab[] {
  return flatten(doc.tabs).flatMap((t) => {
    const p = t.tabProperties;
    if (!p?.tabId || !t.documentTab) return [];
    return [{ id: p.tabId, title: p.title || "Untitled tab", level: p.nestingLevel ?? 0, ...(p.iconEmoji ? { emoji: p.iconEmoji } : {}) }];
  });
}

export interface OpenTab {
  /** The document as the rest of the code reads it: this tab's content at the top */
  doc: docs_v1.Schema$Document;
  tabs: DocTab[];
  /** The tab shown; null for a document read without its tabs */
  tabId: string | null;
  /** Whether it is the first tab, which writes reach with no tabId */
  first: boolean;
}

/**
 * The document with one tab's content where a document without tabs has it: `tabId`'s, or the
 * first tab's when none is asked for. Null when the asked-for tab isn't there (deleted).
 */
export function openTab(doc: docs_v1.Schema$Document, tabId?: string | null): OpenTab | null {
  const all = flatten(doc.tabs).filter((t) => t.tabProperties?.tabId && t.documentTab);
  if (!all.length) return tabId ? null : { doc, tabs: [], tabId: null, first: true };
  const tab = tabId ? all.find((t) => t.tabProperties!.tabId === tabId) : all[0];
  if (!tab) return null;
  const d = tab.documentTab!;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tabs, ...rest } = doc;
  return {
    doc: {
      ...rest,
      body: d.body,
      documentStyle: d.documentStyle,
      namedStyles: d.namedStyles,
      lists: d.lists,
      headers: d.headers,
      footers: d.footers,
      footnotes: d.footnotes,
      inlineObjects: d.inlineObjects,
      positionedObjects: d.positionedObjects,
      namedRanges: d.namedRanges,
      suggestedDocumentStyleChanges: d.suggestedDocumentStyleChanges,
      suggestedNamedStylesChanges: d.suggestedNamedStylesChanges,
    },
    tabs: docTabs(doc),
    tabId: tab.tabProperties!.tabId!,
    first: tab === all[0],
  };
}

/** Where a request names a place in the document: each takes the tab it is in */
const PLACES = new Set(["location", "range", "tableStartLocation", "endOfSegmentLocation", "sectionBreakLocation"]);
/** Requests that name the tab themselves */
const OWN_TAB = new Set(["updateDocumentStyle", "deleteHeader", "deleteFooter", "deletePositionedObject", "replaceImage"]);

function mark(v: unknown, tabId: string): unknown {
  if (Array.isArray(v)) return v.map((x) => mark(x, tabId));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const inner = mark(x, tabId);
    out[k] = PLACES.has(k) && inner && typeof inner === "object" && !Array.isArray(inner) ? { ...(inner as object), tabId } : inner;
  }
  return out;
}

/**
 * The requests aimed at a tab: each names it everywhere Docs takes one, so they reach it wherever
 * it has moved. A header or footer with no section given belongs to the tab's own document style:
 * the first tab's is Docs' default, another tab's is reached through its first section break (at
 * index 0). With no tab (a document read without its tabs) they go as they are.
 */
export function inTab<T extends object>(requests: T[], tabId: string | null | undefined, first = false): T[] {
  if (!tabId) return requests;
  return requests.map((r) => {
    const [kind, body] = Object.entries(r)[0] ?? [];
    if (!kind || !body || typeof body !== "object") return r;
    let next = mark(body, tabId) as Record<string, unknown>;
    if (OWN_TAB.has(kind)) next = { ...next, tabId };
    if ((kind === "createHeader" || kind === "createFooter") && !next.sectionBreakLocation && !first) next = { ...next, sectionBreakLocation: { index: 0, tabId } };
    return { [kind]: next } as T;
  });
}
