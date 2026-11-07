/**
 * POST /api/compare/start's work, offline, through the code that calls Google (src/lib/google.ts)
 * over tabbed stub documents: both documents read again, the reference's missing tabs made (nested
 * where it has them), a blank "Tab 1" renamed, footnotes made with the reference's text, then one
 * sync typing the rest tab by tab. Each tab of LEFT must end up reading as the reference's does, and
 * a change to either document since the review must stop the start.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { google } from "googleapis";
import { compareDocs } from "../../src/lib/compare";
import { buildCompareJob, buildSides, CompareChangedError, CompareRefusedError, prepareCompare, rawTabs, type CompareGoogle } from "../../src/lib/compare-server";
import { MAX_STORED_JSON, storedSize } from "../../src/lib/sync-store";
import type { CompareBreak } from "../../src/lib/compare-types";
import { segmentCharTokens, tokenize } from "../../src/lib/doc-model";
import { batchUpdate, batchUpdateWithReplies, createTab, deleteRange, getDocSnapshot, getRawDocument, renameTab } from "../../src/lib/google";
import { applyControl, runJobWindow, type RunnerDeps } from "../../src/lib/sync-runner";
import { createMemoryStore } from "../../src/lib/sync-store";
import { openTab } from "../../src/lib/doc-tabs";
import { stubDocsClient, TabbedStub } from "../e2e-live/stub-tabs";

const docs = new Map<string, TabbedStub>();
(google as unknown as { docs: () => unknown }).docs = () => stubDocsClient(docs);

const g: CompareGoogle = {
  read: (id) => getRawDocument("t", id),
  batch: (id, requests, tabId, requiredRevisionId) => batchUpdateWithReplies("t", id, requests, { tabId, requiredRevisionId }) as Promise<Record<string, unknown>[]>,
  createTab: (id, props) => createTab("t", id, props),
  renameTab: (id, tabId, title) => renameTab("t", id, tabId, title),
  rehost: async (url) => url,
};

const plain = (d: TabbedStub, tab: string) => d.tab(tab).text().replace(/^\0/, "").replace(/\n$/, "");

function stub(id: string, title: string, tabs: { id: string; title: string; text?: string; children?: { id: string; title: string; text?: string }[] }[]) {
  const d = new TabbedStub(id, title, tabs.map((t) => ({ id: t.id, title: t.title, children: (t.children ?? []).map((c) => ({ id: c.id, title: c.title })) })));
  for (const t of [...tabs, ...tabs.flatMap((x) => x.children ?? [])]) if (t.text) d.tab(t.id).batchUpdate([{ insertText: { location: { index: 1 }, text: t.text } }]);
  docs.set(id, d);
  return d;
}

/** Start as the route does, then run the sync to the end */
async function start(leftId: string, rightId: string, opts: { breaks?: CompareBreak[]; skip?: string[]; typos?: number; seed?: number; tabMap?: unknown; google?: CompareGoogle; cancelAfter?: number; windowMs?: number } = {}) {
  const [l, r] = await Promise.all([getRawDocument("t", leftId), getRawDocument("t", rightId)]);
  const prepared = await prepareCompare(opts.google ?? g, { leftId, rightId, leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: opts.tabMap ?? {}, skip: opts.skip ?? [], breaks: opts.breaks ?? [] });
  let t = 1_000_000;
  const now = () => t;
  const built = buildCompareJob(prepared, { id: `job_${leftId}`, userId: "u", documentId: leftId, documentName: "", breaksMode: opts.breaks?.length ? "manual" : "none", targetMinutes: null, typoFrequency: opts.typos ?? 0, seed: opts.seed ?? 7, startInMinutes: 0, now: t, accessToken: "a", refreshToken: "r" });
  assert.ok(built.ok, built.ok ? "" : built.error);
  if (!built.ok) throw new Error("unreachable");
  const store = createMemoryStore(now);
  await store.setPlan(built.plan);
  await store.setJob(built.job);
  await store.addActiveJob(built.job.id);
  const queue: { generation: number; delaySec: number; tick?: number }[] = [];
  const deps: RunnerDeps = {
    store,
    docs: { snapshot: getDocSnapshot, batch: batchUpdate, deleteRange },
    refresh: async () => ({ access_token: "a" }),
    enqueue: async (_id, generation, delaySec, tick) => { queue.push({ generation, delaySec, tick }); },
    now,
    sleep: async (ms) => { t += ms; },
    ...(opts.windowMs != null ? { windowMs: opts.windowMs } : {}),
  };
  let msg: { generation: number; delaySec: number; tick?: number } = { generation: 0, delaySec: 0 };
  for (let n = 0; n < 50_000; n++) {
    if (opts.cancelAfter != null && n >= opts.cancelAfter) {
      // As the cancel route does: the job is over, whatever it had typed stays
      const job = await applyControl(store, (await store.getJob(built.job.id))!, "cancel", now);
      return { prepared, built, job };
    }
    const res = await runJobWindow(built.job.id, msg.generation, { ...deps, tick: msg.tick });
    if (res.outcome === "done" || res.outcome === "error") {
      const job = (await store.getJob(built.job.id))!;
      assert.equal(job.status, "done", job.error);
      return { prepared, built, job };
    }
    const next = queue.shift();
    if (!next) throw new Error(`the runner stopped with ${res.outcome}`);
    t += next.delaySec * 1000;
    msg = next;
  }
  throw new Error("the sync did not finish");
}

test("missing paragraphs typed into the tab LEFT has; the reference's other tabs made, nested as it has them, and typed", async () => {
  const left = stub("left-doc-0000001", "My notes", [{ id: "t.0", title: "Research", text: "Intro line\nClosing line" }]);
  const right = stub("right-doc-000001", "Reference", [
    { id: "t.0", title: "Research", text: "Intro line\nA middle paragraph, missing from mine.\nClosing line" },
    { id: "t.web", title: "Web", text: "Agent payments\nSecond line of web", children: [{ id: "t.kid", title: "Sources", text: "A source" }] },
  ]);
  const before = right.revisionId;
  const { job } = await start("left-doc-0000001", "right-doc-000001", { typos: 0.5, seed: 3 });
  assert.equal(right.revisionId, before, "the reference is never written to");
  assert.equal(plain(left, "t.0"), "Intro line\nA middle paragraph, missing from mine.\nClosing line");
  const tabs = rawTabs(await getRawDocument("t", "left-doc-0000001"));
  assert.deepEqual(tabs.map((x) => [x.title, x.level]), [["Research", 0], ["Web", 0], ["Sources", 1]]);
  const web = tabs.find((x) => x.title === "Web")!;
  const kid = tabs.find((x) => x.title === "Sources")!;
  assert.equal(kid.parentId, web.id, "nested under the tab made for its parent");
  assert.equal(plain(left, web.id), "Agent payments\nSecond line of web");
  assert.equal(plain(left, kid.id), "A source");
  assert.deepEqual(job.tabs?.map((x) => x.title), ["Research", "Web", "Sources"], "typed in the reference's order");
});

test("a blank Tab 1 takes the reference's title and everything in it, footnote text included", async () => {
  const left = stub("left-doc-0000002", "Blank", [{ id: "t.0", title: "Tab 1" }]);
  const right = stub("right-doc-000002", "Essay", [{ id: "t.0", title: "Essay", text: "Title line\nA paragraph with a note\nLast words" }]);
  // A footnote after "note"
  const at = "Title line\nA paragraph with a note".length + 1;
  const reply = right.tab("t.0").batchUpdate([{ createFootnote: { location: { index: at } } }]) as { createFootnote?: { footnoteId: string } }[];
  const fid = reply[0].createFootnote!.footnoteId;
  right.tab("t.0").batchUpdate([{ insertText: { location: { segmentId: fid, index: 0 }, text: "The source of it." } }]);
  await start("left-doc-0000002", "right-doc-000002");
  const raw = await getRawDocument("t", "left-doc-0000002");
  assert.deepEqual(rawTabs(raw).map((x) => x.title), ["Essay"], "renamed, not added to");
  assert.equal(plain(left, "t.0").replace(/\0/g, ""), "Title line\nA paragraph with a note\nLast words");
  const notes = Object.values(raw.tabs![0].documentTab!.footnotes ?? {});
  assert.equal(notes.length, 1, "the footnote made once");
  const noteText = (notes[0].content ?? []).flatMap((e) => e.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
  assert.equal(noteText.trim(), "The source of it.");
});

test("a change to either document since the review stops the start, before anything is written", async () => {
  const left = stub("left-doc-0000003", "Mine", [{ id: "t.0", title: "Tab 1", text: "One" }]);
  const right = stub("right-doc-000003", "Ref", [{ id: "t.0", title: "Tab 1", text: "One\nTwo" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000003"), getRawDocument("t", "right-doc-000003")]);
  right.tab("t.0").batchUpdate([{ insertText: { location: { index: 1 }, text: "Zero\n" } }]);
  right.revision++;
  const sentBefore = left.sent.get("t.0")?.length ?? 0;
  await assert.rejects(prepareCompare(g, { leftId: "left-doc-0000003", rightId: "right-doc-000003", leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: {}, skip: [], breaks: [] }), CompareChangedError);
  assert.equal(left.sent.get("t.0")?.length ?? 0, sentBefore, "nothing written to LEFT");
});

test("a manual break placed on a copied word pauses the sync right after it", async () => {
  const left = stub("left-doc-0000004", "Mine", [{ id: "t.0", title: "Notes", text: "Alpha\nOmega" }]);
  stub("right-doc-000004", "Ref", [{ id: "t.0", title: "Notes", text: "Alpha\nBeta gamma delta\nMiddle two\nOmega" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000004"), getRawDocument("t", "right-doc-000004")]);
  const sides = buildSides(l, "left-doc-0000004", r, "right-doc-000004");
  const result = compareDocs(sides.left, sides.right, { tabMap: sides.tabMap });
  const tab = result.tabs[0];
  // The reference token ending "gamma"
  const rightToks = tokenize({ type: "doc", content: sides.right.tabs[0].doc.nodes });
  const text = rightToks.map((x) => (x.k === "c" ? x.c : x.k === "nl" ? "\n" : "\0")).join("");
  const gamma = text.indexOf("gamma") + "gamma".length - 1;
  assert.ok(tab.changes.length >= 1);
  const { built } = await start("left-doc-0000004", "right-doc-000004", { breaks: [{ rightTabId: "t.0", rightToken: gamma, minutes: 5 }] });
  const pause = built.ok ? built.plan.actions.findIndex((a) => a.kind === "pause" && a.activity !== undefined && (a.delayMs ?? 0) >= 5 * 60_000 - 1) : -1;
  assert.ok(pause > 0, "a five-minute pause is in the plan");
  const typedBefore = built.ok ? built.plan.actions.slice(0, pause).filter((a) => a.kind === "insert" || a.kind === "typo").map((a) => a.text).join("") : "";
  assert.ok(typedBefore.endsWith("gamma ") || typedBefore.endsWith("gamma"), `the break follows "gamma": …${typedBefore.slice(-20)}`);
  assert.equal(plain(left, "t.0"), "Alpha\nBeta gamma delta\nMiddle two\nOmega");
});

test("a skipped change isn't typed; the rest are", async () => {
  const left = stub("left-doc-0000005", "Mine", [{ id: "t.0", title: "Notes", text: "Alpha\nOmega" }]);
  stub("right-doc-000005", "Ref", [{ id: "t.0", title: "Notes", text: "Alpha\nBeta here\nOmega\nAfter omega" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000005"), getRawDocument("t", "right-doc-000005")]);
  const sides = buildSides(l, "left-doc-0000005", r, "right-doc-000005");
  const tab = compareDocs(sides.left, sides.right, { tabMap: sides.tabMap }).tabs[0];
  const last = tab.changes.find((c) => c.preview.includes("After omega"));
  assert.ok(last, JSON.stringify(tab.changes.map((c) => c.preview)));
  await start("left-doc-0000005", "right-doc-000005", { skip: [last.id] });
  assert.equal(plain(left, "t.0"), "Alpha\nBeta here\nOmega");
});

test("a table the reference has: its structure made at the start, its cells typed, in the tab it goes into", async () => {
  const left = stub("left-doc-0000006", "Mine", [{ id: "t.0", title: "Team", text: "Team\nAfter the table." }]);
  const right = stub("right-doc-000006", "Ref", [{ id: "t.0", title: "Team", text: "Team\nAfter the table." }]);
  const rd = right.tab("t.0");
  rd.batchUpdate([{ insertTable: { rows: 2, columns: 2, location: { index: 6 } } }]);
  const starts: number[] = [];
  const raw = await getRawDocument("t", "right-doc-000006");
  for (const el of raw.tabs![0].documentTab!.body!.content ?? []) if (el.table) for (const row of el.table.tableRows ?? []) for (const c of row.tableCells ?? []) starts.push(c.content![0].startIndex!);
  rd.batchUpdate(starts.map((at, k) => ({ insertText: { location: { index: at }, text: ["Name", "Role", "Ada", "Engineer"][k] } })).reverse());
  await start("left-doc-0000006", "right-doc-000006", { typos: 0.5 });
  assert.equal(plain(left, "t.0"), plain(right, "t.0"));
  const out = await getRawDocument("t", "left-doc-0000006");
  const tables = (out.tabs![0].documentTab!.body!.content ?? []).filter((e) => e.table);
  assert.equal(tables.length, 1, "one table, made once");
  assert.equal(tables[0].table!.rows, 2);
});

// ── Review round: the start path's hard cases ────────────────────────────────

/** A footnote in `doc`'s tab right after the first `after` in its text, holding `text` */
function footnote(d: TabbedStub, tab: string, after: string, text: string) {
  const at = d.tab(tab).text().indexOf(after) + after.length;
  assert.ok(at >= after.length, `"${after}" is in the tab`);
  const reply = d.tab(tab).batchUpdate([{ createFootnote: { location: { index: at } } }]) as { createFootnote?: { footnoteId: string } }[];
  const fid = reply[0].createFootnote!.footnoteId;
  d.tab(tab).batchUpdate([{ insertText: { location: { segmentId: fid, index: 1 }, text } }]);
  return fid;
}

/** Each footnote of a tab as read, in the order their references come in the body: the text before the reference, and the footnote's */
async function notesOf(documentId: string, tabId: string) {
  const raw = await getRawDocument("t", documentId);
  const doc = openTab(raw, tabId)!.doc;
  const out: { before: string; note: string }[] = [];
  let text = "";
  for (const el of doc.body?.content ?? []) {
    for (const e of el.paragraph?.elements ?? []) {
      if (e.footnoteReference) {
        const f = doc.footnotes?.[e.footnoteReference.footnoteId!];
        out.push({ before: text.split(/\s+/).filter(Boolean).slice(-1)[0] ?? "", note: (f?.content ?? []).flatMap((c) => c.paragraph?.elements ?? []).map((x) => x.textRun?.content ?? "").join("").trim() });
      } else text += e.textRun?.content ?? "";
    }
  }
  return out;
}

test("several footnotes in several places: each new reference gets its own reference text, in order", async () => {
  const left = stub("left-doc-0000011", "Mine", [{ id: "t.0", title: "Notes", text: "First kept line\nSecond kept line" }]);
  const right = stub("right-doc-000011", "Ref", [{ id: "t.0", title: "Notes", text: "First kept line\nAlpha new paragraph\nSecond kept line\nOmega new paragraph" }]);
  footnote(right, "t.0", "Omega", "Note for omega.");
  footnote(right, "t.0", "Alpha", "Note for alpha.");
  footnote(right, "t.0", "Second kept", "Note for second.");
  await start("left-doc-0000011", "right-doc-000011");
  assert.equal(plain(left, "t.0").replace(/\0/g, ""), plain(right, "t.0").replace(/\0/g, ""));
  assert.deepEqual(await notesOf("left-doc-0000011", "t.0"), [
    { before: "Alpha", note: "Note for alpha." },
    { before: "kept", note: "Note for second." },
    { before: "Omega", note: "Note for omega." },
  ]);
});

test("the tab map the page sends back (the load's, renames included) still renames a blank Tab 1", async () => {
  stub("left-doc-0000012", "Blank", [{ id: "t.0", title: "Tab 1" }]);
  stub("right-doc-000012", "Essay", [{ id: "t.0", title: "Essay", text: "Only line" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000012"), getRawDocument("t", "right-doc-000012")]);
  const { tabMap } = buildSides(l, "left-doc-0000012", r, "right-doc-000012");
  assert.deepEqual(tabMap, { "t.0": { kind: "tab", leftTabId: "t.0", rename: "Essay" } });
  // As the page asks for it again after the user picks a target somewhere (the load's map, back)
  assert.deepEqual(buildSides(l, "left-doc-0000012", r, "right-doc-000012", tabMap).tabMap, tabMap);
  await start("left-doc-0000012", "right-doc-000012", { tabMap });
  assert.deepEqual(rawTabs(await getRawDocument("t", "left-doc-0000012")).map((x) => x.title), ["Essay"]);
  // A rename the reference doesn't ask for (or of a tab with content) isn't taken from a client
  const own = stub("left-doc-0000013", "Mine", [{ id: "t.0", title: "Tab 1", text: "Something" }]);
  stub("right-doc-000013", "Ref", [{ id: "t.0", title: "Essay", text: "Something\nMore" }]);
  const [l2, r2] = await Promise.all([getRawDocument("t", "left-doc-0000013"), getRawDocument("t", "right-doc-000013")]);
  assert.deepEqual(buildSides(l2, "left-doc-0000013", r2, "right-doc-000013", { "t.0": { kind: "tab", leftTabId: "t.0", rename: "Hacked" } }).tabMap, { "t.0": { kind: "tab", leftTabId: "t.0" } });
  assert.deepEqual(buildSides(l2, "left-doc-0000013", r2, "right-doc-000013", { "t.0": { kind: "tab", leftTabId: "t.0", rename: "Essay" } }).tabMap, { "t.0": { kind: "tab", leftTabId: "t.0" } });
  assert.equal(own.all()[0].title, "Tab 1");
});

/** Bullets on the paragraphs of a stub tab that hold these texts */
function bullets(d: TabbedStub, tab: string, texts: string[], preset: string) {
  const all = d.tab(tab).text();
  const from = all.indexOf(texts[0]);
  const last = texts[texts.length - 1];
  const to = all.indexOf(last) + last.length;
  d.tab(tab).batchUpdate([{ createParagraphBullets: { range: { startIndex: from, endIndex: to }, bulletPreset: preset } }]);
}

/** Each paragraph of a tab as read: its text, and its list and level when it is in one */
async function paragraphsOf(documentId: string, tabId: string) {
  const doc = openTab(await getRawDocument("t", documentId), tabId)!.doc;
  return (doc.body?.content ?? []).filter((e) => e.paragraph).map((e) => {
    const p = e.paragraph!;
    const text = (p.elements ?? []).map((x) => x.textRun?.content ?? (x.footnoteReference ? "*" : "")).join("").replace(/\n$/, "");
    return { text, list: p.bullet?.listId ?? null, level: p.bullet?.nestingLevel ?? 0 };
  });
}

test("a new list item with a footnote joins the list it goes into; the items there keep their list", async () => {
  const left = stub("left-doc-0000014", "Mine", [{ id: "t.0", title: "Notes", text: "Groceries\nApple\nCherry\nDone" }]);
  bullets(left, "t.0", ["Apple", "Cherry"], "BULLET_DISC_CIRCLE_SQUARE");
  const right = stub("right-doc-000014", "Ref", [{ id: "t.0", title: "Notes", text: "Groceries\nApple\nBanana split\nCherry\nDone" }]);
  bullets(right, "t.0", ["Apple", "Cherry"], "BULLET_DISC_CIRCLE_SQUARE");
  footnote(right, "t.0", "Banana", "A fruit.");
  const before = await paragraphsOf("left-doc-0000014", "t.0");
  const listId = before[1].list;
  assert.ok(listId);
  const sentBefore = left.sent.get("t.0")?.length ?? 0;
  await start("left-doc-0000014", "right-doc-000014");
  const after = await paragraphsOf("left-doc-0000014", "t.0");
  assert.deepEqual(after.map((p) => p.text), ["Groceries", "Apple", "Banana* split", "Cherry", "Done"]);
  assert.deepEqual(after.map((p) => p.list), [null, listId, listId, listId, null], "the new item is in the list; Apple and Cherry are still in theirs");
  const sent = (left.sent.get("t.0") ?? []).slice(sentBefore).map((x) => Object.keys(x)[0]);
  assert.ok(!sent.includes("deleteParagraphBullets"), `never takes the bullets off: ${sent.join(", ")}`);
  assert.deepEqual(await notesOf("left-doc-0000014", "t.0"), [{ before: "Banana", note: "A fruit." }]);
});

test("several footnotes in one new paragraph, and one in a paragraph the document has", async () => {
  const left = stub("left-doc-0000015", "Mine", [{ id: "t.0", title: "Notes", text: "Start here\nEnd here" }]);
  const right = stub("right-doc-000015", "Ref", [{ id: "t.0", title: "Notes", text: "Start here\nOne two three four\nEnd here" }]);
  footnote(right, "t.0", "four", "Four.");
  footnote(right, "t.0", "two", "Two.");
  footnote(right, "t.0", "End", "End.");
  await start("left-doc-0000015", "right-doc-000015", { typos: 1, seed: 9 });
  assert.equal(plain(left, "t.0").replace(/\0/g, ""), plain(right, "t.0").replace(/\0/g, ""));
  assert.deepEqual(await notesOf("left-doc-0000015", "t.0"), [{ before: "two", note: "Two." }, { before: "four", note: "Four." }, { before: "End", note: "End." }]);
});

test("a manual break after a tab's last word pauses before the next tab", async () => {
  stub("left-doc-0000016", "Mine", [{ id: "t.0", title: "One", text: "Kept" }]);
  stub("right-doc-000016", "Ref", [{ id: "t.0", title: "One", text: "Kept\nLast words here" }, { id: "t.b", title: "Two", text: "Next tab text" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000016"), getRawDocument("t", "right-doc-000016")]);
  const sides = buildSides(l, "left-doc-0000016", r, "right-doc-000016");
  const rightToks = tokenize({ type: "doc", content: sides.right.tabs[0].doc.nodes });
  const text = rightToks.map((x) => (x.k === "c" ? x.c : x.k === "nl" ? "\n" : "\0")).join("");
  const here = text.indexOf("here") + 3;
  const { built } = await start("left-doc-0000016", "right-doc-000016", { breaks: [{ rightTabId: "t.0", rightToken: here, minutes: 7 }] });
  assert.ok(built.ok);
  const actions = built.ok ? built.plan.actions : [];
  const pause = actions.findIndex((a) => a.kind === "pause" && a.delayMs >= 7 * 60_000 - 1);
  assert.ok(pause > 0, "the break is in the plan");
  const typed = actions.slice(0, pause).filter((a) => a.kind !== "pause").map((a) => a.text).join("");
  assert.ok(/here\s*$/.test(typed) && !typed.includes("Next"), `between the tabs: …${typed.slice(-20)}`);
});

/** A reference with a bit of everything a start sets up: tabs (one nested), a table, footnotes, a header */
function richPair(n: number) {
  const leftId = `left-doc-rich${String(n).padStart(4, "0")}`;
  const rightId = `right-doc-ric${String(n).padStart(4, "0")}`;
  const left = stub(leftId, "Mine", [{ id: "t.0", title: "Main", text: "Team\nAfter the table.\nEnd" }]);
  const right = stub(rightId, "Ref", [
    { id: "t.0", title: "Main", text: "Team\nAfter the table.\nA claim with a source\nEnd" },
    { id: "t.x", title: "Extra", text: "Extra tab line", children: [{ id: "t.y", title: "Deeper", text: "Deeper line" }] },
  ]);
  const rd = right.tab("t.0");
  rd.batchUpdate([{ insertTable: { rows: 2, columns: 2, location: { index: 6 } } }]);
  const starts: number[] = [];
  const raw = right.get(true);
  for (const el of raw.tabs![0].documentTab!.body!.content ?? []) if (el.table) for (const row of el.table.tableRows ?? []) for (const c of row.tableCells ?? []) starts.push(c.content![0].startIndex!);
  rd.batchUpdate(starts.map((at, k) => ({ insertText: { location: { index: at }, text: ["Name", "Role", "Ada", "Engineer"][k] } })).reverse());
  footnote(right, "t.0", "source", "Where it's from.");
  footnote(right, "t.x", "Extra", "About the extra tab.");
  const replies = right.tab("t.x").batchUpdate([{ createHeader: { type: "DEFAULT" } }]) as { createHeader: { headerId: string } }[];
  right.tab("t.x").batchUpdate([{ insertText: { location: { segmentId: replies[0].createHeader.headerId, index: 0 }, text: "Extra header" } }]);
  return { leftId, rightId, left, right };
}

/** What a tab of a stub has, for comparing two documents: its text, tables, footnotes and header */
async function contentOf(documentId: string) {
  const raw = await getRawDocument("t", documentId);
  return rawTabs(raw).map((t) => {
    const doc = openTab(raw, t.id)!.doc;
    const text = (el: { paragraph?: { elements?: { textRun?: { content?: string | null } | null; footnoteReference?: unknown }[] | null } | null; table?: unknown }[] | undefined): string =>
      (el ?? []).map((e) => e.paragraph ? (e.paragraph.elements ?? []).map((x) => x.textRun?.content ?? (x.footnoteReference ? "*" : "")).join("") : e.table ? `[table ${(e.table as { rows?: number }).rows}x${(e.table as { columns?: number }).columns}: ${((e.table as { tableRows?: { tableCells?: { content?: never[] }[] }[] }).tableRows ?? []).flatMap((r) => (r.tableCells ?? []).map((c) => text(c.content).trim())).join("|")}]\n` : "").join("");
    const notes = Object.values(doc.footnotes ?? {}).map((f) => text(f.content as never).trim()).sort();
    const header = doc.documentStyle?.defaultHeaderId ? text(doc.headers?.[doc.documentStyle.defaultHeaderId]?.content as never).trim() : null;
    return { title: t.title, level: t.level, text: text(doc.body?.content as never), notes, header };
  });
}

test("a start cut off anywhere in its set-up, started again, ends with the reference's content once: no tab, table, footnote or header twice", async () => {
  const want = await (async () => { const { rightId } = richPair(0); return contentOf(rightId); })();
  for (let cut = 1; ; cut++) {
    const { leftId, rightId } = richPair(cut);
    // The first start dies after `cut` writes (a timeout, Google failing), as the route would see it
    let writes = 0;
    const die = () => { if (++writes > cut) throw Object.assign(new Error("Backend Error"), { code: 500 }); };
    const dying: CompareGoogle = {
      ...g,
      batch: async (...a) => { die(); return g.batch(...a); },
      createTab: async (...a) => { die(); return g.createTab(...a); },
      renameTab: async (...a) => { die(); return g.renameTab(...a); },
    };
    const [l, r] = await Promise.all([getRawDocument("t", leftId), getRawDocument("t", rightId)]);
    let finished = false;
    try {
      await prepareCompare(dying, { leftId, rightId, leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: {}, skip: [], breaks: [] });
      finished = true; // set up in full; the sync itself never stored (Redis failing, say)
    } catch (err) {
      assert.equal((err as { code?: number }).code, 500, String(err));
    }
    // The page reads both again (the revision changed) and the user starts once more
    await start(leftId, rightId);
    const got = await contentOf(leftId);
    assert.deepEqual(got, want.map((t) => ({ ...t })), `cut after ${cut} writes`);
    if (finished) {
      assert.ok(cut >= 8, `cut at every one of the set-up's writes (${cut})`);
      break;
    }
    assert.ok(cut < 60, "the set-up never finished");
  }
});

test("a sync cancelled partway, compared and started again, finishes the copy: nothing it set up is made twice", async () => {
  const want = await (async () => { const { rightId } = richPair(100); return contentOf(rightId); })();
  let cancelled = 0;
  for (const windows of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
    const { leftId, rightId } = richPair(101 + windows);
    // One action per delivery: cancelled after that many (until it finishes first)
    const first = await start(leftId, rightId, { cancelAfter: windows, windowMs: 0, typos: 0 });
    if (first.job.status === "done") break;
    assert.equal(first.job.status, "cancelled");
    cancelled++;
    await start(leftId, rightId, { typos: 0.5, seed: windows });
    assert.deepEqual(await contentOf(leftId), want, `cancelled after ${windows} deliveries`);
  }
  assert.ok(cancelled >= 6, `cancelled at ${cancelled} points`);
});

test("someone editing your document while the start sets it up: their edit is never taken back", async () => {
  // In the tab the start writes the table into: Google refuses the batch read before their edit, and
  // the user is asked to compare again; started again, it all goes where it belongs
  const { leftId, rightId, left } = richPair(200);
  const typing = (doc: TabbedStub, tab: string): CompareGoogle => {
    let typed = false;
    return {
      ...g,
      batch: async (id, requests, tabId, revision) => {
        if (!typed && tabId === "t.0" && requests.some((r) => "insertTable" in r)) {
          typed = true;
          doc.batchUpdate([{ insertText: { location: { index: 1, tabId: tab }, text: "Hello.\n" } }]);
        }
        return g.batch(id, requests, tabId, revision);
      },
    };
  };
  const [l, r] = await Promise.all([getRawDocument("t", leftId), getRawDocument("t", rightId)]);
  await assert.rejects(prepareCompare(typing(left, "t.0"), { leftId, rightId, leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: {}, skip: [], breaks: [] }), CompareChangedError);
  assert.equal(plain(left, "t.0"), "Hello.\nTeam\nAfter the table.\nEnd", "their edit stays; nothing went in at the old places");
  await start(leftId, rightId);
  const want = await contentOf(rightId);
  assert.deepEqual(await contentOf(leftId), [{ ...want[0], text: `Hello.\n${want[0].text}` }, ...want.slice(1)]);

  // In a tab the start doesn't write to: read again, and on
  const two = richPair(201);
  two.left.batchUpdate([{ addDocumentTab: { tabProperties: { title: "Scratch" } } }]);
  const scratch = rawTabs(await getRawDocument("t", two.leftId)).find((t) => t.title === "Scratch")!.id;
  const typed = await start(two.leftId, two.rightId, { google: typing(two.left, scratch) });
  assert.equal(typed.job.status, "done");
  assert.equal(plain(two.left, scratch), "Hello.\n");
  const got = await contentOf(two.leftId);
  assert.deepEqual(got.filter((t) => t.title !== "Scratch"), await contentOf(two.rightId));
});

test("too much to store in one sync: refused with a clear message before anything is written; past 100 tabs, the rest aren't copied", async () => {
  // About 400 pages, some words styled: more than one sync types
  const words = "the quick brown fox jumps over a lazy dog while seven happy writers draft long essays".split(" ");
  const lines: string[] = [];
  for (let p = 0; p < 6400; p++) lines.push(Array.from({ length: 30 }, (_, k) => words[(p * 7 + k * 3) % words.length]).join(" ") + ".");
  const left = stub("left-doc-0000300", "Mine", [{ id: "t.0", title: "Tab 1" }]);
  const right = stub("right-doc-000300", "Ref", [{ id: "t.0", title: "Book" }]);
  for (let k = lines.length - 1; k >= 0; k -= 100) right.tab("t.0").batchUpdate([{ insertText: { location: { index: 1 }, text: lines.slice(Math.max(0, k - 99), k + 1).join("\n") + (k === lines.length - 1 ? "" : "\n") } }]);
  const len = right.tab("t.0").text().length;
  const styles: object[] = [];
  for (let i = 1; i + 12 < len; i += 4000) styles.push({ updateTextStyle: { range: { startIndex: i, endIndex: i + 6 }, textStyle: { bold: true }, fields: "bold" } });
  right.tab("t.0").batchUpdate(styles as never);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000300"), getRawDocument("t", "right-doc-000300")]);
  const rev = left.revisionId;
  for (const pace of [undefined, { breaksMode: "none" as const, targetMinutes: null, typoFrequency: 1, seed: 1 }]) {
    await assert.rejects(prepareCompare(g, { leftId: "left-doc-0000300", rightId: "right-doc-000300", leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: {}, skip: [], breaks: [], pace }),
      (e: Error) => e instanceof CompareRefusedError && e.status === 400 && /more than one sync can copy/.test(e.message));
  }
  assert.equal(left.revisionId, rev, "nothing written, not even the rename");
  assert.equal(left.all()[0].title, "Tab 1");

  // 99 tabs and the reference's two more: the one past Google's limit of 100 isn't copied, even asked for
  const many = stub("left-doc-0000301", "Many", Array.from({ length: 99 }, (_, k) => ({ id: `t.m${k}`, title: `Part ${k}`, text: `Text ${k}` })));
  stub("right-doc-000301", "Two", [{ id: "t.0", title: "New one", text: "Words" }, { id: "t.1", title: "New two", text: "More words" }]);
  const { prepared } = await start("left-doc-0000301", "right-doc-000301", { tabMap: { "t.0": { kind: "new" }, "t.1": { kind: "new" } } });
  assert.deepEqual(prepared.result.tabs.map((t) => t.target.kind), ["tab", "skip"]);
  assert.equal(many.all().length, 100);
  assert.equal(plain(many, many.all()[99].id), "Words");
});

test("new tabs go where the reference has them: between, before and under the tabs you have", async () => {
  const left = stub("left-doc-0000310", "Mine", [
    { id: "t.a", title: "Intro", text: "Hello there, this is the start." },
    { id: "t.c", title: "Ending", text: "Goodbye, this is the end." },
  ]);
  stub("right-doc-000310", "Ref", [
    { id: "r.p", title: "Preface", text: "A word before we begin." },
    { id: "r.a", title: "Intro", text: "Hello there, this is the start.", children: [{ id: "r.n", title: "Notes", text: "A note on the start." }] },
    { id: "r.b", title: "Middle", text: "Here is the middle part." },
    { id: "r.c", title: "Ending", text: "Goodbye, this is the end." },
  ]);
  await start("left-doc-0000310", "right-doc-000310");
  assert.deepEqual(left.roots.map((t) => t.title), ["Preface", "Intro", "Middle", "Ending"]);
  assert.deepEqual(left.roots[1].children.map((t) => t.title), ["Notes"]);
  assert.equal(plain(left, left.roots[2].id), "Here is the middle part.");
  assert.equal(plain(left, left.roots[1].children[0].id), "A note on the start.");
  assert.equal(plain(left, "t.a"), "Hello there, this is the start.");
});

test("a 150-page copy into a blank document fits in one sync: its plan and the live page's context are stored packed, each under Redis's 1 MB", async () => {
  // Words of a large vocabulary (prose-like: it packs about as well as real text), 150 pages of about 500
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const syllables = ["ka", "ri", "mo", "ten", "sa", "lu", "vor", "pe", "dan", "is", "el", "tro", "mi", "gra", "ul", "bes", "no", "fa", "ze", "chi"];
  const vocab = Array.from({ length: 3000 }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => syllables[Math.floor(rnd() * syllables.length)]).join(""));
  const lines: string[] = [];
  for (let p = 0; p < 150 * 18; p++) lines.push(Array.from({ length: 28 }, () => vocab[Math.floor(rnd() * rnd() * vocab.length)]).join(" ") + ".");
  stub("left-doc-0000302", "Mine", [{ id: "t.0", title: "Tab 1" }]);
  const right = stub("right-doc-000302", "Ref", [{ id: "t.0", title: "Book" }]);
  for (let k = lines.length - 1; k >= 0; k -= 100) right.tab("t.0").batchUpdate([{ insertText: { location: { index: 1 }, text: lines.slice(Math.max(0, k - 99), k + 1).join("\n") + (k === lines.length - 1 ? "" : "\n") } }]);
  const len = right.tab("t.0").text().length;
  const styles: object[] = [];
  for (let i = 1; i + 20 < len; i += 120) styles.push({ updateTextStyle: { range: { startIndex: i, endIndex: i + 9 }, textStyle: { italic: true }, fields: "italic" } });
  right.tab("t.0").batchUpdate(styles as never);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000302"), getRawDocument("t", "right-doc-000302")]);
  const pace = { breaksMode: "auto" as const, targetMinutes: 1200, typoFrequency: 1, seed: 1 };
  const prepared = await prepareCompare(g, { leftId: "left-doc-0000302", rightId: "right-doc-000302", leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: {}, skip: [], breaks: [], pace });
  const built = buildCompareJob(prepared, { id: "job_big", userId: "u", documentId: "left-doc-0000302", documentName: "", ...pace, startInMinutes: 0, now: 0, accessToken: "a", refreshToken: "r" });
  assert.ok(built.ok, built.ok ? "" : built.error);
  if (!built.ok) return;
  assert.ok(built.plan.totalChars > 400_000, `${built.plan.totalChars} characters`);
  assert.ok(JSON.stringify(built.plan).length > 1_000_000, "more than Redis takes unpacked");
  const plan = storedSize(built.plan);
  assert.ok(plan < MAX_STORED_JSON, `plan ${plan} packed`);
  assert.ok(built.context && storedSize(built.context) < MAX_STORED_JSON, "the live page keeps its view of it");
  assert.ok(JSON.stringify(built.job).length < 100_000);
});

test("a tab map from the client can't reach another document's tabs or the object prototype", async () => {
  const left = stub("left-doc-0000303", "Mine", [{ id: "t.0", title: "Mine", text: "Kept" }]);
  stub("right-doc-000303", "Ref", [{ id: "t.0", title: "Theirs", text: "Kept\nAdded" }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000303"), getRawDocument("t", "right-doc-000303")]);
  const hostile = JSON.parse('{"__proto__": {"kind": "skip"}, "constructor": {"kind": "new"}, "t.0": {"kind": "tab", "leftTabId": "t.someone-elses", "rename": "Owned"}, "toString": {"kind": "tab", "leftTabId": "t.0"}}');
  const sides = buildSides(l, "left-doc-0000303", r, "right-doc-000303", hostile);
  assert.deepEqual(sides.tabMap, { "t.0": { kind: "tab", leftTabId: "t.0" } }, "matched as if nothing was given");
  assert.equal(({} as Record<string, unknown>).kind, undefined, "the prototype is untouched");
  await start("left-doc-0000303", "right-doc-000303", { tabMap: hostile });
  assert.equal(plain(left, "t.0"), "Kept\nAdded");
  assert.deepEqual(rawTabs(await getRawDocument("t", "left-doc-0000303")).map((x) => x.title), ["Mine"]);
});

test("an image that can't be copied is left out and reported; a break after a word past it still follows that word", async () => {
  const left = stub("left-doc-0000304", "Mine", [{ id: "t.0", title: "Notes", text: "Start" }]);
  const right = stub("right-doc-000304", "Ref", [{ id: "t.0", title: "Notes", text: "Start\nBefore  after the picture\nThe end" }]);
  const at = right.tab("t.0").text().indexOf("Before ") + "Before ".length;
  right.tab("t.0").batchUpdate([{ insertInlineImage: { location: { index: at }, uri: "https://img.example.com/gone.png", objectSize: { width: { magnitude: 40, unit: "PT" } } } }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000304"), getRawDocument("t", "right-doc-000304")]);
  const sides = buildSides(l, "left-doc-0000304", r, "right-doc-000304");
  const rightToks = tokenize({ type: "doc", content: sides.right.tabs[0].doc.nodes });
  const text = rightToks.map((x) => (x.k === "c" ? x.c : x.k === "nl" ? "\n" : "\0")).join("");
  const picture = text.indexOf("picture") + "picture".length - 1;
  const { built, prepared } = await start("left-doc-0000304", "right-doc-000304", { google: { ...g, rehost: async () => null }, breaks: [{ rightTabId: "t.0", rightToken: picture, minutes: 3 }] });
  assert.equal(prepared.droppedImages, 1);
  assert.equal(plain(left, "t.0"), "Start\nBefore  after the picture\nThe end");
  const actions = built.ok ? built.plan.actions : [];
  const pause = actions.findIndex((a) => a.kind === "pause" && a.delayMs >= 3 * 60_000 - 1);
  const typed = actions.slice(0, pause).filter((a) => a.kind !== "pause").map((a) => a.text).join("");
  assert.ok(pause > 0 && /picture\s*$/.test(typed), `…${typed.slice(-20)}`);
});

test("a new tab with a table takes the reference's page; the tab you have keeps its own", async () => {
  stub("left-doc-0000305", "Mine", [{ id: "t.0", title: "Main", text: "Main text" }]);
  const right = stub("right-doc-000305", "Ref", [{ id: "t.0", title: "Main", text: "Main text" }, { id: "t.t", title: "Tables", text: "Above\nBelow" }]);
  for (const id of ["t.0", "t.t"]) right.tab(id).batchUpdate([{ updateDocumentStyle: { documentStyle: { marginTop: { magnitude: 30, unit: "PT" }, marginLeft: { magnitude: 30, unit: "PT" } }, fields: "marginTop,marginLeft" } }]);
  right.tab("t.t").batchUpdate([{ insertTable: { rows: 1, columns: 3, location: { index: 6 } } }]);
  const cells: number[] = [];
  for (const el of openTab(right.get(true), "t.t")!.doc.body!.content ?? []) if (el.table) for (const row of el.table.tableRows ?? []) for (const c of row.tableCells ?? []) cells.push(c.content![0].startIndex!);
  right.tab("t.t").batchUpdate(cells.map((x, k) => ({ insertText: { location: { index: x }, text: ["a", "b", "c"][k] } })).reverse());
  await start("left-doc-0000305", "right-doc-000305", { typos: 1, seed: 2 });
  const raw = await getRawDocument("t", "left-doc-0000305");
  const made = rawTabs(raw).find((x) => x.title === "Tables")!;
  assert.equal((await contentOf("left-doc-0000305"))[1].text, (await contentOf("right-doc-000305"))[1].text);
  assert.equal(openTab(raw, made.id)!.doc.documentStyle?.marginTop?.magnitude, 30, "a new tab takes the reference's page");
  assert.equal(openTab(raw, "t.0")!.doc.documentStyle?.marginTop?.magnitude, 72, "the tab with content keeps its own");
});

/** A 1×2 table put into a stub tab at `index` (Docs splits the paragraph there), its cells filled */
function table(d: TabbedStub, tab: string, index: number, texts: [string, string]) {
  d.tab(tab).batchUpdate([{ insertTable: { rows: 1, columns: 2, location: { index } } }]);
  const cells: number[] = [];
  const doc = openTab(d.get(true), tab)!.doc;
  for (const el of doc.body!.content ?? []) if (el.table && (el.startIndex ?? 0) >= index) { for (const row of el.table.tableRows ?? []) for (const c of row.tableCells ?? []) cells.push(c.content![0].startIndex!); break; }
  d.tab(tab).batchUpdate(cells.map((x, k) => ({ insertText: { location: { index: x }, text: texts[k] } })).reverse());
}

test("new tables wherever Docs can have them: after a line you have or a new one, at the top, at the end, in a new tab; nothing taken back", async () => {
  // [your tab, the reference's, where the reference's table is put (Docs splits the paragraph there)]
  const shapes: [string, string, number][] = [
    ["Above\nBelow", "Above\nBelow", 6], // right after a line you have (as Docs puts one at the end of a line)
    ["Below", "Above\nBelow", 6], // right after a new line
    ["Above\nBelow", "Above\nBelow", 7], // with an empty line before it
    ["Below", "Above\nBelow", 7],
    ["Above", "Above", 6], // at the very end
    ["Above\nBelow", "Above\nMid\nBelow", 10], // after a new line between two you have
    ["Above", "Above\nMid", 10], // at the very end, after a new line
    ["Above\nBelow", "Above\nBelow", 1], // at the very top
    ["", "Above", 6], // a blank tab
  ];
  let n = 0;
  for (const [mine, theirs, at] of shapes) {
    n++;
    const name = `${JSON.stringify(mine)} ← ${JSON.stringify(theirs)} @${at}`;
    stub(`left-doc-shape${n}0`, "Mine", [{ id: "t.0", title: "Main", ...(mine ? { text: mine } : {}) }]);
    const right = stub(`right-doc-shape${n}`, "Ref", [{ id: "t.0", title: "Main", text: theirs }, { id: "t.n", title: "New", text: theirs }]);
    for (const tab of ["t.0", "t.n"]) table(right, tab, at, ["x", "y"]);
    // (the start refuses to send anything that takes something away, and would fail)
    await start(`left-doc-shape${n}0`, `right-doc-shape${n}`, { typos: 0.5, seed: n });
    const got = (await contentOf(`left-doc-shape${n}0`)).map((t) => t.text);
    const want = (await contentOf(`right-doc-shape${n}`)).map((t) => t.text);
    // Exactly the reference's, but for a table right after a line you have: Docs makes an empty
    // line before a table it puts in, which stands for the reference's empty line after it
    assert.equal(got[1], want[1], `${name}, in a new tab`);
    if (n === 1) assert.equal(got[0], "Above\n\n[table 1x2: x|y]\nBelow\n", name);
    else assert.equal(got[0], want[0], name);
  }
});

test("the live page's view of a sync typing into several tabs: each tab's part of what it types lines up with the plan", async () => {
  const { leftId, rightId, right } = richPair(400);
  right.tab("t.y").batchUpdate([{ insertText: { location: { index: 1 }, text: "Opening words, " } }, { insertPageBreak: { location: { index: 6 } } }]);
  const { built } = await start(leftId, rightId, { google: { ...g, rehost: async (u) => u } });
  assert.ok(built.ok && built.context?.tabs);
  if (!built.ok || !built.context?.tabs) return;
  const segments = built.plan.segments!;
  const source = built.plan.actions.filter((a) => a.kind !== "pause").map((a) => a.text).join("");
  // As the live page works them out (use-sync-jobs: tabParts; use-live-breaks: the part shown)
  let from = 0;
  for (const t of built.context.tabs) {
    const chars = segmentCharTokens(t.doc as never, t.ranges);
    const to = from + chars.reduce((n, c) => n + c.length, 0);
    const mine = segments.slice(t.first, t.first + t.ranges.length);
    assert.ok(mine.every((s) => s.tabId === t.tabId), "a tab's segments are its own");
    assert.equal(from, mine[0].start, `${t.title} starts where its text does`);
    assert.equal(to, mine[mine.length - 1].end, `${t.title} ends where its text does`);
    // Each character the page maps is the one typed there
    const toks = tokenize(t.doc as never);
    chars.forEach((c, k) => c.forEach((q, i) => {
      const ch = source[mine[k].start + i];
      const tok = toks[q];
      if (tok.k === "c" && ch !== "\n") assert.ok(tok.c === ch || ch === " ", `${t.title}: ${JSON.stringify(ch)} from ${JSON.stringify(tok.c)}`);
    }));
    from = to;
  }
  assert.equal(from, source.length, "the parts cover the whole sync");
});

test("nested reference tabs: under the tab their parent goes into, or at the top when their parent isn't copied", async () => {
  stub("left-doc-0000500", "Mine", [{ id: "t.0", title: "Guide", text: "Guide text" }]);
  stub("right-doc-000500", "Ref", [
    { id: "t.g", title: "Guide", text: "Guide text", children: [{ id: "t.gk", title: "Guide notes", text: "Under the guide" }] },
    { id: "t.s", title: "Skipped", text: "Not wanted", children: [{ id: "t.sk", title: "Wanted child", text: "Still wanted" }] },
  ]);
  await start("left-doc-0000500", "right-doc-000500", { tabMap: { "t.s": { kind: "skip" } } });
  const tabs = rawTabs(await getRawDocument("t", "left-doc-0000500"));
  assert.deepEqual(tabs.map((t) => [t.title, t.level, t.parentId]), [["Guide", 0, null], ["Guide notes", 1, "t.0"], ["Wanted child", 0, null]]);
});

test("a manual break after a word next to a new footnote follows that word", async () => {
  stub("left-doc-0000501", "Mine", [{ id: "t.0", title: "Notes", text: "Start here\nEnd here" }]);
  const right = stub("right-doc-000501", "Ref", [{ id: "t.0", title: "Notes", text: "Start here\nOne two three four five\nEnd here" }]);
  footnote(right, "t.0", "two", "Two.");
  footnote(right, "t.0", "One", "One.");
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000501"), getRawDocument("t", "right-doc-000501")]);
  const sides = buildSides(l, "left-doc-0000501", r, "right-doc-000501");
  const toks = tokenize({ type: "doc", content: sides.right.tabs[0].doc.nodes });
  const text = toks.map((x) => (x.k === "c" ? x.c : x.k === "nl" ? "\n" : "\0")).join("");
  const three = text.indexOf("three") + "three".length - 1;
  const { built } = await start("left-doc-0000501", "right-doc-000501", { breaks: [{ rightTabId: "t.0", rightToken: three, minutes: 4 }] });
  const actions = built.ok ? built.plan.actions : [];
  const pause = actions.findIndex((a) => a.kind === "pause" && a.delayMs >= 4 * 60_000 - 1);
  const typed = actions.slice(0, pause).filter((a) => a.kind !== "pause").map((a) => a.text).join("");
  assert.ok(pause > 0 && /three\s*$/.test(typed), `…${typed.slice(-20)}`);
  assert.deepEqual(await notesOf("left-doc-0000501", "t.0"), [{ before: "One", note: "One." }, { before: "two", note: "Two." }]);
});

test("a start reads your document no more than it needs: once more per tab it sets up, not once per step", async () => {
  const { leftId, rightId } = richPair(600);
  let reads = 0;
  let writes = 0;
  const counting: CompareGoogle = { ...g, read: (id) => { if (id === leftId) reads++; return g.read(id); }, batch: (...a) => { writes++; return g.batch(...a); } };
  await start(leftId, rightId, { google: counting });
  // The first read, one after making the two tabs, then for each tab one before writing to it and
  // one after its table or footnotes go in (the last of them is LEFT as the sync starts from)
  assert.ok(reads <= 8, `${reads} reads for ${writes} writes`);
});

test("rows added to a table you have: cancelled before they're typed and started again, they aren't added twice", async () => {
  const fill = (d: TabbedStub, rows: string[][]) => {
    d.tab("t.0").batchUpdate([{ insertTable: { rows: rows.length, columns: 2, location: { index: 6 } } }]);
    const cells: number[] = [];
    for (const el of openTab(d.get(true), "t.0")!.doc.body!.content ?? []) if (el.table) for (const row of el.table.tableRows ?? []) for (const c of row.tableCells ?? []) cells.push(c.content![0].startIndex!);
    d.tab("t.0").batchUpdate(cells.map((x, k) => ({ insertText: { location: { index: x }, text: rows.flat()[k] } })).reverse());
  };
  for (const windows of [0, 1]) {
    const left = stub(`left-doc-rows000${windows}`, "Mine", [{ id: "t.0", title: "Team", text: "Team\nAfter the table." }]);
    const right = stub(`right-doc-rows00${windows}`, "Ref", [{ id: "t.0", title: "Team", text: "Team\nAfter the table." }]);
    fill(left, [["Name", "Role"], ["Ada", "Engineer"]]);
    fill(right, [["Name", "Role"], ["Grace", "Admiral"], ["Ada", "Engineer"]]);
    const first = await start(left.documentId, right.documentId, { cancelAfter: windows, windowMs: 0, typos: 0 });
    assert.equal(first.job.status, "cancelled");
    await start(left.documentId, right.documentId);
    assert.deepEqual((await contentOf(left.documentId))[0].text, (await contentOf(right.documentId))[0].text, `cancelled after ${windows}`);
  }
});

test("only a header to add: it's made, and the start says nothing was left to type", async () => {
  stub("left-doc-0000700", "Mine", [{ id: "t.0", title: "Tab 1" }]);
  const right = stub("right-doc-000700", "Ref", [{ id: "t.0", title: "Tab 1" }]);
  const replies = right.tab("t.0").batchUpdate([{ createHeader: { type: "DEFAULT" } }]) as { createHeader: { headerId: string } }[];
  right.tab("t.0").batchUpdate([{ insertText: { location: { segmentId: replies[0].createHeader.headerId, index: 0 }, text: "Letterhead" } }]);
  const [l, r] = await Promise.all([getRawDocument("t", "left-doc-0000700"), getRawDocument("t", "right-doc-000700")]);
  const prepared = await prepareCompare(g, { leftId: "left-doc-0000700", rightId: "right-doc-000700", leftRevision: l.revisionId!, rightRevision: r.revisionId!, tabMap: {}, skip: [], breaks: [] });
  const built = buildCompareJob(prepared, { id: "j", userId: "u", documentId: "left-doc-0000700", documentName: "", breaksMode: "none", targetMinutes: null, typoFrequency: 0, startInMinutes: 0, now: 0, accessToken: "a", refreshToken: "r" });
  assert.ok(!built.ok && built.code === "nothing" && /now has everything/.test(built.error), JSON.stringify(built));
  assert.equal((await contentOf("left-doc-0000700"))[0].header, "Letterhead");
});

test("a section LEFT lacks, ending with an empty line, before a heading LEFT has: the heading keeps its style throughout", async () => {
  const left = stub("left-doc-0000800", "Mine", [{ id: "t.0", title: "Notes", text: "Heading A\nHeading B\nBody B." }]);
  const right = stub("right-doc-000800", "Ref", [{ id: "t.0", title: "Notes", text: "Heading A\nIntro text here.\nMore.\n\nHeading B\nBody B." }]);
  const heading = (d: TabbedStub, from: number, to: number) => d.tab("t.0").batchUpdate([{ updateParagraphStyle: { range: { startIndex: from, endIndex: to }, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } }]);
  heading(left, 1, 10); heading(left, 11, 20);
  heading(right, 1, 10); heading(right, 35, 44);
  const named = async () => (openTab(await getRawDocument("t", "left-doc-0000800"), "t.0")!.doc.body?.content ?? []).filter((e) => e.paragraph).map((e) => [(e.paragraph!.elements ?? []).map((x) => x.textRun?.content ?? "").join("").trim(), e.paragraph!.paragraphStyle?.namedStyleType]);
  // Once set up (before the sync types), LEFT's paragraphs look as they did
  const checking: CompareGoogle = { ...g, batch: async (...a) => { const out = await g.batch(...a); for (const [text, style] of await named()) if (text?.startsWith("Heading")) assert.equal(style, "HEADING_1", `${text} after ${JSON.stringify(a[1])}`); return out; } };
  await start("left-doc-0000800", "right-doc-000800", { google: checking });
  const styles = (await paragraphsOf("left-doc-0000800", "t.0")).map((p) => p.text);
  assert.deepEqual(styles, ["Heading A", "Intro text here.", "More.", "", "Heading B", "Body B."]);
  assert.deepEqual((await named()).map((x) => x[1]), ["HEADING_1", "NORMAL_TEXT", "NORMAL_TEXT", "NORMAL_TEXT", "HEADING_1", "NORMAL_TEXT"]);
});
