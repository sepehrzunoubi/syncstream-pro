/**
 * Breaks placed at exact spots in the text ("Manual" breaks), and changed while a sync types.
 *
 * A break is a pause action in the plan. Its place is the number of source characters typed
 * before it: a break `at` 120 starts once the first 120 characters are in the document. Placing
 * one splits the typing action it falls inside (if any) into two, so the text, its order, the
 * typing rhythm and the typos all stay as they were: only the wait between them changes.
 *
 * The same function places the breaks chosen before a sync starts and replaces the breaks still
 * ahead of a running one. A running sync's breaks can change only after what it is typing now
 * (see `editableFrom`); the break it is on can be ended or given another length.
 */

import type { DripAction, DripPlan } from "./drip-engine";

export interface BreakAnchor {
  /** Source characters typed before the break starts */
  at: number;
  minutes: number;
}

export const MAX_ANCHORED_BREAKS = 200;
/** One break may last up to a day */
export const MAX_ANCHORED_MINUTES = 24 * 60;
/** All of a sync's breaks together: a week */
export const MAX_TOTAL_BREAK_MINUTES = 7 * 24 * 60;
export const MANUAL_BREAK_ACTIVITY = "On a break";

const OBJ = "￼";
const PAGE_BREAK = "\u000C";

const typedLength = (a: DripAction) => (a.kind === "pause" ? 0 : a.text.length);

/** Source offset at which each action starts */
function offsets(actions: DripAction[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const a of actions) { out.push(at); at += typedLength(a); }
  return out;
}

/** Where each pause action of the plan is, in source characters, in order */
export function breakOffsets(actions: DripAction[]): number[] {
  const starts = offsets(actions);
  return actions.flatMap((a, i) => (a.kind === "pause" ? [starts[i]] : []));
}

/**
 * Split a typing action after its first `k` characters. The wait before it is shared by length;
 * a typo stays with the part its slip is in, or becomes plain typing when the slip spans both.
 */
export function splitAction(a: DripAction, k: number): [DripAction, DripAction] {
  const first = a.text.slice(0, k);
  const second = a.text.slice(k);
  const d1 = Math.round((a.delayMs * k) / Math.max(1, a.text.length));
  const plain = (text: string, delayMs: number): DripAction => ({ kind: "insert", text, delayMs, activity: "Typing" });
  const p1 = plain(first, d1);
  const p2 = plain(second, a.delayMs - d1);
  if (a.kind !== "typo" || a.typoChars == null) return [p1, p2];
  // typoChars is the slipped version of the whole chunk's words (its trailing space left off)
  const word = a.text.trimEnd();
  const slip = a.typoChars;
  const hold = { holdMs: a.holdMs, activity: a.activity };
  if (slip.startsWith(first) && first.length < word.length) {
    const rest = slip.slice(first.length);
    if (rest && rest !== second.trimEnd()) return [p1, { ...p2, kind: "typo", typoChars: rest, ...hold }];
  }
  const tail = word.slice(first.length);
  if (slip.endsWith(tail)) {
    const head = slip.slice(0, slip.length - tail.length).trimEnd();
    if (head && head !== first.trimEnd()) return [{ ...p1, kind: "typo", typoChars: head, ...hold }, p2];
  }
  return [p1, p2];
}

/**
 * The plan with every pause after action `keep` taken out and a break put at each anchor.
 * Actions up to and including `keep` are left exactly as they are (-1 keeps none). Anchors must
 * be sorted, distinct and after what action `keep` types; `label` is the breaks' activity.
 */
export function placeAnchors(actions: DripAction[], anchors: BreakAnchor[], keep = -1, label = MANUAL_BREAK_ACTIVITY): DripAction[] {
  const out = actions.slice(0, keep + 1);
  let at = out.reduce((s, a) => s + typedLength(a), 0);
  let next = 0;
  const pause = (minutes: number): DripAction => ({ kind: "pause", text: "", delayMs: Math.round(minutes * 60_000), activity: label });
  for (let i = keep + 1; i < actions.length; i++) {
    let a = actions[i];
    if (a.kind === "pause") continue;
    // Anchors inside this action split it; one at its end comes after it
    while (next < anchors.length && anchors[next].at < at + a.text.length) {
      const k = anchors[next].at - at;
      if (k > 0) {
        const [head, tail] = splitAction(a, k);
        out.push(head);
        at += head.text.length;
        a = tail;
      }
      out.push(pause(anchors[next].minutes));
      next++;
    }
    out.push(a);
    at += a.text.length;
    while (next < anchors.length && anchors[next].at === at) { out.push(pause(anchors[next].minutes)); next++; }
  }
  return out;
}

/** Number each pause in order, and the minutes of each: the plan's `breaks` and each pause's `breakIndex` */
export function numberBreaks(actions: DripAction[]): { actions: DripAction[]; breaks: number[] } {
  const breaks: number[] = [];
  const numbered = actions.map((a) => {
    if (a.kind !== "pause") return a;
    breaks.push(Math.round((a.delayMs / 60_000) * 100) / 100);
    return { ...a, breakIndex: breaks.length - 1 };
  });
  return { actions: numbered, breaks };
}

/**
 * The first place a running sync's breaks can still change: after the action it is on, unless
 * that is a break (then right after it, where the break already is, so a new one must come later).
 */
export function editableFrom(actions: DripAction[], currentAction: number): number {
  const starts = offsets(actions);
  if (currentAction >= actions.length) return actions.reduce((s, a) => s + typedLength(a), 0);
  return starts[currentAction] + typedLength(actions[currentAction]);
}

/** A source character a break can follow: the end of a word, with the space or line after it */
const breakable = (prev: string | undefined) => prev != null && (/\s/.test(prev) || prev === OBJ || prev === PAGE_BREAK);

export type AnchorCheck = { ok: true; anchors: BreakAnchor[] } | { ok: false; error: string };

/**
 * Validate breaks sent by a client. Each goes after a word of `text` (or at the end of an
 * addition, `ends`), after `from`, and before the last character, so something is typed after it.
 */
export function parseAnchors(raw: unknown, text: string, opts: { from?: number; ends?: number[]; strictFrom?: boolean } = {}): AnchorCheck {
  if (!Array.isArray(raw)) return { ok: false, error: "Breaks must be a list" };
  if (raw.length > MAX_ANCHORED_BREAKS) return { ok: false, error: `At most ${MAX_ANCHORED_BREAKS} breaks` };
  const from = opts.from ?? 0;
  const ends = new Set(opts.ends ?? []);
  const anchors: BreakAnchor[] = [];
  let total = 0;
  for (const item of raw as Record<string, unknown>[]) {
    const at = item?.at;
    const minutes = item?.minutes;
    if (typeof at !== "number" || !Number.isInteger(at)) return { ok: false, error: "Invalid break position" };
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_ANCHORED_MINUTES || Math.round(minutes) !== minutes) {
      return { ok: false, error: `Each break must be a whole number of minutes, from 1 minute to ${MAX_ANCHORED_MINUTES / 60} hours` };
    }
    if (at < from || (opts.strictFrom && at === from)) return { ok: false, error: "That part is already typed: a break can only go after what the sync is typing now" };
    if (at < 1 || at >= text.length) return { ok: false, error: "A break needs text typed after it" };
    if (!breakable(text[at - 1]) && !ends.has(at)) return { ok: false, error: "Breaks go after a word" };
    anchors.push({ at, minutes });
    total += minutes;
  }
  anchors.sort((a, b) => a.at - b.at);
  if (anchors.some((a, i) => i > 0 && anchors[i - 1].at === a.at)) return { ok: false, error: "Two breaks after the same word" };
  if (total > MAX_TOTAL_BREAK_MINUTES) return { ok: false, error: "All breaks together can last up to 7 days" };
  return { ok: true, anchors };
}

/** What a client asks to change about a running sync's breaks */
export interface BreakEdit {
  /** Every break still ahead, after what the sync is typing now */
  breaks: BreakAnchor[];
  /** The break the sync is on now: end it, or give it another length (whole minutes, from its start) */
  current?: { end: true } | { minutes: number };
  /** The job's breaksVersion this edit was made against */
  version?: number;
}

export interface EditablePlan {
  actions: DripAction[];
  breaks: number[];
  totalMs: number;
}

export interface EditableJob {
  status: string;
  currentAction: number;
  totalActions: number;
  nextActionAt?: number;
  lastDueAt?: number;
  /** A paused sync's wait left on the action it is on */
  waitLeftMs?: number;
  breaks: number[];
  breakAt?: number[];
  completedBreaks: number[];
  breaksVersion?: number;
  editableFrom?: number;
}

/**
 * Apply an edit to a plan and its job (both changed in place). Returns an error message when the
 * edit no longer fits the job (typing moved on, another tab changed the breaks first), and whether
 * the current wait now ends sooner, which needs a fresh hand-off to the queue.
 */
export function applyBreakEdit(plan: EditablePlan, job: EditableJob, edit: BreakEdit, now: number, opts: { lenient?: boolean } = {}): { ok: true; sooner: boolean } | { ok: false; error: string; conflict?: boolean } {
  if (edit.version != null && (job.breaksVersion ?? 0) !== edit.version) return { ok: false, error: "The breaks were changed somewhere else. Check them and try again.", conflict: true };
  const from = editableFrom(plan.actions, job.currentAction);
  const onBreak = plan.actions[job.currentAction]?.kind === "pause";
  const late = (b: BreakAnchor) => b.at < from || (onBreak && b.at === from);
  // (a change left for the worker drops what typing has passed since; one applied at once is refused)
  if (!opts.lenient && edit.breaks.some(late)) return { ok: false, error: "That part is already typed: a break can only go after what the sync is typing now", conflict: true };
  let sooner = false;
  const actions = placeAnchors(plan.actions, edit.breaks.filter((b) => !late(b)), job.currentAction, MANUAL_BREAK_ACTIVITY);
  // (a change left for the worker may find the break it was about already over: the rest still applies)
  if (edit.current && !onBreak && !opts.lenient) return { ok: false, error: "The sync isn't on a break right now", conflict: true };
  if (edit.current && onBreak) {
    const cur = { ...actions[job.currentAction] };
    const oldMs = cur.delayMs;
    const newMs = "end" in edit.current ? 0 : Math.round(edit.current.minutes * 60_000);
    if (job.nextActionAt != null) {
      const startedAt = job.nextActionAt - oldMs;
      const until = Math.max(now, startedAt + newMs);
      sooner = until < job.nextActionAt;
      job.nextActionAt = until;
      cur.delayMs = Math.max(0, until - startedAt);
    } else if (job.waitLeftMs != null) {
      // Paused on the break: what is left of it changes with it
      const spent = oldMs - job.waitLeftMs;
      job.waitLeftMs = Math.max(0, newMs - spent);
      cur.delayMs = Math.max(spent, newMs);
    } else cur.delayMs = newMs;
    actions[job.currentAction] = cur;
  }
  const numbered = numberBreaks(actions);
  plan.actions = numbered.actions;
  plan.breaks = numbered.breaks;
  plan.totalMs = plan.actions.reduce((s, a) => s + a.delayMs + (a.holdMs ?? 0), 0);
  job.totalActions = plan.actions.length;
  job.breaks = plan.breaks;
  job.breakAt = breakOffsets(plan.actions);
  job.completedBreaks = plan.actions.flatMap((a, i) => (a.kind === "pause" && i < job.currentAction && a.breakIndex != null ? [a.breakIndex] : []));
  job.breaksVersion = (job.breaksVersion ?? 0) + 1;
  job.editableFrom = editableFrom(plan.actions, job.currentAction);
  return { ok: true, sooner };
}

/** A plan typed at its natural pace with breaks at the anchors ("Manual"): no other pauses, no total to fit */
export function withAnchors(plan: DripPlan, anchors: BreakAnchor[]): DripPlan {
  const { actions, breaks } = numberBreaks(placeAnchors(plan.actions, anchors));
  const totalMs = actions.reduce((s, a) => s + a.delayMs + (a.holdMs ?? 0), 0);
  return { ...plan, actions, breaks, totalMs, targetMs: undefined, fitsTarget: true, totalMinutes: Math.max(1, Math.ceil(totalMs / 60_000)) };
}
