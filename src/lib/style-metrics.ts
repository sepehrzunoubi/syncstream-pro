/**
 * Deterministic linguistic measurements for the Style engine.
 *
 * Everything here is computed locally, without a model: sentence and clause
 * statistics, pacing, transition phrases, punctuation habits, and a
 * token-level diff between a source text and its adapted counterpart. The
 * numbers are shown in the workspace and handed to the model as ground truth
 * so the Transformation Profile is built on measured values, not guesses.
 */

export interface TextMetrics {
  chars: number;
  words: number;
  sentences: number;
  paragraphs: number;
  /** Mean words per sentence */
  meanSentenceWords: number;
  /** Standard deviation of characters per sentence */
  sentenceCharsStd: number;
  /** Sentences of at most SHORT_SENTENCE words */
  shortSentences: number;
  /** Sentences of at least LONG_SENTENCE words */
  longSentences: number;
  /** Short sentences per long sentence (short / max(long, 1)) */
  pacingRatio: number;
  /** Lexical density: words per clause */
  wordsPerClause: number;
  /** Distinct words / words, over lower-cased word forms */
  typeTokenRatio: number;
  meanWordLength: number;
  transitions: TransitionMetrics;
  punctuation: PunctuationMetrics;
}

export interface TransitionMetrics {
  count: number;
  perSentence: number;
  /** Transitions that open a sentence */
  initial: number;
  /** Transitions inside a sentence */
  medial: number;
  /** Phrases used, most frequent first */
  phrases: { phrase: string; count: number }[];
}

export interface PunctuationMetrics {
  commas: number;
  semicolons: number;
  colons: number;
  dashes: number;
  parentheses: number;
  questions: number;
  exclamations: number;
  /** Commas per sentence */
  commasPerSentence: number;
}

export const SHORT_SENTENCE = 12;
export const LONG_SENTENCE = 25;

/** Common transitional phrases, longest first so "on the other hand" wins over "other" */
export const TRANSITION_PHRASES = [
  "on the other hand", "as a matter of fact", "in other words", "for this reason", "in the same way",
  "at the same time", "as a result", "in addition", "for example", "for instance", "in contrast",
  "in conclusion", "in particular", "in summary", "in short", "in fact", "that said", "to this end",
  "above all", "after all", "even so", "by contrast", "by comparison",
  "however", "moreover", "furthermore", "therefore", "thus", "hence", "consequently", "additionally",
  "meanwhile", "nevertheless", "nonetheless", "indeed", "similarly", "likewise", "conversely",
  "ultimately", "finally", "firstly", "secondly", "lastly", "overall", "notably", "importantly",
  "specifically", "instead", "otherwise", "accordingly", "subsequently", "alternatively", "besides",
  "still", "yet", "then", "also",
];

const CLAUSE_CONJUNCTIONS = /\b(and|but|or|nor|so|yet|because|although|though|while|whereas|which|that|when|where|if|unless|until|since|after|before|as)\b/gi;

/** Unicode-aware character classes. Built from strings: the project's tsconfig rejects the `u` flag in regex literals. */
const ALNUM = "[\\p{L}\\p{N}]";
const WORD = `${ALNUM}+(?:['’\\-]${ALNUM}+)*`;
const WORD_RE = new RegExp(WORD, "gu");
const HAS_ALNUM_RE = new RegExp(ALNUM, "u");
const DIFF_TOKEN_RE = new RegExp(`${WORD}\\s*|[^\\s\\p{L}\\p{N}]+\\s*|\\s+`, "gu");
const CAPITALIZED_RE = new RegExp("^\\p{Lu}", "u");

export function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n|\r?\n/).map((p) => p.trim()).filter(Boolean);
}

/** Abbreviations whose full stop does not end a sentence */
const ABBREVIATIONS = /\b(e\.g|i\.e|cf|etc|vs|Dr|Mr|Mrs|Ms|Prof|St|No|Fig|approx)\./gi;
const DOT_MARK = "\u0001";

/** Sentences, as a reader would count them: ends at . ! ? (plus closing quotes) or at a line break */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of splitParagraphs(text)) {
    const guarded = para.replace(ABBREVIATIONS, (m) => m.replace(/\./g, DOT_MARK));
    const parts = guarded.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g) ?? [];
    for (const raw of parts) {
      const s = raw.replace(new RegExp(DOT_MARK, "g"), ".").trim();
      if (s && HAS_ALNUM_RE.test(s)) out.push(s);
    }
  }
  return out;
}

export function wordsOf(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/** Clauses: separated by commas, semicolons, colons, dashes, or a conjunction */
export function countClauses(sentence: string): number {
  const byPunct = sentence.split(/[,;:—–]|\s-\s|\(|\)/).filter((c) => wordsOf(c).length > 0);
  let clauses = byPunct.length;
  for (const piece of byPunct) {
    const conj = piece.match(CLAUSE_CONJUNCTIONS) ?? [];
    // A conjunction only opens a clause when something follows it
    for (const c of conj) {
      const idx = piece.toLowerCase().indexOf(c.toLowerCase());
      if (wordsOf(piece.slice(0, idx)).length >= 2 && wordsOf(piece.slice(idx + c.length)).length >= 2) clauses += 1;
    }
  }
  return Math.max(1, clauses);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export function transitionMetrics(sentences: string[]): TransitionMetrics {
  const counts = new Map<string, number>();
  let initial = 0;
  let medial = 0;
  for (const s of sentences) {
    let rest = s;
    for (const phrase of TRANSITION_PHRASES) {
      const re = new RegExp(`(^|[^\\p{L}])${phrase.replace(/ /g, "\\s+")}(?=[^\\p{L}]|$)`, "giu");
      let m: RegExpExecArray | null;
      while ((m = re.exec(rest))) {
        const at = m.index + m[1].length;
        // "still"/"yet"/"then"/"also" as transitions are usually followed by a comma or open the sentence
        const short = phrase.length <= 5;
        const opens = at === 0 || /^["'“‘(]*$/.test(s.slice(0, at).trim());
        const followedByComma = /^\s*,/.test(rest.slice(at + m[0].length - m[1].length));
        if (short && !opens && !followedByComma) continue;
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
        if (opens) initial += 1; else medial += 1;
        // Blank the match so a shorter phrase inside it is not counted again
        rest = rest.slice(0, at) + " ".repeat(m[0].length - m[1].length) + rest.slice(at + m[0].length - m[1].length);
      }
    }
  }
  const count = initial + medial;
  return {
    count,
    perSentence: sentences.length ? round(count / sentences.length) : 0,
    initial,
    medial,
    phrases: Array.from(counts.entries()).map(([phrase, c]) => ({ phrase, count: c })).sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase)),
  };
}

export function textMetrics(text: string): TextMetrics {
  const sentences = splitSentences(text);
  const words = wordsOf(text);
  const perSentenceWords = sentences.map((s) => wordsOf(s).length);
  const perSentenceChars = sentences.map((s) => s.length);
  const clauses = sentences.reduce((a, s) => a + countClauses(s), 0);
  const short = perSentenceWords.filter((n) => n <= SHORT_SENTENCE).length;
  const long = perSentenceWords.filter((n) => n >= LONG_SENTENCE).length;
  const forms = new Set(words.map((w) => w.toLowerCase()));
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const commas = count(/,/g);
  return {
    chars: text.length,
    words: words.length,
    sentences: sentences.length,
    paragraphs: splitParagraphs(text).length,
    meanSentenceWords: round(mean(perSentenceWords), 1),
    sentenceCharsStd: round(std(perSentenceChars), 1),
    shortSentences: short,
    longSentences: long,
    pacingRatio: round(short / Math.max(1, long)),
    wordsPerClause: clauses ? round(words.length / clauses, 1) : 0,
    typeTokenRatio: words.length ? round(forms.size / words.length) : 0,
    meanWordLength: words.length ? round(mean(words.map((w) => w.length)), 1) : 0,
    transitions: transitionMetrics(sentences),
    punctuation: {
      commas,
      semicolons: count(/;/g),
      colons: count(/:/g),
      dashes: count(/—|–|\s-\s|--/g),
      parentheses: count(/\(/g),
      questions: count(/\?/g),
      exclamations: count(/!/g),
      commasPerSentence: sentences.length ? round(commas / sentences.length) : 0,
    },
  };
}

// ── Token diff ───────────────────────────────────────────────────────────

export type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

/** Words and punctuation as separate tokens; whitespace is attached to the token before it */
export function tokenizeForDiff(text: string): string[] {
  return text.match(DIFF_TOKEN_RE) ?? [];
}

const MAX_DIFF_TOKENS = 2500;

/**
 * Longest-common-subsequence diff over word tokens (case-sensitive).
 * Adjacent same-type ops are merged. Very long texts are compared on their
 * first MAX_DIFF_TOKENS tokens; the rest is reported as replaced.
 */
export function diffWords(a: string, b: string): DiffOp[] {
  const ta = tokenizeForDiff(a);
  const tb = tokenizeForDiff(b);
  const n = Math.min(ta.length, MAX_DIFF_TOKENS);
  const m = Math.min(tb.length, MAX_DIFF_TOKENS);
  const key = (t: string) => t.trimEnd();
  // dp[i][j] = LCS length of ta[i..] and tb[j..]
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = key(ta[i]) === key(tb[j]) ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  const push = (type: DiffOp["type"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(ta[i]) === key(tb[j])) { push("equal", tb[j]); i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { push("delete", ta[i]); i++; }
    else { push("insert", tb[j]); j++; }
  }
  for (; i < ta.length; i++) push("delete", ta[i]);
  for (; j < tb.length; j++) push("insert", tb[j]);
  return ops;
}

export interface EditSummary {
  /** Tokens kept as they were */
  kept: number;
  inserted: number;
  deleted: number;
  /** Deleted runs immediately followed by an inserted run: substitutions */
  substitutions: number;
  /** Share of the source's tokens that survive unchanged (0..1) */
  retention: number;
  /** Capitalised words (not sentence-initial) and numbers from the source that the output keeps */
  preservedNames: string[];
  /** Capitalised words and numbers from the source that the output drops */
  droppedNames: string[];
}

const countTokens = (text: string) => tokenizeForDiff(text).filter((t) => HAS_ALNUM_RE.test(t)).length;

/** Proper-noun-like tokens and numbers: what a faithful rewrite must keep */
export function namesAndNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const s of splitSentences(text)) {
    const words = wordsOf(s);
    words.forEach((w, i) => {
      if (/^\d/.test(w) || (i > 0 && CAPITALIZED_RE.test(w) && !/^I$/.test(w))) out.add(w);
    });
  }
  return Array.from(out);
}

export function summarizeEdits(input: string, output: string, ops = diffWords(input, output)): EditSummary {
  let kept = 0;
  let inserted = 0;
  let deleted = 0;
  let substitutions = 0;
  ops.forEach((op, i) => {
    const n = countTokens(op.text);
    if (op.type === "equal") kept += n;
    else if (op.type === "insert") inserted += n;
    else {
      deleted += n;
      if (ops[i + 1]?.type === "insert") substitutions += 1;
    }
  });
  const sourceTokens = kept + deleted;
  const names = namesAndNumbers(input);
  const outWords = new Set(wordsOf(output));
  return {
    kept,
    inserted,
    deleted,
    substitutions,
    retention: sourceTokens ? round(kept / sourceTokens) : 1,
    preservedNames: names.filter((n) => outWords.has(n)),
    droppedNames: names.filter((n) => !outWords.has(n)),
  };
}

// ── Pairs and corpus ─────────────────────────────────────────────────────

export interface PairReport {
  input: TextMetrics;
  output: TextMetrics;
  edits: EditSummary;
}

export function pairReport(input: string, output: string): PairReport {
  return { input: textMetrics(input), output: textMetrics(output), edits: summarizeEdits(input, output) };
}

export interface CorpusReport {
  pairs: number;
  input: TextMetrics;
  output: TextMetrics;
  edits: { retention: number; substitutionsPerPair: number; insertedPerPair: number; deletedPerPair: number; droppedNames: string[] };
  /** Word-count ratio output / input */
  lengthRatio: number;
}

function averageMetrics(list: TextMetrics[]): TextMetrics {
  const avg = (f: (m: TextMetrics) => number, places = 2) => round(mean(list.map(f)), places);
  const phraseCounts = new Map<string, number>();
  for (const m of list) for (const p of m.transitions.phrases) phraseCounts.set(p.phrase, (phraseCounts.get(p.phrase) ?? 0) + p.count);
  return {
    chars: avg((m) => m.chars, 0),
    words: avg((m) => m.words, 0),
    sentences: avg((m) => m.sentences, 1),
    paragraphs: avg((m) => m.paragraphs, 1),
    meanSentenceWords: avg((m) => m.meanSentenceWords, 1),
    sentenceCharsStd: avg((m) => m.sentenceCharsStd, 1),
    shortSentences: avg((m) => m.shortSentences, 1),
    longSentences: avg((m) => m.longSentences, 1),
    pacingRatio: avg((m) => m.pacingRatio),
    wordsPerClause: avg((m) => m.wordsPerClause, 1),
    typeTokenRatio: avg((m) => m.typeTokenRatio),
    meanWordLength: avg((m) => m.meanWordLength, 1),
    transitions: {
      count: avg((m) => m.transitions.count, 1),
      perSentence: avg((m) => m.transitions.perSentence),
      initial: avg((m) => m.transitions.initial, 1),
      medial: avg((m) => m.transitions.medial, 1),
      phrases: Array.from(phraseCounts.entries()).map(([phrase, count]) => ({ phrase, count })).sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase)),
    },
    punctuation: {
      commas: avg((m) => m.punctuation.commas, 1),
      semicolons: avg((m) => m.punctuation.semicolons, 1),
      colons: avg((m) => m.punctuation.colons, 1),
      dashes: avg((m) => m.punctuation.dashes, 1),
      parentheses: avg((m) => m.punctuation.parentheses, 1),
      questions: avg((m) => m.punctuation.questions, 1),
      exclamations: avg((m) => m.punctuation.exclamations, 1),
      commasPerSentence: avg((m) => m.punctuation.commasPerSentence),
    },
  };
}

export function corpusReport(pairs: { input: string; output: string }[]): CorpusReport | null {
  const reports = pairs.filter((p) => p.input.trim() && p.output.trim()).map((p) => pairReport(p.input, p.output));
  if (!reports.length) return null;
  const inWords = reports.reduce((a, r) => a + r.input.words, 0);
  const outWords = reports.reduce((a, r) => a + r.output.words, 0);
  return {
    pairs: reports.length,
    input: averageMetrics(reports.map((r) => r.input)),
    output: averageMetrics(reports.map((r) => r.output)),
    edits: {
      retention: round(mean(reports.map((r) => r.edits.retention))),
      substitutionsPerPair: round(mean(reports.map((r) => r.edits.substitutions)), 1),
      insertedPerPair: round(mean(reports.map((r) => r.edits.inserted)), 1),
      deletedPerPair: round(mean(reports.map((r) => r.edits.deleted)), 1),
      droppedNames: Array.from(new Set(reports.flatMap((r) => r.edits.droppedNames))).slice(0, 40),
    },
    lengthRatio: inWords ? round(outWords / inWords) : 1,
  };
}

/** The report as plain text, for the model's prompt and for copying */
export function renderMetrics(report: CorpusReport): string {
  const row = (label: string, a: number | string, b: number | string) => `${label.padEnd(34)} ${String(a).padStart(8)} ${String(b).padStart(8)}`;
  const i = report.input;
  const o = report.output;
  const lines = [
    `Pairs measured: ${report.pairs}. Output/input length ratio (words): ${report.lengthRatio}.`,
    row("Metric (averages per text)", "source", "target"),
    row("Words", i.words, o.words),
    row("Sentences", i.sentences, o.sentences),
    row("Paragraphs", i.paragraphs, o.paragraphs),
    row("Mean words per sentence", i.meanSentenceWords, o.meanSentenceWords),
    row("Std dev of chars per sentence", i.sentenceCharsStd, o.sentenceCharsStd),
    row(`Short sentences (<= ${SHORT_SENTENCE} words)`, i.shortSentences, o.shortSentences),
    row(`Long sentences (>= ${LONG_SENTENCE} words)`, i.longSentences, o.longSentences),
    row("Pacing ratio (short / long)", i.pacingRatio, o.pacingRatio),
    row("Words per clause", i.wordsPerClause, o.wordsPerClause),
    row("Type/token ratio", i.typeTokenRatio, o.typeTokenRatio),
    row("Mean word length", i.meanWordLength, o.meanWordLength),
    row("Transitions per sentence", i.transitions.perSentence, o.transitions.perSentence),
    row("Transitions opening a sentence", i.transitions.initial, o.transitions.initial),
    row("Transitions mid-sentence", i.transitions.medial, o.transitions.medial),
    row("Commas per sentence", i.punctuation.commasPerSentence, o.punctuation.commasPerSentence),
    row("Semicolons", i.punctuation.semicolons, o.punctuation.semicolons),
    row("Colons", i.punctuation.colons, o.punctuation.colons),
    row("Dashes", i.punctuation.dashes, o.punctuation.dashes),
    row("Parentheses", i.punctuation.parentheses, o.punctuation.parentheses),
    row("Questions", i.punctuation.questions, o.punctuation.questions),
    row("Exclamations", i.punctuation.exclamations, o.punctuation.exclamations),
    "",
    `Token retention (source tokens kept verbatim): ${Math.round(report.edits.retention * 100)}%. Per pair: ${report.edits.substitutionsPerPair} substitutions, ${report.edits.insertedPerPair} tokens inserted, ${report.edits.deletedPerPair} deleted.`,
  ];
  const phrases = (m: TextMetrics) => m.transitions.phrases.slice(0, 12).map((p) => `${p.phrase} (${p.count})`).join(", ") || "none";
  lines.push(`Transition phrases in sources: ${phrases(i)}.`);
  lines.push(`Transition phrases in targets: ${phrases(o)}.`);
  if (report.edits.droppedNames.length) lines.push(`Names or numbers from a source that its target does not repeat: ${report.edits.droppedNames.join(", ")}.`);
  return lines.join("\n");
}
