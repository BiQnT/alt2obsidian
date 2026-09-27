// Slide hash shared by the plugin and the alt2obs Skill CLI (spec 4.7).
//
//   hash = sha1(normalizePageText(text) + ":" + page).slice(0, 8)
//   hash = sha1(sourceId + ":" + page).slice(0, 8)   when the normalized text is empty
//
// `text` is the page's pdfjs text layer (see `extractPageTexts`), so the hash
// no longer depends on how a page is rendered. `sourceId` is the Alt note id.
// Pure module: no obsidian import, Web Crypto only (Electron and Node 18+,
// where Node 18 callers must provide `globalThis.crypto`).

/** NFC normalize, lowercase, and remove all whitespace. */
export function normalizePageText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 8-hex slide hash for 1-based `page`. */
export async function computeSlideHash(
  pageText: string,
  page: number,
  sourceId: string
): Promise<string> {
  const normalized = normalizePageText(pageText);
  const key = normalized.length > 0 ? normalized : sourceId;
  return (await sha1Hex(`${key}:${page}`)).slice(0, 8);
}

/** Minimal shape of a pdfjs `PDFDocumentProxy` needed for text extraction. */
export interface PdfTextSource {
  numPages: number;
  getPage(pageNum: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
}

/**
 * Per-page text layer, index 0 = page 1. Items' `str` values are joined in
 * order with "" (whitespace is dropped by `normalizePageText` anyway).
 * Shared by `PdfProcessor.getPageTexts` and the Skill CLI so both hash the
 * exact same text.
 */
export async function extractPageTexts(pdf: PdfTextSource): Promise<string[]> {
  const texts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    texts.push(
      content.items.map((item) => (item as { str?: string }).str ?? "").join("")
    );
  }
  return texts;
}
