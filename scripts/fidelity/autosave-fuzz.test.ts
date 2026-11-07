/**
 * The autosave, fuzzed against the strict Docs stub (autosave-fuzz.ts): documents made in the stub,
 * edited with the editor's own transactions, saved round by round as the autosave saves them. For each
 * seed: Docs takes every save, the saves end, the autosave's idea of the document is Docs' own, and once
 * the additions are typed in as the sync types them the document reads as the page shows it.
 *
 * The seeds are fixed, so a run is the same every time. A few still differ in a way not fixed yet; each
 * is listed with how it differs (KNOWN), so any other difference, or a known one that changes, fails.
 * To hunt with more seeds: AUTOSAVE_FUZZ_SEEDS=1-5000 npx tsx --test scripts/fidelity/autosave-fuzz.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScenario, scenarioOf } from "./autosave-fuzz";

/**
 * Seeds that still differ, and how. None is a save Docs refuses or one that never ends:
 *  - lists: a checklist item made in the editor right after a Docs checklist is a list of its own on the
 *    page, while Docs adds it to the list before (createParagraphBullets joins a list of the same preset)
 *  - list labels: Backspace across two numbered items of different levels leaves Docs another glyph
 *  - blocks: a page break typed at the end of the body's last line, or in the line right before a table,
 *    comes with an empty line: insertPageBreak always brings a newline, and Docs keeps its own last
 *    newline and the one before a table
 */
const KNOWN: Record<number, string> = {
  26: "lists", 67: "list labels", 69: "lists", 133: "list labels", 138: "blocks", 140: "lists", 185: "lists",
  187: "lists", 265: "blocks", 276: "lists", 476: "lists", 735: "blocks",
};

/** Seeds whose scenarios found a bug that is fixed now (most also have a test of their own in direct-edits.test.ts) */
const FOUND = [25, 65, 81, 109, 131, 179, 213, 227, 245, 252, 260, 476, 509, 605, 614, 647, 672, 735, 835, 935];

function seeds(): number[] {
  const range = /^(\d+)-(\d+)$/.exec(process.env.AUTOSAVE_FUZZ_SEEDS ?? "");
  if (range) return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, k) => Number(range[1]) + k);
  return [...new Set([...Array.from({ length: 300 }, (_, k) => k + 1), ...FOUND])];
}

test("the autosave's saves of fuzzed edits are ones Docs takes, end, and leave the document as the page shows it", async () => {
  const hunting = !!process.env.AUTOSAVE_FUZZ_SEEDS;
  const failures: string[] = [];
  for (const seed of seeds()) {
    const r = await runScenario(scenarioOf(seed));
    const kind = r.failure?.kind ?? null;
    if (kind === (KNOWN[seed] ?? null)) continue;
    // Any difference that isn't the known one: a new one, a known one that changed, or one that's gone
    // (a hunt leaves out the log, for there may be many)
    if (!kind) failures.push(`seed ${seed} no longer differs (${KNOWN[seed]}): take it off KNOWN`);
    else failures.push(`seed ${seed}${KNOWN[seed] ? ` (known: ${KNOWN[seed]})` : ""}: ${r.failure!.message.slice(0, 400)}${hunting ? "" : `\n${r.log.join("\n").slice(-3000)}`}`);
  }
  assert.deepEqual(failures, []);
});
