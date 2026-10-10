/**
 * Diagnostic: which request recipes make Google Docs nest bullets. Each
 * recipe runs in its own throwaway document (deleted afterwards unless
 * --keep) and prints every paragraph's text and bullet level after each
 * batch. The result decides how the runner should create nested bullets.
 *
 *   npx tsx scripts/e2e-live/probe-lists.ts [--keep]
 */

import type { docs_v1 } from "googleapis";
import { googleDocs, docUrl, type E2EDocs } from "./docs-client";
import { loadLocalEnv, requireEnv } from "./env";

const PRESET = "BULLET_DISC_CIRCLE_SQUARE";
type Para = { text: string; level: number | null; listId: string | null };

function paragraphs(doc: docs_v1.Schema$Document): Para[] {
  const out: Para[] = [];
  for (const el of doc.body?.content ?? []) {
    const p = el.paragraph;
    if (!p) continue;
    const text = (p.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/\n$/, "");
    out.push({ text, level: p.bullet ? p.bullet.nestingLevel ?? 0 : null, listId: p.bullet?.listId ?? null });
  }
  return out;
}

function show(label: string, paras: Para[]) {
  console.log(`  ${label}`);
  for (const p of paras) console.log(`    ${p.level == null ? "  - " : `L${p.level}  `}  ${JSON.stringify(p.text)}${p.listId ? `  (${p.listId.slice(-6)})` : ""}`);
}

const ins = (index: number, text: string) => ({ insertText: { location: { index }, text } });
const create = (startIndex: number, endIndex: number) => ({ createParagraphBullets: { range: { startIndex, endIndex }, bulletPreset: PRESET } });
const del = (startIndex: number, endIndex: number) => ({ deleteParagraphBullets: { range: { startIndex, endIndex } } });

/** Each recipe: a list of batches. A fresh document's body starts at index 1 with its final newline at 1. */
const RECIPES: { name: string; batches: object[][] }[] = [
  {
    name: "R1 one create over three paragraphs typed with tabs (A, \\tB, \\t\\tC), range stops before the final paragraph",
    batches: [[ins(1, "A\n\tB\n\t\tC\n"), create(1, 10)]],
  },
  {
    name: "R2 same, but the range includes the body's final empty paragraph",
    batches: [[ins(1, "A\n\tB\n\t\tC\n"), create(1, 11)]],
  },
  {
    name: "R3 paragraph by paragraph: A bulleted, then \\tB inserted and bulleted alone",
    batches: [[ins(1, "A\n"), create(1, 3)], [ins(3, "\tB\n"), create(3, 6)]],
  },
  {
    name: "R4 A bulleted, then B typed into the list (inherits), then delete bullets over A..B, tab before B, one create over A..B",
    batches: [[ins(1, "A\n"), create(1, 3)], [ins(3, "B\n")], [del(1, 5), ins(3, "\t"), create(1, 6)]],
  },
  {
    name: "R5 like R4 but without the delete: tab before the already bulleted B, one create over A..B",
    batches: [[ins(1, "A\n"), create(1, 3)], [ins(3, "B\n")], [ins(3, "\t"), create(1, 6)]],
  },
  {
    name: "R6 B typed into the list, then delete bullets on B only, tab, create on B only",
    batches: [[ins(1, "A\n"), create(1, 3)], [ins(3, "B\n")], [del(3, 5), ins(3, "\t"), create(3, 6)]],
  },
  {
    name: "R7 the runner's trailing-newline case: A typed with its newline, then the opened (final, empty) paragraph gets a tab and a create of its own",
    batches: [[ins(1, "A\n"), create(1, 3), ins(3, "\t"), create(3, 5)], [ins(3, "B\n")]],
  },
  {
    name: "R8 same as R7 but the create for the opened paragraph spans A..opened (delete first, A keeps 0 tabs)",
    batches: [[ins(1, "A\n"), create(1, 3), del(1, 4), ins(3, "\t"), create(1, 5)], [ins(3, "B\n")]],
  },
];

async function run(docs: E2EDocs, recipe: { name: string; batches: object[][] }, keep: boolean) {
  console.log(`\n== ${recipe.name}`);
  const id = await docs.create(`SyncStream list probe ${recipe.name.slice(0, 2)} ${new Date().toISOString()}`);
  try {
    for (const batch of recipe.batches) {
      try {
        await docs.batchUpdate(id, batch);
      } catch (err) {
        console.log(`  batch refused: ${(err as Error).message}`);
      }
      show(`after ${JSON.stringify(batch).slice(0, 110)}…`, paragraphs(await docs.get(id)));
    }
  } finally {
    if (keep) console.log(`  kept: ${docUrl(id)}`);
    else await docs.remove(id);
  }
}

async function main(): Promise<number> {
  const keep = process.argv.includes("--keep");
  loadLocalEnv();
  const env = requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "E2E_GOOGLE_REFRESH_TOKEN"]);
  if (!env.ok) { console.error(`Missing ${env.missing.join(", ")}; run npm run e2e:live:auth first.`); return 2; }
  const docs = googleDocs({ clientId: env.values.GOOGLE_CLIENT_ID, clientSecret: env.values.GOOGLE_CLIENT_SECRET, refreshToken: env.values.E2E_GOOGLE_REFRESH_TOKEN, paceMs: 700 });
  for (const recipe of RECIPES) await run(docs, recipe, keep);
  console.log("\nWanted: A at L0, B at L1 (and C at L2), with no tab characters left in the text.");
  return 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
