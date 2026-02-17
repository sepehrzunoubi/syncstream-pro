/**
 * Drip Engine v4 — Two modes: Human Pace + Burst Mode.
 *
 * Human Pace: Constant sync over a fixed duration.
 * Burst Mode: Random writing sessions with natural gaps. Auto-calculates
 *             total duration from word count. Sessions last 1-8 min with
 *             2-25 min pauses between them. Typo frequency + pause variance
 *             are user-configurable.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type PaceMode = "human" | "burst";

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
  /** V2 burst: index into the mandatoryPauses array (only set on mandatory pause actions) */
  mandatoryPauseIndex?: number;
}

export interface DripPlan {
  actions: DripAction[];
  totalChars: number;
  totalMinutes: number;
  /** V2 burst: mandatory pause durations in minutes (in execution order, already shuffled) */
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
  eta: number;
  wpm: number;
  activity: string;
  status: string;
  error?: string;
  nextTypoAction?: number;
  /** Index of next significant pause action (burst modes) */
  nextPauseAction?: number;
  /** V2 burst: mandatory pause durations in minutes */
  mandatoryPauses?: number[];
  /** V2 burst: indices of completed mandatory pauses */
  completedPauses?: number[];
  /** Timestamp of last server-side update — used for client-side stall detection */
  lastUpdate?: number;
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

// ── Burst Mode Plan ───────────────────────────────────────────────────────

const BURST_PAUSE_ACTIVITIES = [
  "Taking a break…",
  "Thinking…",
  "Re-reading…",
  "Researching…",
  "Paused",
  "Away…",
];

/**
 * Build a burst-mode plan: simple sentence-level dripping with random gaps.
 *
 * Pattern: bursts of rapid typing (17-55s between chunks) separated by
 * natural pauses (1-4 minutes). This creates realistic Google Docs version
 * history — visible editing activity, then silence, then more editing.
 *
 * All delays are short enough to fit within Vercel's 5-min function timeout,
 * eliminating the chaining problems that plagued the old session-based design.
 *
 * No user-configurable pause length — burst mode is fully automatic.
 * Only typoFrequency is user-controllable.
 */
function buildBurstPlan(text: string, options: PlanOptions): DripPlan {
  const typoFreq = options.typoFrequency ?? 0.5;
  const [typoMin, typoMax] = typoIntervalRange(typoFreq);
  const totalChars = text.length;

  // Split text into sentence-sized chunks (50-100 chars on word boundaries)
  const chunks = chunkText(text, randInt(50, 100));

  const actions: DripAction[] = [];
  let charsSinceTypo = 0;
  let nextTypoAt = randInt(typoMin, typoMax);

  // Tracks how many chunks remain in the current "burst" before a gap
  let chunksUntilBreak = randInt(2, 6);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    let delay: number;
    let activity: string;

    if (i === 0) {
      // First chunk fires immediately
      delay = 0;
      activity = "Typing…";
    } else if (chunksUntilBreak <= 0) {
      // Start of a new burst — insert an inter-burst gap
      const roll = Math.random();
      if (roll < 0.15) {
        // Quick resume — looks like the writer came right back
        delay = randInt(15_000, 45_000);
      } else if (roll < 0.70) {
        // Normal gap — 1-2.5 minutes
        delay = randInt(60_000, 150_000);
      } else {
        // Longer gap — 2.5-4 minutes
        delay = randInt(150_000, 240_000);
      }
      activity = BURST_PAUSE_ACTIVITIES[randInt(0, BURST_PAUSE_ACTIVITIES.length - 1)];
      // Reset burst counter
      chunksUntilBreak = randInt(2, 6);
    } else {
      // Within a burst — short delay simulating active typing
      delay = randInt(17_000, 55_000);
      activity = "Typing…";
    }

    chunksUntilBreak--;

    // Typo injection
    if (charsSinceTypo + chunk.length >= nextTypoAt && chunk.length > 12) {
      const splitPoint = Math.max(8, nextTypoAt - charsSinceTypo);
      const before = chunk.slice(0, splitPoint);
      const after = chunk.slice(splitPoint);

      if (before.length > 0) {
        actions.push({
          kind: "insert",
          text: before,
          delayMs: delay,
          activity,
        });
        delay = randInt(800, 2000);
        activity = "Typing…";
      }

      const { typo, correct } = generateSmartTypo(after);
      const remainder = after.slice(correct.length);

      actions.push({
        kind: "typo",
        text: correct,
        typoChars: typo,
        delayMs: randInt(800, 2500),
        activity: "Correcting typo…",
      });

      if (remainder.length > 0) {
        actions.push({
          kind: "insert",
          text: remainder,
          delayMs: randInt(1000, 4000),
          activity: "Typing…",
        });
      }

      charsSinceTypo = remainder.length;
      nextTypoAt = randInt(typoMin, typoMax);
    } else {
      actions.push({
        kind: "insert",
        text: chunk,
        delayMs: delay,
        activity,
      });
      charsSinceTypo += chunk.length;
    }
  }

  // Calculate total duration from the generated plan
  const totalMs = actions.reduce((sum, a) => sum + a.delayMs, 0);
  const totalMinutes = Math.max(1, Math.ceil(totalMs / 60_000));

  return { actions, totalChars, totalMinutes };
}

// ── Public Entry Point ────────────────────────────────────────────────────

/**
 * Build a drip plan for the given text.
 *
 * @param text            Full source text
 * @param durationMinutes Total sync duration (ignored in burst mode)
 * @param mode            "human" or "burst"
 * @param options         Typo frequency + pause variance
 * @param burstVersion    1 = random gaps (default), 2 = mandatory pause checkpoints
 */
export function buildDripPlan(
  text: string,
  durationMinutes: number,
  mode: PaceMode,
  options: PlanOptions = {},
  burstVersion: 1 | 2 = 1
): DripPlan {
  if (mode === "burst") {
    return burstVersion === 2
      ? buildBurstV2Plan(text, options)
      : buildBurstPlan(text, options);
  }
  return buildHumanPlan(text, durationMinutes, options);
}

// ── Burst V2: Mandatory Pause Checkpoints ────────────────────────────────

const V2_PAUSE_ACTIVITIES = [
  "Break — reviewing notes…",
  "Break — stepped away…",
  "Break — thinking…",
  "Break — re-reading draft…",
  "Break — researching…",
  "Break — getting coffee…",
];

/**
 * Determine mandatory pause durations (in minutes) based on word count.
 * Each call generates slightly different durations for natural variation.
 */
function getMandatoryPauses(wordCount: number): number[] {
  if (wordCount <= 100) {
    // Very short: 3 pauses
    return [
      randInt(1, 3),
      randInt(3, 6),
      randInt(2, 4),
    ];
  }
  if (wordCount <= 300) {
    // Short essay: 4 pauses
    return [
      randInt(2, 4),
      randInt(4, 8),
      randInt(6, 12),
      randInt(2, 5),
    ];
  }
  if (wordCount <= 700) {
    // Medium paper: 5 pauses
    return [
      randInt(2, 5),
      randInt(4, 8),
      randInt(8, 15),
      randInt(5, 10),
      randInt(3, 6),
    ];
  }
  if (wordCount <= 1500) {
    // Long paper: 5 pauses
    return [
      randInt(3, 7),
      randInt(5, 12),
      randInt(10, 20),
      randInt(8, 15),
      randInt(4, 8),
    ];
  }
  // Very long (1500+): 5 pauses
  return [
    randInt(5, 10),
    randInt(8, 15),
    randInt(12, 25),
    randInt(10, 20),
    randInt(5, 12),
  ];
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
 * Build a V2 burst plan: mandatory pause checkpoints + natural typing between them.
 *
 * The plan splits text into segments separated by mandatory pauses. Within each
 * segment, text is dripped in small chunks with short delays (17-55s) just like V1.
 * The mandatory pauses are shuffled so their durations appear in random order,
 * making version history look non-systematic.
 */
function buildBurstV2Plan(text: string, options: PlanOptions): DripPlan {
  const typoFreq = options.typoFrequency ?? 0.5;
  const [typoMin, typoMax] = typoIntervalRange(typoFreq);
  const totalChars = text.length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Determine and shuffle mandatory pauses
  const mandatoryPauses = shuffle(getMandatoryPauses(wordCount));
  const numPauses = mandatoryPauses.length;

  // Split text into small chunks
  const allChunks = chunkText(text, randInt(50, 100));

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
  let isFirstChunk = true;

  for (let seg = 0; seg < numSegments; seg++) {
    const segChunks = segments[seg];

    // Typing actions for this segment
    for (const chunk of segChunks) {
      const delay = isFirstChunk ? 0 : randInt(17_000, 55_000);
      const activity = "Typing…";
      isFirstChunk = false;

      // Typo injection (same logic as V1)
      if (charsSinceTypo + chunk.length >= nextTypoAt && chunk.length > 12) {
        const splitPoint = Math.max(8, nextTypoAt - charsSinceTypo);
        const before = chunk.slice(0, splitPoint);
        const after = chunk.slice(splitPoint);

        if (before.length > 0) {
          actions.push({ kind: "insert", text: before, delayMs: delay, activity });
        }

        const { typo, correct } = generateSmartTypo(after);
        const rest = after.slice(correct.length);

        actions.push({
          kind: "typo", text: correct, typoChars: typo,
          delayMs: randInt(800, 2500), activity: "Correcting typo…",
        });

        if (rest.length > 0) {
          actions.push({ kind: "insert", text: rest, delayMs: randInt(1000, 4000), activity: "Typing…" });
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
        activity: V2_PAUSE_ACTIVITIES[randInt(0, V2_PAUSE_ACTIVITIES.length - 1)],
        mandatoryPauseIndex: seg,
      });
    }
  }

  const totalMs = actions.reduce((sum, a) => sum + a.delayMs, 0);
  const totalMinutes = Math.max(1, Math.ceil(totalMs / 60_000));

  return { actions, totalChars, totalMinutes, mandatoryPauses };
}
