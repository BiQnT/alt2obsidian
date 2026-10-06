// Transcript sections for lectures without slides (spec 4.10). Pure and
// deterministic, no LLM, no tokens.
//
// 1. Split: the timestamped transcript is cut on segment boundaries into
//    sections of 9 to 15 minutes (about 12; a 2 hour lecture gives 8 to 10).
//    Inside that window the cut goes where the talk changes topic: the word
//    overlap of the two minutes before and after a boundary is lowest (a
//    cheap TextTiling), with a bonus for a pause and a small pull toward 12
//    minutes. A short remainder is split in two halves instead of leaving a
//    tiny last section. A transcript without timestamps (URL source) is cut
//    the same way by characters (about 4,000 per section).
// 2. Compress: fillers, repeats and STT double outputs are removed
//    (TranscriptCompressor), sentences are grouped per minute with a
//    `[mm:ss]` prefix, and a section over the cap keeps the sentences that
//    share the most words with the rest of the section.
// 3. Hash: the slide hash rule over the section's raw text, so an unchanged
//    section is found again on re-import.

import { alignTokens, TimedSegment } from "./TranscriptAligner";
import { capSentences, collapseRepeats, contentTokens, dedupeSentences, removeFillers, splitSentences } from "./TranscriptCompressor";
import { computeSlideHash } from "../slideHash";
import { formatClock } from "../sections";
import { TranscriptSegment } from "../../sources/types";

export const SECTION_TARGET_MS = 12 * 60_000;
export const SECTION_MIN_MS = 9 * 60_000;
export const SECTION_MAX_MS = 15 * 60_000;
/** Without timestamps: characters per section and the window around it. */
export const UNTIMED_TARGET_CHARS = 4000;
export const UNTIMED_MIN_CHARS = 3000;
export const UNTIMED_MAX_CHARS = 5500;
/** Compressed transcript kept per section (characters). */
export const SECTION_CAP_CHARS = 3000;
/** Words on each side of a boundary compared for the topic shift. */
const TOPIC_WINDOW_MS = 120_000;
const TOPIC_WINDOW_CHARS = 600;
/** Sentences of one `[mm:ss]` line. */
const BLOCK_MS = 60_000;
const BLOCK_CHARS = 600;

export interface SectionSpan {
  /** 1-based section number. */
  num: number;
  /** Index of the first segment, and one past the last. */
  from: number;
  to: number;
  /** null without timestamps. */
  startMs: number | null;
  endMs: number | null;
}

export interface TranscriptSectionText extends SectionSpan {
  /** 8-hex hash of the raw text (src/core/slideHash.ts rule). */
  hash: string;
  /** Raw transcript of the section, segments joined by newlines. */
  raw: string;
  /** Compressed text sent to the model: `[mm:ss] sentences` lines (no prefix without timestamps). */
  text: string;
}

/** A segment with an optional time (the URL source has none). */
interface Seg {
  startMs: number | null;
  endMs: number | null;
  text: string;
}

function termCounts(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of alignTokens(text)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, x] of a) {
    na += x * x;
    const y = b.get(t);
    if (y) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Topic shift at boundary i (0 to 1): 1 minus the cosine of the words just
 * before and just after it. Nothing on one side gives 0.5 (no signal).
 */
function topicShift(segs: Seg[], i: number, pos: number[], window: number): number {
  const at = pos[i];
  const before: string[] = [];
  const after: string[] = [];
  for (let k = i - 1; k >= 0 && pos[k] >= at - window; k--) before.push(segs[k].text);
  for (let k = i; k < segs.length && pos[k] < at + window; k++) after.push(segs[k].text);
  const a = termCounts(before.join(" "));
  const b = termCounts(after.join(" "));
  if (a.size === 0 || b.size === 0) return 0.5;
  return 1 - cosine(a, b);
}

interface SplitScale {
  /** Position of each segment start (ms, or characters before it). */
  pos: number[];
  /** Position of the end of the transcript. */
  end: number;
  target: number;
  min: number;
  max: number;
  window: number;
  /** Pause before segment i (ms), 0 without timestamps. */
  pause(i: number): number;
}

/** Segment indexes where sections start (always 0 first). */
function boundaries(segs: Seg[], s: SplitScale): number[] {
  const starts = [0];
  let from = 0;
  for (;;) {
    const start = s.pos[from];
    const remaining = s.end - start;
    if (remaining <= s.max) break;
    // A remainder shorter than one section plus a short one is halved.
    const halve = remaining < s.max + s.min;
    const target = halve ? start + remaining / 2 : start + s.target;
    const lo = halve ? target - (s.max - s.min) / 2 : start + s.min;
    const hi = halve ? target + (s.max - s.min) / 2 : start + s.max;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = from + 1; i < segs.length; i++) {
      if (s.pos[i] < lo) continue;
      if (s.pos[i] > hi) break;
      const pause = Math.min(s.pause(i) / 10_000, 1) * 0.3;
      const pull = (Math.abs(s.pos[i] - target) / Math.max(1, hi - lo)) * 0.3;
      const score = topicShift(segs, i, s.pos, s.window) + pause - pull;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) {
      // No segment starts inside the window (a long pause or segment): the
      // first one after the target, else the section runs to the end.
      best = s.pos.findIndex((p, i) => i > from && p >= target);
      if (best < 0) break;
    }
    starts.push(best);
    from = best;
  }
  return starts;
}

function spansFrom(segs: Seg[], starts: number[], timed: boolean): SectionSpan[] {
  return starts.map((from, k) => {
    const to = k + 1 < starts.length ? starts[k + 1] : segs.length;
    return {
      num: k + 1,
      from,
      to,
      startMs: timed ? (segs[from].startMs as number) : null,
      endMs: timed ? Math.max(...segs.slice(from, to).map((x) => x.endMs as number)) : null,
    };
  });
}

/** Untimed pieces are at most this long, so the split can cut between them. */
const UNTIMED_PIECE_CHARS = 600;

/**
 * Untimed text in pieces of whole sentences up to 600 characters (a longer
 * sentence is cut at a space). The URL source joins the whole transcript
 * into one line, which would otherwise be a single segment and a single
 * section.
 */
function untimedPieces(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (piece: string) => {
    if (cur && cur.length + 1 + piece.length > UNTIMED_PIECE_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${piece}` : piece;
  };
  for (const sentence of splitSentences(text)) {
    let rest = sentence;
    while (rest.length > UNTIMED_PIECE_CHARS) {
      const cut = rest.lastIndexOf(" ", UNTIMED_PIECE_CHARS);
      const at = cut > UNTIMED_PIECE_CHARS / 2 ? cut : UNTIMED_PIECE_CHARS;
      push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) push(rest);
  }
  if (cur) out.push(cur);
  return out;
}

/** Segments with text, in time order; timed only when (nearly) every segment has a time. */
function cleanSegments(segments: TranscriptSegment[] | TimedSegment[]): { segs: Seg[]; timed: boolean } {
  const withText = (segments as Seg[]).filter((s) => s.text && s.text.trim());
  const timedCount = withText.filter((s) => s.startMs !== null && s.startMs !== undefined).length;
  const timed = withText.length > 0 && timedCount >= withText.length * 0.9;
  if (!timed) {
    const segs = withText.flatMap((s) => untimedPieces(s.text.trim()).map((text) => ({ startMs: null, endMs: null, text })));
    return { segs, timed: false };
  }
  // An untimed segment takes the previous time, like the aligner.
  let last = 0;
  const segs = withText.map((s) => {
    const start = s.startMs ?? last;
    const end = Math.max(s.endMs ?? start, start);
    last = end;
    return { startMs: start, endMs: end, text: s.text.trim() };
  });
  segs.sort((a, b) => (a.startMs as number) - (b.startMs as number));
  return { segs, timed: true };
}

/** Section boundaries of a transcript (no text: no sections). */
export function splitTranscriptSections(segments: TranscriptSegment[] | TimedSegment[]): { spans: SectionSpan[]; segs: Seg[]; timed: boolean } {
  const { segs, timed } = cleanSegments(segments);
  if (segs.length === 0) return { spans: [], segs, timed };
  if (timed) {
    const pos = segs.map((s) => s.startMs as number);
    const end = Math.max(...segs.map((s) => s.endMs as number));
    const starts = boundaries(segs, {
      pos,
      end,
      target: SECTION_TARGET_MS,
      min: SECTION_MIN_MS,
      max: SECTION_MAX_MS,
      window: TOPIC_WINDOW_MS,
      pause: (i) => Math.max(0, (segs[i].startMs as number) - (segs[i - 1].endMs as number)),
    });
    return { spans: spansFrom(segs, starts, true), segs, timed };
  }
  const pos: number[] = [];
  let chars = 0;
  for (const s of segs) {
    pos.push(chars);
    chars += s.text.length + 1;
  }
  const starts = boundaries(segs, {
    pos,
    end: chars,
    target: UNTIMED_TARGET_CHARS,
    min: UNTIMED_MIN_CHARS,
    max: UNTIMED_MAX_CHARS,
    window: TOPIC_WINDOW_CHARS,
    pause: () => 0,
  });
  return { spans: spansFrom(segs, starts, false), segs, timed };
}

/** Tokens found in at least two sentences of the section: what it is about. */
function sectionProfile(sentences: string[]): string {
  const df = new Map<string, number>();
  for (const s of sentences) for (const t of contentTokens(s)) df.set(t, (df.get(t) ?? 0) + 1);
  return Array.from(df.entries())
    .filter(([, n]) => n >= 2)
    .map(([t]) => t)
    .join(" ");
}

/**
 * Compressed section text: fillers and repeats removed, STT double outputs
 * dropped, sentences grouped per minute as `[mm:ss] ...` lines (per about
 * 600 characters without timestamps), at most `capChars` characters of
 * sentences, keeping the ones most typical of the section.
 */
export function compressSection(segs: Seg[], span: SectionSpan, capChars = SECTION_CAP_CHARS): string {
  const blocks: Array<{ at: number | null; sentences: string[] }> = [];
  let blockStart: number | null = null;
  let blockChars = 0;
  for (let i = span.from; i < span.to; i++) {
    const s = segs[i];
    const cleaned = collapseRepeats(removeFillers(s.text));
    if (!cleaned) continue;
    const newBlock =
      blocks.length === 0 ||
      (s.startMs !== null && blockStart !== null ? s.startMs - blockStart >= BLOCK_MS : blockChars >= BLOCK_CHARS);
    if (newBlock) {
      blocks.push({ at: s.startMs, sentences: [] });
      blockStart = s.startMs;
      blockChars = 0;
    }
    const sentences = splitSentences(cleaned);
    blocks[blocks.length - 1].sentences.push(...sentences);
    blockChars += cleaned.length;
  }
  // Duplicates across the whole section, then the cap.
  const flat: Array<{ block: number; text: string }> = [];
  blocks.forEach((b, k) => b.sentences.forEach((text) => flat.push({ block: k, text })));
  const unique = dedupeSentences(flat.map((f) => f.text));
  const kept: Array<{ block: number; text: string }> = [];
  let u = 0;
  for (const f of flat) {
    if (u < unique.length && f.text === unique[u]) {
      kept.push(f);
      u++;
    }
  }
  const capped = capSentences(
    kept.map((k) => k.text),
    sectionProfile(kept.map((k) => k.text)),
    capChars
  );
  const out: Array<{ block: number; text: string }> = [];
  let c = 0;
  for (const k of kept) {
    if (c < capped.length && k.text === capped[c]) {
      out.push(k);
      c++;
    }
  }
  const lines: string[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const text = out.filter((o) => o.block === k).map((o) => o.text).join(" ");
    if (!text) continue;
    const at = blocks[k].at;
    lines.push(at === null ? text : `[${formatClock(at)}] ${text}`);
  }
  return lines.join("\n");
}

/** Sections with their hash, raw text and compressed text (the input of a summary note). */
export async function transcriptSections(
  segments: TranscriptSegment[] | TimedSegment[],
  sourceId: string,
  capChars = SECTION_CAP_CHARS
): Promise<{ sections: TranscriptSectionText[]; timed: boolean; durationMs: number | null }> {
  const { spans, segs, timed } = splitTranscriptSections(segments);
  const sections: TranscriptSectionText[] = [];
  for (const span of spans) {
    const raw = segs.slice(span.from, span.to).map((s) => s.text).join("\n");
    sections.push({ ...span, raw, hash: await computeSlideHash(raw, span.num, sourceId), text: compressSection(segs, span, capChars) });
  }
  const durationMs = timed && segs.length > 0 ? Math.max(...segs.map((s) => s.endMs as number)) : null;
  return { sections, timed, durationMs };
}
