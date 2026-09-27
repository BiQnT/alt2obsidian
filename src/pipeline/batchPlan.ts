// Generation plan for one deck (spec 5.1 to 5.4). Pure: decides per slide
// whether it gets an LLM call, a template line, or its previous commentary,
// attaches the compressed transcript, and groups the LLM slides into
// batches. The estimate and the generator both work from this plan.

import { splitMultiManagedNote } from "../core/merge";
import { parseSlideMeta, stripSlideMeta } from "../core/slideMeta";
import { PageLayout, SlideInfo, sameImageSignal, templateCommentary } from "../core/prep/SlideAnalyzer";
import { compressTranscript, splitTranscriptEvenly } from "../core/prep/TranscriptCompressor";

export interface PlannedSlide extends SlideInfo {
  /** Page text layer ("" when unreadable). */
  text: string;
  /** Compressed transcript excerpt for this slide. */
  transcript: string;
  mode: "llm" | "template" | "reuse";
  /** Body for template slides. */
  template?: string;
  /** Previous managed body (without its meta line) and gist for reused slides. */
  reused?: { commentary: string; gist: string };
}

export interface Batch {
  pages: number[];
  hasImages: boolean;
}

export interface DeckPlan {
  slides: PlannedSlide[];
  batches: Batch[];
  scanned: boolean;
  transcriptChars: { before: number; after: number };
}

export interface ExistingSlide {
  slideNum: number;
  hash: string;
  commentary: string;
  imageSignal: string | null;
  gist: string;
}

/** Slides of an existing page-anchored note that carry 2.0 metadata. */
export function parseExistingSlides(noteContent: string): ExistingSlide[] {
  const out: ExistingSlide[] = [];
  for (const s of splitMultiManagedNote(noteContent).sections) {
    const meta = parseSlideMeta(s.managed);
    if (!meta || !meta.gist) continue;
    out.push({
      slideNum: s.slideNum,
      hash: s.hash,
      commentary: stripSlideMeta(s.managed).trim(),
      imageSignal: meta.imageSignal,
      gist: meta.gist,
    });
  }
  return out;
}

export interface PlanInput {
  slides: SlideInfo[];
  layouts: PageLayout[];
  scanned: boolean;
  transcript: string | null;
  transcriptCapChars: number;
  batchSize: number;
  deckTitle: string;
  /** Previous note's slides; reuse needs matching text hash and image signal. */
  existing?: ExistingSlide[];
}

export function planDeck(input: PlanInput): DeckPlan {
  const n = input.slides.length;
  const chunks = splitTranscriptEvenly(input.transcript, n);
  // A near-duplicate run is explained once, on its last page: that page gets
  // the whole run's transcript.
  const runChunks: string[] = chunks.map((c) => c ?? "");
  // Walk backwards so the run's chunks stay in deck order.
  for (const s of [...input.slides].reverse()) {
    if (s.dupOf !== null && runChunks[s.page - 1]) {
      runChunks[s.dupOf - 1] = `${runChunks[s.page - 1]} ${runChunks[s.dupOf - 1]}`.trim();
      runChunks[s.page - 1] = "";
    }
  }

  // Pair with previous slides by hash in deck order (merge pass 1).
  const pool = new Map<string, ExistingSlide[]>();
  for (const e of input.existing ?? []) {
    if (!pool.has(e.hash)) pool.set(e.hash, []);
    pool.get(e.hash)!.push(e);
  }

  let before = 0;
  let after = 0;
  const slides: PlannedSlide[] = input.slides.map((s, i) => {
    const text = input.layouts[i]?.text ?? "";
    const template = templateCommentary(s, input.deckTitle);
    if (template !== null) return { ...s, text, transcript: "", mode: "template", template };
    const candidates = pool.get(s.hash);
    const prev = candidates && candidates.length > 0 ? candidates[0] : undefined;
    if (prev) candidates!.shift();
    if (prev && s.imageSignal && sameImageSignal(prev.imageSignal, s.imageSignal)) {
      return { ...s, text, transcript: "", mode: "reuse", reused: { commentary: prev.commentary, gist: prev.gist } };
    }
    const compressed = compressTranscript(runChunks[i] || null, text, input.transcriptCapChars);
    before += compressed.originalChars;
    after += compressed.text.length;
    return { ...s, text, transcript: compressed.text, mode: "llm" };
  });

  return {
    slides,
    batches: makeBatches(slides, input.batchSize),
    scanned: input.scanned,
    transcriptChars: { before, after },
  };
}

/**
 * Consecutive LLM slides, K per batch; a batch with an image holds at most
 * K/2 slides (spec 5.3).
 */
export function makeBatches(slides: PlannedSlide[], batchSize: number): Batch[] {
  const k = Math.max(1, Math.floor(batchSize));
  const kImg = Math.max(1, Math.floor(k / 2));
  const batches: Batch[] = [];
  let cur: Batch = { pages: [], hasImages: false };
  for (const s of slides) {
    if (s.mode !== "llm") continue;
    const hasImages = cur.hasImages || s.sendImage;
    const limit = hasImages ? kImg : k;
    if (cur.pages.length > 0 && cur.pages.length + 1 > limit) {
      batches.push(cur);
      cur = { pages: [], hasImages: false };
    }
    cur.pages.push(s.page);
    cur.hasImages = cur.hasImages || s.sendImage;
  }
  if (cur.pages.length > 0) batches.push(cur);
  return batches;
}

/**
 * "Fewer images" (spec 5.5): visual slides that have a usable text layer go
 * text-only. Slides with no text keep their image, or they could not be
 * explained at all.
 */
export function withFewerImages(plan: DeckPlan, batchSize: number): DeckPlan {
  const slides = plan.slides.map((s) =>
    s.sendImage && s.textChars >= 30 && !plan.scanned ? { ...s, sendImage: false } : s
  );
  return { ...plan, slides, batches: makeBatches(slides, batchSize) };
}

export function planCounts(plan: DeckPlan): {
  total: number;
  llm: number;
  templated: number;
  deduped: number;
  reused: number;
  images: number;
} {
  const c = { total: plan.slides.length, llm: 0, templated: 0, deduped: 0, reused: 0, images: 0 };
  for (const s of plan.slides) {
    if (s.mode === "llm") {
      c.llm++;
      if (s.sendImage) c.images++;
    } else if (s.mode === "reuse") c.reused++;
    else if (s.dupOf !== null) c.deduped++;
    else c.templated++;
  }
  return c;
}
