/**
 * Docs' line spacing is a multiple of each font's natural line height (the
 * font's ascent, descent and line gap), not of a fixed 1.2 × the size. The
 * paragraph's line-height is spacing × --ss-nlh, and this measures --ss-nlh
 * for every font the editor offers, the document's own default font and any
 * other font the page uses, with the browser's own font files.
 * It also measures each font's ascent and descent (--ss-asc, --ss-desc): a
 * highlight covers them, so a list glyph's highlight is drawn to match the
 * text's (see docs.css).
 * Each family is drawn with its space face first (space-faces.ts), so kerning
 * stays inside words as in Docs.
 */

import { FONT_FAMILIES } from "@/lib/rich-text";
import { screenStack, spaceRules } from "./space-faces";

const STYLE_ID = "ss-line-metrics";
const FACES_ID = "ss-space-faces";
/** Families measured, in the order their rules are written */
const families = new Set<string>();
let probe: HTMLDivElement | null = null;
let installed = false;

function measure(family: string): string {
  if (!probe) {
    probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;font-size:100px;line-height:normal;white-space:nowrap";
  }
  if (!probe.isConnected) document.body.appendChild(probe);
  probe.style.fontFamily = screenStack(family);
  probe.replaceChildren("Hg");
  const nlh = Math.round((probe.getBoundingClientRect().height / 100) * 1000) / 1000;
  // Ascent and descent at a large size, where the browser's rounding to whole pixels costs little; a
  // zero-height inline block sits on the baseline
  const text = document.createElement("span");
  text.style.fontSize = "1000px";
  text.textContent = "Hg";
  const baseline = document.createElement("span");
  baseline.style.cssText = "display:inline-block;width:0;height:0";
  probe.replaceChildren(text, baseline);
  const box = text.getBoundingClientRect();
  const base = baseline.getBoundingClientRect().top;
  const asc = Math.round(base - box.top) / 1000;
  const desc = Math.round(box.bottom - base) / 1000;
  return `--ss-nlh: ${nlh}; --ss-asc: ${asc}; --ss-desc: ${desc};`;
}

/** Sets a style element's text, only when it changes: new @font-face rules load again, and a load writes again */
function setStyle(id: string, text: string) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement("style"); el.id = id; document.head.appendChild(el); }
  if (el.textContent !== text) el.textContent = text;
}

function write() {
  if (!families.size) return;
  // The space faces first, so the metrics are measured in the stacks the page draws
  setStyle(FACES_ID, spaceRules(families).join("\n"));
  const name = (f: string) => `"${CSS.escape(f)}"`;
  // Text in a font of its own, and a document whose default font it is (data-doc-font, see use-page-setup)
  const rules = [`.ss-doc { ${measure("Arial")} }`];
  for (const f of families) rules.push(`.ss-doc[data-doc-font=${name(f)}], .ss-doc [data-font=${name(f)}] { ${measure(f)} }`);
  probe?.remove();
  setStyle(STYLE_ID, rules.join("\n"));
}

/** Measure these fonts too (a document's or a paste's); each is measured again once web fonts load */
export function fontMetrics(more: Iterable<string>) {
  if (typeof document === "undefined") return;
  let added = false;
  for (const f of more) {
    if (!f || families.has(f) || !/^[\p{L}\p{N} ]{1,64}$/u.test(f)) continue;
    families.add(f);
    added = true;
  }
  if (added && installed) write();
}

export function installLineMetrics() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  for (const f of FONT_FAMILIES) families.add(f);
  write();
  // Web fonts change the answer once they load, the ones a document asks for later too
  let queued = false;
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; write(); }); } };
  document.fonts?.ready?.then(later).catch(() => {});
  document.fonts?.addEventListener?.("loadingdone", later);
}
