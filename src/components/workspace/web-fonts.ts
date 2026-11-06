/**
 * Fonts for the page. Docs offers every Google Fonts family, in every
 * weight it has (Montserrat Light, Roboto Medium...). The dashboard loads
 * the common ones up front (see dashboard/layout.tsx); any other family or
 * weight a document or a paste uses is loaded from Google Fonts when it
 * first shows up, so the page draws text in the font Docs will.
 */

import type { EditorNode } from "@/lib/rich-text";
import { fontWeightOf } from "@/lib/rich-text";

/** Loaded with the dashboard, upright and italic at 400 and 700 */
const BUNDLED = new Set(["Arimo", "Tinos", "Carlito", "Caladea", "Cousine", "Comic Neue", "EB Garamond", "Gelasio", "Lato", "Lexend", "Lora", "Merriweather", "Montserrat", "Nunito", "Open Sans", "Playfair Display", "Roboto", "Roboto Mono", "Spectral"]);
/** Docs' fonts that aren't Google Fonts: they show in their metric-compatible stand-ins (FONT_STACKS) */
const NOT_WEB = new Set(["Arial", "Calibri", "Cambria", "Comic Sans MS", "Courier New", "Georgia", "Times New Roman", "Trebuchet MS", "Verdana", "Impact", "Tahoma", "Helvetica", "Garamond", "Arial Black", "Arial Narrow", "Century Gothic", "Consolas", "Corsiva", "Courier"]);

/** Variants as Google Fonts' css2 names them: "ital,wght" pairs like "0,400" */
type Variant = string;
const variant = (italic: boolean, weight: number): Variant => `${italic ? 1 : 0},${weight}`;
const requested = new Map<string, Set<Variant>>();

/** The families and variants a document's text uses */
export function fontsIn(doc: EditorNode | null | undefined, extra: string[] = []): Map<string, Set<Variant>> {
  const out = new Map<string, Set<Variant>>();
  const add = (family: string, v: Variant) => {
    const set = out.get(family) ?? new Set<Variant>();
    set.add(v);
    out.set(family, set);
  };
  for (const f of extra) if (f) add(f, variant(false, 400));
  const walk = (n: EditorNode) => {
    if (n.type === "text") {
      const marks = n.marks ?? [];
      const ts = marks.find((m) => m.type === "textStyle")?.attrs;
      const family = typeof ts?.fontFamily === "string" ? ts.fontFamily : null;
      if (family) {
        const bold = marks.some((m) => m.type === "bold");
        const weight = fontWeightOf(ts?.fontWeight) ?? (bold ? 700 : 400);
        add(family, variant(marks.some((m) => m.type === "italic"), bold && weight < 700 ? 700 : weight));
      }
    }
    for (const c of n.content ?? []) walk(c);
  };
  if (doc) walk(doc);
  return out;
}

function link(href: string, onError?: () => void) {
  const el = document.createElement("link");
  el.rel = "stylesheet";
  // Read with CORS (Google Fonts allows it), so the page can draw each face's spaces from it (space-faces.ts)
  el.crossOrigin = "anonymous";
  el.href = href;
  el.dataset.ssFont = "";
  if (onError) el.addEventListener("error", onError, { once: true });
  document.head.appendChild(el);
}

const familyParam = (family: string) => encodeURIComponent(family).replace(/%20/g, "+");

/** Load what isn't loaded yet. A family without some of the variants still gets its regular face. */
export function loadFonts(fonts: Map<string, Set<Variant>>) {
  if (typeof document === "undefined") return;
  for (const [family, variants] of fonts) {
    if (NOT_WEB.has(family) || !/^[\p{L}\p{N} ]{1,64}$/u.test(family)) continue;
    const have = requested.get(family) ?? new Set<Variant>(BUNDLED.has(family) ? ["0,400", "0,700", "1,400", "1,700"] : []);
    requested.set(family, have);
    // A new family comes with its regular and bold faces, as the toolbar's B and I need them
    const want = new Set<Variant>(variants);
    if (!BUNDLED.has(family) && !have.size) for (const v of ["0,400", "0,700", "1,400", "1,700"]) want.add(v);
    // css2 takes the pairs in order: upright before italic, then by weight
    const missing = [...want].filter((v) => !have.has(v)).sort((a, b) => {
      const [ai, aw] = a.split(",").map(Number);
      const [bi, bw] = b.split(",").map(Number);
      return ai - bi || aw - bw;
    });
    if (!missing.length) continue;
    for (const v of missing) have.add(v);
    const name = familyParam(family);
    link(`https://fonts.googleapis.com/css2?family=${name}:ital,wght@${missing.join(";")}&display=swap`, () => {
      // Google answers nothing for a family that lacks one of the variants: ask for each on its own
      for (const v of missing) link(`https://fonts.googleapis.com/css2?family=${name}:ital,wght@${v}&display=swap`);
    });
  }
}
