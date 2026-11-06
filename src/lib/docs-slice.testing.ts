/**
 * Google Docs' own copies (the slice Chrome hands a page on paste), made for tests: the text, and the
 * style entries Docs writes at given positions.
 */

/** A text style as Docs copies it: every value given, none inherited unless asked */
export const ts = (o: Record<string, unknown> = {}, inherited: string[] = []) => {
  const base: Record<string, unknown> = { ts_bd: false, ts_fs: 11, ts_ff: "Arial", ts_it: false, ts_sc: false, ts_st: false, ts_tw: 400, ts_un: false, ts_va: "nor", ts_bgc2: { clr_type: 0, hclr_color: null }, ts_fgc2: { clr_type: 0, hclr_color: "#000000" }, ...o };
  for (const k of ["ts_bd", "ts_fs", "ts_ff", "ts_it", "ts_sc", "ts_st", "ts_un", "ts_va", "ts_bgc2", "ts_fgc2"]) base[`${k}_i`] = inherited.includes(k) || inherited.includes("*");
  return base;
};
export const ps = (o: Record<string, unknown> = {}) => ({ ps_al: 0, ps_awao: true, ps_hd: 0, ps_ifl: 0, ps_il: 0, ps_ir: 0, ps_klt: false, ps_kwn: false, ps_ltr: true, ps_ls: 1.15, ps_lslm: 1, ps_pbb: false, ps_sm: 0, ps_sa: 0, ps_sb: 0, ...o });

/** A clipboard copy: the text and the style entries at given positions */
export function clip(text: string, at: { text?: Record<number, object>; paragraph?: Record<number, object>; list?: Record<number, object>; link?: Record<number, object> } = {}, extra: Record<string, unknown> = {}) {
  const arr = (m: Record<number, object> | undefined) => { const out: (object | null)[] = []; for (const [k, v] of Object.entries(m ?? {})) out[Number(k)] = v; return Array.from(out, (x) => x ?? null); };
  // Every paragraph has a paragraph style and a list entry, as Docs writes them
  const paragraph = { ...at.paragraph };
  const list = { ...at.list };
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") { paragraph[i] ??= ps(); list[i] ??= { ls_nest: 0, ls_id: null }; }
  const resolved = {
    dsl_spacers: text,
    dsl_styleslices: [
      { stsl_type: "text", stsl_styles: arr({ 0: ts(), ...at.text }) },
      { stsl_type: "paragraph", stsl_styles: arr(paragraph) },
      { stsl_type: "list", stsl_styles: arr(list) },
      { stsl_type: "link", stsl_styles: arr({ 0: { lnks_link: null }, ...at.link }) },
      { stsl_type: "tbl", stsl_styles: [] },
    ],
    dsl_entitymap: {},
    dsl_entitytypemap: {},
    dsl_entitypositionmap: {},
    ...extra,
  };
  return JSON.stringify({ dih: 0, data: JSON.stringify({ resolved, autotext_content: {} }), dct: "kix" });
}

const level = (gt: number, gf: string, gs = "") => ({ b_gt: gt, b_gf: gf, b_gs: gs, b_sn: 1, b_il: 36, b_ifl: 18, b_a: 0 });
const STAR_LIST = { le_nb: { nl_0: level(9, "%0", "\u2605"), nl_1: level(9, "%1", "\u25cb"), nl_2: level(9, "%2", "\u25a0") } };

/**
 * A copy Docs can't give whole in its slice: a heading, a table (the next paragraph's text straight
 * after it, as Docs writes it), a paragraph in 14pt, one with an image (centred), one with a date chip,
 * an item of a list whose bullet is a star (the HTML says only "disc"), and a last paragraph, or with
 * `tableLast`, a second table (as Ctrl+A copies a document that ends with one). With the HTML Docs
 * writes for the same copy, and its text/plain.
 */
export function mixedCopy({ tableLast = false } = {}) {
  const table = (rows: string[][]) => `\u0010${rows.map((r) => `\u0012${r.map((c) => `\u001c${c}\n`).join("")}`).join("")}\u0011`;
  const blocks = ["Report\n", table([["Name", "Score"], ["Ada", "90"]]), "After\n", "Logo *\n", "Due \ue909 soon\n", "Star item\n", tableLast ? table([["Total", "90"]]) : "Last\n"];
  const text = blocks.join("");
  const at = (s: string, from = 0) => text.indexOf(s, from);
  const nl = (s: string) => at("\n", at(s));
  const image: (object | null)[] = Array.from({ length: text.length }, () => null);
  image[at("*")] = { id: "kix.img" };
  const slice = clip(text, {
    // The heading's text has its style's size, as Docs copies it (inherited)
    text: { 0: ts({ ts_fs: 20 }, ["*"]), [nl("Report") + 1]: ts(), [at("After")]: ts({ ts_fs: 14 }), [nl("After")]: ts() },
    paragraph: { [nl("Report")]: ps({ ps_hd: 1, ps_sb: 20, ps_sa: 6 }), [nl("Logo")]: ps({ ps_al: 1 }) },
    list: { [nl("Star item")]: { ls_id: "kix.star", ls_nest: 0 } },
  }, {
    dsl_entitymap: { "kix.star": STAR_LIST, "kix.img": {} },
    dsl_entitytypemap: { "kix.star": "list", "kix.img": "inline" },
    dsl_entitypositionmap: { inline: image },
  });
  const span = (t: string, style = "font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;") => `<span style="${style}">${t}</span>`;
  const p = (inner: string, extra = "") => `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;${extra}">${inner}</p>`;
  const cell = (t: string) => `<td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;">${p(span(t), "").replace("line-height:1.38", "line-height:1.2")}</td>`;
  const htmlTable = (rows: string[][]) => `<div dir="ltr" style="margin-left:0pt;" align="left"><table style="border:none;border-collapse:collapse;"><colgroup><col width="300"><col width="300"></colgroup><tbody>${rows.map((r) => `<tr style="height:0pt">${r.map(cell).join("")}</tr>`).join("")}</tbody></table></div>`;
  const html = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-mixed">'
    + `<h1 dir="ltr" style="line-height:1.38;margin-top:20pt;margin-bottom:6pt;">${span("Report", "font-size:20pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;")}</h1>`
    + htmlTable([["Name", "Score"], ["Ada", "90"]])
    + p(span("After", "font-size:14pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"))
    + "<br>"
    + p(span("Logo ") + '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"><span style="border:none;display:inline-block;overflow:hidden;width:24px;height:24px;"><img src="https://lh7-rt.googleusercontent.com/docsz/mixed-copy-logo" width="24" height="24" style="margin-left:0px;margin-top:0px;"></span></span>', "text-align:center;")
    + p(span("Due ") + span("Nov 6, 2026") + span(" soon"))
    + `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"><li dir="ltr" style="list-style-type:disc;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="1">${p(span("Star item")).replace('<p dir="ltr" style="', '<p dir="ltr" role="presentation" style="')}</li></ul>`
    + (tableLast ? htmlTable([["Total", "90"]]) + "</b>" : p(span("Last")) + "<br></b>");
  return { slice, html, text: `Report\nName\nScore\nAda\n90\nAfter\nLogo \nDue Nov 6, 2026 soon\nStar item\n${tableLast ? "Total\n90" : "Last\n"}` };
}
