/**
 * Compile the style the app ships: the fingerprint and rules of the whole
 * dataset, every sample as a runtime exemplar, and the winning candidate.
 *
 *   npm run style:compile -- [--dataset solvely] --candidate <id>
 *   npm run style:fingerprint -- [--dataset solvely]      # just print the fingerprint
 */

import fs from "node:fs";
import path from "node:path";
import { loadDataset, type Dataset } from "./dataset";
import { deriveRules, extractFingerprint, renderFingerprint } from "../../src/lib/fingerprint";
import { CANDIDATES } from "../../src/lib/style-candidates";
import type { CompiledStyle } from "../../src/lib/style-spec";

export function compileStyle(ds: Dataset, candidateId: string, evaluation: CompiledStyle["evaluation"]): string {
  if (!CANDIDATES.some((c) => c.id === candidateId)) throw new Error(`Unknown candidate "${candidateId}"`);
  const fp = extractFingerprint(ds.samples);
  if (!fp) throw new Error("No samples to compile");
  const previous = readCompiled(ds.dir);
  const compiled: CompiledStyle = {
    version: 1,
    name: ds.config.name,
    builtAt: new Date().toISOString(),
    candidateId,
    evaluation: evaluation ?? (previous?.candidateId === candidateId ? previous.evaluation : null),
    notes: ds.config.notes,
    fingerprint: fp,
    rules: deriveRules(fp),
    exemplars: ds.samples.map((s) => ({ input: s.input, output: s.output })),
  };
  const file = path.join(ds.dir, "compiled.json");
  fs.writeFileSync(file, JSON.stringify(compiled, null, 2) + "\n");
  fs.writeFileSync(path.join(ds.dir, "fingerprint.txt"), renderFingerprint(fp, compiled.rules) + "\n");
  return file;
}

function readCompiled(dir: string): CompiledStyle | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "compiled.json"), "utf8")) as CompiledStyle; } catch { return null; }
}

function main() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => { const i = argv.findIndex((a) => a === flag || a.startsWith(flag + "=")); if (i < 0) return undefined; return argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1]; };
  const ds = loadDataset(get("--dataset") ?? "solvely");
  if (!ds.samples.length) throw new Error(`No samples in ${path.join(ds.dir, "samples.jsonl")}`);
  if (argv.includes("--print") || path.basename(process.argv[1] ?? "").startsWith("fingerprint")) {
    const fp = extractFingerprint(ds.samples)!;
    console.log(renderFingerprint(fp));
    return;
  }
  const candidate = get("--candidate") ?? readCompiled(ds.dir)?.candidateId;
  if (!candidate) throw new Error("Pass --candidate <id>");
  const out = compileStyle(ds, candidate, null);
  console.log(`Compiled ${ds.samples.length} samples with candidate ${candidate} into ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err instanceof Error ? err.message : err); process.exit(1); }
}
