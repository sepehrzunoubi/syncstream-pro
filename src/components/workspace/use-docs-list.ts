/** The user's Google Docs: the list, the selected one, creating and renaming */

import { useCallback, useRef, useState } from "react";
import { postJson } from "./api";
import { readPageDefault } from "./storage";
import type { Doc, Setter } from "./doc-state";

/** Creating a document waits this long for Google, then says it's taking too long */
const CREATE_TIMEOUT_MS = 45_000;

/**
 * The list as the docs route gives it, with what it can't know yet: documents made here that Drive
 * doesn't list yet (it takes a moment after a document is made), and the one selected, which stays
 * in the list while it's selected even once it's no longer among the most recent.
 */
export function mergeDocs(listed: Doc[], made: Doc[], previous: Doc[], selectedId: string): Doc[] {
  const has = new Set(listed.map((d) => d.id));
  const extra: Doc[] = [];
  for (const d of made) if (!has.has(d.id)) { extra.push(d); has.add(d.id); }
  const selected = previous.find((d) => d.id === selectedId);
  if (selected && !has.has(selected.id)) extra.push(selected);
  return [...extra, ...listed];
}

export function useDocsList({ setSnack, setScopeError }: { setSnack: Setter<string | null>; setScopeError: Setter<boolean> }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const [selectedDocId, setSelectedDoc] = useState("");
  /** The tab of it to show ("": its first). Another document opens at its first tab */
  const [selectedTabId, setSelectedTabId] = useState("");
  const current = useRef("");
  current.current = selectedDocId;
  const setSelectedDocId = useCallback((next: string | ((cur: string) => string), tabId?: string) => {
    const id = typeof next === "function" ? next(current.current) : next;
    if (id !== current.current) setSelectedTabId(tabId ?? "");
    else if (tabId != null) setSelectedTabId(tabId);
    current.current = id;
    setSelectedDoc(id);
  }, []);
  const [isCreatingDoc, setIsCreatingDoc] = useState(false);
  /** Documents made here, until Drive lists them */
  const made = useRef<Doc[]>([]);
  /** The document just made, until it is open on the page (it then takes the caret, as in Docs) */
  const createdDocRef = useRef<string | null>(null);
  const creating = useRef(false);

  const renameDoc = useCallback(async (name: string): Promise<boolean> => {
    const id = selectedDocId;
    if (!id) return false;
    const { ok, status, data } = await postJson<{ name: string }>("/api/docs/rename", { documentId: id, name });
    if (!ok) { if (status === 401) setScopeError(true); setSnack(data.error || "Couldn't rename the document"); return false; }
    const rename = (d: Doc) => (d.id === id ? { ...d, name: data.name ?? name } : d);
    made.current = made.current.map(rename);
    setDocs((prev) => prev.map(rename));
    return true;
  }, [selectedDocId, setScopeError, setSnack]);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch("/api/docs");
      if (res.status === 401) { setScopeError(true); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { docs: Doc[] };
      const listed = data.docs || [];
      made.current = made.current.filter((d) => !listed.some((x) => x.id === d.id));
      const list = mergeDocs(listed, made.current, docsRef.current, current.current);
      setDocs(list);
      // The document picked stays picked; with none, the most recent is
      setSelectedDocId((cur) => cur || list[0]?.id || "");
    } catch {
      setSnack("Couldn't load your Google Docs. Try Refresh list.");
    }
  }, [setScopeError, setSnack, setSelectedDocId]);

  /** Make a Google Doc and select it; resolves with its id, or null when it couldn't be made */
  /** A new Google Doc, opened: named `title` (Import PDF names it after the file), else "Untitled document" */
  const createDoc = useCallback(async (title?: string): Promise<string | null> => {
    // One at a time: a second click while Google is making the first would make two
    if (creating.current) return null;
    creating.current = true;
    setIsCreatingDoc(true);
    try {
      const def = readPageDefault();
      let res: Response;
      try {
        res = await fetch("/api/docs/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title?.trim() || "Untitled document", pageSetup: def?.setup, pageless: def?.pageless === true }),
          signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
          // It may still have been made: the list shows it once Drive has it
          setTimeout(() => { void fetchDocs(); }, 5000);
          throw new Error("Google is taking too long to make the document. If it was made, it shows in the list in a moment.");
        }
        throw new Error("You're offline, or Google can't be reached");
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
      if (res.status === 401) throw new Error("Your Google sign-in expired. Choose Reconnect Google account in the account menu.");
      // It may have been made all the same (Google didn't answer in time): the list shows it once Drive has it
      if (res.status >= 500) setTimeout(() => { void fetchDocs(); }, 5000);
      if (!res.ok || !data.id) throw new Error(data.error || "Couldn't create the document");
      const doc: Doc = { id: data.id, name: data.name || title?.trim() || "Untitled document", modifiedTime: new Date().toISOString() };
      made.current = [doc, ...made.current.filter((d) => d.id !== doc.id)];
      setDocs((prev) => [doc, ...prev.filter((d) => d.id !== doc.id)]);
      createdDocRef.current = doc.id;
      setSelectedDocId(doc.id);
      setSnack(`Created "${doc.name}"`);
      return doc.id;
    } catch (err) {
      setSnack(err instanceof Error ? err.message : "Couldn't create the document");
      return null;
    } finally {
      creating.current = false;
      setIsCreatingDoc(false);
    }
  }, [setSnack, setSelectedDocId, fetchDocs]);

  return { docs, selectedDocId, setSelectedDocId, selectedTabId, setSelectedTabId, isCreatingDoc, renameDoc, fetchDocs, createDoc, createdDocRef };
}
