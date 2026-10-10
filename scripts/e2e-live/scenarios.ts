/**
 * The three live scenarios, written against the E2EDocs interface so they
 * run unchanged against Google and against the stub.
 *
 *  A. Typing: additions are built the way the editor builds them, turned
 *     into a job exactly as POST /api/sync/start does, and typed by the real
 *     runner (in-process, in-memory store, virtual clock). The finished
 *     document is read back and compared with what the editor meant.
 *  B. Direct edits: the document is imported, changed as a user would
 *     (split a heading, un-bullet an item, edit mid-sentence, delete the
 *     last paragraph, insert a table) and saved with directEdits(), with
 *     the editor's read-back after table structure changes.
 *  C. Collaborator mid-sync: another writer inserts a paragraph at the top
 *     between two of the runner's batches; the sync must still land in
 *     the right place.
 */

import { importDoc } from "../../src/lib/doc-import";
import { additions, adoptStructure, directEdits, PENDING_MARK } from "../../src/lib/doc-model";
import { buildDripPlan } from "../../src/lib/drip-engine";
import { snapshotOf } from "../../src/lib/google";
import { plainFormat, type EditorNode } from "../../src/lib/rich-text";
import { buildSyncRecords, parseSegments, segmentBoundaries, spotsFor } from "../../src/lib/sync-plan";
import { runJobWindow, type RunnerDeps, type RunResult } from "../../src/lib/sync-runner";
import { createMemoryStore } from "../../src/lib/sync-store";
import { FastClock, realSleep } from "./clock";
import { compareShapes, diffShapes, shapeOf, type Report } from "./compare";
import { docUrl, runnerDocsApi, type E2EDocs } from "./docs-client";

export interface E2EOptions {
  /** Plan seed, so a failing run can be repeated exactly */
  seed?: number;
  typoFrequency?: number;
  /** Keep the document afterwards (it is always kept when something failed) */
  keep?: boolean;
  /** Scenario C: the collaborator writes after this many runner writes */
  collaboratorAfterWrite?: number;
  title?: string;
  log?: (line: string) => void;
  /** Runner chatter (every write, relocation, retry) */
  verbose?: boolean;
  /** Real waiting, used only when Google asks for a retry; tests pass a no-op */
  sleep?: (ms: number) => Promise<void>;
}

export interface E2EResult {
  documentId: string;
  url: string;
  ok: boolean;
  deleted: boolean;
}

// ── Editor JSON builders ────────────────────────────────────────────────────

const ADD = { type: PENDING_MARK };
const text = (t: string, marks: NonNullable<EditorNode["marks"]> = []): EditorNode => (marks.length ? { type: "text", text: t, marks } : { type: "text", text: t });
const pending = (node: EditorNode): EditorNode => ({ ...node, marks: [...(node.marks ?? []), ADD] });
const PARA_ATTRS = { styleName: "normal", textAlign: null, indent: 0, firstLine: false, lineSpacing: 115, list: null, level: null, preset: null, indentEnd: null, box: null, keep: null, borders: null, shading: null };
const para = (attrs: Record<string, unknown>, ...content: EditorNode[]): EditorNode => ({ type: "paragraph", attrs: { ...PARA_ATTRS, ...attrs }, content });
/** A paragraph the user typed: every piece glows */
const typed = (attrs: Record<string, unknown>, ...content: EditorNode[]): EditorNode => para(attrs, ...content.map(pending));
const doc = (content: EditorNode[]): EditorNode => ({ type: "doc", content });

const plainOf = (node: EditorNode): string => (node.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : c.type === "pageBreak" ? "\u000C" : "")).join("");

/** Adjacent text nodes with the same marks as one node, so text can be replaced across Docs' run boundaries */
function mergeText(node: EditorNode): EditorNode {
  const out: EditorNode[] = [];
  for (const c of node.content ?? []) {
    const last = out[out.length - 1];
    if (c.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(c.marks ?? [])) last.text = (last.text ?? "") + (c.text ?? "");
    else out.push({ ...c });
  }
  return { ...node, content: out };
}

function replaceInParagraph(node: EditorNode, from: string, to: string): EditorNode {
  const merged = mergeText(node);
  const hit = (merged.content ?? []).find((c) => c.type === "text" && (c.text ?? "").includes(from));
  if (!hit) throw new Error(`"${from}" is not in one run of "${plainOf(node)}"`);
  hit.text = hit.text!.replace(from, to);
  return merged;
}

/** Split a paragraph into two at the first occurrence of `at` (which is dropped), both keeping the paragraph's attributes */
function splitParagraph(node: EditorNode, at: string): [EditorNode, EditorNode] {
  const merged = mergeText(node);
  const content = merged.content ?? [];
  const k = content.findIndex((c) => c.type === "text" && (c.text ?? "").includes(at));
  if (k < 0) throw new Error(`"${at}" is not in "${plainOf(node)}"`);
  const piece = content[k];
  const idx = piece.text!.indexOf(at);
  const head = { ...piece, text: piece.text!.slice(0, idx) };
  const tail = { ...piece, text: piece.text!.slice(idx + at.length) };
  const first = [...content.slice(0, k), ...(head.text ? [head] : [])];
  const second = [...(tail.text ? [tail] : []), ...content.slice(k + 1)];
  return [{ ...merged, content: first }, { ...merged, content: second }];
}

const findParagraph = (nodes: EditorNode[], contains: string): number => {
  const k = nodes.findIndex((n) => n.type === "paragraph" && plainOf(n).includes(contains));
  if (k < 0) throw new Error(`No paragraph contains "${contains}"`);
  return k;
};

// ── The runner, driven in-process ───────────────────────────────────────────

interface Delivery { generation: number; delaySec: number; tick?: number }

/**
 * Run a job to its end the way QStash and the worker do, with the queue
 * replaced by a loop: each hand-off advances the virtual clock by the delay
 * the runner asked for. Only a retry after a Google error waits for real.
 */
async function driveJob(jobId: string, deps: RunnerDeps, clock: FastClock, queue: Delivery[], sleep: (ms: number) => Promise<void>, log: (l: string) => void): Promise<RunResult> {
  let msg: Delivery = { generation: 0, delaySec: 0 };
  for (let step = 0; step < 200_000; step++) {
    const r = await runJobWindow(jobId, msg.generation, { ...deps, tick: msg.tick });
    if (r.outcome === "done" || r.outcome === "error" || r.outcome === "cancelled" || r.outcome === "paused" || r.outcome === "not_found" || r.outcome === "already_finished") return r;
    const next = queue.shift();
    if (!next) throw new Error(`the runner returned "${r.outcome}" without queueing a delivery`);
    if (r.outcome === "retry") {
      log(`Google asked for patience: ${r.job?.activity ?? "retry"}; waiting ${next.delaySec}s`);
      await sleep(Math.min(next.delaySec, 120) * 1000);
    }
    clock.advance(next.delaySec * 1000);
    msg = next;
  }
  throw new Error("the runner did not finish within 200000 deliveries");
}

interface SyncRun {
  outcome: RunResult["outcome"];
  charsSent: number;
  totalChars: number;
  status: string;
  error?: string;
}

/** Build the job exactly as POST /api/sync/start does, then run it through the runner */
async function typeAdditions(docs: E2EDocs, documentId: string, base: EditorNode, target: EditorNode, opts: E2EOptions, hooks: { afterWrite?: (n: number) => Promise<void> }, report: Report, label: string): Promise<SyncRun | undefined> {
  const log = opts.log ?? (() => {});
  const { segments, text: source, boundaries } = additions(base, target);
  report.check(`${label}: the editor finds additions to type`, segments.length > 0, segments.length ? undefined : "no glowing text in the target");
  if (!segments.length) return undefined;
  // What the client posts, validated as the server validates it
  const posted = JSON.parse(JSON.stringify(segments.map(({ at, mode, text: t, format }) => ({ at, mode, text: t, format }))));
  const parsed = parseSegments(posted);
  if (!parsed.ok) {
    report.check(`${label}: the server accepts the additions`, false, parsed.error);
    return undefined;
  }
  report.check(`${label}: the server accepts the additions`, true);
  const text = parsed.segments.map((s) => s.text).join("");
  report.check(`${label}: segment texts and boundaries agree`, text === source && JSON.stringify(segmentBoundaries(parsed.segments)) === JSON.stringify(boundaries));
  const plan = buildDripPlan(text, { seed: opts.seed ?? 7, breaks: [1], typoFrequency: opts.typoFrequency ?? 0.7, ...(boundaries.length ? { boundaries } : {}) });
  const typos = plan.actions.filter((a) => a.kind === "typo").length;
  const pauses = plan.actions.filter((a) => a.kind === "pause").length;
  report.info(`${segments.length} segment(s), ${text.length} characters, ${plan.actions.length} actions (${typos} typos, ${pauses} break), ${Math.round(plan.totalMs / 1000)}s of plan time, seed ${plan.seed}`);

  const current = await docs.get(documentId);
  const snap = snapshotOf(current);
  const spots = spotsFor(current, snap.chars, parsed.segments);
  if (!report.check(`${label}: every addition has its paragraph in the document`, !!spots)) return undefined;

  const clock = new FastClock();
  const store = createMemoryStore(clock.now);
  const now = clock.now();
  const jobId = `e2e_${now.toString(36)}`;
  const { plan: syncPlan, job } = buildSyncRecords({
    id: jobId, userId: "e2e", documentId, documentName: opts.title ?? "e2e", plan, format: plainFormat(text), segments: parsed.segments, spots: spots!, now,
    accessToken: "e2e-access-token", refreshToken: "e2e-refresh-token", baselineWordCount: snap.wordCount,
  });
  await store.setPlan(syncPlan);
  await store.setJob(job);
  await store.addUserJob(job.userId, jobId);
  await store.addActiveJob(jobId);

  const queue: Delivery[] = [];
  const deps: RunnerDeps = {
    store,
    docs: runnerDocsApi(docs, hooks),
    refresh: async () => ({ access_token: "e2e-access-token" }),
    enqueue: async (_id, generation, delaySec, tick) => { queue.push({ generation, delaySec, tick }); },
    now: clock.now,
    sleep: clock.sleep,
    log: opts.verbose ? (m) => log(`  [runner] ${m}`) : undefined,
  };
  const started = Date.now();
  const result = await driveJob(jobId, deps, clock, queue, opts.sleep ?? realSleep, log);
  const finished = (await store.getJob(jobId))!;
  report.info(`runner finished with "${result.outcome}" after ${Math.round((Date.now() - started) / 1000)}s real time (${Math.round(clock.skippedMs / 1000)}s of waits skipped)`);
  report.check(`${label}: the sync completes`, result.outcome === "done", result.outcome === "done" ? undefined : `${result.outcome}: ${finished.error ?? finished.activity}`);
  report.check(`${label}: every character was sent`, finished.charsSent === text.length, `${finished.charsSent} of ${text.length}`);
  report.check(`${label}: the finished job keeps no credentials`, finished.status !== "done" || (finished.accessToken === "" && finished.refreshToken === ""));
  return { outcome: result.outcome, charsSent: finished.charsSent, totalChars: text.length, status: finished.status, error: finished.error };
}

// ── Scenarios ───────────────────────────────────────────────────────────────

const SEED_TEXT = "Intro paragraph that stays.\nClosing paragraph that also stays.";

async function scenarioTyping(docs: E2EDocs, documentId: string, opts: E2EOptions, report: Report): Promise<void> {
  report.section("A. Typing: headings, bold/italic, a link, nested lists, a page break");
  await docs.batchUpdate(documentId, [{ insertText: { location: { index: 1 }, text: SEED_TEXT } }]);
  const imported = importDoc(await docs.get(documentId));
  const base = doc(imported.nodes);
  report.check("A: the seeded document reads back", plainOf(imported.nodes[0]) === "Intro paragraph that stays." && imported.nodes.length === 2, imported.nodes.map(plainOf).join(" | "));

  const intro = imported.nodes[0];
  const closing = imported.nodes[1];
  const target = doc([
    typed({ styleName: "h1" }, text("SyncStream live check")),
    typed({}, text("This run types "), text("bold", [{ type: "bold" }]), text(", "), text("italic", [{ type: "italic" }]), text(" and a "), text("link", [{ type: "link", attrs: { href: "https://example.com/syncstream" } }]), text(" into Google Docs.")),
    typed({ styleName: "h2" }, text("A list with levels")),
    typed({ list: "bullet", level: 0 }, text("First point")),
    typed({ list: "bullet", level: 1 }, text("Nested point")),
    typed({ list: "bullet", level: 2 }, text("Deeper point")),
    typed({ list: "bullet", level: 0 }, text("Back to the top level")),
    typed({ list: "ordered", level: 0 }, text("Step one")),
    typed({ list: "ordered", level: 0 }, text("Step two")),
    { ...intro, content: [text("Intro paragraph"), pending(text(" (with words typed into the middle)")), text(" that stays.")] },
    typed({}, text("Page one ends here."), { type: "pageBreak" }),
    typed({}, text("Page two starts here.")),
    closing,
  ]);

  const run = await typeAdditions(docs, documentId, base, target, opts, {}, report, "A");
  if (!run) return;
  const after = importDoc(await docs.get(documentId));
  compareShapes(report, "A", shapeOf(target), shapeOf(after.nodes));
}

async function scenarioDirectEdits(docs: E2EDocs, documentId: string, opts: E2EOptions, report: Report): Promise<void> {
  report.section("B. Direct edits: split a heading, un-bullet an item, edit mid-sentence, delete the last paragraph, insert a table");
  let base = doc(importDoc(await docs.get(documentId)).nodes);
  const nodes = [...(base.content ?? [])];

  const h = findParagraph(nodes, "SyncStream live check");
  nodes.splice(h, 1, ...splitParagraph(nodes[h], " "));
  const item = findParagraph(nodes, "Back to the top level");
  const box = (nodes[item].attrs?.box ?? {}) as Record<string, unknown>;
  nodes[item] = { ...nodes[item], attrs: { ...nodes[item].attrs, list: null, level: null, listId: null, glyph: null, box: { start: 0, first: 0, above: box.above ?? null, below: box.below ?? null } } };
  const intro = findParagraph(nodes, "Intro paragraph");
  nodes[intro] = replaceInParagraph(nodes[intro], "that stays.", "that remains.");
  const last = nodes[nodes.length - 1];
  report.check("B: the last paragraph is the closing one", plainOf(last) === "Closing paragraph that also stays.", plainOf(last));
  nodes.pop();
  // A table between two plain paragraphs. Docs puts a newline before an inserted table, which makes an
  // empty paragraph the editor then removes by deleting the previous paragraph's newline instead (the
  // newline right before a table cannot be deleted), so the neighbours are kept alike in style.
  const cell = (t: string): EditorNode => ({ type: "tableCell", attrs: {}, content: [para({}, text(t))] });
  const table: EditorNode = { type: "table", attrs: {}, content: [{ type: "tableRow", attrs: {}, content: [cell("Row 1, A"), cell("Row 1, B")] }, { type: "tableRow", attrs: {}, content: [cell("Row 2, A"), cell("Row 2, B")] }] };
  nodes.splice(intro + 1, 0, table);
  let target = doc(nodes);

  const expected = shapeOf(target);
  let rounds = 0;
  let converged = false;
  for (; rounds < 6; rounds++) {
    const { requests, saved, structural } = directEdits(base, target);
    if (!requests.length) { converged = true; break; }
    report.info(`save round ${rounds + 1}: ${requests.length} request(s)${structural ? " (table structure first, then read back)" : ""}: ${requests.map((r) => Object.keys(r)[0]).join(", ")}`);
    try {
      await docs.batchUpdate(documentId, requests);
    } catch (err) {
      report.check(`B: save round ${rounds + 1} is accepted by Docs`, false, `${err instanceof Error ? err.message : String(err)} — requests: ${JSON.stringify(requests).slice(0, 600)}`);
      return;
    }
    if (structural) {
      const fresh = doc(importDoc(await docs.get(documentId)).nodes);
      target = adoptStructure(fresh, target);
      base = fresh;
    } else base = saved;
  }
  report.check("B: saving converges (nothing left to save)", converged, `${rounds} rounds and still changes`);
  const after = importDoc(await docs.get(documentId));
  compareShapes(report, "B", expected, shapeOf(after.nodes));
  if (converged) {
    const drift = diffShapes(shapeOf(base), shapeOf(after.nodes));
    report.check("B: the editor's saved copy matches Google", drift.length === 0, drift.slice(0, 4).join("; "));
  }
  if (opts.verbose) opts.log?.(`  document after B: ${JSON.stringify(shapeOf(after.nodes)).slice(0, 2000)}`);
}

async function scenarioCollaborator(docs: E2EDocs, documentId: string, opts: E2EOptions, report: Report): Promise<void> {
  report.section("C. Collaborator mid-sync: a paragraph is inserted at the top between two batches");
  const imported = importDoc(await docs.get(documentId));
  const base = doc(imported.nodes);
  const first = imported.nodes[0];
  if (first.type !== "paragraph") { report.check("C: the document starts with a paragraph", false, first.type ?? "?"); return; }
  const target = doc([
    ...imported.nodes,
    typed({}, text("Added while a collaborator edits above.")),
    typed({}, text("The sync must still land here, after everything else.")),
  ]);
  const afterWrite = opts.collaboratorAfterWrite ?? 2;
  let collaborated = false;
  const hooks = {
    afterWrite: async (n: number) => {
      if (collaborated || n !== afterWrite) return;
      collaborated = true;
      await docs.batchUpdate(documentId, [{ insertText: { location: { index: 1 }, text: "Collaborator note\n" } }]);
      report.info(`collaborator inserted a paragraph at the top after write ${n}`);
    },
  };
  const run = await typeAdditions(docs, documentId, base, target, opts, hooks, report, "C");
  report.check("C: the collaborator got a turn", collaborated, "the sync finished before the collaborator's turn; lower --collab-after");
  if (!run) return;
  // The inserted paragraph copies the style of the one it was typed into (Docs copies paragraph style on a newline)
  const expected = shapeOf(doc([{ ...first, content: [text("Collaborator note")] }, ...(target.content ?? [])]));
  const after = importDoc(await docs.get(documentId));
  compareShapes(report, "C", expected, shapeOf(after.nodes));
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function runE2E(docs: E2EDocs, report: Report, opts: E2EOptions = {}): Promise<E2EResult> {
  const log = opts.log ?? (() => {});
  const title = opts.title ?? `SyncStream e2e ${new Date().toISOString()}`;
  report.section("Setup");
  const documentId = await docs.create(title);
  const url = docUrl(documentId);
  report.check("a throwaway document was created", !!documentId);
  report.info(`${title} — ${url}`);
  let deleted = false;
  try {
    for (const scenario of [scenarioTyping, scenarioDirectEdits, scenarioCollaborator]) {
      try {
        await scenario(docs, documentId, opts, report);
      } catch (err) {
        report.check(`${scenario.name} ran to its end`, false, err instanceof Error ? err.stack ?? err.message : String(err));
      }
    }
  } finally {
    report.section("Teardown");
    report.info(`Docs API calls: ${docs.calls.reads} reads, ${docs.calls.writes} writes`);
    const ok = report.failed === 0;
    if (!opts.keep && ok) {
      try {
        await docs.remove(documentId);
        deleted = true;
        report.info("the test document was deleted");
      } catch (err) {
        report.check("the test document could be deleted", false, err instanceof Error ? err.message : String(err));
      }
    } else {
      log(ok ? `Kept as asked: ${url}` : `Kept for inspection: ${url}`);
    }
  }
  return { documentId, url, ok: report.failed === 0, deleted };
}
