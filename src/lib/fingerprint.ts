/**
 * Stylistic fingerprint of a dataset of input/output samples.
 *
 * Everything here is deterministic: no model is involved. From the samples
 * it extracts how the target style paces its sentences, how dense its
 * clauses are, which words it prefers, drops or swaps, how it punctuates
 * and structures text, and what it preserves. The numbers become explicit
 * rules with evidence counts, a target the output of a model can be scored
 * against, and (see prompt-compiler.ts) a prompt a small local model can
 * follow. Feed it more samples and the fingerprint sharpens.
 */

import {
  countClauses, diffWords, namesAndNumbers, splitParagraphs, splitSentences, textMetrics, tokenizeForDiff, transitionMetrics, wordsOf,
  LONG_SENTENCE, SHORT_SENTENCE,
} from "./style-metrics";

export interface Sample { input: string; output: string }

/** Sentence length classes used for pacing and rhythm */
export const LENGTH_BUCKETS: { label: string; max: number }[] = [
  { label: "1–8 words", max: 8 },
  { label: "9–15 words", max: 15 },
  { label: "16–25 words", max: 25 },
  { label: "26+ words", max: Infinity },
];

export interface SideStats {
  words: number;
  sentences: number;
  paragraphs: number;
  meanSentenceWords: number;
  stdSentenceWords: number;
  medianSentenceWords: number;
  /** Share of sentences in each LENGTH_BUCKET (0..1) */
  histogram: number[];
  shortShare: number;
  longShare: number;
  /** Share of adjacent sentence pairs whose length class differs: how much the rhythm alternates */
  alternation: number;
  sentencesPerParagraph: number;
  wordsPerClause: number;
  clausesPerSentence: number;
  commasPerSentence: number;
  /** Per sentence */
  subordinators: number;
  coordinators: number;
  /** Per 100 words */
  contractions: number;
  firstPerson: number;
  secondPerson: number;
  hedges: number;
  intensifiers: number;
  /** Per sentence */
  passive: number;
  questions: number;
  exclamations: number;
  /** Per 100 words */
  semicolons: number;
  colons: number;
  dashes: number;
  parentheses: number;
  quotes: number;
  meanWordLength: number;
  typeTokenRatio: number;
  transitionsPerSentence: number;
  /** Of transitions, the share that opens its sentence */
  transitionInitialShare: number;
  /** Share of paragraphs that are list items, headings, or bold-led */
  bullets: number;
  headings: number;
}

export interface WordShift { word: string; outputPer1k: number; inputPer1k: number; outputCount: number; inputCount: number }
export interface Substitution { from: string; to: string; count: number }
export interface Counted { text: string; count: number; share: number }

export interface Fingerprint {
  samples: number;
  input: SideStats;
  output: SideStats;
  lengthRatio: number;
  sentenceRatio: number;
  paragraphRatio: number;
  vocabulary: {
    preferred: WordShift[];
    avoided: WordShift[];
    substitutions: Substitution[];
    openers: Counted[];
    phrases: Counted[];
    transitions: Counted[];
  };
  preservation: {
    retention: number;
    namesKept: number;
    numbersKept: number;
  };
}

export interface Rule {
  id: string;
  /** Imperative, as the model reads it */
  text: string;
  /** What in the samples supports it */
  evidence: string;
  confidence: "high" | "medium" | "low";
  category: "length" | "pacing" | "clauses" | "vocabulary" | "voice" | "punctuation" | "structure" | "preservation";
}

// ── Lexicons ────────────────────────────────────────────────────────────

const SUBORDINATORS = ["because", "although", "though", "while", "whereas", "which", "that", "when", "whenever", "where", "if", "unless", "until", "since", "after", "before", "as", "so that", "even though", "whether"];
const COORDINATORS = ["and", "but", "or", "nor", "so", "yet"];
const HEDGES = ["perhaps", "maybe", "possibly", "probably", "likely", "somewhat", "rather", "fairly", "quite", "arguably", "generally", "typically", "often", "sometimes", "may", "might", "could", "seems", "seem", "appears", "appear", "tend", "tends", "suggests", "suggest"];
const INTENSIFIERS = ["very", "really", "extremely", "highly", "incredibly", "absolutely", "truly", "deeply", "strongly", "significantly", "remarkably", "particularly", "especially", "definitely", "certainly", "clearly", "obviously"];
const FIRST_PERSON = ["i", "me", "my", "mine", "we", "us", "our", "ours", "i'm", "i've", "i'd", "i'll", "we're", "we've", "we'd", "we'll"];
const SECOND_PERSON = ["you", "your", "yours", "you're", "you've", "you'd", "you'll"];
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "there", "here", "he", "she", "they", "them", "his", "her", "their", "we", "our", "you", "your", "i", "my", "me", "us", "not", "no", "so", "if", "then", "than", "too", "very", "can", "will", "would", "could", "should", "has", "have", "had", "do", "does", "did", "into", "about", "over", "up", "out", "also", "just", "more", "most", "some", "any", "all", "each", "which", "who", "what", "when", "where", "how", "why", "s", "t"]);
const CONTRACTION_RE = /\b\w+['’](?:t|s|re|ve|ll|d|m)\b/gi;
const PASSIVE_RE = /\b(?:is|are|was|were|be|been|being|get|gets|got)\s+(?:\w+ly\s+)?\w+(?:ed|en|t)\b/gi;

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2; };
const bucketOf = (n: number) => LENGTH_BUCKETS.findIndex((b) => n <= b.max);
const per = (count: number, base: number, scale: number) => (base ? round((count / base) * scale) : 0);

function countWordsIn(words: string[], lexicon: string[]): number {
  const set = new Set(lexicon);
  return words.filter((w) => set.has(w.toLowerCase())).length;
}

function countPhrases(text: string, phrases: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const p of phrases) {
    const re = new RegExp(`(^|[^a-z])${p.replace(/ /g, "\\s+")}(?=[^a-z]|$)`, "g");
    n += (lower.match(re) ?? []).length;
  }
  return n;
}

/** Statistics of one side (all inputs, or all outputs) of the dataset */
export function sideStats(texts: string[]): SideStats {
  const sentences = texts.flatMap(splitSentences);
  const paragraphs = texts.flatMap(splitParagraphs);
  const all = texts.join("\n\n");
  const words = wordsOf(all);
  const lengths = sentences.map((s) => wordsOf(s).length);
  const hist = LENGTH_BUCKETS.map(() => 0);
  for (const n of lengths) hist[bucketOf(n)] += 1;
  let changes = 0;
  let adjacent = 0;
  for (const t of texts) {
    const ls = splitSentences(t).map((s) => wordsOf(s).length);
    for (let i = 1; i < ls.length; i++) { adjacent += 1; if (bucketOf(ls[i]) !== bucketOf(ls[i - 1])) changes += 1; }
  }
  const clauses = sentences.reduce((a, s) => a + countClauses(s), 0);
  const sentenceCount = Math.max(1, sentences.length);
  const count = (re: RegExp) => (all.match(re) ?? []).length;
  const tr = transitionMetrics(sentences);
  const forms = new Set(words.map((w) => w.toLowerCase()));
  const listLike = paragraphs.filter((p) => /^\s*(?:[-*•]|\d+[.)])\s/.test(p)).length;
  const headingLike = paragraphs.filter((p) => /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/.test(p) || (p.length < 60 && !/[.!?]$/.test(p) && paragraphs.length > 1 && /^[A-Z]/.test(p) && wordsOf(p).length <= 8)).length;
  return {
    words: words.length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    meanSentenceWords: round(mean(lengths), 1),
    stdSentenceWords: round(std(lengths), 1),
    medianSentenceWords: median(lengths),
    histogram: hist.map((h) => (sentences.length ? round(h / sentences.length) : 0)),
    shortShare: sentences.length ? round(lengths.filter((n) => n <= SHORT_SENTENCE).length / sentences.length) : 0,
    longShare: sentences.length ? round(lengths.filter((n) => n >= LONG_SENTENCE).length / sentences.length) : 0,
    alternation: adjacent ? round(changes / adjacent) : 0,
    sentencesPerParagraph: paragraphs.length ? round(sentences.length / paragraphs.length, 1) : 0,
    wordsPerClause: clauses ? round(words.length / clauses, 1) : 0,
    clausesPerSentence: round(clauses / sentenceCount, 1),
    commasPerSentence: round(count(/,/g) / sentenceCount),
    subordinators: round(countPhrases(all, SUBORDINATORS) / sentenceCount),
    coordinators: round(countPhrases(all, COORDINATORS) / sentenceCount),
    contractions: per(count(CONTRACTION_RE), words.length, 100),
    firstPerson: per(countWordsIn(words, FIRST_PERSON), words.length, 100),
    secondPerson: per(countWordsIn(words, SECOND_PERSON), words.length, 100),
    hedges: per(countWordsIn(words, HEDGES), words.length, 100),
    intensifiers: per(countWordsIn(words, INTENSIFIERS), words.length, 100),
    passive: round(count(PASSIVE_RE) / sentenceCount),
    questions: round(count(/\?/g) / sentenceCount),
    exclamations: round(count(/!/g) / sentenceCount),
    semicolons: per(count(/;/g), words.length, 100),
    colons: per(count(/:/g), words.length, 100),
    dashes: per(count(/—|–|\s-\s|--/g), words.length, 100),
    parentheses: per(count(/\(/g), words.length, 100),
    quotes: per(count(/["“”]/g), words.length, 100),
    meanWordLength: round(mean(words.map((w) => w.length)), 1),
    typeTokenRatio: words.length ? round(forms.size / words.length) : 0,
    transitionsPerSentence: tr.perSentence,
    transitionInitialShare: tr.count ? round(tr.initial / tr.count) : 0,
    bullets: paragraphs.length ? round(listLike / paragraphs.length) : 0,
    headings: paragraphs.length ? round(headingLike / paragraphs.length) : 0,
  };
}

// ── Vocabulary ──────────────────────────────────────────────────────────

function frequencies(texts: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of texts) for (const w of wordsOf(t)) { const k = w.toLowerCase(); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

/** Words the outputs use noticeably more (preferred) or less (avoided) than the inputs, per 1,000 words */
export function vocabularyShift(samples: Sample[], limit = 25): { preferred: WordShift[]; avoided: WordShift[] } {
  const inF = frequencies(samples.map((s) => s.input));
  const outF = frequencies(samples.map((s) => s.output));
  const inN = Math.max(1, Array.from(inF.values()).reduce((a, b) => a + b, 0));
  const outN = Math.max(1, Array.from(outF.values()).reduce((a, b) => a + b, 0));
  const shifts: (WordShift & { score: number })[] = [];
  const keys = new Set([...Array.from(inF.keys()), ...Array.from(outF.keys())]);
  keys.forEach((w) => {
    if (STOPWORDS.has(w) || w.length < 3 || /^\d/.test(w)) return;
    const ic = inF.get(w) ?? 0;
    const oc = outF.get(w) ?? 0;
    const ip = (ic / inN) * 1000;
    const op = (oc / outN) * 1000;
    // Smoothed log ratio, so a word seen once does not dominate
    const score = Math.log((op + 0.5) / (ip + 0.5)) * Math.log(1 + Math.max(ic, oc));
    shifts.push({ word: w, outputPer1k: round(op, 1), inputPer1k: round(ip, 1), outputCount: oc, inputCount: ic, score });
  });
  const strip = (x: WordShift & { score: number }): WordShift => ({ word: x.word, outputPer1k: x.outputPer1k, inputPer1k: x.inputPer1k, outputCount: x.outputCount, inputCount: x.inputCount });
  const preferred = shifts.filter((s) => s.outputCount >= 2 && s.outputPer1k >= 2 * s.inputPer1k).sort((a, b) => b.score - a.score).slice(0, limit).map(strip);
  const avoided = shifts.filter((s) => s.inputCount >= 2 && s.inputPer1k >= 2 * s.outputPer1k).sort((a, b) => a.score - b.score).slice(0, limit).map(strip);
  return { preferred, avoided };
}

const MAX_DIFF_TOKENS_PER_SIDE = 900;
const CLEAN_RUN_RE = new RegExp("^\\p{L}[\\p{L}'’-]*(?: \\p{L}[\\p{L}'’-]*)*$", "u");
const MAX_DIFF_SAMPLES = 300;

/** Replacements mined from the word diffs: a deleted run directly followed by an inserted run of similar size */
export function mineSubstitutions(samples: Sample[], limit = 30): Substitution[] {
  const counts = new Map<string, number>();
  let used = 0;
  for (const s of samples) {
    if (used >= MAX_DIFF_SAMPLES) break;
    if (tokenizeForDiff(s.input).length > MAX_DIFF_TOKENS_PER_SIDE || tokenizeForDiff(s.output).length > MAX_DIFF_TOKENS_PER_SIDE) continue;
    used += 1;
    const ops = diffWords(s.input, s.output);
    for (let i = 0; i + 1 < ops.length; i++) {
      if (ops[i].type !== "delete" || ops[i + 1].type !== "insert") continue;
      const from = ops[i].text.trim();
      const to = ops[i + 1].text.trim();
      // Clean word runs only: a swap that drags punctuation along is a restructuring, not a vocabulary choice
      if (!CLEAN_RUN_RE.test(from) || !CLEAN_RUN_RE.test(to)) continue;
      const fw = wordsOf(from).length;
      const tw = wordsOf(to).length;
      if (!fw || !tw || fw > 3 || tw > 3) continue;
      if (from.toLowerCase() === to.toLowerCase()) continue;
      // Sentence-initial capitalisation is not a substitution
      if (ops[i - 1]?.text.trimEnd().match(/[.!?]$/) && fw === 1 && tw === 1 && from.toLowerCase().slice(1) === to.toLowerCase().slice(1)) continue;
      const key = `${from.toLowerCase()}\u0000${to.toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([k, count]) => { const [from, to] = k.split("\u0000"); return { from, to, count }; })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))
    .slice(0, limit);
}

/** The first word or two of each output sentence, most common first */
export function sentenceOpeners(texts: string[], limit = 12): Counted[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const t of texts) for (const s of splitSentences(t)) {
    const words = wordsOf(s);
    if (!words.length) continue;
    total += 1;
    const first = words[0].toLowerCase();
    // A function word alone says little; take two words then
    const key = STOPWORDS.has(first) && words[1] ? `${words[0]} ${words[1]}` : words[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .map(([text, count]) => ({ text, count, share: total ? round(count / total) : 0 }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, limit);
}

/** Two- and three-word phrases the outputs repeat and the inputs do not use */
export function signaturePhrases(samples: Sample[], limit = 15): Counted[] {
  const inputText = samples.map((s) => s.input.toLowerCase()).join("\n");
  const counts = new Map<string, number>();
  let sentences = 0;
  for (const s of samples) for (const sent of splitSentences(s.output)) {
    sentences += 1;
    const w = wordsOf(sent).map((x) => x.toLowerCase());
    const seen = new Set<string>();
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) {
      const gram = w.slice(i, i + n);
      if (gram.every((x) => STOPWORDS.has(x))) continue;
      const key = gram.join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([k, c]) => c >= 3 && !inputText.includes(k))
    .map(([text, count]) => ({ text, count, share: sentences ? round(count / sentences) : 0 }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, limit);
}

// ── The fingerprint ─────────────────────────────────────────────────────

export function extractFingerprint(samples: Sample[]): Fingerprint | null {
  const clean = samples.map((s) => ({ input: s.input.trim(), output: s.output.trim() })).filter((s) => s.input && s.output);
  if (!clean.length) return null;
  const input = sideStats(clean.map((s) => s.input));
  const output = sideStats(clean.map((s) => s.output));
  const tr = transitionMetrics(clean.flatMap((s) => splitSentences(s.output)));
  const outSentences = Math.max(1, output.sentences);

  // Preservation: how much of each input survives, and whether names and numbers do
  let retention = 0;
  let names = 0;
  let namesKept = 0;
  let numbers = 0;
  let numbersKept = 0;
  let measured = 0;
  for (const s of clean) {
    const outWords = new Set(wordsOf(s.output));
    for (const n of namesAndNumbers(s.input)) {
      if (/^\d/.test(n)) { numbers += 1; if (outWords.has(n)) numbersKept += 1; }
      else { names += 1; if (outWords.has(n)) namesKept += 1; }
    }
    if (measured < MAX_DIFF_SAMPLES && tokenizeForDiff(s.input).length <= MAX_DIFF_TOKENS_PER_SIDE && tokenizeForDiff(s.output).length <= MAX_DIFF_TOKENS_PER_SIDE) {
      const ops = diffWords(s.input, s.output);
      const kept = ops.filter((o) => o.type === "equal").reduce((a, o) => a + wordsOf(o.text).length, 0);
      const total = wordsOf(s.input).length;
      if (total) { retention += kept / total; measured += 1; }
    }
  }

  return {
    samples: clean.length,
    input,
    output,
    lengthRatio: input.words ? round(output.words / input.words) : 1,
    sentenceRatio: input.sentences ? round(output.sentences / input.sentences) : 1,
    paragraphRatio: input.paragraphs ? round(output.paragraphs / input.paragraphs) : 1,
    vocabulary: {
      ...vocabularyShift(clean),
      substitutions: mineSubstitutions(clean),
      openers: sentenceOpeners(clean.map((s) => s.output)),
      phrases: signaturePhrases(clean),
      transitions: tr.phrases.slice(0, 12).map((p) => ({ text: p.phrase, count: p.count, share: round(p.count / outSentences) })),
    },
    preservation: {
      retention: measured ? round(retention / measured) : 1,
      namesKept: names ? round(namesKept / names) : 1,
      numbersKept: numbers ? round(numbersKept / numbers) : 1,
    },
  };
}

// ── Rules ───────────────────────────────────────────────────────────────

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Explicit rules derived from the fingerprint, with the evidence behind each */
export function deriveRules(fp: Fingerprint): Rule[] {
  const rules: Rule[] = [];
  const conf = (n: number): Rule["confidence"] => (n >= 8 ? "high" : n >= 3 ? "medium" : "low");
  const base = conf(fp.samples);
  const i = fp.input;
  const o = fp.output;
  const add = (id: string, category: Rule["category"], text: string, evidence: string, confidence: Rule["confidence"] = base) => rules.push({ id, category, text, evidence, confidence });

  // Length
  if (fp.lengthRatio <= 0.85) add("length-shorter", "length", `Make the result about ${pct(fp.lengthRatio)} of the source's length. Cut words, not facts.`, `Outputs average ${pct(fp.lengthRatio)} of the input word count across ${fp.samples} samples.`);
  else if (fp.lengthRatio >= 1.15) add("length-longer", "length", `Make the result about ${fp.lengthRatio}× the source's length.`, `Outputs average ${fp.lengthRatio}× the input word count.`);
  else add("length-same", "length", "Keep the result about as long as the source.", `Outputs average ${fp.lengthRatio}× the input word count.`);

  // Pacing
  add("pacing-mean", "pacing", `Average ${o.meanSentenceWords} words per sentence (most sentences ${Math.max(1, Math.round(o.meanSentenceWords - o.stdSentenceWords))} to ${Math.round(o.meanSentenceWords + o.stdSentenceWords)} words).`, `Output sentences: mean ${o.meanSentenceWords}, median ${o.medianSentenceWords}, spread ±${o.stdSentenceWords}; inputs average ${i.meanSentenceWords}.`);
  if (fp.sentenceRatio >= 1.2 && o.meanSentenceWords < i.meanSentenceWords) add("pacing-split", "pacing", "Split long sentences into two or three shorter ones.", `Outputs have ${fp.sentenceRatio}× as many sentences as inputs; mean length drops from ${i.meanSentenceWords} to ${o.meanSentenceWords} words.`);
  if (fp.sentenceRatio <= 0.8 && o.meanSentenceWords > i.meanSentenceWords) add("pacing-merge", "pacing", "Merge short sentences into longer, flowing ones.", `Outputs have ${fp.sentenceRatio}× as many sentences as inputs; mean length rises from ${i.meanSentenceWords} to ${o.meanSentenceWords} words.`);
  if (o.shortShare >= 0.3) add("pacing-short", "pacing", `Use short, punchy sentences (${SHORT_SENTENCE} words or fewer) for about ${pct(o.shortShare)} of sentences.`, `${pct(o.shortShare)} of output sentences are ${SHORT_SENTENCE} words or fewer (inputs: ${pct(i.shortShare)}).`);
  if (o.longShare <= 0.05 && i.longShare > 0.1) add("pacing-no-long", "pacing", `Avoid sentences over ${LONG_SENTENCE} words.`, `${pct(o.longShare)} of output sentences are ${LONG_SENTENCE}+ words, against ${pct(i.longShare)} of input sentences.`);
  else if (o.longShare >= 0.25) add("pacing-long", "pacing", `Use long sentences (${LONG_SENTENCE}+ words) for about ${pct(o.longShare)} of sentences.`, `${pct(o.longShare)} of output sentences are ${LONG_SENTENCE}+ words.`);
  if (o.alternation >= 0.55 && o.sentences >= 10) add("pacing-rhythm", "pacing", "Alternate sentence lengths: follow a long sentence with a short one.", `${pct(o.alternation)} of adjacent output sentences change length class.`);
  else if (o.alternation <= 0.3 && o.sentences >= 10) add("pacing-even", "pacing", "Keep sentence lengths even; do not alternate long and short.", `Only ${pct(o.alternation)} of adjacent output sentences change length class.`);
  if (o.sentencesPerParagraph && Math.abs(o.sentencesPerParagraph - i.sentencesPerParagraph) >= 1.5) add("pacing-paragraphs", "structure", `Use paragraphs of about ${Math.round(o.sentencesPerParagraph)} sentences.`, `Outputs average ${o.sentencesPerParagraph} sentences per paragraph; inputs ${i.sentencesPerParagraph}.`);

  // Clauses
  add("clauses-density", "clauses", `Keep about ${o.wordsPerClause} words per clause and ${o.clausesPerSentence} clauses per sentence.`, `Outputs: ${o.wordsPerClause} words/clause, ${o.clausesPerSentence} clauses/sentence; inputs: ${i.wordsPerClause} and ${i.clausesPerSentence}.`);
  if (o.subordinators <= i.subordinators * 0.6 && i.subordinators >= 0.3) add("clauses-flat", "clauses", "Prefer simple and coordinated sentences over subordinate clauses (because, although, which).", `Subordinators per sentence fall from ${i.subordinators} to ${o.subordinators}.`);
  if (o.subordinators >= i.subordinators * 1.5 && o.subordinators >= 0.3) add("clauses-subordinate", "clauses", "Link ideas with subordinate clauses (because, although, which) rather than separate sentences.", `Subordinators per sentence rise from ${i.subordinators} to ${o.subordinators}.`);
  if (o.commasPerSentence <= i.commasPerSentence * 0.6 && i.commasPerSentence >= 0.5) add("clauses-commas-fewer", "punctuation", `Use few commas: about ${o.commasPerSentence} per sentence.`, `Commas per sentence fall from ${i.commasPerSentence} to ${o.commasPerSentence}.`);
  else if (o.commasPerSentence >= i.commasPerSentence * 1.5 && o.commasPerSentence >= 0.8) add("clauses-commas-more", "punctuation", `Use commas freely: about ${o.commasPerSentence} per sentence.`, `Commas per sentence rise from ${i.commasPerSentence} to ${o.commasPerSentence}.`);

  // Vocabulary
  for (const s of fp.vocabulary.substitutions.filter((x) => x.count >= 2).slice(0, 20)) add(`sub-${s.from}`, "vocabulary", `Replace "${s.from}" with "${s.to}".`, `Seen ${s.count} times in the samples.`, s.count >= 3 ? "high" : "medium");
  const preferred = fp.vocabulary.preferred.slice(0, 15).map((w) => w.word);
  if (preferred.length) add("vocab-preferred", "vocabulary", `Favour these words: ${preferred.join(", ")}.`, `Each appears at least twice as often per 1,000 words in outputs as in inputs.`);
  const avoided = fp.vocabulary.avoided.slice(0, 15).map((w) => w.word);
  if (avoided.length) add("vocab-avoided", "vocabulary", `Avoid these words: ${avoided.join(", ")}.`, `Each appears at least twice as often per 1,000 words in inputs as in outputs.`);
  const phrases = fp.vocabulary.phrases.slice(0, 8).map((p) => `"${p.text}"`);
  if (phrases.length) add("vocab-phrases", "vocabulary", `Phrases typical of the style: ${phrases.join(", ")}.`, `Each occurs in at least three output sentences and never in the inputs.`);
  const openers = fp.vocabulary.openers.filter((op) => op.share >= 0.05).slice(0, 6);
  if (openers.length) add("vocab-openers", "vocabulary", `Common sentence openers: ${openers.map((op) => `"${op.text}" (${pct(op.share)})`).join(", ")}.`, `Shares of output sentences starting this way.`);
  if (o.meanWordLength <= i.meanWordLength - 0.4) add("vocab-short-words", "vocabulary", "Prefer short, plain words.", `Mean word length falls from ${i.meanWordLength} to ${o.meanWordLength} letters.`);
  else if (o.meanWordLength >= i.meanWordLength + 0.4) add("vocab-long-words", "vocabulary", "Prefer precise, longer words.", `Mean word length rises from ${i.meanWordLength} to ${o.meanWordLength} letters.`);

  // Voice
  if (o.contractions >= 1.5 && o.contractions >= i.contractions * 1.5) add("voice-contractions", "voice", "Use contractions (it's, don't, we're).", `${o.contractions} contractions per 100 words in outputs, ${i.contractions} in inputs.`);
  else if (o.contractions <= 0.2 && i.contractions >= 0.8) add("voice-no-contractions", "voice", "Do not use contractions.", `${o.contractions} contractions per 100 words in outputs, ${i.contractions} in inputs.`);
  if (o.firstPerson >= 1 && o.firstPerson >= i.firstPerson * 1.5) add("voice-first", "voice", "Write in the first person (I, we).", `First-person words per 100: ${o.firstPerson} in outputs, ${i.firstPerson} in inputs.`);
  else if (o.firstPerson <= 0.2 && i.firstPerson >= 1) add("voice-no-first", "voice", "Do not write in the first person.", `First-person words per 100: ${o.firstPerson} in outputs, ${i.firstPerson} in inputs.`);
  if (o.secondPerson >= 1 && o.secondPerson >= i.secondPerson * 1.5) add("voice-second", "voice", "Address the reader directly (you, your).", `Second-person words per 100: ${o.secondPerson} in outputs, ${i.secondPerson} in inputs.`);
  else if (o.secondPerson <= 0.2 && i.secondPerson >= 1) add("voice-no-second", "voice", "Do not address the reader as \"you\".", `Second-person words per 100: ${o.secondPerson} in outputs, ${i.secondPerson} in inputs.`);
  if (o.passive <= i.passive * 0.5 && i.passive >= 0.2) add("voice-active", "voice", "Use the active voice.", `Passive constructions per sentence fall from ${i.passive} to ${o.passive}.`);
  else if (o.passive >= i.passive * 1.8 && o.passive >= 0.2) add("voice-passive", "voice", "Use the passive voice where the inputs use the active.", `Passive constructions per sentence rise from ${i.passive} to ${o.passive}.`);
  if (o.hedges <= i.hedges * 0.5 && i.hedges >= 0.8) add("voice-direct", "voice", "Drop hedges (perhaps, somewhat, may, seems). State things directly.", `Hedges per 100 words fall from ${i.hedges} to ${o.hedges}.`);
  else if (o.hedges >= i.hedges * 1.8 && o.hedges >= 0.8) add("voice-hedged", "voice", "Hedge claims (perhaps, likely, may, seems).", `Hedges per 100 words rise from ${i.hedges} to ${o.hedges}.`);
  if (o.intensifiers <= i.intensifiers * 0.5 && i.intensifiers >= 0.5) add("voice-no-intensifiers", "voice", "Drop intensifiers (very, really, extremely).", `Intensifiers per 100 words fall from ${i.intensifiers} to ${o.intensifiers}.`);
  if (o.questions >= 0.1 && o.questions >= i.questions * 2) add("voice-questions", "voice", `Ask the occasional question (about ${pct(o.questions)} of sentences).`, `${pct(o.questions)} of output sentences are questions, ${pct(i.questions)} of input sentences.`);
  if (o.exclamations >= 0.05 && o.exclamations >= i.exclamations * 2) add("voice-exclaim", "voice", "Use the occasional exclamation.", `${pct(o.exclamations)} of output sentences end in an exclamation mark.`);
  else if (o.exclamations === 0 && i.exclamations >= 0.05) add("voice-no-exclaim", "voice", "No exclamation marks.", `Inputs have them in ${pct(i.exclamations)} of sentences; outputs never.`);

  // Transitions
  if (o.transitionsPerSentence <= i.transitionsPerSentence * 0.5 && i.transitionsPerSentence >= 0.15) add("trans-fewer", "vocabulary", "Drop transitional phrases (however, moreover, in addition). Let sentences stand on their own.", `Transitions per sentence fall from ${i.transitionsPerSentence} to ${o.transitionsPerSentence}.`);
  else if (o.transitionsPerSentence >= 0.15 && o.transitionsPerSentence >= i.transitionsPerSentence * 1.5) {
    const list = fp.vocabulary.transitions.slice(0, 6).map((t) => t.text).join(", ");
    add("trans-more", "vocabulary", `Connect sentences with transitions in about ${pct(o.transitionsPerSentence)} of sentences${o.transitionInitialShare >= 0.6 ? ", usually at the start of the sentence" : ""}${list ? ` (${list})` : ""}.`, `Transitions per sentence rise from ${i.transitionsPerSentence} to ${o.transitionsPerSentence}.`);
  }

  // Punctuation
  if (o.semicolons === 0 && i.semicolons >= 0.2) add("punct-no-semicolons", "punctuation", "No semicolons.", `Inputs use ${i.semicolons} per 100 words; outputs none.`);
  else if (o.semicolons >= 0.3 && o.semicolons >= i.semicolons * 2) add("punct-semicolons", "punctuation", "Use semicolons to join related clauses.", `${o.semicolons} per 100 words in outputs, ${i.semicolons} in inputs.`);
  if (o.dashes === 0 && i.dashes >= 0.2) add("punct-no-dashes", "punctuation", "No dashes.", `Inputs use ${i.dashes} per 100 words; outputs none.`);
  else if (o.dashes >= 0.3 && o.dashes >= i.dashes * 2) add("punct-dashes", "punctuation", "Use dashes for asides and emphasis.", `${o.dashes} per 100 words in outputs, ${i.dashes} in inputs.`);
  if (o.parentheses === 0 && i.parentheses >= 0.2) add("punct-no-parens", "punctuation", "No parentheses. Fold asides into the sentence or drop them.", `Inputs use ${i.parentheses} per 100 words; outputs none.`);
  if (o.colons >= 0.3 && o.colons >= i.colons * 2) add("punct-colons", "punctuation", "Introduce points with a colon.", `${o.colons} per 100 words in outputs, ${i.colons} in inputs.`);

  // Structure
  if (o.bullets >= 0.2 && o.bullets >= i.bullets * 2) add("struct-bullets", "structure", `Use bullet or numbered lists (about ${pct(o.bullets)} of paragraphs).`, `${pct(o.bullets)} of output paragraphs are list items, ${pct(i.bullets)} of input paragraphs.`);
  else if (o.bullets === 0 && i.bullets >= 0.1) add("struct-no-bullets", "structure", "No lists. Write in prose.", `Inputs have list items in ${pct(i.bullets)} of paragraphs; outputs none.`);
  if (o.headings >= 0.1 && o.headings >= i.headings * 2) add("struct-headings", "structure", "Use short headings to break the text into sections.", `${pct(o.headings)} of output paragraphs are headings.`);
  if (fp.paragraphRatio >= 1.4) add("struct-more-paragraphs", "structure", "Break the text into more paragraphs.", `Outputs have ${fp.paragraphRatio}× the paragraphs of inputs.`);
  else if (fp.paragraphRatio <= 0.7) add("struct-fewer-paragraphs", "structure", "Merge paragraphs; use fewer breaks.", `Outputs have ${fp.paragraphRatio}× the paragraphs of inputs.`);

  // Preservation: always, and backed by the data where it holds
  const kept = fp.preservation;
  add("preserve-facts", "preservation", "Keep every fact, name, number, date, quotation and citation from the source. Do not add information.", `Samples keep ${pct(kept.namesKept)} of names and ${pct(kept.numbersKept)} of numbers; ${pct(kept.retention)} of source words survive verbatim.`, "high");
  if (kept.retention >= 0.7) add("preserve-wording", "preservation", "Change only what the style requires; most of the source wording stays.", `${pct(kept.retention)} of source words survive verbatim.`);
  else if (kept.retention <= 0.35) add("preserve-rewrite", "preservation", "Rewrite freely in your own words while keeping the meaning; do not copy the source phrasing.", `Only ${pct(kept.retention)} of source words survive verbatim.`);

  return rules;
}

// ── Scoring an output against the fingerprint ───────────────────────────

export interface Deviation { metric: string; target: string; actual: string; hint: string; severity: number }

export interface MatchReport {
  /** 0..1: how closely the text matches the target style */
  score: number;
  deviations: Deviation[];
}

/**
 * Compare a candidate output (for a given input) with the fingerprint's
 * targets. Each metric contributes a penalty scaled by its spread in the
 * samples; the deviations double as revision instructions for the model.
 */
export function matchFingerprint(fp: Fingerprint, input: string, output: string): MatchReport {
  const o = fp.output;
  const got = sideStats([output]);
  const inWords = wordsOf(input).length;
  const devs: Deviation[] = [];
  let penalty = 0;
  let weight = 0;
  const check = (metric: string, actual: number, target: number, tolerance: number, w: number, hint: (a: number, t: number) => string, fmt = (n: number) => String(n)) => {
    const d = Math.abs(actual - target) / Math.max(tolerance, 1e-6);
    const severity = Math.min(1, Math.max(0, (d - 1) / 2)); // free within one tolerance, full penalty at three
    penalty += severity * w;
    weight += w;
    if (severity > 0) devs.push({ metric, target: fmt(target), actual: fmt(actual), hint: hint(actual, target), severity });
  };
  const fmtPct = (n: number) => pct(n);
  if (inWords) {
    const ratio = got.words / inWords;
    check("Length (output ÷ source words)", round(ratio), fp.lengthRatio, 0.12, 3, (a, t) => (a > t ? `Cut the length to about ${pct(t)} of the source.` : `Expand to about ${pct(t)} of the source.`), (n) => `${n}×`);
  }
  if (got.sentences >= 1) {
    check("Mean words per sentence", got.meanSentenceWords, o.meanSentenceWords, Math.max(2, o.stdSentenceWords * 0.5), 3, (a, t) => (a > t ? `Shorten sentences to average ${t} words.` : `Lengthen sentences to average ${t} words.`));
    check("Short sentences (≤12 words)", got.shortShare, o.shortShare, 0.15, 2, (a, t) => (a < t ? `Use more short sentences: about ${pct(t)}.` : `Use fewer short sentences: about ${pct(t)}.`), fmtPct);
    check("Long sentences (25+ words)", got.longShare, o.longShare, 0.12, 2, (a, t) => (a > t ? `Avoid long sentences; about ${pct(t)} should be 25+ words.` : `Allow some long sentences: about ${pct(t)}.`), fmtPct);
    check("Words per clause", got.wordsPerClause, o.wordsPerClause, 1.5, 2, (a, t) => (a > t ? `Shorten clauses to about ${t} words.` : `Lengthen clauses to about ${t} words.`));
    check("Commas per sentence", got.commasPerSentence, o.commasPerSentence, 0.4, 1, (a, t) => (a > t ? `Use fewer commas: about ${t} per sentence.` : `Use more commas: about ${t} per sentence.`));
    check("Transitions per sentence", got.transitionsPerSentence, o.transitionsPerSentence, 0.15, 1, (a, t) => (a > t ? `Use fewer transitional phrases (about ${t} per sentence).` : `Use more transitional phrases (about ${t} per sentence).`));
  }
  check("Contractions per 100 words", got.contractions, o.contractions, 1, 1, (a, t) => (a > t ? "Use fewer contractions." : "Use contractions."));
  check("First person per 100 words", got.firstPerson, o.firstPerson, 1.5, 1, (a, t) => (a > t ? "Use the first person less." : "Write in the first person more."));
  check("Passive per sentence", got.passive, o.passive, 0.2, 1, (a, t) => (a > t ? "Use the active voice." : "Use the passive voice more."));
  check("Semicolons per 100 words", got.semicolons, o.semicolons, 0.3, 0.5, (a, t) => (a > t ? "Drop the semicolons." : "Use semicolons."));
  check("Dashes per 100 words", got.dashes, o.dashes, 0.3, 0.5, (a, t) => (a > t ? "Drop the dashes." : "Use dashes."));
  const score = weight ? round(1 - penalty / weight) : 1;
  return { score, deviations: devs.sort((a, b) => b.severity - a.severity) };
}

// ── Exemplars for a new text ────────────────────────────────────────────

/** Pick the samples closest to the text in length and vocabulary, shortest ties first */
export function selectExemplars<T extends Sample>(samples: T[], text: string, k = 4, maxChars = 1600): T[] {
  const usable = samples.filter((s) => s.input.trim() && s.output.trim());
  if (!usable.length) return [];
  const df = new Map<string, number>();
  const bags = usable.map((s) => { const b = new Set(wordsOf(s.input).map((w) => w.toLowerCase()).filter((w) => !STOPWORDS.has(w))); b.forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)); return b; });
  const query = new Set(wordsOf(text).map((w) => w.toLowerCase()).filter((w) => !STOPWORDS.has(w)));
  const n = usable.length;
  const idf = (w: string) => Math.log((n + 1) / ((df.get(w) ?? 0) + 1)) + 1;
  const qNorm = Math.sqrt(Array.from(query).reduce((a, w) => a + idf(w) ** 2, 0)) || 1;
  const words = wordsOf(text).length || 1;
  const scored = usable.map((s, idx) => {
    const bag = bags[idx];
    let dot = 0;
    query.forEach((w) => { if (bag.has(w)) dot += idf(w) ** 2; });
    const bNorm = Math.sqrt(Array.from(bag).reduce((a, w) => a + idf(w) ** 2, 0)) || 1;
    const cosine = dot / (qNorm * bNorm);
    const len = wordsOf(s.input).length || 1;
    const lengthSim = 1 - Math.min(1, Math.abs(Math.log(len / words)) / Math.log(8));
    const size = s.input.length + s.output.length;
    const sizePenalty = size > maxChars ? Math.min(1, (size - maxChars) / maxChars) * 0.5 : 0;
    return { s, score: 0.6 * cosine + 0.4 * lengthSim - sizePenalty, size };
  });
  return scored.sort((a, b) => b.score - a.score || a.size - b.size).slice(0, k).map((x) => x.s);
}

/** The fingerprint as plain text, for export and for a quick read */
export function renderFingerprint(fp: Fingerprint, rules = deriveRules(fp)): string {
  const i = fp.input;
  const o = fp.output;
  const row = (label: string, a: number | string, b: number | string) => `${label.padEnd(34)} ${String(a).padStart(9)} ${String(b).padStart(9)}`;
  const lines = [
    `Samples: ${fp.samples}. Length ratio ${fp.lengthRatio}×, sentence ratio ${fp.sentenceRatio}×, paragraph ratio ${fp.paragraphRatio}×.`,
    "",
    row("Metric", "inputs", "outputs"),
    row("Mean words per sentence", i.meanSentenceWords, o.meanSentenceWords),
    row("Spread (std) of sentence length", i.stdSentenceWords, o.stdSentenceWords),
    ...LENGTH_BUCKETS.map((b, k) => row(`Sentences ${b.label}`, pct(i.histogram[k]), pct(o.histogram[k]))),
    row("Rhythm (length class changes)", pct(i.alternation), pct(o.alternation)),
    row("Sentences per paragraph", i.sentencesPerParagraph, o.sentencesPerParagraph),
    row("Words per clause", i.wordsPerClause, o.wordsPerClause),
    row("Clauses per sentence", i.clausesPerSentence, o.clausesPerSentence),
    row("Commas per sentence", i.commasPerSentence, o.commasPerSentence),
    row("Subordinators per sentence", i.subordinators, o.subordinators),
    row("Coordinators per sentence", i.coordinators, o.coordinators),
    row("Transitions per sentence", i.transitionsPerSentence, o.transitionsPerSentence),
    row("Contractions per 100 words", i.contractions, o.contractions),
    row("First person per 100 words", i.firstPerson, o.firstPerson),
    row("Second person per 100 words", i.secondPerson, o.secondPerson),
    row("Hedges per 100 words", i.hedges, o.hedges),
    row("Intensifiers per 100 words", i.intensifiers, o.intensifiers),
    row("Passive per sentence", i.passive, o.passive),
    row("Questions per sentence", i.questions, o.questions),
    row("Semicolons per 100 words", i.semicolons, o.semicolons),
    row("Colons per 100 words", i.colons, o.colons),
    row("Dashes per 100 words", i.dashes, o.dashes),
    row("Parentheses per 100 words", i.parentheses, o.parentheses),
    row("Mean word length", i.meanWordLength, o.meanWordLength),
    row("Type/token ratio", i.typeTokenRatio, o.typeTokenRatio),
    row("List paragraphs", pct(i.bullets), pct(o.bullets)),
    "",
    `Preferred words: ${fp.vocabulary.preferred.slice(0, 20).map((w) => w.word).join(", ") || "none found"}`,
    `Avoided words: ${fp.vocabulary.avoided.slice(0, 20).map((w) => w.word).join(", ") || "none found"}`,
    `Substitutions: ${fp.vocabulary.substitutions.slice(0, 20).map((s) => `${s.from} → ${s.to} (${s.count})`).join("; ") || "none found"}`,
    `Signature phrases: ${fp.vocabulary.phrases.slice(0, 10).map((p) => p.text).join(", ") || "none found"}`,
    `Sentence openers: ${fp.vocabulary.openers.slice(0, 8).map((p) => `${p.text} (${pct(p.share)})`).join(", ") || "none found"}`,
    `Preservation: ${pct(fp.preservation.retention)} of source words kept verbatim; names kept ${pct(fp.preservation.namesKept)}, numbers kept ${pct(fp.preservation.numbersKept)}.`,
    "",
    "Rules:",
    ...rules.map((r, k) => `${k + 1}. ${r.text} [${r.confidence}: ${r.evidence}]`),
  ];
  return lines.join("\n");
}

export { textMetrics };
