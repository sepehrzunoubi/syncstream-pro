import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRules, extractFingerprint, matchFingerprint, mineSubstitutions, renderFingerprint, selectExemplars, sentenceOpeners, sideStats, vocabularyShift } from "./fingerprint";

const SAMPLES = [
  { input: "The committee reviewed the proposal in detail; however, it was ultimately rejected because the budget was considered too large and the timeline was deemed unrealistic.", output: "The committee read the proposal closely. They rejected it. The budget was too big, and the timeline couldn't work." },
  { input: "It is generally recommended that users update their passwords on a regular basis, utilizing a combination of letters, numbers and symbols, in order to minimize the likelihood of unauthorized access.", output: "Change your password often. Use letters, numbers and symbols. That makes it harder for someone to break in." },
  { input: "The museum, which was founded in 1884 by a group of local merchants, houses approximately 40,000 objects, a considerable number of which have never been displayed.", output: "A group of local merchants founded the museum in 1884. It holds about 40,000 objects. Many have never been shown." },
  { input: "Prior to initiating the installation procedure, it is essential that all existing data be backed up, since the process will overwrite the contents of the primary drive; this is irreversible.", output: "Back up your data before you install. The process wipes the main drive. It can't be undone." },
];

test("side stats measure pacing, clauses and voice", () => {
  const s = sideStats(["Short one. This is a second sentence that is somewhat longer, with a clause. Don't stop!"]);
  assert.equal(s.sentences, 3);
  assert.equal(s.histogram.length, 4);
  assert.ok(Math.abs(s.histogram.reduce((a, b) => a + b, 0) - 1) < 0.02);
  assert.ok(s.contractions > 0);
  assert.ok(s.commasPerSentence > 0);
  assert.equal(s.exclamations, 0.33);
  assert.equal(sideStats([""]).sentences, 0);
});

test("the fingerprint captures the shift from long formal inputs to short plain outputs", () => {
  const fp = extractFingerprint(SAMPLES)!;
  assert.equal(fp.samples, 4);
  assert.ok(fp.lengthRatio < 1, "outputs are shorter");
  assert.ok(fp.sentenceRatio > 1.5, "outputs split sentences");
  assert.ok(fp.output.meanSentenceWords < fp.input.meanSentenceWords);
  assert.ok(fp.output.semicolons === 0 && fp.input.semicolons > 0);
  assert.ok(fp.output.contractions > fp.input.contractions);
  assert.ok(fp.preservation.numbersKept >= 0.99, "numbers survive");
  assert.equal(extractFingerprint([{ input: " ", output: "x" }]), null);
});

test("vocabulary shift, substitutions and openers come from the data", () => {
  const many = [...SAMPLES, ...SAMPLES];
  const { preferred, avoided } = vocabularyShift(many);
  assert.ok(avoided.some((w) => w.word === "utilizing" || w.word === "approximately" || w.word === "considerable"));
  assert.ok(preferred.every((w) => w.outputCount >= 2));
  const subs = mineSubstitutions([{ input: "We utilize the tool to utilize time. Bad; however, fine.", output: "We use the tool to use time. Bad. Still, fine." }]);
  assert.deepEqual(subs, [{ from: "utilize", to: "use", count: 2 }], "punctuation-laden restructurings are not substitutions");
  const openers = sentenceOpeners(["The cat sat. The cat ran. It rained."]);
  assert.equal(openers[0].text, "The cat");
});

test("rules are explicit, evidenced, and tied to the measured shift", () => {
  const fp = extractFingerprint(SAMPLES)!;
  const rules = deriveRules(fp);
  const ids = rules.map((r) => r.id);
  assert.ok(ids.includes("length-shorter"));
  assert.ok(ids.includes("pacing-split"));
  assert.ok(ids.includes("punct-no-semicolons"));
  assert.ok(ids.includes("preserve-facts"));
  for (const r of rules) { assert.ok(r.text.length > 10); assert.ok(r.evidence.length > 10); }
  const text = renderFingerprint(fp, rules);
  assert.match(text, /Samples: 4/);
  assert.match(text, /Rules:/);
});

test("match score rewards outputs that follow the style and explains misses", () => {
  const fp = extractFingerprint(SAMPLES)!;
  const input = "Although the new policy was intended to reduce waiting times, preliminary data from the first three months suggest that it has had a negligible effect; in some clinics waiting times have actually increased.";
  const good = matchFingerprint(fp, input, "The new policy was meant to cut waiting times. Three months in, it hasn't. Some clinics are slower.");
  const bad = matchFingerprint(fp, input, "Although the new policy was intended to reduce waiting times, preliminary data from the first three months suggest that it has had a negligible effect; in some clinics waiting times have actually increased, which is unfortunate, and the administration has not yet responded.");
  assert.ok(good.score > bad.score, `good ${good.score} should beat bad ${bad.score}`);
  assert.ok(bad.deviations.some((d) => /words per sentence/i.test(d.metric)));
  assert.ok(bad.deviations[0].hint.length > 0);
});

test("exemplars are the closest samples in vocabulary and length", () => {
  const picked = selectExemplars(SAMPLES, "Before you begin the installation, back up all existing data; the primary drive will be overwritten.", 2);
  assert.equal(picked.length, 2);
  assert.ok(picked[0].input.includes("installation"));
  assert.deepEqual(selectExemplars([], "x", 2), []);
});
