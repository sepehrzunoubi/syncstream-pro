/**
 * Style lab: search for the prompt (y) that turns the dataset's inputs (x)
 * into its outputs (z).
 *
 *   npm run style:eval -- [--dataset solvely] [--candidates a,b] [--holdout N | --loo]
 *                         [--runs 2] [--model llama3.1] [--limit 10] [--promote]
 *
 * The provider comes from LLM_PROVIDER / LLM_BASE_URL / LLM_MODEL (see
 * src/lib/llm.ts). Every candidate is run over the held-out inputs, each
 * reply is scored against the real output, and a leaderboard is printed and
 * saved under style-data/<dataset>/results/. --promote writes the winner
 * into compiled.json (or `npm run style:compile -- --candidate <id>` later).
 */

import fs from "node:fs";
import path from "node:path";
import { loadDataset, leaveOneOut, splitDataset, type DatasetSample } from "./dataset";
import { scoreReply, meanScore, type Score } from "./score";
import { compileStyle } from "./compile";
import { extractFingerprint, deriveRules, selectExemplars, type Fingerprint, type Rule } from "../../src/lib/fingerprint";
import { CANDIDATES, maxOutputTokens, type Candidate } from "../../src/lib/style-candidates";
import { complete, llmConfig, llmStatus } from "../../src/lib/llm";

interface Args { dataset: string; candidates: string[]; holdout?: number; loo: boolean; runs: number; model?: string; limit?: number; promote: boolean; verbose: boolean; concurrency: number }

function parseArgs(argv: string[]): Args {
  const a: Args = { dataset: "solvely", candidates: CANDIDATES.map((c) => c.id), loo: false, runs: 1, promote: false, verbose: false, concurrency: 1 };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split("=");
    const v = inline ?? argv[i + 1];
    const take = () => { if (inline === undefined) i++; return v; };
    switch (k) {
      case "--dataset": a.dataset = take(); break;
      case "--candidates": a.candidates = take().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--holdout": a.holdout = Number(take()); break;
      case "--loo": a.loo = true; break;
      case "--runs": a.runs = Math.max(1, Number(take())); break;
      case "--model": a.model = take(); break;
      case "--limit": a.limit = Number(take()); break;
      case "--concurrency": a.concurrency = Math.max(1, Number(take())); break;
      case "--promote": a.promote = true; break;
      case "--verbose": a.verbose = true; break;
      default: if (k.startsWith("--")) throw new Error(`Unknown option ${k}`);
    }
  }
  return a;
}

interface Trial { candidate: string; sampleId: string; run: number; reply: string; score: Score; ms: number; inputTokens: number; outputTokens: number; error?: string }

export interface RunReport {
  dataset: string;
  startedAt: string;
  model: string;
  provider: string;
  split: { mode: "holdout" | "loo"; train: number; test: number; testIds: string[] };
  leaderboard: { candidate: string; description: string; mean: Score; trials: number; errors: number; meanMs: number }[];
  trials: Trial[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

async function trial(c: Candidate, sample: DatasetSample, train: DatasetSample[], fp: Fingerprint, rules: Rule[], notes: string, run: number, model?: string): Promise<Trial> {
  const exemplars = selectExemplars(train, sample.input, c.exemplars);
  const messages = c.build({ fingerprint: fp, rules, exemplars, notes, text: sample.input });
  try {
    const r = await complete({ messages, maxTokens: maxOutputTokens(sample.input, fp), temperature: c.temperature, model });
    return { candidate: c.id, sampleId: sample.id, run, reply: r.text, score: scoreReply(sample.input, sample.output, r.text, fp), ms: r.ms, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { candidate: c.id, sampleId: sample.id, run, reply: "", score: scoreReply(sample.input, sample.output, "", fp), ms: 0, inputTokens: 0, outputTokens: 0, error: message };
  }
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r, k) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ") + (k === 0 ? "\n" + widths.map((w) => "-".repeat(w)).join("  ") : "")).join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<RunReport> {
  const args = parseArgs(argv);
  const ds = loadDataset(args.dataset);
  if (ds.samples.length < 2) throw new Error(`The ${args.dataset} dataset has ${ds.samples.length} sample(s); the lab needs at least 2 (one to learn from, one to test on). Add samples to ${path.join(ds.dir, "samples.jsonl")}.`);
  const candidates = args.candidates.map((id) => { const c = CANDIDATES.find((x) => x.id === id); if (!c) throw new Error(`Unknown candidate "${id}". Known: ${CANDIDATES.map((x) => x.id).join(", ")}`); return c; });

  const status = await llmStatus();
  const model = args.model ?? status.model;
  console.log(`Model: ${status.provider} ${model} (${status.detail})`);
  if (status.reachable === false) throw new Error("The model server is not reachable. Start it, or set LLM_PROVIDER / LLM_BASE_URL.");

  // Cases to run: each holds the sample to score and the samples to learn from
  let cases: { sample: DatasetSample; train: DatasetSample[] }[];
  let mode: RunReport["split"]["mode"];
  if (args.loo || ds.samples.length <= 4) {
    mode = "loo";
    cases = leaveOneOut(ds);
  } else {
    mode = "holdout";
    const { train, test } = splitDataset(ds, args.holdout);
    cases = test.map((sample) => ({ sample, train }));
  }
  if (args.limit) cases = cases.slice(0, args.limit);
  console.log(`Dataset: ${ds.samples.length} samples, ${mode === "loo" ? "leave-one-out" : "held out"} ${cases.length} to score, ${cases[0].train.length} to learn from. Candidates: ${candidates.map((c) => c.id).join(", ")}. Runs: ${args.runs}.`);

  // Fingerprints per training set (one per case in leave-one-out, one shared otherwise)
  const fpCache = new Map<string, { fp: Fingerprint; rules: Rule[] }>();
  const fpFor = (train: DatasetSample[]) => {
    const key = train.map((s) => s.id).join("|");
    let hit = fpCache.get(key);
    if (!hit) { const fp = extractFingerprint(train)!; hit = { fp, rules: deriveRules(fp) }; fpCache.set(key, hit); }
    return hit;
  };

  const jobs: (() => Promise<Trial>)[] = [];
  for (const c of candidates) for (const { sample, train } of cases) for (let run = 1; run <= args.runs; run++) {
    jobs.push(() => { const { fp, rules } = fpFor(train); return trial(c, sample, train, fp, rules, ds.config.notes, run, args.model); });
  }
  let doneCount = 0;
  const trials = await mapLimit(jobs, args.concurrency, async (job) => {
    const t = await job();
    doneCount += 1;
    const tag = t.error ? `ERROR ${t.error.slice(0, 80)}` : `total ${t.score.total.toFixed(3)} (sim ${t.score.similarity.toFixed(2)}, style ${t.score.style.toFixed(2)}, fid ${t.score.fidelity.toFixed(2)})`;
    console.log(`[${doneCount}/${jobs.length}] ${t.candidate} × ${t.sampleId}${args.runs > 1 ? ` #${t.run}` : ""}: ${tag}${t.score.notes.length && args.verbose ? ` — ${t.score.notes.join("; ")}` : ""}`);
    if (args.verbose && t.reply) console.log(`    ${t.reply.replace(/\s+/g, " ").slice(0, 300)}`);
    return t;
  });

  const leaderboard = candidates.map((c) => {
    const mine = trials.filter((t) => t.candidate === c.id);
    const ok = mine.filter((t) => !t.error);
    return { candidate: c.id, description: c.description, mean: meanScore(mine.map((t) => t.score)), trials: mine.length, errors: mine.length - ok.length, meanMs: ok.length ? Math.round(ok.reduce((a, t) => a + t.ms, 0) / ok.length) : 0 };
  }).sort((a, b) => b.mean.total - a.mean.total);

  console.log("\n" + table([
    ["candidate", "total", "similarity", "style", "fidelity", "errors", "avg ms"],
    ...leaderboard.map((l) => [l.candidate, l.mean.total.toFixed(3), l.mean.similarity.toFixed(3), l.mean.style.toFixed(3), l.mean.fidelity.toFixed(3), String(l.errors), String(l.meanMs)]),
  ]));

  const report: RunReport = {
    dataset: args.dataset, startedAt: new Date().toISOString(), model, provider: status.provider,
    split: { mode, train: cases[0].train.length, test: cases.length, testIds: cases.map((c) => c.sample.id) },
    leaderboard, trials,
  };
  const resultsDir = path.join(ds.dir, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `${report.startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nSaved ${path.relative(process.cwd(), file)}`);

  const winner = leaderboard[0];
  console.log(`Winner: ${winner.candidate} (${winner.mean.total.toFixed(3)}). ${winner.description}`);
  if (args.promote) {
    const out = compileStyle(ds, winner.candidate, { run: path.basename(file), score: winner.mean.total, samples: ds.samples.length, model });
    console.log(`Promoted ${winner.candidate} into ${path.relative(process.cwd(), out)}`);
  } else {
    console.log(`To ship it: npm run style:compile -- --candidate ${winner.candidate}`);
  }
  return report;
}

if (require.main === module) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}

export { llmConfig };
