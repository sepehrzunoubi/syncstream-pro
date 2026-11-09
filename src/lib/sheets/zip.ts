/**
 * Reading a zip archive (an .xlsx file is one), in the browser and on the server alike: the
 * directory at the end of the file names every entry, and each entry is inflated when asked for.
 * Only what .xlsx files use: stored and deflated entries, no encryption, no zip64.
 */

export class ZipError extends Error {}

interface Entry { method: number; compressedSize: number; size: number; offset: number }

/** Everything unpacked from one file, in bytes: a small archive can't be made to fill memory */
export const MAX_UNPACKED = 80 * 1024 * 1024;

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new ZipError("This browser can't unpack the file");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    // (the directory's size is what was promised; an entry that unpacks past it is not what it says)
    if (total > Math.max(expected, 1024) * 1.01 + 1024 || total > MAX_UNPACKED) throw new ZipError("The file unpacks to more than it should");
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export class Zip {
  private readonly entries = new Map<string, Entry>();
  private unpacked = 0;

  constructor(private readonly bytes: Uint8Array) {
    const b = bytes;
    // The end record is the last thing in the file, before at most 64 KB of comment
    let end = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { end = i; break; }
    }
    if (end < 0) throw new ZipError("Not a zip archive");
    const count = u16(b, end + 10);
    let at = u32(b, end + 16);
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (at + 46 > b.length || u32(b, at) !== 0x02014b50) throw new ZipError("The archive's directory is damaged");
      const method = u16(b, at + 10);
      const compressedSize = u32(b, at + 20);
      const size = u32(b, at + 24);
      const nameLen = u16(b, at + 28);
      const extraLen = u16(b, at + 30);
      const commentLen = u16(b, at + 32);
      const offset = u32(b, at + 42);
      const name = decoder.decode(b.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, "/").replace(/^\//, "");
      this.entries.set(name, { method, compressedSize, size, offset });
      at += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return Array.from(this.entries.keys());
  }

  /** An entry's bytes, or null when the archive has no such entry */
  async read(name: string): Promise<Uint8Array | null> {
    const e = this.entries.get(name) ?? this.entries.get(this.names().find((n) => n.toLowerCase() === name.toLowerCase()) ?? "");
    if (!e) return null;
    const b = this.bytes;
    if (e.offset + 30 > b.length || u32(b, e.offset) !== 0x04034b50) throw new ZipError("The archive is damaged");
    const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
    const data = b.subarray(start, start + e.compressedSize);
    this.unpacked += e.size;
    if (this.unpacked > MAX_UNPACKED) throw new ZipError("The file is too large once unpacked");
    if (e.method === 0) return data;
    if (e.method !== 8) throw new ZipError("The archive is packed in a way that can't be read");
    return inflateRaw(data, e.size);
  }

  async text(name: string): Promise<string | null> {
    const data = await this.read(name);
    return data ? new TextDecoder("utf-8").decode(data) : null;
  }
}
