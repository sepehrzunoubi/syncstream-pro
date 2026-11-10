"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, FileSpreadsheet, FileText, History, Trash2 } from "lucide-react";
import type { HistoryEntry, JobStatus } from "@/lib/sync-store";
import { Dialog } from "../workspace/dialog";
import { formatSpan } from "@/lib/format";
import { postJson } from "../workspace/api";
import { writeFocusHandoff } from "../compare/storage";

/** Anything can ask for the history to open (Help's neighbour in the menu bar does) */
export const HISTORY_EVENT = "ss-open-history";

type Entry = HistoryEntry & { live?: boolean };
/** Statuses a sync never leaves (the store's own list is server code) */
const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "error", "cancelled"]);

const STATUS_WORDS: Record<JobStatus, string> = { scheduled: "Scheduled", pending: "Starting", running: "In progress", paused: "Paused", done: "Finished", error: "Stopped by an error", cancelled: "Cancelled" };
const STATUS_COLOR: Record<JobStatus, string> = { scheduled: "#8e918f", pending: "#0b57d0", running: "#0b57d0", paused: "#b06000", done: "#146c2e", error: "#b3261e", cancelled: "#8e918f" };

export const entryUrl = (e: Pick<HistoryEntry, "kind" | "documentId" | "tabId">): string =>
  e.kind === "sheet" ? `https://docs.google.com/spreadsheets/d/${e.documentId}/edit` : `https://docs.google.com/document/d/${e.documentId}/edit${e.tabId ? `?tab=${encodeURIComponent(e.tabId)}` : ""}`;

function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "Started 2:14 PM · took 43 min · 1,204 words" */
function detail(e: Entry): string {
  const parts = [`${e.status === "scheduled" ? "Starts" : "Started"} ${timeOf(e.startedAt ?? e.startAt ?? e.createdAt)}`];
  if (e.startedAt && e.finishedAt && e.finishedAt > e.startedAt) parts.push(`took ${formatSpan((e.finishedAt - e.startedAt) / 60_000)}`);
  if (e.kind === "doc" && e.words) parts.push(`${e.words.toLocaleString()} ${e.words === 1 ? "word" : "words"}`);
  if (e.status !== "done" && e.totalChars > 0 && e.charsSent > 0) parts.push(`${Math.min(100, Math.round((e.charsSent / e.totalChars) * 100))}% done`);
  return parts.join(" · ");
}

/**
 * The sync history: every sync started from this account, on any device, newest first. A button for
 * the header, and the dialog it opens.
 */
export function SyncHistory() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<"all" | "doc" | "sheet">("all");
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch("/api/history");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { entries: Entry[]; now: number };
      setEntries(data.entries);
      setNow(data.now ?? Date.now());
    } catch { setFailed(true); }
  }, []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(HISTORY_EVENT, onOpen);
    return () => window.removeEventListener(HISTORY_EVENT, onOpen);
  }, []);
  useEffect(() => { if (open) { setConfirmClear(false); void load(); } }, [open, load]);
  const close = useCallback(() => setOpen(false), []);

  const shown = useMemo(() => (entries ?? []).filter((e) => filter === "all" || e.kind === filter), [entries, filter]);
  const groups = useMemo(() => {
    const out: { label: string; items: Entry[] }[] = [];
    for (const e of shown) {
      const label = dayLabel(e.createdAt, now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(e); else out.push({ label, items: [e] });
    }
    return out;
  }, [shown, now]);

  const remove = async (e: Entry) => {
    setEntries((list) => (list ?? []).filter((x) => x.id !== e.id));
    // A finished sync still in the list goes from there too; one that is running stays
    if (e.live && TERMINAL.has(e.status)) await postJson("/api/sync/dismiss", { jobId: e.id });
    await fetch("/api/history", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id }) }).catch(() => {});
  };
  const clearAll = async () => {
    setConfirmClear(false);
    setEntries((list) => (list ?? []).filter((x) => x.live && !TERMINAL.has(x.status)));
    await fetch("/api/history", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) }).catch(() => {});
    void load();
  };
  const view = (e: Entry) => {
    setOpen(false);
    if (e.kind === "sheet") router.push(`/dashboard/sheets?job=${encodeURIComponent(e.id)}`);
    else { writeFocusHandoff(e.documentId, e.id); if (window.location.pathname === "/dashboard") window.location.reload(); else router.push("/dashboard"); }
  };

  const hasBoth = (entries ?? []).some((e) => e.kind === "sheet") && (entries ?? []).some((e) => e.kind === "doc");
  return (
    <>
      <button type="button" className="ss-icon-btn ss-history-btn" onClick={() => setOpen(true)} title="Sync history" aria-label="Sync history">
        <History className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <Dialog open={open} title="Sync history" onClose={close} width={640} footer={
        <>
          {confirmClear ? (
            <>
              <span className="text-[13px] text-[var(--ss-text-2)]">Forget every finished sync?</span>
              <button type="button" className="ss-btn ss-btn-danger" onClick={() => { void clearAll(); }}>Clear history</button>
              <button type="button" className="ss-btn ss-btn-text" onClick={() => setConfirmClear(false)}>Keep it</button>
            </>
          ) : (
            (entries?.length ?? 0) > 0 && <button type="button" className="ss-btn ss-btn-text" onClick={() => setConfirmClear(true)}>Clear history</button>
          )}
          <span className="flex-1" />
          <button type="button" className="ss-btn ss-btn-filled" onClick={close}>Done</button>
        </>
      }>
        <p className="-mt-1 mb-3 text-[13px] leading-5 text-[var(--ss-text-2)]">Every sync you&apos;ve started with this Google account, on any device.</p>
        {hasBoth && (
          <div className="ss-segmented mb-3 max-w-[320px]" role="group" aria-label="Show">
            {([["all", "All"], ["doc", "Docs"], ["sheet", "Sheets"]] as const).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>
                {filter === v && <span className="ss-seg-pill" />}
                <span className="ss-seg-label">{label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="ss-history-list" aria-live="polite" aria-busy={entries == null && !failed}>
          {failed && <p className="ss-history-empty">Couldn&apos;t load your history. <button type="button" className="ss-link-btn" onClick={() => { void load(); }}>Try again</button></p>}
          {!failed && entries == null && <p className="ss-history-empty">Loading</p>}
          {!failed && entries != null && shown.length === 0 && <p className="ss-history-empty">No syncs yet. The ones you start show up here and stay.</p>}
          {groups.map((g) => (
            <section key={g.label}>
              <h3 className="ss-history-day">{g.label}</h3>
              <ul>
                {g.items.map((e) => (
                  <li key={e.id} className="ss-history-row">
                    <span className="ss-history-icon" data-kind={e.kind}>{e.kind === "sheet" ? <FileSpreadsheet className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> : <FileText className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="ss-history-name">{e.documentName}{e.tabTitle ? <span className="text-[var(--ss-text-3)]"> › {e.tabTitle}</span> : null}</span>
                      <span className="ss-history-line">
                        <span className="ss-history-status" style={{ color: STATUS_COLOR[e.status] }}>{STATUS_WORDS[e.status]}</span>
                        <span> · {detail(e)}</span>
                      </span>
                    </span>
                    {e.live && <button type="button" className="ss-btn ss-btn-text h-8" onClick={() => view(e)} title="Open this sync in SyncStream">View</button>}
                    <a className="ss-icon-btn h-8 w-8" href={entryUrl(e)} target="_blank" rel="noopener noreferrer" title={e.kind === "sheet" ? "Open in Google Sheets" : "Open in Google Docs"} aria-label={`Open ${e.documentName} in Google ${e.kind === "sheet" ? "Sheets" : "Docs"}`}>
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    </a>
                    {(!e.live || TERMINAL.has(e.status)) && (
                      <button type="button" className="ss-icon-btn h-8 w-8" onClick={() => { void remove(e); }} title="Remove from history" aria-label={`Remove ${e.documentName} from history`}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Dialog>
    </>
  );
}
