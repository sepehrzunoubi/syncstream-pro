import { Redis } from "@upstash/redis";
import { randomBytes } from "crypto";

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
