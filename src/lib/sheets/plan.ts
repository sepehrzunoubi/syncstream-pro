/**
 * When each step of a spreadsheet sync happens. Every step waits a moment first: the time it takes
 * to do (keystrokes, a click on a toolbar) and the time someone thinks before doing it (longer
 * before a formula than before a label, longer again at the start of a new section). A total time
 * stretches or squeezes only the thinking, and what is left over of a long one is spent away from
 * the sheet, between sections. A seed makes the plan the same on the page and on the server.
 */

import type { DripAction } from "../drip-engine";
import { createRng, randomSeed, type Rng } from "../prng";
import { typedText, type Workbook } from "./model";
import { planSteps, type PlanSection } from "./order";
import { compareSteps, type CompareSummary } from "./compare";
import { stepLabel, type Step } from "./steps";

/** Google allows 60 writes a minute per person: no step follows the one before it sooner than this */
export const MIN_STEP_MS = 1_100;
/** Time away shorter than this is thinking; from here on it is its own step */
const MIN_PAUSE_MS = 45_000;
export const MIN_SHEET_TARGET_MINUTES = 1;
export const MAX_SHEET_TARGET_MINUTES = 7 * 24 * 60;

/** A break someone placed: before section number `section` (as planSteps lists them) starts, for `minutes` */
export interface SheetBreak { section: number; minutes: number }
export const MAX_SHEET_BREAKS = 50;
export const MAX_SHEET_BREAK_MINUTES = 12 * 60;

/** The breaks of a request, checked: whole sections that exist (not the first), each once, sane lengths */
export function parseSheetBreaks(raw: unknown, sections: number): SheetBreak[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SHEET_BREAKS) return null;
  const seen = new Set<number>();
  const out: SheetBreak[] = [];
  for (const b of raw) {
    const o = b as Partial<SheetBreak> | null;
    if (!o || typeof o.section !== "number" || !Number.isInteger(o.section) || o.section < 1 || o.section >= sections || seen.has(o.section)) return null;
    if (typeof o.minutes !== "number" || !Number.isFinite(o.minutes) || o.minutes < 1 || o.minutes > MAX_SHEET_BREAK_MINUTES) return null;
    seen.add(o.section);
    out.push({ section: o.section, minutes: o.minutes });
  }
  return out.sort((a, b) => a.section - b.section);
}

export interface SheetPlanOptions {
  /** The whole sync's length in minutes; none for a natural pace */
  targetMinutes?: number | null;
  seed?: number;
  /** Breaks placed by hand, each before a section; they are part of the total time when one is asked for */
  breaks?: SheetBreak[];
  /**
   * Compare & Sync: the spreadsheet as it is now. The plan is then only what it is missing of the
   * workbook (compare.ts); `tabs` names the tabs of it that can be written, lower-cased.
   */
  have?: Workbook;
  tabs?: ReadonlySet<string>;
}

export interface SheetPlan {
  steps: Step[];
  sections: PlanSection[];
  /** One per step: its wait and what the activity line says */
  actions: DripAction[];
  /** What each step counts for in the progress (keystrokes, more or less) */
  units: number[];
  totalUnits: number;
  totalMs: number;
  /** The pace with nothing asked for, and the fastest there is */
  naturalMs: number;
  minMs: number;
  /** False when the time asked for is shorter than the fastest */
  fitsTarget: boolean;
  seed: number;
  /** The sections before any time away was added: what a break's `section` counts in */
  sectionCount: number;
  /** Compare & Sync: what will be typed and what is left as it is */
  compare?: { typed: Set<number>[]; summary: CompareSummary };
}

interface Timing { floor: number; think: number }

function stepTiming(rng: Rng, wb: Workbook, step: Step): Timing {
  switch (step.k) {
    case "type": {
      const cell = wb.sheets[step.s]?.cells[step.cells[0]];
      const text = cell ? typedText(cell) : "";
      const n = Math.min(text.length, 400);
      if (cell?.f != null) return { floor: 700 + n * 150, think: Math.min(22_000, rng.float(1_800, 6_500) + n * 130) };
      if (typeof cell?.v === "number") return { floor: 400 + n * 130, think: rng.float(600, 2_200) + n * 70 };
      return { floor: 350 + n * 105, think: rng.float(500, 1_900) + n * 85 };
    }
    case "fill": return { floor: 900, think: rng.float(800, 2_600) };
    case "paste": return { floor: 1_300, think: rng.float(1_800, 5_500) };
    case "fmt": return { floor: 1_000, think: rng.float(900, 3_200) + (step.a === "borders" ? 900 : 0) + Math.min(2_500, (step.rects.length - 1) * 350) };
    case "runs": return { floor: 1_400, think: rng.float(1_200, 3_500) };
    case "merge": return { floor: 1_000, think: rng.float(700, 2_200) + Math.min(2_500, (step.rects.length - 1) * 400) };
    case "size": case "hide": return { floor: 900, think: rng.float(500, 1_900) };
    case "sheet": return { floor: 1_200, think: rng.float(2_500, 7_000) };
    case "chart": return { floor: 2_500, think: rng.float(5_000, 14_000) };
    case "pause": return { floor: 0, think: 0 };
    default: return { floor: 1_100, think: rng.float(900, 3_200) };
  }
}

function stepUnits(wb: Workbook, step: Step): number {
  if (step.k === "pause") return 0;
  if (step.k === "type") { const cell = wb.sheets[step.s]?.cells[step.cells[0]]; return Math.max(1, cell ? typedText(cell).length : 1); }
  if (step.k === "fill" || step.k === "paste") return Math.max(2, step.cells.length * 2);
  return 3;
}

/** The first cell a step touches: [sheet, row, column] */
function stepPlace(wb: Workbook, step: Step): [number, number, number] | null {
  if (step.k === "type" || step.k === "fill" || step.k === "paste") { const c = wb.sheets[step.s]?.cells[step.cells[0]]; return c ? [step.s, c.r, c.c] : null; }
  if (step.k === "fmt" || step.k === "merge") return step.rects[0] ? [step.s, step.rects[0][0], step.rects[0][1]] : null;
  return null;
}

export function buildSheetPlan(wb: Workbook, opts: SheetPlanOptions = {}): SheetPlan {
  const seed = opts.seed ?? randomSeed();
  const rng = createRng(seed);
  const compared = opts.have ? compareSteps(opts.have, wb, opts.tabs) : null;
  const base = compared ?? planSteps(wb);
  const starts = new Set(base.sections.map((s) => s.at));

  const timings: Timing[] = [];
  let prev: [number, number, number] | null = null;
  base.steps.forEach((step, i) => {
    const t = stepTiming(rng, wb, step);
    // A new section is looked at before it is started; going back up the sheet takes a moment too
    if (starts.has(i) && i > 0) t.think += rng.float(4_000, 12_000);
    const place = stepPlace(wb, step);
    if (place && prev && (place[0] !== prev[0] || Math.abs(place[1] - prev[1]) > 8)) t.think += rng.float(700, 2_400);
    if (place) prev = place;
    t.floor = Math.max(MIN_STEP_MS, Math.round(t.floor));
    t.think = Math.round(t.think);
    timings.push(t);
  });
  // (the first thing happens as soon as the sync starts)
  if (timings[0]) timings[0] = { floor: MIN_STEP_MS, think: 0 };

  const minMs = timings.reduce((a, t) => a + t.floor, 0);
  const naturalMs = timings.reduce((a, t) => a + t.floor + t.think, 0);
  const asked = opts.targetMinutes != null && Number.isFinite(opts.targetMinutes)
    ? Math.min(MAX_SHEET_TARGET_MINUTES, Math.max(MIN_SHEET_TARGET_MINUTES, opts.targetMinutes)) * 60_000
    : null;
  // Breaks placed by hand: each before its section. With a total time, they are part of it
  const breakAt = new Map<number, number>();
  for (const b of opts.breaks ?? []) {
    const section = base.sections[b.section];
    if (section && b.section > 0 && section.at > 0) breakAt.set(section.at, (breakAt.get(section.at) ?? 0) + Math.round(b.minutes * 60_000));
  }
  const breaksMs = Array.from(breakAt.values()).reduce((a, b) => a + b, 0);
  const target = asked == null ? null : asked - breaksMs;

  let scale = 1;
  let away = 0;
  let fitsTarget = true;
  if (target != null) {
    if (target < minMs) { scale = 0; fitsTarget = false; }
    else if (target <= naturalMs) scale = naturalMs > minMs ? (target - minMs) / (naturalMs - minMs) : 1;
    else away = target - naturalMs;
  }

  // Time away goes between sections, in a few long stretches rather than many short ones
  const awayAt = new Map<number, number>();
  if (away > 0) {
    const places = base.sections.map((s) => s.at).filter((at) => at > 0);
    const count = Math.min(places.length, Math.max(1, Math.min(12, Math.round(away / (20 * 60_000)) + 1)));
    if (away < MIN_PAUSE_MS || !count) {
      // Too little to step away for: it is spent thinking
      scale = naturalMs > minMs ? 1 + away / (naturalMs - minMs) : 1;
      if (naturalMs <= minMs && timings.length > 1) timings[timings.length - 1].floor += away;
      away = 0;
    } else {
      const picked = rng.shuffle(places.slice()).slice(0, count).sort((a, b) => a - b);
      const weights = picked.map(() => rng.float(0.6, 1.4));
      const sum = weights.reduce((a, b) => a + b, 0);
      let left = away;
      picked.forEach((at, i) => {
        const ms = i === picked.length - 1 ? left : Math.round((away * weights[i]) / sum);
        left -= ms;
        awayAt.set(at, ms);
      });
    }
  }

  const steps: Step[] = [];
  const actions: DripAction[] = [];
  const units: number[] = [];
  const moved = new Map<number, number>();
  let totalMs = 0;
  base.steps.forEach((step, i) => {
    for (const [pause, activity] of [[breakAt.get(i), "On a break"], [awayAt.get(i), "Away from the sheet"]] as const) {
      if (!pause) continue;
      steps.push({ k: "pause" });
      actions.push({ kind: "pause", text: "", delayMs: pause, activity });
      units.push(0);
      totalMs += pause;
    }
    moved.set(i, steps.length);
    const t = timings[i];
    const delayMs = Math.max(MIN_STEP_MS, Math.round(t.floor + t.think * scale));
    steps.push(step);
    actions.push({ kind: "insert", text: "", delayMs, activity: stepLabel(wb, step) });
    units.push(stepUnits(wb, step));
    totalMs += delayMs;
  });
  // Rounding leaves a second or two: the last wait takes it, so the total is the one asked for
  if (target != null && fitsTarget && actions.length > 1) {
    const last = actions[actions.length - 1];
    const fixed = Math.max(MIN_STEP_MS, last.delayMs + (target + breaksMs - totalMs));
    totalMs += fixed - last.delayMs;
    last.delayMs = fixed;
  }
  const sections = base.sections.map((s) => ({ ...s, at: moved.get(s.at) ?? s.at }));
  return { steps, sections, actions, units, totalUnits: units.reduce((a, b) => a + b, 0), totalMs, naturalMs, minMs, fitsTarget, seed, sectionCount: base.sections.length, ...(compared ? { compare: { typed: compared.typed, summary: compared.summary } } : {}) };
}
