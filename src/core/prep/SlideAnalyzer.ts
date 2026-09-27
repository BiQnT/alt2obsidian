// Deterministic slide analysis (spec 5.1). No LLM, no obsidian import: the
// plugin, the Skill CLI (scripts/phase2/prep.mjs) and the benchmark all run
// this same code.
//
// Per page:
//   textChars   length of the normalized text layer (slideHash rules)
//   imageRatio  share of the rendered page covered by non-text ink, from a
//               small grayscale render and the text item boxes (null when no
//               render is available)
//   kind        cover / toc / thanks / content / visual
//   dupOf       for a run of animation build steps (each page's text is
//               contained in the next and similarity >= 0.9, no number
//               changed), every page but the last points at the last one,
//               which alone is generated
//   sendImage   whether the generator attaches the page image (spec 5.2)
//   imageSignal 16x16 average hash plus an 8x8 luminance grid of the render
//               (128 hex), the cheap image check that makes "skip unchanged
//               slide" safe (spec 5.4)

import { computeSlideHash, normalizePageText } from "../slideHash";

export type SlideKind = "cover" | "toc" | "thanks" | "content" | "visual";

/** 8-bit grayscale raster, row-major, one byte per pixel. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Text item box, normalized to the page (0..1), origin top-left. */
export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageLayout {
  /** pdfjs text layer joined like `extractPageTexts`; null = unreadable. */
  text: string | null;
  boxes: TextBox[];
  /** Text lines (pdfjs end-of-line marks). Absent: `text` is one line. */
  lines?: string[];
}

export interface SlideInfo {
  page: number;
  hash: string;
  textChars: number;
  imageRatio: number | null;
  kind: SlideKind;
  /** Page whose commentary covers this one (near-duplicate run), else null. */
  dupOf: number | null;
  sendImage: boolean;
  /** First line-ish of the slide text, for the lecture context list. */
  title: string;
  imageSignal: string | null;
}

export interface AnalyzeOptions {
  sourceId: string;
  /** "text-only" never attaches images except for a PDF without a text layer. */
  imageRule?: "auto" | "text-only";
}

export const DUPLICATE_SIMILARITY = 0.9;
/** Share of textless pages above which the PDF counts as a scan. */
const SCANNED_SHARE = 0.8;
const VISUAL_RATIO = 0.3;
const LOW_TEXT_CHARS = 30;
const LOW_TEXT_VISUAL_RATIO = 0.08;

/** A whole first line that names a table of contents. */
const TOC_LINE = /^(table of contents|contents|목차|차례|outline|agenda)\s*:?$/i;
/** A whole line that only says thanks / Q&A / the end. "질문: 왜 ...?" does not match. */
const THANKS_LINE = /^(thank you( very much)?|thanks|감사합니다|수고하셨습니다|q\s*&\s*a|questions?|any questions|질문 있나요|the end|끝)\s*[!.?]*$/i;
/** Cover: lecture or course title in the first lines ... */
const COVER_TITLE = /\b(lecture|lec\.?|chapter|week|unit|session)\s*\d+|\b[A-Z]{2,6}\s?-?\d{3,4}[A-Z]?\b|제\s*\d+\s*강|\d+\s*강\b|\d+\s*주차|강의/i;
/** ... and an author or affiliation line. */
const COVER_AFFILIATION = /universit|department|dept\.|school of|college|institute|laborator|\blab\b|professor|prof\.|@[\w.-]+\.[a-z]{2,}|대학|학과|학부|연구실|교수/i;
const COVER_MAX_CHARS = 1200;

// ---- text helpers ----

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient of character bigrams on normalized text (0..1). */
export function textSimilarity(a: string, b: string): number {
  const na = normalizePageText(a);
  const nb = normalizePageText(b);
  if (na === nb) return na.length > 0 ? 1 : 0;
  if (na.length < 2 || nb.length < 2) return 0;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let common = 0;
  for (const [g, c] of ga) common += Math.min(c, gb.get(g) ?? 0);
  return (2 * common) / (na.length - 1 + nb.length - 1);
}

/** Short title for the lecture-wide slide list: the start of the text layer. */
export function slideTitle(text: string | null): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > 40 ? `${t.slice(0, 40)}...` : t;
}

// ---- image helpers ----

/** Most common luminance (in 8-level buckets), taken as the background. */
function backgroundLevel(gray: GrayImage): number {
  const hist = new Array(32).fill(0);
  for (let i = 0; i < gray.data.length; i++) hist[gray.data[i] >> 3]++;
  let best = 0;
  for (let b = 1; b < 32; b++) if (hist[b] > hist[best]) best = b;
  return best * 8 + 4;
}

/**
 * Share of 16x16 grid cells that carry ink (pixels far from the background
 * level) and are not covered by a text box. Bullet text slides score low,
 * diagrams, plots and photos score high.
 */
export function computeImageRatio(gray: GrayImage, boxes: TextBox[], grid = 16): number {
  if (gray.width === 0 || gray.height === 0) return 0;
  const bg = backgroundLevel(gray);
  let graphic = 0;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * gray.width) / grid);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * gray.width) / grid));
      const y0 = Math.floor((gy * gray.height) / grid);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * gray.height) / grid));
      let ink = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (Math.abs(gray.data[y * gray.width + x] - bg) > 40) ink++;
        }
      }
      if (ink / ((x1 - x0) * (y1 - y0)) < 0.03) continue;
      const cx0 = gx / grid;
      const cy0 = gy / grid;
      const cell = 1 / grid;
      let covered = 0;
      for (const b of boxes) {
        const ox = Math.max(0, Math.min(cx0 + cell, b.x + b.w) - Math.max(cx0, b.x));
        const oy = Math.max(0, Math.min(cy0 + cell, b.y + b.h) - Math.max(cy0, b.y));
        covered += ox * oy;
      }
      if (covered / (cell * cell) < 0.3) graphic++;
    }
  }
  return Math.round((graphic / (grid * grid)) * 1000) / 1000;
}

/** 16x16 average hash (64 hex chars) of the render, by area-averaged downsampling. */
export function averageHash(gray: GrayImage, size = 16): string {
  const cells: number[] = [];
  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) {
      const x0 = Math.floor((gx * gray.width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * gray.width) / size));
      const y0 = Math.floor((gy * gray.height) / size);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * gray.height) / size));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < gray.height; y++) {
        for (let x = x0; x < x1 && x < gray.width; x++) {
          sum += gray.data[y * gray.width + x];
          n++;
        }
      }
      cells.push(n > 0 ? sum / n : 0);
    }
  }
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  let hex = "";
  for (let i = 0; i < cells.length; i += 4) {
    let nibble = 0;
    for (let k = 0; k < 4; k++) nibble = (nibble << 1) | (cells[i + k] > mean ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

/** 8x8 grid of mean luminance quantized to 16 levels (64 hex): catches edits the average hash misses. */
export function luminanceGrid(gray: GrayImage, size = 8): string {
  let hex = "";
  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) {
      const x0 = Math.floor((gx * gray.width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * gray.width) / size));
      const y0 = Math.floor((gy * gray.height) / size);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * gray.height) / size));
      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < y1 && y < gray.height; y++) {
        for (let x = x0; x < x1 && x < gray.width; x++) {
          sum += gray.data[y * gray.width + x];
          cnt++;
        }
      }
      hex += Math.min(15, Math.floor((cnt > 0 ? sum / cnt : 0) / 16)).toString(16);
    }
  }
  return hex;
}

/** Image signal: average hash (64 hex) followed by the luminance grid (64 hex). */
export function imageSignal(gray: GrayImage): string {
  return averageHash(gray) + luminanceGrid(gray);
}

/** Bits that differ between two hex strings of equal length; Infinity when not comparable. */
export function signalDistance(a: string | null, b: string | null): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * Same render: at most 2 of the 256 average-hash bits differ, and at most
 * 2 grid cells differ, by one luminance level only (anti-aliasing noise).
 */
export function sameImageSignal(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== 128 || b.length !== 128) return false;
  if (signalDistance(a.slice(0, 64), b.slice(0, 64)) > 2) return false;
  let cells = 0;
  for (let i = 64; i < 128; i++) {
    const d = Math.abs(parseInt(a[i], 16) - parseInt(b[i], 16));
    if (d > 1) return false;
    if (d === 1) cells++;
  }
  return cells <= 2;
}

// ---- classification ----

/** Lines without page numbers and blanks. */
function contentLines(text: string | null, lines?: string[]): string[] {
  return (lines ?? [text ?? ""]).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 0 && !/^\d{1,3}$/.test(l));
}

/**
 * Page 1 is a cover when its text is short, or (conservatively) when it has
 * a lecture/course title in its first three lines, an author or affiliation
 * line, no bullet list, and stays under 1200 characters: covers often carry
 * a long disclaimer.
 */
export function looksLikeCover(text: string | null, lines?: string[]): boolean {
  const chars = normalizePageText(text ?? "").length;
  if (chars <= 150) return true;
  if (chars > COVER_MAX_CHARS) return false;
  const ls = contentLines(text, lines);
  if (ls.some((l) => /^[•◼▪■●◦\-*]\s/.test(l))) return false;
  return ls.slice(0, 3).some((l) => COVER_TITLE.test(l)) && ls.some((l) => COVER_AFFILIATION.test(l));
}

export function classifySlide(
  index: number,
  pageCount: number,
  text: string | null,
  imageRatio: number | null,
  lines?: string[]
): SlideKind {
  const norm = normalizePageText(text ?? "");
  const chars = norm.length;
  const ls = contentLines(text, lines);
  if (index === 0 && looksLikeCover(text, lines)) return "cover";
  // Thanks / Q&A: one of the last two pages whose first line says only that,
  // with at most a short name or e-mail line besides.
  if (index >= pageCount - 2 && chars > 0 && chars <= 120 && ls.length > 0 && THANKS_LINE.test(ls[0])) {
    const rest = ls.slice(1).join(" ");
    if (rest.length <= 40 && !/^[•◼▪■●◦\-*]/m.test(ls.slice(1).join("\n"))) return "thanks";
  }
  // Table of contents: within the first 15% of the deck (at least 3 pages), first line is the keyword.
  const tocWindow = Math.max(3, Math.ceil(pageCount * 0.15));
  if (index < tocWindow && chars > 0 && chars <= 500 && ls.length > 0 && TOC_LINE.test(ls[0])) return "toc";
  if (imageRatio === null) return chars < LOW_TEXT_CHARS ? "visual" : "content";
  if (chars < LOW_TEXT_CHARS && imageRatio >= LOW_TEXT_VISUAL_RATIO) return "visual";
  if (imageRatio >= VISUAL_RATIO) return "visual";
  if (chars === 0) return "visual";
  return "content";
}

/** Word, number and symbol tokens; letters and digits split apart ("Case1" = case, 1). */
function tokens(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?|[\uac00-\ud7a3]+|[^\s\w]/g) ?? [];
}

/**
 * Page `b` is an animation build step of page `a`: similar text, every
 * number of `a` still in `b`, and `a`'s other tokens contained in `b` (up to
 * 3% missing for text-extraction noise). "Case 1" vs "Case 2" or a changed
 * number is not a build step.
 */
export function isBuildStep(a: string, b: string): boolean {
  if (textSimilarity(a, b) < DUPLICATE_SIMILARITY) return false;
  const ta = tokens(a);
  const pool = new Map<string, number>();
  for (const t of tokens(b)) pool.set(t, (pool.get(t) ?? 0) + 1);
  if (tokens(b).length < ta.length) return false;
  let missingWords = 0;
  for (const t of ta) {
    const n = pool.get(t) ?? 0;
    if (n > 0) {
      pool.set(t, n - 1);
      continue;
    }
    if (/^\d/.test(t)) return false;
    missingWords++;
  }
  return missingWords <= Math.floor(ta.length * 0.03);
}

/**
 * Analyze every page. `grays[i]` is a small grayscale render of page i+1
 * (null when rendering is not available, e.g. the Skill CLI without
 * pdftoppm): image ratio and image signal are then null.
 */
export async function analyzeSlides(
  layouts: PageLayout[],
  grays: Array<GrayImage | null>,
  opts: AnalyzeOptions
): Promise<{ slides: SlideInfo[]; scanned: boolean }> {
  const n = layouts.length;
  const textless = layouts.filter((l) => normalizePageText(l.text ?? "").length === 0).length;
  const scanned = n > 0 && textless / n >= SCANNED_SHARE;
  const slides: SlideInfo[] = [];
  for (let i = 0; i < n; i++) {
    const layout = layouts[i];
    const gray = grays[i] ?? null;
    const imageRatio = gray ? computeImageRatio(gray, layout.boxes) : null;
    const kind: SlideKind = scanned ? "content" : classifySlide(i, n, layout.text, imageRatio, layout.lines);
    slides.push({
      page: i + 1,
      hash: await computeSlideHash(layout.text, i + 1, opts.sourceId),
      textChars: normalizePageText(layout.text ?? "").length,
      imageRatio,
      kind,
      dupOf: null,
      sendImage: scanned || (kind === "visual" && opts.imageRule !== "text-only"),
      title: slideTitle(layout.text),
      imageSignal: gray ? imageSignal(gray) : null,
    });
  }
  // Animation build runs of generated kinds: keep the last page of each run.
  // A visual page also needs the same image (its picture may be what changed).
  const generated = (s: SlideInfo) => s.kind === "content" || s.kind === "visual";
  for (let i = n - 2; i >= 0; i--) {
    const a = slides[i];
    const b = slides[i + 1];
    if (!generated(a) || !generated(b) || a.textChars < 20 || b.textChars < 20) continue;
    if ((a.kind === "visual" || b.kind === "visual") && !sameImageSignal(a.imageSignal, b.imageSignal)) continue;
    if (isBuildStep(layouts[i].text ?? "", layouts[i + 1].text ?? "")) {
      a.dupOf = b.dupOf ?? b.page;
    }
  }
  return { slides, scanned };
}

// ---- key diagrams (spec 4.8, ported from the retired lecture-note skill) ----

/** At most this many diagram images per lecture (lecture-note used 5 to 10). */
export const MAX_KEY_DIAGRAMS = 8;

/**
 * Pages worth saving as an image in the note: diagrams, circuits, plots,
 * state machines and trees, picked by the render alone (no tokens). A page
 * qualifies when it is a generated "visual" page whose non-text ink covers
 * at least 30% of the render; template pages (cover, contents, closing),
 * animation build steps that are not the last step, and scanned PDFs
 * (every page is an image) are skipped, as are text-only and decorative
 * pages below the ink threshold. The most graphic pages win, returned in
 * deck order.
 */
export function selectKeyDiagrams(slides: SlideInfo[], scanned: boolean, max = MAX_KEY_DIAGRAMS): number[] {
  if (scanned) return [];
  return slides
    .filter((s) => s.kind === "visual" && s.dupOf === null && s.imageRatio !== null && s.imageRatio >= VISUAL_RATIO)
    .sort((a, b) => (b.imageRatio ?? 0) - (a.imageRatio ?? 0) || a.page - b.page)
    .slice(0, max)
    .map((s) => s.page)
    .sort((a, b) => a - b);
}

// ---- template lines for slides that get no LLM call ----

export function templateCommentary(slide: SlideInfo, deckTitle: string): string | null {
  if (slide.dupOf !== null) {
    return `다음 슬라이드와 같은 내용입니다. 해설은 [[#📚 슬라이드 ${slide.dupOf}|슬라이드 ${slide.dupOf}]]을 보세요.`;
  }
  switch (slide.kind) {
    case "cover":
      return `표지 슬라이드: **${slide.title || deckTitle}**`;
    case "toc":
      return "목차 슬라이드입니다. 이번 강의에서 다룰 항목을 소개합니다.";
    case "thanks":
      return "마무리 슬라이드입니다.";
    default:
      return null;
  }
}

/** One-line gist for a templated slide, used by the overview and concept steps. */
export function templateGist(slide: SlideInfo): string {
  if (slide.dupOf !== null) return `슬라이드 ${slide.dupOf}와 같은 내용`;
  return { cover: "표지", toc: "목차", thanks: "마무리", content: "", visual: "" }[slide.kind];
}
