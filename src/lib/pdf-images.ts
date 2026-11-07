/**
 * A PDF's images as PNG or JPEG files Google Docs can insert. pdf.js hands
 * over decoded pixels (a JPEG's original bytes aren't kept), so each image
 * is encoded again: PNG for flat graphics and anything with transparency,
 * JPEG for photographs, small enough for the image store (700 KB).
 */

import type { PdfPixels } from "./pdf-extract";

export interface EncodedImage {
  mime: "image/png" | "image/jpeg";
  data: Uint8Array;
  width: number;
  height: number;
}

/** The image store's limit */
export const MAX_IMAGE_BYTES = 700 * 1024;
/** Wider than this is more than any page shows */
const MAX_SIDE = 2000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type CanvasModule = { createCanvas(w: number, h: number): any };
let canvasModule: CanvasModule | null | undefined;
async function canvasLib(): Promise<CanvasModule | null> {
  if (canvasModule !== undefined) return canvasModule;
  try {
    const m = (await import("@napi-rs/canvas")) as unknown as CanvasModule & { default?: CanvasModule };
    canvasModule = typeof m.createCanvas === "function" ? m : m.default ?? null;
  } catch { canvasModule = null; }
  return canvasModule;
}

/** RGBA pixels from pdf.js's 1-bit gray, RGB or RGBA images */
function rgba(px: PdfPixels): Uint8ClampedArray | null {
  const { width: w, height: h, kind, data } = px;
  const n = w * h;
  if (kind === 3) return data.length >= n * 4 ? new Uint8ClampedArray(data.buffer, data.byteOffset, n * 4) : null;
  const out = new Uint8ClampedArray(n * 4);
  if (kind === 2) {
    if (data.length < n * 3) return null;
    for (let i = 0, j = 0; i < n; i++, j += 3) { out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255; }
    return out;
  }
  if (kind === 1) {
    const row = (w + 7) >> 3;
    if (data.length < row * h) return null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (data[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
      const k = (y * w + x) * 4;
      out[k] = out[k + 1] = out[k + 2] = v;
      out[k + 3] = 255;
    }
    return out;
  }
  return null;
}

/** Whether the pixels look like a photograph (many colours) rather than a flat graphic */
function photographic(px: Uint8ClampedArray): boolean {
  const seen = new Set<number>();
  const step = Math.max(1, Math.floor(px.length / 4 / 20000));
  for (let i = 0; i < px.length; i += 4 * step) {
    seen.add((px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | (px[i + 2] >> 3));
    if (seen.size > 600) return true;
  }
  return false;
}

/**
 * Encode an image for Docs. `shown` is its size on the page in points: an image is kept at twice that
 * at most (sharp on high-density screens), and never above 2000 px a side.
 */
export async function encodeImage(px: PdfPixels, shown: { w: number; h: number }): Promise<EncodedImage | null> {
  const lib = await canvasLib();
  const data = rgba(px);
  if (!lib || !data) return null;
  const src = lib.createCanvas(px.width, px.height);
  const ctx = src.getContext("2d");
  const imageData = ctx.createImageData(px.width, px.height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  let alpha = false;
  for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) { alpha = true; break; }
  const photo = !alpha && photographic(data);
  // Twice the shown size in CSS pixels at most
  const limit = Math.min(MAX_SIDE, Math.max(64, Math.round((Math.max(shown.w, shown.h) / 0.75) * 2)));
  let scale = Math.min(1, limit / Math.max(px.width, px.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(px.width * scale));
    const h = Math.max(1, Math.round(px.height * scale));
    let canvas = src;
    if (scale < 1) {
      canvas = lib.createCanvas(w, h);
      const c = canvas.getContext("2d");
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = "high";
      c.drawImage(src, 0, 0, w, h);
    }
    const quality = [92, 85, 78, 70, 62, 55][attempt];
    const buf: Uint8Array = photo ? canvas.toBuffer("image/jpeg", quality) : canvas.toBuffer("image/png");
    if (buf.length <= MAX_IMAGE_BYTES) return { mime: photo ? "image/jpeg" : "image/png", data: new Uint8Array(buf), width: w, height: h };
    // Too large: a flat graphic with alpha stays PNG and shrinks; anything else becomes a JPEG
    scale *= photo || alpha ? 0.75 : 1;
    if (!photo && !alpha) {
      const jpg: Uint8Array = canvas.toBuffer("image/jpeg", 88);
      if (jpg.length <= MAX_IMAGE_BYTES) return { mime: "image/jpeg", data: new Uint8Array(jpg), width: w, height: h };
      scale *= 0.75;
    }
  }
  return null;
}
