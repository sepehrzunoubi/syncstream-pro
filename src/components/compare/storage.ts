/**
 * What Compare & Sync keeps on this device: the session (the two documents, the tab choices,
 * skipped changes, breaks and settings), and the handoff of a sync it started to the editor.
 */

import type { CompareBreak, TabMap, TabTarget } from "@/lib/compare-types";

export const SESSION_KEY = "syncstream_compare_v1";
export const FOCUS_KEY = "syncstream_focus_v1";
/** A handoff older than this is from another visit: the editor ignores it */
export const FOCUS_MAX_AGE_MS = 2 * 60_000;

export interface PickedDoc { id: string; name: string }

export interface CompareSettings {
  breaksMode: "auto" | "none" | "manual";
  /** Automatic and None: the total time; null for the natural pace */
  durationMinutes: number | null;
  /** Manual: what is typed in the Break length field */
  breakLength: string;
  typoFrequency: number;
  startInMinutes: number;
}

export const DEFAULT_SETTINGS: CompareSettings = { breaksMode: "auto", durationMinutes: null, breakLength: "", typoFrequency: 0.5, startInMinutes: 0 };

export interface CompareSession {
  left: PickedDoc | null;
  right: PickedDoc | null;
  /** The tab choices the user made (reference tab id → target); the rest are matched automatically */
  tabMap: TabMap;
  skip: string[];
  breaks: CompareBreak[];
  settings: CompareSettings;
  scrollSync: boolean;
  /** The reference tab shown */
  tab: string | null;
}

export const EMPTY_SESSION: CompareSession = { left: null, right: null, tabMap: {}, skip: [], breaks: [], settings: DEFAULT_SETTINGS, scrollSync: true, tab: null };

const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function readDoc(v: unknown): PickedDoc | null {
  const d = v as Partial<PickedDoc> | null;
  return d && str(d.id, 200) ? { id: d.id, name: typeof d.name === "string" ? d.name.slice(0, 500) : "" } : null;
}

function readTarget(v: unknown): TabTarget | null {
  const t = v as Partial<Record<string, unknown>> | null;
  if (!t || typeof t !== "object") return null;
  if (t.kind === "skip") return { kind: "skip" };
  if (t.kind === "tab" && str(t.leftTabId, 200)) return { kind: "tab", leftTabId: t.leftTabId, ...(str(t.rename) ? { rename: t.rename } : {}) };
  if (t.kind === "new" && typeof t.title === "string") {
    return { kind: "new", title: t.title.slice(0, 500), ...(str(t.emoji, 16) ? { emoji: t.emoji } : {}), parentRightTabId: str(t.parentRightTabId, 200) ? t.parentRightTabId : null };
  }
  return null;
}

/** A stored session, read defensively: anything unreadable falls back to its default */
export function parseSession(raw: string | null): CompareSession {
  let v: Record<string, unknown>;
  try { v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { return EMPTY_SESSION; }
  if (!v || typeof v !== "object") return EMPTY_SESSION;
  const tabMap: TabMap = {};
  if (v.tabMap && typeof v.tabMap === "object") {
    for (const [k, t] of Object.entries(v.tabMap as Record<string, unknown>)) { const target = readTarget(t); if (target) tabMap[k] = target; }
  }
  const s = (v.settings ?? {}) as Partial<CompareSettings>;
  const settings: CompareSettings = {
    breaksMode: s.breaksMode === "none" || s.breaksMode === "manual" ? s.breaksMode : "auto",
    durationMinutes: typeof s.durationMinutes === "number" && s.durationMinutes > 0 ? s.durationMinutes : null,
    breakLength: typeof s.breakLength === "string" ? s.breakLength.slice(0, 40) : "",
    typoFrequency: typeof s.typoFrequency === "number" ? Math.min(1, Math.max(0, s.typoFrequency)) : 0.5,
    startInMinutes: typeof s.startInMinutes === "number" && s.startInMinutes >= 0 ? s.startInMinutes : 0,
  };
  const breaks = Array.isArray(v.breaks)
    ? (v.breaks as Partial<CompareBreak>[]).filter((b): b is CompareBreak => !!b && str(b.rightTabId, 200) && Number.isInteger(b.rightToken) && (b.rightToken as number) >= 0 && typeof b.minutes === "number" && b.minutes > 0)
    : [];
  return {
    left: readDoc(v.left),
    right: readDoc(v.right),
    tabMap,
    skip: Array.isArray(v.skip) ? (v.skip as unknown[]).filter((x): x is string => str(x, 200)) : [],
    breaks,
    settings,
    scrollSync: v.scrollSync !== false,
    tab: str(v.tab, 200) ? v.tab : null,
  };
}

export function loadSession(): CompareSession {
  try { return parseSession(localStorage.getItem(SESSION_KEY)); } catch { return EMPTY_SESSION; }
}

export function saveSession(s: CompareSession) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* storage full or blocked */ }
}

export interface FocusHandoff { documentId: string; jobId: string; at: number }

/** Compare & Sync started a sync: the editor opens on its live view */
export function writeFocusHandoff(documentId: string, jobId: string) {
  try { localStorage.setItem(FOCUS_KEY, JSON.stringify({ documentId, jobId, at: Date.now() } satisfies FocusHandoff)); } catch { /* storage blocked */ }
}

/** A fresh handoff, read once: it is removed whatever it holds */
export function readFocusHandoff(raw: string | null, now: number): FocusHandoff | null {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<FocusHandoff>) : null;
    if (!v || !str(v.documentId, 200) || !str(v.jobId, 200) || typeof v.at !== "number") return null;
    return now - v.at >= 0 && now - v.at <= FOCUS_MAX_AGE_MS ? { documentId: v.documentId, jobId: v.jobId, at: v.at } : null;
  } catch { return null; }
}

export function takeFocusHandoff(): FocusHandoff | null {
  try {
    const raw = localStorage.getItem(FOCUS_KEY);
    localStorage.removeItem(FOCUS_KEY);
    return readFocusHandoff(raw, Date.now());
  } catch { return null; }
}
