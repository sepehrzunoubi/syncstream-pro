/** The parts of an .xlsx archive and how they point at each other */

import { child, children, parseXml } from "./xml";
import type { Zip } from "./zip";

export interface Rel { type: string; target: string; external: boolean }

/** A part's relationships by id, their targets as paths inside the archive */
export async function readRels(zip: Zip, part: string): Promise<Map<string, Rel>> {
  const slash = part.lastIndexOf("/");
  const dir = slash < 0 ? "" : part.slice(0, slash + 1);
  const xml = await zip.text(`${dir}_rels/${part.slice(slash + 1)}.rels`);
  const out = new Map<string, Rel>();
  if (!xml) return out;
  for (const r of children(child(parseXml(xml), "Relationships"), "Relationship")) {
    const external = r.attrs.TargetMode === "External";
    let target = r.attrs.Target ?? "";
    if (!external) {
      if (target.startsWith("/")) target = target.slice(1);
      else {
        const parts = (dir + target).split("/");
        const stack: string[] = [];
        for (const p of parts) { if (p === "..") stack.pop(); else if (p !== "." && p !== "") stack.push(p); }
        target = stack.join("/");
      }
    }
    out.set(r.attrs.Id ?? "", { type: (r.attrs.Type ?? "").replace(/^.*\//, ""), target, external });
  }
  return out;
}
