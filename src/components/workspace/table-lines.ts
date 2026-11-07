import { Plugin } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Google Docs has a paragraph right before every table: inserting a table makes one, and the one
 * before a table can't be deleted. A page where a table has none (a table inserted or pasted on the
 * first line, right after another table or after a section break) would have the save try to
 * delete Docs' paragraph, which Docs refuses, and every save after it fail the same way. So the page
 * keeps that paragraph too, as Docs does.
 */

/** Where the page lacks the paragraph Docs has before a table: the position of each such table */
export function missingTableLines(doc: PMNode): number[] {
  const at: number[] = [];
  const walk = (parent: PMNode, start: number) => {
    let prev: PMNode | null = null;
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (child.type.name === "table" && (!prev || prev.type.name !== "paragraph" || prev.attrs.locked)) at.push(pos);
      // The blocks of a section in columns are the document's own, after its section break
      if (child.type.name === "columnSection") walk(child, pos + 1);
      prev = child;
    });
  };
  walk(doc, 0);
  return at;
}

/** Puts in the paragraph Docs has before a table, whenever the page lacks it */
export function tableLinesPlugin(): Plugin {
  return new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some((tr) => tr.docChanged)) return null;
      const at = missingTableLines(state.doc);
      if (!at.length) return null;
      const tr = state.tr;
      // From the end, so the positions before stay where they are
      for (const pos of at.reverse()) tr.insert(pos, state.schema.nodes.paragraph.create());
      return tr;
    },
  });
}
