// The "legacy" build works in browsers a version or two behind as well.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

// Shows a lead page in the review window. The PDF is fetched once per draft and kept while you review.

GlobalWorkerOptions.workerSrc = workerUrl;

// pdf.js's helper files, served by the app (see vite.config.ts).
const PDFJS = new URL('/pdfjs/', location.href).href;

const cache = new Map<string, PDFDocumentLoadingTask>();
const running = new WeakMap<HTMLCanvasElement, { cancel: () => void; promise: Promise<unknown> }>();

export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  let task = cache.get(url);
  if (!task) {
    task = getDocument({
      url,
      withCredentials: true,
      // Decoders for scanned pages (JPEG 2000, JBIG2) and the fonts and color profiles some PDFs lean on.
      // Without them those pages are drawn blank white, though the PDF opens fine elsewhere.
      wasmUrl: PDFJS + 'wasm/',
      iccUrl: PDFJS + 'iccs/',
      standardFontDataUrl: PDFJS + 'standard_fonts/',
      cMapUrl: PDFJS + 'cmaps/',
    });
    task.promise.catch(() => cache.delete(url));
    cache.set(url, task);
    // Keep only the latest couple of files in memory.
    while (cache.size > 2) {
      const [k, old] = cache.entries().next().value!;
      cache.delete(k);
      void old.destroy().catch(() => {});
    }
  }
  return task.promise;
}

/** Draws one page into the canvas, fitted to `width` CSS pixels, turned by `rotate` degrees (scans can be sideways). */
export async function renderPage(canvas: HTMLCanvasElement, url: string, pageNo: number, width: number, rotate = 0, zoom = 1) {
  // A newer request for the same canvas replaces the one still drawing.
  const prev = running.get(canvas);
  if (prev) {
    prev.cancel();
    await prev.promise.catch(() => {});
  }
  const doc = await loadPdf(url);
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotate) % 360 });
  const scale = (width / base.width) * zoom;
  const ratio = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: scale * ratio, rotation: (page.rotate + rotate) % 360 });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${Math.floor(vp.width / ratio)}px`;
  canvas.style.height = `${Math.floor(vp.height / ratio)}px`;
  const task = page.render({ canvas, viewport: vp });
  running.set(canvas, task);
  try {
    await task.promise;
  } catch (e: any) {
    if (e?.name !== 'RenderingCancelledException') throw e;
  } finally {
    if (running.get(canvas) === task) running.delete(canvas);
  }
}
