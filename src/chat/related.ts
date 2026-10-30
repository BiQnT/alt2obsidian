// Related slides under an answer (2.1.0 spec 5.11): at send time, without
// tokens, the slides of this lecture that match the question best, by BM25
// with the note verifier's tokenizer and its direct-match rule (at least two
// shared terms or a score of 8, src/verify/evidence.ts). Slides already in
// the material are left out, and nothing is added by itself: "+ 자료에 추가"
// adds a slide for the next question. Pure: no obsidian import.

import { buildEvidenceIndex, rankSlides, strongHit } from "../verify/evidence";

/** Related slides shown under an answer, at most. */
export const RELATED_SLIDES = 2;

/** One slide as the search reads it: its gist, commentary and the page text already read. */
export interface SlideDoc {
  num: number;
  gist: string;
  text: string;
}

export interface RelatedSlide {
  num: number;
  gist: string;
}

/** The best matching slides for a question, those in `exclude` (the material) left out. */
export function relatedSlides(question: string, docs: SlideDoc[], exclude: number[], max = RELATED_SLIDES): RelatedSlide[] {
  if (docs.length === 0 || !question.trim()) return [];
  // The index is by position: slide N is document N - 1.
  const texts = new Array<string>(Math.max(...docs.map((d) => d.num))).fill("");
  for (const d of docs) if (d.num >= 1) texts[d.num - 1] = d.text;
  const gists = new Map(docs.map((d) => [d.num, d.gist]));
  return rankSlides(question, buildEvidenceIndex(texts, []), texts.length)
    .filter((h) => !exclude.includes(h.slide) && strongHit(h))
    .slice(0, max)
    .map((h) => ({ num: h.slide, gist: gists.get(h.slide) ?? "" }));
}
