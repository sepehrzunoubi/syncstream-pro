/**
 * Drip Engine v5 — Three modes: Human Pace, Burst Mode, Custom.
 *
 * Human Pace: Constant sync over a fixed duration.
 * Burst Mode: Mandatory pause checkpoints + natural micro-typed segments.
 *             Auto-calculates total duration from word count. Inserts text in
 *             tiny micro-chunks (1-3 words) with realistic 2-8s delays plus
 *             periodic thinking pauses, and a handful of multi-minute mandatory
 *             pauses spaced through the doc. Typo frequency is user-configurable.
 * Custom:     1 sentence per minute baseline; user picks up to 4 pause cubes
 *             from a fixed catalog (4m–3h). Pauses are inserted in cart order,
 *             evenly spaced between sentence segments.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type PaceMode = "human" | "burst" | "custom";

export interface PlanOptions {
  /** 0-1 scale. 0 = rare typos (~every 800 chars), 1 = frequent (~every 120 chars). Default 0.5 */
  typoFrequency?: number;
  /** 0-1 scale. Currently unused — burst mode auto-manages pauses. Kept for future use. Default 0.5 */
  pauseVariance?: number;
}

/** An individual action the stream executor performs */
export interface DripAction {
  /** "insert" = append text, "typo" = inject wrong chars then correct, "pause" = wait only, "heartbeat" = SSE keepalive */
  kind: "insert" | "typo" | "pause" | "heartbeat";
  /** Text to insert (for "insert" and "typo" correct text) */
  text: string;
  /** For "typo": the wrong characters to type first */
  typoChars?: string;
  /** Delay in ms BEFORE this action executes */
  delayMs: number;
  /** Human-readable activity label for the UI */
  activity: string;
  /** Burst mode: index into the mandatoryPauses array (only set on mandatory pause actions) */
  mandatoryPauseIndex?: number;
}

export interface DripPlan {
  actions: DripAction[];
  totalChars: number;
  totalMinutes: number;
  /** Burst mode: mandatory pause durations in minutes (in execution order, already shuffled) */
  mandatoryPauses?: number[];
}

export interface StreamEvent {
  type: "progress" | "done" | "error" | "heartbeat";
  actionIndex: number;
  totalActions: number;
  charsSent: number;
  totalChars: number;
  nextDelayMs: number;
  /** Absolute timestamp (ms) when the current delay ends */
  nextActionAt?: number;
  /** Relative ms to plan completion (kept for back-compat; prefer etaTargetAt) */
  eta: number;
  /** Absolute wall-clock ms when the whole sync is expected to finish. Survives tab close. */
  etaTargetAt?: number;
  wpm: number;
  activity: string;
  status: string;
  error?: string;
  nextTypoAction?: number;
  /** Index of next significant pause action (burst modes) */
  nextPauseAction?: number;
  /** Burst mode: mandatory pause durations in minutes */
  mandatoryPauses?: number[];
  /** Burst mode: indices of completed mandatory pauses */
  completedPauses?: number[];
  /** Timestamp of last server-side update — used for client-side stall detection */
  lastUpdate?: number;
  /** Current mandatory pause delay in ms (>0 means a long pause is active — stall detector should wait) */
  currentPauseDelayMs?: number;
  /** Baseline word count in target doc before sync started */
  baselineWordCount?: number;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Keyboard neighbor map for realistic fat-finger typos */
const NEIGHBORS: Record<string, string[]> = {
  a: ["s", "q", "z"], b: ["v", "n", "g"], c: ["x", "v", "d"],
  d: ["s", "f", "e", "c"], e: ["w", "r", "d"], f: ["d", "g", "r", "v"],
  g: ["f", "h", "t", "b"], h: ["g", "j", "y", "n"], i: ["u", "o", "k"],
  j: ["h", "k", "u", "n"], k: ["j", "l", "i", "m"], l: ["k", "o", "p"],
  m: ["n", "k", "l"], n: ["b", "m", "h", "j"], o: ["i", "p", "l"],
  p: ["o", "l"], q: ["w", "a"], r: ["e", "t", "f"],
  s: ["a", "d", "w", "z"], t: ["r", "y", "g"], u: ["y", "i", "j"],
  v: ["c", "b", "f", "g"], w: ["q", "e", "s"], x: ["z", "c", "s"],
  y: ["t", "u", "h"], z: ["a", "x", "s"],
};

/**
 * Generate a smart typo from the upcoming text.
 * Returns the distorted text AND the original correct segment it covers.
 * Strategies: adjacent-key swap, letter transposition, double letter, dropped letter, phonetic swap.
 */
function generateSmartTypo(upcomingText: string): { typo: string; correct: string } {
  // Find the first 1-3 words to distort
  const trimmed = upcomingText.trimStart();
  const leadingSpace = upcomingText.length - trimmed.length;
  const words = trimmed.split(/\s+/);
  const wordCount = Math.min(words.length, randInt(1, 3));
  const segment = words.slice(0, wordCount).join(" ");
  // The correct text includes any leading whitespace
  const correct = upcomingText.slice(0, leadingSpace + segment.length);

  if (segment.length < 2) {
    return { typo: segment + segment, correct };
  }

  const strategy = randInt(0, 4);
  const chars = segment.split("");

  let distorted: string;
  switch (strategy) {
    case 0: {
      // Adjacent-key replacement: replace 1-2 chars with keyboard neighbors
      const numReplacements = randInt(1, Math.min(2, chars.length));
      for (let r = 0; r < numReplacements; r++) {
        const idx = randInt(0, chars.length - 1);
        const lower = chars[idx].toLowerCase();
        const neighbors = NEIGHBORS[lower];
        if (neighbors) {
          const replacement = neighbors[randInt(0, neighbors.length - 1)];
          chars[idx] = chars[idx] === chars[idx].toUpperCase()
            ? replacement.toUpperCase()
            : replacement;
        }
      }
      distorted = chars.join("");
      break;
    }
    case 1: {
      // Letter transposition: swap two adjacent letters
      if (chars.length >= 2) {
        const idx = randInt(0, chars.length - 2);
        [chars[idx], chars[idx + 1]] = [chars[idx + 1], chars[idx]];
      }
      distorted = chars.join("");
      break;
    }
    case 2: {
      // Double letter: repeat a random character
      const idx = randInt(0, chars.length - 1);
      chars.splice(idx, 0, chars[idx]);
      distorted = chars.join("");
      break;
    }
    case 3: {
      // Dropped letter: remove a random character
      if (chars.length > 2) {
        const idx = randInt(0, chars.length - 1);
        chars.splice(idx, 1);
      }
      distorted = chars.join("");
      break;
    }
    case 4: {
      // Phonetic swap: common misspelling patterns
      let result = segment;
      const swaps: [string, string][] = [
        ["th", "ht"], ["ie", "ei"], ["ea", "ae"], ["ou", "uo"],
        ["er", "re"], ["an", "na"], ["in", "ni"], ["on", "no"],
        ["ti", "it"], ["es", "se"], ["al", "la"], ["en", "ne"],
      ];
      const applicable = swaps.filter(([from]) => result.toLowerCase().includes(from));
      if (applicable.length > 0) {
        const [from, to] = applicable[randInt(0, applicable.length - 1)];
        const idx = result.toLowerCase().indexOf(from);
        result = result.slice(0, idx) + to + result.slice(idx + from.length);
      } else {
        const idx2 = randInt(0, chars.length - 1);
        const lower = chars[idx2].toLowerCase();
        const neighbors = NEIGHBORS[lower];
        if (neighbors) {
          chars[idx2] = neighbors[randInt(0, neighbors.length - 1)];
        }
        result = chars.join("");
      }
      distorted = result;
      break;
    }
    default:
      distorted = segment;
  }

  // Ensure the typo is actually different from the correct text
  if (distorted === segment) {
    // Force at least one adjacent-key swap
    const forceChars = segment.split("");
    const idx = randInt(0, forceChars.length - 1);
    const lower = forceChars[idx].toLowerCase();
    const neighbors = NEIGHBORS[lower];
    if (neighbors) {
      forceChars[idx] = neighbors[randInt(0, neighbors.length - 1)];
    } else {
      forceChars[idx] = forceChars[idx] + forceChars[idx];
    }
    distorted = forceChars.join("");
  }

  return { typo: distorted, correct };
}

// ── Shared Helpers ────────────────────────────────────────────────────────

/**
 * Compute dynamic typo interval from typoFrequency (0-1).
 * 0 → ~300 char interval (rare), 1 → ~40 char interval (frequent).
 */
function typoIntervalRange(typoFrequency: number): [number, number] {
  const center = Math.round(300 - typoFrequency * 260); // 300 → 40
  const spread = Math.round(center * 0.25);
  return [Math.max(20, center - spread), center + spread];
}

/**
 * Split text on word boundaries into chunks of approximately `targetSize`.
 */
function chunkText(text: string, targetSize: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + targetSize, text.length);
    if (end < text.length) {
      const sp = text.lastIndexOf(" ", end);
      if (sp > offset) end = sp + 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

// ── Human Pace Plan ───────────────────────────────────────────────────────

/**
 * Build a constant-sync plan over a fixed duration.
 * CharsPerMinute = TotalChars / DurationMinutes, split into micro-bursts.
 */
function buildHumanPlan(
  text: string,
  durationMinutes: number,
  options: PlanOptions
): DripPlan {
  const typoFreq = options.typoFrequency ?? 0.5;
  const [typoMin, typoMax] = typoIntervalRange(typoFreq);
  const typoPauseMs = randInt(800, 1500);

  const totalChars = text.length;
  const totalBudgetMs = durationMinutes * 60 * 1000;
  const charsPerMinute = Math.ceil(totalChars / durationMinutes);

  const textActions: DripAction[] = [];
  let charsSinceLastTypo = 0;
  let nextTypoAt = randInt(typoMin, typoMax);

  const avgBursts = 4;
  const chunkSize = Math.ceil(charsPerMinute / avgBursts);
  const chunks = chunkText(text, chunkSize);

  for (const chunk of chunks) {
    if (charsSinceLastTypo + chunk.length >= nextTypoAt && chunk.length > 15) {
      const splitPoint = Math.max(10, nextTypoAt - charsSinceLastTypo);
      const beforeTypo = chunk.slice(0, splitPoint);
      const afterTypo = chunk.slice(splitPoint);

      if (beforeTypo.length > 0) {
        textActions.push({
          kind: "insert",
          text: beforeTypo,
          delayMs: 0,
          activity: "Typing…",
        });
      }

      const { typo, correct } = generateSmartTypo(afterTypo);
      const remainder = afterTypo.slice(correct.length);

      textActions.push({
        kind: "typo",
        text: correct,
        typoChars: typo,
        delayMs: 0,
        activity: "Correcting typo…",
      });

      // Insert the rest of the chunk after the typo correction
      if (remainder.length > 0) {
        textActions.push({
          kind: "insert",
          text: remainder,
          delayMs: 0,
          activity: "Typing…",
        });
      }

      charsSinceLastTypo = remainder.length;
      nextTypoAt = randInt(typoMin, typoMax);
    } else {
      textActions.push({
        kind: "insert",
        text: chunk,
        delayMs: 0,
        activity: "Typing…",
      });
      charsSinceLastTypo += chunk.length;
    }
  }

  // Distribute time budget across actions
  // Typo actions only consume their correction pause (typoPauseMs), NOT a pre-delay.
  // So the remaining delay budget must be spread only among insert actions.
  const typoCount = textActions.filter((a) => a.kind === "typo").length;
  const typoTimeBudget = typoCount * typoPauseMs;
  const delayBudget = Math.max(0, totalBudgetMs - typoTimeBudget);
  const insertActions = textActions.filter((a) => a.kind === "insert");
  // Subtract 1 for the first insert which fires immediately (delay=0)
  const numDelaySlots = Math.max(1, insertActions.length - 1);
  const baseDelay = Math.floor(delayBudget / numDelaySlots);

  let isFirstInsert = true;
  for (let i = 0; i < textActions.length; i++) {
    if (textActions[i].kind === "typo") {
      textActions[i].delayMs = typoPauseMs;
    } else {
      if (isFirstInsert) {
        textActions[i].delayMs = 0;
        isFirstInsert = false;
      } else {
        const variance = baseDelay * 0.15;
        textActions[i].delayMs = Math.max(1000, Math.round(baseDelay + randFloat(-variance, variance)));
      }
    }
  }

  // Spread any rounding error evenly across insert actions (skip first which is 0)
  if (textActions.length > 1) {
    const actualTotal = textActions.reduce((sum, a) => sum + a.delayMs, 0);
    const diff = totalBudgetMs - actualTotal;
    if (Math.abs(diff) > 500) {
      const adjustableInserts = textActions.filter((a) => a.kind === "insert" && a.delayMs > 0);
      if (adjustableInserts.length > 0) {
        const perAction = Math.round(diff / adjustableInserts.length);
        for (const a of adjustableInserts) {
          a.delayMs = Math.max(1000, a.delayMs + perAction);
        }
      }
    }
  }

  return { actions: textActions, totalChars, totalMinutes: durationMinutes };
}

// ── Public Entry Point ────────────────────────────────────────────────────

/**
 * Build a drip plan for the given text.
 *
 * @param text            Full source text
 * @param durationMinutes Total sync duration (ignored in burst mode)
 * @param mode            "human" or "burst"
 * @param options         Typo frequency + pause variance
 */
export function buildDripPlan(
  text: string,
  durationMinutes: number,
  mode: PaceMode,
  options: PlanOptions = {},
  customPauses: number[] = []
): DripPlan {
  if (mode === "burst") {
    return buildBurstPlan(text, options);
  }
  if (mode === "custom") {
    return buildCustomPlan(text, customPauses, options);
  }
  return buildHumanPlan(text, durationMinutes, options);
}

// ── Burst Mode: Mandatory Pause Checkpoints + Micro-typing ──────────────

const BURST_PAUSE_ACTIVITIES = [
  "Break — reviewing notes…",
  "Break — stepped away…",
  "Break — thinking…",
  "Break — re-reading draft…",
  "Break — researching…",
  "Break — getting coffee…",
];

/**
 * Pick `count` unique integers from [min..max] (inclusive).
 */
function pickUnique(min: number, max: number, count: number): number[] {
  const pool: number[] = [];
  for (let v = min; v <= max; v++) pool.push(v);
  // Fisher-Yates on pool, then take first `count`
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/**
 * Determine mandatory pause durations (in minutes) based on word count.
 * All durations are guaranteed to be distinct for natural-looking variation.
 */
function getMandatoryPauses(wordCount: number): number[] {
  if (wordCount <= 100) return pickUnique(1, 8, 3);    // 3 pauses, 1-8 min
  if (wordCount <= 300) return pickUnique(2, 12, 4);   // 4 pauses, 2-12 min
  if (wordCount <= 700) return pickUnique(2, 15, 5);   // 5 pauses, 2-15 min
  if (wordCount <= 1500) return pickUnique(3, 20, 5);  // 5 pauses, 3-20 min
  return pickUnique(5, 25, 5);                          // 5 pauses, 5-25 min
}

/** Fisher-Yates shuffle (in place) */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build a burst plan: mandatory pause checkpoints + natural micro-typed segments.
 *
 * Text is inserted in tiny micro-chunks (1-3 words each) with short realistic
 * delays (2-8s) to simulate actual keystroke rhythm. Every few micro-chunks,
 * a "thinking pause" (15-50s) is inserted. This produces many small edits in
 * Google Docs version history instead of a few large paste-like ones, achieving
 * a high GPTZero natural typing score.
 *
 * Mandatory pauses are shuffled so their durations appear in random order.
 */
function buildBurstPlan(text: string, options: PlanOptions): DripPlan {
  const typoFreq = options.typoFrequency ?? 0.5;
  const [typoMin, typoMax] = typoIntervalRange(typoFreq);
  const totalChars = text.length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Determine and shuffle mandatory pauses
  const mandatoryPauses = shuffle(getMandatoryPauses(wordCount));
  const numPauses = mandatoryPauses.length;

  // Split text into micro-chunks (8-25 chars ≈ 1-3 words) for realistic edit sizes
  const allChunks = chunkText(text, randInt(8, 25));

  // Distribute chunks across numPauses+1 segments
  const numSegments = numPauses + 1;
  const basePerSeg = Math.floor(allChunks.length / numSegments);
  const remainder = allChunks.length % numSegments;

  const segments: string[][] = [];
  let offset = 0;
  for (let s = 0; s < numSegments; s++) {
    const count = basePerSeg + (s < remainder ? 1 : 0);
    segments.push(allChunks.slice(offset, offset + count));
    offset += count;
  }

  const actions: DripAction[] = [];
  let charsSinceTypo = 0;
  let nextTypoAt = randInt(typoMin, typoMax);
  let isFirstAction = true;
  let chunksSinceThinkPause = 0;
  let nextThinkPauseAt = randInt(4, 8); // thinking pause every 4-8 micro-chunks

  for (let seg = 0; seg < numSegments; seg++) {
    const segChunks = segments[seg];

    for (const chunk of segChunks) {
      // Delay logic: realistic typing rhythm
      let delay: number;
      let activity: string;

      if (isFirstAction) {
        delay = 0;
        activity = "Typing…";
        isFirstAction = false;
      } else if (chunksSinceThinkPause >= nextThinkPauseAt) {
        // Periodic "thinking" pause — simulates re-reading or pausing to think
        delay = randInt(15_000, 50_000);
        activity = "Thinking…";
        chunksSinceThinkPause = 0;
        nextThinkPauseAt = randInt(4, 8);
      } else {
        // Normal micro-typing delay — 2-8 seconds between small inserts
        delay = randInt(2_000, 8_000);
        activity = "Typing…";
      }

      chunksSinceThinkPause++;

      // Typo injection
      if (charsSinceTypo + chunk.length >= nextTypoAt && chunk.length > 6) {
        const splitPoint = Math.max(4, nextTypoAt - charsSinceTypo);
        const before = chunk.slice(0, splitPoint);
        const after = chunk.slice(splitPoint);

        if (before.length > 0) {
          actions.push({ kind: "insert", text: before, delayMs: delay, activity });
          delay = randInt(1_000, 3_000);
          activity = "Typing…";
        }

        const { typo, correct } = generateSmartTypo(after);
        const rest = after.slice(correct.length);

        actions.push({
          kind: "typo", text: correct, typoChars: typo,
          delayMs: randInt(800, 2500), activity: "Correcting typo…",
        });

        if (rest.length > 0) {
          actions.push({ kind: "insert", text: rest, delayMs: randInt(1_500, 4_000), activity: "Typing…" });
        }

        charsSinceTypo = rest.length;
        nextTypoAt = randInt(typoMin, typoMax);
      } else {
        actions.push({ kind: "insert", text: chunk, delayMs: delay, activity });
        charsSinceTypo += chunk.length;
      }
    }

    // Insert mandatory pause after this segment (except after the last segment)
    if (seg < numPauses) {
      const pauseMin = mandatoryPauses[seg];
      const pauseMs = pauseMin * 60_000;
      actions.push({
        kind: "pause",
        text: "",
        delayMs: pauseMs,
        activity: BURST_PAUSE_ACTIVITIES[randInt(0, BURST_PAUSE_ACTIVITIES.length - 1)],
        mandatoryPauseIndex: seg,
      });
      // Reset thinking-pause counter after mandatory pause
      chunksSinceThinkPause = 0;
      nextThinkPauseAt = randInt(4, 8);
    }
  }

  const totalMs = actions.reduce((sum, a) => sum + a.delayMs, 0);
  const totalMinutes = Math.max(1, Math.ceil(totalMs / 60_000));

  return { actions, totalChars, totalMinutes, mandatoryPauses };
}

// ── Custom Mode: 1 sentence/minute baseline + user-selected pauses ──────────

/**
 * Split text into sentences. Each match keeps trailing punctuation + whitespace
 * so that re-joining the segments reproduces the original text exactly.
 * Falls back to a single segment if no terminator is present.
 */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+\n+|[^.!?\n]+$/g);
  if (!matches || matches.length === 0) return text.length > 0 ? [text] : [];
  // Drop empties that can appear when text starts/ends with whitespace
  return matches.filter((s) => s.length > 0);
}

const CUSTOM_PAUSE_CATALOG = new Set([4, 10, 15, 30, 45, 60, 90, 120, 180]);
const MAX_CUSTOM_PAUSES = 4;

/**
 * Build a custom plan: types each sentence over ~60s, then injects user-selected
 * pauses (in cart order) at evenly spaced sentence boundaries.
 *
 * Per-sentence delay budget = 60_000 ms, distributed across that sentence's
 * insert actions (mirrors human-pace distribution but per-sentence). The very
 * first action of the whole plan has delayMs = 0.
 */
function buildCustomPlan(
  text: string,
  customPauses: number[],
  options: PlanOptions
): DripPlan {
  const typoFreq = options.typoFrequency ?? 0.5;
  const [typoMin, typoMax] = typoIntervalRange(typoFreq);
  const typoPauseMs = randInt(800, 1500);
  const totalChars = text.length;

  // Sanitize pauses: keep only catalog values, cap at MAX_CUSTOM_PAUSES
  const validPauses = customPauses
    .filter((p) => Number.isFinite(p) && CUSTOM_PAUSE_CATALOG.has(p))
    .slice(0, MAX_CUSTOM_PAUSES);

  const sentences = splitSentences(text);
  const S = Math.max(1, sentences.length);
  const P = validPauses.length;

  // Compute insertion points: pause i is inserted after sentence index
  // floor((i+1) * S / (P+1)) - 1, clamped to [0, S-2] so we never insert
  // a pause after the very last sentence.
  const insertAfter = new Set<number>();
  if (P > 0 && S > 1) {
    for (let i = 0; i < P; i++) {
      let idx = Math.floor(((i + 1) * S) / (P + 1)) - 1;
      if (idx < 0) idx = 0;
      if (idx > S - 2) idx = S - 2;
      insertAfter.add(idx);
    }
  }

  const actions: DripAction[] = [];
  let charsSinceTypo = 0;
  let nextTypoAt = randInt(typoMin, typoMax);
  let isFirstAction = true;
  let pauseCursor = 0;

  for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
    const sentence = sentences[sIdx];

    // Build this sentence's insert/typo actions (delays filled in below).
    const sentenceActions: DripAction[] = [];
    const avgBursts = 4;
    const chunkSize = Math.max(8, Math.ceil(sentence.length / avgBursts));
    const chunks = chunkText(sentence, chunkSize);

    for (const chunk of chunks) {
      if (charsSinceTypo + chunk.length >= nextTypoAt && chunk.length > 12) {
        const splitPoint = Math.max(8, nextTypoAt - charsSinceTypo);
        const before = chunk.slice(0, splitPoint);
        const after = chunk.slice(splitPoint);

        if (before.length > 0) {
          sentenceActions.push({ kind: "insert", text: before, delayMs: 0, activity: "Typing…" });
        }

        const { typo, correct } = generateSmartTypo(after);
        const remainder = after.slice(correct.length);

        sentenceActions.push({
          kind: "typo", text: correct, typoChars: typo,
          delayMs: typoPauseMs, activity: "Correcting typo…",
        });

        if (remainder.length > 0) {
          sentenceActions.push({ kind: "insert", text: remainder, delayMs: 0, activity: "Typing…" });
        }

        charsSinceTypo = remainder.length;
        nextTypoAt = randInt(typoMin, typoMax);
      } else {
        sentenceActions.push({ kind: "insert", text: chunk, delayMs: 0, activity: "Typing…" });
        charsSinceTypo += chunk.length;
      }
    }

    // Distribute 60s budget across this sentence's insert actions.
    // Typos already consume typoPauseMs; spread remaining across inserts.
    const typoTime = sentenceActions.filter((a) => a.kind === "typo").length * typoPauseMs;
    const sentenceBudgetMs = 60_000;
    const remainingBudget = Math.max(0, sentenceBudgetMs - typoTime);
    const inserts = sentenceActions.filter((a) => a.kind === "insert");
    // Number of inserts that get a pre-delay. The first insert of the WHOLE
    // plan fires immediately (delay 0); for subsequent sentences every insert
    // can carry a delay.
    const delayableInserts = isFirstAction ? Math.max(1, inserts.length - 1) : Math.max(1, inserts.length);
    const baseDelay = Math.floor(remainingBudget / delayableInserts);

    let firstInsertOfSentence = true;
    for (const a of sentenceActions) {
      if (a.kind === "typo") continue; // already set to typoPauseMs
      if (isFirstAction) {
        a.delayMs = 0;
        isFirstAction = false;
        firstInsertOfSentence = false;
        continue;
      }
      if (firstInsertOfSentence) {
        // Give first insert of subsequent sentences a small lead-in delay too
        // (otherwise the sentence boundary would feel like a paste).
        firstInsertOfSentence = false;
      }
      const variance = baseDelay * 0.15;
      a.delayMs = Math.max(500, Math.round(baseDelay + randFloat(-variance, variance)));
    }

    actions.push(...sentenceActions);

    // Inject user pause if this sentence is an insertion point
    if (insertAfter.has(sIdx) && pauseCursor < validPauses.length) {
      const pauseMin = validPauses[pauseCursor];
      actions.push({
        kind: "pause",
        text: "",
        delayMs: pauseMin * 60_000,
        activity: `Custom break — ${pauseMin}m pause…`,
        mandatoryPauseIndex: pauseCursor,
      });
      pauseCursor++;
    }
  }

  const totalMs = actions.reduce((sum, a) => sum + a.delayMs, 0);
  const totalMinutes = Math.max(1, Math.ceil(totalMs / 60_000));

  return { actions, totalChars, totalMinutes, mandatoryPauses: validPauses };
}
