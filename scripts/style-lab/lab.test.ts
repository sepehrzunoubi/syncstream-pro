import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSamples, splitDataset, leaveOneOut, type Dataset } from "./dataset";
import { lcsRatio, meanScore, scoreReply, tokenF1 } from "./score";
import { extractFingerprint } from "../../src/lib/fingerprint";
import { CANDIDATES, maxOutputTokens, revisionMessages } from "../../src/lib/style-candidates";

const LINES = [
  '{"id":"a","input":"The committee reviewed the proposal; however, it was rejected because the budget was too large.","output":"The committee read the proposal. They rejected it. The budget was too big."}',
  '{"id":"b","input":"It is recommended that users update their passwords regularly, utilizing letters, numbers and symbols.","output":"Change your password often. Use letters, numbers and symbols."}',
  '{"id":"c","input":"The museum, which was founded in 1884, houses approximately 40,000 objects.","output":"The museum was founded in 1884. It holds about 40,000 objects."}',
  '{"id":"d","input":"Prior to installation, it is essential that all data be backed up, since the process overwrites the drive.","output":"Back up your data before you install. The process wipes the drive."}',
  '{"id":"e","input":"Although the policy was intended to reduce waiting times, data suggest it has had a negligible effect.","output":"The policy was meant to cut waiting times. It hasn\'t."}',
].join("\n");

test("samples.jsonl parses, and bad lines name themselves", () => {
  const samples = parseSamples(LINES + "\n\n");
  assert.equal(samples.length, 5);
  assert.equal(samples[0].id, "a");
  assert.throws(() => parseSamples('{"input":"x"}'), /line 1: needs string/);
  assert.throws(() => parseSamples('{"id":"a","input":"x","output":"y"}\n{"id":"a","input":"x","output":"y"}'), /duplicate id/);
  assert.throws(() => parseSamples("not json"), /not valid JSON/);
});

test("the split is deterministic and leave-one-out covers every sample", () => {
  const ds: Dataset = { dir: "", config: { name: "t", notes: "", holdout: 0.4, seed: 3 }, samples: parseSamples(LINES) };
  const a = splitDataset(ds);
  const b = splitDataset(ds);
  assert.deepEqual(a.test.map((s) => s.id), b.test.map((s) => s.id));
  assert.equal(a.test.length + a.train.length, 5);
  assert.equal(a.test.length, 2);
  assert.equal(splitDataset(ds, 1).test.length, 1);
  const loo = leaveOneOut(ds);
  assert.equal(loo.length, 5);
  assert.ok(loo.every((c) => c.train.length === 4 && !c.train.some((s) => s.id === c.sample.id)));
});

test("scores separate a faithful rewrite from a bad one", () => {
  const samples = parseSamples(LINES);
  const fp = extractFingerprint(samples)!;
  const input = "The report, which was filed in 2019 by Maria Chen, was ignored for months; nobody acted on it.";
  const reference = "Maria Chen filed the report in 2019. Nobody acted on it for months.";
  const exact = scoreReply(input, reference, reference, fp);
  const close = scoreReply(input, reference, "Maria Chen filed the report in 2019. For months nobody acted on it.", fp);
  const unfaithful = scoreReply(input, reference, "Someone filed a report a while ago. It was ignored for a long time, and that was regrettable; in the end, nothing changed at all.", fp);
  const empty = scoreReply(input, reference, "", fp);
  assert.ok(exact.total > close.total && close.total > unfaithful.total && unfaithful.total > empty.total, `${exact.total} > ${close.total} > ${unfaithful.total} > ${empty.total}`);
  assert.equal(exact.tokenF1, 1);
  assert.equal(lcsRatio(reference, reference), 1);
  assert.ok(tokenF1(reference, "completely different words here") < 0.2);
  assert.ok(unfaithful.notes.some((n) => n.startsWith("dropped")));
  assert.equal(meanScore([exact, empty]).total, Math.round(((exact.total + 0) / 2) * 1000) / 1000);
});

test("every candidate builds a valid chat with the input last", () => {
  const samples = parseSamples(LINES);
  const fp = extractFingerprint(samples)!;
  const text = "Please note that the meeting has been rescheduled.";
  for (const c of CANDIDATES) {
    const messages = c.build({ fingerprint: fp, rules: [], exemplars: samples.slice(0, c.exemplars), notes: "Keep British spelling.", text });
    assert.equal(messages[0].role, "system", c.id);
    assert.equal(messages[messages.length - 1].role, "user", c.id);
    assert.ok(messages[messages.length - 1].content.includes(text), c.id);
    assert.ok(messages[0].content.includes("British"), `${c.id} carries the notes`);
    for (let i = 1; i < messages.length - 1; i++) assert.notEqual(messages[i].role, "system", c.id);
  }
  assert.ok(maxOutputTokens(text, fp) >= 256);
  const revised = revisionMessages([{ role: "user", content: text }], "draft", ["Shorten sentences."]);
  assert.equal(revised.length, 3);
  assert.match(revised[2].content, /Shorten sentences/);
});
