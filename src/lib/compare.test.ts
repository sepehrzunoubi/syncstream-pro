import { test } from "node:test";
import assert from "node:assert/strict";
import type { docs_v1 } from "googleapis";
import { applyBreaks, breaksFromMerged, compareDocs, matchTabs, NEW_TAB_PARAGRAPH } from "./compare";
import type { CompareSide, CompareTab, TabCompare } from "./compare-types";
import { importDoc, type ImportedDoc } from "./doc-import";
import { additions, breakAnchors, directEdits, PENDING_MARK, tokenize, type Tok } from "./doc-model";
import type { EditorNode } from "./rich-text";

// ── Documents as documents.get gives them, read by the app's own importer ──

type TextStyle = docs_v1.Schema$TextStyle;
type Run = string | { t: string; s?: TextStyle } | { fn: string } | { img: string; w?: number; h?: number } | "pb";
interface P { p: Run[] | string; named?: string; list?: "bullet" | "number"; level?: number; align?: string; style?: docs_v1.Schema$ParagraphStyle }
interface T { table: string[][] }
type B = string | P | T;
interface Extra { header?: string; footer?: string; page?: { w: number; h: number; margin: number }; locked?: "rule" | "chip" | "toc" }

const PT = (magnitude: number) => ({ magnitude, unit: "PT" });
const rgb = (hex: string) => ({ color: { rgbColor: { red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 } } });

function gdoc(blocks: B[], extra: Extra = {}): docs_v1.Schema$Document {
  let i = 1;
  const footnotes: Record<string, docs_v1.Schema$Footnote> = {};
  const inlineObjects: Record<string, docs_v1.Schema$InlineObject> = {};
  const content: docs_v1.Schema$StructuralElement[] = [{ endIndex: 1, sectionBreak: { sectionStyle: { sectionType: "CONTINUOUS" } } }];
  const paragraph = (spec: P, at: number) => {
    let k = at;
    const elements: docs_v1.Schema$ParagraphElement[] = [];
    const runs = typeof spec.p === "string" ? [spec.p] : spec.p;
    for (const run of runs) {
      if (run === "pb") { elements.push({ startIndex: k, endIndex: k + 1, pageBreak: { textStyle: {} } }); k++; }
      else if (typeof run === "string" || "t" in run) {
        const text = typeof run === "string" ? run : run.t;
        if (!text) continue;
        elements.push({ startIndex: k, endIndex: k + text.length, textRun: { content: text, textStyle: typeof run === "string" ? {} : run.s ?? {} } });
        k += text.length;
      } else if ("fn" in run) {
        const id = `kix.fn${Object.keys(footnotes).length + 1}`;
        elements.push({ startIndex: k, endIndex: k + 1, footnoteReference: { footnoteId: id, footnoteNumber: String(Object.keys(footnotes).length + 1), textStyle: {} } });
        footnotes[id] = { footnoteId: id, content: [{ startIndex: 0, endIndex: run.fn.length + 1, paragraph: { elements: [{ startIndex: 0, endIndex: run.fn.length + 1, textRun: { content: `${run.fn}\n`, textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } }] };
        k++;
      } else {
        const id = `kix.img${Object.keys(inlineObjects).length + 1}`;
        elements.push({ startIndex: k, endIndex: k + 1, inlineObjectElement: { inlineObjectId: id, textStyle: {} } });
        inlineObjects[id] = { objectId: id, inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: run.img }, size: { width: PT(run.w ?? 96), height: PT(run.h ?? 72) } } } };
        k++;
      }
    }
    elements.push({ startIndex: k, endIndex: k + 1, textRun: { content: "\n", textStyle: {} } });
    k++;
    const paragraphStyle: docs_v1.Schema$ParagraphStyle = { namedStyleType: spec.named ?? "NORMAL_TEXT", ...(spec.align ? { alignment: spec.align } : {}), ...(spec.style ?? {}) };
    const bullet = spec.list ? { listId: spec.list === "bullet" ? "kix.bullets" : "kix.numbers", nestingLevel: spec.level ?? 0 } : undefined;
    return { el: { startIndex: at, endIndex: k, paragraph: { elements, paragraphStyle, ...(bullet ? { bullet } : {}) } }, end: k };
  };
  for (const b of blocks) {
    if (typeof b === "object" && "table" in b) {
      const start = i;
      let k = start + 1;
      const tableRows = b.table.map((cells) => {
        const rowStart = k++;
        const tableCells = cells.map((text) => {
          const cellStart = k++;
          const { el, end } = paragraph({ p: text }, k);
          const cell = { startIndex: cellStart, endIndex: end, content: [el], tableCellStyle: {} };
          k = end;
          return cell;
        });
        k++;
        return { startIndex: rowStart, endIndex: k, tableCells };
      });
      k++;
      content.push({ startIndex: start, endIndex: k, table: { rows: b.table.length, columns: b.table[0].length, tableRows } });
      i = k;
      continue;
    }
    const { el, end } = paragraph(typeof b === "string" ? { p: b } : b, i);
    content.push(el);
    i = end;
  }
  const segment = (id: string, text: string) => ({ headerId: id, footerId: id, content: [{ startIndex: 0, endIndex: text.length + 1, paragraph: { elements: [{ startIndex: 0, endIndex: text.length + 1, textRun: { content: `${text}\n`, textStyle: {} } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } }] });
  const page = extra.page ?? { w: 612, h: 792, margin: 72 };
  return {
    documentId: "doc",
    title: "Doc",
    revisionId: "rev1",
    body: { content },
    footnotes,
    inlineObjects,
    ...(extra.header ? { headers: { "kix.h": segment("kix.h", extra.header) } } : {}),
    ...(extra.footer ? { footers: { "kix.f": segment("kix.f", extra.footer) } } : {}),
    documentStyle: {
      pageSize: { width: PT(page.w), height: PT(page.h) },
      marginTop: PT(page.margin), marginBottom: PT(page.margin), marginLeft: PT(page.margin), marginRight: PT(page.margin),
      ...(extra.header ? { defaultHeaderId: "kix.h" } : {}),
      ...(extra.footer ? { defaultFooterId: "kix.f" } : {}),
    },
    namedStyles: { styles: [
      { namedStyleType: "NORMAL_TEXT", textStyle: { fontSize: PT(11), weightedFontFamily: { fontFamily: "Arial", weight: 400 } }, paragraphStyle: { lineSpacing: 115, spaceAbove: PT(0), spaceBelow: PT(0) } },
      { namedStyleType: "HEADING_1", textStyle: { fontSize: PT(20) }, paragraphStyle: { spaceAbove: PT(20), spaceBelow: PT(6) } },
      { namedStyleType: "HEADING_2", textStyle: { fontSize: PT(16) }, paragraphStyle: { spaceAbove: PT(18), spaceBelow: PT(6) } },
    ] },
    lists: {
      "kix.bullets": { listProperties: { nestingLevels: Array.from({ length: 9 }, (_, n) => ({ glyphSymbol: ["●", "○", "■"][n % 3], indentFirstLine: PT(18 + 36 * n), indentStart: PT(36 + 36 * n) })) } },
      "kix.numbers": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0.", indentFirstLine: PT(18), indentStart: PT(36) }, { glyphType: "ALPHA", glyphFormat: "%1.", indentFirstLine: PT(54), indentStart: PT(72) }] } },
    },
  };
}

const imp = (blocks: B[], extra?: Extra): ImportedDoc => importDoc(gdoc(blocks, extra));

interface TabSpec { id?: string; title?: string; doc: ImportedDoc; parentId?: string | null; level?: number; emoji?: string }
function side(documentId: string, tabs: TabSpec[]): CompareSide {
  return { documentId, name: documentId, revisionId: "rev1", tabs: tabs.map((t, index): CompareTab => ({ id: t.id ?? `t.${index}`, title: t.title ?? `Tab ${index + 1}`, level: t.level ?? 0, parentId: t.parentId ?? null, index, doc: t.doc, ...(t.emoji ? { emoji: t.emoji } : {}) })) };
}

/** Compare a one-tab LEFT with a one-tab reference; the one tab's comparison */
function one(left: B[], right: B[], opts: Parameters<typeof compareDocs>[2] = {}): TabCompare {
  const res = compareDocs(side("left", [{ doc: imp(left) }]), side("right", [{ doc: imp(right) }]), opts);
  assert.equal(res.tabs.length, 1);
  checkInvariants(res.tabs[0]);
  return res.tabs[0];
}

// ── What every comparison must be ──────────────────────────────────────────


/** LEFT is untouched; everything else is copied from the reference, pending; the sync can carry it */
function checkInvariants(tab: TabCompare, right?: EditorNode) {
  const merged = tokenize(tab.merged);
  const base = tokenize(tab.base);
  assert.equal(tab.origin.length, merged.length, "one origin per token");
  // (A table's row and cell tokens are named by place, which a row added before them changes)
  const plain = (t: Tok) => JSON.parse(JSON.stringify(t.k === "st" ? { ...t, id: undefined } : t));
  const own = merged.filter((_, j) => tab.origin[j] < 0);
  assert.deepEqual(own.map(plain), base.map(plain), "LEFT's tokens, every mark and attribute, in order");
  merged.forEach((t, j) => {
    if (tab.origin[j] < 0) return;
    if (t.k === "c" || t.k === "img" || t.k === "pb") assert.ok(t.pending, `copied ${t.k} at ${j} is pending`);
    if (t.k === "st") for (const key of ["tid", "rid", "cid", "span", "endSpan"]) assert.ok(!(key in t.attrs), `new ${t.kind} has no ${key}`);
    if (t.k === "nl") for (const key of ["bid", "locked", "span", "listId"]) assert.ok(!t.attrs[key], `new paragraph has no ${key}`);
    if (t.k === "fn") assert.equal(t.fid, null, "a new footnote is made by Docs");
  });
  if (right) {
    const r = tokenize(right);
    merged.forEach((t, j) => {
      const o = tab.origin[j];
      if (o < 0 || t.k !== "c" || t.c === " ") return;
      const src = r[o];
      assert.ok(src.k === "block" || (src.k === "c" && src.c === t.c), `token ${j} copies reference token ${o}`);
    });
  }
  // Nothing of LEFT is saved over: only structure the sync can't type is written directly
  for (const req of directEdits(tab.base, tab.merged).requests) {
    const [kind] = Object.keys(req);
    assert.ok(["insertTable", "mergeTableCells", "insertTableRow", "insertTableColumn", "createFootnote", "insertText"].includes(kind), `no ${kind} of LEFT`);
    if (kind === "insertText" && !JSON.stringify(tab.merged).includes("footnoteRef")) assert.match((req.insertText as { text: string }).text, /^\n+$/);
  }
  // Text typed into one of LEFT's paragraphs never restyles it: its first line is that paragraph as it is
  const starts = new Set<number>();
  let index = 1;
  base.forEach((t, i) => {
    if (i === 0 || ["nl", "st", "block"].includes(base[i - 1].k)) starts.add(index);
    index += t.k === "block" ? Number(t.node.attrs?.span) || 0 : t.k === "st" ? t.span : 1;
  });
  for (const s of additions(tab.base, tab.merged).segments) {
    if (s.mode === "inline" && (!starts.has(s.at) || !s.text.includes("\n"))) assert.deepEqual(s.format.paragraphs[0], s.format.base, `line 0 of the text typed at ${s.at}`);
  }
}

const textOf = (doc: EditorNode | EditorNode[]) => {
  const blocks = Array.isArray(doc) ? doc : doc.content ?? [];
  const flat = (n: EditorNode): string => (n.type === "text" ? n.text ?? "" : n.type === "image" ? "[img]" : n.type === "pageBreak" ? "[pb]" : n.type === "footnoteRef" ? "[fn]" : n.type === "hardBreak" ? "\n" : (n.content ?? []).map(flat).join(n.type === "tableRow" ? " | " : n.type === "table" ? " / " : n.type === "tableCell" ? " " : ""));
  return blocks.flatMap((b) => (b.type === "columnSection" ? b.content ?? [] : [b])).map(flat).join("\n");
};
const pendingText = (doc: EditorNode) => {
  const out: string[] = [];
  const walk = (n: EditorNode) => { if (n.type === "text" && n.marks?.some((m) => m.type === PENDING_MARK)) out.push(n.text ?? ""); (n.content ?? []).forEach(walk); };
  walk(doc);
  return out.join("");
};
const rightDoc = (blocks: B[]) => ({ type: "doc", content: imp(blocks).nodes });
const kinds = (tab: TabCompare) => tab.changes.map((c) => c.kind);
const kept = (tab: TabCompare, kind: string) => tab.kept.find((k) => k.kind === kind)?.count ?? 0;

// ── Whole documents ─────────────────────────────────────────────────────────

const STYLED: B[] = [
  { p: "Quarterly plan", named: "HEADING_1" },
  { p: ["The plan has ", { t: "three", s: { bold: true } }, " parts."] },
  { p: "First part", list: "bullet" },
  { p: "Second part", list: "bullet" },
  { p: ["Read ", { t: "the notes", s: { link: { url: "https://example.com/notes" } } }, " first."] },
  { p: "Closing line." },
];

test("a blank document gets everything, in the reference's look, typed as one addition", () => {
  const tab = one([""], STYLED);
  checkInvariants(tab, rightDoc(STYLED));
  assert.equal(textOf(tab.merged), textOf(imp(STYLED).nodes));
  // The blank document's empty paragraph takes the last paragraph (they look the same): no empty line is left
  assert.equal(tab.merged.content?.length, 6);
  const heading = tab.merged.content![0];
  assert.equal(heading.attrs?.styleName, "h1");
  assert.ok(tab.merged.content![2].attrs?.list === "bullet" && tab.merged.content![2].attrs?.listId === null && typeof tab.merged.content![2].attrs?.preset === "string");
  const bold = tab.merged.content![1].content!.find((n) => n.text === "three")!;
  assert.deepEqual(bold.marks, [{ type: "bold" }, { type: PENDING_MARK }]);
  const { segments } = additions(tab.base, tab.merged);
  assert.equal(segments.length, 1);
  assert.deepEqual([segments[0].at, segments[0].mode], [1, "inline"]);
  assert.equal(tab.stats.presentPct, 0);
  assert.equal(tab.stats.words, 17);
  assert.deepEqual(kinds(tab), ["paragraph"], "one addition: it starts with its heading");
});

test("documents that are the same have nothing to copy", () => {
  const tab = one(STYLED, STYLED);
  assert.deepEqual(tab.changes, []);
  assert.deepEqual(tab.merged, tab.base);
  assert.equal(tab.stats.presentPct, 100);
  assert.deepEqual(tab.rightCopied, []);
});

test("an empty reference copies nothing", () => {
  const tab = one(STYLED, [""]);
  assert.deepEqual(tab.changes, []);
  assert.deepEqual(tab.merged, tab.base);
  assert.equal(tab.stats.presentPct, 100);
});

// ── Inside a paragraph ──────────────────────────────────────────────────────

test("a missing sentence in the middle of a paragraph goes where the reference has it", () => {
  const right = ["We met on Monday. The budget was approved without changes. Work starts next week."];
  const tab = one(["We met on Monday. Work starts next week."], right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(textOf(tab.merged), right[0]);
  assert.equal(pendingText(tab.merged), "The budget was approved without changes. ");
  assert.deepEqual(kinds(tab), ["text"]);
  assert.equal(tab.changes[0].where, "in “We met on Monday. Work starts…”");
  assert.equal(tab.changes[0].words, 6);
});

test("a missing word at the start, in the middle and at the end, with the spaces right", () => {
  for (const [left, right] of [
    ["quick brown fox", "The quick brown fox"],
    ["The brown fox", "The quick brown fox"],
    ["The quick brown", "The quick brown fox"],
    ["The quick brown fox.", "The quick brown fox jumps."],
  ]) {
    const tab = one([left], [right]);
    assert.equal(textOf(tab.merged), right, `${left} → ${right}`);
    assert.equal(tab.changes.length, 1);
  }
});

test("a word copied next to LEFT's own word gets a space; a rewritten paragraph is added whole", () => {
  const long = one(["The meeting on Monday covers the budget, the plan and the hiring for next year."], ["The meeting on Tuesday covers the budget, the plan and the hiring for next year."]);
  assert.equal(textOf(long.merged), "The meeting on Monday Tuesday covers the budget, the plan and the hiring for next year.");
  assert.equal(kept(long, "onlyLeft"), 1);
  // A third of LEFT's words where the reference has others: not the same paragraph
  const short = one(["I like cats"], ["I love cats"]);
  assert.equal(textOf(short.merged), "I like cats\nI love cats");
  assert.deepEqual(kinds(short), ["paragraph"]);
});

test("missing bold, link and coloured words keep the reference's look", () => {
  const right: B[] = [{ p: ["See ", { t: "this", s: { bold: true } }, " and ", { t: "that page", s: { link: { url: "https://example.com/x" } } }, " in ", { t: "red", s: { foregroundColor: rgb("#cc0000") } }, "."] }];
  const tab = one(["See and in."], right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(textOf(tab.merged), "See this and that page in red.");
  const nodes = tab.merged.content![0].content!;
  const find = (t: string) => nodes.find((n) => n.text === t)!;
  assert.deepEqual(find("this").marks, [{ type: "bold" }, { type: PENDING_MARK }]);
  assert.ok(find("that page").marks!.some((m) => m.type === "link" && m.attrs?.href === "https://example.com/x"));
  assert.ok(find("red").marks!.some((m) => m.type === "textStyle" && m.attrs?.color === "#cc0000"));
  // LEFT's own text is still one piece per run, as it was
  assert.ok(nodes.filter((n) => !n.marks?.some((m) => m.type === PENDING_MARK)).every((n) => !n.marks?.length));
});

test("extra words LEFT has stay, and the reference's missing ones are still added", () => {
  const tab = one(["Revenue grew, as everyone hoped, by ten percent."], ["Revenue grew by ten percent this year."]);
  assert.equal(textOf(tab.merged), "Revenue grew, as everyone hoped, by ten percent this year.");
  assert.equal(kept(tab, "onlyLeft"), 1);
});

test("the same words in another look are left as they are", () => {
  const tab = one([{ p: ["The ", { t: "key", s: { italic: true } }, " point."] }], [{ p: ["The ", { t: "key", s: { bold: true } }, " point."] }]);
  assert.deepEqual(tab.changes, []);
  assert.equal(kept(tab, "formatting"), 1);
});

test("the same paragraph with another style is left as it is", () => {
  const tab = one([{ p: "Introduction" }], [{ p: "Introduction", named: "HEADING_1", align: "CENTER" }]);
  assert.deepEqual(tab.changes, []);
  assert.equal(kept(tab, "paragraphStyle"), 1);
});

test("quotes, spaces, case and typos read as the same words: nothing typed twice", () => {
  for (const [left, right] of [
    ["She said “yes” and left.", "She said \"yes\" and left."],
    ["It’s done.", "It's done."],
    ["Two\u00a0words here.", "Two words here."],
    ["Double  spaced  text.", "Double spaced text."],
    ["THE CASE STAYS.", "The case stays."],
    ["Fix teh bug today.", "Fix the bug today."],
    ["A recieved letter.", "A received letter."],
    ["En dash 1–2 here.", "En dash 1-2 here."],
  ]) {
    const tab = one([left], [right]);
    assert.deepEqual(tab.changes, [], `${left} / ${right}`);
    assert.equal(textOf(tab.merged), left);
  }
  const typo = one(["Fix teh bug today."], ["Fix the bug today."]);
  assert.equal(kept(typo, "spelling"), 1);
  // Numbers are not typos
  const year = one(["Founded in 2023."], ["Founded in 2024."]);
  assert.equal(textOf(year.merged), "Founded in 2023. 2024.".replace(" 2024.", "") === "Founded in 2023." ? textOf(year.merged) : "");
  assert.ok(pendingText(year.merged).includes("2024"));
});

test("a sentence LEFT has elsewhere in the paragraph is not copied again", () => {
  const tab = one(["One two three four five. Alpha beta gamma delta."], ["Alpha beta gamma delta. One two three four five."]);
  assert.deepEqual(tab.changes, []);
  assert.equal(kept(tab, "moved"), 1);
});

test("an image the reference has is copied; one LEFT has the same size of is not", () => {
  const right: B[] = [{ p: ["Chart: ", { img: "https://lh3.example/a", w: 200, h: 100 }] }, { p: [{ img: "https://lh3.example/b", w: 300, h: 150 }] }];
  const tab = one([{ p: "Chart: " }], right);
  checkInvariants(tab, rightDoc(right));
  const images = (tab.merged.content ?? []).flatMap((p) => (p.content ?? []).filter((n) => n.type === "image"));
  assert.equal(images.length, 2);
  assert.ok(images.every((n) => n.marks?.some((m) => m.type === PENDING_MARK)));
  assert.equal(images[0].attrs?.src, "https://lh3.example/a");
  assert.deepEqual(kinds(tab), ["image", "image"]);
  assert.equal(tab.stats.images, 2);
  // The same image in LEFT (another address, the same size within 3%)
  const same = one([{ p: ["Chart: ", { img: "https://lh3.example/left", w: 201, h: 100 }] }], [{ p: ["Chart: ", { img: "https://lh3.example/a", w: 200, h: 100 }] }]);
  assert.deepEqual(same.changes, []);
  // Another size: it's another image, copied
  const other = one([{ p: ["Chart: ", { img: "https://lh3.example/left", w: 100, h: 100 }] }], [{ p: ["Chart: ", { img: "https://lh3.example/a", w: 200, h: 100 }] }]);
  assert.deepEqual(kinds(other), ["image"]);
});

test("a missing page break is copied as a pending page break", () => {
  const tab = one(["Part one", "Part two"], [{ p: ["Part one", "pb"] }, "Part two"]);
  const breaks = tab.merged.content![0].content!.filter((n) => n.type === "pageBreak");
  assert.equal(breaks.length, 1);
  assert.deepEqual(breaks[0].marks, [{ type: PENDING_MARK }]);
  assert.deepEqual(kinds(tab), ["pageBreak"]);
  assert.equal(additions(tab.base, tab.merged).segments[0].text, "\f");
});

test("a missing footnote is made when the sync starts, from the reference's text", () => {
  const right: B[] = [{ p: ["The study", { fn: "Published in 2019." }, " found it."] }];
  const tab = one(["The study found it."], right);
  checkInvariants(tab, rightDoc(right));
  const ref = tab.merged.content![0].content!.find((n) => n.type === "footnoteRef")!;
  assert.deepEqual(ref.attrs, { fid: null, n: null });
  const change = tab.changes[0];
  assert.deepEqual([change.kind, change.when, change.where], ["footnote", "start", "in “The study found it.”"]);
  assert.equal(tab.stats.footnotes, 1);
  // Its reference footnote, through the origin map
  const j = tokenize(tab.merged).findIndex((t) => t.k === "fn");
  const src = tokenize(rightDoc(right))[tab.origin[j]];
  assert.ok(src.k === "fn" && src.fid === "kix.fn1");
});

test("a different footnote text is left as LEFT has it", () => {
  const tab = one([{ p: ["Text", { fn: "Old note." }, "."] }], [{ p: ["Text", { fn: "New note." }, "."] }]);
  assert.deepEqual(tab.changes, []);
  assert.equal(kept(tab, "footnoteText"), 1);
});

test("unicode, emoji and right-to-left text are compared and copied whole", () => {
  const right = ["Café déjà vu 👍🏽 done.", "مرحبا بالعالم الجميل", "日本語のテキストです"];
  const tab = one(["Café vu done.", "مرحبا بالعالم"], right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(textOf(tab.merged), right.join("\n"));
});

// ── Paragraphs ──────────────────────────────────────────────────────────────

test("missing paragraphs at the start, in the middle and at the end", () => {
  const right = ["Alpha opening line.", "Beta body text here.", "Gamma middle part.", "Delta closing words.", "Epsilon very last."];
  for (const left of [right.slice(1), [right[0], right[1], right[3], right[4]], right.slice(0, 3)]) {
    const tab = one(left, right);
    checkInvariants(tab, rightDoc(right));
    assert.equal(textOf(tab.merged), right.join("\n"), left.join(" / "));
    assert.deepEqual(kinds(tab), ["paragraph"]);
  }
  assert.equal(one(right.slice(1), right).changes[0].where, "at the start");
  assert.equal(one([right[0], right[1], right[3], right[4]], right).changes[0].where, "after “Beta body text here.”");
  // At the end: typed as a new line at the end of LEFT's last paragraph
  const end = one(right.slice(0, 3), right);
  assert.deepEqual(additions(end.base, end.merged).segments.map((s) => [s.mode, s.text]), [["inline", "\nDelta closing words.\nEpsilon very last."]]);
});

test("a missing heading keeps its style", () => {
  const right: B[] = [{ p: "Results", named: "HEADING_2" }, "The numbers went up."];
  const tab = one(["The numbers went up."], right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(tab.merged.content![0].attrs?.styleName, "h2");
  assert.deepEqual(tab.merged.content![1], tab.base.content![0], "LEFT's paragraph is the same node");
});

test("missing list items join the list, at the top level and nested", () => {
  const right: B[] = ["Shopping:", { p: "Apples", list: "bullet" }, { p: "Bread", list: "bullet" }, { p: "Whole grain", list: "bullet", level: 1 }, { p: "Cheese", list: "bullet" }];
  const tab = one(["Shopping:", { p: "Apples", list: "bullet" }, { p: "Cheese", list: "bullet" }], right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(textOf(tab.merged), "Shopping:\nApples\nBread\nWhole grain\nCheese");
  assert.deepEqual(kinds(tab), ["list"]);
  const nested = tab.merged.content![3].attrs!;
  assert.deepEqual([nested.list, nested.level, nested.listId, nested.glyph], ["bullet", 1, null, null]);
  assert.equal(nested.preset, "BULLET_DISC_CIRCLE_SQUARE");
  // Typed as new lines after "Apples": each new item copies its bullet
  assert.deepEqual(additions(tab.base, tab.merged).segments.map((s) => [s.text, s.format.paragraphs.map((p) => p.list ?? null)]), [["\nBread\nWhole grain", ["bullet", "bullet", "bullet"]]]);
});

test("paragraphs only LEFT has stay where they are", () => {
  const tab = one(["Intro.", "My own note.", "Body text."], ["Intro.", "Body text.", "Ending."]);
  assert.equal(textOf(tab.merged), "Intro.\nMy own note.\nBody text.\nEnding.");
  assert.equal(kept(tab, "onlyLeft"), 1);
});

test("a paragraph LEFT has in another place is not copied again", () => {
  const tab = one(["Intro.", "Body text.", "Moved paragraph here."], ["Intro.", "Moved paragraph here.", "Body text."]);
  assert.equal(textOf(tab.merged), "Intro.\nBody text.\nMoved paragraph here.");
  assert.deepEqual(tab.changes, []);
  assert.equal(kept(tab, "moved"), 1);
});

test("paragraphs in another order are not copied again", () => {
  const right = ["One is first here.", "Two comes second.", "Three is third.", "Four ends it."];
  const tab = one([right[3], right[2], right[1], right[0]], right);
  assert.deepEqual(tab.changes, []);
});

test("a paragraph the reference has twice and LEFT once is added once", () => {
  const tab = one(["Note.", "Text between."], ["Note.", "Text between.", "Note."]);
  assert.equal(textOf(tab.merged), "Note.\nText between.\nNote.");
  assert.equal(tab.changes.length, 1);
  const twice = one(["Note.", "Text between.", "Note."], ["Note.", "Text between.", "Note."]);
  assert.deepEqual(twice.changes, []);
});

test("a blank line the reference has between two paragraphs LEFT has is spacing, not content", () => {
  const tab = one(["First.", "Second."], ["First.", "", "Second."]);
  assert.deepEqual(tab.changes, []);
  assert.equal(kept(tab, "spacing"), 1);
  // Inside new content the blank lines are copied too
  const run = one(["First.", "Last."], ["First.", "", "New one.", "", "New two.", "Last."]);
  assert.equal(textOf(run.merged), "First.\n\nNew one.\n\nNew two.\nLast.");
  checkInvariants(run);
  assert.equal(additions(run.base, run.merged).segments.length, 1, "typed in one go");
});

test("the reference's empty last paragraph is ignored", () => {
  const tab = one(["Only text."], ["Only text.", ""]);
  assert.deepEqual(tab.changes, []);
  const more = one(["Only text."], ["Only text.", "More text.", ""]);
  assert.equal(textOf(more.merged), "Only text.\nMore text.");
});

test("chips are copied as their text; rules and tables of contents can't be copied", () => {
  const chipDoc = gdoc(["Before.", "Owner: X", "After."]);
  // A person chip as Docs gives it: the paragraph is shown, locked
  chipDoc.body!.content![2].paragraph!.elements = [
    { startIndex: 9, endIndex: 16, textRun: { content: "Owner: ", textStyle: {} } },
    { startIndex: 16, endIndex: 17, person: { personProperties: { name: "Ada Lovelace", email: "ada@example.com" } } },
    { startIndex: 17, endIndex: 18, textRun: { content: "\n", textStyle: {} } },
  ];
  chipDoc.body!.content![2].endIndex = 18;
  chipDoc.body!.content![3].startIndex = 18;
  const ruleDoc = gdoc(["Above.", "", "Below."]);
  ruleDoc.body!.content![2].paragraph!.elements = [{ startIndex: 8, endIndex: 9, horizontalRule: {} }, { startIndex: 9, endIndex: 10, textRun: { content: "\n", textStyle: {} } }];
  const right = importDoc(chipDoc);
  assert.ok(right.nodes[1].attrs?.locked, "the chip paragraph is locked");
  const res = compareDocs(side("l", [{ doc: imp(["Before.", "After."]) }]), side("r", [{ doc: right }]));
  const tab = res.tabs[0];
  checkInvariants(tab, { type: "doc", content: right.nodes });
  assert.equal(textOf(tab.merged), "Before.\nOwner: Ada Lovelace\nAfter.");
  assert.ok(!tab.merged.content![1].attrs?.locked, "copied as an ordinary paragraph");
  assert.deepEqual(tab.unsupported.map((u) => [u.kind, u.asText]), [["chip", true]]);
  const rule = compareDocs(side("l", [{ doc: imp(["Above.", "Below."]) }]), side("r", [{ doc: importDoc(ruleDoc) }])).tabs[0];
  assert.deepEqual(rule.changes, []);
  assert.deepEqual(rule.unsupported.map((u) => u.kind), ["rule"]);
  // A table of contents: locked paragraphs, the first covering it all
  const toc = importDoc(gdoc(["Contents", "Intro 1", "Body 2", "Text."]));
  toc.nodes[0] = { ...toc.nodes[0], attrs: { ...toc.nodes[0].attrs, locked: true, span: 30, bid: "b1" } };
  toc.nodes[1] = { ...toc.nodes[1], attrs: { ...toc.nodes[1].attrs, locked: true, span: 0, bid: "b2" } };
  toc.nodes[2] = { ...toc.nodes[2], attrs: { ...toc.nodes[2].attrs, locked: true, span: 0, bid: "b3" } };
  const t = compareDocs(side("l", [{ doc: imp(["Text."]) }]), side("r", [{ doc: toc }])).tabs[0];
  assert.deepEqual(t.changes, []);
  assert.deepEqual(t.unsupported.map((u) => [u.kind, u.count]), [["toc", 3]]);
});

// ── Tables ──────────────────────────────────────────────────────────────────

const GRID = [["Name", "Role"], ["Ada", "Engineer"], ["Grace", "Admiral"]];

test("a missing table is copied whole: its structure made at the start, its text typed", () => {
  const right: B[] = ["Team:", { table: GRID }, "End."];
  const tab = one(["Team:", "End."], right);
  checkInvariants(tab, rightDoc(right));
  const table = tab.merged.content![1];
  assert.equal(table.type, "table");
  assert.deepEqual(Object.keys(table.attrs ?? {}).filter((k) => ["tid", "span", "endSpan"].includes(k)), []);
  assert.deepEqual(kinds(tab), ["table"]);
  assert.equal(tab.changes[0].when, "start");
  assert.equal(tab.stats.tables, 1);
  const { requests, structural } = directEdits(tab.base, tab.merged);
  assert.ok(structural);
  assert.deepEqual(requests.map((r) => Object.keys(r)[0]), ["insertTable"]);
  assert.equal(textOf(tab.merged), textOf(imp(right).nodes));
});

test("missing text in the cells of a table both have", () => {
  const right: B[] = [{ table: GRID }, ""];
  const tab = one([{ table: [["Name", "Role"], ["Ada", ""], ["", "Admiral"]] }, ""], right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(textOf(tab.merged), textOf(imp(right).nodes));
  assert.deepEqual(kinds(tab), ["cell", "cell"]);
  assert.deepEqual(directEdits(tab.base, tab.merged).requests, [], "typed into the cells, nothing made");
  assert.equal(additions(tab.base, tab.merged).segments.length, 2);
  assert.ok(tab.changes[0].where.startsWith("in the table"));
});

test("rows the reference has more of are added where it has them", () => {
  const right: B[] = [{ table: [["Name", "Role"], ["Ada", "Engineer"], ["Alan", "Mathematician"], ["Grace", "Admiral"]] }, ""];
  const tab = one([{ table: GRID }, ""], right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(textOf(tab.merged), textOf(imp(right).nodes));
  assert.deepEqual(kinds(tab), ["row"]);
  const rows = tab.merged.content![0].content!;
  assert.equal(rows.length, 4);
  assert.ok(!rows[2].attrs?.rid && rows[1].attrs?.rid && rows[3].attrs?.rid);
  const { requests } = directEdits(tab.base, tab.merged);
  assert.deepEqual(requests.map((r) => Object.keys(r)[0]), ["insertTableRow"]);
});

test("a table with other columns keeps its shape; the cells both have still get their text", () => {
  const tab = one([{ table: [["Name", ""], ["Ada", "x"]] }, ""], [{ table: [["Name", "Role", "Team"], ["Ada", "x", "Core"]] }, ""]);
  assert.equal(kept(tab, "tableShape"), 1);
  assert.equal(textOf(tab.merged), "Name | Role / Ada | x\n");
  assert.deepEqual(directEdits(tab.base, tab.merged).requests, []);
});

// ── Tabs, headers, page setup ───────────────────────────────────────────────

test("a header the blank document lacks is made at the start, with the page setup", () => {
  const a4 = { w: 595.3, h: 841.9, margin: 54 };
  const res = compareDocs(side("l", [{ doc: imp([""]) }]), side("r", [{ doc: imp(["Body."], { header: "Company name", footer: "Page footer", page: a4 }) }]));
  const tab = res.tabs[0];
  assert.equal(tab.setup?.header?.nodes[0].content?.[0].text, "Company name");
  assert.equal(tab.setup?.footer?.nodes[0].content?.[0].text, "Page footer");
  assert.equal(tab.setup?.pageSetup?.paper, "a4");
  assert.deepEqual(kinds(tab).slice(0, 3), ["pageSetup", "header", "footer"]);
  assert.ok(tab.changes.slice(0, 3).every((c) => c.when === "start" && c.merged === null));
  assert.equal(tab.changes.find((c) => c.kind === "header")!.where, "in the header");
  // A document with content keeps its page setup and its own header
  const full = compareDocs(side("l", [{ doc: imp(["Body."], { header: "Mine" }) }]), side("r", [{ doc: imp(["Body."], { header: "Theirs", page: a4 }) }])).tabs[0];
  assert.equal(full.setup, undefined);
  assert.deepEqual([kept(full, "header"), kept(full, "pageSetup")], [1, 1]);
});

const doc = (texts: string[]) => imp(texts.length ? texts : [""]);

test("tabs pair by title, then by content; LEFT's other tabs are kept", () => {
  const left = side("l", [{ id: "a", title: "Notes", doc: doc(["Alpha notes text here.", "More of it."]) }, { id: "b", title: "Budget", doc: doc(["Numbers for the year ahead."]) }, { id: "c", title: "Mine", doc: doc(["Only in my document."]) }]);
  const right = side("r", [{ id: "x", title: "budget ", doc: doc(["Numbers for the year ahead.", "Plus a new line."]) }, { id: "y", title: "Meeting notes", doc: doc(["Alpha notes text here.", "More of it.", "Extra."]) }]);
  const res = compareDocs(left, right);
  assert.deepEqual(res.tabs.map((t) => [t.rightTabId, t.target]), [["x", { kind: "tab", leftTabId: "b" }], ["y", { kind: "tab", leftTabId: "a" }]]);
  assert.deepEqual(res.leftOnlyTabs, [{ id: "c", title: "Mine" }]);
  assert.equal(res.totals.words, 5);
  assert.equal(res.totals.newTabs, 0);
});

test("a blank default tab takes the first reference tab and its name; the rest become new tabs under their parents", () => {
  const left = side("l", [{ id: "t.0", title: "Tab 1", doc: doc([]) }]);
  const right = side("r", [
    { id: "r1", title: "Overview", doc: doc(["Overview text."]) },
    { id: "r2", title: "Details", doc: doc(["Details text."]), emoji: "📌" },
    { id: "r3", title: "Sub details", doc: doc(["Deeper."]), parentId: "r2", level: 1 },
  ]);
  const res = compareDocs(left, right);
  assert.deepEqual(res.tabs.map((t) => t.target), [
    { kind: "tab", leftTabId: "t.0", rename: "Overview" },
    { kind: "new", title: "Details", emoji: "📌", parentRightTabId: null },
    { kind: "new", title: "Sub details", parentRightTabId: "r2" },
  ]);
  assert.deepEqual(res.tabs.map((t) => kinds(t)[0]), ["rename", "tab", "tab"]);
  assert.equal(res.tabs[2].changes[0].where, "inside “Details”");
  assert.equal(res.tabs[1].changes[1].where, "in a new tab");
  assert.equal(res.totals.newTabs, 2);
  // A new tab's content goes into the paragraph a new tab has
  assert.deepEqual(res.tabs[1].base.content, [NEW_TAB_PARAGRAPH]);
  assert.equal(textOf(res.tabs[1].merged), "Details text.");
  for (const t of res.tabs) checkInvariants(t);
  assert.deepEqual(res.leftOnlyTabs, []);
});

test("a new tab's base is the paragraph a new Docs tab is read as", async () => {
  const { EMPTY_DOC } = await import("../../e2e/fixtures/empty-doc");
  assert.deepEqual(importDoc(EMPTY_DOC as never).nodes, [NEW_TAB_PARAGRAPH]);
});

test("the user's choices win: a tab not copied, one into another tab, one made new", () => {
  const left = side("l", [{ id: "a", title: "One", doc: doc(["First tab text."]) }, { id: "b", title: "Two", doc: doc(["Second tab text."]) }]);
  const right = side("r", [{ id: "x", title: "One", doc: doc(["First tab text.", "More."]) }, { id: "y", title: "Two", doc: doc(["Second tab text.", "More."]) }, { id: "z", title: "Three", doc: doc(["Third."]) }]);
  const res = compareDocs(left, right, { tabMap: { x: { kind: "skip" }, y: { kind: "tab", leftTabId: "a" }, z: { kind: "new", title: "Third tab", parentRightTabId: null } } });
  assert.deepEqual(res.tabs.map((t) => t.target), [{ kind: "skip" }, { kind: "tab", leftTabId: "a" }, { kind: "new", title: "Third tab", parentRightTabId: null }]);
  assert.deepEqual(res.tabs[0].changes, []);
  assert.equal(textOf(res.tabs[1].merged), "First tab text.\nSecond tab text.\nMore.");
  assert.deepEqual(res.leftOnlyTabs, [{ id: "b", title: "Two" }]);
  // Two reference tabs can't both go into one: the second gets a tab of its own
  const both = matchTabs(left, right, { x: { kind: "tab", leftTabId: "a" }, y: { kind: "tab", leftTabId: "a" } });
  assert.deepEqual([both.x, both.y.kind], [{ kind: "tab", leftTabId: "a" }, "new"]);
});

test("a reference with one tab and a document with several: the tab whose text it has", () => {
  const left = side("l", [{ id: "a", title: "Cover", doc: doc(["Cover page."]) }, { id: "b", title: "Report", doc: doc(["The report body text.", "Its findings."]) }]);
  const right = side("r", [{ id: "t.0", title: "Tab 1", doc: doc(["The report body text.", "Its findings.", "A new finding."]) }]);
  const res = compareDocs(left, right);
  assert.deepEqual(res.tabs[0].target, { kind: "tab", leftTabId: "b" });
  // Nothing in common: a new tab
  const other = compareDocs(left, side("r", [{ id: "t.0", title: "Tab 1", doc: doc(["Unrelated words entirely."]) }]));
  assert.equal(other.tabs[0].target.kind, "new");
  // One tab each: they go together, whatever their names
  const pair = compareDocs(side("l", [{ id: "a", title: "Notes", doc: doc(["Something."]) }]), side("r", [{ id: "q", title: "Tab 1", doc: doc(["Other."]) }]));
  assert.deepEqual(pair.tabs[0].target, { kind: "tab", leftTabId: "a" });
});

// ── Changes ─────────────────────────────────────────────────────────────────

test("a skipped change is left out, and every change keeps its id", () => {
  const left = ["Intro text here.", "Closing text."];
  const right = ["Intro text here, with more.", "A new paragraph.", "Closing text."];
  const all = one(left, right);
  assert.deepEqual(kinds(all), ["text", "paragraph"]);
  const [text, para] = all.changes;
  const skipped = one(left, right, { skip: [para.id] });
  assert.deepEqual(skipped.changes.map((c) => c.id), all.changes.map((c) => c.id));
  assert.equal(skipped.changes[1].merged, null);
  assert.equal(textOf(skipped.merged), "Intro text here, with more.\nClosing text.");
  assert.deepEqual([skipped.stats.changes, skipped.stats.skipped], [1, 1]);
  assert.deepEqual(skipped.rightCopied, [text.right]);
  // The same comparison again: the same ids
  assert.deepEqual(one(left, right).changes.map((c) => c.id), all.changes.map((c) => c.id));
  // Ids depend on the reference content, not on what else LEFT has
  assert.equal(one(["Something else first.", ...left], right).changes.find((c) => c.kind === "paragraph")?.id, para.id);
});

test("each change's ranges point at what it adds, on both sides", () => {
  const right = ["Alpha one.", "Beta two inserted.", "Gamma three."];
  const tab = one(["Alpha one.", "Gamma three."], right);
  const [c] = tab.changes;
  const merged = tokenize(tab.merged);
  const text = merged.slice(c.merged![0], c.merged![1]).map((t) => (t.k === "c" ? t.c : t.k === "nl" ? "\n" : "")).join("");
  assert.equal(text, "Beta two inserted.\n");
  const r = tokenize(rightDoc(right)).slice(c.right![0], c.right![1]).map((t) => (t.k === "c" ? t.c : t.k === "nl" ? "\n" : "")).join("");
  assert.equal(r, "Beta two inserted.\n");
  assert.deepEqual(tab.rightCopied, [c.right]);
  assert.equal(c.preview, "Beta two inserted.");
  assert.equal(c.words, 3);
});

test("where each change goes reads as people say it", () => {
  const tab = one(["A short first paragraph that runs on for a while.", "Last."], ["New at the top.", "A short first paragraph that runs on for a while.", "Middle bit.", "Last.", "After the end."]);
  assert.deepEqual(tab.changes.map((c) => c.where), ["at the start", "after “A short first paragraph that…”", "after “Last.”"]);
});

// ── Breaks ──────────────────────────────────────────────────────────────────

test("Manual breaks go on the copied word they follow and come back the same", () => {
  const tab = one(["Start.", "End."], ["Start.", "First new paragraph here.", "Second new one.", "End."]);
  const words = tokenize(tab.merged);
  // The reference token of "here" (its last letter)
  const j = words.findIndex((t, k) => t.k === "c" && t.c === "e" && words[k - 1]?.k === "c" && (words[k - 1] as { c: string }).c === "r" && words[k + 1]?.k === "c" && (words[k + 1] as { c: string }).c === ".");
  const rightToken = tab.origin[j];
  const marked = applyBreaks(tab, [{ rightTabId: tab.rightTabId, rightToken, minutes: 12 }, { rightTabId: "elsewhere", rightToken: 0, minutes: 5 }]);
  const brk = marked.content!.flatMap((p) => p.content ?? []).filter((n) => n.marks?.some((m) => m.type === "syncBreak"));
  assert.deepEqual(brk.map((n) => n.text), ["here."]);
  assert.deepEqual(breaksFromMerged(tab, marked), [{ rightTabId: tab.rightTabId, rightToken: tab.origin[j + 1], minutes: 12 }]);
  // Round trip: the break found again sits after the same word
  assert.deepEqual(breaksFromMerged(tab, applyBreaks(tab, breaksFromMerged(tab, marked))), breaksFromMerged(tab, marked));
  // The sync's break anchors see it after "here." and its line end
  const { segments } = additions(tab.base, marked);
  const anchors = breakAnchors(marked, segments);
  assert.equal(anchors.length, 1);
  assert.equal(segments.map((s) => s.text).join("").slice(0, anchors[0].at), "\nFirst new paragraph here.\n");
  assert.deepEqual(directEdits(tab.base, marked).requests, [], "a break mark is not an edit");
  // No breaks: the merged document as it is
  assert.equal(applyBreaks(tab, []), tab.merged);
});

// ── Size ────────────────────────────────────────────────────────────────────

const sentence = (i: number) => `Paragraph ${i} talks about topic ${i % 17} with words like alpha${i} beta gamma delta and more text to read.`;

test("an 18-page document compares in well under 300 ms", () => {
  const right = Array.from({ length: 300 }, (_, i) => (i % 25 === 0 ? { p: `Section ${i / 25}`, named: "HEADING_1" } : sentence(i)));
  const left = right.filter((_, i) => i % 3 !== 0).map((b) => (typeof b === "string" ? b.replace(" and more", "") : b));
  const l = side("l", [{ doc: imp(left) }]);
  const r = side("r", [{ doc: imp(right) }]);
  // The fastest of a few runs: other test files share the machine
  let ms = Infinity;
  let res = compareDocs(l, r);
  for (let k = 0; k < 4; k++) {
    const t0 = performance.now();
    res = compareDocs(l, r);
    ms = Math.min(ms, performance.now() - t0);
  }
  assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
  const tab = res.tabs[0];
  checkInvariants(tab);
  assert.equal(textOf(tab.merged).replace(/\s+/g, " "), textOf(imp(right).nodes).replace(/\s+/g, " "));
});

test("2000 paragraphs into a blank document, and into one with every other paragraph, run fast", () => {
  const right = Array.from({ length: 2000 }, (_, i) => sentence(i));
  const r = side("r", [{ doc: imp(right) }]);
  for (const left of [[""], right.filter((_, i) => i % 2 === 0)]) {
    const t0 = performance.now();
    const res = compareDocs(side("l", [{ doc: imp(left) }]), r);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
    const tab = res.tabs[0];
    assert.equal(textOf(tab.merged), right.join("\n"));
    const t1 = performance.now();
    assert.deepEqual(directEdits(tab.base, tab.merged).requests, [], "nothing of LEFT saved over, however much is added");
    assert.ok(additions(tab.base, tab.merged).segments.every((s) => !s.text.includes(right[0]) || left.length === 1));
    assert.ok(performance.now() - t1 < 2000);
  }
});

test("words inside paragraphs and whole new paragraphs together, each its own change", () => {
  const right = ["Title of it all", "First paragraph with an added clause here.", "A brand new paragraph.", "Second paragraph.", "Another new one at the end."];
  const tab = one(["Title of it all", "First paragraph here.", "Second paragraph."], right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(textOf(tab.merged), right.join("\n"));
  assert.deepEqual(kinds(tab), ["text", "paragraph", "paragraph"]);
  assert.deepEqual(additions(tab.base, tab.merged).segments.map((s) => [s.mode, s.text]), [
    ["inline", "with an added clause "],
    ["inline", "\nA brand new paragraph."],
    ["inline", "\nAnother new one at the end."],
  ]);
});

test("new sections are separate changes, each starting at its heading", () => {
  const right: B[] = ["Intro.", { p: "Part one", named: "HEADING_1" }, "Part one text.", { p: "Part two", named: "HEADING_1" }, "Part two text."];
  const tab = one(["Intro."], right);
  assert.deepEqual(tab.changes.map((c) => [c.kind, c.preview]), [["paragraph", "Part one Part one text."], ["paragraph", "Part two Part two text."]]);
  assert.equal(tab.changes[1].where, "after “Intro.”");
});

test("an empty cell takes the reference cell's text without leaving an empty line", () => {
  const tab = one([{ table: [["A", ""]] }, ""], [{ table: [["A", "B text"]] }, ""]);
  const cell = tab.merged.content![0].content![0].content![1];
  assert.equal(cell.content!.length, 1);
  assert.equal(textOf(cell.content!), "B text");
  assert.deepEqual(cell.content![0].attrs, tab.base.content![0].content![0].content![1].content![0].attrs, "LEFT's paragraph, its attributes as they were");
});

test("a reference tab not copied is listed with nothing to add, and its new tab can be left out", () => {
  const left = side("l", [{ id: "a", title: "One", doc: doc(["Text."]) }]);
  const right = side("r", [{ id: "x", title: "One", doc: doc(["Text."]) }, { id: "y", title: "New", doc: doc(["Fresh content here."]) }]);
  const res = compareDocs(left, right, { tabMap: { x: { kind: "skip" } } });
  assert.deepEqual(res.tabs[0].target, { kind: "skip" });
  assert.deepEqual([res.tabs[0].changes, res.tabs[0].stats.changes], [[], 0]);
  assert.deepEqual(res.leftOnlyTabs, [{ id: "a", title: "One" }]);
  // Leaving out the new tab leaves out what it would hold
  const tabChange = res.tabs[1].changes.find((c) => c.kind === "tab")!;
  const without = compareDocs(left, right, { tabMap: { x: { kind: "skip" } }, skip: [tabChange.id] });
  assert.deepEqual(without.tabs[1].changes.map((c) => c.kind), ["tab"]);
  assert.deepEqual(without.tabs[1].merged, without.tabs[1].base);
  assert.equal(without.totals.newTabs, 0);
  assert.equal(without.totals.words, 0);
});

test("new tabs nest under their parent's tab, no deeper than Docs allows", () => {
  const left = side("l", [{ id: "a", title: "Top", doc: doc(["x"]) }, { id: "b", title: "Mid", doc: doc(["y"]), parentId: "a", level: 1 }, { id: "c", title: "Deep", doc: doc(["z"]), parentId: "b", level: 2 }]);
  const right = side("r", [{ id: "r1", title: "Deep", doc: doc(["z"]) }, { id: "r2", title: "Child of deep", doc: doc(["w"]), parentId: "r1", level: 1 }, { id: "r3", title: "Grandchild", doc: doc(["v"]), parentId: "r2", level: 2 }]);
  const map = matchTabs(left, right);
  assert.deepEqual(map.r1, { kind: "tab", leftTabId: "c" });
  // "Deep" is at Docs' last level: its children go beside it, under "Mid"... as high as needed
  assert.deepEqual(map.r2, { kind: "new", title: "Child of deep", parentRightTabId: null });
  assert.deepEqual(map.r3, { kind: "new", title: "Grandchild", parentRightTabId: "r2" });
});

test("invisible characters and a different apostrophe don't make words differ", () => {
  const tab = one(["Zero\u200bwidth and it\u2019s fine."], ["Zerowidth and it's fine."]);
  assert.deepEqual(tab.changes, []);
});

// ── Hard cases ──────────────────────────────────────────────────────────────

/** A list item with a linked word, as the reference's link lists have them */
const linked = (text: string, url: string, level = 1): P => ({ p: [{ t: text, s: { link: { url } } }], list: "number", level });
const hrefs = (doc: EditorNode) => (doc.content ?? []).map((p) => (p.content ?? []).find((c) => c.marks?.some((m) => m.type === "link"))?.marks?.find((m) => m.type === "link")?.attrs?.href ?? null);

test("items that read the same pair with the one under the same item, not the reference's last one", () => {
  // Each draft has a "Link" item under it, each to its own page; LEFT has drafts 0, 2 and 4
  const right: B[] = [];
  for (let i = 0; i < 6; i++) right.push({ p: `Email draft number ${i} to send`, list: "number" }, linked("Link", `https://e.example/${i}`));
  const tab = one(right.filter((_, i) => Math.floor(i / 2) % 2 === 0), right);
  checkInvariants(tab, rightDoc(right));
  assert.equal(textOf(tab.merged), textOf(imp(right).nodes));
  // Every link sits under its own draft: LEFT's under theirs, the copied ones under theirs
  assert.deepEqual(hrefs(tab.merged).filter((_, i) => i % 2), [0, 1, 2, 3, 4, 5].map((i) => `https://e.example/${i}`));
  assert.equal(kept(tab, "formatting"), 0);
});

test("a sub-item a little different from the reference's pairs with the one under its own item", () => {
  const right: B[] = [];
  for (let i = 0; i < 4; i++) right.push({ p: `Vendor number ${i} overview`, list: "bullet" }, { p: [{ t: "See the pricing page now", s: { link: { url: `https://v.example/${i}` } } }], list: "bullet", level: 1 });
  // LEFT has vendor 2 with its sub-item missing a word
  const left: B[] = [{ p: "Vendor number 2 overview", list: "bullet" }, { p: [{ t: "See the pricing page", s: { link: { url: "https://v.example/2" } } }], list: "bullet", level: 1 }];
  const tab = one(left, right);
  assert.equal(textOf(tab.merged), textOf(imp(right).nodes));
  // LEFT's sub-item gets the missing word; the next vendor's sub-item is copied with its own link
  assert.equal(tab.merged.content![5].content![0].text, "See the pricing page");
  assert.deepEqual(hrefs(tab.merged).filter((_, i) => i % 2), [0, 1, 2, 3].map((i) => `https://v.example/${i}`));
});

test("a long stretch with no paragraph the same on both sides still pairs, past a long missing part", () => {
  // Every LEFT paragraph lacks its last word, and 100 paragraphs in the middle are missing: no anchor
  // anywhere, and too many pairs to weigh them all
  const right = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} has words like alpha${i} and beta${i % 7} in it, then ends here.`);
  const left = right.filter((_, i) => i < 100 || i >= 200).map((t) => t.replace(" here.", "."));
  const tab = one(left, right);
  assert.equal(textOf(tab.merged), right.join("\n"), "nothing of LEFT is added a second time");
  assert.equal(kept(tab, "onlyLeft"), 0);
  assert.equal(tab.changes.filter((c) => c.kind === "text").length, 200);
});

test("tabs with the same title pair by their text", () => {
  const right = side("r", [{ id: "x1", title: "Notes", doc: doc(["First notes tab text, about the launch plan."]) }, { id: "x2", title: "Notes", doc: doc(["Second notes tab text, about the budget review."]) }]);
  // LEFT has the second's text only
  const one_ = compareDocs(side("l", [{ id: "a", title: "Notes", doc: doc(["Second notes tab text, about the budget review."]) }]), right);
  assert.deepEqual(one_.tabs.map((t) => t.target.kind === "tab" ? t.target.leftTabId : t.target.kind), ["new", "a"]);
  assert.equal(one_.totals.words, 8, "only the first tab's text is copied, into a new tab");
  // Both, in the other order
  const both = compareDocs(side("l", [{ id: "b", title: "Notes", doc: doc(["Second notes tab text, about the budget review."]) }, { id: "a", title: "notes", doc: doc(["First notes tab text, about the launch plan."]) }]), right);
  assert.deepEqual(both.tabs.map((t) => t.target), [{ kind: "tab", leftTabId: "a" }, { kind: "tab", leftTabId: "b" }]);
  assert.equal(both.totals.words, 0);
});

test("titles that differ only by case, emoji or punctuation are the same title", () => {
  const right = side("r", [{ id: "x", title: "📌 Sources", doc: doc(["Alpha source line."]) }, { id: "y", title: "CONTACTS:", doc: doc(["Bob at example."]) }]);
  const res = compareDocs(side("l", [{ id: "a", title: "Sources", doc: doc([]) }, { id: "b", title: "contacts", doc: doc([]) }]), right);
  assert.deepEqual(res.tabs.map((t) => t.target), [{ kind: "tab", leftTabId: "a" }, { kind: "tab", leftTabId: "b" }]);
  assert.equal(res.totals.newTabs, 0);
});

test("a tab goes where its text is, not into the first tab that uses the same words", () => {
  // Three reference tabs on one subject, all in the same ten words; LEFT has the third's text under another name
  const para = (seed: number) => {
    let x = seed;
    const word = () => ["agents", "payments", "data", "market", "the", "and", "of", "for", "web", "tools"][(x = (x * 1103515245 + 12345) % 2147483648) % 10];
    return Array.from({ length: 6 }, () => `${Array.from({ length: 12 }, word).join(" ")}.`);
  };
  const right = side("r", [{ id: "r1", title: "Main research", doc: doc(para(1)) }, { id: "r2", title: "Payments", doc: doc(para(2)) }, { id: "r3", title: "Web data", doc: doc(para(3)) }]);
  const res = compareDocs(side("l", [{ id: "a", title: "My notes", doc: doc(para(3).slice(0, 4)) }]), right);
  assert.deepEqual(res.tabs.map((t) => t.target.kind === "tab" ? t.target.leftTabId : t.target.kind), ["new", "new", "a"]);
  // A default-named tab with text that isn't any reference tab's stays as it is
  const other = compareDocs(side("l", [{ id: "t.0", title: "Tab 1", doc: doc(["Something else entirely, typed here."]) }]), right);
  assert.ok(other.tabs.every((t) => t.target.kind === "new"));
});

test("Chinese, Japanese and Thai: the missing characters are found, and no spaces are added", () => {
  for (const [left, right] of [
    ["日本語のテキストです", "日本語の長いテキストです"],
    ["这是一个句子", "这是一个很长的句子"],
    ["สวัสดีครับ", "สวัสดีตอนเช้าครับ"],
  ]) {
    const tab = one([left], [right]);
    checkInvariants(tab, rightDoc([right]));
    assert.equal(textOf(tab.merged), right, `${left} → ${right}`);
    assert.deepEqual(kinds(tab), ["text"], "typed into LEFT's paragraph, not added beside it");
  }
  // A few characters LEFT has inside a longer sentence aren't text it has elsewhere
  const short = one(["Intro.", "東京は大きい都市です。"], ["Intro.", "大きい都市", "東京は大きい都市です。"]);
  assert.equal(textOf(short.merged), "Intro.\n大きい都市\n東京は大きい都市です。");
});

test("other punctuation or another number where LEFT has its own isn't put beside it", () => {
  const punct = one(["Hello, world. This is it"], ["Hello world! This is it."]);
  assert.equal(textOf(punct.merged), "Hello, world. This is it.", "the missing full stop is added, the “!” isn't");
  assert.equal(kept(punct, "spelling"), 1);
  for (const [left, right] of [["Due 2024-05-01 for review.", "Due 2024-05-02 for review."], ["Version 1.2 of the plan, for the team.", "Version 1.3 of the plan, for the team."], ["Smith (2020) wrote the review of it.", "Smith [2021] wrote the review of it."]]) {
    const tab = one([left], [right]);
    assert.deepEqual(tab.changes, [], left);
    assert.equal(textOf(tab.merged), left);
  }
  // A number LEFT doesn't have is still added
  assert.equal(textOf(one(["Revenue was million in 2023."], ["Revenue was 12 million in 2023."]).merged), "Revenue was 12 million in 2023.");
});

test("a change left out keeps LEFT's empty last paragraph it was to go into", () => {
  const cases: [B[], B[]][] = [
    [[""], ["Alpha line.", "Beta line."]],
    [["Alpha line.", ""], ["Alpha line.", "Beta line."]],
    [[{ table: [["A", ""]] }, ""], [{ table: [["A", "B text"]] }, ""]],
  ];
  for (const [left, right] of cases) {
    const all = one(left, right);
    const none = one(left, right, { skip: all.changes.map((c) => c.id) });
    assert.deepEqual(none.merged, none.base, JSON.stringify(left));
  }
});

test("a heading between two items of a list reads the same as one that isn't", () => {
  const right: B[] = [{ p: "Topic one", list: "bullet" }, { p: "Section two", named: "HEADING_1" }, { p: "Topic two", list: "bullet" }];
  const tab = one([{ p: "Section two", named: "HEADING_1" }, { p: "Topic two", list: "bullet" }], right);
  assert.equal(kept(tab, "paragraphStyle"), 0);
  assert.equal(textOf(tab.merged), "Topic one\nSection two\nTopic two");
});

test("new sub-items go under the item they belong to, before an item only LEFT has", () => {
  const right: B[] = [{ p: "Market overview", list: "bullet" }, { p: "Size estimate", list: "bullet", level: 1 }, { p: "Growth rate", list: "bullet", level: 2 }, { p: "Competitors", list: "bullet" }];
  const tab = one([{ p: "Market overview", list: "bullet" }, { p: "My own top note", list: "bullet" }, { p: "Competitors", list: "bullet" }], right);
  assert.equal(textOf(tab.merged), "Market overview\nSize estimate\nGrowth rate\nMy own top note\nCompetitors");
  // An empty line between the new sub-items doesn't stop them
  const spaced = one([{ p: "Market overview", list: "bullet" }, { p: "My own top note", list: "bullet" }, { p: "Competitors", list: "bullet" }], [right[0], right[1], "", right[2], right[3]]);
  assert.equal(textOf(spaced.merged), "Market overview\nSize estimate\n\nGrowth rate\nMy own top note\nCompetitors");
  // Under a heading only LEFT has: a section's text stays with its own heading
  const sections = one(
    [{ p: "Part A", named: "HEADING_1" }, "A text.", { p: "My part", named: "HEADING_1" }, { p: "Part C", named: "HEADING_1" }],
    [{ p: "Part A", named: "HEADING_1" }, "A text.", "More A text.", { p: "Part B", named: "HEADING_1" }, "B text.", { p: "Part C", named: "HEADING_1" }],
  );
  assert.equal(textOf(sections.merged), "Part A\nA text.\nMore A text.\nMy part\nPart B\nB text.\nPart C");
});

test("missing nested items at levels 2 to 5, and whole sub-lists, go where the reference has them", () => {
  const item = (text: string, level: number): P => ({ p: text, list: "bullet", level });
  const right: B[] = [
    { p: "Overview of the segment", named: "HEADING_1" },
    item("Definition", 0), item("Software that helps agents", 1), item("Data processing", 2), item("Crawlers that index sites", 3), item("Structured output", 4), item("Schema for each page", 5), item("Harnesses", 2),
    item("Market", 0), item("Size", 1), item("Growth", 2), item("Buyers", 1),
    item("Risks", 0), item("Trust", 1),
  ];
  const lvl = (b: B) => (typeof b === "object" && "p" in b ? b.level ?? 0 : -1);
  for (const left of [right.filter((b) => lvl(b) < 3), right.filter((b) => lvl(b) !== 2 && lvl(b) !== 4), right.filter((_, i) => i < 8 || i === 12), right.filter((b) => lvl(b) <= 0)]) {
    const tab = one(left, right);
    checkInvariants(tab, rightDoc(right));
    assert.equal(textOf(tab.merged), textOf(imp(right).nodes));
    assert.deepEqual(tab.merged.content!.map((p) => p.attrs?.level ?? null), imp(right).nodes.map((p) => p.attrs?.level ?? null), "each item at its level");
  }
});

test("the reference's last paragraph LEFT has elsewhere isn't typed into LEFT's empty last line", () => {
  const tab = one(["Closing words here today.", "Intro text.", ""], ["Intro text.", "Closing words here today."]);
  assert.deepEqual(tab.changes, []);
  assert.equal(kept(tab, "moved"), 1);
});

test("a very long paragraph with many words missing gets them in place, not a second copy beside it", () => {
  const vocabulary = ["agents", "pay", "for", "data", "with", "cards", "wallets", "tokens", "and", "rails", "in", "the", "market"];
  const words = Array.from({ length: 2400 }, (_, i) => `${vocabulary[(i * 7 + (i >> 3)) % vocabulary.length]}${i % 5 ? "" : i % 26}`);
  const right = `${words.join(" ")}.`;
  const tab = one([`${words.filter((_, i) => i % 3 !== 1).join(" ")}.`], [right]);
  assert.equal(textOf(tab.merged), right);
  assert.ok(tab.changes.every((c) => c.kind === "text"));
});

test("two sentences that share most of their words aren't merged into one", () => {
  const swapped = one(["Prices rise for buyers in Europe, and fall for sellers in Asia."], ["Prices fall for buyers in Europe, and rise for sellers in Asia."]);
  assert.equal(textOf(swapped.merged), "Prices rise for buyers in Europe, and fall for sellers in Asia.\nPrices fall for buyers in Europe, and rise for sellers in Asia.");
  // A template line under another heading: the reference's line is its own paragraph
  const template = one(
    [{ p: "Subsegment two", named: "HEADING_1" }, { p: "Industry subsegment start-up competitors (from the market map)", list: "bullet" }],
    [{ p: "Subsegment two", named: "HEADING_1" }, { p: "Industry subsegment mature competitors (from the market map)", list: "bullet" }],
  );
  assert.deepEqual(kinds(template), ["list"]);
  assert.ok(!textOf(template.merged).includes("start-up mature"));
  // One word another is still typed beside LEFT's (as with Monday and Tuesday)
  assert.deepEqual(kinds(one(["The new model raises prices for small business buyers across all regions this year."], ["The new model lowers prices for small business buyers across all regions this year."])), ["text"]);
});
