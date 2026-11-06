import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { Slice, Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { editorExtensions } from "./extensions";
import { LinkLook } from "./link-look";

const schema = getSchema(editorExtensions);
const plugins = [...LinkLook.config.addProseMirrorPlugins!.call({} as never), history()];
const link = (href: string) => schema.marks.link.create({ href });
const ts = (attrs: Record<string, unknown>) => schema.marks.textStyle.create(attrs);
const stateOf = (...paras: PMNode[]) => EditorState.create({ schema, doc: schema.node("doc", null, paras), plugins });
const para = (...nodes: PMNode[]) => schema.node("paragraph", null, nodes);
/** Each text run of the first paragraph: its text, colour, underline and link */
const runs = (s: EditorState) => {
  const out: string[] = [];
  s.doc.child(0).forEach((n) => {
    const color = n.marks.find((m) => m.type.name === "textStyle")?.attrs.color ?? "-";
    const u = n.marks.some((m) => m.type.name === "underline") ? "u" : "-";
    const href = n.marks.find((m) => m.type.name === "link")?.attrs.href ?? "-";
    out.push(`${n.text}|${color}|${u}|${href}`);
  });
  return out;
};

test("text made a link here looks as Docs makes a link: blue, underlined, its font and size kept", () => {
  let s = stateOf(para(schema.text("see the docs", [ts({ fontFamily: "Georgia", fontSize: 14, color: "#cc0000" })])));
  s = s.apply(s.tr.addMark(5, 13, link("https://example.com/")));
  assert.deepEqual(runs(s), ["see |#cc0000|-|-", "the docs|#1155cc|u|https://example.com/"]);
  const textStyle = s.doc.child(0).child(1).marks.find((m) => m.type.name === "textStyle")!;
  assert.equal(textStyle.attrs.fontFamily, "Georgia");
  assert.equal(textStyle.attrs.fontSize, 14);
  // Undo takes the link and its look away together
  undo(s, (tr) => { s = s.apply(tr); });
  assert.deepEqual(runs(s), ["see the docs|#cc0000|-|-"]);
});

test("a link pasted or edited keeps the look it has", () => {
  // A plain black link, as a Docs copy can have it
  const plain = schema.text("plain link", [link("https://a.example/"), ts({ color: "#000000" })]);
  let s = stateOf(para(schema.text("x")));
  s = s.apply(s.tr.replace(1, 1, new Slice(Fragment.from(plain), 0, 0)));
  assert.deepEqual(runs(s), ["plain link|#000000|-|https://a.example/", "x|-|-|-"]);
  // A new address for the same link: it stays as it looks
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, 11)).addMark(1, 11, link("https://b.example/")));
  assert.deepEqual(runs(s), ["plain link|#000000|-|https://b.example/", "x|-|-|-"]);
});

test("only the part that wasn't a link yet gets the look", () => {
  // "old" is a plain link already; the link is stretched over " new"
  let s = stateOf(para(schema.text("old", [link("https://a.example/")]), schema.text(" new")));
  s = s.apply(s.tr.addMark(1, 8, link("https://a.example/")));
  assert.deepEqual(runs(s), ["old|-|-|https://a.example/", " new|#1155cc|u|https://a.example/"]);
});
