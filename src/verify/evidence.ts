// Evidence retrieval for the note verifier (spec 4.6 step 2). Script only,
// no tokens: BM25 over the slide texts (primary, top 2) and the aligned
// transcript chunks (secondary, top 2), with the transcript aligner's
// tokenizer (Korean and English, stopwords, light stemming).

import { alignTokens, segmentInSpan, StoredSpan, TimedSegment } from "../core/prep/TranscriptAligner";
import { classifySlide, slideTitle } from "../core/prep/SlideAnalyzer";
import { normalizePageText } from "../core/slideHash";
import { Claim } from "./claims";
import { englishHints } from "./glossary";

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
  /** Slide number, or the section number when the lecture has no slides (spec 4.10). */
  slide: number;
  score: number;
  /** Distinct claim terms found in the slide. */
  shared: number;
  /** Share of the claim's distinct terms found in the slide. */
  coverage: number;
  excerpt: string;
  /** Section evidence: when the excerpt was said. */
  startMs?: number;
}

export interface TranscriptHit {
  slide: number | null;
  startMs: number;
  score: number;
  excerpt: string;
}

/**
 * How the slides were found: the claim's own terms ("direct"), or, when it
 * shares no term with any slide (a Korean note on English slides), the
 * nearby claims of its section, its heading, or the whole section.
 */
export type EvidenceSource = "direct" | "weak" | "neighbour" | "heading" | "section";

/**
 * A direct match counts (and may lend its slides to neighbours) only with
 * at least 2 distinct shared terms or this BM25 score: one generic word in
 * common is no evidence. A weaker match is "weak" and looks for context
 * evidence first.
 */
export const MIN_SHARED_TERMS = 2;
export const MIN_DIRECT_SCORE = 8;

function strongHit(h: SlideHit | undefined): boolean {
  return !!h && (h.shared >= MIN_SHARED_TERMS || h.score >= MIN_DIRECT_SCORE);
}

export interface ClaimEvidence {
  claim: Claim;
  slides: SlideHit[];
  transcript: TranscriptHit[];
  source: EvidenceSource;
  /** High slide coverage and no number, formula or negation: judged last (spec 4.6 "맞음 후보"). */
  likelyTrue: boolean;
  /** No evidence found by any route: listed apart, not judged (never a verdict). */
  unmatched: boolean;
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

/** A slide text this short is sent whole instead of an excerpt. */
export const WHOLE_SLIDE_CHARS = 700;

/**
 * The part of `text` around its lines (or sentences) richest in the
 * claim's distinct terms, at most `max` characters. Grows toward the
 * richer neighbour, and tries the other side when that one does not fit.
 */
export function bestExcerpt(text: string, terms: Set<string>, max: number): string {
  const units = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((u) => u.replace(/\s+/g, " ").trim())
    .filter((u) => u.length > 0);
  if (units.length === 0) return "";
  const hits = units.map((u) => new Set(alignTokens(u).filter((t) => terms.has(t))).size);
  let best = 0;
  for (let i = 1; i < units.length; i++) if (hits[i] > hits[best]) best = i;
  let from = best;
  let to = best + 1;
  let len = units[best].length;
  for (;;) {
    const left = from > 0 ? units[from - 1].length + 1 : Infinity;
    const right = to < units.length ? units[to].length + 1 : Infinity;
    const preferLeft = from > 0 && (to >= units.length || hits[from - 1] > hits[to]);
    if (preferLeft && len + left <= max) {
      from--;
      len += left;
    } else if (!preferLeft && len + right <= max) {
      to++;
      len += right;
    } else if (preferLeft && len + right <= max) {
      to++;
      len += right;
    } else if (!preferLeft && len + left <= max) {
      from--;
      len += left;
    } else break;
  }
  const out = units.slice(from, to).join(" ");
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

/** Slide evidence text: the whole slide when it is short, else the best excerpt. */
export function slideExcerpt(text: string, terms: Set<string>): string {
  const whole = text.replace(/\s+/g, " ").trim();
  return whole.length <= WHOLE_SLIDE_CHARS ? whole : bestExcerpt(text, terms, SLIDE_EXCERPT_CHARS);
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

/**
 * Retrieval terms of a text: its own tokens (English words, numbers,
 * Korean stems; English in parentheses is already in the text) plus the
 * English hint words of its Korean terms (glossary.ts). No tokens.
 */
export function retrievalTerms(text: string): string[] {
  const own = alignTokens(text);
  const hints = alignTokens(englishHints(text).join(" "));
  return [...own, ...hints];
}

function slideHits(scores: number[], terms: Set<string>, index: EvidenceIndex, k = TOP_SLIDES): SlideHit[] {
  return topK(scores, k).map((i) => {
    const docTerms = index.slides.tf[i];
    let shared = 0;
    for (const t of terms) if (docTerms.has(t)) shared++;
    return {
      slide: i + 1,
      score: Math.round(scores[i] * 100) / 100,
      shared,
      coverage: terms.size > 0 ? Math.round((shared / terms.size) * 100) / 100 : 0,
      excerpt: slideExcerpt(index.slideTexts[i], terms),
    };
  });
}

/** Direct evidence of one claim: BM25 over the slides and the transcript chunks with its retrieval terms. */
export function findEvidence(claim: Claim, index: EvidenceIndex): ClaimEvidence {
  const tokens = retrievalTerms(claim.text);
  const terms = new Set(tokens);
  const slides = slideHits(bm25(tokens, index.slides), terms, index);
  const chunkScores = bm25(tokens, index.chunkIndex);
  const transcript: TranscriptHit[] = topK(chunkScores, TOP_TRANSCRIPT).map((i) => ({
    slide: index.chunks[i].slide,
    startMs: index.chunks[i].startMs,
    score: Math.round(chunkScores[i] * 100) / 100,
    excerpt: bestExcerpt(index.chunks[i].text, terms, TRANSCRIPT_EXCERPT_CHARS),
  }));
  const strong = strongHit(slides[0]);
  const likelyTrue =
    strong &&
    terms.size >= 3 &&
    (slides[0]?.coverage ?? 0) >= LIKELY_TRUE_COVERAGE &&
    !NUMBER_OR_FORMULA.test(claim.text) &&
    !NEGATION.test(claim.text);
  return { claim, slides, transcript, source: slides.length > 0 && !strong ? "weak" : "direct", likelyTrue, unmatched: slides.length === 0 && transcript.length === 0 };
}

/** How far (in claims) a neighbour may be. */
const NEIGHBOUR_WINDOW = 3;

/**
 * Evidence for claims that share no term with any slide or transcript
 * chunk, from their context, in this order:
 *   1. neighbour: the slides the nearest claims of the same section found
 *      directly (up to 3 claims away, nearer ones weigh more);
 *   2. heading: the slides that match the section heading's terms;
 *   3. section: the slides that match all claims of the section together.
 * The transcript evidence is then the first chunks aligned to those slides.
 * A claim that still has nothing stays `unmatched`.
 */
export function withContextEvidence(evidence: ClaimEvidence[], index: EvidenceIndex): ClaimEvidence[] {
  const out = evidence.map((e) => ({ ...e }));
  // Only strong direct matches lend their slides.
  const direct = evidence.map((e) => e.source === "direct" && e.slides.length > 0);
  const transcriptFor = (slides: number[]): TranscriptHit[] => {
    const hits: TranscriptHit[] = [];
    for (const n of slides) {
      const c = index.chunks.find((ch) => ch.slide === n);
      if (c) hits.push({ slide: c.slide, startMs: c.startMs, score: 0, excerpt: c.text.length > TRANSCRIPT_EXCERPT_CHARS ? `${c.text.slice(0, TRANSCRIPT_EXCERPT_CHARS - 3)}...` : c.text });
      if (hits.length >= TOP_TRANSCRIPT) break;
    }
    return hits;
  };
  const fromSlides = (e: ClaimEvidence, pages: number[], source: EvidenceSource): ClaimEvidence => {
    const terms = new Set(retrievalTerms(e.claim.text));
    const slides = pages.slice(0, TOP_SLIDES).map((n) => ({ slide: n, score: 0, shared: 0, coverage: 0, excerpt: slideExcerpt(index.slideTexts[n - 1] ?? "", terms) }));
    return { ...e, slides, transcript: e.transcript.length > 0 ? e.transcript : transcriptFor(slides.map((h) => h.slide)), source, likelyTrue: false, unmatched: false };
  };
  const strongPages = (text: string): number[] => {
    const t = retrievalTerms(text);
    const hits = slideHits(bm25(t, index.slides), new Set(t), index);
    return strongHit(hits[0]) ? hits.map((h) => h.slide) : [];
  };
  /** Context slides for claim i: neighbours, then heading, then section; null when none. */
  const contextFor = (i: number): { pages: number[]; source: EvidenceSource } | null => {
    const e = evidence[i];
    const weight = new Map<number, number>();
    for (let d = 1; d <= NEIGHBOUR_WINDOW; d++) {
      for (const j of [i - d, i + d]) {
        if (j < 0 || j >= evidence.length || !direct[j] || evidence[j].claim.sectionIndex !== e.claim.sectionIndex) continue;
        evidence[j].slides.forEach((h, rank) => weight.set(h.slide, (weight.get(h.slide) ?? 0) + (NEIGHBOUR_WINDOW + 1 - d) / (rank + 1)));
      }
    }
    if (weight.size > 0) return { pages: [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n]) => n), source: "neighbour" };
    if (e.claim.section) {
      const heading = strongPages(e.claim.section);
      if (heading.length > 0) return { pages: heading, source: "heading" };
    }
    const sectionText = evidence.filter((x) => x.claim.sectionIndex === e.claim.sectionIndex).map((x) => x.claim.text).join(" ");
    const section = strongPages(sectionText);
    return section.length > 0 ? { pages: section, source: "section" } : null;
  };
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.slides.length > 0 && e.source === "direct") continue;
    const ctx = contextFor(i);
    if (e.source === "weak" && e.slides.length > 0) {
      // A weak match keeps its own top slide first (its one shared term is
      // still a lead) and fills the rest from the context.
      if (!ctx) continue;
      const own = e.slides[0];
      const rest = fromSlides(e, ctx.pages.filter((n) => n !== own.slide), ctx.source).slides;
      out[i] = { ...e, slides: [own, ...rest].slice(0, TOP_SLIDES), source: "weak", likelyTrue: false };
      continue;
    }
    if (ctx) out[i] = fromSlides(e, ctx.pages, ctx.source);
  }
  return out;
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
  // Only direct matches count: context evidence is a guess.
  for (const e of evidence) if (e.source === "direct") for (const h of e.slides) if (h.coverage >= LINK_COVERAGE) linked.add(h.slide);
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

// ---- Lectures without slides (spec 4.10) ----
// The documents are the transcript sections of the summary note (about 12
// minutes each): BM25 over the section text plus the glossary hints, exactly
// like slides. Each section hit then carries the excerpt of its best chunk
// (about 420 characters) and the time that chunk starts, so the evidence is
// "구간 N [mm:ss]: ..."; there is no separate transcript evidence.

export interface VerifySection {
  num: number;
  startMs: number;
  endMs: number;
  /** The note's heading text ("⏱ 구간 3 [24:10~36:02]"), null when the note has no section headings. */
  heading: string | null;
  /** The section's one-line gist from the note, "" when unknown. */
  gist: string;
}

/** Sections as stored spans: a segment belongs to the section its start falls in. */
export function sectionSpans(sections: VerifySection[]): StoredSpan[] {
  return sections.map((s, i) => ({
    slide: s.num,
    startMs: i === 0 ? 0 : Math.floor(s.startMs / 100) * 100,
    endMs: i + 1 < sections.length ? Math.floor(sections[i + 1].startMs / 100) * 100 : Number.MAX_SAFE_INTEGER,
    low: false,
  }));
}

/** Each section hit gets the excerpt and time of its best chunk for the claim; transcript hits are dropped. */
export function withSectionExcerpts(evidence: ClaimEvidence[], index: EvidenceIndex): ClaimEvidence[] {
  return evidence.map((e) => {
    const terms = retrievalTerms(e.claim.text);
    const scores = bm25(terms, index.chunkIndex);
    const termSet = new Set(terms);
    const slides = e.slides.map((h) => {
      let best = -1;
      for (let i = 0; i < index.chunks.length; i++) {
        if (index.chunks[i].slide !== h.slide) continue;
        if (best < 0 || scores[i] > scores[best]) best = i;
      }
      if (best < 0) return h;
      const chunk = index.chunks[best];
      return { ...h, excerpt: bestExcerpt(chunk.text, termSet, TRANSCRIPT_EXCERPT_CHARS), startMs: chunk.startMs };
    });
    return { ...e, slides, transcript: [] };
  });
}

/** Sections no claim covers (directly, 30% of its terms), with their gist as the title; nearly empty sections skipped. */
export function uncoveredSections(sections: VerifySection[], sectionTexts: string[], evidence: ClaimEvidence[], max = 40): UncoveredSlide[] {
  const linked = new Set<number>();
  for (const e of evidence) if (e.source === "direct") for (const h of e.slides) if (h.coverage >= LINK_COVERAGE) linked.add(h.slide);
  const out: UncoveredSlide[] = [];
  sections.forEach((sec, i) => {
    if (linked.has(sec.num)) return;
    const text = (sectionTexts[i] ?? "").replace(/\s+/g, " ").trim();
    if (normalizePageText(text).length < 30) return;
    out.push({ slide: sec.num, title: sec.gist || `구간 ${sec.num}`, keySentences: sec.gist ? "" : text.length > 200 ? `${text.slice(0, 197)}...` : text });
  });
  return out.slice(0, max);
}
