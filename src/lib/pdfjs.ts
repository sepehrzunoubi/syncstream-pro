/**
 * pdf.js on the server. In Node it runs its worker in this thread, and would load it from a path
 * worked out at run time (./pdf.worker.mjs beside pdf.mjs): a file the build's tracing doesn't
 * know to ship, so a deployment without it fails every PDF with "Setting up fake worker failed".
 * Importing the worker by name ships it, and handing it to pdf.js (globalThis.pdfjsWorker) means
 * that path is never used.
 */
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loading: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    // @ts-expect-error: the worker build ships without type declarations
    const worker: unknown = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const g = globalThis as { pdfjsWorker?: unknown };
    g.pdfjsWorker ??= worker;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })().catch((err: unknown) => {
    // A failed load is tried again by the next PDF, not remembered
    loading = null;
    throw err;
  });
  return loading;
}
