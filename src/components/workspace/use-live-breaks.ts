"use client";

/**
 * A running sync's breaks on its live page: where each one is (a pill after its word, with its
 * state), and changing the ones still ahead while it types: add one by clicking a word not typed
 * yet, change a length, remove one or all, end the break it is on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { afterWord, segmentCharTokens } from "@/lib/doc-model";
import { formatBreak, parseBreakLength } from "@/lib/breaks";
import { richFromEditorJSON, type EditorNode } from "@/lib/rich-text";
import type { PublicJob } from "@/lib/sync-store";
import { formatWait } from "@/lib/format";
import { BREAK_PILL_EVENT, BREAK_PLACE_EVENT, setBreakUi, type BreakPillDetail, type LiveBreak } from "./break-marks";
import { offsetToPos, tokenPositions } from "./pagination";
import { isActive } from "./job-status";
import { postJson } from "./api";
import { escapeIsFree } from "./keys";
import type { Setter, Source } from "./doc-state";

export interface LiveBreakRow { index: number; at: number | null; minutes: number; state: LiveBreak["state"]; word?: string }

/** The word a break at source offset `at` follows */
export function wordBefore(text: string, at: number): string {
  let e = Math.min(at, text.length);
  while (e > 0 && /\s/.test(text[e - 1])) e--;
  let b = e;
  while (b > 0 && !/\s/.test(text[b - 1])) b--;
  const w = text.slice(b, e);
  return w.length > 24 ? `${w.slice(0, 23)}…` : w;
}

/** Each of the job's breaks with its state: done, on now, ahead (can change) or being typed */
export function liveRows(job: PublicJob): LiveBreakRow[] {
  const done = new Set(job.completedBreaks);
  const onNow = (job.status === "running" || job.status === "paused") && job.nextBreakAction != null && job.nextBreakAction === job.currentAction;
  const firstOpen = job.breaks.findIndex((_, i) => !done.has(i));
  const from = job.editableFrom ?? 0;
  return job.breaks.map((minutes, index) => {
    const at = job.breakAt?.[index] ?? null;
    const state: LiveBreak["state"] = done.has(index) ? "done" : onNow && index === firstOpen ? "now" : at != null && at >= from && isActive(job) ? "ahead" : isActive(job) ? "locked" : "done";
    return { index, at, minutes, state };
  });
}

export function useLiveBreaks({ viewer, job, source, shown, now, upsertJob, setSnack }: {
  viewer: Editor | null;
  job: PublicJob | null;
  source: Source | undefined;
  /** The part of the source the live page shows (one tab of a sync typing into several): the rest has no place on it */
  shown?: { from: number; to: number } | null;
  now: number;
  upsertJob: (job: PublicJob) => void;
  setSnack: Setter<string | null>;
}) {
  const text = source?.text ?? "";
  const rows = useMemo(() => (job ? liveRows(job).map((r) => (r.at != null && text ? { ...r, word: wordBefore(text, r.at) || undefined } : r)) : []), [job, text]);
  // Syncs started before breaks had places can't have them changed
  const canEdit = !!job && isActive(job) && !!job.breakAt;

  // Character → token → place on the live page
  const map = useMemo(() => {
    const ctx = source?.context;
    if (!ctx?.doc || !ctx.ranges) return null;
    return segmentCharTokens(ctx.doc as EditorNode, ctx.ranges).flat();
  }, [source]);
  const from = shown?.from ?? 0;
  const to = shown?.to ?? text.length;
  const placeOf = useCallback((at: number): number | null => {
    if (!viewer || !text || at <= from || at > to) return null;
    // The pill goes after the word, before the space or line end the break follows
    let g = Math.min(at, text.length) - 1;
    while (g > from && /\s/.test(text[g])) g--;
    if (g < from) return null;
    if (map) {
      const q = map[g - from];
      const positions = tokenPositions(viewer.state.doc);
      return q != null && positions[q] != null ? positions[q] + 1 : null;
    }
    return offsetToPos(viewer.state.doc, g - from + 1);
  }, [viewer, text, map, from, to]);
  /** The source offset a break after the viewer's word [from, to) has */
  const offsetOf = useCallback((end: number): number | null => {
    if (!viewer || !text) return null;
    let g: number | null = null;
    if (map) {
      const positions = tokenPositions(viewer.state.doc);
      const q = positions.lastIndexOf(end - 1);
      if (q >= 0) { const k = map.lastIndexOf(q); if (k >= 0) g = k + from; }
    } else {
      g = richFromEditorJSON(viewer.state.doc.cut(0, end).toJSON() as EditorNode).text.length - 1 + from;
    }
    return g == null || g < 0 ? null : afterWord(text, g);
  }, [viewer, text, map, from]);

  // The pills on the live page
  const liveKey = useRef("");
  useEffect(() => {
    if (!viewer || viewer.isDestroyed) return;
    const live: LiveBreak[] = [];
    if (job) {
      for (const r of rows) {
        if (r.at == null) continue;
        const pos = placeOf(r.at);
        if (pos == null) continue;
        const left = job.status === "paused" ? job.waitLeftMs ?? 0 : job.nextActionAt != null ? job.nextActionAt - now : 0;
        const label = r.state === "done" ? `✓ ${formatBreak(r.minutes)}` : r.state === "now" ? `${formatWait(Math.max(0, left))} left` : formatBreak(r.minutes);
        const title = r.state === "done" ? "This break is over" : r.state === "now" ? "The sync is on this break. Click to end it or change its length." : r.state === "locked" ? "Being typed now: this break can't change" : `A ${formatBreak(r.minutes)} break starts after this word. Click to change it.`;
        live.push({ pos, at: r.at, minutes: r.minutes, state: r.state, label, title });
      }
    }
    const key = JSON.stringify(live);
    if (key === liveKey.current) return;
    liveKey.current = key;
    setBreakUi(viewer.view, { live });
  }, [viewer, job, rows, placeOf, now]);

  // Changing them
  const [sending, setSending] = useState(false);
  const send = useCallback(async (future: { at: number; minutes: number }[], current?: { end: true } | { minutes: number }) => {
    if (!job) return;
    const before = job;
    // Shown at once; the server's answer replaces it
    const kept = rows.filter((r) => r.state !== "ahead");
    const merged = [...kept.map((r) => ({ at: r.at ?? -1, minutes: current && r.state === "now" && "minutes" in current ? current.minutes : r.minutes })), ...future].sort((a, b) => a.at - b.at);
    upsertJob({ ...job, breaks: merged.map((b) => b.minutes), breakAt: merged.map((b) => b.at) });
    setSending(true);
    try {
      const { ok, data } = await postJson<{ job: PublicJob; error?: string }>("/api/sync/breaks", { jobId: job.id, version: job.breaksVersion ?? 0, breaks: future, ...(current ? { current } : {}) });
      if (ok && data.job) upsertJob(data.job);
      else { upsertJob(before); setSnack(data.error || "Couldn't change the breaks"); }
    } catch {
      upsertJob(before);
      setSnack("Couldn't change the breaks. Check your connection.");
    } finally {
      setSending(false);
    }
  }, [job, rows, upsertJob, setSnack]);
  const future = rows.filter((r) => r.state === "ahead" && r.at != null).map((r) => ({ at: r.at!, minutes: r.minutes }));
  const add = (at: number, minutes: number) => send([...future.filter((b) => b.at !== at), { at, minutes }].sort((a, b) => a.at - b.at));
  const remove = (at: number) => send(future.filter((b) => b.at !== at));
  const changeLength = (at: number, minutes: number) => send(future.map((b) => (b.at === at ? { ...b, minutes } : b)));
  const clearFuture = () => send([]);
  const endNow = () => send(future, { end: true });
  const setCurrentLength = (minutes: number) => send(future, { minutes });

  // Placing on the live page: a click on a word not typed yet. Asked for on this sync (a length typed,
  // or Place on page), and over with Done, Esc, another sync or this one finishing
  const [breakLength, setLength] = useState("");
  const minutes = parseBreakLength(breakLength);
  const [placingFor, setPlacingFor] = useState<string | null>(null);
  const placing = canEdit && minutes != null && placingFor === job?.id ? minutes : null;
  const jobId = job?.id ?? null;
  const setBreakLength = useCallback((v: string) => {
    setLength(v);
    if (parseBreakLength(v) != null && jobId && canEdit) setPlacingFor(jobId);
  }, [jobId, canEdit]);
  const endPlacing = useCallback(() => setPlacingFor(null), []);
  const togglePlacing = useCallback(() => setPlacingFor((cur) => (cur === jobId || !canEdit ? null : jobId)), [jobId, canEdit]);
  useEffect(() => { setLength(""); setPlacingFor(null); }, [jobId]);
  useEffect(() => { if (!canEdit) setPlacingFor(null); }, [canEdit]);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed) return;
    setBreakUi(viewer.view, { placing, placeLive: true, hover: null });
  }, [viewer, placing]);
  useEffect(() => {
    if (placing == null) return;
    const onKey = (e: KeyboardEvent) => { if (escapeIsFree(e, ["#ss-live-break-length"])) setPlacingFor(null); };
    const onPlace = (e: Event) => {
      const d = (e as CustomEvent<{ from: number; to: number; minutes: number }>).detail;
      const at = offsetOf(d.to);
      if (at == null || !job) return;
      if (at < (job.editableFrom ?? 0)) { setSnack("That part is already typed: a break can only go after what the sync is typing now"); return; }
      if (at >= text.length) { setSnack("Nothing is typed after the last word"); return; }
      void add(at, d.minutes);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(BREAK_PLACE_EVENT, onPlace);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener(BREAK_PLACE_EVENT, onPlace); };
  });

  // A pill on the live page opens its popover. It names the break by its place, and shows it as it is
  // now: once the break is no longer one that can change (it is being typed, or over), it closes
  const [opened, setOpened] = useState<{ at: number; rect: DOMRect } | null>(null);
  useEffect(() => {
    const onPill = (e: Event) => {
      const d = (e as CustomEvent<BreakPillDetail>).detail;
      if (!d.live || (viewer && d.dom !== viewer.view.dom)) return;
      const row = rows.find((r) => r.at === d.live!.at);
      if (row && (row.state === "ahead" || row.state === "now")) setOpened({ at: d.live.at, rect: d.rect });
    };
    window.addEventListener(BREAK_PILL_EVENT, onPill);
    return () => window.removeEventListener(BREAK_PILL_EVENT, onPill);
  }, [rows, viewer]);
  const openRow = opened ? rows.find((r) => r.at === opened.at && (r.state === "ahead" || r.state === "now")) : undefined;
  const popover = opened && openRow ? { row: openRow, rect: opened.rect } : null;
  useEffect(() => { if (opened && !openRow) setOpened(null); }, [opened, openRow]);
  useEffect(() => { setOpened(null); }, [jobId]);
  const closePopover = useCallback(() => setOpened(null), []);

  return {
    rows, canEdit, sending, breakLength, setBreakLength, minutes, placing, endPlacing, togglePlacing,
    remove, changeLength, clearFuture, endNow, setCurrentLength, popover, closePopover,
  };
}
