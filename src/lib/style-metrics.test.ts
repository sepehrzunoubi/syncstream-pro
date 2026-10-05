import { test } from "node:test";
import assert from "node:assert/strict";
import {
  corpusReport, countClauses, diffWords, namesAndNumbers, renderMetrics, splitSentences, summarizeEdits, textMetrics, transitionMetrics, wordsOf,
} from "./style-metrics";

test("sentences split on terminal punctuation and line breaks, not on abbreviations", () => {
  assert.deepEqual(splitSentences("One. Two! Three?\nFour"), ["One.", "Two!", "Three?", "Four"]);
  assert.deepEqual(splitSentences('He said "Go." Then left.'), ['He said "Go."', "Then left."]);
  assert.deepEqual(splitSentences("Use tools, e.g. hammers, daily. Done."), ["Use tools, e.g. hammers, daily.", "Done."]);
  assert.deepEqual(splitSentences("...\n\n"), []);
});

test("words keep contractions and hyphens", () => {
  assert.deepEqual(wordsOf("Don't re-use 3 items, OK?"), ["Don't", "re-use", "3", "items", "OK"]);
});

test("clauses count punctuation and conjunction boundaries", () => {
  assert.equal(countClauses("The cat sat."), 1);
  assert.equal(countClauses("The cat sat, and the dog barked."), 2);
  assert.equal(countClauses("The cat sat; the dog barked because it was bored."), 3);
});

test("transitions: placement and short-word guard", () => {
  const t = transitionMetrics(["However, it rained.", "It was, in fact, dry.", "We also went home.", "Also, we ate."]);
  assert.equal(t.initial, 2);
  assert.equal(t.medial, 1);
  assert.equal(t.count, 3);
  assert.deepEqual(t.phrases.map((p) => p.phrase), ["also", "however", "in fact"]);
});

test("text metrics on a small passage", () => {
  const m = textMetrics("Short one. This is a much longer sentence that keeps going on and on, with several clauses, until it finally reaches well over twenty-five words in total length.");
  assert.equal(m.sentences, 2);
  assert.equal(m.shortSentences, 1);
  assert.equal(m.longSentences, 1);
  assert.equal(m.pacingRatio, 1);
  assert.equal(m.punctuation.commas, 2);
  assert.ok(m.wordsPerClause > 1);
  assert.equal(textMetrics("").sentences, 0);
});

test("word diff finds substitutions, insertions and deletions", () => {
  const ops = diffWords("The quick brown fox jumps.", "The swift brown fox jumps high.");
  assert.deepEqual(ops.map((o) => [o.type, o.text.trim()]), [
    ["equal", "The"], ["delete", "quick"], ["insert", "swift"], ["equal", "brown fox jumps"], ["insert", "high"], ["equal", "."],
  ]);
  const s = summarizeEdits("The quick brown fox jumps.", "The swift brown fox jumps high.", ops);
  assert.equal(s.substitutions, 1);
  assert.equal(s.inserted, 2);
  assert.equal(s.deleted, 1);
  assert.equal(s.kept, 4);
  assert.equal(s.retention, 0.8);
});

test("names and numbers must survive a rewrite", () => {
  assert.deepEqual(namesAndNumbers("In 2019 Maria Chen visited Lisbon. Lisbon was warm."), ["2019", "Maria", "Chen", "Lisbon"]);
  const s = summarizeEdits("In 2019 Maria Chen visited Lisbon.", "Maria Chen went to Porto in 2019.");
  assert.deepEqual(s.preservedNames, ["2019", "Maria", "Chen"]);
  assert.deepEqual(s.droppedNames, ["Lisbon"]);
});

test("corpus report averages pairs and renders as text", () => {
  const report = corpusReport([
    { input: "It rained. However, we went out and had a great time.", output: "It rained, but we went out anyway. We had a great time." },
    { input: "   ", output: "ignored" },
  ]);
  assert.ok(report);
  assert.equal(report.pairs, 1);
  assert.equal(report.input.transitions.count, 1);
  assert.equal(report.output.transitions.count, 0);
  assert.ok(report.lengthRatio > 1);
  const text = renderMetrics(report);
  assert.match(text, /Pairs measured: 1/);
  assert.match(text, /however \(1\)/);
  assert.equal(corpusReport([]), null);
});
