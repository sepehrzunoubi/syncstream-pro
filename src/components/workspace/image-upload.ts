/** Max bytes the upload route accepts (keep in sync with MAX_IMAGE_BYTES) */
const MAX_BYTES = 700 * 1024;
/** Text width of a Letter page with 1in margins, in CSS px */
export const TEXT_WIDTH_PX = 624;

function bytesOf(dataUrl: string): number {
  const i = dataUrl.indexOf(",");
  return Math.floor(((dataUrl.length - i - 1) * 3) / 4);
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't an image SyncStream can read"));
    img.src = src;
  });
}

/**
 * Shrink an image so it uploads within the storage limit, keeping PNG and
 * GIF when they already fit. Returns a data URL and the size to show it at.
 */
export async function prepareImage(file: Blob): Promise<{ dataUrl: string; width: number; height: number }> {
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const naturalW = img.naturalWidth || 1;
  const naturalH = img.naturalHeight || 1;
  const display = (w: number, h: number) => {
    const width = Math.min(w, TEXT_WIDTH_PX);
    return { width: Math.round(width), height: Math.round((h * width) / w) };
  };

  const keepAsIs = /^data:image\/(png|jpeg|gif);/.test(original) && bytesOf(original) <= MAX_BYTES && naturalW <= 2000;
  if (keepAsIs) return { dataUrl: original, ...display(naturalW, naturalH) };

  let w = Math.min(naturalW, 1600);
  let h = Math.round((naturalH * w) / naturalW);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  for (let attempt = 0; attempt < 6; attempt++) {
    canvas.width = w;
    canvas.height = h;
    ctx.fillStyle = "#ffffff"; // JPEG has no transparency
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of [0.88, 0.78, 0.66]) {
      const out = canvas.toDataURL("image/jpeg", q);
      if (bytesOf(out) <= MAX_BYTES) return { dataUrl: out, ...display(naturalW, naturalH) };
    }
    w = Math.round(w * 0.75);
    h = Math.round(h * 0.75);
  }
  throw new Error("That image is too large, even after shrinking it");
}

/** Upload for use in a sync; Google fetches it from the returned URL. */
export async function uploadImage(file: Blob): Promise<{ url: string; width: number; height: number }> {
  const { dataUrl, width, height } = await prepareImage(file);
  const res = await fetch("/api/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.error || "Couldn't upload the image");
  return { url: data.url, width, height };
}

/** Size an image from the web to fit the page width */
export async function measureRemoteImage(url: string): Promise<{ width: number; height: number }> {
  try {
    const img = await loadImage(url);
    const width = Math.min(img.naturalWidth || TEXT_WIDTH_PX, TEXT_WIDTH_PX);
    return { width: Math.round(width), height: Math.round(((img.naturalHeight || width) * width) / (img.naturalWidth || width)) };
  } catch {
    return { width: TEXT_WIDTH_PX / 2, height: TEXT_WIDTH_PX / 3 };
  }
}
