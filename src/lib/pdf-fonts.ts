/**
 * Fonts of a PDF as Google Docs families.
 *
 * A PDF names each embedded face by its PostScript name, subset tag first
 * ("ABCDEF+Arial-BoldMT"). Docs only draws its own fonts (its few system
 * fonts and Google Fonts families) and draws anything else in Arial, so a
 * name is mapped to a Docs family, a weight and italic. Fonts a machine
 * substituted when the PDF was made (Liberation for Arial, Carlito for
 * Calibri) go back to the font the author picked.
 */

export interface DocsFont {
  /** A family Docs draws */
  family: string;
  /** 100..900; 700 and above is bold */
  weight: number;
  italic: boolean;
}

/** Families Docs offers besides Google Fonts, and the popular Google Fonts families, by squashed name */
const FAMILIES = [
  // Docs' own and Office-compatible families
  "Arial", "Calibri", "Cambria", "Comic Sans MS", "Courier New", "Georgia", "Impact", "Times New Roman", "Trebuchet MS", "Verdana",
  // Google Fonts
  "Roboto", "Roboto Condensed", "Roboto Mono", "Roboto Slab", "Roboto Serif", "Roboto Flex", "Open Sans", "Lato", "Montserrat", "Poppins", "Inter",
  "Oswald", "Raleway", "Nunito", "Nunito Sans", "Merriweather", "Merriweather Sans", "Lora", "Playfair Display", "EB Garamond", "Cormorant Garamond",
  "Spectral", "Lexend", "Source Sans Pro", "Source Sans 3", "Source Serif Pro", "Source Serif 4", "Source Code Pro", "PT Sans", "PT Serif", "PT Mono",
  "Ubuntu", "Ubuntu Mono", "Noto Sans", "Noto Serif", "Noto Sans Mono", "Fira Sans", "Fira Code", "Fira Mono", "IBM Plex Sans", "IBM Plex Serif",
  "IBM Plex Mono", "Work Sans", "Rubik", "Mulish", "Quicksand", "Karla", "Manrope", "DM Sans", "DM Serif Display", "DM Mono", "Barlow", "Barlow Condensed",
  "Archivo", "Arimo", "Tinos", "Cousine", "Libre Baskerville", "Libre Franklin", "Crimson Text", "Crimson Pro", "Alegreya", "Alegreya Sans", "Cardo",
  "Bitter", "Arvo", "Cabin", "Comfortaa", "Dosis", "Exo 2", "Josefin Sans", "Kanit", "Mukta", "Oxygen", "Titillium Web", "Space Grotesk", "Space Mono",
  "Inconsolata", "JetBrains Mono", "Anonymous Pro", "Amatic SC", "Caveat", "Pacifico", "Lobster", "Dancing Script", "Shadows Into Light", "Indie Flower",
  "Permanent Marker", "Bebas Neue", "Abril Fatface", "Anton", "Archivo Black", "Righteous", "Josefin Slab", "Old Standard TT", "Vollkorn", "Domine",
  "Prata", "Cinzel", "Zilla Slab", "Hind", "Heebo", "Assistant", "Varela Round", "Maven Pro", "Signika", "Asap", "Overpass", "Public Sans", "Red Hat Display",
  "Red Hat Text", "Sora", "Outfit", "Plus Jakarta Sans", "Figtree", "Urbanist", "Lexend Deca", "Atkinson Hyperlegible", "Alef", "Amiri", "Cairo", "Tajawal",
  "Frank Ruhl Libre", "Rubik Mono One", "Questrial", "Didact Gothic", "Gelasio", "Caladea", "Carlito", "Comic Neue", "Courier Prime", "Noto Sans Hebrew",
  "Noto Sans Arabic", "Noto Naskh Arabic", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", "Noto Sans TC", "Libre Caslon Text", "Sorts Mill Goudy",
  "Literata", "Newsreader", "Fraunces", "Besley", "Bodoni Moda", "Cormorant", "Marcellus", "Philosopher", "Satisfy", "Great Vibes", "Sacramento",
];
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const KNOWN = new Map(FAMILIES.map((f) => [squash(f), f]));

/**
 * Faces a machine substitutes for the author's font, and the other names fonts go by, keyed by squashed
 * family name (style words already removed)
 */
const ALIASES: Record<string, string> = {
  arialmt: "Arial", arialnarrow: "Arial", arialunicodems: "Arial", helvetica: "Arial", helveticaneue: "Arial", liberationsans: "Arial", arimo: "Arial",
  nimbussans: "Arial", nimbussansl: "Arial", freesans: "Arial", texgyreheros: "Arial", swiss: "Arial", microsoftsansserif: "Arial", segoeui: "Open Sans",
  sfpro: "Inter", sfprotext: "Inter", sfprodisplay: "Inter", sfui: "Inter", sfuitext: "Inter", sfuidisplay: "Inter", tahoma: "Verdana", dejavusans: "Verdana",
  bitstreamverasans: "Verdana", lucidagrande: "Verdana", lucidasans: "Verdana", lucidasansunicode: "Verdana", geneva: "Verdana", avenir: "Nunito Sans",
  avenirnext: "Nunito Sans", gillsans: "Lato", gillsansmt: "Lato", futura: "Montserrat", centurygothic: "Montserrat", franklingothic: "Libre Franklin",
  myriad: "Source Sans Pro", myriadpro: "Source Sans Pro", sourcesans: "Source Sans Pro", sourcesanspro: "Source Sans Pro", corbel: "Open Sans", candara: "Lato",
  aptos: "Inter", aptosdisplay: "Inter", aptosnarrow: "Inter",
  times: "Times New Roman", timesroman: "Times New Roman", timesnewroman: "Times New Roman", timesnewromanps: "Times New Roman", timesnewromanpsmt: "Times New Roman",
  liberationserif: "Times New Roman", tinos: "Times New Roman", nimbusroman: "Times New Roman", nimbusromno9l: "Times New Roman", nimbusromanno9l: "Times New Roman",
  freeserif: "Times New Roman", texgyretermes: "Times New Roman", stixgeneral: "Times New Roman", stixtwotext: "Times New Roman", cmr: "Times New Roman",
  lmroman: "Times New Roman", latinmodernroman: "Times New Roman", computermodern: "Times New Roman", dejavuserif: "Georgia", bitstreamveraserif: "Georgia",
  bookantiqua: "Libre Baskerville", palatino: "Libre Baskerville", palatinolinotype: "Libre Baskerville", texgyrepagella: "Libre Baskerville", baskerville: "Libre Baskerville",
  baskervilleoldface: "Libre Baskerville", garamond: "EB Garamond", adobegaramond: "EB Garamond", adobegaramondpro: "EB Garamond", ebgaramond: "EB Garamond",
  ebgaramond12: "EB Garamond", garamondpremierpro: "EB Garamond", agaramond: "EB Garamond", agaramondpro: "EB Garamond", minion: "Crimson Text", minionpro: "Crimson Text", caslon: "Libre Caslon Text",
  adobecaslonpro: "Libre Caslon Text", bookmanoldstyle: "Libre Baskerville", centuryschoolbook: "Old Standard TT", constantia: "Georgia", gelasio: "Georgia",
  sitka: "Georgia", charter: "Georgia", bitstreamcharter: "Georgia", cambriamath: "Cambria", caladea: "Cambria", carlito: "Calibri", calibrilight: "Calibri",
  courier: "Courier New", couriernew: "Courier New", couriernewps: "Courier New", couriernewpsmt: "Courier New", liberationmono: "Courier New", cousine: "Courier New",
  nimbusmono: "Courier New", nimbusmonops: "Courier New", nimbusmonol: "Courier New", freemono: "Courier New", texgyrecursor: "Courier New", courier10pitch: "Courier New",
  consolas: "Inconsolata", menlo: "Roboto Mono", monaco: "Roboto Mono", sfmono: "Roboto Mono", dejavusansmono: "Roboto Mono", bitstreamverasansmono: "Roboto Mono",
  lucidaconsole: "Inconsolata", andalemono: "Inconsolata", cmtt: "Courier New", lmmono: "Courier New",
  trebuchet: "Trebuchet MS", trebuchetms: "Trebuchet MS", comicsans: "Comic Sans MS", comicsansms: "Comic Sans MS", comicneue: "Comic Sans MS",
  georgiapro: "Georgia", verdanapro: "Verdana", arialblack: "Arial", impact: "Impact", sourceserif: "Source Serif Pro", sourcecode: "Source Code Pro",
  notosansdisplay: "Noto Sans", opensanscondensed: "Open Sans", robotodraft: "Roboto", googlesans: "Open Sans", productsans: "Open Sans",
  googlesanstext: "Open Sans", googlesansdisplay: "Open Sans",
};

/** Style words of a PostScript name, longest first, and the weight they give (0: none) */
const STYLE_WORDS: [RegExp, number][] = [
  [/(ultra|extra)[- ]?light/i, 200], [/(ultra|extra)[- ]?bold/i, 800], [/(semi|demi)[- ]?bold/i, 600], [/hairline|thin/i, 100], [/light/i, 300], [/book/i, 400],
  [/medium/i, 500], [/demi/i, 600], [/heavy|black/i, 900], [/bold/i, 700], [/regular|normal|roman|plain|text/i, 400],
];

/** "PlayfairDisplay" → "Playfair Display", "EBGaramond" → "EB Garamond", "IBMPlexSans" → "IBM Plex Sans" */
function splitCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The Docs family, weight and italic of a PDF font. `serif` and `mono` come from the font's own
 * description, for a family Docs doesn't have.
 */
export function docsFont(rawName: string | null | undefined, hints: { serif?: boolean; mono?: boolean; bold?: boolean; italic?: boolean } = {}): DocsFont {
  const ps = (rawName ?? "").replace(/^[A-Z]{6}\+/, "").replace(/^\/+/, "").trim();
  // Family and style: "Arial-BoldMT", "Arial,BoldItalic", "Montserrat SemiBold Italic", "TimesNewRomanPS-ItalicMT"
  const cut = ps.search(/[-,]/);
  let familyPart = cut > 0 ? ps.slice(0, cut) : ps;
  let stylePart = cut > 0 ? ps.slice(cut + 1) : "";
  // A style written into the family ("RobotoLight", "OpenSansBold", "Montserrat SemiBold")
  const inline = /(?<=[a-z\s])((Ultra|Extra|Semi|Demi)?(Hairline|Thin|Light|Book|Regular|Medium|Bold|Heavy|Black)|Italic|Oblique)+$/.exec(familyPart.replace(/\s+/g, " "));
  if (inline && inline.index > 1) {
    stylePart = `${inline[0]} ${stylePart}`;
    familyPart = familyPart.slice(0, inline.index);
  }
  const style = `${stylePart} ${ps}`;
  let weight = 0;
  for (const [re, w] of STYLE_WORDS) {
    if (re.test(stylePart)) { weight = w; break; }
  }
  if (!weight && /bold/i.test(familyPart)) weight = 700;
  // TeX names its faces by letters: cmbx (bold extended), cmti (text italic), cmsl (slanted)
  const tex = /^(cm|lm)(bx|b|ti|sl|bxti)\d*$/i.exec(familyPart);
  if (tex && !weight && /b/i.test(tex[2])) weight = 700;
  if (!weight) weight = hints.bold ? 700 : 400;
  const italic = /italic|oblique|inclined|(?<![a-z])it$/i.test(stylePart) || /italic|oblique/i.test(style) || !!(tex && /ti|sl/i.test(tex[2])) || !!hints.italic;
  const family = familyOf(familyPart, ps, hints);
  return { family, weight, italic };
}

function familyOf(familyPart: string, ps: string, hints: { serif?: boolean; mono?: boolean }): string {
  const tries = [familyPart, familyPart.replace(/(PSMT|PS|MT|Std|Pro|LT|OT|W\d+)$/i, "")];
  for (const t of tries) {
    const k = squash(t);
    if (!k) continue;
    if (ALIASES[k]) return ALIASES[k];
    const known = KNOWN.get(k);
    if (known) return known;
  }
  // "Roboto Condensed Medium", "Noto Sans Display": the longest known family it starts with
  const k = squash(familyPart);
  let best = "";
  for (const [key, f] of KNOWN) if (k.startsWith(key) && key.length > squash(best).length) best = f;
  for (const [key, f] of Object.entries(ALIASES)) if (k.startsWith(key) && key.length > squash(best).length) best = f;
  if (best && squash(best).length >= 4) return best;
  // Families known by a word in their name
  const WORDS: [RegExp, string][] = [[/garamond/, "EB Garamond"], [/baskerville/, "Libre Baskerville"], [/caslon/, "Libre Caslon Text"], [/helvetica|arial/, "Arial"], [/times/, "Times New Roman"], [/futura/, "Montserrat"], [/roboto/, "Roboto"], [/opensans/, "Open Sans"]];
  for (const [re, f] of WORDS) if (re.test(k)) return f;
  // TeX's Computer Modern and friends: cmr10, cmbx12, cmtt10, cmss10
  if (/^(cm|lm)(r|bx|ti|sl|b)\d*$/i.test(k)) return "Times New Roman";
  if (/^(cm|lm)ss/i.test(k)) return "Arial";
  if (/^(cm|lm)tt/i.test(k)) return "Courier New";
  const name = splitCamel(familyPart);
  if (/mono|code|console|courier|typewriter/i.test(ps) || hints.mono) return "Courier New";
  if (/serif|roman|times|garamond|book|antiqua|baskerville|caslon|georgia|minion|palatino/i.test(ps) && !/sans/i.test(ps)) return "Times New Roman";
  if (hints.serif && !/sans|gothic|grotesk|grotesque/i.test(ps)) return name && /^[A-Za-z][A-Za-z ]+$/.test(name) && KNOWN.has(squash(name)) ? KNOWN.get(squash(name))! : "Times New Roman";
  return "Arial";
}

/**
 * Natural line height (ascent + descent + line gap, over the size) of Docs' fonts, which Docs' line
 * spacing multiplies. Measured from the fonts Docs serves; families not listed use the PDF font's own.
 */
const LINE_HEIGHTS: Record<string, number> = {
  Arial: 1.149, "Times New Roman": 1.149, "Courier New": 1.133, Georgia: 1.136, Verdana: 1.215, "Trebuchet MS": 1.164, "Comic Sans MS": 1.394, Impact: 1.22,
  Calibri: 1.221, Cambria: 1.172, Roboto: 1.172, "Roboto Mono": 1.319, "Open Sans": 1.362, Lato: 1.2, Montserrat: 1.219, Inter: 1.21, Lexend: 1.25,
  "EB Garamond": 1.305, Lora: 1.28, Merriweather: 1.257, Nunito: 1.364, "Playfair Display": 1.333, Spectral: 1.542, "Source Sans Pro": 1.257, Poppins: 1.5,
  Raleway: 1.174, Oswald: 1.482, "Noto Sans": 1.362, "Noto Serif": 1.362, "PT Sans": 1.294, "PT Serif": 1.324, Ubuntu: 1.149, "Libre Baskerville": 1.24,
  "Crimson Text": 1.11, Inconsolata: 1.049, "Source Code Pro": 1.257, "Work Sans": 1.173, Rubik: 1.185, "Nunito Sans": 1.364, "Roboto Condensed": 1.172,
  "Roboto Slab": 1.319, "Fira Sans": 1.2, "IBM Plex Sans": 1.3, Mulish: 1.255, Karla: 1.169, "DM Sans": 1.302, Manrope: 1.366, Barlow: 1.2, Cabin: 1.215,
};

/** The natural line height of a Docs family, or of the PDF's font (its ascent and descent) for one not listed */
export function naturalLineHeight(family: string, pdfFont?: { ascent?: number; descent?: number } | null): number {
  const known = LINE_HEIGHTS[family];
  if (known) return known;
  const asc = pdfFont?.ascent;
  const desc = pdfFont?.descent;
  if (typeof asc === "number" && typeof desc === "number" && asc > 0.5 && asc < 1.5) {
    // A PDF's ascent and descent leave out the line gap, which most fonts put at about 4% of the size
    return Math.max(1, Math.min(1.7, (asc - Math.min(0, desc)) * 1.04));
  }
  return 1.15;
}

/** Docs' ascent and descent of a family, as fractions of the size (where the baseline sits in its line) */
export function fontMetrics(family: string, pdfFont?: { ascent?: number; descent?: number } | null): { ascent: number; descent: number } {
  const asc = pdfFont?.ascent;
  const desc = pdfFont?.descent;
  if (typeof asc === "number" && typeof desc === "number" && asc > 0.5 && asc < 1.5) return { ascent: asc, descent: Math.abs(desc) };
  return family === "Times New Roman" ? { ascent: 0.891, descent: 0.216 } : { ascent: 0.905, descent: 0.212 };
}
