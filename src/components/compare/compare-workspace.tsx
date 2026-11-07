"use client";

/**
 * Compare & Sync: pick your document and a reference, see your document as it will be after the
 * sync (what's missing glows where it goes) beside the reference (what will be copied
 * highlighted), leave out what you don't want, and start one sync that types only the rest.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ArrowLeftRight, ArrowUpDown, FileX2, Files, KeyRound, TriangleAlert } from "lucide-react";
import type { Change, CompareBreak, CompareLoadResponse, CompareSide, CompareStartBody, TabMap, TabTarget } from "@/lib/compare-types";
import type { PublicJob } from "@/lib/sync-store";
import type { EditorNode } from "@/lib/rich-text";
import { buildDripPlan } from "@/lib/drip-engine";
import { withAnchors } from "@/lib/breaks";
import { randomSeed } from "@/lib/prng";
import type { HeaderUser } from "../workspace/header";
import { Icon } from "../workspace/icon";
import { Menu, MenuItem } from "../workspace/menu";
import { Snackbar, useSnack } from "../workspace/snack";
import { postJson } from "../workspace/api";
import { BREAKS_CLEARED, useManualBreaks } from "../workspace/use-manual-breaks";
import { BreakPopover, PlacingBar } from "../workspace/break-ui";
import { setBreakUi } from "../workspace/break-marks";
import { tokenPositions } from "../workspace/pagination";
import { installLineMetrics } from "../workspace/line-metrics";
import type { Doc } from "../workspace/doc-state";
import { CompareHeader, ZOOMS } from "./compare-header";
import { DocChip, type Side } from "./doc-picker";
import { ComparePane, usePaneEditor, type PaneMarks, type PaneSetup } from "./compare-pane";
import { CompareSidebar } from "./compare-sidebar";
import { ComparePanel } from "./compare-panel";
import { setCompareMarks } from "./compare-marks";
import { anchorPairs, docOf, mapOffset, plural, tokenRange, typedText } from "./compare-view";
import { breaksOf, runCompare, withBreaks } from "./engine";
import { EMPTY_SESSION, loadSession, saveSession, writeFocusHandoff, type CompareSession, type CompareSettings, type PickedDoc } from "./storage";

type Load =
  | { status: "idle" }
  | { status: "loading"; pair: string }
  | { status: "ready"; pair: string; data: CompareLoadResponse; refreshing?: boolean }
  | { status: "error"; pair: string; message: string; code: number };

const ease = [0.2, 0, 0, 1] as const;
const pairOf = (s: CompareSession) => (s.left && s.right ? `${s.left.id}|${s.right.id}` : "");
/** Another pair of documents starts afresh: tab choices, left-out changes and breaks belong to the last pair */
const resetFor = (s: CompareSession, next: Partial<CompareSession>): CompareSession => ({ ...s, ...next, tabMap: {}, skip: [], breaks: [], tab: null });
const CHANGED = "One of the documents changed. Here's the new comparison.";
/**
 * The tab choices the user made, for these documents. Only those are sent: the routes match the
 * rest again the same way (same revisions, same answer), automatic renames of blank tabs included.
 */
const choicesFor = (map: TabMap, right: CompareSide): TabMap => Object.fromEntries(Object.entries(map).filter(([id]) => right.tabs.some((t) => t.id === id)));

/** What a failed load says, in plain words */
function loadError(status: number, error?: string): string {
  if (status === 0) return "You're offline, or Google can't be reached. Check your connection and try again.";
  if (status === 401) return "Your Google sign-in expired. Choose Reconnect Google account in the account menu.";
  if (status === 403) return error || "You don't have access to one of these documents. Ask its owner to share it with you, or pick another.";
  if (status === 404) return error || "One of these documents can't be found. It may have been deleted or moved to the trash.";
  if (status === 429) return "Too many requests in a short time. Wait a moment, then try again.";
  return error || "Couldn't read the documents. Try again in a moment.";
}

export function CompareWorkspace({ user, onSignOut, onReauth }: { user: HeaderUser | null; onSignOut: () => void; onReauth: () => void }) {
  const router = useRouter();
  const [snack, setSnack] = useSnack();
  const [scopeError, setScopeError] = useState(false);
  const [session, setSession] = useState<CompareSession>(EMPTY_SESSION);
  const [restored, setRestored] = useState(false);
  useEffect(() => { setSession(loadSession()); setRestored(true); installLineMetrics(); }, []);
  // Kept as it changes (it's small): a reload or a closed tab right after picking keeps the pick
  useEffect(() => { if (restored) saveSession(session); }, [session, restored]);
  const patch = useCallback((p: Partial<CompareSession>) => setSession((s) => ({ ...s, ...p })), []);
  const { left, right, settings } = session;
  const pair = pairOf(session);

  useEffect(() => { document.title = "Compare & Sync - SyncStream"; }, []);
  const [iconsReady, setIconsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    document.fonts?.load('20px "Material Symbols Outlined"', "check").then((f) => {
      if (!alive || !f.length) return;
      setIconsReady(true);
      // Menus and pickers render outside the workspace; their icons show once the font is in too
      document.documentElement.classList.add("ss-icons-ready");
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Layout: both pages side by side from 1100px, one at a time below; the tabs dock from 1360px
  // (narrower, they open over the pages: the pages need the room), and show by themselves from
  // 1600px (below, two pages beside the tabs and the panel would be too small to read)
  const [wide, setWide] = useState(true);
  const [railWide, setRailWide] = useState(true);
  const [railAuto, setRailAuto] = useState(true);
  useEffect(() => {
    const queries = [1100, 1360, 1600].map((w) => window.matchMedia(`(min-width: ${w}px)`));
    const apply = () => { setWide(queries[0].matches); setRailWide(queries[1].matches); setRailAuto(queries[2].matches); };
    apply();
    for (const q of queries) q.addEventListener("change", apply);
    return () => { for (const q of queries) q.removeEventListener("change", apply); };
  }, []);
  const [railOpen, setRailOpen] = useState<boolean | null>(null);
  const [shown, setShown] = useState<"left" | "right">("left");
  const [zoom, setZoom] = useState<number | "fit">("fit");

  // ── Recent documents, for the pickers ──
  const [recent, setRecent] = useState<Doc[]>([]);
  const [recentState, setRecentState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let alive = true;
    fetch("/api/docs")
      .then(async (r) => {
        if (r.status === 401) { setScopeError(true); throw new Error("401"); }
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { docs?: Doc[] };
      })
      .then((d) => { if (alive) { setRecent(d.docs ?? []); setRecentState("ready"); } })
      .catch(() => { if (alive) setRecentState("failed"); });
    return () => { alive = false; };
  }, []);
  const [picker, setPicker] = useState<Side | null>(null);
  const [creating, setCreating] = useState(false);

  // ── Reading both documents ──
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const loadReq = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const fetchCompare = useCallback(async (opts: { map?: TabMap; keep?: boolean } = {}) => {
    const s = sessionRef.current;
    if (!s.left || !s.right || s.left.id === s.right.id) return;
    const key = pairOf(s);
    const req = ++loadReq.current;
    setLoad((cur) => (opts.keep && cur.status === "ready" && cur.pair === key ? { ...cur, refreshing: true } : { status: "loading", pair: key }));
    const map = opts.map ?? s.tabMap;
    const qs = new URLSearchParams({ left: s.left.id, right: s.right.id });
    if (Object.keys(map).length) qs.set("map", JSON.stringify(map));
    let res: Response;
    try { res = await fetch(`/api/compare/load?${qs}`); } catch { if (req === loadReq.current) setLoad({ status: "error", pair: key, message: loadError(0), code: 0 }); return; }
    const data = (await res.json().catch(() => ({}))) as Partial<CompareLoadResponse> & { error?: string };
    if (req !== loadReq.current) return;
    if (!res.ok || !data.left || !data.right) {
      if (res.status === 401) setScopeError(true);
      setLoad({ status: "error", pair: key, message: loadError(res.status, data.error), code: res.status });
      return;
    }
    const loaded = data as CompareLoadResponse;
    setLoad({ status: "ready", pair: key, data: loaded });
    // The names the documents have now (a pasted link has none until here)
    setSession((cur) => pairOf(cur) !== key ? cur : {
      ...cur,
      left: { id: loaded.left.documentId, name: loaded.left.name },
      right: { id: loaded.right.documentId, name: loaded.right.name },
    });
  }, []);
  // A new pair of documents is read as soon as both are picked (their names changing isn't a new pair)
  useEffect(() => {
    if (!restored) return;
    const [a, b] = pair.split("|");
    if (!pair || a === b) { loadReq.current++; setLoad({ status: "idle" }); return; }
    void fetchCompare();
  }, [restored, pair, fetchCompare]);

  const data = load.status === "ready" ? load.data : null;
  const busy = load.status === "loading" || (load.status === "ready" && !!load.refreshing);

  // ── The comparison: every change (for the list), and with the skipped ones left out ──
  const fullRun = useMemo(() => (data ? runCompare(data, []) : null), [data]);
  const full = fullRun?.ok ? fullRun.result : null;
  const allIds = useMemo(() => new Set(full?.tabs.flatMap((t) => t.changes.map((c) => c.id)) ?? []), [full]);
  const skip = useMemo(() => session.skip.filter((id) => allIds.has(id)), [session.skip, allIds]);
  const skipKey = skip.join("|");
  const skipSet = useMemo(() => new Set(skip), [skip]);
  const appliedRun = useMemo(() => (data && full ? (skip.length ? runCompare(data, skip) : fullRun) : null), [data, full, fullRun, skipKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const applied = appliedRun?.ok ? appliedRun.result : null;
  const compareError = fullRun && !fullRun.ok ? fullRun.error : appliedRun && !appliedRun.ok ? appliedRun.error : null;

  const tabId = applied ? (applied.tabs.some((t) => t.rightTabId === session.tab) ? session.tab : (applied.tabs.find((t) => t.changes.length > 0) ?? applied.tabs[0])?.rightTabId ?? null) : null;
  const tab = applied?.tabs.find((t) => t.rightTabId === tabId) ?? null;
  const fullTab = full?.tabs.find((t) => t.rightTabId === tabId) ?? null;
  const rightTab = data?.right.tabs.find((t) => t.id === tabId) ?? null;
  const multiTab = !!data && (data.left.tabs.length > 1 || data.right.tabs.length > 1);
  useEffect(() => { if (data && railOpen == null) setRailOpen(railAuto && multiTab); }, [data, railOpen, railAuto, multiTab]);
  const showRail = !!data && !!applied && !!railOpen;

  // ── The two pages ──
  const leftEditor = usePaneEditor("Your document after the sync");
  const rightEditor = usePaneEditor("Reference");
  const leftScroll = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const rightScroll = useRef<HTMLDivElement>(null);
  const breaksRef = useRef(session.breaks);
  breaksRef.current = session.breaks;
  const leftKey = data && tab ? `${data.left.revisionId}|${data.right.revisionId}|${tab.rightTabId}|${skipKey}|${JSON.stringify(tab.target)}` : "";
  const leftDoc = useMemo<EditorNode | null>(() => (tab && tab.target.kind !== "skip" ? withBreaks(tab, breaksRef.current) : null), [leftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The reference is read against the styles of the tab it goes into: another target, another read
  const rightKey = data && rightTab ? `${data.right.revisionId}|${rightTab.id}|${JSON.stringify(tab?.target ?? null)}` : "";
  const rightDoc = useMemo(() => (rightTab ? docOf(rightTab.doc.nodes) : null), [rightTab]);
  const leftSetup = useMemo<PaneSetup | null>(() => {
    if (!data || !tab || !rightTab) return null;
    const target = tab.target;
    const into = target.kind === "tab" ? data.left.tabs.find((t) => t.id === target.leftTabId) : null;
    const pageless = (into ?? data.left.tabs[0])?.doc.pageless ?? false;
    // A new or blank tab takes the reference's page setup when the sync starts
    if (!into || into.doc.empty) return { pageSetup: tab.setup?.pageSetup ?? rightTab.doc.pageSetup, pageless, defaults: into?.doc.defaults };
    return { pageSetup: into.doc.pageSetup, pageless, defaults: into.doc.defaults };
  }, [data, tab, rightTab]);
  const rightSetup = useMemo<PaneSetup | null>(() => (rightTab ? { pageSetup: rightTab.doc.pageSetup, pageless: rightTab.doc.pageless, defaults: rightTab.doc.defaults } : null), [rightTab]);
  const leftMarks = useMemo<PaneMarks>(() => ({ blocks: (tab?.changes ?? []).filter((c) => c.kind === "table" && c.merged).map((c) => c.merged![0]) }), [tab]);
  const rightMarks = useMemo<PaneMarks>(() => ({
    copied: tab?.rightCopied ?? [],
    skipped: (fullTab?.changes ?? []).filter((c) => skipSet.has(c.id) && c.right).map((c) => c.right!),
    blocks: (tab?.changes ?? []).filter((c) => c.kind === "table" && c.right).map((c) => c.right![0]),
  }), [tab, fullTab, skipSet]);

  // ── Manual breaks, on the glowing words of your document ──
  const [starting, setStarting] = useState(false);
  const canPlace = !!tab && tab.target.kind !== "skip" && tab.changes.some((c) => c.when === "typed" && c.words > 0);
  const setBreakLength = useCallback((v: React.SetStateAction<string>) => setSession((s) => ({ ...s, settings: { ...s.settings, breakLength: typeof v === "function" ? v(s.settings.breakLength) : v } })), []);
  const manual = useManualBreaks({ editor: leftEditor, breaksMode: settings.breaksMode, breakLength: settings.breakLength, setBreakLength, docKey: leftKey, active: !starting && !busy, canPlace: !!leftDoc && canPlace, setSnack });
  // The page's breaks are kept by reference position, so they survive a new comparison
  const leftLoaded = useRef("");
  const rowsKey = JSON.stringify(manual.rows.map((r) => [r.from, r.to, r.minutes]));
  useEffect(() => {
    if (!leftEditor || !tab || leftLoaded.current !== leftKey) return;
    const mine = breaksOf(tab, leftEditor.getJSON() as EditorNode);
    setSession((s) => {
      const rest = s.breaks.filter((b) => b.rightTabId !== tab.rightTabId);
      const before = s.breaks.filter((b) => b.rightTabId === tab.rightTabId);
      return JSON.stringify(before) === JSON.stringify(mine) ? s : { ...s, breaks: [...rest, ...mine] };
    });
  }, [rowsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const elsewhere = session.breaks.filter((b) => b.rightTabId !== tabId && applied?.tabs.some((t) => t.rightTabId === b.rightTabId)).length;

  // ── Pointing out a change on both pages ──
  const [activeChange, setActiveChange] = useState<string | null>(null);
  const flashN = useRef(0);
  /** Scroll events to ignore until then: the one pane moved to follow the other, or both while a change is shown */
  const lock = useRef<{ side: "left" | "right" | "both"; until: number }>({ side: "both", until: 0 });
  const quiet = (side: "left" | "right" | "both", ms: number) => { lock.current = { side, until: performance.now() + ms }; };
  const locked = (side: "left" | "right") => performance.now() < lock.current.until && (lock.current.side === "both" || lock.current.side === side);
  const pendingJump = useRef<Change | null>(null);
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reveal = useCallback((editor: typeof leftEditor, scroller: HTMLDivElement | null, range: [number, number] | null) => {
    if (!editor || editor.isDestroyed || !scroller || !range) return false;
    const r = tokenRange(tokenPositions(editor.state.doc), range, editor.state.doc.content.size);
    if (!r) return false;
    const n = ++flashN.current;
    setCompareMarks(editor.view, { flash: { ...r, n } });
    setTimeout(() => { if (!editor.isDestroyed && flashN.current === n) setCompareMarks(editor.view, { flash: null }); }, 1800);
    if (!scroller.offsetParent) return true;
    const at = editor.view.coordsAtPos(r.from);
    const box = scroller.getBoundingClientRect();
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + at.top - box.top - scroller.clientHeight * 0.3), behavior: reduceMotion() ? "auto" : "smooth" });
    return true;
  }, []);
  const canvasRef = useRef<HTMLElement>(null);
  const doJump = useCallback((c: Change) => {
    quiet("both", 900);
    // The change as the page has it now (a left-out change is only on the reference)
    const merged = tab?.changes.find((x) => x.id === c.id)?.merged ?? null;
    const behavior = reduceMotion() ? "auto" : "smooth";
    const show = () => {
      const onLeft = reveal(leftEditor, leftScroll.current, merged);
      const onRight = reveal(rightEditor, rightScroll.current, c.right);
      if (!onLeft && !onRight) {
        leftScroll.current?.scrollTo({ top: 0, behavior });
        rightScroll.current?.scrollTo({ top: 0, behavior });
      }
    };
    if (wide) { show(); return; }
    // One page at a time: the one that has it comes up, and the pages come into view
    setShown(merged && !skipSet.has(c.id) ? "left" : c.right ? "right" : "left");
    canvasRef.current?.scrollIntoView({ behavior, block: "start" });
    setTimeout(show, 60);
  }, [tab, reveal, leftEditor, rightEditor, wide, skipSet]);
  const jump = useCallback((c: Change) => {
    setActiveChange(c.id);
    if (c.rightTabId !== tabId) { pendingJump.current = c; patch({ tab: c.rightTabId }); return; }
    doJump(c);
  }, [tabId, doJump, patch]);
  // After the tab of a change opens, point it out
  const [paneReady, setPaneReady] = useState({ left: "", right: "" });
  useEffect(() => {
    const c = pendingJump.current;
    if (!c || c.rightTabId !== tabId || paneReady.left !== leftKey || paneReady.right !== rightKey) return;
    pendingJump.current = null;
    requestAnimationFrame(() => doJump(c));
  }, [paneReady, leftKey, rightKey, tabId, doJump]);

  // ── Scrolling both pages together, by the content they share ──
  const anchors = useRef<{ key: string; a: number[]; b: number[] } | null>(null);
  const measureAnchors = useCallback(() => {
    const ls = leftScroll.current, rs = rightScroll.current;
    if (!leftEditor || !rightEditor || !tab || !ls || !rs) return null;
    const key = `${leftKey}|${rightKey}|${ls.scrollHeight}|${rs.scrollHeight}|${zoom}`;
    if (anchors.current?.key === key) return anchors.current;
    const lp = tokenPositions(leftEditor.state.doc), rp = tokenPositions(rightEditor.state.doc);
    const lt = ls.getBoundingClientRect().top - ls.scrollTop, rt = rs.getBoundingClientRect().top - rs.scrollTop;
    const a: number[] = [], b: number[] = [];
    for (const [m, r] of anchorPairs(tab.origin)) {
      const pl = lp[Math.min(m, lp.length - 1)], pr = rp[Math.min(r, rp.length - 1)];
      if (pl == null || pr == null) continue;
      try {
        const ya = leftEditor.view.coordsAtPos(pl).top - lt, yb = rightEditor.view.coordsAtPos(pr).top - rt;
        if ((!a.length || ya >= a[a.length - 1]) && (!b.length || yb >= b[b.length - 1])) { a.push(ya); b.push(yb); }
      } catch { /* a position the page can't draw yet */ }
    }
    anchors.current = { key, a, b };
    return anchors.current;
  }, [leftEditor, rightEditor, tab, leftKey, rightKey, zoom]);
  const follow = useCallback((from: "left" | "right") => {
    if (!session.scrollSync || !wide || locked(from)) return;
    const src = from === "left" ? leftScroll.current : rightScroll.current;
    const dst = from === "left" ? rightScroll.current : leftScroll.current;
    const m = measureAnchors();
    if (!src || !dst || !m) return;
    const eye = src.clientHeight * 0.35;
    const y = mapOffset(src.scrollTop + eye, from === "left" ? m.a : m.b, from === "left" ? m.b : m.a, src.scrollHeight, dst.scrollHeight);
    quiet(from === "left" ? "right" : "left", 80);
    dst.scrollTop = Math.max(0, y - eye);
  }, [session.scrollSync, wide, measureAnchors]);
  const frame = useRef(0);
  const onScroll = (side: "left" | "right") => () => {
    if (locked(side)) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => follow(side));
  };

  // ── Picking documents ──
  const [notice, setNotice] = useState<string | null>(null);
  const pick = useCallback((side: Side, doc: PickedDoc) => {
    const s = sessionRef.current;
    if ((side === "left" ? s.right : s.left)?.id === doc.id) { setSnack("Pick two different documents"); return; }
    if ((side === "left" ? s.left : s.right)?.id === doc.id) return;
    setSession((cur) => resetFor(cur, side === "left" ? { left: doc } : { right: doc }));
    setRailOpen(null);
    setNotice(null);
  }, [setSnack]);
  const swap = useCallback(() => { setSession((s) => resetFor(s, { left: s.right, right: s.left })); setRailOpen(null); setNotice(null); }, []);
  const clearAll = useCallback(() => { setSession((s) => resetFor(s, { left: null, right: null })); setRailOpen(null); setNotice(null); }, []);
  const createBlank = useCallback(async () => {
    setCreating(true);
    try {
      const name = sessionRef.current.right?.name ? `Copy of ${sessionRef.current.right.name}` : "Untitled document";
      const { ok, status, data: d } = await postJson<{ id: string; name: string }>("/api/docs/create", { title: name });
      if (status === 401) { setScopeError(true); throw new Error("Your Google sign-in expired. Choose Reconnect Google account in the account menu."); }
      if (!ok) throw new Error(d.error || "Couldn't create the document");
      setRecent((r) => [{ id: d.id, name: d.name, modifiedTime: new Date().toISOString() }, ...r]);
      pick("left", { id: d.id, name: d.name });
      setSnack(`Created "${d.name}"`);
    } catch (err) {
      setSnack(err instanceof Error ? err.message : "Couldn't create the document");
    } finally {
      setCreating(false);
    }
  }, [pick, setSnack]);

  // ── Tab choices, skipped changes, settings ──
  const setTarget = useCallback((rightTabId: string, target: TabTarget) => {
    if (!data) return;
    const tabMap = { ...choicesFor(sessionRef.current.tabMap, data.right), [rightTabId]: target };
    patch({ tabMap });
    // The reference is read again against the styles of the tab it now goes into
    void fetchCompare({ map: tabMap, keep: true });
  }, [data, patch, fetchCompare]);
  const toggleSkip = useCallback((id: string) => setSession((s) => ({ ...s, skip: s.skip.includes(id) ? s.skip.filter((x) => x !== id) : [...s.skip, id] })), []);
  const skipAll = useCallback((ids: string[], on: boolean) => setSession((s) => ({ ...s, skip: on ? Array.from(new Set([...s.skip, ...ids])) : s.skip.filter((x) => !ids.includes(x)) })), []);
  const setSettings = useCallback((p: Partial<CompareSettings>) => setSession((s) => ({ ...s, settings: { ...s.settings, ...p } })), []);
  const [seed, setSeed] = useState(() => randomSeed());

  // ── How long it takes: the same plan the sync will make, near enough ──
  const breaksKey = JSON.stringify(session.breaks);
  const plan = useMemo(() => {
    if (!applied) return null;
    const tabs = applied.tabs.filter((t) => t.target.kind !== "skip");
    const { text, anchors: at } = typedText(tabs.map((t) => withBreaks(t, settings.breaksMode === "manual" ? session.breaks : [])));
    if (!text.trim()) return null;
    const manualMode = settings.breaksMode === "manual";
    const p = buildDripPlan(text, { targetMinutes: manualMode ? null : settings.durationMinutes, breaks: settings.breaksMode === "auto" ? "auto" : [], typoFrequency: settings.typoFrequency, seed });
    return manualMode ? withAnchors(p, at) : p;
  }, [applied, settings.breaksMode, settings.durationMinutes, settings.typoFrequency, seed, breaksKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Start ──
  const [startError, setStartError] = useState<string | null>(null);
  useEffect(() => { setStartError(null); }, [pair]);
  const blocked = !data ? "Pick both documents first" : !data.canEdit ? "You can only view your document, so it can't be changed" : busy ? "Reading the documents" : null;
  const start = useCallback(async () => {
    if (!data || !applied || starting || blocked) return;
    setStarting(true);
    setStartError(null);
    setNotice(null);
    try {
      const manualMode = settings.breaksMode === "manual";
      const typedTabs = new Set(applied.tabs.filter((t) => t.target.kind !== "skip").map((t) => t.rightTabId));
      const breaks: CompareBreak[] = manualMode ? sessionRef.current.breaks.filter((b) => typedTabs.has(b.rightTabId)) : [];
      const body: CompareStartBody = {
        leftId: data.left.documentId,
        rightId: data.right.documentId,
        leftRevision: data.left.revisionId,
        rightRevision: data.right.revisionId,
        tabMap: choicesFor(sessionRef.current.tabMap, data.right),
        skip,
        breaksMode: settings.breaksMode,
        documentName: data.left.name,
        breaks,
        targetMinutes: manualMode ? null : settings.durationMinutes,
        typoFrequency: settings.typoFrequency,
        startInMinutes: settings.startInMinutes,
        seed,
      };
      const { ok, status, data: res } = await postJson<{ job: PublicJob; code?: string }>("/api/compare/start", body);
      if (status === 401) { setScopeError(true); throw new Error("Your Google sign-in expired. Choose Reconnect Google account in the account menu."); }
      if (status === 409 && res.code === "changed") {
        // Read both again; the tab choices, left-out changes and breaks carry over (they go by the reference)
        await fetchCompare({ keep: true });
        setNotice(CHANGED);
        // The notice is in the panel; one page at a time, the panel may be out of view
        if (!wide) setSnack(CHANGED);
        return;
      }
      if (!ok || !res.job) throw new Error(res.error || `Couldn't start the sync (HTTP ${status})`);
      writeFocusHandoff(data.left.documentId, res.job.id);
      // The changes now belong to the sync; the editor opens on it
      setSession((s) => ({ ...s, skip: [], breaks: [], settings: { ...s.settings, startInMinutes: 0 } }));
      router.push("/dashboard");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Couldn't start the sync");
    } finally {
      setStarting(false);
    }
  }, [data, applied, starting, blocked, settings, skip, seed, fetchCompare, router, setSnack, wide]);
  // Starting ends placing breaks; so does a new comparison
  useEffect(() => { if (leftEditor && !leftEditor.isDestroyed) setBreakUi(leftEditor.view, { hover: null }); }, [leftEditor, leftKey]);

  // ── What the page says ──
  const status = !left && !right ? "Pick your document and the reference"
    : !right ? "Now pick the reference"
    : !left ? "Now pick your document"
    : left.id === right.id ? "Pick two different documents"
    : load.status === "loading" ? "Reading both documents"
    : load.status === "error" || compareError ? "Couldn't compare"
    : applied ? (applied.totals.changes ? `${applied.totals.words ? plural(applied.totals.words, "word") : plural(applied.totals.changes, "change")} to add` : "Up to date")
    : null;

  const strip = (
    <div className="ss-noprint ss-toolbar-wrap">
      <div className="ss-toolbar ss-cmp-strip" role="toolbar" aria-label="Documents">
        {data && !showRail && (
          <button type="button" className={`ss-icon-btn ss-cmp-tabs-btn ${multiTab ? "ss-cmp-tool" : ""}`} onClick={() => setRailOpen(true)} title="Show the reference's tabs" aria-label="Show tabs">
            <Icon name="notes" />
            {multiTab && <span className="ss-cmp-tool-label">{plural(data.right.tabs.length, "tab")}</span>}
          </button>
        )}
        <DocChip side="left" doc={left} other={right} recent={recent} recentState={recentState} onPick={(d) => pick("left", d)} onCreate={() => { void createBlank(); }} creating={creating} open={picker === "left"} onOpenChange={(o) => setPicker(o ? "left" : null)} />
        <span className="ss-cmp-flow" title="What the reference has and your document lacks is typed into your document" aria-hidden="true"><Icon name="arrow_back" size={18} /></span>
        <DocChip side="right" doc={right} other={left} recent={recent} recentState={recentState} onPick={(d) => pick("right", d)} open={picker === "right"} onOpenChange={(o) => setPicker(o ? "right" : null)} />
        <button type="button" className="ss-icon-btn ss-cmp-swap" onClick={swap} disabled={!left && !right} title="Swap the documents" aria-label="Swap the documents">
          <ArrowLeftRight className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
        <span className="ss-cmp-strip-gap" />
        {wide && applied && (
          <button type="button" className="ss-icon-btn ss-cmp-tool" data-on={session.scrollSync ? "true" : undefined} aria-pressed={session.scrollSync} aria-label="Scroll together" onClick={() => patch({ scrollSync: !session.scrollSync })} title={session.scrollSync ? "Scrolling both pages together. Click to scroll each on its own" : "Scroll both pages together"}>
            <ArrowUpDown className="h-[18px] w-[18px]" strokeWidth={1.75} />
            <span className="ss-cmp-tool-label">Scroll together</span>
          </button>
        )}
        {applied && <Menu label="Zoom" trigger={
          <button type="button" className="ss-select-btn ss-zoom-btn" title="Zoom" aria-label={`Zoom: ${zoom === "fit" ? "Fit" : `${zoom}%`}`}>
            <span className="ss-caption">{zoom === "fit" ? "Fit" : `${zoom}%`}</span>
            <Icon name="arrow_drop_down" />
          </button>
        }>
          <MenuItem checkable checked={zoom === "fit"} onSelect={() => setZoom("fit")}>Fit</MenuItem>
          {ZOOMS.map((z) => <MenuItem key={z} checkable checked={zoom === z} onSelect={() => setZoom(z)}>{z}%</MenuItem>)}
        </Menu>}
      </div>
    </div>
  );

  const rail = data && full ? (
    <CompareSidebar left={data.left} right={data.right} result={full} tabMap={busy ? { ...data.tabMap, ...session.tabMap } : data.tabMap} skip={skipSet} selected={tabId} onSelect={(id) => { patch({ tab: id }); if (!railWide) setRailOpen(false); }} onTarget={setTarget} busy={busy} onHide={() => setRailOpen(false)} />
  ) : null;

  const ready = !!data && !!applied && !!full;
  const placeholderLeft = tab?.target.kind === "skip" ? (
    <div className="ss-cmp-pane-note">
      <p className="ss-cmp-note-title">This tab isn&apos;t copied</p>
      <p className="ss-cmp-sub">&ldquo;{tab.rightTitle}&rdquo; stays out of your document.</p>
      <button type="button" className="ss-btn ss-btn-outlined mt-4" onClick={() => setTarget(tab.rightTabId, { kind: "new", title: tab.rightTitle, ...(rightTab?.emoji ? { emoji: rightTab.emoji } : {}), parentRightTabId: rightTab?.parentId ?? null })}>Copy it as a new tab</button>
    </div>
  ) : null;
  // The tab as it will be after the sync: a blank "Tab 1" already under the name it takes
  const leftTitleTab = !multiTab || !tab ? null
    : tab.target.kind === "tab" ? tab.target.rename ?? data!.left.tabs.find((t) => t.id === (tab.target as { leftTabId: string }).leftTabId)?.title ?? null
    : tab.target.kind === "new" ? `${tab.rightTitle} (new tab)` : null;

  const canvas = (() => {
    if (!left || !right) return <EmptyState left={left} right={right} onPick={setPicker} />;
    if (left.id === right.id) return <Problem icon={lucideBig(Files)} title="Pick two different documents" body="Your document and the reference are the same document. Choose another one for either side." actions={<button type="button" className="ss-btn ss-btn-outlined" onClick={() => setPicker("right")}>Choose the reference</button>} />;
    if (load.status === "error") {
      const again = <button type="button" className="ss-btn ss-btn-tonal" onClick={() => { void fetchCompare(); }}><Icon name="refresh" />Try again</button>;
      if (load.code === 401) {
        return <Problem icon={lucideBig(KeyRound)} title="Reconnect your Google account" body="Your Google sign-in expired, so SyncStream can't read your documents. Sign in again and the comparison carries on." actions={<button type="button" className="ss-btn ss-btn-filled" onClick={onReauth}>Reconnect Google account</button>} />;
      }
      if (load.code === 403 || load.code === 404) {
        // The route names the document it couldn't open
        const side: Side = /your document/i.test(load.message) ? "left" : "right";
        return (
          <Problem icon={load.code === 403 ? <Icon name="lock" size={28} /> : lucideBig(FileX2)} title={`${load.code === 403 ? "No access to" : "Can't find"} ${side === "left" ? "your document" : "the reference"}`} body={load.message} actions={
            <>
              <button type="button" className="ss-btn ss-btn-tonal" onClick={() => setPicker(side)}>{side === "left" ? "Choose another document" : "Choose another reference"}</button>
              <button type="button" className="ss-btn ss-btn-text" onClick={() => { void fetchCompare(); }}>Try again</button>
            </>
          } />
        );
      }
      return <Problem icon={<Icon name="cloud_off" size={28} />} title="Couldn't read the documents" body={load.message} actions={again} />;
    }
    if (compareError) return <Problem icon={lucideBig(TriangleAlert)} title="Couldn't compare these documents" body={compareError} actions={<button type="button" className="ss-btn ss-btn-tonal" onClick={() => { void fetchCompare(); }}><Icon name="refresh" />Try again</button>} />;
    const loading = load.status === "loading" || !ready;
    return (
      <>
        {!wide && (
          <div className="ss-cmp-switch">
            <div className="ss-segmented" role="group" aria-label="Page shown">
              {([["left", "Your document"], ["right", "Reference"]] as const).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={shown === v} onClick={() => setShown(v)}>
                  {shown === v && <motion.span layoutId="ss-cmp-pane-pill" className="ss-seg-pill" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                  <span className="ss-seg-label">{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="ss-cmp-panes" data-wide={wide ? "true" : undefined}>
          <AnimatePresence>
            {load.status === "ready" && load.refreshing && <motion.div key="bar" className="ss-cmp-refresh" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="progressbar" aria-label="Comparing again" />}
          </AnimatePresence>
          <ComparePane
            className={!wide && shown !== "left" ? "ss-cmp-hidden" : ""}
            editor={leftEditor}
            title="Your document · after the sync"
            tabTitle={showRail && railWide ? null : leftTitleTab}
            legend={ready && tab && tab.target.kind !== "skip" ? <><span className="ss-cmp-swatch" aria-hidden="true">Aa</span>{tab.stats.words ? `${plural(tab.stats.words, "word")} to add` : tab.changes.length ? "New parts glow" : "Nothing to add here"}</> : null}
            doc={leftDoc}
            docKey={leftKey}
            glow
            setup={leftSetup}
            zoom={zoom}
            marks={leftMarks}
            loading={loading}
            placeholder={placeholderLeft}
            scrollerRef={leftScroll}
            onScroll={onScroll("left")}
            onLoaded={() => { leftLoaded.current = leftKey; setPaneReady((r) => ({ ...r, left: leftKey })); }}
            overlay={<AnimatePresence>{manual.placing != null && <PlacingBar key="placing" minutes={manual.placing} onDone={manual.endPlacing} />}</AnimatePresence>}
          />
          <ComparePane
            className={!wide && shown !== "right" ? "ss-cmp-hidden" : ""}
            editor={rightEditor}
            title="Reference"
            tabTitle={multiTab && !(showRail && railWide) ? rightTab?.title : null}
            legend={ready && tab ? <><span className="ss-cmp-swatch" aria-hidden="true">Aa</span>{tab.rightCopied.length ? "Highlighted parts are copied" : "Nothing here is copied"}</> : null}
            doc={rightDoc}
            docKey={rightKey}
            glow={false}
            setup={rightSetup}
            zoom={zoom}
            marks={rightMarks}
            loading={loading}
            scrollerRef={rightScroll}
            onScroll={onScroll("right")}
            onLoaded={() => setPaneReady((r) => ({ ...r, right: rightKey }))}
          />
        </div>
      </>
    );
  })();

  const panelNotice = (
    <>
      {scopeError && !(load.status === "error" && load.code === 401) && (
        <div className="ss-cmp-banner" data-tone="error">
          Google didn&apos;t give SyncStream access to your documents.
          <a href="/api/auth/login" className="mt-1 block font-medium underline">Reconnect Google account</a>
        </div>
      )}
      {data && !data.canEdit && (
        <div className="ss-cmp-banner" data-tone="warn" role="status">
          You can only view &ldquo;{data.left.name}&rdquo;, so the sync can&apos;t type into it. Pick a document you can edit, or ask its owner for edit access.
        </div>
      )}
      <AnimatePresence initial={false}>
        {notice && (
          <motion.div key="notice" className="ss-cmp-banner" data-tone="info" role="status" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease }}>
            <span className="flex-1">{notice}</span>
            <button type="button" className="ss-icon-btn h-7 w-7 rounded-full" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="close" size={18} /></button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );

  const panel = ready && !compareError && load.status !== "error" ? (
    <ComparePanel
      result={applied!}
      full={full!}
      reference={data!.right}
      skip={skipSet}
      onToggleSkip={toggleSkip}
      onSkipAll={skipAll}
      onJump={jump}
      activeChange={activeChange}
      settings={settings}
      onSettings={setSettings}
      manual={{ rows: manual.rows, elsewhere, onRemove: manual.remove, onClear: manual.clear, onHover: manual.hover, onJump: (r) => { quiet("both", 900); manual.jump(r); }, canPlace: manual.canPlace, placing: manual.placing != null, onTogglePlacing: manual.togglePlacing, onLength: manual.editLength }}
      plan={plan}
      onShuffle={() => setSeed(randomSeed())}
      onStart={() => { void start(); }}
      starting={starting}
      blocked={blocked}
      startError={startError}
      notice={panelNotice}
    />
  ) : (
    <PanelIdle loading={!!left && !!right && left.id !== right.id && (load.status === "loading" || (load.status === "ready" && !ready))} notice={panelNotice} />
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className={`ss-workspace ss-cmp ${iconsReady ? "ss-icons-ready" : ""}`}>
        <CompareHeader
          user={user}
          status={status}
          onReauth={onReauth}
          onSignOut={onSignOut}
          menus={{
            left, right, canCompare: !!pair && left?.id !== right?.id,
            onNew: clearAll, onSwap: swap, onReload: () => { void fetchCompare({ keep: true }); },
            scrollSync: session.scrollSync, onToggleScrollSync: () => patch({ scrollSync: !session.scrollSync }),
            tabsOpen: showRail, onToggleTabs: () => setRailOpen((o) => !o),
            zoom, onZoom: setZoom,
          }}
        />
        {strip}
        <div className="ss-body ss-cmp-body">
          <AnimatePresence initial={false}>
            {showRail && railWide && (
              <motion.div key="rail" className="ss-rail-docked ss-cmp-rail h-full flex-none overflow-hidden" initial={{ width: 0, opacity: 0 }} animate={{ width: 264, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.22, ease }}>
                {rail}
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {showRail && !railWide && (
              <motion.div key="drawer" className="fixed inset-0 z-50 flex" role="dialog" aria-label="Tabs">
                <motion.div className="h-full bg-[var(--ss-canvas)] shadow-xl" initial={{ x: -300 }} animate={{ x: 0 }} exit={{ x: -300 }} transition={{ type: "spring", stiffness: 420, damping: 40 }}>
                  {rail}
                </motion.div>
                <motion.button className="flex-1 bg-black/30" aria-label="Close tabs" onClick={() => setRailOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
              </motion.div>
            )}
          </AnimatePresence>
          <main ref={canvasRef} className="ss-cmp-canvas" aria-label="Pages">{canvas}</main>
          <aside ref={asideRef} className="ss-cmp-aside" aria-label="Changes and sync settings">{panel}</aside>
        </div>
        <AnimatePresence>
          {!wide && applied && !compareError && load.status === "ready" && (
            <motion.div key="bar" className="ss-cmp-mobilebar" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} transition={{ type: "spring", stiffness: 420, damping: 38 }}>
              <button type="button" className="ss-cmp-mobilebar-text" onClick={() => asideRef.current?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" })}>
                <span className="ss-cmp-mobilebar-big">{applied.totals.changes ? status : "Already up to date"}</span>
                <span className="ss-cmp-mobilebar-sub">{applied.totals.changes ? "Review the changes" : "See what stays as it is"}</span>
              </button>
              {applied.totals.changes > 0 && (
                <button type="button" className="ss-btn ss-btn-filled px-5" onClick={() => { void start(); }} disabled={starting || !!blocked} title={blocked ?? undefined}>
                  {starting ? <span className="ss-cmp-spinner ss-cmp-spinner-light" aria-hidden="true" /> : <Icon name="play_arrow" />}
                  {starting ? "Starting" : settings.startInMinutes > 0 ? "Schedule" : "Start sync"}
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <Snackbar snack={snack} action={snack === BREAKS_CLEARED ? { label: "Undo", run: manual.undoClear } : null} onDismiss={() => setSnack(null)} />
        {manual.popover && (
          <BreakPopover
            key={`${manual.popover.from}-${manual.popover.to}`}
            rect={manual.popover.rect}
            minutes={manual.popover.minutes}
            onSave={(m) => manual.changeLength(manual.popover!, m)}
            onRemove={() => manual.removeAt(manual.popover!)}
            onClose={manual.closePopover}
          />
        )}
      </div>
    </MotionConfig>
  );
}

/** Before both documents are picked: what this is, and the two choices */
function EmptyState({ left, right, onPick }: { left: PickedDoc | null; right: PickedDoc | null; onPick: (side: Side) => void }) {
  const step = (side: Side, n: number, title: string, body: string, doc: PickedDoc | null) => (
    <motion.button
      type="button"
      className="ss-cmp-step"
      data-done={doc ? "true" : undefined}
      onClick={() => onPick(side)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease, delay: n * 0.06 }}
    >
      <span className="ss-cmp-step-n" aria-hidden="true">{doc ? <Icon name="check" size={18} /> : n}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="ss-cmp-step-title">{title}</span>
        <span className="ss-cmp-step-body">{doc ? doc.name || "Untitled document" : body}</span>
      </span>
      <span className="ss-cmp-step-cta">{doc ? "Change" : "Choose"}</span>
    </motion.button>
  );
  return (
    <div className="ss-cmp-empty">
      <motion.div className="ss-cmp-illustration" aria-hidden="true" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease }}>
        <div className="ss-cmp-ill-page"><span /><span /><span className="ss-cmp-ill-add" /><span /><span className="ss-cmp-ill-add" style={{ width: "54%" }} /></div>
        <div className="ss-cmp-ill-arrow"><Icon name="arrow_back" size={20} /></div>
        <div className="ss-cmp-ill-page"><span /><span /><span className="ss-cmp-ill-copy" /><span /><span className="ss-cmp-ill-copy" style={{ width: "54%" }} /></div>
      </motion.div>
      <h2 className="ss-cmp-empty-title">Bring a document up to date</h2>
      <p className="ss-cmp-empty-body">SyncStream finds what the reference has and your document doesn&apos;t, and types only that into your document. Nothing you already have is deleted or changed.</p>
      <div className="ss-cmp-steps">
        {step("left", 1, "Your document", "The one that gets the missing parts", left)}
        {step("right", 2, "Reference", "The one to copy from", right)}
      </div>
    </div>
  );
}

const lucideBig = (C: typeof Files) => <C className="h-7 w-7" strokeWidth={1.5} aria-hidden="true" />;

function Problem({ icon, title, body, actions }: { icon: React.ReactNode; title: string; body: string; actions?: React.ReactNode }) {
  return (
    <motion.div className="ss-cmp-empty" role="alert" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease }}>
      <span className="ss-cmp-problem-icon" aria-hidden="true">{icon}</span>
      <h2 className="ss-cmp-empty-title">{title}</h2>
      <p className="ss-cmp-empty-body">{body}</p>
      {actions && <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div>}
    </motion.div>
  );
}

/** The panel before a comparison: how it works, or a quiet skeleton while the documents are read */
function PanelIdle({ loading, notice }: { loading: boolean; notice: React.ReactNode }) {
  // A long read says it's still going
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!loading) return;
    const id = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(id);
  }, [loading]);
  return (
    <div className="ss-cmp-panel">
      {notice}
      {loading ? (
        <div className="ss-cmp-summary" aria-busy="true" aria-label="Comparing">
          <div className="ss-cmp-skel-line" style={{ width: "60%", height: 22 }} />
          <div className="ss-cmp-skel-line mt-3" style={{ width: "80%" }} />
          <div className="ss-cmp-skel-line mt-6" style={{ width: "100%", height: 6 }} />
          <p className="ss-cmp-meter-label" role="status">{slow ? "Still reading. Long documents with many tabs take a little longer." : "Reading both documents and finding what's missing"}</p>
        </div>
      ) : (
        <section className="ss-cmp-section">
          <h2 className="ss-cmp-h2">How it works</h2>
          <ol className="ss-cmp-how">
            <li><span>1</span>Pick your document and a reference.</li>
            <li><span>2</span>See your document as it will be: everything it&apos;s missing glows where it goes.</li>
            <li><span>3</span>Leave out what you don&apos;t want, then start the sync. It types only the missing parts, like a person would.</li>
          </ol>
        </section>
      )}
    </div>
  );
}
