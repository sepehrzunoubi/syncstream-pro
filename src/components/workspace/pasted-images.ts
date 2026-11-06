/**
 * Images a copy carries in its HTML as data (Docs' copy of a document open for viewing, and many
 * apps' copies). The editor takes no data: address, since Google can't fetch one to put the image in
 * the document. So each is shown at once from a blob: address, uploaded as a pasted image file is,
 * and given its uploaded address, which the sync can insert. One that can't be uploaded is taken
 * out, with a message: the page doesn't show an image the document won't have.
 */

import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { uploadImage } from "./image-upload";

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
const IMG_DATA_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(data:image\/[^"']*)\2/gi;

/** Blob addresses of pasted images still to upload, and those uploaded (by their blob address) */
const waiting = new Map<string, Blob>();
const uploaded = new Map<string, { url: string; width: number; height: number }>();

function blobOf(src: string): Blob | null {
  const m = DATA_IMAGE.exec(src);
  if (!m) return null;
  try {
    const bin = atob(m[2].replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1].toLowerCase() });
  } catch {
    return null;
  }
}

/** The pasted HTML with each image given as data shown from a blob: address, to upload once pasted */
export function pastedImageSources(html: string): string {
  if (!/data:image\//i.test(html) || typeof URL.createObjectURL !== "function") return html;
  return html.replace(IMG_DATA_SRC, (all, pre: string, quote: string, src: string) => {
    const blob = blobOf(src);
    if (!blob) return all;
    const url = URL.createObjectURL(blob);
    waiting.set(url, blob);
    return `${pre}${quote}${url}${quote}`;
  });
}

/** Whether an image's address is one of a pasted image still being uploaded */
export const isUploadingImage = (src: unknown) => typeof src === "string" && waiting.has(src);

export const PastedImages = Extension.create({
  name: "pastedImages",
  addProseMirrorPlugins() {
    const inFlight = new Set<string>();
    let current: EditorView | null = null;
    /** Every image with this blob address: its uploaded one, or (when the upload failed) out */
    const settle = (src: string, done: { url: string; width: number; height: number } | null, error?: unknown) => {
      inFlight.delete(src);
      waiting.delete(src);
      if (done) uploaded.set(src, done);
      const view = current;
      if (view && !(view as unknown as { isDestroyed?: boolean }).isDestroyed) {
        const tr = view.state.tr;
        const at: number[] = [];
        tr.doc.descendants((node, pos) => { if (node.type.name === "image" && node.attrs.src === src) at.push(pos); });
        for (const pos of at.reverse()) {
          const attrs = tr.doc.nodeAt(pos)!.attrs;
          if (done) tr.setNodeMarkup(pos, undefined, { ...attrs, src: done.url, width: attrs.width ?? done.width, height: attrs.height ?? done.height });
          else tr.delete(pos, pos + 1);
        }
        if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false));
        if (!done && at.length) window.dispatchEvent(new CustomEvent("ss-image-failed", { detail: error instanceof Error ? error.message : null }));
      }
      if (!done) URL.revokeObjectURL(src);
    };
    const look = (view: EditorView) => {
      current = view;
      const known: string[] = [];
      view.state.doc.descendants((node) => {
        if (node.type.name !== "image") return;
        const src = node.attrs.src;
        if (typeof src !== "string" || !src.startsWith("blob:")) return;
        // Back with undo or redo after its upload: its uploaded address
        if (uploaded.has(src)) { known.push(src); return; }
        const blob = waiting.get(src);
        if (!blob || inFlight.has(src)) return;
        inFlight.add(src);
        uploadImage(blob).then((done) => settle(src, done), (err) => settle(src, null, err));
      });
      // (not from inside the view's update)
      if (known.length) setTimeout(() => { for (const src of known) if (uploaded.has(src)) settle(src, uploaded.get(src)!); }, 0);
    };
    return [new Plugin({ view: (view) => { look(view); return { update: look, destroy: () => { current = null; } }; } })];
  },
});
