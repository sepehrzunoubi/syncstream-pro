/** The user's Google Docs: the list, the selected one, creating and renaming */

import { useCallback, useRef, useState } from "react";
import { postJson } from "./api";
import { readPageDefault } from "./storage";
import type { Doc, Setter } from "./doc-state";

export function useDocsList({ setSnack, setScopeError }: { setSnack: Setter<string | null>; setScopeError: Setter<boolean> }) {
  const [docs, setDocs] = useState<Doc[]>([]);
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

  const renameDoc = useCallback(async (name: string): Promise<boolean> => {
    const id = selectedDocId;
    if (!id) return false;
    const { ok, status, data } = await postJson<{ name: string }>("/api/docs/rename", { documentId: id, name });
    if (!ok) { if (status === 401) setScopeError(true); setSnack(data.error || "Couldn't rename the document"); return false; }
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, name: data.name ?? name } : d)));
    return true;
  }, [selectedDocId, setScopeError, setSnack]);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch("/api/docs");
      if (res.status === 401) { setScopeError(true); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { docs: Doc[] };
      setDocs(data.docs || []);
      setSelectedDocId((cur) => (cur && data.docs?.some((d) => d.id === cur) ? cur : data.docs?.[0]?.id ?? ""));
    } catch {
      setSnack("Couldn't load your Google Docs. Try Refresh list.");
    }
  }, [setScopeError, setSnack, setSelectedDocId]);

  const createDoc = useCallback(async () => {
    setIsCreatingDoc(true);
    try {
      const { ok, status, data } = await postJson<{ id: string; name: string }>("/api/docs/create", { title: "Untitled document", pageSetup: readPageDefault()?.setup, pageless: readPageDefault()?.pageless === true });
      if (status === 401) throw new Error("Your Google sign-in expired. Choose Reconnect Google account in the account menu.");
      if (!ok) throw new Error(data.error || "Couldn't create the document");
      setDocs((prev) => [{ id: data.id, name: data.name, modifiedTime: new Date().toISOString() }, ...prev]);
      setSelectedDocId(data.id);
      setSnack(`Created "${data.name}"`);
    } catch (err) {
      setSnack(err instanceof Error ? err.message : "Couldn't create the document");
    } finally {
      setIsCreatingDoc(false);
    }
  }, [setSnack, setSelectedDocId]);

  return { docs, selectedDocId, setSelectedDocId, selectedTabId, setSelectedTabId, isCreatingDoc, renameDoc, fetchDocs, createDoc };
}
