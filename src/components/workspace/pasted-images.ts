/**
 * Images a copy carries in its HTML as data (Docs' copy of a document open for viewing, and many
 * apps' copies). The editor takes no data: address, since Google can't fetch one to put the image in
 * the document. So each is shown at once from a blob: address, uploaded as a pasted image file is,
 * and given its uploaded address, which the sync can insert. One that can't be uploaded is taken
 * out, with a message: the page doesn't show an image the document won't have. So is any other
 * image not on the web (a file: address from a word processor's copy, another site's blob:, an
 * address too long for Docs), and one whose blob: address is gone (a draft saved while it uploaded,
 * back after a reload, when its upload didn't finish).
 *
 * Uploads go a few at a time: the upload route takes so many a minute, and when it says it has had
 * too many, they wait as long as it says, the images still showing (and the sync still waiting).
 */

import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { PENDING_MARK } from "@/lib/doc-model";
import { isInsertableImageSrc } from "@/lib/rich-text";
import { uploadImage, UploadError } from "./image-upload";

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
const IMG_DATA_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(data:image\/[^"']*)\2/gi;

type Uploaded = { url: string; width: number; height: number };
/** Blob addresses of pasted images still to upload, those uploaded, and those that can't be (with why) */
const waiting = new Map<string, Blob>();
const uploaded = new Map<string, Uploaded>();
const failed = new Map<string, string | null>();

/**
 * Uploads finished, by blob: address, where a draft saved while they uploaded (with their blob:
 * address) finds them after a reload: the upload may finish while its document isn't shown
 */
const UPLOADED_KEY = "syncstream_uploaded_images";
const KEPT = 200;
function storedUpload(src: string): Uploaded | null {
  try {
    const all = JSON.parse(localStorage.getItem(UPLOADED_KEY) ?? "{}") as Record<string, Uploaded>;
    const done = all[src];
    return done && typeof done.url === "string" && isInsertableImageSrc(done.url) ? done : null;
  } catch {
    return null;
  }
}
function storeUpload(src: string, done: Uploaded): void {
  try {
    const all = JSON.parse(localStorage.getItem(UPLOADED_KEY) ?? "{}") as Record<string, Uploaded>;
    all[src] = done;
    localStorage.setItem(UPLOADED_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-KEPT))));
  } catch { /* storage blocked */ }
}

/** Uploads at a time, and when the route takes more again (after it said too many) */
const AT_ONCE = 3;
const queue: (() => Promise<void>)[] = [];
let running = 0;
let resumeAt = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
function pump(): void {
  while (running < AT_ONCE && queue.length) {
    const wait = resumeAt - Date.now();
    if (wait > 0) {
      if (!resumeTimer) resumeTimer = setTimeout(() => { resumeTimer = null; pump(); }, wait);
      return;
    }
    const task = queue.shift()!;
    running++;
    void task().finally(() => { running--; pump(); });
  }
}

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

/**
 * The pasted HTML with each image given as data shown from a blob: address, to upload once pasted.
 * The same image twice in a copy is one address, uploaded once.
 */
export function pastedImageSources(html: string): string {
  if (!/data:image\//i.test(html) || typeof URL.createObjectURL !== "function") return html;
  const made = new Map<string, string>();
  return html.replace(IMG_DATA_SRC, (all, pre: string, quote: string, src: string) => {
    let url = made.get(src);
    if (!url) {
      const blob = blobOf(src);
      if (!blob) return all;
      url = URL.createObjectURL(blob);
      waiting.set(url, blob);
      made.set(src, url);
    }
    return `${pre}${quote}${url}${quote}`;
  });
}

/**
 * Pasted HTML for a header, footer or footnote. Those editors upload nothing, and what a sync adds
 * never goes there: an image is kept only when the save can insert it (on the web, or a pasted image
 * already uploaded, at its address), and in a footnote, never (Docs takes no image there). Any
 * other is left out, with a message.
 */
export function segmentImageSources(html: string, footnote = false): string {
  if (!/<img\b/i.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let left = 0;
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    const done = uploaded.get(src) ?? null;
    if (!footnote && done) img.setAttribute("src", done.url);
    else if (footnote || !/^https:\/\//i.test(src) || !isInsertableImageSrc(src)) { img.remove(); left++; }
  }
  if (!left) return html;
  const why = footnote ? "a footnote can't have an image" : "a header or footer takes an image only from a web address";
  setTimeout(() => window.dispatchEvent(new CustomEvent("ss-image-failed", { detail: why })), 0);
  return doc.body.innerHTML;
}

/**
 * Whether an image's address is one the sync can't insert yet: a pasted image's, until it's uploaded
 * (or, when it can't be, taken out)
 */
export const isUploadingImage = (src: unknown) => typeof src === "string" && src.startsWith("blob:");

/** Why an image can't be in the document, for the message */
const reason = (error: unknown) => (error instanceof Error && error.message ? error.message : null);

/** Whether a blob: address is another site's (shown there, never this page's to read) */
function foreign(src: string): boolean {
  try {
    return new URL(src).origin !== window.location.origin;
  } catch {
    return true;
  }
}

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
      if (done) { uploaded.set(src, done); storeUpload(src, done); }
      else failed.set(src, reason(error));
      apply(src);
      if (!done) URL.revokeObjectURL(src);
    };
    const upload = (src: string, image: Promise<Blob>) => {
      const attempt = async () => {
        try {
          settle(src, await uploadImage(await image));
        } catch (err) {
          // Too many for now: it waits its turn again, after as long as the route says
          if (err instanceof UploadError && err.status === 429) {
            resumeAt = Math.max(resumeAt, Date.now() + (err.retryAfter ?? 30) * 1000);
            queue.unshift(attempt);
          } else settle(src, null, err);
        }
      };
      // (an image gone before its turn is settled then)
      image.catch(() => {});
      queue.push(attempt);
      pump();
    };
    const look = (view: EditorView) => {
      current = view;
      const now = new Set<unknown>();
      view.state.doc.descendants((node) => {
        if (node.type.name !== "image") return;
        const src: unknown = node.attrs.src;
        if (isInsertableImageSrc(src)) return;
        if (typeof src !== "string" || !src.startsWith("blob:")) {
          // Google can't fetch it: one the sync would add (never the document's own)
          if (!node.marks.some((m) => m.type.name === PENDING_MARK)) return;
          if (typeof src === "string") failed.set(src, /^https?:\/\//i.test(src) ? "its web address is too long for Google Docs" : "it isn't on the web, so the document can't have it");
          now.add(src);
          return;
        }
        // Back with undo or redo after its upload: its uploaded address. After a failed one: out again
        if (uploaded.has(src) || failed.has(src)) { now.add(src); return; }
        if (inFlight.has(src)) return;
        const stored = storedUpload(src);
        if (stored) { uploaded.set(src, stored); now.add(src); return; }
        // Another site's (a web app showing its images from blob: addresses): not there to upload
        if (!waiting.has(src) && foreign(src)) {
          failed.set(src, "another site shows it, so it can't be copied from there (copy the image itself)");
          now.add(src);
          return;
        }
        inFlight.add(src);
        // One this page didn't make (a draft saved while it uploaded, back after a reload): its image, while there is one
        const blob = waiting.get(src);
        upload(src, blob ? Promise.resolve(blob) : fetch(src).then((r) => (r.ok ? r.blob() : Promise.reject(new Error())), () => Promise.reject(new Error()))
          .catch(() => Promise.reject(new Error("it was gone before it was uploaded"))));
      });
      // (not from inside the view's update)
      if (now.size) setTimeout(() => { for (const src of now) apply(src); }, 0);
    };
    return [new Plugin({ view: (view) => { look(view); return { update: look, destroy: () => { current = null; } }; } })];
  },
});
