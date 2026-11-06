/**
 * Docs kerns the letter pairs inside a word but never a pair that includes a space. Measured in the
 * corpus PDFs, every family (Arial, Times New Roman, Calibri, Cambria, Roboto, Source Sans, Lexend...)
 * kerns inside words, and no pair with a space is kerned. Chrome kerns both once font-kerning is on,
 * and a pair with a space changes a line's width enough to move where it wraps.
 *
 * So each family's stack on the page starts with a face that draws only spaces (unicode-range
 * U+0020, U+00A0). Chrome shapes a run of one face at a time, so its runs split at every space and
 * no kerning crosses one. The face draws the space from the font the text itself lands on: the
 * family, the metric-compatible font a system puts in its place, or the web font after it in the
 * stack. So the space's width, and the line's metrics (which come from the first face in the stack
 * that covers a space), are the family's own.
 *
 * Only the page uses these stacks. The editor's inline styles, and so its clipboard, keep the
 * family's own stack (fontStack), so no copy names a face that exists only here.
 */

import { fontStack, SPACE_FACE_PREFIX } from "@/lib/rich-text";

const SAFE = /^[\p{L}\p{N} ]{1,64}$/u;
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

export const spaceFamily = (family: string) => `${SPACE_FACE_PREFIX}${family}`;

/** The stack the page draws a family in: its space face, then fontStack */
export function screenStack(family: string): string {
  return SAFE.test(family) ? `"${spaceFamily(family)}", ${fontStack(family)}` : fontStack(family);
}

/** The fonts a system shows in place of a family it lacks, as fontconfig's metric aliases do */
const METRIC_ALIASES: Record<string, string[]> = {
  Arial: ["Liberation Sans", "Arimo"],
  "Times New Roman": ["Liberation Serif", "Tinos"],
  "Courier New": ["Liberation Mono", "Cousine"],
  Calibri: ["Carlito"],
  Cambria: ["Caladea"],
  Georgia: ["Gelasio"],
};

type Face = { src: string; weight: string; style: string; stretch: string };

/** Whether a unicode-range ("U+0000-00FF, U+0131, U+02??") covers a code point */
export function covers(range: string, cp: number): boolean {
  return range.split(",").some((part) => {
    const m = /^\s*U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) return false;
    const lo = parseInt(m[1].replace(/\?/g, "0"), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "f"), 16);
    return cp >= lo && cp <= hi;
  });
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/** The web faces that draw a space, by family, from the Google Fonts stylesheets on the page */
function webFaces(): Map<string, Face[]> {
  const out = new Map<string, Face[]>();
  for (const sheet of Array.from(document.styleSheets)) {
    if (!sheet.href?.startsWith("https://fonts.googleapis.com/")) continue;
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // a stylesheet loaded without CORS can't be read
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const s = rule.style;
      const range = s.getPropertyValue("unicode-range");
      const src = s.getPropertyValue("src");
      if (!src || (range && !covers(range, 0x20))) continue;
      const family = unquote(s.getPropertyValue("font-family"));
      const list = out.get(family) ?? [];
      list.push({ src, weight: s.getPropertyValue("font-weight") || "400", style: s.getPropertyValue("font-style") || "normal", stretch: s.getPropertyValue("font-stretch") || "" });
      out.set(family, list);
    }
  }
  return out;
}

const VARIANTS = [
  { weight: "1 549", style: "normal", full: ["", " Regular"], ps: ["", "-Regular"], bold: false },
  { weight: "550 1000", style: "normal", full: [" Bold"], ps: ["-Bold"], bold: true },
  { weight: "1 549", style: "italic", full: [" Italic"], ps: ["-Italic"], bold: false },
  { weight: "550 1000", style: "italic", full: [" Bold Italic"], ps: ["-BoldItalic"], bold: true },
];

const css = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

/** The web face nearest a variant: same style if there is one, then the closest weight */
function nearest(faces: Face[], italic: boolean, bold: boolean): Face | undefined {
  const want = bold ? 700 : 400;
  const w = (f: Face) => Math.abs((parseInt(f.weight, 10) || 400) - want);
  const same = faces.filter((f) => (f.style === "italic") === italic);
  return (same.length ? same : faces).slice().sort((a, b) => w(a) - w(b))[0];
}

const faceRule = (family: string, src: string, weight: string, style: string, stretch = "") =>
  `@font-face { font-family: ${css(spaceFamily(family))}; src: ${src}; font-weight: ${weight}; font-style: ${style};${stretch ? ` font-stretch: ${stretch};` : ""} font-display: swap; unicode-range: U+0020, U+00A0; }`;

/**
 * Families whose space face the browser draws at another width than the family's own space. Some
 * browsers draw a font they load (a web font or a local() one) at whole-pixel advances while they
 * draw installed fonts at exact ones: Chrome on Linux does with fontconfig's hinting on, as Ubuntu
 * sets it. There a space face would make every space up to half a pixel off, which moves where far
 * more lines wrap than a kerned pair beside a space does, so such a family is drawn without one.
 */
const offWidth = new Set<string>();

let canvas: CanvasRenderingContext2D | null = null;

/**
 * Checks each family's loaded space face against the family's own space, and leaves out (from the
 * next spaceRules) every face that draws it at another width. True when one was found.
 */
export function checkSpaceFaces(families: Iterable<string>): boolean {
  if (typeof document === "undefined" || !document.fonts) return false;
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return false;
  const loaded = new Set(Array.from(document.fonts).filter((f) => f.status === "loaded" && f.style === "normal" && f.family.startsWith(SPACE_FACE_PREFIX)).map((f) => unquote(f.family)));
  let found = false;
  for (const family of families) {
    if (offWidth.has(family) || !SAFE.test(family) || !loaded.has(spaceFamily(family))) continue;
    // At 100px, a space drawn at whole pixels is off by up to half a pixel
    canvas.font = `100px ${css(spaceFamily(family))}, monospace`;
    const face = canvas.measureText(" ").width;
    canvas.font = `100px ${fontStack(family)}`;
    if (Math.abs(face - canvas.measureText(" ").width) > 0.01) {
      offWidth.add(family);
      found = true;
    }
  }
  return found;
}

/** The space faces for these families, and the rules that draw each in its screen stack */
export function spaceRules(families: Iterable<string>): string[] {
  if (typeof document === "undefined") return [];
  const web = webFaces();
  const rules: string[] = [];
  for (const family of families) {
    if (!SAFE.test(family)) continue;
    // Without its face the screen stack's first name names nothing, and the family's own fonts draw every character
    if (offWidth.has(family)) {
      rules.push(`.ss-doc [data-font=${css(family)}] { font-family: ${screenStack(family)} !important; }`);
      continue;
    }
    const own = web.get(family);
    if (own) {
      // A web family shadows any installed font of its name: its space comes from its own files
      for (const f of own) rules.push(faceRule(family, f.src, f.weight, f.style, f.stretch));
    } else {
      // An installed family, then what stands in for it: the stack's next families, in order
      const chain = fontStack(family).split(",").map(unquote).filter((f) => f && !GENERIC.has(f.toLowerCase()));
      for (const v of VARIANTS) {
        const src: string[] = [];
        for (const f of chain) {
          const faces = web.get(f);
          if (faces) {
            const face = nearest(faces, v.style === "italic", v.bold);
            if (face) src.push(face.src);
            break; // a web font in the stack always loads, so nothing after it is reached
          }
          for (const name of [f, ...(METRIC_ALIASES[f] ?? [])]) {
            for (const s of v.full) src.push(`local(${css(name + s)})`);
            for (const s of v.ps) if (name.includes(" ")) src.push(`local(${css(name.replace(/ /g, "") + s)})`);
          }
        }
        if (src.length) rules.push(faceRule(family, [...new Set(src)].join(", "), v.weight, v.style));
      }
    }
    // Text in a font of its own: its inline style (fontStack) gives way to the screen stack
    rules.push(`.ss-doc [data-font=${css(family)}] { font-family: ${screenStack(family)} !important; }`);
  }
  // With every space drawn from a face of its own, kerning stays inside words, as in Docs
  rules.push(`html .ss-doc { font-kerning: normal; }`);
  return rules;
}
