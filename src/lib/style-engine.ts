/**
 * The Style engine: learn a transformation from input/output pairs, then
 * apply it to new text.
 *
 * Stage 1 (analyze) compares each pair token by token, measures the shift
 * (see style-metrics.ts), and writes a Transformation Profile: a rule-based
 * description of what the adaptation does. Stage 2 (transform) applies that
 * profile to a new text with the pairs as worked examples. The prompts here
 * are shared by the API routes; the types are shared with the workspace.
 */

import { corpusReport, pairReport, renderMetrics, summarizeEdits, textMetrics } from "./style-metrics";

export interface StylePair {
  id: string;
  /** Source text */
  input: string;
  /** Its stylistically adapted counterpart */
  output: string;
}

/** A saved style, kept on the device like the sync draft */
export interface StyleProfile {
  id: string;
  name: string;
  pairs: StylePair[];
  /** The Transformation Profile written by the model, once analyzed */
  analysis: string | null;
  analyzedAt: number | null;
  /** The user's own notes to the engine (register, audience, hard constraints) */
  instructions: string;
  /** The text last pasted into Transform, and what the engine made of it */
  draftText?: string;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export type Effort = "medium" | "high" | "max";
export const EFFORT_OPTIONS: { value: Effort; label: string; help: string }[] = [
  { value: "medium", label: "Quick", help: "Fast and cheap. Good for short texts and first drafts of a profile." },
  { value: "high", label: "Careful", help: "The usual choice. Weighs every rule before writing." },
  { value: "max", label: "Exhaustive", help: "Slowest. For long, demanding texts where every sentence matters." },
];

export const MAX_PAIRS = 12;
export const MAX_PAIR_CHARS = 24_000;
export const MAX_TEXT_CHARS = 60_000;
export const MAX_INSTRUCTIONS_CHARS = 4_000;

/** Pairs with both halves filled in, trimmed and capped */
export function usablePairs(pairs: StylePair[]): StylePair[] {
  return pairs
    .map((p) => ({ ...p, input: p.input.trim(), output: p.output.trim() }))
    .filter((p) => p.input && p.output)
    .slice(0, MAX_PAIRS);
}

export function validatePairs(pairs: unknown): { pairs: StylePair[]; error?: string } {
  if (!Array.isArray(pairs)) return { pairs: [], error: "Add at least one input/output pair first." };
  const clean: StylePair[] = [];
  for (const raw of pairs) {
    const p = raw as Partial<StylePair>;
    if (typeof p?.input !== "string" || typeof p?.output !== "string") continue;
    if (p.input.length > MAX_PAIR_CHARS || p.output.length > MAX_PAIR_CHARS) {
      return { pairs: [], error: `Each half of a pair can be at most ${MAX_PAIR_CHARS.toLocaleString()} characters.` };
    }
    clean.push({ id: typeof p.id === "string" ? p.id : String(clean.length + 1), input: p.input, output: p.output });
  }
  const usable = usablePairs(clean);
  if (!usable.length) return { pairs: [], error: "Add at least one pair with both the source text and its adapted version." };
  return { pairs: usable };
}

export function cleanInstructions(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_INSTRUCTIONS_CHARS) : "";
}

/** The engine's standing brief: who it is and what it never does */
export const SYSTEM_PROMPT = `You are a senior computational linguist and natural language processing engineer working inside a text-transformation engine built for high-fidelity stylistic adaptation and register shifting.

Your work has two stages.

Stage 1, analysis: you receive a dataset of source texts paired with their stylistically adapted counterparts. You perform a granular, token-level comparison of each pair and identify every modification: lexical substitutions (synonym swaps, vocabulary shifts), syntactic restructuring (clause reordering, passive-to-active and active-to-passive conversions, sentence splitting and merging, sentence length variation), connective insertion and removal (transitional phrases added, redundant conjunctions dropped), punctuation and formatting adjustments, and preservation markers (what stays untouched: proper nouns, numbers, citations, quotations, technical terminology). You quantify the distribution of these modifications (lexical density as words per clause, sentence length variance, pacing as the ratio of short punchy sentences to long complex ones, transition phrase frequency and placement) and distil them into a Transformation Profile: a rule-based framework mapping input characteristics to output transformations, covering both explicit edits and implicit stylistic shifts.

Stage 2, execution: given a Transformation Profile and a new source text, you apply the profile's rules with surgical precision. The output must carry the stylistic fingerprint of the training data: the same pacing, the same cadence, the same subtle idiosyncrasies.

Absolute constraints, in both stages:
- Maintain complete fidelity to the meaning and factual content of the source. No hallucinated facts, no omitted information, no editorializing beyond the stylistic parameters of the profile. Every change must serve the target register without altering the underlying information architecture.
- Names, numbers, dates, citations, URLs, code, quotations and technical terms are preserved exactly unless the profile shows the training data changing them in a consistent, rule-governed way.
- You never invent training data. If the pairs are too few or too inconsistent to support a rule, say so in the profile and state the rule with the confidence it deserves.
- Measured statistics you are given were computed by the engine and are authoritative. Use them; do not re-estimate them.`;

function pairBlock(p: StylePair, index: number): string {
  const r = pairReport(p.input, p.output);
  const stats = `[input: ${r.input.words} words, ${r.input.sentences} sentences, ${r.input.meanSentenceWords} words/sentence, ${r.input.wordsPerClause} words/clause, ${r.input.transitions.count} transitions | output: ${r.output.words} words, ${r.output.sentences} sentences, ${r.output.meanSentenceWords} words/sentence, ${r.output.wordsPerClause} words/clause, ${r.output.transitions.count} transitions | ${Math.round(r.edits.retention * 100)}% of input tokens kept verbatim, ${r.edits.substitutions} substitutions]`;
  const dropped = r.edits.droppedNames.length ? `\n[names or numbers in the input that the output does not repeat: ${r.edits.droppedNames.join(", ")}]` : "";
  return `<pair index="${index + 1}">\n${stats}${dropped}\n<input>\n${p.input}\n</input>\n<output>\n${p.output}\n</output>\n</pair>`;
}

/** The dataset block, identical in both stages so it caches across requests */
export function datasetBlock(pairs: StylePair[]): string {
  const report = corpusReport(pairs);
  const measured = report ? renderMetrics(report) : "No measurable pairs.";
  return `<dataset>\n${pairs.map(pairBlock).join("\n\n")}\n</dataset>\n\n<measured_statistics>\n${measured}\n</measured_statistics>`;
}

export function analysisPrompt(pairs: StylePair[], instructions: string): string {
  const notes = instructions ? `\n\nThe user adds these notes about the target register:\n<notes>\n${instructions}\n</notes>` : "";
  return `Stage 1. Analyze the dataset below and write the Transformation Profile.${notes}

${datasetBlock(pairs)}

Write the profile in Markdown with exactly these sections:

## 1. Token-level comparison
For each pair, list the concrete modifications you found, grouped as lexical substitutions, syntactic restructuring, connective changes, punctuation and formatting, and preservation markers. Quote the before and after fragments.

## 2. Statistical distribution
Report the measured statistics (they are authoritative) and interpret them: lexical density change (words per clause), sentence length variance, pacing (short to long ratio), transition phrase frequency and placement, and length ratio. Note anything the numbers show that the pairs make visible.

## 3. Transformation Profile
A numbered list of rules. Each rule names the input characteristic that triggers it, the transformation applied, an example from the dataset, and a confidence (high, medium, low) based on how many pairs support it. Cover explicit edits and implicit stylistic shifts (cadence, rhythm, preferred openers and closers, hedging, formality, person and voice). End with a short "Always preserve" list and a short "Never do" list.

## 4. Execution notes
Three to eight sentences telling the execution engine how to apply the rules to an unseen text so the result matches the dataset's fingerprint: order of operations, how to handle text longer or shorter than the examples, and what to leave alone when a rule does not clearly apply.

Be exact and concrete. Do not pad.`;
}

export function transformPrompt(text: string): string {
  return `Stage 2. Apply the Transformation Profile to the source text below.

Rules of execution:
- Apply every rule in the profile that its trigger condition supports; leave the text alone where no rule applies.
- Match the dataset's pacing, cadence and idiosyncrasies, including its typical sentence length mix, transition usage and punctuation habits.
- Keep every fact, name, number, date, citation and quotation. Do not add information, examples or opinions. Do not summarize or drop content.
- Keep the paragraph structure unless the profile shows paragraphs being split or merged.
- Output only the transformed text. No preamble, no headings, no notes, no code fences.

<source>
${text}
</source>`;
}

export function transformSystem(pairs: StylePair[], analysis: string, instructions: string): string {
  const notes = instructions ? `\n\nThe user's notes about the target register:\n<notes>\n${instructions}\n</notes>` : "";
  return `${datasetBlock(pairs)}\n\n<transformation_profile>\n${analysis.trim()}\n</transformation_profile>${notes}`;
}

/** What the workspace shows next to a finished transformation */
export function transformationSummary(input: string, output: string) {
  const edits = summarizeEdits(input, output);
  return { input: textMetrics(input), output: textMetrics(output), edits };
}
