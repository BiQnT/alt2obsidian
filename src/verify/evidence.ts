// Evidence retrieval for the note verifier (spec 4.6 step 2). Script only,
// no tokens: BM25 over the slide texts (primary, top 2) and the aligned
// transcript chunks (secondary, top 2), with the transcript aligner's
// tokenizer (Korean and English, stopwords, light stemming).

import { alignTokens, segmentInSpan, StoredSpan, TimedSegment } from "../core/prep/TranscriptAligner";
import { classifySlide, slideTitle } from "../core/prep/SlideAnalyzer";
import { normalizePageText } from "../core/slideHash";
import { Claim } from "./claims";

export const TOP_SLIDES = 2;
export const TOP_TRANSCRIPT = 2;
/** Characters of evidence per excerpt in the prompt. */
export const SLIDE_EXCERPT_CHARS = 320;
export const TRANSCRIPT_EXCERPT_CHARS = 260;
/** Transcript chunk size (characters) for retrieval. */
const CHUNK_CHARS = 420;
/** Share of a claim's terms a slide must hold to count as "likely true" / as covering it. */
export const LIKELY_TRUE_COVERAGE = 0.8;
export const LINK_COVERAGE = 0.3;

export interface TranscriptChunk {
  /** Aligned slide, null when the transcript has no alignment. */
  slide: number | null;
  startMs: number;
  text: string;
}

export interface SlideHit {
  slide: number;
  score: number;
  /** Share of the claim's distinct terms found in the slide. */
  coverage: number;
  excerpt: string;
}

export interface TranscriptHit {
  slide: number | null;
  startMs: number;
  score: number;
  excerpt: string;
}

export interface ClaimEvidence {
  claim: Claim;
  slides: SlideHit[];
  transcript: TranscriptHit[];
  /** High slide coverage and no number, formula or negation: judged last (spec 4.6 "맞음 후보"). */
  likelyTrue: boolean;
  /** No term shared with any slide or transcript chunk: "근거 없음" without an LLM call. */
  noEvidence: boolean;
}

// ---- BM25 ----

interface Bm25Index {
  tf: Array<Map<string, number>>;
  len: number[];
  avgLen: number;
  idf: Map<string, number>;
}

function termCounts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function buildIndex(docs: string[]): Bm25Index {
  const tf = docs.map((d) => termCounts(alignTokens(d)));
  const len = tf.map((m) => Array.from(m.values()).reduce((a, b) => a + b, 0));
  const avgLen = Math.max(1, len.reduce((a, b) => a + b, 0) / Math.max(1, len.length));
  const df = new Map<string, number>();
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (docs.length - d + 0.5) / (d + 0.5)));
  return { tf, len, avgLen, idf };
}

function bm25(terms: string[], index: Bm25Index, k1 = 1.2, b = 0.75): number[] {
  const scores = new Array(index.tf.length).fill(0);
  for (const term of new Set(terms)) {
    const idf = index.idf.get(term);
    if (idf === undefined) continue;
    for (let j = 0; j < index.tf.length; j++) {
      const f = index.tf[j].get(term);
      if (!f) continue;
      scores[j] += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.len[j]) / index.avgLen));
    }
  }
  return scores;
}

function topK(scores: number[], k: number): number[] {
  return scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, k)
    .map(([, i]) => i);
}

// ---- excerpts ----

/** The part of `text` around its lines (or sentences) richest in the claim's terms, at most `max` characters. */
export function bestExcerpt(text: string, terms: Set<string>, max: number): string {
  const units = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((u) => u.replace(/\s+/g, " ").trim())
    .filter((u) => u.length > 0);
  if (units.length === 0) return "";
  const hits = units.map((u) => alignTokens(u).filter((t) => terms.has(t)).length);
  let best = 0;
  for (let i = 1; i < units.length; i++) if (hits[i] > hits[best]) best = i;
  let from = best;
  let to = best + 1;
  let len = units[best].length;
  // Grow toward the richer neighbour while it fits.
  for (;;) {
    const left = from > 0 ? units[from - 1].length + 1 : Infinity;
    const right = to < units.length ? units[to].length + 1 : Infinity;
    const preferLeft = from > 0 && (to >= units.length || hits[from - 1] > hits[to]);
    const step = preferLeft ? left : right;
    if (step === Infinity || len + step > max) break;
    if (preferLeft) from--;
    else to++;
    len += step;
  }
  const out = units.slice(from, to).join(" ");
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

// ---- transcript chunks ----

/**
 * Retrieval chunks of the transcript: segments of one aligned span (spec
 * 4.3 `alt_alignment`) grouped up to about 420 characters. Without spans,
 * consecutive segments are grouped the same way with no slide.
 */
export function transcriptChunks(segments: TimedSegment[], spans: StoredSpan[] | null): TranscriptChunk[] {
  const out: TranscriptChunk[] = [];
  let cur: TranscriptChunk | null = null;
  const slideOf = (seg: TimedSegment): number | null => {
    if (!spans || spans.length === 0) return null;
    const span = spans.find((s) => segmentInSpan(seg.startMs, s));
    return span ? span.slide : null;
  };
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const slide = slideOf(seg);
    if (cur && cur.slide === slide && cur.text.length + text.length + 1 <= CHUNK_CHARS) {
      cur.text += ` ${text}`;
      continue;
    }
    cur = { slide, startMs: seg.startMs, text };
    out.push(cur);
  }
  return out;
}

// ---- claims ----

const NUMBER_OR_FORMULA = /\d|[=<>^√∑∫±×÷≤≥≈∝∞]|\bO\(/;
const NEGATION = /않|없|못|아니|안\s|\bnot\b|\bnever\b|n't\b|\bno\b|\bcannot\b/i;

export interface EvidenceIndex {
  slides: Bm25Index;
  slideTexts: string[];
  chunks: TranscriptChunk[];
  chunkIndex: Bm25Index;
}

export function buildEvidenceIndex(slideTexts: string[], chunks: TranscriptChunk[]): EvidenceIndex {
  return { slides: buildIndex(slideTexts), slideTexts, chunks, chunkIndex: buildIndex(chunks.map((c) => c.text)) };
}

export function findEvidence(claim: Claim, index: EvidenceIndex): ClaimEvidence {
  const tokens = alignTokens(claim.text);
  const terms = new Set(tokens);
  const slideScores = bm25(tokens, index.slides);
  const slides: SlideHit[] = topK(slideScores, TOP_SLIDES).map((i) => {
    const docTerms = index.slides.tf[i];
    let shared = 0;
    for (const t of terms) if (docTerms.has(t)) shared++;
    return {
      slide: i + 1,
      score: Math.round(slideScores[i] * 100) / 100,
      coverage: terms.size > 0 ? Math.round((shared / terms.size) * 100) / 100 : 0,
      excerpt: bestExcerpt(index.slideTexts[i], terms, SLIDE_EXCERPT_CHARS),
    };
  });
  const chunkScores = bm25(tokens, index.chunkIndex);
  const transcript: TranscriptHit[] = topK(chunkScores, TOP_TRANSCRIPT).map((i) => ({
    slide: index.chunks[i].slide,
    startMs: index.chunks[i].startMs,
    score: Math.round(chunkScores[i] * 100) / 100,
    excerpt: bestExcerpt(index.chunks[i].text, terms, TRANSCRIPT_EXCERPT_CHARS),
  }));
  const likelyTrue =
    terms.size >= 3 &&
    (slides[0]?.coverage ?? 0) >= LIKELY_TRUE_COVERAGE &&
    !NUMBER_OR_FORMULA.test(claim.text) &&
    !NEGATION.test(claim.text);
  return { claim, slides, transcript, likelyTrue, noEvidence: slides.length === 0 && transcript.length === 0 };
}

export interface UncoveredSlide {
  slide: number;
  title: string;
  /** Key sentences: the start of the slide text after the title, whitespace collapsed. */
  keySentences: string;
}

/** Slides not covering at least 30% of any claim among its top 2, without cover, contents, closing and textless pages. */
export function uncoveredSlides(slideTexts: string[], evidence: ClaimEvidence[], maxSlides = 40): UncoveredSlide[] {
  const linked = new Set<number>();
  for (const e of evidence) for (const h of e.slides) if (h.coverage >= LINK_COVERAGE) linked.add(h.slide);
  const out: UncoveredSlide[] = [];
  slideTexts.forEach((text, i) => {
    if (linked.has(i + 1)) return;
    if (normalizePageText(text).length < 30) return;
    const kind = classifySlide(i, slideTexts.length, text, null, text.split("\n"));
    if (kind === "cover" || kind === "toc" || kind === "thanks") return;
    const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const title = slideTitle(lines[0] ?? "");
    const rest = lines.slice(1).join(" ");
    out.push({ slide: i + 1, title, keySentences: rest.length > 200 ? `${rest.slice(0, 197)}...` : rest });
  });
  return out.slice(0, maxSlides);
}
