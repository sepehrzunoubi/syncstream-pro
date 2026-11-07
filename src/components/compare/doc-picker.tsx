"use client";

/**
 * The two document chips at the top of Compare & Sync, each opening a picker: search the Drive
 * or paste a link, recent documents, and for "Your document" a new blank one.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import * as PO from "@radix-ui/react-popover";
import { Link2, Search } from "lucide-react";
import { Icon } from "../workspace/icon";
import type { Doc } from "../workspace/doc-state";
import { parseDocRef } from "./doc-link";
import type { PickedDoc } from "./storage";

export type Side = "left" | "right";
export const ROLE: Record<Side, string> = { left: "Your document", right: "Reference" };

/** Names compared without case or accents */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** A name with the part that matches what was typed in bold */
function Matched({ name, q }: { name: string; q: string }) {
  const at = q ? fold(name).indexOf(fold(q)) : -1;
  // Folding can change lengths (accents); only mark when it didn't
  if (at < 0 || fold(name).length !== name.length) return <>{name}</>;
  return <>{name.slice(0, at)}<b className="font-medium">{name.slice(at, at + q.length)}</b>{name.slice(at + q.length)}</>;
}

function editedLabel(iso: string): string | undefined {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return undefined;
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
}

/** Drive search, as you type: the documents whose names match */
function useDriveSearch(query: string, enabled: boolean) {
  const [found, setFound] = useState<{ q: string; docs: Doc[] } | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!enabled || !q || parseDocRef(q)) { setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const id = setTimeout(() => {
      fetch(`/api/docs?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { docs?: Doc[] } | null) => { if (Array.isArray(d?.docs)) setFound({ q, docs: d.docs }); })
        .catch(() => { /* recent documents still show */ })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { clearTimeout(id); controller.abort(); };
  }, [query, enabled]);
  return { found, searching };
}

interface Row { key: string; kind: "doc" | "link" | "new"; doc?: PickedDoc; when?: string; disabledWhy?: string }

interface DocChipProps {
  side: Side;
  doc: PickedDoc | null;
  /** The other side's document: picking it too is refused */
  other: PickedDoc | null;
  recent: Doc[];
  recentState: "loading" | "ready" | "failed";
  onPick: (doc: PickedDoc) => void;
  /** Your document only: make a blank Google Doc and use it */
  onCreate?: () => void;
  creating?: boolean;
  /** Opened from outside (the empty state's buttons) */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DocChip(p: DocChipProps) {
  const role = ROLE[p.side];
  return (
    <PO.Root open={p.open} onOpenChange={p.onOpenChange}>
      <PO.Trigger asChild>
        <button type="button" className="ss-cmp-chip" data-side={p.side} data-empty={p.doc ? undefined : "true"} aria-label={`${role}: ${p.doc?.name || "choose a document"}`} title={p.doc?.name ? `${role}: ${p.doc.name}` : `Choose ${p.side === "left" ? "your document" : "the reference"}`}>
          <span className="ss-cmp-chip-icon" aria-hidden="true"><Icon name="description" size={18} /></span>
          <span className="ss-cmp-chip-text">
            <span className="ss-cmp-chip-role">{role}</span>
            <span className="ss-cmp-chip-name">{p.doc ? p.doc.name || "Untitled document" : "Choose a document"}</span>
          </span>
          <Icon name="arrow_drop_down" className="ss-cmp-chip-arrow" />
        </button>
      </PO.Trigger>
      <PO.Portal>
        <PO.Content className="ss-popover ss-cmp-picker" align="start" sideOffset={6} collisionPadding={8} aria-label={`Choose ${p.side === "left" ? "your document" : "the reference"}`}>
          <Picker {...p} />
        </PO.Content>
      </PO.Portal>
    </PO.Root>
  );
}

function Picker(p: DocChipProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const { found, searching } = useDriveSearch(query, true);
  const q = query.trim();
  const link = parseDocRef(q);
  const otherRole = p.side === "left" ? "reference" : "your document";

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const why = (id: string) => (id === p.other?.id ? `Already ${otherRole}` : undefined);
    if (link) {
      const known = [...p.recent, ...(found?.docs ?? [])].find((d) => d.id === link);
      out.push({ key: `link:${link}`, kind: "link", doc: { id: link, name: known?.name ?? "" }, disabledWhy: why(link) });
      return out;
    }
    const seen = new Set<string>();
    const add = (d: Doc) => {
      if (seen.has(d.id)) return;
      seen.add(d.id);
      out.push({ key: d.id, kind: "doc", doc: { id: d.id, name: d.name }, when: editedLabel(d.modifiedTime), disabledWhy: why(d.id) });
    };
    // The Drive's answer first, then recent documents; both narrowed to the name typed
    const match = (d: Doc) => !q || fold(d.name).includes(fold(q));
    if (found && found.q === q) found.docs.filter(match).forEach(add);
    p.recent.filter(match).forEach(add);
    if (p.onCreate && !q) out.push({ key: "new", kind: "new" });
    return out;
  }, [link, p.recent, found, q, p.other?.id, p.onCreate, otherRole]);

  useEffect(() => { setActive(0); }, [q]);
  const pick = (r: Row | undefined) => {
    if (!r || r.disabledWhy) return;
    if (r.kind === "new") { p.onCreate?.(); p.onOpenChange(false); return; }
    if (r.doc) { p.onPick(r.doc); p.onOpenChange(false); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(rows[active]); }
  };
  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, listId]);

  const heading = link ? null : q ? (searching && !rows.length ? "Searching your Drive" : rows.length ? "Matching documents" : null) : "Recent documents";
  return (
    <div className="ss-cmp-picker-body">
      <div className="ss-cmp-search">
        <Search className="ss-cmp-search-icon" aria-hidden="true" />
        <input
          ref={input}
          autoFocus
          className="ss-cmp-search-input"
          placeholder="Search your Drive or paste a link"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
          aria-label="Search your Drive or paste a link"
          spellCheck={false}
          autoComplete="off"
        />
        {searching && <span className="ss-cmp-spinner" role="status" aria-label="Searching" />}
      </div>
      {heading && <div className="ss-cmp-picker-label">{heading}</div>}
      <ul id={listId} role="listbox" className="ss-cmp-picker-list" aria-label={`Documents for ${ROLE[p.side].toLowerCase()}`}>
        {rows.map((r, i) => (
          <li
            key={r.key}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            aria-disabled={r.disabledWhy ? true : undefined}
            className="ss-cmp-picker-row"
            data-active={i === active ? "true" : undefined}
            data-kind={r.kind}
            onMouseMove={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(r)}
          >
            <span className="ss-cmp-picker-icon" aria-hidden="true">
              {r.kind === "new" ? <Icon name="note_add" size={20} /> : r.kind === "link" ? <Link2 className="h-[18px] w-[18px]" /> : <Icon name="description" size={20} />}
            </span>
            <span className="ss-cmp-picker-name">
              {r.kind === "new" ? "New blank document" : r.kind === "link" ? (r.doc?.name ? r.doc.name : "Open the document from this link") : r.doc?.name ? <Matched name={r.doc.name} q={q} /> : "Untitled document"}
              {r.kind === "new" && <span className="ss-cmp-picker-sub">Everything in the reference is typed into it</span>}
              {r.kind === "link" && !r.disabledWhy && <span className="ss-cmp-picker-sub">You need access to it in Google Drive</span>}
            </span>
            {r.disabledWhy ? <span className="ss-cmp-picker-tag">{r.disabledWhy}</span> : r.doc && r.doc.id === p.doc?.id ? <Icon name="check" size={18} className="text-[var(--ss-blue)]" /> : r.when ? <span className="ss-cmp-picker-when">{r.when}</span> : null}
          </li>
        ))}
      </ul>
      {!rows.length && (
        <p className="ss-cmp-picker-empty">
          {p.recentState === "loading" && !q ? "Loading your documents" : p.recentState === "failed" && !q ? "Couldn't load your documents. Paste a link to one instead." : q && searching ? "Searching your Drive" : q ? <>No document named &ldquo;{q}&rdquo;. Try another name, or paste its link.</> : "No documents yet. Paste a link to one."}
        </p>
      )}
      {link && link === p.other?.id && <p className="ss-cmp-picker-note" role="status">That&apos;s already {otherRole}. Pick two different documents.</p>}
    </div>
  );
}
