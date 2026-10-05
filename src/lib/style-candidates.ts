/**
 * Candidate prompts: the y we are searching for.
 *
 * Each candidate is one strategy for turning the fingerprint, a few
 * exemplars and a user's input into the messages a model receives. The
 * style lab (scripts/style-lab) runs every candidate over the dataset's
 * inputs, scores the replies against the real outputs, and promotes the
 * winner into the compiled style the app ships. Add a strategy here, run
 * the lab, keep it if it wins.
 */

import type { ChatMessage } from "./llm";
import type { Fingerprint, Rule, Sample } from "./fingerprint";
import { LENGTH_BUCKETS } from "./fingerprint";

export interface PromptContext {
  fingerprint: Fingerprint;
  rules: Rule[];
  /** Samples chosen as worked examples for this input */
  exemplars: Sample[];
  /** The operator's own notes, from the dataset's config */
  notes: string;
  text: string;
}

export interface Candidate {
  id: string;
  description: string;
  /** How many exemplars to pick for this strategy */
  exemplars: number;
  temperature: number;
  build: (ctx: PromptContext) => ChatMessage[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

const FIDELITY = "Keep every fact, name, number, date, quotation and citation from the source. Do not add information, examples or opinions. Do not leave anything out. Output only the rewritten text: no preamble, no notes, no headings unless the examples use them.";

function targets(fp: Fingerprint): string {
  const o = fp.output;
  return [
    `Length: about ${pct(fp.lengthRatio)} of the source's word count.`,
    `Sentences: average ${o.meanSentenceWords} words; ${LENGTH_BUCKETS.map((b, k) => `${pct(o.histogram[k])} are ${b.label}`).join(", ")}.`,
    `Clauses: about ${o.wordsPerClause} words per clause, ${o.commasPerSentence} commas per sentence.`,
    `Paragraphs: about ${o.sentencesPerParagraph} sentences each.`,
    `Transitions (however, also, so): about ${o.transitionsPerSentence} per sentence.`,
    `Contractions: ${o.contractions} per 100 words. First person: ${o.firstPerson} per 100 words. Second person: ${o.secondPerson} per 100 words.`,
  ].join("\n");
}

function ruleList(rules: Rule[], max: number, minConfidence: Rule["confidence"] = "low"): string {
  const order = { high: 0, medium: 1, low: 2 };
  return rules
    .filter((r) => order[r.confidence] <= order[minConfidence])
    .slice(0, max)
    .map((r, k) => `${k + 1}. ${r.text}`)
    .join("\n");
}

function notesBlock(notes: string): string {
  return notes.trim() ? `\n\nOperator notes:\n${notes.trim()}` : "";
}

/** Exemplars as alternating user/assistant turns: the format chat models learn from best */
function fewShot(exemplars: Sample[]): ChatMessage[] {
  return exemplars.flatMap((e): ChatMessage[] => [
    { role: "user", content: e.input },
    { role: "assistant", content: e.output },
  ]);
}

/** Exemplars inline in the final user message */
function inlineExamples(exemplars: Sample[]): string {
  return exemplars.map((e, k) => `### Example ${k + 1}\nSource:\n${e.input}\n\nRewritten:\n${e.output}`).join("\n\n");
}

export const CANDIDATES: Candidate[] = [
  {
    id: "fewshot-plain",
    description: "No rules at all: the examples as prior turns, then the input. The baseline every other candidate must beat.",
    exemplars: 4,
    temperature: 0.2,
    build: ({ exemplars, text, notes }) => [
      { role: "system", content: `You rewrite text in a fixed house style. Learn the style from the previous exchanges and apply it exactly. ${FIDELITY}${notesBlock(notes)}` },
      ...fewShot(exemplars),
      { role: "user", content: text },
    ],
  },
  {
    id: "rules-fewshot",
    description: "Explicit rules from the fingerprint, then the examples as prior turns.",
    exemplars: 4,
    temperature: 0.2,
    build: ({ rules, exemplars, text, notes }) => [
      { role: "system", content: `You rewrite text in a fixed house style.\n\nRules of the style:\n${ruleList(rules, 30)}\n\n${FIDELITY}${notesBlock(notes)}` },
      ...fewShot(exemplars),
      { role: "user", content: text },
    ],
  },
  {
    id: "targets-fewshot",
    description: "Numeric targets (sentence length mix, clause density, transitions) plus the strongest rules, then the examples as prior turns.",
    exemplars: 4,
    temperature: 0.2,
    build: ({ fingerprint, rules, exemplars, text, notes }) => [
      { role: "system", content: `You rewrite text in a fixed house style.\n\nMeasured targets of the style:\n${targets(fingerprint)}\n\nRules of the style:\n${ruleList(rules, 20, "medium")}\n\n${FIDELITY}${notesBlock(notes)}` },
      ...fewShot(exemplars),
      { role: "user", content: text },
    ],
  },
  {
    id: "rules-inline",
    description: "Rules and the examples all in one user message, with the source last. Suits models that ignore prior turns.",
    exemplars: 3,
    temperature: 0.2,
    build: ({ rules, exemplars, text, notes }) => [
      { role: "system", content: `You rewrite text in a fixed house style. ${FIDELITY}${notesBlock(notes)}` },
      { role: "user", content: `Rules of the style:\n${ruleList(rules, 30)}\n\n${inlineExamples(exemplars)}\n\n### Now rewrite this source in the same style. Output only the rewritten text.\nSource:\n${text}` },
    ],
  },
  {
    id: "terse-rules",
    description: "The ten highest-confidence rules only, no numbers, examples as prior turns. For small models that drown in detail.",
    exemplars: 4,
    temperature: 0.1,
    build: ({ rules, exemplars, text, notes }) => [
      { role: "system", content: `Rewrite the user's text in this style:\n${ruleList(rules.filter((r) => r.confidence === "high"), 10)}\n${FIDELITY}${notesBlock(notes)}` },
      ...fewShot(exemplars),
      { role: "user", content: text },
    ],
  },
  {
    id: "many-shot",
    description: "Eight examples and the rules. Costs more context; often wins when the style is subtle.",
    exemplars: 8,
    temperature: 0.2,
    build: ({ rules, exemplars, text, notes }) => [
      { role: "system", content: `You rewrite text in a fixed house style.\n\nRules of the style:\n${ruleList(rules, 30)}\n\n${FIDELITY}${notesBlock(notes)}` },
      ...fewShot(exemplars),
      { role: "user", content: text },
    ],
  },
  {
    id: "edit-plan",
    description: "Asks the model to apply the rules as an editor's pass: tighten, re-pace, swap vocabulary, then output. Rules and examples as prior turns.",
    exemplars: 4,
    temperature: 0.2,
    build: ({ fingerprint, rules, exemplars, text, notes }) => [
      { role: "system", content: `You are the final editor of a house style. Work through the source in this order: (1) cut or expand to the target length, (2) re-pace the sentences to the target lengths, (3) adjust clause density and punctuation, (4) swap vocabulary, (5) check that every fact, name and number survived. Then output only the finished text.\n\nMeasured targets:\n${targets(fingerprint)}\n\nRules:\n${ruleList(rules, 30)}\n\n${FIDELITY}${notesBlock(notes)}` },
      ...fewShot(exemplars),
      { role: "user", content: text },
    ],
  },
];

export function candidateById(id: string): Candidate | undefined {
  return CANDIDATES.find((c) => c.id === id);
}

/** Room for the reply: the style's length ratio applied to the input, with headroom */
export function maxOutputTokens(text: string, fp: Fingerprint): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const expected = words * Math.max(0.5, fp.lengthRatio) * 1.6; // ~1.6 tokens per word
  return Math.max(256, Math.min(8192, Math.round(expected * 1.5 + 200)));
}

/** A revision turn: the draft and what to fix, after the original exchange */
export function revisionMessages(base: ChatMessage[], draft: string, fixes: string[]): ChatMessage[] {
  return [
    ...base,
    { role: "assistant", content: draft },
    { role: "user", content: `Revise your draft to fix these, keeping all of its content and every fact:\n${fixes.map((f) => `- ${f}`).join("\n")}\nOutput only the revised text.` },
  ];
}
