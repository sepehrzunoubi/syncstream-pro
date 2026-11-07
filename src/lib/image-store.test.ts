import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage as decode } from "@napi-rs/canvas";
import { fitForDocs, hostAllowed, imageSize, importImageFromUrl, isPublicAddress, loadImage, MAX_IMAGE_BYTES, sniffImage, type ImportImageOptions } from "./image-store";

/** A w×h image of random colours: it compresses badly, so it is big */
function noise(w: number, h: number) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(w, h);
  let seed = 7;
  for (let i = 0; i < data.data.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    data.data[i] = i % 4 === 3 ? 255 : seed & 0xff;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}
function flat(w: number, h: number) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3366cc";
  ctx.fillRect(0, 0, w, h);
  return canvas;
}

test("an image's format and size are read from its first bytes", async () => {
  const c = flat(64, 48);
  for (const [kind, bytes] of [["png", await c.encode("png")], ["jpeg", await c.encode("jpeg", 80)], ["webp", await c.encode("webp", 80)], ["gif", await c.encode("gif", 80)], ["avif", await c.encode("avif")]] as const) {
    assert.equal(sniffImage(bytes), kind);
    assert.deepEqual(imageSize(bytes, kind), { w: 64, h: 48 }, kind);
  }
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffImage(Buffer.from("")), null);
});

test("an image Docs can take as it is is kept as it is; others are made to fit", async () => {
  const small = await flat(200, 100).encode("png");
  const kept = (await fitForDocs(small))!;
  assert.equal(kept.converted, false);
  assert.equal(kept.bytes, small);
  assert.equal(kept.mime, "image/png");

  // Too big to store: smaller, still a picture of the same shape
  const big = await noise(900, 600).encode("png");
  assert.ok(big.length > MAX_IMAGE_BYTES);
  const fitted = (await fitForDocs(big))!;
  assert.ok(fitted.converted && fitted.bytes.length <= MAX_IMAGE_BYTES);
  assert.ok(fitted.mime === "image/png" || fitted.mime === "image/jpeg");
  const img = await decode(fitted.bytes);
  assert.ok(Math.abs(img.width / img.height - 1.5) < 0.01, `${img.width}x${img.height}`);

  // A format Docs doesn't take: converted
  const webp = (await fitForDocs(await flat(300, 200).encode("webp", 90)))!;
  assert.equal(webp.mime, "image/png");
  assert.equal(sniffImage(webp.bytes), "png");

  // Not an image, or one too large to open safely: none
  assert.equal(await fitForDocs(Buffer.from("not an image at all")), null);
  const bomb = Buffer.from(await flat(8, 8).encode("png"));
  bomb.writeUInt32BE(30_000, 16);
  bomb.writeUInt32BE(30_000, 20);
  assert.equal(await fitForDocs(bomb), null, "900 megapixels aren't decoded");
});

test("only Google's image servers, on the public internet, are fetched from", async () => {
  assert.ok(hostAllowed("lh3.googleusercontent.com", ["*.googleusercontent.com"]));
  assert.ok(hostAllowed("docs.google.com", ["docs.google.com"]));
  assert.ok(!hostAllowed("googleusercontent.com.evil.com", ["*.googleusercontent.com"]));
  assert.ok(!hostAllowed("evilgoogleusercontent.com", ["*.googleusercontent.com"]));
  assert.ok(!hostAllowed("mail.google.com", ["docs.google.com"]));
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["142.250.80.1", "2607:f8b0:4004:c07::84", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress("not-an-ip"), false);
});

/** importImageFromUrl over a fake web: `pages` by URL, every host resolving to `ip` unless named in `dns` */
function web(pages: Record<string, () => Response | Promise<Response>>, dns: Record<string, string[]> = {}) {
  const asked: { url: string; auth: string | null }[] = [];
  const opts: ImportImageOptions = {
    baseUrl: "https://syncstream.example/",
    lookup: async (host) => dns[host] ?? ["142.250.80.1"],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, auth: new Headers(init?.headers).get("authorization") });
      assert.equal(init?.redirect, "manual", "redirects are checked one by one");
      const page = pages[url];
      return page ? page() : new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  return { asked, opts };
}
const png = async () => new Response(new Uint8Array(await flat(120, 80).encode("png")), { headers: { "content-type": "image/png" } });

test("a reference document's image is copied into the store, at an address Google can fetch", async () => {
  const bytes = await flat(120, 80).encode("png");
  const { asked, opts } = web({ "https://lh3.googleusercontent.com/abc=w120": () => new Response(new Uint8Array(bytes)) });
  const got = (await importImageFromUrl("https://lh3.googleusercontent.com/abc=w120", { ...opts, accessToken: "tok" }))!;
  assert.match(got.url, /^https:\/\/syncstream\.example\/api\/images\/[A-Za-z0-9_-]{16,64}$/);
  assert.ok(got.url.endsWith(got.id));
  const stored = (await loadImage(got.id))!;
  assert.equal(stored.mime, "image/png");
  assert.deepEqual(stored.bytes, Buffer.from(bytes));
  assert.deepEqual(asked, [{ url: "https://lh3.googleusercontent.com/abc=w120", auth: "Bearer tok" }]);
});

test("anything else is refused before it is fetched, and a redirect is followed only where it may go", async () => {
  const { asked, opts } = web({
    "https://lh3.googleusercontent.com/hop": () => new Response(null, { status: 302, headers: { location: "https://lh4.googleusercontent.com/img" } }),
    "https://lh4.googleusercontent.com/img": () => new Response(null, { status: 302, headers: { location: "/final" } }),
    "https://lh4.googleusercontent.com/final": () => new Response("x"),
    "https://lh3.googleusercontent.com/out": () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    "https://lh3.googleusercontent.com/denied": () => new Response("no", { status: 403 }),
  }, { "lh5.googleusercontent.com": ["10.0.0.7"] });
  for (const url of ["file:///etc/passwd", "ftp://lh3.googleusercontent.com/a.png", "https://example.com/a.png", "https://user:pw@lh3.googleusercontent.com/a.png", "https://127.0.0.1/a.png", "https://lh5.googleusercontent.com/a.png", "not a url"]) {
    assert.equal(await importImageFromUrl(url, opts), null, url);
  }
  assert.equal(asked.length, 0, "none of them was fetched");
  // Redirected to another of Google's servers: followed, without the token
  const followed = await importImageFromUrl("https://lh3.googleusercontent.com/hop", { ...opts, accessToken: "tok" });
  assert.equal(followed, null, "(its last page isn't an image)");
  assert.deepEqual(asked.map((a) => [a.url, a.auth]), [["https://lh3.googleusercontent.com/hop", "Bearer tok"], ["https://lh4.googleusercontent.com/img", null], ["https://lh4.googleusercontent.com/final", null]]);
  asked.length = 0;
  // Redirected anywhere else: not followed
  assert.equal(await importImageFromUrl("https://lh3.googleusercontent.com/out", opts), null);
  assert.deepEqual(asked.map((a) => a.url), ["https://lh3.googleusercontent.com/out"]);
  assert.equal(await importImageFromUrl("https://lh3.googleusercontent.com/denied", opts), null);
  // Another allowlist, for a caller that copies from elsewhere
  const other = web({ "https://cdn.example.org/a.png": png });
  assert.ok(await importImageFromUrl("https://cdn.example.org/a.png", { ...other.opts, allowHosts: ["cdn.example.org"] }));
});

test("a download that is too large or too slow is given up", async () => {
  const MB = 1024 * 1024;
  const { opts } = web({
    "https://lh3.googleusercontent.com/declared": () => new Response("x", { headers: { "content-length": String(26 * MB) } }),
    "https://lh3.googleusercontent.com/endless": () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(MB)); } })),
  });
  assert.equal(await importImageFromUrl("https://lh3.googleusercontent.com/declared", opts), null);
  assert.equal(await importImageFromUrl("https://lh3.googleusercontent.com/endless", opts), null);
  const slow: ImportImageOptions = { ...opts, timeoutMs: 50, fetch: ((_u: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch };
  // (the timeout's timer doesn't keep a process alive; a server's open request does)
  const alive = setTimeout(() => {}, 5_000);
  try {
    assert.equal(await importImageFromUrl("https://lh3.googleusercontent.com/slow", slow), null);
  } finally {
    clearTimeout(alive);
  }
});
