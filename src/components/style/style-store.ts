/**
 * What the Style engine tab keeps on this device: the last text and
 * result, and a one-shot hand-off of a result to the sync editor.
 */

const DRAFT_KEY = "syncstream_style_draft_v2";
const HANDOFF_KEY = "syncstream_style_handoff";

export interface StyleDraft { text: string; result: string }

export function loadStyleDraft(): StyleDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as Partial<StyleDraft>) : {};
    return { text: typeof d.text === "string" ? d.text : "", result: typeof d.result === "string" ? d.result : "" };
  } catch { return { text: "", result: "" }; }
}

export function saveStyleDraft(draft: StyleDraft): void {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage full or blocked */ }
}

/** Hand a result to the sync editor; it is picked up once on the next visit */
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
