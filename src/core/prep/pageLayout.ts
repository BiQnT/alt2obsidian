// Page text and text item boxes from a pdfjs document, for SlideAnalyzer.
// The text is joined exactly like `extractPageTexts` (src/core/slideHash.ts),
// so the slide hash computed from it is the same one.

import type { GrayImage, PageLayout, TextBox } from "./SlideAnalyzer";

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

/** Minimal shape of a pdfjs `PDFDocumentProxy` used here. */
export interface PdfLayoutSource {
  numPages: number;
  getPage(pageNum: number): Promise<{
    view?: number[];
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
}

function itemBox(item: PdfTextItem, view: number[]): TextBox | null {
  const t = item.transform;
  if (!t || !item.str || !item.str.trim()) return null;
  const [x0, y0, x1, y1] = view;
  const pw = x1 - x0;
  const ph = y1 - y0;
  if (pw <= 0 || ph <= 0) return null;
  const h = Math.abs(item.height || t[3] || 0);
  const w = Math.abs(item.width || 0);
  const left = (t[4] - x0) / pw;
  const top = 1 - (t[5] + h - y0) / ph;
  return { x: left, y: top, w: w / pw, h: h / ph };
}

export async function extractPageLayouts(pdf: PdfLayoutSource): Promise<PageLayout[]> {
  const out: PageLayout[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const items = content.items as PdfTextItem[];
      const view = page.view ?? [0, 0, 1, 1];
      const lines: string[] = [];
      let line = "";
      for (const item of items) {
        line += item.str ?? "";
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      out.push({
        text: items.map((item) => item.str ?? "").join(""),
        boxes: items.map((item) => itemBox(item, view)).filter((b): b is TextBox => b !== null),
        lines,
      });
    } catch (e) {
      console.warn(`[Alt2Obsidian] layout extraction failed for page ${pageNum}:`, e);
      out.push({ text: null, boxes: [], lines: [] });
    }
  }
  return out;
}

/** Binary PGM (P5, maxval <= 255), as written by `pdftoppm -gray`. */
export function parsePgm(bytes: Uint8Array): GrayImage {
  let pos = 0;
  const token = (): string => {
    for (;;) {
      while (pos < bytes.length && /\s/.test(String.fromCharCode(bytes[pos]))) pos++;
      if (bytes[pos] === 0x23) {
        while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
        continue;
      }
      break;
    }
    let s = "";
    while (pos < bytes.length && !/\s/.test(String.fromCharCode(bytes[pos]))) s += String.fromCharCode(bytes[pos++]);
    return s;
  };
  if (token() !== "P5") throw new Error("not a binary PGM (P5) image");
  const width = parseInt(token(), 10);
  const height = parseInt(token(), 10);
  const maxval = parseInt(token(), 10);
  if (!(width > 0 && height > 0) || !(maxval > 0 && maxval < 256)) throw new Error("unsupported PGM header");
  pos++; // single whitespace after maxval
  const data = bytes.subarray(pos, pos + width * height);
  if (data.length < width * height) throw new Error("truncated PGM data");
  if (maxval === 255) return { width, height, data };
  const scaled = new Uint8Array(width * height);
  for (let i = 0; i < scaled.length; i++) scaled[i] = Math.round((data[i] * 255) / maxval);
  return { width, height, data: scaled };
}

/** RGBA canvas pixels to 8-bit luminance. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3] / 255;
    // Transparent pixels render over white.
    data[i] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a));
  }
  return { width, height, data };
}

/** Long edge of the analysis render (plugin canvas and pdftoppm `-scale-to`). */
export const ANALYSIS_LONG_EDGE = 160;

/** Page text with line breaks between lines, the aligner's input (spec 4.3). */
export function layoutAlignmentText(layout: PageLayout): string {
  return layout.lines && layout.lines.length > 0 ? layout.lines.join("\n") : layout.text ?? "";
}
