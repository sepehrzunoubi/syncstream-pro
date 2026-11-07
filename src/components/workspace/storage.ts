/**
 * What the workspace keeps in localStorage: the draft (settings, and text
 * typed with no document open), the default page setup for new documents,
 * and each document's additions until a sync types them in.
 */

import type { JSONContent } from "@tiptap/react";
import type { BreaksMode } from "./sync-panel";
import { parsePageSetup, type PageSetup } from "@/lib/page-setup";
import type { EditorNode } from "@/lib/rich-text";
import { plainToDoc } from "./doc-json";

const DRAFT_KEY = "syncstream_draft_v2";
const LEGACY_DRAFT_KEY = "syncstream_draft";

export interface Draft {
  /** Text typed with no document selected (all of it is to be typed) */
  doc?: JSONContent;
  selectedDocId?: string;
  /** The tab of it shown (absent: its first) */
  selectedTabId?: string;
  durationMinutes?: number | null;
  /** "custom" is the old "Choose", which opens as Manual */
  breaksMode?: BreaksMode | "custom";
  /** Old drafts' chosen break lengths (no longer used) */
  customBreaks?: number[];
  /** What was typed in Manual's Break length field */
  breakLength?: string;
  typoFrequency?: number;
  zoom?: number | "fit";
  pageless?: boolean;
  /** Page setup of text typed with no document selected */
  pageSetup?: PageSetup;
}

/** The page setup new documents get (File > Page setup > Set as default) */
const PAGE_DEFAULT_KEY = "syncstream_page_default";
export function readPageDefault(): { setup: PageSetup; pageless: boolean } | null {
  try {
    const raw = localStorage.getItem(PAGE_DEFAULT_KEY);
    const v = raw ? (JSON.parse(raw) as { setup?: unknown; pageless?: unknown }) : null;
    const setup = v ? parsePageSetup(v.setup) : null;
    return setup ? { setup, pageless: v?.pageless === true } : null;
  } catch { return null; }
}
export function writePageDefault(setup: PageSetup, pageless: boolean) {
  try { localStorage.setItem(PAGE_DEFAULT_KEY, JSON.stringify({ setup, pageless })); } catch { /* storage blocked */ }
}

/**
 * Additions made to a document, kept per document tab until they are synced. A document without
 * tabs (and, from before tabs, its first tab's) are kept under the document's id alone.
 */
const ADDITIONS_PREFIX = "syncstream_additions_";
export interface SavedAdditions { revisionId: string; doc: EditorNode }
/** Which tab: its id, and whether it is the document's first */
export interface TabRef { id: string | null | undefined; first?: boolean }

const additionsKey = (docId: string, tabId?: string | null) => ADDITIONS_PREFIX + docId + (tabId ? `#${tabId}` : "");

export function readAdditions(docId: string, tab?: TabRef): SavedAdditions | null {
  try {
    const raw = localStorage.getItem(additionsKey(docId, tab?.id)) ?? (tab?.id && tab.first ? localStorage.getItem(additionsKey(docId)) : null);
    return raw ? (JSON.parse(raw) as SavedAdditions) : null;
  } catch { return null; }
}

export function writeAdditions(docId: string, value: SavedAdditions | null, tab?: TabRef) {
  try {
    if (value) localStorage.setItem(additionsKey(docId, tab?.id), JSON.stringify(value));
    else localStorage.removeItem(additionsKey(docId, tab?.id));
    // The first tab's from before tabs are now under its own id
    if (tab?.id && tab.first) localStorage.removeItem(additionsKey(docId));
  } catch { /* storage full or blocked */ }
}

export function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as Draft;
    const legacy = localStorage.getItem(LEGACY_DRAFT_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as { sourceText?: string; selectedDocId?: string; typoFrequency?: number; durationMinutes?: number | null; customBreaks?: number[]; breaksMode?: BreaksMode | "custom" };
      return { ...old, doc: old.sourceText ? plainToDoc(old.sourceText) : undefined };
    }
  } catch { /* unreadable draft */ }
  return {};
}

/** Write the draft (the caller catches a full or blocked storage) */
export function saveDraft(draft: Draft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  localStorage.removeItem(LEGACY_DRAFT_KEY);
}
