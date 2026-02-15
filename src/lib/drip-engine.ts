/**
 * Drip Engine v3 — Minute-Quota Algorithm with Typo Simulation.
 *
 * - CharsPerMinute = TotalChars / DurationMinutes (strict cap per 60s window)
 * - Each minute is split into 3-5 micro-bursts with 10-20s random gaps
 * - Typo injection every 300-500 chars: types wrong chars, deletes, retypes
 * - Two modes: "human" (default) and "longform" (research pauses every 15 min)
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type PaceMode = "human" | "longform";

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

const MICRO_BURSTS_MIN = 3;
const MICRO_BURSTS_MAX = 5;
const BURST_GAP_MIN_MS = 10_000;  // 10s
const BURST_GAP_MAX_MS = 20_000;  // 20s
const TYPO_INTERVAL_MIN = 300;    // inject typo every 300-500 chars
const TYPO_INTERVAL_MAX = 500;
const TYPO_WRONG_MIN = 5;         // 5-10 wrong characters
const TYPO_WRONG_MAX = 10;
const TYPO_PAUSE_MS = 1000;       // 1s pause before correction
const HEARTBEAT_INTERVAL_MS = 5000; // SSE heartbeat every 5s
const LONGFORM_PAUSE_INTERVAL_MIN = 15; // research pause every 15 min
const LONGFORM_PAUSE_MIN_MS = 60_000;   // 1-3 min research pause
const LONGFORM_PAUSE_MAX_MS = 180_000;

// ── Plan Builder ───────────────────────────────────────────────────────────

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

/**
 * Build the full drip plan using the Minute-Quota algorithm.
 *
 * @param text            Full source text
 * @param durationMinutes Total sync duration
 * @param mode            "human" or "longform"
 */
export function buildDripPlan(
  text: string,
  durationMinutes: number,
  mode: PaceMode
): DripPlan {
  const totalChars = text.length;
  const charsPerMinute = Math.ceil(totalChars / durationMinutes);

  const actions: DripAction[] = [];
  let textOffset = 0;
  let charsSinceLastTypo = 0;
  let nextTypoAt = randInt(TYPO_INTERVAL_MIN, TYPO_INTERVAL_MAX);
  let elapsedMinutes = 0;

  // Process minute by minute
  while (textOffset < totalChars && elapsedMinutes < durationMinutes) {
    const charsThisMinute = Math.min(charsPerMinute, totalChars - textOffset);
    const numBursts = randInt(MICRO_BURSTS_MIN, MICRO_BURSTS_MAX);

    // Split this minute's chars into micro-burst chunks
    const minuteText = text.slice(textOffset, textOffset + charsThisMinute);
    const burstChunks = chunkText(minuteText, Math.ceil(charsThisMinute / numBursts));

    // Distribute delays across the 60s window
    let minuteTimeUsed = 0;

    for (let b = 0; b < burstChunks.length; b++) {
      const chunk = burstChunks[b];

      // Delay before this burst
      const gapMs = b === 0
        ? (elapsedMinutes === 0 ? 0 : randFloat(BURST_GAP_MIN_MS, BURST_GAP_MAX_MS))
        : randFloat(BURST_GAP_MIN_MS, BURST_GAP_MAX_MS);
      minuteTimeUsed += gapMs;

      // Check if we should inject a typo within this chunk
      if (charsSinceLastTypo + chunk.length >= nextTypoAt && chunk.length > 15) {
        // Split chunk: part before typo, typo, part after
        const splitPoint = Math.max(10, nextTypoAt - charsSinceLastTypo);
        const beforeTypo = chunk.slice(0, splitPoint);
        const afterTypo = chunk.slice(splitPoint);

        // Insert the text before the typo
        if (beforeTypo.length > 0) {
          actions.push({
            kind: "insert",
            text: beforeTypo,
            delayMs: Math.round(gapMs),
            activity: "Typing\u2026",
          });
        }

        // Typo: type wrong chars
        const wrongLen = randInt(TYPO_WRONG_MIN, TYPO_WRONG_MAX);
        const wrongChars = generateTypoChars(wrongLen);
        actions.push({
          kind: "typo",
          text: afterTypo.length > 0 ? afterTypo : "",
          typoChars: wrongChars,
          delayMs: TYPO_PAUSE_MS,
          activity: "Correcting typo\u2026",
        });

        charsSinceLastTypo = afterTypo.length;
        nextTypoAt = randInt(TYPO_INTERVAL_MIN, TYPO_INTERVAL_MAX);
      } else {
        // Normal insert
        actions.push({
          kind: "insert",
          text: chunk,
          delayMs: Math.round(gapMs),
          activity: "Typing\u2026",
        });
        charsSinceLastTypo += chunk.length;
      }

      // Inject heartbeats during long gaps so the frontend gets updates every 5s
      if (b < burstChunks.length - 1) {
        const nextGap = randFloat(BURST_GAP_MIN_MS, BURST_GAP_MAX_MS);
        if (nextGap > HEARTBEAT_INTERVAL_MS * 2) {
          const heartbeats = Math.floor(nextGap / HEARTBEAT_INTERVAL_MS) - 1;
          for (let h = 0; h < Math.min(heartbeats, 3); h++) {
            actions.push({
              kind: "heartbeat",
              text: "",
              delayMs: HEARTBEAT_INTERVAL_MS,
              activity: "Paused to think\u2026",
            });
          }
        }
      }
    }

    textOffset += charsThisMinute;
    elapsedMinutes++;

    // Long Form mode: add research pauses every 15 minutes
    if (
      mode === "longform" &&
      elapsedMinutes > 0 &&
      elapsedMinutes % LONGFORM_PAUSE_INTERVAL_MIN === 0 &&
      textOffset < totalChars
    ) {
      const pauseMs = randFloat(LONGFORM_PAUSE_MIN_MS, LONGFORM_PAUSE_MAX_MS);
      actions.push({
        kind: "pause",
        text: "",
        delayMs: Math.round(pauseMs),
        activity: "Researching\u2026",
      });

      // Add heartbeats during the research pause
      const hbCount = Math.floor(pauseMs / HEARTBEAT_INTERVAL_MS) - 1;
      for (let h = 0; h < Math.min(hbCount, 10); h++) {
        actions.push({
          kind: "heartbeat",
          text: "",
          delayMs: HEARTBEAT_INTERVAL_MS,
          activity: "Researching\u2026",
        });
      }
    }

    // Fill remaining time in this minute with a thinking pause + heartbeat
    const remainingInMinute = 60_000 - minuteTimeUsed;
    if (remainingInMinute > HEARTBEAT_INTERVAL_MS && textOffset < totalChars) {
      actions.push({
        kind: "heartbeat",
        text: "",
        delayMs: Math.round(Math.min(remainingInMinute, HEARTBEAT_INTERVAL_MS)),
        activity: "Paused to think\u2026",
      });
    }
  }

  // If any text remains (rounding), flush it as a final insert
  if (textOffset < totalChars) {
    const remaining = text.slice(textOffset);
    const flushChunks = chunkText(remaining, Math.ceil(charsPerMinute / MICRO_BURSTS_MIN));
    for (const chunk of flushChunks) {
      actions.push({
        kind: "insert",
        text: chunk,
        delayMs: randInt(BURST_GAP_MIN_MS, BURST_GAP_MAX_MS),
        activity: "Typing\u2026",
      });
    }
  }

  return { actions, totalChars, totalMinutes: durationMinutes };
}
