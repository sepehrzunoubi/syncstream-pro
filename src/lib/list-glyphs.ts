/**
 * List levels the Docs API can't name. A level with neither a glyph symbol nor a numbering type is
 * how the API gives a checklist, and also how it gives the bullets of Docs' older list presets
 * (documents made, or text pasted, before the current presets: their ● ○ ■ carry no symbol of their
 * own). The two look the same in the API, but not in Docs' own export of the tab: its HTML draws each
 * level's glyph (`.lst-kix_<list>-<level>>li:before{content:"\0025cf  "}`), a checklist's as ● at
 * every level (the export has no checkboxes), and the older bullets as they are, ● ○ ■ by level.
 * So a list whose export glyphs aren't ● at every level is a bulleted list, drawn with those glyphs.
 */

import type { docs_v1 } from "googleapis";

const ORDERED = new Set(["DECIMAL", "ZERO_DECIMAL", "UPPER_ALPHA", "ALPHA", "UPPER_ROMAN", "ROMAN"]);
const DISC = "●";

/** A level the API gives no glyph for: a checklist's, or an older preset's bullet */
export function unnamedLevel(level: docs_v1.Schema$NestingLevel | undefined): boolean {
  if (!level || level.glyphSymbol) return false;
  return !(level.glyphType && (ORDERED.has(level.glyphType) || level.glyphType === "NONE"));
}

/** The lists the paragraphs of a document use whose levels the API gives no glyph for */
export function unnamedLists(doc: docs_v1.Schema$Document): string[] {
  const used = new Set<string>();
  const walk = (content: docs_v1.Schema$StructuralElement[] | undefined) => {
    for (const el of content ?? []) {
      const b = el.paragraph?.bullet;
      if (b?.listId && unnamedLevel(doc.lists?.[b.listId]?.listProperties?.nestingLevels?.[b.nestingLevel ?? 0])) used.add(b.listId);
      for (const row of el.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) walk(cell.content ?? []);
    }
  };
  walk(doc.body?.content ?? undefined);
  return [...used];
}

/** A CSS string's text: its escapes (\0025cf, \"), without the spaces Docs pads a glyph with */
function cssText(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch ?? "")).trim();
}

/**
 * The glyph Docs' HTML export draws for each level of each list it styles, by list id (kix.…):
 * a symbol, or null for a numbered level (a counter).
 */
export function exportGlyphs(html: string): Map<string, (string | null)[]> {
  const out = new Map<string, (string | null)[]>();
  const rule = /\.lst-kix_([A-Za-z0-9_-]+)-(\d)>li:before\{content:((?:"(?:[^"\\]|\\.)*"\s*)+)([^}]*)\}/g;
  for (const m of html.matchAll(rule)) {
    const id = `kix.${m[1]}`;
    const level = Number(m[2]);
    const counter = /counter\(/.test(m[4]);
    const text = cssText([...m[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join(""));
    const levels = out.get(id) ?? [];
    // Each rule is written more than once; the first says it
    if (levels[level] === undefined) levels[level] = counter || !text ? null : text;
    out.set(id, levels);
  }
  return out;
}

/**
 * The document with each unnamed list the export draws as bullets given its glyphs. A list the export
 * draws as ● at every level it styles is a checklist (or can't be told from one) and is left as it is.
 * Returns the lists it named.
 */
export function nameLists(doc: docs_v1.Schema$Document, glyphs: Map<string, (string | null)[]>, ids: string[]): string[] {
  const named: string[] = [];
  for (const id of ids) {
    const drawn = glyphs.get(id);
    const levels = doc.lists?.[id]?.listProperties?.nestingLevels;
    if (!drawn || !levels) continue;
    const symbols = drawn.filter((g): g is string => typeof g === "string");
    if (!symbols.length || symbols.every((g) => g === DISC)) continue;
    levels.forEach((level, n) => {
      const g = drawn[n];
      if (g && unnamedLevel(level)) level.glyphSymbol = g;
    });
    named.push(id);
  }
  return named;
}
