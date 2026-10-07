// Browser entry for test/dom-pdf-worker.mjs: PdfProcessor with the PDF.js
// worker bundled into main.js (a Blob URL from src/pdf/pdfWorker.ts), set
// up the way the plugin does it. Results go to <pre id="out"> as JSON.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { PdfProcessor } from "../../src/pdf/PdfProcessor";
import { createPdfWorkerUrl } from "../../src/pdf/pdfWorker";
import type { GrayImage } from "../../src/core/prep/SlideAnalyzer";

/** Share of pixels darker than mid gray. */
function darkShare(img: GrayImage | null): number {
  if (!img) return -1;
  let dark = 0;
  for (let i = 0; i < img.data.length; i++) if (img.data[i] < 128) dark++;
  return dark / img.data.length;
}

/** Share of non-white pixels of a base64 JPEG or PNG. */
async function inkShare(base64: string, mime: string): Promise<number> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) ink++;
  return ink / (px.length / 4);
}

async function main() {
  const url = createPdfWorkerUrl();
  const processor = new PdfProcessor(url);
  const data = await (await fetch("./deck.pdf")).arrayBuffer();

  // The document runs in a real module worker started from the Blob URL,
  // not in PDF.js's main-thread fallback ("fake worker").
  const task = pdfjsLib.getDocument({ data: data.slice(0) });
  const doc = await task.promise;
  const worker = (task as any)._worker;
  const realWorker = !!worker?._webWorker && worker._webWorker instanceof Worker;
  await doc.destroy();

  // Several documents at once (the viewer and an import), each with its own worker.
  const [texts, count, layouts] = await Promise.all([processor.getPageTexts(data), processor.getPageCount(data), processor.getPageLayouts(data)]);
  const prep = await processor.analyzeForPrep(data);
  const jpeg = await processor.renderPageJpeg(data, 1, 600);
  const pngs = await processor.renderPagesToImages(data, [1, 4], 400);
  const material = await processor.extractLectureMaterialContext(data, "Cache coherence MESI");

  // Plugin unload revokes the URL: no new document can start a worker from it
  // (PDF.js then tries its main-thread fallback, which cannot load it either).
  console.log("revoke step");
  URL.revokeObjectURL(url);
  let afterRevoke = "opened";
  try {
    const late = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
    await late.destroy();
  } catch (e) {
    afterRevoke = "failed: " + (e instanceof Error ? e.message : String(e));
  }

  return {
    workerSrcIsBlob: url.startsWith("blob:"),
    realWorker,
    texts,
    count,
    layoutLines: layouts.map((l) => l.text),
    grayDark: prep.grays.map(darkShare),
    jpeg: jpeg ? { mime: jpeg.mimeType, ink: await inkShare(jpeg.base64, jpeg.mimeType) } : null,
    pngs: await Promise.all(pngs.map(async (p) => ({ page: p.pageNum, ink: await inkShare(p.base64Png, "image/png") }))),
    materialPages: material?.pageCount ?? null,
    afterRevoke,
  };
}

main().then(
  (r) => (document.getElementById("out")!.textContent = JSON.stringify(r)),
  (e) => (document.getElementById("out")!.textContent = "ERROR " + ((e && e.stack) || e))
);
