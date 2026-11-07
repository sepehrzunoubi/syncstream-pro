import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDripPlan } from "./drip-engine";
import { MAX_STORED_JSON, packValue, storedSize, unpackValue, type SyncPlan } from "./sync-store";

const plan = (text: string): SyncPlan => {
  const p = buildDripPlan(text, { typoFrequency: 1, seed: 4 });
  return { id: "sync_x", userId: "u", documentId: "d", actions: p.actions, totalChars: p.totalChars, totalMs: p.totalMs, breaks: p.breaks } as SyncPlan;
};

test("a plan is stored packed and read back exactly; one stored before packing still reads", () => {
  const p = plan("Héllo, wörld — 你好 🙂\nA second line.\n".repeat(200));
  // As Upstash keeps it: the value's JSON, parsed again on read
  const stored = JSON.parse(JSON.stringify(packValue(p)));
  assert.deepEqual(unpackValue<SyncPlan>(stored), p);
  assert.deepEqual(unpackValue<SyncPlan>(JSON.parse(JSON.stringify(p))), p, "a plain plan (stored before packing)");
  assert.equal(unpackValue(null), null);
  // A plain value that happens to have a `z` beside other fields isn't taken for a packed one
  assert.deepEqual(unpackValue({ z: "abc", other: 1 }), { z: "abc", other: 1 });
});

test("packing fits a long sync's plan in one Redis request", () => {
  const words = "participants who slept recalled more of the word pairs than those who stayed awake through the night".split(" ");
  let text = "";
  for (let k = 0; text.length < 500_000; k++) text += words.map((_, i) => words[(i * 7 + k * 3) % words.length]).join(" ") + ".\n";
  const p = plan(text);
  assert.ok(JSON.stringify(p).length > MAX_STORED_JSON, "more than Redis takes unpacked");
  assert.ok(storedSize(p) < MAX_STORED_JSON / 4, `${storedSize(p)} packed`);
});
