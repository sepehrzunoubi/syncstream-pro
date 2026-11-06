/**
 * Images a copy carries in its HTML as data (Docs' copy of a document open for viewing, and many
 * apps' copies). The editor takes no data: address, since Google can't fetch one to put the image in
 * the document. So each is shown at once from a blob: address, uploaded as a pasted image file is,
 * and given its uploaded address, which the sync can insert. One that can't be uploaded is taken
 * out, with a message: the page doesn't show an image the document won't have. So is any other
 * image not on the web (a file: address from a word processor's copy), and one whose blob: address
 * is gone (a draft saved while it uploaded, back after a reload).
 */

import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { PENDING_MARK } from "@/lib/doc-model";
import { uploadImage } from "./image-upload";

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
const IMG_DATA_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(data:image\/[^"']*)\2/gi;
/** An address Google can fetch an image from: what the sync inserts */
const ON_THE_WEB = /^https?:\/\//i;

type Uploaded = { url: string; width: number; height: number };
/** Blob addresses of pasted images still to upload, those uploaded, and those that can't be (with why) */
const waiting = new Map<string, Blob>();
const uploaded = new Map<string, Uploaded>();
const failed = new Map<string, string | null>();

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

/**
 * Whether an image's address is one the sync can't insert yet: a pasted image's, until it's uploaded
 * (or, when it can't be, taken out)
 */
export const isUploadingImage = (src: unknown) => typeof src === "string" && src.startsWith("blob:");

/** Why an image can't be in the document, for the message */
const reason = (error: unknown) => (error instanceof Error && error.message ? error.message : null);

export const PastedImages = Extension.create({
  name: "pastedImages",
  addProseMirrorPlugins() {
    const inFlight = new Set<string>();
    let current: EditorView | null = null;
    /** Every image with this address: its uploaded one, or (when it can't be uploaded) out, with a message */
    const apply = (src: unknown) => {
      const view = current;
      if (!view || (view as unknown as { isDestroyed?: boolean }).isDestroyed) return;
      const done = typeof src === "string" ? uploaded.get(src) : undefined;
      const tr = view.state.tr;
      const at: number[] = [];
      tr.doc.descendants((node, pos) => { if (node.type.name === "image" && node.attrs.src === src) at.push(pos); });
      for (const pos of at.reverse()) {
        const attrs = tr.doc.nodeAt(pos)!.attrs;
        if (done) tr.setNodeMarkup(pos, undefined, { ...attrs, src: done.url, width: attrs.width ?? done.width, height: attrs.height ?? done.height });
        else tr.delete(pos, pos + 1);
      }
      if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false));
      if (!done && at.length) window.dispatchEvent(new CustomEvent("ss-image-failed", { detail: typeof src === "string" ? failed.get(src) ?? null : null }));
    };
    const settle = (src: string, done: Uploaded | null, error?: unknown) => {
      inFlight.delete(src);
      waiting.delete(src);
      if (done) uploaded.set(src, done);
      else failed.set(src, reason(error));
      apply(src);
      if (!done) URL.revokeObjectURL(src);
    };
    const look = (view: EditorView) => {
      current = view;
      const now = new Set<unknown>();
      view.state.doc.descendants((node) => {
        if (node.type.name !== "image") return;
        const src: unknown = node.attrs.src;
        if (typeof src === "string" && ON_THE_WEB.test(src)) return;
        if (typeof src !== "string" || !src.startsWith("blob:")) {
          // Google can't fetch it: one the sync would add (never the document's own)
          if (!node.marks.some((m) => m.type.name === PENDING_MARK)) return;
          if (typeof src === "string") failed.set(src, "it isn't on the web, so the document can't have it");
          now.add(src);
          return;
        }
        // Back with undo or redo after its upload: its uploaded address. After a failed one: out again
        if (uploaded.has(src) || failed.has(src)) { now.add(src); return; }
        if (inFlight.has(src)) return;
        inFlight.add(src);
        // One this page didn't make (a draft saved while it uploaded, back after a reload): its image, while there is one
        const blob = waiting.get(src);
        const image = blob ? Promise.resolve(blob) : fetch(src).then((r) => (r.ok ? r.blob() : Promise.reject(new Error())), () => Promise.reject(new Error()))
          .catch(() => Promise.reject(new Error("it was gone before it was uploaded")));
        image.then((b) => uploadImage(b)).then((done) => settle(src, done), (err) => settle(src, null, err));
      });
      // (not from inside the view's update)
      if (now.size) setTimeout(() => { for (const src of now) apply(src); }, 0);
    };
    return [new Plugin({ view: (view) => { look(view); return { update: look, destroy: () => { current = null; } }; } })];
  },
});
