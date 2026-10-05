/**
 * The dataset of x → z samples, and its train / held-out split.
 */

import fs from "node:fs";
import path from "node:path";
import type { Sample } from "../../src/lib/fingerprint";

export interface DatasetSample extends Sample { id: string; note?: string }

export interface DatasetConfig { name: string; notes: string; holdout: number; seed: number }

export interface Dataset {
  dir: string;
  config: DatasetConfig;
  samples: DatasetSample[];
}

export function datasetDir(name = "solvely"): string {
  return path.resolve(process.cwd(), "style-data", name);
}

/** Read samples.jsonl; a bad line stops the run so it gets fixed */
export function parseSamples(text: string): DatasetSample[] {
  const out: DatasetSample[] = [];
  const ids = new Set<string>();
  text.split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    let row: Partial<DatasetSample>;
    try { row = JSON.parse(line) as Partial<DatasetSample>; } catch (err) { throw new Error(`samples.jsonl line ${idx + 1}: not valid JSON (${err instanceof Error ? err.message : err})`); }
    if (typeof row.input !== "string" || typeof row.output !== "string") throw new Error(`samples.jsonl line ${idx + 1}: needs string "input" and "output"`);
    const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `line${idx + 1}`;
    if (ids.has(id)) throw new Error(`samples.jsonl line ${idx + 1}: duplicate id "${id}"`);
    ids.add(id);
    if (!row.input.trim() || !row.output.trim()) throw new Error(`samples.jsonl line ${idx + 1} (${id}): empty input or output`);
    out.push({ id, input: row.input, output: row.output, ...(typeof row.note === "string" ? { note: row.note } : {}) });
  });
  return out;
}

export function loadDataset(name = "solvely"): Dataset {
  const dir = datasetDir(name);
  const configPath = path.join(dir, "config.json");
  const samplesPath = path.join(dir, "samples.jsonl");
  const config = { name, notes: "", holdout: 0.25, seed: 7, ...(fs.existsSync(configPath) ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<DatasetConfig>) : {}) } as DatasetConfig;
  const samples = fs.existsSync(samplesPath) ? parseSamples(fs.readFileSync(samplesPath, "utf8")) : [];
  return { dir, config, samples };
}

/** Deterministic pseudo-random order from a seed, so the split is the same run after run */
function shuffled<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0 || 1;
  const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

export interface Split { train: DatasetSample[]; test: DatasetSample[] }

/**
 * Hold out a share of the samples to score on; the rest supply the
 * fingerprint and the exemplars. With very few samples everything is
 * tested leave-one-out instead (each sample scored with the others as
 * training data).
 */
export function splitDataset(ds: Dataset, holdoutCount?: number): Split {
  const order = shuffled(ds.samples, ds.config.seed);
  const n = order.length;
  const want = holdoutCount ?? Math.round(n * ds.config.holdout);
  const k = Math.max(1, Math.min(n - 1, want));
  return { test: order.slice(0, k), train: order.slice(k) };
}

export function leaveOneOut(ds: Dataset): { sample: DatasetSample; train: DatasetSample[] }[] {
  return ds.samples.map((sample) => ({ sample, train: ds.samples.filter((s) => s.id !== sample.id) }));
}
