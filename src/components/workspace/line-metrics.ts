/**
 * Docs' line spacing is a multiple of each font's natural line height (the
 * font's ascent, descent and line gap), not of a fixed 1.2 × the size. The
 * paragraph's line-height is spacing × --ss-nlh, and this measures --ss-nlh
 * for every font the editor offers, with the browser's own font files.
 */

import { FONT_FAMILIES, fontStack } from "@/lib/rich-text";

const STYLE_ID = "ss-line-metrics";
let done = false;

export function installLineMetrics() {
  if (done || typeof document === "undefined") return;
  done = true;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;font-size:100px;line-height:normal;white-space:nowrap";
  document.body.appendChild(probe);
  const measure = (family: string) => {
    probe.style.fontFamily = fontStack(family);
    probe.textContent = "Hg";
    return Math.round((probe.getBoundingClientRect().height / 100) * 1000) / 1000;
  };
  const write = () => {
    const rules = FONT_FAMILIES.map((f) => `.ss-doc [data-font="${f}"] { --ss-nlh: ${measure(f)}; }`);
    rules.unshift(`.ss-doc { --ss-nlh: ${measure("Arial")}; }`);
    let el = document.getElementById(STYLE_ID);
    if (!el) { el = document.createElement("style"); el.id = STYLE_ID; document.head.appendChild(el); }
    el.textContent = rules.join("\n");
  };
  write();
  // Web fonts change the answer once they load
  document.fonts?.ready?.then(() => { write(); probe.remove(); }).catch(() => probe.remove());
}
