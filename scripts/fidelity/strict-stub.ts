/**
 * A stricter Docs stub, for the sync fidelity tests (fidelity.ts).
 *
 * Extends the offline stub (scripts/e2e-live/stub-docs.ts) with documented
 * Google Docs behaviour the stub leaves out, each behind a flag so a run can
 * show which behaviour changes the result:
 *
 *  - join: "If the paragraph immediately before paragraphs being updated is
 *    in a list with a matching preset, the paragraphs being updated are added
 *    to that preceding list." (CreateParagraphBulletsRequest)
 *  - bulletStyle: "If the range fully contains a paragraph belonging to a
 *    list, the paragraph's bullet is also updated with the matching text
 *    style." (UpdateTextStyleRequest.range); bullets start with an empty
 *    text style; documents.get returns paragraph.bullet.textStyle.
 *  - soloTabs: commit acc3a59's live finding: "a paragraph bulleted on its
 *    own always lands at level 0 (and its tabs stay behind, shifting the
 *    text that follows)". Off unless asked for; fidelity.ts's STRICT has it.
 *  - list styles (always on): each preset draws its own glyphs (list-labels.ts),
 *    and a checklist level has no glyph type or symbol, as the API gives one.
 *  - links (always on): a link set without its colour and underline in
 *    the same request gets Docs' link colour and an underline (TextStyle.link).
 *  - namedStyles: replace the document's named styles (a target doc whose
 *    Normal text / headings differ from Google's defaults).
 */
import type { docs_v1 } from "googleapis";
import { DocsApiError, StubDocument } from "../e2e-live/stub-docs";
import type { E2EDocs } from "../e2e-live/docs-client";
import { presetGlyph } from "../../src/lib/list-labels";

type TextStyle = docs_v1.Schema$TextStyle;
type NL = { k: "nl"; ts: TextStyle; ps: docs_v1.Schema$ParagraphStyle; bullet?: { listId: string; nestingLevel: number; ts?: TextStyle } };

export interface StrictOptions {
  join?: boolean;
  bulletStyle?: boolean;
  soloTabs?: boolean;
  /**
   * A text style whose range ends at a paragraph's newline styles that newline too, the body's last
   * one included; the newline before the range is left alone. Read back from Google Docs: "Big " made
   * bold in "Big \n" leaves the whole paragraph one bold run, and so does styling only its last word.
   */
  ownNewline?: boolean;
  /**
   * A paragraph given bullets, or one that loses them, loses its spacing mode (read back from Google
   * Docs: NEVER_COLLAPSE set before createParagraphBullets is gone after it, set after it stays and is
   * copied to the paragraphs typed from it)
   */
  dropsMode?: boolean;
  /**
   * Paragraphs that join the list of the item before them land at that item's level plus their tabs,
   * and their tabs go even when there is only one of them (read back from Google Docs: a paragraph
   * bulleted right after a nested item is nested with it)
   */
  joinLevel?: boolean;
  namedStyles?: docs_v1.Schema$NamedStyle[];
}

const clone = <T>(v: T): T => structuredClone(v);

export class StrictStubDocument extends StubDocument {
  listPreset: Record<string, string> = {};
  private seq = 0;
  constructor(id: string, title: string, private readonly opts: StrictOptions) {
    super(id, title);
  }

  private paras(s: number, e: number): { start: number; nl: number }[] {
    return (this as unknown as { paragraphsIn(s: number, e: number): { start: number; nl: number }[] }).paragraphsIn(s, e);
  }

  override createParagraphBullets(start: number, end: number, preset: string): void {
    const paragraphs = this.paras(start, end);
    if (!paragraphs.length) throw new DocsApiError(`No paragraph in [${start}, ${end})`, 400);
    // The list to add to: the preceding paragraph's, when it has the same preset
    let listId = `kix.strict${++this.seq}`;
    const prev = this.items[paragraphs[0].start - 1] as NL | undefined;
    const joins = !!this.opts.join && prev?.k === "nl" && !!prev.bullet && this.listPreset[prev.bullet.listId] === preset;
    const under = joins && this.opts.joinLevel ? prev!.bullet!.nestingLevel ?? 0 : 0;
    if (joins) listId = prev!.bullet!.listId;
    else {
      this.lists[listId] = listForPreset(preset);
      this.listPreset[listId] = preset;
    }
    const tabsOf = (p: { start: number }) => {
      let tabs = 0;
      while (this.items[p.start + tabs]?.k === "c" && (this.items[p.start + tabs] as { ch: string }).ch === "\t") tabs++;
      return tabs;
    };
    const fresh = paragraphs.filter((p) => !(this.items[p.nl] as NL).bullet);
    const baseline = fresh.length ? Math.min(...fresh.map(tabsOf)) : 0;
    const solo = this.opts.soloTabs && paragraphs.length === 1 && fresh.length === 1 && !(joins && this.opts.joinLevel);
    for (const p of [...paragraphs].reverse()) {
      const tabs = tabsOf(p);
      const removed = solo ? 0 : tabs;
      this.items.splice(p.start, removed);
      const nl = this.items[p.nl - removed] as NL;
      const leftover = nl.bullet ? 0 : Math.max(0, Math.round((nl.ps.indentStart?.magnitude ?? 0) / 36) - 1);
      const level = nl.bullet ? nl.bullet.nestingLevel ?? 0 : Math.min(8, (solo ? 0 : tabs - baseline) + leftover + under);
      if (this.opts.dropsMode && !nl.bullet) delete (nl.ps as Record<string, unknown>).spacingMode;
      nl.bullet = { listId, nestingLevel: level, ts: this.opts.bulletStyle ? {} : undefined };
      nl.ps.indentFirstLine = { magnitude: 18 + 36 * level, unit: "PT" };
      nl.ps.indentStart = { magnitude: 36 * (level + 1), unit: "PT" };
    }
  }

  override deleteParagraphBullets(start: number, end: number): void {
    if (this.opts.dropsMode) for (const p of this.paras(start, end)) {
      const nl = this.items[p.nl] as NL;
      if (nl.bullet) delete (nl.ps as Record<string, unknown>).spacingMode;
    }
    super.deleteParagraphBullets(start, end);
  }

  override updateTextStyle(start: number, end: number, textStyle: TextStyle, fields: string): void {
    // "The range may be extended to include adjacent newlines": the one its last text's paragraph ends with
    if (this.opts.ownNewline && this.items[end]?.k === "nl" && this.items[end - 1] && this.items[end - 1].k !== "nl") end += 1;
    // "When setting a link, the text foreground color will be updated to the default link color and the
    // text will be underlined. If these fields are modified in the same request, those values will be
    // used instead of the link defaults." (TextStyle.link)
    const masked = fields.split(",").map((f) => f.trim());
    if (textStyle.link?.url && masked.includes("link")) {
      const extra: string[] = [];
      const ts = { ...textStyle };
      if (!masked.includes("underline")) { ts.underline = true; extra.push("underline"); }
      if (!masked.includes("foregroundColor")) { ts.foregroundColor = { color: { rgbColor: { red: 0x11 / 255, green: 0x55 / 255, blue: 0xcc / 255 } } }; extra.push("foregroundColor"); }
      if (extra.length) { textStyle = ts; fields = [...masked, ...extra].join(","); }
    }
    super.updateTextStyle(start, end, textStyle, fields);
    if (!this.opts.bulletStyle) return;
    const keys = fields.split(",").map((f) => f.trim()).filter(Boolean);
    for (const p of this.paras(start, end)) {
      const nl = this.items[p.nl] as NL;
      // "fully contains" a paragraph; "the range may be extended to include adjacent newlines"
      if (!nl.bullet || start > p.start || end < p.nl) continue;
      const ts = (nl.bullet.ts ??= {}) as Record<string, unknown>;
      for (const key of keys) {
        const v = (textStyle as Record<string, unknown>)[key];
        if (v == null) delete ts[key];
        else ts[key] = clone(v);
      }
    }
  }

  override toDocument(): docs_v1.Schema$Document {
    const doc = super.toDocument();
    if (this.opts.namedStyles) doc.namedStyles = { styles: clone(this.opts.namedStyles) };
    for (const el of doc.body?.content ?? []) {
      const p = el.paragraph;
      if (!p?.bullet) continue;
      const nl = this.items[(el.endIndex ?? 0) - 1] as NL | undefined;
      if (nl?.k === "nl" && nl.bullet?.ts) p.bullet.textStyle = clone(nl.bullet.ts);
    }
    return doc;
  }
}

/** A list in a preset's own glyphs (list-labels.ts), each level 36pt deeper with its glyph 18pt before the text */
function listForPreset(preset: string): docs_v1.Schema$List {
  const nestingLevels: docs_v1.Schema$NestingLevel[] = [];
  for (let l = 0; l < 9; l++) {
    const indent = { indentFirstLine: { magnitude: 18 + 36 * l, unit: "PT" }, indentStart: { magnitude: 36 * (l + 1), unit: "PT" } };
    // The API gives a checkbox no glyph type or symbol of its own
    if (preset === "BULLET_CHECKBOX") { nestingLevels.push({ glyphType: "GLYPH_TYPE_UNSPECIFIED", glyphFormat: `%${l}`, ...indent }); continue; }
    const g = presetGlyph(preset, l);
    nestingLevels.push(typeof g === "string" ? { glyphSymbol: g, glyphFormat: `%${l}`, ...indent } : { glyphType: g.type, glyphFormat: g.format, startNumber: 1, ...indent });
  }
  return { listProperties: { nestingLevels } };
}

/** A Docs service of strict stub documents, recording every batch */
export function createStrictStubDocs(opts: StrictOptions): E2EDocs & { docs: Map<string, StrictStubDocument>; batches: object[][] } {
  const docs = new Map<string, StrictStubDocument>();
  const batches: object[][] = [];
  let seq = 0;
  const calls = { reads: 0, writes: 0 };
  const document = (id: string) => {
    const d = docs.get(id);
    if (!d) throw new DocsApiError(`Requested entity was not found: ${id}`, 404);
    return d;
  };
  return {
    kind: "stub",
    calls,
    docs,
    batches,
    async create(title) {
      const id = `strict-doc-${++seq}`;
      docs.set(id, new StrictStubDocument(id, title, opts));
      return id;
    },
    async get(id) {
      calls.reads++;
      return document(id).toDocument();
    },
    async batchUpdate(id, requests, requiredRevisionId) {
      if (!requests.length) return;
      calls.writes++;
      batches.push(clone(requests));
      document(id).batchUpdate(requests as never, requiredRevisionId);
    },
    async remove(id) {
      docs.delete(id);
    },
  };
}
