/**
 * A small XML reader for the parts of an .xlsx file: elements, attributes and text, with namespace
 * prefixes dropped from element names ("x:row" is "row"). Attributes keep theirs ("r:id").
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The element's own text (its children's text is theirs) */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name] ?? m;
  });
}

const ATTR = /([^\s=/<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(src); m; m = ATTR.exec(src)) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return attrs;
}

const local = (name: string) => { const i = name.indexOf(":"); return i < 0 ? name : name.slice(i + 1); };

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const top = stack[stack.length - 1];
      top.text += decodeEntities(src.slice(i, lt));
    }
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      stack[stack.length - 1].text += src.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src[lt + 1] === "?" || src[lt + 1] === "!") { const e = src.indexOf(">", lt); i = e < 0 ? n : e + 1; continue; }
    const gt = src.indexOf(">", lt);
    if (gt < 0) break;
    if (src[lt + 1] === "/") {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClosing = src[gt - 1] === "/";
    const inner = src.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const sp = inner.search(/\s/);
    const name = sp < 0 ? inner : inner.slice(0, sp);
    const node: XmlNode = { tag: local(name), attrs: sp < 0 ? {} : parseAttrs(inner.slice(sp)), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

export const child = (node: XmlNode | undefined | null, tag: string): XmlNode | undefined => node?.children.find((c) => c.tag === tag);
export const children = (node: XmlNode | undefined | null, tag: string): XmlNode[] => (node ? node.children.filter((c) => c.tag === tag) : []);

/** The first descendant with this tag, depth first */
export function find(node: XmlNode | undefined | null, tag: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.tag === tag) return c;
    const deep = find(c, tag);
    if (deep) return deep;
  }
  return undefined;
}

/** "1", "true" and "on" are true; an attribute that is absent is `fallback` */
export function flag(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return value === "1" || value === "true" || value === "on";
}
