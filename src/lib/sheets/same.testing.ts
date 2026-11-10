/**
 * Whether two workbooks come to the same spreadsheet: every cell's value, formula, note, link and
 * look (blank ranges spread out, defaults filled in, theme colours resolved), every size, merge,
 * rule and name. Used to hold the reader to Google Sheets' own import of the same file: one side
 * is the file as SyncStream reads it, the other the .xlsx Google exports of what it imported.
 * An error constant and the formula that gives the same error count as the same (the API can only
 * write the second). Left out, because the export itself adds or drops them: a number format Sheets worked out for a
 * formula, the inner edges of a merged cell, and the cells a merge covers.
 */
import { cellName, type Sheet, type Workbook } from "./model";

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** Each kind of difference with how often it occurs and one example; empty when the two match */
export function workbookDifferences(a: Workbook, b: Workbook, max = 10, opts: { results?: boolean } = {}): string[] {
  const hex = (w: Workbook, c: unknown) => { const v = typeof c === "string" && c.startsWith("theme:") ? ((w.theme as Record<string, string | undefined> | undefined)?.[c.slice(6)] ?? c) : c; return typeof v === "string" ? v.toLowerCase() : v; };
  const flat = (w: Workbook, st: Workbook["styles"][number] | undefined) => {
    const o: Record<string, unknown> = { "font.family": w.defaultFont.family.toLowerCase(), "font.size": w.defaultFont.size, "font.color": "#000000" };
    if (!st) return o;
    for (const [k, v] of Object.entries(st)) { if (k === "font") for (const [fk, fv] of Object.entries(v as object)) o["font." + fk] = hex(w, fv); else if (k === "borders") for (const [bk, bv] of Object.entries(v as object)) o["border." + bk] = canon({ ...(bv as object), color: hex(w, (bv as { color?: unknown }).color) }); else o[k] = hex(w, v); }
    return o;
  };
  const looks = (sheet: Sheet) => { const m = new Map<number, number>(); for (const sp of sheet.spans ?? []) for (const [r0, c0, r1, c1] of sp.rects) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) m.set(r * 16384 + c, sp.v); for (const c of sheet.cells) m.set(c.r * 16384 + c.c, c.s ?? 0); return m; };
  let total = 0;
  const lines: string[] = [];
  if (a.sheets.length !== b.sheets.length) lines.push(`sheets ${a.sheets.length}|${b.sheets.length}`);
  if (canon(a.names?.map((n) => n.name).sort()) !== canon(b.names?.map((n) => n.name).sort())) lines.push(`names ${a.names?.length}|${b.names?.length}`);
  a.sheets.forEach((sa, i) => {
    const sb = b.sheets[i]; if (!sb) return;
    const head: string[] = [];
    const px = (s: Sheet, runs: [number, number, number][], def: number, n: number) => { const o = new Array<number>(n).fill(def); for (const [x, y, p] of runs) for (let k = x; k <= Math.min(y, n - 1); k++) o[k] = p; return o; };
    for (const k of ["name", "rowCount", "colCount", "hideGridlines", "frozenRows", "frozenCols", "hidden", "tabColor"] as const) if (canon(sa[k]) !== canon(sb[k])) head.push(`${k} ${canon(sa[k])}|${canon(sb[k])}`);
    const ca = px(sa, sa.colPx, sa.defaultColPx, sa.colCount), cb = px(sb, sb.colPx, sb.defaultColPx, sb.colCount);
    const cd = ca.map((v, k) => (v !== cb[k] ? `${k}:${v}|${cb[k]}` : "")).filter(Boolean);
    if (cd.length) head.push(`col widths differ (${cd.length}): ${cd.slice(0, 8).join(" ")}`);
    const ra = px(sa, sa.rowPx, sa.defaultRowPx, sa.rowCount), rb = px(sb, sb.rowPx, sb.defaultRowPx, sb.rowCount);
    const rd = ra.map((v, k) => (v !== rb[k] ? `${k}:${v}|${rb[k]}` : "")).filter(Boolean);
    if (rd.length) head.push(`row heights differ (${rd.length}): ${rd.slice(0, 8).join(" ")}`);
    for (const k of ["hiddenRows", "hiddenCols", "groups", "filter", "banding", "conditional", "charts"] as const) if (canon(sa[k]) !== canon(sb[k])) head.push(`${k}: ${canon(sa[k])?.slice(0, 200)} | ${canon(sb[k])?.slice(0, 200)}`);
    const dv = (s: Sheet) => (s.validations ?? []).map((v) => canon({ ...v, rect: undefined }) + "@" + v.rect.join()).sort();
    if (canon(dv(sa)) !== canon(dv(sb))) head.push(`validations ${dv(sa).length}|${dv(sb).length}: ${dv(sa).filter((x) => !dv(sb).includes(x)).slice(0, 2).join(" ; ").slice(0, 260)} || ${dv(sb).filter((x) => !dv(sa).includes(x)).slice(0, 2).join(" ; ").slice(0, 260)}`);
    const m = (w: Sheet) => w.merges.map((x) => x.join()).sort();
    if (canon(m(sa)) !== canon(m(sb))) head.push(`merges ${sa.merges.length}|${sb.merges.length}: only A ${m(sa).filter((x) => !m(sb).includes(x)).slice(0, 4).join(" ")} ; only B ${m(sb).filter((x) => !m(sa).includes(x)).slice(0, 4).join(" ")}`);
    const covered = new Set<number>();
    const anchors = new Set<number>(sb.merges.map((m2) => m2[0] * 16384 + m2[1]));
    for (const [r0, c0, r1, c1] of sb.merges) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) covered.add(r * 16384 + c);
    const mapA = new Map(sa.cells.map((c) => [c.r * 16384 + c.c, c])), mapB = new Map(sb.cells.map((c) => [c.r * 16384 + c.c, c]));
    const la = looks(sa), lb = looks(sb);
    const kinds = new Map<string, { n: number; eg: string }>();
    const note = (kind: string, eg: string) => { const k = kinds.get(kind); if (k) k.n++; else kinds.set(kind, { n: 1, eg }); };
    const close = (x: unknown, y: unknown) => (typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 1e-7 * Math.max(1, Math.abs(x), Math.abs(y)) : canon(x ?? null) === canon(y ?? null));
    const same = (x: unknown, y: unknown) => (typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)) * 10 : canon(x ?? null) === canon(y ?? null));
    for (const k of [...new Set<number>([...la.keys(), ...lb.keys()])].sort((x, y) => x - y)) {
      if (covered.has(k)) continue;
      const ca2 = mapA.get(k), cb2 = mapB.get(k);
      const name = cellName(Math.floor(k / 16384), k % 16384);
      // An error typed as a constant can't be written through the API: the sync writes the formula that
      // gives the same error ("=#DIV/0!"), which shows and behaves the same
      const constant = (x: typeof ca2, y: typeof ca2) => !!x && x.f == null && x.e != null && y?.f === x.e;
      if (constant(ca2, cb2) || constant(cb2, ca2)) continue;
      if ((ca2?.f ?? null) !== (cb2?.f ?? null)) note("formula", `${name}: ${ca2?.f} | ${cb2?.f}`);
      else if (ca2?.f == null && !same(ca2?.v, cb2?.v)) note("value", `${name}: ${canon(ca2?.v)} | ${canon(cb2?.v)}`);
      // What a formula worked out to (both sides saved by the same spreadsheet program), when asked
      else if (opts.results && ca2?.f != null && !/\b(TODAY|NOW|RAND|RANDBETWEEN|RANDARRAY)\(/i.test(ca2.f) && !close(ca2?.v, cb2?.v)) note("formula result", `${name}: ${ca2.f.slice(0, 60)} = ${canon(ca2?.v)} | ${canon(cb2?.v)}`);
      if ((ca2?.e ?? null) !== (cb2?.e ?? null)) note("error", `${name}: ${ca2?.e} | ${cb2?.e}`);
      for (const extra of ["note", "link"] as const) if (canon(ca2?.[extra]) !== canon(cb2?.[extra])) note(extra, `${name}: ${canon(ca2?.[extra])?.slice(0, 120)} | ${canon(cb2?.[extra])?.slice(0, 120)}`);
      const fa2 = flat(a, a.styles[la.get(k) ?? 0]), fb2 = flat(b, b.styles[lb.get(k) ?? 0]);
      // What Google's export adds or drops on its own: a formula's worked-out number format, a merged cell's inner edges
      if (fa2.numFmt === undefined && cb2?.f != null) delete fb2.numFmt;
      if (anchors.has(k)) for (const e of ["border.bottom", "border.right"]) if (fb2[e] === undefined) delete fa2[e];
      for (const p of new Set([...Object.keys(fa2), ...Object.keys(fb2)])) if (canon(fa2[p]) !== canon(fb2[p])) note("style " + p, `${name}: ${canon(fa2[p])} | ${canon(fb2[p])}`);
    }
    const n = [...kinds.values()].reduce((s, v) => s + v.n, 0) + head.length;
    total += n;
    if (n) { lines.push(`## ${sa.name}: ${n}`); for (const h of head) lines.push("  " + h); for (const [kind, v] of [...kinds].sort((x, y) => y[1].n - x[1].n).slice(0, max)) lines.push(`  ${v.n} × ${kind}   e.g. ${v.eg}`); }
  });
  void total;
  return lines;
}
