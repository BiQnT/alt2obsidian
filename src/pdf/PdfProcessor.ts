import { requestUrl } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPageTexts } from "../core/slideHash";
import { extractLectureMaterialContext } from "../core/lectureMaterial";
import type { LectureMaterialContext, VisionImageRef } from "../types";

export class PdfProcessor {
  /**
   * Worker URL must be resolved through Obsidian's resource-path machinery
   * (e.g., `app://local/...`). Raw filesystem paths get incorrectly prepended
   * to the `app://obsidian.md/` baseURI by pdfjs and fail to load. Caller
   * (main.ts) is responsible for the conversion via
   * `app.vault.adapter.getResourcePath(...)`.
   */
  constructor(workerSrc: string) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
  }

  async downloadPdf(pdfUrl: string): Promise<ArrayBuffer> {
    try {
      const response = await requestUrl({
        url: pdfUrl,
        method: "GET",
      });
      return response.arrayBuffer;
    } catch (e) {
      throw new Error(
        "PDF 다운로드에 실패했습니다. 서명된 URL이 만료되었을 수 있습니다."
      );
    }
  }

  async extractLectureMaterialContext(
    pdfData: ArrayBuffer,
    seedText: string,
    onProgress?: (page: number, total: number) => void
  ): Promise<LectureMaterialContext | null> {
    try {
      const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise;
      try {
        return await extractLectureMaterialContext(pdf, seedText, onProgress);
      } finally {
        await pdf.destroy();
      }
    } catch (e) {
      console.warn("[Alt2Obsidian] PDF text extraction failed:", e);
      return null;
    }
  }

  /**
   * Open the PDF and return its page count. Returns 0 on failure (logs warning).
   * Used by `PerSlideCommentaryGenerator` to bound the slide loop.
   */
  async getPageCount(pdfData: ArrayBuffer): Promise<number> {
    try {
      const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise;
      const count = pdf.numPages;
      await pdf.destroy();
      return count;
    } catch (e) {
      console.warn("[Alt2Obsidian] getPageCount failed:", e);
      return 0;
    }
  }

  /**
   * Text layer of every page (index 0 = page 1, null = unreadable page),
   * used for the slide hash. Throws only if the PDF itself cannot be opened.
   */
  async getPageTexts(pdfData: ArrayBuffer): Promise<Array<string | null>> {
    const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise;
    try {
      return await extractPageTexts(pdf);
    } finally {
      await pdf.destroy();
    }
  }

  /**
   * Render the requested PDF pages to base64 PNG images, scaled to fit
   * `maxWidth` while preserving aspect ratio (capped at scale=2 to avoid
   * gigantic outputs on already-large slides). Failures on individual pages
   * are isolated (logged + skipped); the surrounding catch handles a full
   * setup failure (returns []).
   *
   * Reused by `PerSlideCommentaryGenerator` for per-slide multimodal LLM
   * input.
   */
  async renderPagesToImages(
    pdfData: ArrayBuffer,
    pageNums: number[],
    maxWidth = 1024
  ): Promise<VisionImageRef[]> {
    if (!pageNums.length) return [];
    try {
      const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise;
      const results: VisionImageRef[] = [];

      for (const pageNum of pageNums) {
        if (pageNum < 1 || pageNum > pdf.numPages) continue;
        try {
          const page = await pdf.getPage(pageNum);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(maxWidth / baseViewport.width, 2);
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;

          await page.render({ canvasContext: ctx, viewport }).promise;
          const dataUrl = canvas.toDataURL("image/png");
          const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
          results.push({ pageNum, base64Png: base64 });
          canvas.width = 0;
          canvas.height = 0;
        } catch (pageErr) {
          console.warn(
            `[Alt2Obsidian] PDF page ${pageNum} render failed:`,
            pageErr
          );
        }
      }

      await pdf.destroy();
      return results;
    } catch (e) {
      console.warn("[Alt2Obsidian] PDF page render setup failed:", e);
      return [];
    }
  }
}
