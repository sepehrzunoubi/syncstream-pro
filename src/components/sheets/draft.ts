/**
 * The workbook being prepared on the Sheets page, kept on this device so a reload doesn't lose it.
 * Only one is kept, and only while it fits in the browser's storage.
 */

import type { Workbook } from "@/lib/sheets/model";
import { parseWorkbook } from "@/lib/sheets/validate";

const KEY = "syncstream_sheet_draft_v1";
/** Past this the draft isn't kept (browsers give a page about 5 MB) */
const MAX_CHARS = 3_500_000;

export interface SheetDraft {
  workbook: Workbook;
  name: string;
  settings: { targetMinutes: number | null; startInMinutes: number; seed: number };
}

export function loadDraft(): SheetDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SheetDraft>;
    const parsed = parseWorkbook(v.workbook);
    if (!parsed.ok) return null;
    const s = (v.settings ?? {}) as Partial<SheetDraft["settings"]>;
    return {
      // (what the file didn't carry over is said again after a reload)
      workbook: { ...parsed.workbook, warnings: Array.isArray(v.workbook?.warnings) ? v.workbook.warnings.filter((w): w is string => typeof w === "string").slice(0, 20) : [] },
      name: typeof v.name === "string" ? v.name.slice(0, 200) : parsed.workbook.name,
      settings: {
        targetMinutes: typeof s.targetMinutes === "number" && s.targetMinutes > 0 ? s.targetMinutes : null,
        startInMinutes: typeof s.startInMinutes === "number" && s.startInMinutes >= 0 ? s.startInMinutes : 0,
        seed: typeof s.seed === "number" && Number.isInteger(s.seed) && s.seed >= 0 ? s.seed : 1,
      },
    };
  } catch {
    return null;
  }
}

export function saveDraft(draft: SheetDraft): void {
  try {
    const raw = JSON.stringify(draft);
    if (raw.length > MAX_CHARS) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, raw);
  } catch { /* storage full or blocked: the workbook stays for this visit only */ }
}

export function clearDraft(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
