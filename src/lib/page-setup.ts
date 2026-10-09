/**
 * Page setup, as in Docs' File > Page setup: paper size, orientation,
 * margins and page colour. Sizes are in points. Mirrors the Google Docs
 * documentStyle, so a document's setup is read when it opens and written
 * back when it is changed here.
 */

export type PaperId = "letter" | "tabloid" | "legal" | "statement" | "executive" | "folio" | "a3" | "a4" | "a5" | "b4" | "b5";
export type Orientation = "portrait" | "landscape";

export interface PageSetup {
  orientation: Orientation;
  paper: PaperId;
  /** Points */
  margins: { top: number; bottom: number; left: number; right: number };
  /** #rrggbb, or null for white */
  color: string | null;
}

/** Paper sizes, portrait, in points (the list Docs offers) */
export const PAPERS: Record<PaperId, { label: string; w: number; h: number }> = {
  letter: { label: 'Letter (8.5" x 11")', w: 612, h: 792 },
  tabloid: { label: 'Tabloid (11" x 17")', w: 792, h: 1224 },
  legal: { label: 'Legal (8.5" x 14")', w: 612, h: 1008 },
  statement: { label: 'Statement (5.5" x 8.5")', w: 396, h: 612 },
  executive: { label: 'Executive (7.25" x 10.5")', w: 522, h: 756 },
  folio: { label: 'Folio (8.5" x 13")', w: 612, h: 936 },
  a3: { label: "A3 (29.7cm x 42cm)", w: 841.9, h: 1190.6 },
  a4: { label: "A4 (21cm x 29.7cm)", w: 595.3, h: 841.9 },
  a5: { label: "A5 (14.8cm x 21cm)", w: 419.5, h: 595.3 },
  b4: { label: "B4 (25cm x 35.3cm)", w: 708.7, h: 1000.6 },
  b5: { label: "B5 (17.6cm x 25cm)", w: 498.9, h: 708.7 },
};
export const PAPER_ORDER: PaperId[] = ["letter", "tabloid", "legal", "statement", "executive", "folio", "a3", "a4", "a5", "b4", "b5"];

export const DEFAULT_PAGE_SETUP: PageSetup = { orientation: "portrait", paper: "letter", margins: { top: 72, bottom: 72, left: 72, right: 72 }, color: null };

/** Page width and height in points, orientation applied */
export function pageSize(s: PageSetup): { w: number; h: number } {
  const p = PAPERS[s.paper];
  return s.orientation === "landscape" ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/** The same setup in CSS pixels (96 per inch), for laying out pages */
export function pageGeometry(s: PageSetup): { w: number; h: number; top: number; bottom: number; left: number; right: number } {
  const px = (pt: number) => Math.round((pt * 96) / 72);
  const { w, h } = pageSize(s);
  return { w: px(w), h: px(h), top: px(s.margins.top), bottom: px(s.margins.bottom), left: px(s.margins.left), right: px(s.margins.right) };
}

export const samePageSetup = (a: PageSetup, b: PageSetup) =>
  a.orientation === b.orientation && a.paper === b.paper && a.color === b.color &&
  a.margins.top === b.margins.top && a.margins.bottom === b.margins.bottom && a.margins.left === b.margins.left && a.margins.right === b.margins.right;

const clampMargin = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(720, Math.round(v * 100) / 100)) : fallback);

/** Validate a setup from a request or storage; null when it isn't one */
export function parsePageSetup(raw: unknown): PageSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PageSetup>;
  if (r.orientation !== "portrait" && r.orientation !== "landscape") return null;
  if (typeof r.paper !== "string" || !(r.paper in PAPERS)) return null;
  const m = (r.margins ?? {}) as Partial<PageSetup["margins"]>;
  const color = typeof r.color === "string" && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toLowerCase() : null;
  const setup: PageSetup = {
    orientation: r.orientation,
    paper: r.paper as PaperId,
    margins: { top: clampMargin(m.top, 72), bottom: clampMargin(m.bottom, 72), left: clampMargin(m.left, 72), right: clampMargin(m.right, 72) },
    color: color === "#ffffff" ? null : color,
  };
  const { w, h } = pageSize(setup);
  // Margins must leave room for text
  if (setup.margins.left + setup.margins.right > w - 36 || setup.margins.top + setup.margins.bottom > h - 36) return null;
  return setup;
}

// ── Google Docs ─────────────────────────────────────────────────────────────

interface Dimension { magnitude?: number | null; unit?: string | null }
interface DocumentStyle {
  pageSize?: { width?: Dimension | null; height?: Dimension | null } | null;
  marginTop?: Dimension | null;
  marginBottom?: Dimension | null;
  marginLeft?: Dimension | null;
  marginRight?: Dimension | null;
  background?: { color?: { color?: { rgbColor?: { red?: number | null; green?: number | null; blue?: number | null } | null } | null } | null } | null;
}

const pt = (d: Dimension | null | undefined, fallback: number) => (typeof d?.magnitude === "number" ? d.magnitude : fallback);

/** The setup of an open Google Doc. Unknown paper sizes fall back to the closest listed one. */
export function pageSetupFromDocumentStyle(ds: DocumentStyle | null | undefined): PageSetup {
  if (!ds) return DEFAULT_PAGE_SETUP;
  const w = pt(ds.pageSize?.width, 612);
  const h = pt(ds.pageSize?.height, 792);
  const orientation: Orientation = w > h ? "landscape" : "portrait";
  const pw = Math.min(w, h);
  const ph = Math.max(w, h);
  let paper: PaperId = "letter";
  let best = Infinity;
  for (const id of PAPER_ORDER) {
    const d = Math.abs(PAPERS[id].w - pw) + Math.abs(PAPERS[id].h - ph);
    if (d < best) { best = d; paper = id; }
  }
  const rgb = ds.background?.color?.color?.rgbColor;
  const hex = (v: number | null | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  const color = rgb ? `#${hex(rgb.red)}${hex(rgb.green)}${hex(rgb.blue)}` : null;
  return {
    orientation,
    paper,
    margins: { top: pt(ds.marginTop, 72), bottom: pt(ds.marginBottom, 72), left: pt(ds.marginLeft, 72), right: pt(ds.marginRight, 72) },
    color: !color || color === "#ffffff" ? null : color,
  };
}

/** The batchUpdate request that gives a Google Doc this setup */
export function documentStyleRequest(s: PageSetup): Record<string, unknown> {
  const { w, h } = pageSize(s);
  const dim = (magnitude: number) => ({ magnitude, unit: "PT" });
  const c = s.color ?? "#ffffff";
  const ch = (i: number) => parseInt(c.slice(i, i + 2), 16) / 255;
  return {
    updateDocumentStyle: {
      documentStyle: {
        pageSize: { width: dim(w), height: dim(h) },
        marginTop: dim(s.margins.top),
        marginBottom: dim(s.margins.bottom),
        marginLeft: dim(s.margins.left),
        marginRight: dim(s.margins.right),
        background: { color: { color: { rgbColor: { red: ch(1), green: ch(3), blue: ch(5) } } } },
      },
      fields: "pageSize,marginTop,marginBottom,marginLeft,marginRight,background",
    },
  };
}
