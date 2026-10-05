/**
 * How close is a model's reply to the output we want to mirror?
 *
 * Three views, each 0..1:
 *   similarity  wording overlap with the reference output (token F1 and
 *               longest-common-subsequence ratio, order-aware)
 *   style       how the reply measures against the fingerprint's targets
 *               (pacing, clause density, voice, punctuation), independent
 *               of wording, so a reply can score well with different words
 *   fidelity    content kept from the input: names, numbers, and a length
 *               that is neither a summary nor padding
 * The total weights wording and style equally and treats fidelity as a gate.
 */

import { diffWords, namesAndNumbers, wordsOf } from "../../src/lib/style-metrics";
import { matchFingerprint, type Fingerprint } from "../../src/lib/fingerprint";

export interface Score {
  similarity: number;
  tokenF1: number;
  lcsRatio: number;
  style: number;
  fidelity: number;
  namesKept: number;
  lengthFit: number;
  total: number;
  /** Why points were lost, for the report */
  notes: string[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const norm = (w: string) => w.toLowerCase().replace(/[’']/g, "'");

export function tokenF1(reference: string, candidate: string): number {
  const ref = wordsOf(reference).map(norm);
  const cand = wordsOf(candidate).map(norm);
  if (!ref.length || !cand.length) return 0;
  const counts = new Map<string, number>();
  for (const w of ref) counts.set(w, (counts.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of cand) { const c = counts.get(w) ?? 0; if (c > 0) { hit += 1; counts.set(w, c - 1); } }
  if (!hit) return 0;
  const p = hit / cand.length;
  const r = hit / ref.length;
  return (2 * p * r) / (p + r);
}

/** Share of the reference's words that appear in the candidate in the same order */
export function lcsRatio(reference: string, candidate: string): number {
  const refWords = wordsOf(reference).length;
  if (!refWords) return 0;
  const kept = diffWords(reference, candidate).filter((o) => o.type === "equal").reduce((a, o) => a + wordsOf(o.text).length, 0);
  return kept / refWords;
}

export function scoreReply(input: string, reference: string, reply: string, fp: Fingerprint): Score {
  const notes: string[] = [];
  const text = reply.trim();
  if (!text) return { similarity: 0, tokenF1: 0, lcsRatio: 0, style: 0, fidelity: 0, namesKept: 0, lengthFit: 0, total: 0, notes: ["empty reply"] };

  const f1 = tokenF1(reference, text);
  const lcs = lcsRatio(reference, text);
  const similarity = 0.5 * f1 + 0.5 * lcs;

  const match = matchFingerprint(fp, input, text);
  for (const d of match.deviations.slice(0, 3)) notes.push(`${d.metric}: ${d.actual} vs ${d.target}`);

  const names = namesAndNumbers(input);
  const words = new Set(wordsOf(text));
  const namesKept = names.length ? names.filter((n) => words.has(n)).length / names.length : 1;
  if (namesKept < 1) notes.push(`dropped: ${names.filter((n) => !words.has(n)).slice(0, 5).join(", ")}`);

  // Length relative to the reference: within ±15% is perfect, half or double is zero
  const refWords = wordsOf(reference).length || 1;
  const ratio = wordsOf(text).length / refWords;
  const lengthFit = Math.max(0, 1 - Math.max(0, Math.abs(Math.log(ratio)) - Math.log(1.15)) / (Math.log(2) - Math.log(1.15)));
  if (lengthFit < 1) notes.push(`length ${Math.round(ratio * 100)}% of reference`);

  // Preamble or commentary the model added around the text
  if (/^(here is|here's|sure|certainly|below is)/i.test(text) || /^(rewritten|revised) (text|version)[:\s]/i.test(text)) notes.push("preamble");

  const fidelity = 0.6 * namesKept + 0.4 * lengthFit;
  const total = (0.5 * similarity + 0.5 * match.score) * (0.5 + 0.5 * fidelity);
  return {
    similarity: round(similarity), tokenF1: round(f1), lcsRatio: round(lcs),
    style: round(match.score), fidelity: round(fidelity), namesKept: round(namesKept), lengthFit: round(lengthFit),
    total: round(total), notes,
  };
}

export function meanScore(scores: Score[]): Score {
  const avg = (f: (s: Score) => number) => round(scores.reduce((a, s) => a + f(s), 0) / Math.max(1, scores.length));
  return {
    similarity: avg((s) => s.similarity), tokenF1: avg((s) => s.tokenF1), lcsRatio: avg((s) => s.lcsRatio),
    style: avg((s) => s.style), fidelity: avg((s) => s.fidelity), namesKept: avg((s) => s.namesKept), lengthFit: avg((s) => s.lengthFit),
    total: avg((s) => s.total), notes: [],
  };
}
