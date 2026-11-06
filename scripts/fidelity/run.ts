/**
 * Type editor content into the strict stub Google Doc with the real runner and print what came out:
 * every paragraph of the document, and every difference from what the editor shows (fidelity.ts).
 *
 *   npx tsx scripts/fidelity/run.ts [scenario|all|path/to/capture-slice.json] [--loose] [--append] [--verbose] [--seed N] [--typos F]
 *
 * A path runs a Docs clipboard capture (its -slice.json, with the .txt next to it) pasted into an
 * empty document. --loose runs the plain offline stub instead of the strict one.
 */
import fs from "node:fs";
import type { docs_v1 } from "googleapis";
import { asAdded, differences, pasteCapture, SCENARIOS, STRICT, syncInto, type Scenario } from "./fidelity";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const which = args.find((a, i) => !a.startsWith("--") && !["--seed", "--typos"].includes(args[i - 1] ?? "")) ?? "all";
const verbose = flag("--verbose");

/** A clipboard capture pasted into an empty document, by the editor's paste code */
export function captureScenario(path: string): Scenario {
  return {
    name: path,
    what: "a Docs clipboard capture pasted into an empty document",
    target: (base) => {
      const pasted = pasteCapture(path, base);
      if (!pasted) throw new Error(`${path}: the paste path reads this capture as HTML (the slice has content it leaves to HTML)`);
      return asAdded(pasted);
    },
  };
}

function compact(reqs: object[]): string {
  return reqs.map((r) => {
    const [k] = Object.keys(r);
    const b = (r as Record<string, Record<string, unknown>>)[k];
    const range = b.range as { startIndex: number; endIndex: number } | undefined;
    const loc = b.location as { index: number } | undefined;
    const where = range ? `[${range.startIndex},${range.endIndex})` : loc ? `@${loc.index}` : "";
    const extra = k === "insertText" ? JSON.stringify(b.text) : k === "createParagraphBullets" ? String(b.bulletPreset).slice(0, 12) : k === "updateParagraphStyle" ? `{${b.fields}}` : k === "updateTextStyle" ? styleKey(b.textStyle as Record<string, unknown>) : "";
    return `${k.replace(/Request$/, "")}${where}${extra ? " " + extra : ""}`;
  }).join(" | ");
}

const hex = (c: docs_v1.Schema$OptionalColor | undefined | null) => {
  const r = c?.color?.rgbColor;
  if (!r) return undefined;
  const h = (v: number | null | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${h(r.red)}${h(r.green)}${h(r.blue)}`;
};
function styleKey(t: Record<string, unknown> | undefined | null): string {
  if (!t) return "{}";
  const s = t as docs_v1.Schema$TextStyle;
  const parts: string[] = [];
  if (s.bold) parts.push("b");
  if (s.italic) parts.push("i");
  if (s.underline) parts.push("u");
  if (s.smallCaps) parts.push("sc");
  if (s.baselineOffset && s.baselineOffset !== "NONE") parts.push(s.baselineOffset.toLowerCase());
  if (s.fontSize) parts.push(`${s.fontSize.magnitude}pt`);
  if (s.weightedFontFamily) parts.push(s.weightedFontFamily.fontFamily ?? "?");
  const fg = hex(s.foregroundColor); if (fg) parts.push(`fg${fg}`);
  const bg = hex(s.backgroundColor); if (bg) parts.push(`bg${bg}`);
  if (s.link?.url) parts.push(`link`);
  return `{${parts.join(" ")}}`;
}

function describe(doc: docs_v1.Schema$Document) {
  const named = new Map((doc.namedStyles?.styles ?? []).map((n) => [n.namedStyleType, n]));
  const listsSeen: string[] = [];
  const counters = new Map<string, number[]>();
  for (const el of doc.body?.content ?? []) {
    const p = el.paragraph;
    if (!p) continue;
    const ps = p.paragraphStyle ?? {};
    const runs = (p.elements ?? []).map((e) => e.pageBreak ? "[PB]" : `${JSON.stringify((e.textRun?.content ?? "").slice(0, 28))}${styleKey(e.textRun?.textStyle as Record<string, unknown>)}`);
    let bullet = "";
    if (p.bullet) {
      const lid = p.bullet.listId ?? "";
      if (!listsSeen.includes(lid)) listsSeen.push(lid);
      const lvl = p.bullet.nestingLevel ?? 0;
      const c = counters.get(lid) ?? [];
      c[lvl] = (c[lvl] ?? 0) + 1; c.length = lvl + 1; counters.set(lid, c);
      const nl = doc.lists?.[lid]?.listProperties?.nestingLevels?.[lvl];
      const label = nl?.glyphSymbol ?? `${c[lvl]}${nl?.glyphType === "ALPHA" ? "(a)" : nl?.glyphType === "ROMAN" ? "(i)" : ""}.`;
      bullet = ` LIST#${listsSeen.indexOf(lid)} L${lvl} "${label}"${p.bullet.textStyle ? ` bulletStyle${styleKey(p.bullet.textStyle as Record<string, unknown>)}` : ""}`;
    }
    const d = (x: docs_v1.Schema$Dimension | undefined | null) => (x ? x.magnitude ?? 0 : "·");
    const nsName = ps.namedStyleType ?? "NORMAL_TEXT";
    console.log(`   [${el.startIndex}-${el.endIndex}) ${nsName}${bullet} ind ${d(ps.indentStart)}/${d(ps.indentFirstLine)} sp ${d(ps.spaceAbove)}/${d(ps.spaceBelow)} ls ${ps.lineSpacing ?? "·"}${ps.alignment && ps.alignment !== "START" ? " " + ps.alignment : ""} :: ${runs.join(" ")}`);
    void named;
  }
}

async function main() {
  const list = which === "all" ? SCENARIOS : fs.existsSync(which) ? [captureScenario(which)] : SCENARIOS.filter((s) => s.name === which);
  if (!list.length) throw new Error(`No scenario ${which}; have ${SCENARIOS.map((s) => s.name).join(", ")}`);
  for (const s of list) {
    const r = await syncInto(s, { seed: Number(opt("--seed", "7")), typos: Number(opt("--typos", "0.7")), append: flag("--append"), stub: flag("--loose") ? {} : STRICT });
    console.log(`\n== ${s.name}: ${s.what}\n   ${r.outcome}${r.error ? ` (${r.error})` : ""}, ${r.batches.length} batches, ${r.actions} actions${s.known ? `\n   known: ${s.known}` : ""}`);
    if (verbose) r.batches.forEach((b, i) => console.log(`   batch ${i}: ${compact(b)}`));
    describe(r.doc as docs_v1.Schema$Document);
    const diffs = differences(r.target, r.doc);
    for (const d of diffs.slice(0, 25)) console.log("   x " + d.replace(/\n/g, "\n     "));
    console.log(`   => ${diffs.length} difference(s) between the editor and the document`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
