import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDripPlan, type DripAction } from "./drip-engine";
import { applyBreakEdit, breakOffsets, editableFrom, numberBreaks, parseAnchors, placeAnchors, splitAction, withAnchors, type EditableJob } from "./breaks";

const TEXT = "The first piece slowly turned the voice into something else. It swelled, then grew rougher.\nThe second one was quieter and much more distant, almost like a siren far away.\nThe end.";
const typed = (actions: DripAction[]) => actions.filter((a) => a.kind !== "pause").map((a) => a.text).join("");
const total = (actions: DripAction[]) => actions.reduce((s, a) => s + a.delayMs + (a.holdMs ?? 0), 0);
/** Offset just after the word ending at `word`'s first occurrence, with the space after it */
const after = (word: string) => { const i = TEXT.indexOf(word) + word.length; return /\s/.test(TEXT[i]) ? i + 1 : i; };

test("breaks go exactly where asked, and the text, its typos and its typing time stay as they were", () => {
  for (const seed of [1, 2, 3, 7, 42]) {
    const plan = buildDripPlan(TEXT, { seed, breaks: [], typoFrequency: 1 });
    const anchors = [{ at: after("piece"), minutes: 33 }, { at: after("rougher."), minutes: 5 }, { at: after("siren"), minutes: 90 }];
    const placed = placeAnchors(plan.actions, anchors);
    assert.equal(typed(placed), TEXT, `seed ${seed}: same text`);
    assert.deepEqual(breakOffsets(placed), anchors.map((a) => a.at), `seed ${seed}: breaks at the anchors`);
    assert.equal(total(placed), total(plan.actions) + (33 + 5 + 90) * 60_000, `seed ${seed}: typing time unchanged`);
    // Every typo is still a typo of the text it types, and none was invented
    const typos = (actions: DripAction[]) => actions.filter((a) => a.kind === "typo").length;
    assert.ok(typos(placed) >= typos(plan.actions) - anchors.length, `seed ${seed}: at most one typo per split lost`);
    for (const a of placed) if (a.kind === "typo") assert.notEqual(a.typoChars, a.text.trimEnd());
  }
});

test("a typo split by a break stays with the part its slip is in", () => {
  const typo: DripAction = { kind: "typo", text: "slowly turned ", typoChars: "slowly tunred", delayMs: 1000, holdMs: 800, activity: "Fixing a typo" };
  const [a, b] = splitAction(typo, "slowly ".length);
  assert.deepEqual([a.kind, a.text, b.kind, b.text, b.typoChars], ["insert", "slowly ", "typo", "turned ", "tunred"]);
  assert.equal(a.delayMs + b.delayMs, 1000);
  const early: DripAction = { ...typo, typoChars: "slowyl turned" };
  const [c, d] = splitAction(early, "slowly ".length);
  assert.deepEqual([c.kind, c.typoChars, d.kind], ["typo", "slowyl", "insert"]);
  // A slip across the space (transposed with it) can't be kept on either side
  const across: DripAction = { ...typo, typoChars: "slowlyt urned" };
  assert.deepEqual(splitAction(across, "slowly ".length).map((x) => x.kind), ["insert", "insert"]);
});

test("Manual: the natural pace with only the chosen breaks, and adding a break moves the finish by its length", () => {
  const plain = buildDripPlan(TEXT, { seed: 5, breaks: [] });
  const manual = withAnchors(plain, [{ at: after("else."), minutes: 20 }]);
  assert.equal(manual.actions.filter((a) => a.kind === "pause").length, 1);
  assert.equal(manual.totalMs, plain.totalMs + 20 * 60_000);
  assert.deepEqual(manual.breaks, [20]);
  assert.equal(manual.actions.find((a) => a.kind === "pause")?.breakIndex, 0);
  assert.equal(withAnchors(plain, []).totalMs, plain.totalMs);
});

test("parseAnchors: after a word, before the end, distinct, within the limits", () => {
  const ok = parseAnchors([{ at: after("second"), minutes: 10 }, { at: after("first"), minutes: 33 }], TEXT);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.anchors.map((a) => a.minutes), [33, 10], "sorted by place");
  const bad = (raw: unknown, opts = {}) => { const r = parseAnchors(raw, TEXT, opts); return r.ok ? "ok" : r.error; };
  assert.match(bad([{ at: TEXT.indexOf("first") + 2, minutes: 5 }]), /after a word/);
  assert.match(bad([{ at: TEXT.length, minutes: 5 }]), /text typed after/);
  assert.match(bad([{ at: 0, minutes: 5 }]), /text typed after/);
  assert.match(bad([{ at: after("first"), minutes: 0 }]), /whole number of minutes/);
  assert.match(bad([{ at: after("first"), minutes: 1.5 }]), /whole number of minutes/);
  assert.match(bad([{ at: after("first"), minutes: 24 * 60 + 1 }]), /24 hours/);
  assert.match(bad([{ at: after("first"), minutes: 5 }, { at: after("first"), minutes: 6 }]), /same word/);
  assert.match(bad(Array.from({ length: 201 }, () => ({ at: after("first"), minutes: 1 }))), /At most 200/);
  assert.match(bad(Array.from({ length: 8 }, (_, i) => ({ at: after(["The", "first", "piece", "slowly", "turned", "the", "voice", "into"][i]), minutes: 24 * 60 }))), /7 days/);
  // The end of one addition is a place too, even without a space after it
  const end = TEXT.indexOf("first") + 2;
  assert.equal(bad([{ at: end, minutes: 5 }], { ends: [end] }), "ok");
});

/** A plan with breaks at the anchors and a job on action `current` */
function running(anchors: { at: number; minutes: number }[], current: number, extra: Partial<EditableJob> = {}) {
  const base = withAnchors(buildDripPlan(TEXT, { seed: 9, breaks: [] }), anchors);
  const plan = { actions: base.actions, breaks: base.breaks, totalMs: base.totalMs };
  const job: EditableJob = { status: "running", currentAction: current, totalActions: plan.actions.length, breaks: plan.breaks, breakAt: breakOffsets(plan.actions), completedBreaks: [], breaksVersion: 0, ...extra };
  return { plan, job };
}

test("a live change only touches what comes after the action being typed", () => {
  const { plan, job } = running([{ at: after("piece"), minutes: 10 }, { at: after("second"), minutes: 10 }], 6);
  const before = plan.actions.slice(0, 7).map((a) => JSON.stringify(a));
  const from = editableFrom(plan.actions, 6);
  const res = applyBreakEdit(plan, job, { breaks: [{ at: after("siren"), minutes: 45 }], version: 0 }, 0);
  assert.ok(res.ok);
  assert.deepEqual(plan.actions.slice(0, 7).map((a) => JSON.stringify(a)), before, "the past and the current action are untouched");
  assert.equal(typed(plan.actions), TEXT);
  // The first break (already passed) stays; the second is replaced by the new one
  assert.deepEqual(job.breakAt, [after("piece"), after("siren")]);
  assert.deepEqual(job.breaks, [10, 45]);
  assert.deepEqual(job.completedBreaks, [0]);
  assert.equal(job.breaksVersion, 1);
  assert.equal(job.totalActions, plan.actions.length);
  assert.ok(from > 0 && job.editableFrom === from);
  // Too late, or made against another version: refused
  const late = applyBreakEdit(plan, job, { breaks: [{ at: after("The") , minutes: 5 }] }, 0);
  assert.ok(!late.ok && late.conflict);
  const stale = applyBreakEdit(plan, job, { breaks: [], version: 0 }, 0);
  assert.ok(!stale.ok && stale.conflict);
  // Left for the worker, a change drops the breaks typing has passed since and keeps the rest
  const lenient = applyBreakEdit(plan, job, { breaks: [{ at: after("The"), minutes: 5 }, { at: after("quieter"), minutes: 7 }] }, 0, { lenient: true });
  assert.ok(lenient.ok);
  assert.deepEqual(job.breakAt, [after("piece"), after("quieter")]);
});

test("the break the sync is on can be ended now or given another length", () => {
  const anchors = [{ at: after("piece"), minutes: 30 }];
  const placed = numberBreaks(placeAnchors(buildDripPlan(TEXT, { seed: 9, breaks: [] }).actions, anchors)).actions;
  const onBreak = placed.findIndex((a) => a.kind === "pause");
  const startedAt = 1_000_000;
  {
    const { plan, job } = running(anchors, onBreak, { nextActionAt: startedAt + 30 * 60_000 });
    const res = applyBreakEdit(plan, job, { breaks: [], current: { end: true } }, startedAt + 5 * 60_000);
    assert.ok(res.ok && res.sooner);
    assert.equal(job.nextActionAt, startedAt + 5 * 60_000);
  }
  {
    const { plan, job } = running(anchors, onBreak, { nextActionAt: startedAt + 30 * 60_000 });
    const res = applyBreakEdit(plan, job, { breaks: [], current: { minutes: 45 } }, startedAt + 5 * 60_000);
    assert.ok(res.ok && !res.sooner);
    assert.equal(job.nextActionAt, startedAt + 45 * 60_000);
    assert.deepEqual(job.breaks, [45]);
  }
  {
    // Paused 10 minutes into it: what is left of it changes with it
    const { plan, job } = running(anchors, onBreak, { status: "paused", waitLeftMs: 20 * 60_000 });
    assert.ok(applyBreakEdit(plan, job, { breaks: [], current: { minutes: 15 } }, 0).ok);
    assert.equal(job.waitLeftMs, 5 * 60_000);
  }
  {
    // A new break can't go right where the current one is
    const { plan, job } = running(anchors, onBreak, { nextActionAt: startedAt });
    const res = applyBreakEdit(plan, job, { breaks: [{ at: after("piece"), minutes: 5 }] }, startedAt);
    assert.ok(!res.ok);
  }
  {
    const { plan, job } = running(anchors, 0);
    const res = applyBreakEdit(plan, job, { breaks: [], current: { end: true } }, 0);
    assert.ok(!res.ok && /isn't on a break/.test(res.error));
  }
});
