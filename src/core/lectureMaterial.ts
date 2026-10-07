// Compact lecture-material excerpt of a PDF (the "[PDF 강의자료 발췌]" input
// of prompts/summary-enhance-material.md and summary-from-material.md).
// Shared by PdfProcessor and the Skill CLI (scripts/src/lecture-material.ts)
// so both feed the same excerpt to the prompt. No obsidian import.

import type { LectureMaterialContext, LectureMaterialPage } from "../types";
import type { PdfTextSource } from "./slideHash";

/**
 * Scores every page against `seedText` (lecture title + Alt summary) and
 * keeps the first pages plus the best-scoring ones within a size budget.
 * Returns null when the PDF has no text layer at all.
 */
export async function extractLectureMaterialContext(
  pdf: PdfTextSource,
  seedText: string,
  onProgress?: (page: number, total: number) => void
): Promise<LectureMaterialContext | null> {
  const pageCount = pdf.numPages;
  const seedTerms = extractTerms(seedText);
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
    const text = collapseWhitespace(rawText);

    if (text.length > 0) {
      extractedCharCount += text.length;
      pages.push({
        pageNum,
        text,
        score: scorePage(text, seedTerms, pageNum),
      });
    }

    onProgress?.(pageNum, pageCount);

    // Lets Obsidian draw the progress; under plain Node (the Skill's CLI)
    // there is no window and nothing to draw.
    if (pageNum % 10 === 0 && pageNum < pageCount && typeof window !== "undefined") {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  if (pages.length === 0) return null;

  return buildCompactContext(pages, pageCount, extractedCharCount);
}

function buildCompactContext(
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

    const pageText = truncateAtSentence(page.text, Math.min(900, remaining));
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

function collapseWhitespace(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([a-z])-\s+([a-z])/gi, "$1$2")
    .trim();
}

function scorePage(text: string, terms: string[], pageNum: number): number {
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

function extractTerms(seedText: string): string[] {
  const terms = new Set<string>();
  const matches = seedText.match(/[A-Za-z][A-Za-z0-9-]{3,}|[가-힣]{3,}/g) || [];

  for (const match of matches) {
    const term = match.toLowerCase();
    if (term.length >= 4) terms.add(term);
    if (terms.size >= 40) break;
  }

  return Array.from(terms);
}

function truncateAtSentence(text: string, maxChars: number): string {
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
