// Transcript alignment for an import (spec 4.3): script-only by default,
// with an optional LLM check of the low-confidence spans (task
// "alignment", off unless the user picks a provider). No obsidian import:
// the plugin and the Skill CLI share it.

import { LLMProvider } from "../types";
import { TranscriptSegment } from "../sources/types";
import { renderPrompt } from "../prompts/render";
import {
  AlignedSpan,
  AlignmentResult,
  alignTranscript,
  chunksFromAlignment,
  formatAlignment,
  LOW_CONFIDENCE,
  TimedSegment,
} from "../core/prep/TranscriptAligner";
import alignmentCheckTemplate from "../../prompts/alignment-check.md";

export interface LectureAlignment {
  result: AlignmentResult;
  segments: TimedSegment[];
  /** Transcript per slide (index 0 = slide 1), used instead of the even split. */
  chunks: Array<string | null>;
  /** Frontmatter value of `alt_alignment`. */
  value: string;
  lowSpans: AlignedSpan[];
  /** Spans changed by the LLM check (0 when it did not run). */
  llmChanged: number;
}

/** Segments with timestamps, or null when the transcript has none (URL source). */
export function timedSegments(segments: TranscriptSegment[] | undefined): TimedSegment[] | null {
  if (!segments || segments.length === 0) return null;
  const timed = segments.filter((s): s is TranscriptSegment & { startMs: number; endMs: number } => s.startMs !== null && s.endMs !== null);
  if (timed.length === 0 || timed.length < segments.length * 0.9) return null;
  return timed.map((s) => ({ startMs: s.startMs, endMs: Math.max(s.endMs, s.startMs), text: s.text }));
}

function finish(result: AlignmentResult, segments: TimedSegment[], slideCount: number, llmChanged: number): LectureAlignment {
  return {
    result,
    segments,
    chunks: chunksFromAlignment(result, segments, slideCount),
    value: formatAlignment(result.spans),
    lowSpans: result.spans.filter((s) => s.confidence < LOW_CONFIDENCE),
    llmChanged,
  };
}

/** Aligns when the transcript has timestamps; null otherwise (even split applies). */
export function alignLecture(slideTexts: string[], segments: TranscriptSegment[] | undefined): LectureAlignment | null {
  const timed = timedSegments(segments);
  if (!timed || slideTexts.length === 0) return null;
  return finish(alignTranscript(slideTexts, timed), timed, slideTexts.length, 0);
}

/** At most this many uncertain spans go to the check call. */
export const MAX_CHECK_SPANS = 12;
const EXCERPT_CHARS = 500;
const SLIDE_CHARS = 280;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function candidatesFor(span: AlignedSpan, slideCount: number): number[] {
  const c = new Set<number>([span.slide]);
  if (span.slide > 1) c.add(span.slide - 1);
  if (span.slide < slideCount) c.add(span.slide + 1);
  return Array.from(c).sort((a, b) => a - b);
}

/** Prompt of the check call, or null when no span needs it. */
export function buildAlignmentCheckPrompt(title: string, alignment: LectureAlignment, slideTexts: string[]): string | null {
  const spans = alignment.lowSpans.slice(0, MAX_CHECK_SPANS);
  if (spans.length === 0) return null;
  const parts = spans.map((span, i) => {
    const excerpt = alignment.segments.slice(span.fromSegment, span.toSegment).map((s) => s.text).join(" ");
    const cands = candidatesFor(span, slideTexts.length)
      .map((n) => `  - 슬라이드 ${n}: ${clip(slideTexts[n - 1] ?? "", SLIDE_CHARS) || "(텍스트 없음)"}`)
      .join("\n");
    return `[part ${i + 1}] current guess: slide ${span.slide}\ntranscript: ${clip(excerpt, EXCERPT_CHARS)}\ncandidates:\n${cands}`;
  });
  return renderPrompt(alignmentCheckTemplate, { title, parts: parts.join("\n\n") });
}

export const ALIGNMENT_CHECK_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["parts"],
  properties: {
    parts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "slide"],
        properties: { id: { type: "integer" }, slide: { type: "integer" } },
      },
    },
  },
};

/**
 * Asks the alignment-check model about the low-confidence spans (one call)
 * and relabels the spans it moves to another candidate. A failed call keeps
 * the script result; cancellation propagates.
 */
export async function checkAlignmentWithLlm(
  llm: LLMProvider,
  title: string,
  alignment: LectureAlignment,
  slideTexts: string[],
  signal?: AbortSignal
): Promise<LectureAlignment> {
  const prompt = buildAlignmentCheckPrompt(title, alignment, slideTexts);
  if (!prompt) return alignment;
  const spans = alignment.lowSpans.slice(0, MAX_CHECK_SPANS);
  const answer = await llm.generateJSON(
    prompt,
    (raw) => {
      const parts = (raw as { parts?: unknown })?.parts;
      if (!Array.isArray(parts)) throw new Error("parts 배열이 없음");
      return parts as Array<{ id?: unknown; slide?: unknown }>;
    },
    { schema: ALIGNMENT_CHECK_SCHEMA, signal, attempts: 1 }
  );
  const segmentSlides = alignment.result.segmentSlides.slice();
  const moved = new Map<AlignedSpan, number>();
  for (const a of answer) {
    const id = Number(a.id);
    const slide = Number(a.slide);
    const span = spans[id - 1];
    if (!span || !Number.isInteger(slide)) continue;
    if (!candidatesFor(span, slideTexts.length).includes(slide) || slide === span.slide) continue;
    moved.set(span, slide);
    for (let k = span.fromSegment; k < span.toSegment; k++) segmentSlides[k] = slide;
  }
  if (moved.size === 0) return alignment;
  // Rebuild spans: neighbours with the same slide merge.
  const next: AlignedSpan[] = [];
  for (const span of alignment.result.spans) {
    const slide = moved.get(span) ?? span.slide;
    const checked = moved.has(span) ? { confidence: LOW_CONFIDENCE } : {};
    const prev = next[next.length - 1];
    if (prev && prev.slide === slide) {
      prev.endMs = span.endMs;
      prev.toSegment = span.toSegment;
      prev.confidence = Math.max(prev.confidence, checked.confidence ?? span.confidence);
    } else {
      next.push({ ...span, slide, ...checked });
    }
  }
  return finish({ spans: next, segmentSlides }, alignment.segments, slideTexts.length, moved.size);
}

/** Status line of the import screen. Alignment is not an option: it runs whenever timestamps exist. */
export function alignmentStatus(timestamps: boolean, hasTranscript: boolean): string {
  if (hasTranscript && timestamps) return "전사 타임스탬프 있음 · 슬라이드에 자동 정렬";
  return hasTranscript ? "전사 타임스탬프 없음 · 균등 분할" : "전사 없음";
}
