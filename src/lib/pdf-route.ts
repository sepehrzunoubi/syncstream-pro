/**
 * Import PDF, on the server: read the uploaded bytes into editor content
 * (src/lib/pdf-import.ts), put its images in the image store so a sync can
 * insert them, and answer with what the editor needs. The route
 * (src/app/api/pdf/import) only adds sign-in and rate limiting around it.
 */

import { importPdf, PdfImportError, type PdfImportErrorCode, type PdfImportResult } from "./pdf-import";
import { saveImage } from "./image-store";
import type { PageSetup } from "./page-setup";
import type { EditorNode } from "./rich-text";

/** The largest PDF people are told they can import */
export const MAX_PDF_BYTES = 4 * 1024 * 1024;
/** What the route reads at most: a little over the limit people see, under the platform's 4.5 MB */
export const MAX_PDF_BODY = 4_400_000;
/** Reading stops waiting after this; the function itself is allowed 60 s */
export const PDF_TIMEOUT_MS = 45_000;
/** Storing the images takes at most this after the reading: the answer comes before the 60 s are up */
export const STORE_TIMEOUT_MS = 10_000;
/** Images stored at the same time */
const STORE_CONCURRENCY = 4;

export const IMAGE_PREFIX = "pdf-image:";

/** What /api/pdf/import answers with */
export interface PdfImportBody {
  nodes: EditorNode[];
  pageSetup: PageSetup;
  header?: EditorNode[];
  footer?: EditorNode[];
  fonts: string[];
  pages: number;
  tagged: boolean;
  warnings: string[];
  stats: PdfImportResult["stats"];
}

/** Why a PDF wasn't imported: the reader's reasons, or it took too long, or something unexpected broke */
export type PdfErrorCode = PdfImportErrorCode | "timeout" | "failed";

export type PdfImportReply =
  | { ok: true; status: 200; body: PdfImportBody }
  | { ok: false; status: number; body: { error: string; code: PdfErrorCode } };

export const TOO_LARGE_MESSAGE = "This PDF is over 4 MB, the most you can import. Make it smaller (for example by saving it again with smaller images), or split it, then import it again.";
const TIMEOUT_MESSAGE = "This PDF took too long to read. Try again, or import a shorter part of it.";
const FAILED_MESSAGE = "Couldn't import this PDF. Try again, or try another PDF.";
const NOT_PDF_MESSAGE = "This file couldn't be read as a PDF. It may be damaged, or not a PDF.";
const IMAGE_LOST = "An image in this PDF couldn't be copied.";

/** A PDF starts with "%PDF-" (some writers put a few bytes before it) */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

/**
 * The editor content with each "pdf-image:<key>" image pointing at its stored copy. Images whose
 * copy couldn't be stored are left out (the count says how many).
 */
export function placeImages(nodes: EditorNode[], urls: ReadonlyMap<string, string>): { nodes: EditorNode[]; dropped: number } {
  let dropped = 0;
  const walk = (list: EditorNode[]): EditorNode[] => {
    const out: EditorNode[] = [];
    for (const n of list) {
      const src = n.type === "image" && typeof n.attrs?.src === "string" ? n.attrs.src : null;
      if (src?.startsWith(IMAGE_PREFIX)) {
        const url = urls.get(src.slice(IMAGE_PREFIX.length));
        if (!url) { dropped++; continue; }
        out.push({ ...n, attrs: { ...n.attrs, src: url } });
        continue;
      }
      out.push(n.content ? { ...n, content: walk(n.content) } : n);
    }
    return out;
  };
  return { nodes: walk(nodes), dropped };
}

/** Run `fn` over `items`, at most `limit` at a time; none is started once `until` (a time) has gone by */
async function eachLimited<T>(items: T[], limit: number, until: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length && Date.now() < until) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Resolves with `p`, or rejects with "timeout" once `ms` have gone by */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PdfTimeout()), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

class PdfTimeout extends Error {
  constructor() { super("PDF import timed out"); this.name = "PdfTimeout"; }
}

export interface ImportOptions {
  /** This deployment's address, which the stored images are served from (Google fetches them there) */
  baseUrl: string;
  timeoutMs?: number;
  /** How long storing the images may take (STORE_TIMEOUT_MS); those not stored by then are left out */
  storeTimeoutMs?: number;
  /** For tests: the reader and the image store */
  read?: (bytes: Uint8Array) => Promise<PdfImportResult>;
  store?: (mime: string, base64: string) => Promise<string>;
  /** Told about failures worth logging (an image the store refused, an unexpected error) */
  onProblem?: (event: string, err: unknown) => void;
}

/** Read an uploaded PDF and answer the way /api/pdf/import does */
export async function importPdfForEditor(bytes: Uint8Array, opts: ImportOptions): Promise<PdfImportReply> {
  if (bytes.length > MAX_PDF_BODY) return { ok: false, status: 413, body: { error: TOO_LARGE_MESSAGE, code: "tooLarge" } };
  if (!bytes.length || !looksLikePdf(bytes)) return { ok: false, status: 422, body: { error: NOT_PDF_MESSAGE, code: "invalid" } };
  const read = opts.read ?? ((b: Uint8Array) => importPdf(b));
  let result: PdfImportResult;
  try {
    result = await within(read(bytes), opts.timeoutMs ?? PDF_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof PdfImportError) return { ok: false, status: 422, body: { error: err.message, code: err.code } };
    if (err instanceof PdfTimeout) return { ok: false, status: 504, body: { error: TIMEOUT_MESSAGE, code: "timeout" } };
    opts.onProblem?.("pdf.import_failed", err);
    return { ok: false, status: 500, body: { error: FAILED_MESSAGE, code: "failed" } };
  }

  const store = opts.store ?? saveImage;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const urls = new Map<string, string>();
  await eachLimited(result.images, STORE_CONCURRENCY, Date.now() + (opts.storeTimeoutMs ?? STORE_TIMEOUT_MS), async (img) => {
    try {
      const id = await store(img.mime, Buffer.from(img.data).toString("base64"));
      urls.set(img.key, `${base}/api/images/${id}`);
    } catch (err) {
      opts.onProblem?.("pdf.image_store_failed", err);
    }
  });
  const body = placeImages(result.nodes, urls);
  const warnings = [...result.warnings];
  if (body.dropped && !warnings.includes(IMAGE_LOST)) warnings.push(IMAGE_LOST);
  return {
    ok: true,
    status: 200,
    body: {
      nodes: body.nodes,
      pageSetup: result.pageSetup,
      ...(result.header ? { header: result.header } : {}),
      ...(result.footer ? { footer: result.footer } : {}),
      fonts: result.fonts,
      pages: result.pages,
      tagged: result.tagged,
      warnings,
      stats: { ...result.stats, images: Math.max(0, result.stats.images - body.dropped) },
    },
  };
}

/** The request body, up to `max` bytes; null when it is longer */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
