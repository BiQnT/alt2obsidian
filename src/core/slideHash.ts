// Slide hash shared by the plugin and the alt2obs Skill CLI (spec 4.7).
//
//   text page:     hash = sha1(normalizePageText(text)).slice(0, 8)
//   textless page: hash = sha1(sourceId + ":" + page).slice(0, 8)
//
// Text pages hash their content only, never their position, so inserting or
// deleting a slide leaves every other slide's hash unchanged and the merge in
// VaultManager keeps memos attached to the right slide. Pages with identical
// text (animation builds) share a hash; the merge pairs them in deck order.
// Textless pages (image-only, or text extraction failed) have no content
// signal and fall back to a positional hash.
//
// `text` is the page's pdfjs text layer (see `extractPageTexts`), so the hash
// does not depend on how a page is rendered. `sourceId` is the Alt note id.
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

/**
 * 8-hex slide hash for 1-based `page`. `pageText` null means the text layer
 * could not be read; it is hashed like an image-only page.
 */
export async function computeSlideHash(
  pageText: string | null,
  page: number,
  sourceId: string
): Promise<string> {
  const normalized = pageText === null ? "" : normalizePageText(pageText);
  const key = normalized.length > 0 ? normalized : `${sourceId}:${page}`;
  return (await sha1Hex(key)).slice(0, 8);
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
 * order with "" (whitespace is dropped by `normalizePageText` anyway). A page
 * whose text cannot be read yields null (with a warning) instead of failing
 * the whole document. Shared by `PdfProcessor.getPageTexts` and the Skill CLI
 * so both hash the exact same text.
 */
export async function extractPageTexts(pdf: PdfTextSource): Promise<Array<string | null>> {
  const texts: Array<string | null> = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      texts.push(
        content.items.map((item) => (item as { str?: string }).str ?? "").join("")
      );
    } catch (e) {
      console.warn(`[Alt2Obs] text extraction failed for page ${pageNum}:`, e);
      texts.push(null);
    }
  }
  return texts;
}
