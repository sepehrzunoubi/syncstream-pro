/**
 * Drip Engine v6 — one planner for natural typing.
 *
 * The text is split into 1–3 word chunks that are typed at a realistic pace,
 * with short pauses at sentence ends, longer ones at paragraph ends, periodic
 * "thinking" pauses, occasional typos that get corrected, and a few longer
 * breaks. A target duration stretches or compresses the idle time (never the
 * keystrokes themselves into absurd values), and a seed makes the whole plan
 * reproducible so the client preview matches what the server will run.
 */

import { createRng, randomSeed, type Rng } from "./prng";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DripAction {
  /** insert = type text; typo = type wrong chars, hold, delete, type text; pause = wait only */
  kind: "insert" | "typo" | "pause";
  /** Text to insert (for typo: the correct text) */
  text: string;
  /** typo only: the wrong characters typed first */
  typoChars?: string;
  /** Wait before this action executes, in ms */
  delayMs: number;
  /** typo only: how long the wrong characters stay before being corrected, in ms */
  holdMs?: number;
  /** Human-readable activity label for the UI */
  activity: string;
  /** pause only: index into DripPlan.breaks for breaks that appear in the checklist */
  breakIndex?: number;
}

export interface PlanOptions {
  /** Total target duration in minutes. Omit (or null) for a natural pace. */
  targetMinutes?: number | null;
  /** "auto" picks breaks from the text length; [] disables them; a list gives explicit minutes. */
  breaks?: "auto" | number[];
  /** 0–1. 0 ≈ one typo per 300 chars, 1 ≈ one per 40 chars. Default 0.5 */
  typoFrequency?: number;
  /** Seed for reproducible plans. Random when omitted. */
  seed?: number;
}

export interface DripPlan {
  actions: DripAction[];
  totalChars: number;
  /** Exact planned wall time */
  totalMs: number;
  /** Rounded-up minutes, for display */
  totalMinutes: number;
  /** Break lengths in minutes, in execution order */
  breaks: number[];
  seed: number;
}

/** Snapshot of a job sent to the dashboard */
export interface StreamEvent {
  type: "progress" | "done" | "error";
  actionIndex: number;
  totalActions: number;
  charsSent: number;
  totalChars: number;
  nextActionAt?: number;
  etaTargetAt?: number;
  wpm: number;
  activity: string;
  status: string;
  error?: string;
  nextBreakAction?: number;
  nextBreakAt?: number;
  breaks?: number[];
  completedBreaks?: number[];
  lastUpdate?: number;
  baselineWordCount?: number;
  liveWordCount?: number;
}

export const MAX_CUSTOM_BREAKS = 8;
export const MAX_BREAK_MINUTES = 180;
export const MIN_TARGET_MINUTES = 1;
export const MAX_TARGET_MINUTES = 7 * 24 * 60;

// ── Keyboard neighbours for realistic typos ───────────────────────────────

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

/** Distort a word-ish string so it looks like a real slip. Never returns the input unchanged. */
export function distortText(rng: Rng, segment: string): string {
  if (segment.length < 2) return segment + segment;
  const chars = segment.split("");
  const strategy = rng.int(0, 3);
  if (strategy === 0) {
    // adjacent key
    const idx = rng.int(0, chars.length - 1);
    const neighbors = NEIGHBORS[chars[idx].toLowerCase()];
    if (neighbors) {
      const r = rng.pick(neighbors);
      chars[idx] = chars[idx] === chars[idx].toUpperCase() ? r.toUpperCase() : r;
    }
  } else if (strategy === 1) {
    // transpose two neighbours
    const idx = rng.int(0, chars.length - 2);
    [chars[idx], chars[idx + 1]] = [chars[idx + 1], chars[idx]];
  } else if (strategy === 2) {
    // doubled letter
    const idx = rng.int(0, chars.length - 1);
    chars.splice(idx, 0, chars[idx]);
  } else if (chars.length > 2) {
    // dropped letter
    chars.splice(rng.int(0, chars.length - 1), 1);
  }
  let out = chars.join("");
  if (out === segment) {
    const idx = rng.int(0, segment.length - 1);
    out = segment.slice(0, idx) + segment[idx] + segment.slice(idx);
  }
  return out;
}

// ── Tokenising ────────────────────────────────────────────────────────────

interface Chunk {
  text: string;
  words: number;
  endsSentence: boolean;
  endsParagraph: boolean;
}

/** Split text into 1–3 word chunks whose concatenation is exactly the input. */
function chunkText(text: string, rng: Rng): Chunk[] {
  const tokens = text.match(/\s*\S+\s*/g) ?? [];
  if (tokens.length === 0) return text.length > 0 ? [{ text, words: 0, endsSentence: false, endsParagraph: false }] : [];
  // Very long inputs get bigger chunks so the action count stays bounded.
  const scale = Math.max(1, Math.ceil(tokens.length / 900));
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < tokens.length) {
    const n = rng.int(1 * scale, 3 * scale);
    const slice = tokens.slice(i, i + n);
    // Do not run past a paragraph break inside a chunk
    let take = slice.length;
    for (let k = 0; k < slice.length - 1; k++) {
      if (/\n/.test(slice[k])) { take = k + 1; break; }
    }
    const piece = slice.slice(0, take);
    const joined = piece.join("");
    const trimmedEnd = joined.trimEnd();
    chunks.push({
      text: joined,
      words: piece.length,
      endsSentence: /[.!?]["')\]]*$/.test(trimmedEnd),
      endsParagraph: /\n/.test(joined.slice(trimmedEnd.length)),
    });
    i += take;
  }
  return chunks;
}

// ── Break selection ───────────────────────────────────────────────────────

function pickDistinct(rng: Rng, min: number, max: number, count: number): number[] {
  const pool: number[] = [];
  for (let v = min; v <= max; v++) pool.push(v);
  rng.shuffle(pool);
  return pool.slice(0, Math.min(count, pool.length));
}

/** Automatic break lengths (minutes) from the word count. */
export function autoBreaks(wordCount: number, rng: Rng): number[] {
  if (wordCount < 40) return [];
  if (wordCount < 120) return pickDistinct(rng, 2, 6, 1);
  if (wordCount <= 300) return pickDistinct(rng, 2, 12, rng.int(2, 3));
  if (wordCount <= 700) return pickDistinct(rng, 3, 15, rng.int(3, 4));
  if (wordCount <= 1500) return pickDistinct(rng, 3, 20, rng.int(4, 5));
  return pickDistinct(rng, 5, 25, 5);
}

const BREAK_ACTIVITIES = [
  "Break — stepped away…",
  "Break — re-reading the draft…",
  "Break — thinking…",
  "Break — getting coffee…",
  "Break — checking notes…",
];

/**
 * Choose chunk boundaries for `count` breaks, spaced evenly through the text,
 * preferring paragraph ends, then sentence ends, then any chunk boundary.
 * Returns indices i meaning "after chunk i".
 */
function placeBreaks(chunks: Chunk[], count: number, taken: Set<number>): number[] {
  const n = chunks.length;
  if (count === 0 || n < 2) return [];
  const result: number[] = [];
  for (let j = 0; j < count; j++) {
    const ideal = Math.round(((j + 1) * n) / (count + 1)) - 1;
    const candidate = nearestBoundary(chunks, ideal, taken);
    if (candidate == null) continue;
    taken.add(candidate);
    result.push(candidate);
  }
  return result.sort((a, b) => a - b);
}

function nearestBoundary(chunks: Chunk[], ideal: number, taken: Set<number>): number | null {
  const n = chunks.length;
  const lastAllowed = n - 2; // never after the final chunk
  const ok = (i: number) => i >= 0 && i <= lastAllowed && !taken.has(i);
  const tiers: ((c: Chunk) => boolean)[] = [
    (c) => c.endsParagraph,
    (c) => c.endsSentence,
    () => true,
  ];
  for (const tier of tiers) {
    const radius = tier === tiers[0] ? Math.max(3, Math.floor(n / 6)) : tier === tiers[1] ? Math.max(2, Math.floor(n / 10)) : n;
    for (let d = 0; d <= radius; d++) {
      for (const i of [ideal - d, ideal + d]) {
        if (ok(i) && tier(chunks[i])) return i;
      }
    }
  }
  return null;
}

// ── Planner ───────────────────────────────────────────────────────────────

export function buildDripPlan(text: string, options: PlanOptions = {}): DripPlan {
  const seed = options.seed ?? randomSeed();
  const rng = createRng(seed);
  const typoFrequency = clamp(options.typoFrequency ?? 0.5, 0, 1);
  const totalChars = text.length;
  const chunks = chunkText(text, rng);
  const wordCount = chunks.reduce((s, c) => s + c.words, 0);

  // Typo cadence in characters
  const typoCenter = Math.round(300 - typoFrequency * 260);
  const typoRange: [number, number] = [Math.max(20, Math.round(typoCenter * 0.75)), Math.round(typoCenter * 1.25)];

  // ── Base rhythm ──
  const typing: { chunk: Chunk; typoChars?: string; holdMs?: number; delayMs: number }[] = [];
  let charsSinceTypo = 0;
  let nextTypoAt = rng.int(typoRange[0], typoRange[1]);
  let chunksSinceThink = 0;
  let nextThinkAt = rng.int(5, 9);
  let carryPause = 0; // pause owed from the previous chunk's boundary

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const keystrokes = c.text.length * rng.float(220, 420);
    let delay = i === 0 ? 0 : Math.round(keystrokes + carryPause);
    chunksSinceThink++;
    if (i > 0 && chunksSinceThink >= nextThinkAt) {
      delay += rng.int(8_000, 35_000);
      chunksSinceThink = 0;
      nextThinkAt = rng.int(5, 9);
    }
    carryPause = c.endsParagraph ? rng.int(6_000, 20_000) : c.endsSentence ? rng.int(1_200, 5_000) : 0;

    const wordPart = c.text.trimEnd();
    let typoChars: string | undefined;
    let holdMs: number | undefined;
    if (wordPart.length >= 3 && charsSinceTypo + c.text.length >= nextTypoAt) {
      typoChars = distortText(rng, wordPart);
      holdMs = rng.int(600, 2_000);
      charsSinceTypo = 0;
      nextTypoAt = rng.int(typoRange[0], typoRange[1]);
    } else {
      charsSinceTypo += c.text.length;
    }
    typing.push({ chunk: c, typoChars, holdMs, delayMs: delay });
  }

  // ── Breaks ──
  const breakOption = options.breaks ?? "auto";
  let breakMinutes =
    breakOption === "auto"
      ? autoBreaks(wordCount, rng)
      : breakOption
          .filter((m) => Number.isFinite(m) && m >= 1 && m <= MAX_BREAK_MINUTES)
          .slice(0, MAX_CUSTOM_BREAKS)
          .map((m) => Math.round(m));
  if (breakOption === "auto") rng.shuffle(breakMinutes);

  const baseMs = typing.reduce((s, t) => s + t.delayMs + (t.holdMs ?? 0), 0);

  // ── Fit to target ──
  let scale = 1;
  let extraGapMs = 0;
  const target = options.targetMinutes;
  if (target != null && Number.isFinite(target) && target > 0) {
    const targetMs = clamp(target, MIN_TARGET_MINUTES, MAX_TARGET_MINUTES) * 60_000;
    let breaksMs = breakMinutes.reduce((s, m) => s + m, 0) * 60_000;
    // Too tight: shed automatic breaks first, then type faster (down to ~2.5× natural).
    if (breakOption === "auto") {
      while (breakMinutes.length > 0 && targetMs - breaksMs < baseMs * 0.4) {
        breakMinutes = breakMinutes.slice(0, -1);
        breaksMs = breakMinutes.reduce((s, m) => s + m, 0) * 60_000;
      }
    }
    const available = Math.max(0, targetMs - breaksMs);
    scale = clamp(available / Math.max(1, baseMs), 0.4, 1.6);
    extraGapMs = Math.max(0, available - baseMs * scale);
  }

  // Extra idle time becomes "away" gaps at natural boundaries.
  const gapMinutes: number[] = [];
  if (extraGapMs >= 90_000) {
    const count = clamp(Math.round(extraGapMs / (15 * 60_000)), 1, 40);
    const weights = Array.from({ length: count }, () => rng.float(0.5, 1.5));
    const wsum = weights.reduce((s, w) => s + w, 0);
    for (const w of weights) gapMinutes.push(Math.max(1, Math.round((extraGapMs * w) / wsum / 60_000)));
  }

  // ── Assemble ──
  const taken = new Set<number>();
  const breakPositions = placeBreaks(chunks, breakMinutes.length, taken);
  const gapPositions = placeBreaks(chunks, gapMinutes.length, taken);
  const pauseAt = new Map<number, { minutes: number; isBreak: boolean }[]>();
  breakPositions.forEach((pos, i) => pauseAt.set(pos, [...(pauseAt.get(pos) ?? []), { minutes: breakMinutes[i], isBreak: true }]));
  gapPositions.forEach((pos, i) => pauseAt.set(pos, [...(pauseAt.get(pos) ?? []), { minutes: gapMinutes[i], isBreak: false }]));

  const actions: DripAction[] = [];
  const breaks: number[] = [];
  for (let i = 0; i < typing.length; i++) {
    const t = typing[i];
    const delayMs = i === 0 ? 0 : Math.max(400, Math.round(t.delayMs * scale));
    if (t.typoChars) {
      actions.push({
        kind: "typo",
        text: t.chunk.text,
        typoChars: t.typoChars,
        delayMs,
        holdMs: Math.max(400, Math.round((t.holdMs ?? 1_000) * scale)),
        activity: "Correcting a typo…",
      });
    } else {
      actions.push({ kind: "insert", text: t.chunk.text, delayMs, activity: "Typing…" });
    }
    const pauses = pauseAt.get(i);
    if (pauses) {
      for (const p of pauses) {
        breaks.push(p.minutes);
        actions.push({
          kind: "pause",
          text: "",
          delayMs: p.minutes * 60_000,
          activity: p.isBreak ? rng.pick(BREAK_ACTIVITIES) : "Away from the keyboard…",
          breakIndex: breaks.length - 1,
        });
      }
    }
  }

  const totalMs = actions.reduce((s, a) => s + a.delayMs + (a.holdMs ?? 0), 0);
  return {
    actions,
    totalChars,
    totalMs,
    totalMinutes: Math.max(1, Math.ceil(totalMs / 60_000)),
    breaks,
    seed,
  };
}

/** Sum of the remaining wait from action `from` onward (inclusive of its own delay). */
export function remainingMs(actions: DripAction[], from: number): number {
  let sum = 0;
  for (let i = from; i < actions.length; i++) sum += actions[i].delayMs + (actions[i].holdMs ?? 0);
  return sum;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
