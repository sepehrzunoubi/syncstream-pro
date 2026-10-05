/**
 * Styles are kept on this device, like the sync draft: a list of profiles
 * in localStorage, plus a one-shot hand-off of transformed text to the
 * sync editor.
 */

import type { StylePair, StyleProfile } from "@/lib/style-engine";
import type { Effort } from "@/lib/style-engine";

const PROFILES_KEY = "syncstream_style_profiles_v1";
const SETTINGS_KEY = "syncstream_style_settings_v1";
const HANDOFF_KEY = "syncstream_style_handoff";

export interface StyleSettings { effort: Effort; stage?: "pairs" | "profile" | "transform"; selectedId?: string }

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function newPair(): StylePair {
  return { id: uid(), input: "", output: "" };
}

export function newProfile(name = "Untitled style"): StyleProfile {
  const now = Date.now();
  return { id: uid(), name, pairs: [newPair()], analysis: null, analyzedAt: null, instructions: "", createdAt: now, updatedAt: now };
}

export function loadProfiles(): StyleProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    const list = raw ? (JSON.parse(raw) as StyleProfile[]) : [];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && Array.isArray(p.pairs)) : [];
  } catch { return []; }
}

export function saveProfiles(profiles: StyleProfile[]): boolean {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    return true;
  } catch { return false; }
}

export function loadSettings(): StyleSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const s = raw ? (JSON.parse(raw) as Partial<StyleSettings>) : {};
    return { effort: s.effort === "medium" || s.effort === "max" ? s.effort : "high", stage: s.stage, selectedId: s.selectedId };
  } catch { return { effort: "high" }; }
}

export function saveSettings(settings: StyleSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage full or blocked */ }
}

/** Hand transformed text to the sync editor; it is picked up once on the next visit */
export function setStyleHandoff(text: string): boolean {
  try {
    localStorage.setItem(HANDOFF_KEY, text);
    return true;
  } catch { return false; }
}

export function takeStyleHandoff(): string | null {
  try {
    const text = localStorage.getItem(HANDOFF_KEY);
    if (text != null) localStorage.removeItem(HANDOFF_KEY);
    return text && text.trim() ? text : null;
  } catch { return null; }
}
