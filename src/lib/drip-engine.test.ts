import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDripPlan, remainingMs } from "./drip-engine";

const SAMPLE = `Pauline Oliveros, Applebox Double

The first thing I noticed in Applebox was how something as basic as a wooden box could create such a weird range of sounds. I heard dry scratching followed by what I can only call "sharp" metallic vibrations! At certain points it almost sounded like random objects shaking around.

Musica Elettronica Viva, 1967 Berlin Concert

This one was interesting because the voice slowly stopped sounding completely human to me. I could still hear where some of the vocal sounds were coming from, but the electronics stretched them into unstable pitches. It felt less like an effect and more like the voice becoming another instrument.`;

function reconstruct(plan: ReturnType<typeof buildDripPlan>): string {
  return plan.actions.filter((a) => a.kind !== "pause").map((a) => a.text).join("");
}

test("plan reproduces the text exactly", () => {
  for (const seed of [1, 2, 3, 99, 12345]) {
    const plan = buildDripPlan(SAMPLE, { seed });
    assert.equal(reconstruct(plan), SAMPLE);
    assert.equal(plan.totalChars, SAMPLE.length);
  }
  assert.equal(reconstruct(buildDripPlan("  leading and trailing  ", { seed: 5 })), "  leading and trailing  ");
  assert.equal(reconstruct(buildDripPlan("one", { seed: 5 })), "one");
  assert.deepEqual(buildDripPlan("", { seed: 5 }).actions, []);
});

test("same seed gives an identical plan, different seeds differ", () => {
  const a = buildDripPlan(SAMPLE, { seed: 42, targetMinutes: 45 });
  const b = buildDripPlan(SAMPLE, { seed: 42, targetMinutes: 45 });
  assert.deepEqual(a, b);
  const c = buildDripPlan(SAMPLE, { seed: 43, targetMinutes: 45 });
  assert.notDeepEqual(a.actions, c.actions);
});

test("typos are never identical to the correct text and chunks stay word-sized", () => {
  const plan = buildDripPlan(SAMPLE, { seed: 7, typoFrequency: 1 });
  const typos = plan.actions.filter((a) => a.kind === "typo");
  assert.ok(typos.length >= 5, `expected several typos, got ${typos.length}`);
  for (const t of typos) {
    assert.notEqual(t.typoChars, t.text.trimEnd());
    assert.ok((t.holdMs ?? 0) >= 400);
  }
  for (const a of plan.actions) {
    if (a.kind === "pause") continue;
    assert.ok(a.text.trim().split(/\s+/).length <= 3, `chunk too big: ${JSON.stringify(a.text)}`);
  }
});

test("first action fires immediately and every later action waits", () => {
  const plan = buildDripPlan(SAMPLE, { seed: 11 });
  assert.equal(plan.actions[0].delayMs, 0);
  for (const a of plan.actions.slice(1)) assert.ok(a.delayMs >= 400);
});

test("natural pace lands in a sensible range for ~120 words", () => {
  const plan = buildDripPlan(SAMPLE, { seed: 3, breaks: [] });
  const minutes = plan.totalMs / 60_000;
  assert.ok(minutes > 4 && minutes < 25, `natural pace was ${minutes.toFixed(1)} min`);
  assert.equal(plan.breaks.length, 0);
});

test("target duration is honoured within 3% when it is reachable", () => {
  for (const target of [30, 60, 240, 1440]) {
    const plan = buildDripPlan(SAMPLE, { seed: 9, targetMinutes: target, breaks: "auto" });
    const ratio = plan.totalMs / (target * 60_000);
    assert.ok(Math.abs(ratio - 1) < 0.03, `target ${target}m produced ${(plan.totalMs / 60_000).toFixed(1)}m`);
    assert.equal(plan.fitsTarget, true);
    assert.equal(reconstruct(plan), SAMPLE);
    assert.equal(remainingMs(plan.actions, 0), plan.totalMs);
  }
});

test("a long target adds away-gaps instead of stretching keystrokes", () => {
  const plan = buildDripPlan(SAMPLE, { seed: 9, targetMinutes: 1440, breaks: "auto" });
  const typingDelays = plan.actions.filter((a) => a.kind !== "pause").map((a) => a.delayMs);
  assert.ok(Math.max(...typingDelays) < 120_000, "keystroke delays should stay short");
  assert.ok(plan.breaks.length >= 5, "long targets should add several gaps");
});

test("a very short target sheds automatic breaks and types faster, but never faster than the floor", () => {
  const plan = buildDripPlan(SAMPLE, { seed: 4, targetMinutes: 2, breaks: "auto" });
  assert.equal(plan.breaks.length, 0);
  const natural = buildDripPlan(SAMPLE, { seed: 4, breaks: [] });
  assert.ok(plan.totalMs < natural.totalMs);
  assert.ok(plan.totalMs > natural.totalMs * 0.35);
});

test("custom breaks are used verbatim, in order, and never after the last chunk", () => {
  const plan = buildDripPlan(SAMPLE, { seed: 8, breaks: [15, 4, 30] });
  assert.deepEqual(plan.breaks, [15, 4, 30]);
  const pauses = plan.actions.filter((a) => a.kind === "pause");
  assert.equal(pauses.length, 3);
  assert.deepEqual(pauses.map((p) => p.delayMs), [15, 4, 30].map((m) => m * 60_000));
  assert.notEqual(plan.actions[plan.actions.length - 1].kind, "pause");
  assert.deepEqual(pauses.map((p) => p.breakIndex), [0, 1, 2]);
});

test("huge inputs keep a bounded action count", () => {
  const big = Array.from({ length: 4000 }, (_, i) => `word${i}${i % 17 === 0 ? "." : ""}`).join(" ");
  const plan = buildDripPlan(big, { seed: 1 });
  assert.ok(plan.actions.length < 3000, `too many actions: ${plan.actions.length}`);
  assert.equal(reconstruct(plan), big);
});

test("with breaks set to None, a long target never invents breaks and reports the shortfall", () => {
  const plan = buildDripPlan(SAMPLE, { seed: 9, targetMinutes: 90, breaks: [] });
  assert.equal(plan.breaks.length, 0);
  assert.equal(plan.actions.filter((a) => a.kind === "pause").length, 0);
  assert.equal(plan.fitsTarget, false);
  assert.equal(plan.targetMs, 90 * 60_000);
  const natural = buildDripPlan(SAMPLE, { seed: 9, breaks: [] });
  assert.ok(plan.totalMs <= natural.totalMs * 1.6 + 1000, "stretches typing at most 1.6×");
  assert.ok(plan.totalMs < 60 * 60_000);
});

test("custom breaks are never extended with extra gaps", () => {
  const plan = buildDripPlan(SAMPLE, { seed: 9, targetMinutes: 240, breaks: [10, 20] });
  assert.deepEqual(plan.breaks, [10, 20]);
  assert.equal(plan.fitsTarget, false);
  const short = buildDripPlan(SAMPLE, { seed: 9, targetMinutes: 45, breaks: [10, 20] });
  assert.deepEqual(short.breaks, [10, 20]);
  assert.equal(short.fitsTarget, true);
});
