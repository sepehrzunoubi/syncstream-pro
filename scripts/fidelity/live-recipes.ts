/**
 * Live recipes that settle the Docs API behaviours the strict stub
 * (strict-stub.ts) assumes and nothing could verify without credentials. Same shape as
 * scripts/e2e-live/probe-lists.ts: each recipe runs in its own throwaway
 * document and prints every paragraph (text, bullet level, list id, bullet
 * text style, the paragraph style fields that matter) after each batch.
 *
 *   npx tsx scripts/fidelity/live-recipes.ts [--keep] [--stub] [Q1 Q4 ...]
 *
 * --stub runs the same batches against the offline stub, to show where the
 * stub's answer is an assumption.
 */
import type { docs_v1 } from "googleapis";
import { googleDocs, docUrl, type E2EDocs } from "../e2e-live/docs-client";
import { loadLocalEnv, requireEnv } from "../e2e-live/env";
import { createStubDocs } from "../e2e-live/stub-docs";

const BUL = "BULLET_DISC_CIRCLE_SQUARE";
const NUM = "NUMBERED_DECIMAL_ALPHA_ROMAN";
const ins = (index: number, text: string) => ({ insertText: { location: { index }, text } });
const create = (startIndex: number, endIndex: number, bulletPreset = BUL) => ({ createParagraphBullets: { range: { startIndex, endIndex }, bulletPreset } });
const del = (startIndex: number, endIndex: number) => ({ deleteParagraphBullets: { range: { startIndex, endIndex } } });
const delText = (startIndex: number, endIndex: number) => ({ deleteContentRange: { range: { startIndex, endIndex } } });
const rgb = (r: number, g: number, b: number) => ({ color: { rgbColor: { red: r, green: g, blue: b } } });
const textStyle = (startIndex: number, endIndex: number, ts: object, fields: string) => ({ updateTextStyle: { range: { startIndex, endIndex }, textStyle: ts, fields } });
const paraStyle = (startIndex: number, endIndex: number, ps: object, fields: string) => ({ updateParagraphStyle: { range: { startIndex, endIndex }, paragraphStyle: ps, fields } });
const PT = (magnitude: number) => ({ magnitude, unit: "PT" });
const GREEN = rgb(0.851, 0.918, 0.827);

/** Each recipe: a question, the batches, what each possible answer means for the runner */
const RECIPES: { id: string; q: string; batches: object[][] }[] = [
  {
    id: "Q1",
    q: "Bullet text style: what does createParagraphBullets give the bullet, and which updateTextStyle ranges restyle it? (a) highlight [1,12) = all text, no newline; (b) [1,13) with the newline; (c) [3,8) partial",
    batches: [
      [ins(1, "Hello world\nSecond item\nThird item\n"), create(1, 36)],
      [textStyle(1, 12, { backgroundColor: GREEN }, "backgroundColor")],
      [textStyle(13, 25, { backgroundColor: GREEN, fontSize: PT(16) }, "backgroundColor,fontSize")],
      [textStyle(27, 31, { foregroundColor: rgb(1, 0, 0) }, "foregroundColor")],
    ],
  },
  {
    id: "Q2",
    q: "Does deleting and re-creating bullets (the runner's re-creation from a list's first item) reset bullet.textStyle?",
    batches: [
      [ins(1, "Styled bullet\n"), create(1, 15), textStyle(1, 15, { backgroundColor: GREEN, fontSize: PT(16) }, "backgroundColor,fontSize")],
      [del(1, 15), paraStyle(1, 15, { indentStart: PT(0), indentFirstLine: PT(0) }, "indentStart,indentFirstLine"), create(1, 15)],
    ],
  },
  {
    id: "Q3",
    q: "Join: does a list created right after a list with the same preset join it (same listId, numbering continues)? After an empty paragraph? After a different preset?",
    batches: [
      [ins(1, "A1\nA2\nB1\n\nC1\nD1\n"), create(1, 7, NUM)],
      [create(7, 10, NUM)],
      [create(11, 14, NUM)],
      [create(14, 17, BUL)],
    ],
  },
  {
    id: "Q4a",
    q: "Nesting of a paragraph bulleted on its own, after a plain paragraph, with one leading tab: level, and does the tab stay in the text?",
    batches: [[ins(1, "Plain\n\tTabbed\n")], [create(7, 15)]],
  },
  {
    id: "Q4b",
    q: "Nesting from indentation: a lone paragraph with indentStart 72 / first line 54 and no tab, bulleted: level 1?",
    batches: [[ins(1, "Plain\nIndented\n"), paraStyle(7, 16, { indentStart: PT(72), indentFirstLine: PT(54) }, "indentStart,indentFirstLine")], [create(7, 16)]],
  },
  {
    id: "Q4c",
    q: "Nesting from indentation: indentStart 108 / first line 90, bulleted alone: level 2?",
    batches: [[ins(1, "Plain\nDeeper\n"), paraStyle(7, 14, { indentStart: PT(108), indentFirstLine: PT(90) }, "indentStart,indentFirstLine")], [create(7, 14)]],
  },
  {
    id: "Q4d",
    q: "A tabbed paragraph bulleted alone right after an item of a same-preset list (the runner's 'not ours' case): joins? level? tab left?",
    batches: [[ins(1, "Top\n\tChild\n"), create(1, 5)], [create(5, 12)]],
  },
  {
    id: "Q5",
    q: "Numbered list with bullet sub-items: one numbered list over all four (tabs), then delete bullets on the two sub-items and re-bullet them with a bullet preset; does O2 stay '2.' and do B1/B2 land at level 1?",
    batches: [
      [ins(1, "O1\n\tB1\n\tB2\nO2\n"), create(1, 15, NUM)],
      [del(4, 10), create(4, 10, BUL)],
    ],
  },
  {
    id: "Q6",
    q: "Soft line break: is U+000B kept by insertText as a line break inside one paragraph (and inside a list item)?",
    batches: [[ins(1, "line one\u000bline two\nitem one\u000bstill item one\n"), create(19, 43)]],
  },
  {
    id: "Q7",
    q: "Side effects of namedStyleType: Enter in a H1 with explicit spacing and 20pt text, then NORMAL_TEXT set on the new paragraph (copied spaceAbove kept?), then HEADING_2 (explicit 20pt text kept?)",
    batches: [
      [ins(1, "Heading"), paraStyle(1, 8, { namedStyleType: "HEADING_1", spaceAbove: PT(20), spaceBelow: PT(6) }, "namedStyleType,spaceAbove,spaceBelow"), textStyle(1, 8, { fontSize: PT(20) }, "fontSize")],
      [ins(8, "\nBody")],
      [paraStyle(9, 13, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType")],
      [paraStyle(9, 13, { namedStyleType: "HEADING_2" }, "namedStyleType")],
    ],
  },
  {
    id: "Q8",
    q: "spacingMode: what do list paragraphs made by createParagraphBullets get, and does COLLAPSE_LISTS / NEVER_COLLAPSE stick when set?",
    batches: [
      [ins(1, "one\ntwo\nthree\n"), paraStyle(1, 15, { spaceAbove: PT(10), spaceBelow: PT(10) }, "spaceAbove,spaceBelow"), create(1, 15)],
      [paraStyle(1, 15, { spacingMode: "NEVER_COLLAPSE" }, "spacingMode")],
    ],
  },
  {
    id: "Q9",
    q: "Links: link set alone (colour and underline defaults?), then a link with underline:false and black set in the same request",
    batches: [
      [ins(1, "first link and second link\n"), textStyle(1, 11, { link: { url: "https://example.com/" } }, "link")],
      [textStyle(16, 27, { link: { url: "https://example.com/" }, underline: false, foregroundColor: rgb(0, 0, 0) }, "link,underline,foregroundColor")],
    ],
  },
  {
    id: "Q10",
    q: "Continue numbering across a paragraph: one numbered list over I1, N, I2, then delete the bullet of N: is I2 still '2.'?",
    batches: [[ins(1, "I1\nNote\nI2\n"), create(1, 12, NUM), del(4, 9), paraStyle(4, 9, { indentStart: PT(0), indentFirstLine: PT(0) }, "indentStart,indentFirstLine")]],
  },
  {
    id: "Q11",
    q: "Avoid joining: a temporary empty paragraph between two same-preset lists while the second is created, then the temporary paragraph deleted: two lists (second restarts at 1)?",
    batches: [[ins(1, "L1\nL2\n\nM1\nM2\n"), create(1, 7, NUM), create(8, 14, NUM), delText(7, 8)]],
  },
  {
    id: "Q13a",
    q: "Nesting a lone item: bullet it together with a helper paragraph before it (the helper at level 0, the item with two tabs), then delete the helper: does the item keep level 2 (■ at 108pt)?",
    batches: [[ins(1, "Plain\nH\n\t\tSolo\n")], [create(7, 16)], [delText(7, 9)]],
  },
  {
    id: "Q13b",
    q: "The same with the helper after the item: bullet [\\t\\tSolo, H], then delete H: does Solo keep level 2?",
    batches: [[ins(1, "Plain\n\t\tSolo\nH\n")], [create(7, 16)], [delText(12, 14)]],
  },
  {
    id: "Q14",
    q: "A text style up to a paragraph's newline: is the newline styled too? (a) all of \"Big \" in \"Big \\n\"; (b) only the last word; (c) text right after a newline: is the newline before it left alone? Answered: (a) yes, (b) yes, the body's last newline included, (c) yes.",
    batches: [
      [ins(1, "\n"), ins(1, "Big bold "), textStyle(5, 10, { bold: true }, "bold")],
      [ins(11, "Next\n"), textStyle(11, 15, { italic: true }, "italic")],
    ],
  },
  {
    id: "Q15",
    q: "Spacing mode and bullets: does createParagraphBullets keep a paragraph's NEVER_COLLAPSE? does deleteParagraphBullets? is one set after the bullets copied to the next item typed? Answered: dropped by both, kept and copied when set after.",
    batches: [
      [ins(1, "Item\nNext\n"), paraStyle(1, 5, { spacingMode: "NEVER_COLLAPSE" }, "spacingMode"), create(1, 5, NUM)],
      [paraStyle(1, 5, { spacingMode: "NEVER_COLLAPSE" }, "spacingMode"), ins(5, "\nItem two")],
      [del(1, 5)],
    ],
  },
  {
    id: "Q16",
    q: "Joining a list after a nested item: at which level do paragraphs bulleted right after it land? (a) one with no tab; (b) one with a tab; (c) two, the second with a tab, after a top-level item. Answered: at the level of the item before plus their tabs counted from the least of them: (a) nested with it, (b) the same, its tab gone, (c) top level and one deeper.",
    batches: [
      [ins(1, "One\n\tTwo\nThree\nFour\n"), create(1, 10, NUM)],
      [create(9, 15, NUM)],
      [ins(15, "\t"), create(15, 21, NUM)],
    ],
  },
  {
    id: "Q12",
    q: "documentFormat: does updateDocumentStyle accept documentMode PAGELESS (and flipPageOrientation)?",
    batches: [
      [{ updateDocumentStyle: { documentStyle: { documentFormat: { documentMode: "PAGELESS" } }, fields: "documentFormat" } }],
      [{ updateDocumentStyle: { documentStyle: { documentFormat: { documentMode: "PAGES" }, flipPageOrientation: true }, fields: "documentFormat,flipPageOrientation" } }],
    ],
  },
];

const hex = (c: docs_v1.Schema$OptionalColor | undefined | null) => {
  const r = c?.color?.rgbColor;
  if (!r) return "";
  const h = (v: number | null | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${h(r.red)}${h(r.green)}${h(r.blue)}`;
};
const ts = (t: docs_v1.Schema$TextStyle | undefined | null) => (t ? JSON.stringify({ ...t, ...(t.backgroundColor ? { backgroundColor: hex(t.backgroundColor) } : {}), ...(t.foregroundColor ? { foregroundColor: hex(t.foregroundColor) } : {}) }) : "-");

function show(label: string, doc: docs_v1.Schema$Document) {
  console.log(`  ${label}`);
  for (const el of doc.body?.content ?? []) {
    const p = el.paragraph;
    if (!p) continue;
    const text = (p.elements ?? []).map((e) => e.textRun?.content ?? (e.pageBreak ? "[PB]" : "")).join("");
    const ps = p.paragraphStyle ?? {};
    const pick = { named: ps.namedStyleType, above: ps.spaceAbove?.magnitude, below: ps.spaceBelow?.magnitude, start: ps.indentStart?.magnitude, first: ps.indentFirstLine?.magnitude, mode: ps.spacingMode };
    const b = p.bullet;
    const runs = (p.elements ?? []).map((e) => ts(e.textRun?.textStyle)).join(" ");
    console.log(`    ${b ? `L${b.nestingLevel ?? 0} ${String(b.listId).slice(-6)} bullet=${ts(b.textStyle)}` : "-"}  ${JSON.stringify(text)}  ${JSON.stringify(pick)}  runs=${runs}`);
  }
  const ds = doc.documentStyle as Record<string, unknown> | undefined;
  if (ds?.documentFormat || ds?.flipPageOrientation) console.log(`    documentStyle ${JSON.stringify({ documentFormat: ds.documentFormat, flipPageOrientation: ds.flipPageOrientation })}`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const only = args.filter((a) => /^Q\d+[a-z]?$/.test(a));
  let docs: E2EDocs;
  if (args.includes("--stub")) docs = createStubDocs();
  else {
    loadLocalEnv();
    const env = requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "E2E_GOOGLE_REFRESH_TOKEN"]);
    if (!env.ok) { console.error(`Missing ${env.missing.join(", ")}; run npm run e2e:live:auth first (or pass --stub).`); return 2; }
    docs = googleDocs({ clientId: env.values.GOOGLE_CLIENT_ID, clientSecret: env.values.GOOGLE_CLIENT_SECRET, refreshToken: env.values.E2E_GOOGLE_REFRESH_TOKEN, paceMs: 700 });
  }
  for (const r of RECIPES.filter((x) => !only.length || only.includes(x.id))) {
    console.log(`\n== ${r.id}: ${r.q}`);
    const id = await docs.create(`SyncStream live recipe ${r.id} ${new Date().toISOString()}`);
    try {
      for (const batch of r.batches) {
        try { await docs.batchUpdate(id, batch); } catch (err) { console.log(`  batch refused: ${(err as Error).message}`); }
        show(`after ${JSON.stringify(batch).slice(0, 120)}…`, await docs.get(id));
      }
    } finally {
      if (keep && docs.kind === "google") console.log(`  kept: ${docUrl(id)}`);
      else await docs.remove(id);
    }
  }
  return 0;
}
main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
