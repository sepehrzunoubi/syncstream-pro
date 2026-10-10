/**
 * Diagnostic: how Google Docs nests bullets when the runner types a nested
 * list chunk by chunk. Replays the runner's exact request sequence (insertText
 * for the chunk, then the same formatting requests the runner sends for it)
 * in a throwaway document and prints every paragraph's bullet level after
 * each batch, for several chunkings. Deletes the document unless --keep.
 *
 *   npx tsx scripts/e2e-live/probe-lists.ts [--keep]
 */

import type { docs_v1 } from "googleapis";
import { DEFAULT_PARAGRAPH, FormatIndex, type DocListState, type ParagraphFormat, type RichFormat } from "../../src/lib/rich-text";
import { googleDocs, docUrl, type E2EDocs } from "./docs-client";
import { loadLocalEnv, requireEnv } from "./env";

const TEXT = "First point\nNested point\nDeeper point\nBack to the top level\nAfter the list\n";
const LIST: ParagraphFormat = { ...DEFAULT_PARAGRAPH, list: "bullet" };
const FORMAT: RichFormat = {
  v: 1,
  paragraphs: [
    { ...LIST, level: 0 },
    { ...LIST, level: 1 },
    { ...LIST, level: 2 },
    { ...LIST, level: 0 },
    DEFAULT_PARAGRAPH,
    DEFAULT_PARAGRAPH,
  ],
  base: DEFAULT_PARAGRAPH,
  runs: [{ len: TEXT.length }],
};

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
  console.log(`\n  ${label}`);
  for (const p of paras) console.log(`    ${p.level == null ? "   -" : `L${p.level}  `}  ${JSON.stringify(p.text)}${p.listId ? `  (${p.listId.slice(-6)})` : ""}`);
}

/** The body's last index where typing appends (just before the final newline) */
function endIndex(doc: docs_v1.Schema$Document): number {
  const content = doc.body?.content ?? [];
  return (content[content.length - 1]?.endIndex ?? 2) - 1;
}

function chunk(text: string, how: "paragraphs" | "five" | "whole"): string[] {
  if (how === "whole") return [text];
  if (how === "paragraphs") return text.split(/(?<=\n)/);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 5) out.push(text.slice(i, i + 5));
  return out;
}

async function replay(docs: E2EDocs, documentId: string, how: "paragraphs" | "five" | "whole", verbose: boolean) {
  console.log(`\n== Chunking: ${how}`);
  const fx = new FormatIndex(TEXT, FORMAT);
  let doc = await docs.get(documentId);
  let cursor = endIndex(doc);
  let list: DocListState = null;
  let offset = 0;
  for (const piece of chunk(TEXT, how)) {
    const requests: object[] = [{ insertText: { location: { index: cursor }, text: piece } }];
    const r = fx.writeRequests(offset, offset + piece.length, cursor, list);
    requests.push(...r.requests);
    if (verbose) console.log("  batch:", JSON.stringify(requests));
    await docs.batchUpdate(documentId, requests);
    list = r.docList;
    cursor += piece.length;
    offset += piece.length;
    doc = await docs.get(documentId);
    show(`after typing ${JSON.stringify(piece)}`, paragraphs(doc).slice(-7));
  }
  // A separator so the next chunking starts a fresh list
  const sep = endIndex(doc);
  await docs.batchUpdate(documentId, [{ insertText: { location: { index: sep }, text: "— separator —\n" } }]);
}

async function main(): Promise<number> {
  const keep = process.argv.includes("--keep");
  const verbose = process.argv.includes("--verbose");
  loadLocalEnv();
  const env = requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "E2E_GOOGLE_REFRESH_TOKEN"]);
  if (!env.ok) { console.error(`Missing ${env.missing.join(", ")}; run npm run e2e:live:auth first.`); return 2; }
  const docs = googleDocs({ clientId: env.values.GOOGLE_CLIENT_ID, clientSecret: env.values.GOOGLE_CLIENT_SECRET, refreshToken: env.values.E2E_GOOGLE_REFRESH_TOKEN, paceMs: 700 });
  const id = await docs.create(`SyncStream list probe ${new Date().toISOString()}`);
  console.log(`Probe document: ${docUrl(id)}`);
  try {
    await replay(docs, id, "paragraphs", verbose);
    await replay(docs, id, "five", verbose);
    await replay(docs, id, "whole", verbose);
    console.log("\nExpected everywhere: L0 First point, L1 Nested point, L2 Deeper point, L0 Back to the top level, - After the list");
  } finally {
    if (keep) console.log(`\nKept: ${docUrl(id)}`);
    else { await docs.remove(id); console.log("\nProbe document deleted."); }
  }
  return 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
