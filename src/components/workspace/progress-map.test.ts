import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { editorExtensions } from "./extensions";
import { tokenPositions } from "./pagination";
import { additions, segmentCharTokens, tokenize, PENDING_MARK, type Tok } from "@/lib/doc-model";
import { OBJ, PAGE_BREAK, type EditorNode } from "@/lib/rich-text";
import { fixtureContent } from "../../../e2e/fixtures/google-doc";

// The live page of a running sync greys out what is still to come: the sync reports how many
// characters it has typed, and these maps turn that count back into places on the page

const schema = getSchema(editorExtensions);
const ADD = [{ type: PENDING_MARK }];
const base = (): EditorNode => ({ type: "doc", content: fixtureContent().nodes });
const textOf = (n: EditorNode): string => (n.text ?? "") + (n.content ?? []).map(textOf).join("");

/** The fixture with pending content put into the paragraph whose text starts with `startsWith` */
function withAddition(startsWith: string, edit: (p: EditorNode) => EditorNode | EditorNode[]): EditorNode {
  const doc = base();
  const i = doc.content!.findIndex((n) => textOf(n).startsWith(startsWith));
  assert.ok(i >= 0, `no paragraph starts with ${startsWith}`);
  const out = edit(doc.content![i]);
  doc.content!.splice(i, 1, ...(Array.isArray(out) ? out : [out]));
  return doc;
}

const kind = (t: Tok) => t.k;

test("tokenPositions gives every token of tokenize a place, footnote references included", () => {
  const json = base();
  const doc = PMNode.fromJSON(schema, json);
  const toks = tokenize(doc.toJSON() as EditorNode);
  const positions = tokenPositions(doc);
  assert.ok(toks.some((t) => t.k === "fn"), "the fixture has a footnote");
  assert.equal(positions.length, toks.length);
  toks.forEach((t, i) => {
    const p = positions[i];
    const node = doc.nodeAt(p);
    if (t.k === "c") assert.equal(doc.textBetween(p, p + 1), t.c, `token ${i}`);
    else if (t.k === "fn") assert.equal(node?.type.name, "footnoteRef", `token ${i}`);
    else if (t.k === "img") assert.equal(node?.type.name, "image", `token ${i}`);
    else if (t.k === "pb") assert.equal(node?.type.name, "pageBreak", `token ${i}`);
    else if (t.k === "br") assert.equal(node?.type.name, "hardBreak", `token ${i}`);
    else if (t.k === "nl") { const $p = doc.resolve(p); assert.ok($p.parent.isTextblock && $p.parentOffset === $p.parent.content.size, `token ${i} ends its paragraph`); }
  });
});

/** Every character a sync types maps to the token it came from, at that token's place on the page */
function assertMapped(target: EditorNode) {
  const doc = PMNode.fromJSON(schema, target);
  const json = doc.toJSON() as EditorNode;
  const { segments } = additions(base(), json);
  assert.ok(segments.length > 0, "there is something to type");
  const toks = tokenize(json);
  const positions = tokenPositions(doc);
  const chars = segmentCharTokens(json, segments.map((s) => s.tokens));
  segments.forEach((s, r) => {
    assert.equal(chars[r].length, s.text.length, `segment ${r}: one token per character`);
    let prev = -1;
    chars[r].forEach((q, k) => {
      assert.ok(q >= s.tokens[0] && q < s.tokens[1] && q >= prev, `segment ${r} char ${k}: in order, inside the segment`);
      prev = q;
      const t = toks[q];
      const ch = s.text[k];
      if (t.k === "c") { assert.equal(ch, t.c, `segment ${r} char ${k}`); assert.equal(doc.textBetween(positions[q], positions[q] + 1), t.c, `segment ${r} char ${k} on the page`); }
      else if (t.k === "nl" || t.k === "br") assert.equal(ch, "\n");
      else if (t.k === "pb") assert.ok(ch === PAGE_BREAK || ch === "\n");
      else if (t.k === "img") assert.ok(ch === OBJ || ch === " ");
      else assert.fail(`segment ${r} char ${k} came from a ${kind(t)} token`);
    });
  });
}

test("text added after a footnote maps onto its own characters (it drifted by one per footnote)", () => {
  assertMapped(withAddition("Closing thoughts", (p) => ({ ...p, content: [...(p.content ?? []), { type: "text", text: " And one more.", marks: ADD }] })));
  // In the footnote's own paragraph, after the reference
  assertMapped(withAddition("The second work uses tape", (p) => ({ ...p, content: [...(p.content ?? []).slice(0, -1), { type: "text", text: ", side A", marks: ADD }, ...(p.content ?? []).slice(-1)] })));
});

test("a page break inside an added paragraph is two characters for one token, and what follows still lines up", () => {
  assertMapped(withAddition("Closing thoughts", (p) => [
    { type: "paragraph", attrs: {}, content: [{ type: "text", text: "Before", marks: ADD }, { type: "pageBreak", marks: ADD }, { type: "text", text: "after the break", marks: ADD }] },
    { ...p, content: [{ type: "text", text: "New start. ", marks: ADD }, ...(p.content ?? [])] },
  ]));
});

test("new paragraphs, a line break and an image map one to one", () => {
  assertMapped(withAddition("Closing thoughts", (p) => [
    p,
    { type: "paragraph", attrs: {}, content: [{ type: "text", text: "First line", marks: ADD }, { type: "hardBreak", marks: ADD }, { type: "text", text: "second", marks: ADD }] },
    { type: "paragraph", attrs: {}, content: [{ type: "image", attrs: { src: "https://example.test/a.png", width: 40, height: 40 }, marks: ADD }, { type: "text", text: " caption", marks: ADD }] },
  ]));
});
