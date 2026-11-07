import { Redis } from "@upstash/redis";
import { randomBytes } from "crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { getBaseUrl } from "./base-url";
import { log } from "./log";

/**
 * Images typed into a doc must be at a public URL when Google inserts them.
 * They are kept in Redis for two weeks (longer than any sync can run) and
 * served from /api/images/<id>, where the id is unguessable.
 */

const PREFIX = "img:";
const TTL_SECONDS = 14 * 24 * 3600;
/** Upstash's free tier caps a request near 1 MB; base64 adds a third */
export const MAX_IMAGE_BYTES = 700 * 1024;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

interface Stored { m: string; d: string }

const memory = new Map<string, Stored>();

function redis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? new Redis({ url, token }) : null;
}

export async function saveImage(mime: string, base64: string): Promise<string> {
  const id = randomBytes(18).toString("base64url");
  const value: Stored = { m: mime, d: base64 };
  const r = redis();
  if (r) await r.set(PREFIX + id, value, { ex: TTL_SECONDS });
  else memory.set(id, value);
  return id;
}

export async function loadImage(id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  const r = redis();
  const value = r ? await r.get<Stored>(PREFIX + id) : memory.get(id);
  if (!value?.d || !IMAGE_TYPES.has(value.m)) return null;
  return { mime: value.m, bytes: Buffer.from(value.d, "base64") };
}

// ── Copying an image from another address ─────────────────────────────────
// A Google Doc's images are read as addresses on Google's servers that work for 30 minutes
// (contentUri). A sync types an image much later, so it is copied here first.

/** Where a document's images are read from: Google's image servers */
export const GOOGLE_IMAGE_HOSTS: readonly string[] = ["*.googleusercontent.com", "docs.google.com"];
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
/** "Images ... cannot exceed 25 megapixels" (InsertInlineImageRequest) */
const MAX_DOCS_PIXELS = 25_000_000;
/** Bigger ones aren't decoded: the bitmap alone would take too much memory */
const MAX_DECODE_PIXELS = 40_000_000;
/** A converted image's longest side: twice what a page shows, at most */
const MAX_SIDE = 2400;

type Kind = "png" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "avif";
const MIME: Partial<Record<Kind, string>> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif" };

export interface ImportImageOptions {
  /** Hosts it may be fetched from: a name, or "*.example.com" for any name under it. Default: Google's image servers */
  allowHosts?: readonly string[];
  /** Sent to the image's own host, for an image only the user can see */
  accessToken?: string;
  /** This deployment's address, which Google fetches the copy from (default: getBaseUrl()) */
  baseUrl?: string;
  timeoutMs?: number;
  /** For tests: the fetch and the DNS lookup used */
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
}

/**
 * Copy an image from `url` into the store, as PNG, JPEG or GIF of at most MAX_IMAGE_BYTES (made
 * smaller, or converted from WebP, BMP or AVIF, when it has to be), and give the address a sync
 * inserts it from. Null when it can't be fetched from there or isn't an image Docs can show.
 */
export async function importImageFromUrl(url: string, opts: ImportImageOptions = {}): Promise<{ id: string; url: string } | null> {
  let host = "";
  try {
    host = new URL(url).hostname;
    const bytes = await download(url, opts);
    if (!bytes) return null;
    const image = await fitForDocs(bytes);
    if (!image) {
      log.warn("images.import_refused", { host, bytes: bytes.length, reason: "not an image Docs can show" });
      return null;
    }
    const id = await saveImage(image.mime, image.bytes.toString("base64"));
    log.info("images.imported", { host, bytes: bytes.length, stored: image.bytes.length, mime: image.mime, converted: image.converted });
    return { id, url: `${(opts.baseUrl ?? getBaseUrl()).replace(/\/+$/, "")}/api/images/${id}` };
  } catch (err) {
    // (the address itself is a credential for the image: only its host is logged)
    log.warn("images.import_failed", { host, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Whether `host` is one of `allow` ("*.x.com": any name under x.com) */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((p) => {
    const a = p.toLowerCase();
    return a.startsWith("*.") ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a;
  });
}

/** Addresses that aren't on the public internet: this machine, private networks, link-local, multicast, reserved */
const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) NOT_PUBLIC.addSubnet(net, bits, "ipv4");
// (an IPv4 address written as IPv6, ::ffff:a.b.c.d, is checked against the IPv4 ranges)
for (const [net, bits] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) NOT_PUBLIC.addSubnet(net, bits, "ipv6");

/** Whether an IP address is on the public internet */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  return v !== 0 && !NOT_PUBLIC.check(ip, v === 6 ? "ipv6" : "ipv4");
}

/** An address that may be fetched: http(s), an allowed host, nothing but public addresses behind it */
async function checkTarget(url: URL, allow: readonly string[], lookup: (host: string) => Promise<string[]>): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`not a web address (${url.protocol})`);
  if (url.username || url.password) throw new Error("an address with credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostAllowed(host, allow)) throw new Error(`host not allowed: ${host}`);
  const addresses = isIP(host) ? [host] : await lookup(host);
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error(`host is not on the public internet: ${host}`);
}

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The bytes at `url`, following redirects that stay within the allowed hosts; null when it can't be fetched */
async function download(url: string, opts: ImportImageOptions): Promise<Buffer | null> {
  const allow = opts.allowHosts ?? GOOGLE_IMAGE_HOSTS;
  const lookup = opts.lookup ?? defaultLookup;
  const doFetch = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  let at = new URL(url);
  const origin = at.origin;
  for (let hop = 0; ; hop++) {
    await checkTarget(at, allow, lookup);
    const headers: Record<string, string> = { Accept: "image/png,image/jpeg,image/gif,image/webp,image/*;q=0.8" };
    // The user's token only ever goes to the host the image was read from
    if (opts.accessToken && at.origin === origin) headers.Authorization = `Bearer ${opts.accessToken}`;
    const res = await doFetch(at, { headers, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!next || hop >= MAX_REDIRECTS) throw new Error(`too many redirects (HTTP ${res.status})`);
      at = new URL(next, at);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (declared > MAX_DOWNLOAD_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`too large (${declared} bytes)`);
    }
    return readCapped(res, MAX_DOWNLOAD_BYTES);
  }
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`too large (over ${max} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The image format, from its first bytes */
export function sniffImage(b: Uint8Array): Kind | null {
  const at = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (at(0, "BM") && b.length >= 26) return "bmp";
  if ((at(0, "II") && b[2] === 42 && b[3] === 0) || (at(0, "MM") && b[2] === 0 && b[3] === 42)) return "tiff";
  if (at(4, "ftyp") && (at(8, "avif") || at(8, "avis"))) return "avif";
  return null;
}

/** Width and height from the image's header, without decoding it (null: not found) */
export function imageSize(b: Buffer, kind: Kind): { w: number; h: number } | null {
  try {
    switch (kind) {
      case "png": return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
      case "gif": return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
      case "bmp": return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
      case "jpeg": {
        // The first start-of-frame marker holds the size
        for (let i = 2; i + 9 < b.length; ) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1];
          if (m === 0xff) { i++; continue; }
          if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
          i += 2 + b.readUInt16BE(i + 2);
        }
        return null;
      }
      case "webp": {
        const chunk = b.toString("latin1", 12, 16);
        if (chunk === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
        if (chunk === "VP8L") { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
        if (chunk === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
        return null;
      }
      case "avif": {
        // The image spatial extents property: size, "ispe", version and flags, width, height
        const i = b.indexOf("ispe", 0, "latin1");
        return i >= 4 && i + 16 <= b.length ? { w: b.readUInt32BE(i + 8), h: b.readUInt32BE(i + 12) } : null;
      }
      default: return null;
    }
  } catch {
    return null;
  }
}

/**
 * The image as Docs inserts it and the store keeps it: PNG, JPEG or GIF of at most MAX_IMAGE_BYTES
 * and 25 megapixels. One that already is goes as it is; any other is decoded and saved again,
 * smaller step by step until it fits (PNG first when it may have see-through parts or sharp lines,
 * then JPEG on white). Null when it can't be read or made to fit.
 */
export async function fitForDocs(bytes: Buffer): Promise<{ mime: string; bytes: Buffer; converted: boolean } | null> {
  const kind = sniffImage(bytes);
  if (!kind) return null;
  const size = imageSize(bytes, kind);
  if (!size || size.w < 1 || size.h < 1) return null;
  const pixels = size.w * size.h;
  const mime = MIME[kind];
  if (mime && bytes.length <= MAX_IMAGE_BYTES && pixels <= MAX_DOCS_PIXELS) return { mime, bytes, converted: false };
  if (pixels > MAX_DECODE_PIXELS) return null;

  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(bytes).catch(() => null);
  if (!img || !img.width || !img.height) return null;
  const lossless = kind !== "jpeg";
  let scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height), Math.sqrt(MAX_DOCS_PIXELS / (img.width * img.height)));
  for (let step = 0; step < 8; step++, scale *= 0.75) {
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const draw = (white: boolean) => {
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      if (white) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
      return canvas;
    };
    if (lossless) {
      const png = await draw(false).encode("png");
      if (png.length <= MAX_IMAGE_BYTES) return { mime: "image/png", bytes: png, converted: true };
    }
    const canvas = draw(true);
    for (const quality of [85, 70]) {
      const jpeg = await canvas.encode("jpeg", quality);
      if (jpeg.length <= MAX_IMAGE_BYTES) return { mime: "image/jpeg", bytes: jpeg, converted: true };
    }
  }
  return null;
}
