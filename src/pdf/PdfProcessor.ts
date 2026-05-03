import { requestUrl } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { LectureMaterialContext, LectureMaterialPage, VisionImageRef } from "../types";

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
      const pageCount = pdf.numPages;
      const seedTerms = this.extractTerms(seedText);
      const pages: LectureMaterialPage[] = [];
      let extractedCharCount = 0;

      for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const rawText = textContent.items
          .map((item: unknown) => {
            const textItem = item as { str?: string };
            return textItem.str || "";
          })
          .join(" ");
        const text = this.normalizePageText(rawText);

        if (text.length > 0) {
          extractedCharCount += text.length;
          pages.push({
            pageNum,
            text,
            score: this.scorePage(text, seedTerms, pageNum),
          });
        }

        onProgress?.(pageNum, pageCount);

        if (pageNum % 10 === 0 && pageNum < pageCount) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }

      await pdf.destroy();

      if (pages.length === 0) return null;

      return this.buildCompactContext(pages, pageCount, extractedCharCount);
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
   * Render the requested PDF pages to base64 PNG images, scaled to fit
   * `maxWidth` while preserving aspect ratio (capped at scale=2 to avoid
   * gigantic outputs on already-large slides). Failures on individual pages
   * are isolated (logged + skipped); the surrounding catch handles a full
   * setup failure (returns []).
   *
   * Reused by `PerSlideCommentaryGenerator` for per-slide multimodal LLM
   * input and by the spike-validated hash function (which hashes the same
   * PNG bytes that go to the LLM, ensuring hash and vision input match).
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

  private buildCompactContext(
    pages: LectureMaterialPage[],
    pageCount: number,
    extractedCharCount: number
  ): LectureMaterialContext {
    const maxPages = 14;
    const maxChars = 12000;
    const firstPages = pages.filter((page) => page.pageNum <= 3);
    const scoredPages = [...pages]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPages);
    const selectedMap = new Map<number, LectureMaterialPage>();

    for (const page of [...firstPages, ...scoredPages]) {
      selectedMap.set(page.pageNum, page);
    }

    const selectedPages = Array.from(selectedMap.values())
      .sort((a, b) => a.pageNum - b.pageNum)
      .slice(0, maxPages);
    const lines: string[] = [];
    let usedChars = 0;

    for (const page of selectedPages) {
      const remaining = maxChars - usedChars;
      if (remaining <= 0) break;

      const pageText = this.truncateAtSentence(page.text, Math.min(900, remaining));
      if (!pageText) continue;

      const line = `[p.${page.pageNum}] ${pageText}`;
      lines.push(line);
      usedChars += line.length;
    }

    return {
      pageCount,
      pages: selectedPages,
      text: lines.join("\n"),
      extractedCharCount,
      truncated: extractedCharCount > usedChars,
    };
  }

  private normalizePageText(text: string): string {
    return text
      .replace(/\s+/g, " ")
      .replace(/([a-z])-\s+([a-z])/gi, "$1$2")
      .trim();
  }

  private scorePage(text: string, terms: string[], pageNum: number): number {
    const lower = text.toLowerCase();
    let score = Math.min(text.length / 80, 20);

    for (const term of terms) {
      if (lower.includes(term)) score += 4;
    }

    if (/definition|theorem|algorithm|formula|example|정의|정리|알고리즘|공식|예시/.test(lower)) {
      score += 8;
    }

    if (pageNum <= 3) score += 5;
    return score;
  }

  private extractTerms(seedText: string): string[] {
    const terms = new Set<string>();
    const matches = seedText.match(/[A-Za-z][A-Za-z0-9-]{3,}|[가-힣]{3,}/g) || [];

    for (const match of matches) {
      const term = match.toLowerCase();
      if (term.length >= 4) terms.add(term);
      if (terms.size >= 40) break;
    }

    return Array.from(terms);
  }

  private truncateAtSentence(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const sliced = text.slice(0, maxChars);
    const sentenceEnd = Math.max(
      sliced.lastIndexOf(". "),
      sliced.lastIndexOf("? "),
      sliced.lastIndexOf("! "),
      sliced.lastIndexOf("다. ")
    );
    if (sentenceEnd > maxChars * 0.6) {
      return sliced.slice(0, sentenceEnd + 1).trim();
    }
    return sliced.trim();
  }
}
