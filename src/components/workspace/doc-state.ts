/**
 * What the workspace knows about the open Google Doc, shared by the hooks
 * that load it, save it and start syncs into it.
 */

import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { DocDefaults } from "@/lib/doc-import";
import type { EditorNode, RichFormat } from "@/lib/rich-text";
import type { DocTab } from "@/lib/doc-tabs";

export type Doc = { id: string; name: string; modifiedTime: string };

export interface Source { text: string; format: RichFormat | null; context?: { doc?: EditorNode; ranges?: [number, number][] } | null }

/** What is known about the selected document's own content */
export interface DocContent {
  docId: string;
  /** The tab shown (the one asked for while loading); null for a document read without its tabs */
  tabId?: string | null;
  /** The document's tabs, in Docs' order (child tabs after their parent) */
  tabs?: DocTab[];
  status: "loading" | "ready" | "failed";
  revisionId?: string;
  /** The document's own default font, size and heading styles */
  defaults?: DocDefaults;
  /** Why it couldn't be opened */
  error?: string;
}

export type Setter<T> = Dispatch<SetStateAction<T>>;

/** The open document's bookkeeping, read by callbacks and effects without re-rendering */
export interface DocRefs {
  docContentRef: MutableRefObject<DocContent | null>;
  /** The document as last saved to Google Docs, and its revision */
  baseRef: MutableRefObject<EditorNode | null>;
  revisionRef: MutableRefObject<string>;
  /** Text typed before a document was open, to be added at its end */
  legacyTextRef: MutableRefObject<EditorNode | null>;
  contentReq: MutableRefObject<number>;
  contentStale: MutableRefObject<boolean>;
  savingRef: MutableRefObject<Promise<boolean> | null>;
  docBusyRef: MutableRefObject<boolean>;
  retried: MutableRefObject<Set<string>>;
  /** The tab asked for ("": the document's first) */
  tabRef: MutableRefObject<string>;
}

/** The shown tab, as the additions storage and the edit route name it */
export const shownTab = (c: DocContent | null | undefined) => ({ id: c?.tabId ?? null, first: !!c?.tabId && c?.tabs?.[0]?.id === c?.tabId });
/** What an edit posted to /api/docs/edit says about the tab it is in */
export function tabFields(c: DocContent | null | undefined): { tabId?: string; firstTab?: boolean } {
  const t = shownTab(c);
  return t.id ? { tabId: t.id, firstTab: t.first } : {};
}

export function useDocRefs(): DocRefs {
  const docContentRef = useRef<DocContent | null>(null);
  const baseRef = useRef<EditorNode | null>(null);
  const revisionRef = useRef("");
  const legacyTextRef = useRef<EditorNode | null>(null);
  const contentReq = useRef(0);
  const contentStale = useRef(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const docBusyRef = useRef(false);
  const retried = useRef(new Set<string>());
  const tabRef = useRef("");
  return { docContentRef, baseRef, revisionRef, legacyTextRef, contentReq, contentStale, savingRef, docBusyRef, retried, tabRef };
}
