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
  /** 0-1 scale. 0 = short gaps (1-4 min), 1 = long gaps (8-25 min). Burst mode only. Default 0.5 */
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
}

export interface DripPlan {
  actions: DripAction[];
  totalChars: number;
  totalMinutes: number;
}

export interface StreamEvent {
  type: "progress" | "done" | "error" | "heartbeat";
  actionIndex: number;
  totalActions: number;
  charsSent: number;
  totalChars: number;
  nextDelayMs: number;
  eta: number;
  wpm: number;
  activity: string;
  status: string;
  error?: string;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

const TYPO_CHARS = "abcdefghijklmnopqrstuvwxyz";
function generateTypoChars(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += TYPO_CHARS[randInt(0, TYPO_CHARS.length - 1)];
  }
  return s;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TYPO_WRONG_MIN = 3;         // 3-8 wrong characters
const TYPO_WRONG_MAX = 8;

// ── Shared Helpers ────────────────────────────────────────────────────────

/**
 * Compute dynamic typo interval from typoFrequency (0-1).
 * 0 → ~800 char interval (rare), 1 → ~120 char interval (frequent).
 */
function typoIntervalRange(typoFrequency: number): [number, number] {
  const center = Math.round(800 - typoFrequency * 680); // 800 → 120
  const spread = Math.round(center * 0.2);
  return [Math.max(60, center - spread), center + spread];
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

      textActions.push({
        kind: "typo",
        text: afterTypo,
        typoChars: generateTypoChars(randInt(TYPO_WRONG_MIN, TYPO_WRONG_MAX)),
        delayMs: 0,
        activity: "Correcting typo…",
      });

      charsSinceLastTypo = afterTypo.length;
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
  const typoCount = textActions.filter((a) => a.kind === "typo").length;
  const typoTimeBudget = typoCount * typoPauseMs;
  const delayBudget = totalBudgetMs - typoTimeBudget;
  const numGaps = textActions.length;
  const baseDelay = Math.floor(delayBudget / numGaps);

  for (let i = 0; i < textActions.length; i++) {
    if (textActions[i].kind === "typo") {
      textActions[i].delayMs = typoPauseMs;
    } else {
      const variance = baseDelay * 0.2;
      textActions[i].delayMs = Math.max(1000, Math.round(baseDelay + randFloat(-variance, variance)));
    }
  }

  // First action fires immediately, last action absorbs rounding error
  if (textActions.length > 0) {
    textActions[0].delayMs = 0;
    const actualTotal = textActions.reduce((sum, a) => sum + a.delayMs, 0);
    const diff = totalBudgetMs - actualTotal;
    if (textActions.length > 1) {
      const lastIdx = textActions.length - 1;
      textActions[lastIdx].delayMs = Math.max(0, textActions[lastIdx].delayMs + diff);
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
 * Build a burst-mode plan: random writing sessions separated by natural gaps.
 * Duration is auto-calculated from text length + randomized session structure.
 *
 * Each session: 1-8 min of active typing at 25-45 WPM.
 * Between sessions: configurable pauses (1-25 min based on pauseVariance).
 */
function buildBurstPlan(text: string, options: PlanOptions): DripPlan {
  const typoFreq = options.typoFrequency ?? 0.5;
  const pauseVar = options.pauseVariance ?? 0.5;
  const [typoMin, typoMax] = typoIntervalRange(typoFreq);
  const totalChars = text.length;

  // Active typing speed during bursts: 25-45 WPM (~125-225 CPM)
  const activeCPM = randFloat(125, 225);

  // Build sessions: split text into variable-length writing sessions
  const actions: DripAction[] = [];
  let offset = 0;
  let sessionIndex = 0;

  while (offset < totalChars) {
    // Session length: 1-8 minutes of active typing
    const sessionMinutes = randFloat(1, 8);
    const sessionChars = Math.min(
      Math.ceil(sessionMinutes * activeCPM),
      totalChars - offset
    );

    // Inter-session pause (not before first session)
    if (sessionIndex > 0) {
      // pauseVariance 0 → 1-4 min, 0.5 → 4.5-14.5 min, 1 → 8-25 min
      const minPauseMin = 1 + pauseVar * 7;
      const maxPauseMin = 4 + pauseVar * 21;
      const pauseMs = randFloat(minPauseMin, maxPauseMin) * 60_000;

      actions.push({
        kind: "pause",
        text: "",
        delayMs: Math.round(pauseMs),
        activity: BURST_PAUSE_ACTIVITIES[randInt(0, BURST_PAUSE_ACTIVITIES.length - 1)],
      });
    }

    // Split session text into small micro-chunks for natural typing feel
    const sessionText = text.slice(offset, offset + sessionChars);
    const microChunkSize = randInt(15, 60);
    const chunks = chunkText(sessionText, microChunkSize);

    let charsSinceTypo = 0;
    let nextTypoAt = randInt(typoMin, typoMax);

    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];

      // Micro-delay between chunks within a session: 3-18 seconds
      const delay =
        c === 0 && sessionIndex === 0
          ? 0
          : randInt(3000, 18000);

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
            activity: "Typing…",
          });
        }

        actions.push({
          kind: "typo",
          text: after,
          typoChars: generateTypoChars(randInt(TYPO_WRONG_MIN, TYPO_WRONG_MAX)),
          delayMs: randInt(800, 2500),
          activity: "Correcting typo…",
        });

        charsSinceTypo = after.length;
        nextTypoAt = randInt(typoMin, typoMax);
      } else {
        actions.push({
          kind: "insert",
          text: chunk,
          delayMs: delay,
          activity: "Typing…",
        });
        charsSinceTypo += chunk.length;
      }
    }

    offset += sessionChars;
    sessionIndex++;
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
 */
export function buildDripPlan(
  text: string,
  durationMinutes: number,
  mode: PaceMode,
  options: PlanOptions = {}
): DripPlan {
  if (mode === "burst") {
    return buildBurstPlan(text, options);
  }
  return buildHumanPlan(text, durationMinutes, options);
}
