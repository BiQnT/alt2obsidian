// Generation plan of a summary note for a lecture without slides (spec
// 4.10). Pure: the transcript is cut into sections (no tokens), each section
// either gets an LLM call or reuses its previous summary (same transcript
// hash and a stored gist), and the LLM sections are grouped into batches.
// The estimate and the generator both work from this plan.

import { TranscriptSegment } from "../sources/types";
import { TimedSegment } from "../core/prep/TranscriptAligner";
import { SECTION_CAP_CHARS, splitTranscriptSections, transcriptSections } from "../core/prep/TranscriptSections";
import { splitSectionNote } from "../core/merge";
import { parseSlideMeta, stripSlideMeta } from "../core/slideMeta";
import { parseSectionHeading } from "../core/sections";
import type { VerifySection } from "../verify/evidence";

/** A section of the previous note (re-import). */
export interface ExistingSection {
  num: number;
  hash: string;
  /** Managed body without its meta line. */
  body: string;
  /** "" for a section without meta. */
  gist: string;
  /** Start time from its heading (whole seconds), null when the heading has none. */
  startMs?: number | null;
}

export interface PlannedSection {
  num: number;
  hash: string;
  startMs: number | null;
  endMs: number | null;
  /** Compressed transcript sent to the model (`[mm:ss] ...` lines). */
  text: string;
  /** Raw transcript characters (before compression). */
  rawChars: number;
  mode: "llm" | "reuse";
  /** Previous summary and gist of a reused section. */
  reused?: { body: string; gist: string };
  /**
   * LLM sections only: the previous note's section (same hash, else same
   * number), kept when generation fails so a failed re-import never deletes
   * an existing summary.
   */
  previous?: ExistingSection;
}

export interface TranscriptPlan {
  sections: PlannedSection[];
  /** Section numbers per call. */
  batches: number[][];
  /** The transcript has timestamps (local Alt notes); a URL transcript has none. */
  timed: boolean;
  /** End of the last segment (ms), null without timestamps. */
  durationMs: number | null;
  transcriptChars: { before: number; after: number };
}

/** At most this many sections and transcript characters per call (a 2 hour lecture fits in one). */
export const SECTIONS_PER_CALL = 12;
export const SECTION_CHARS_PER_CALL = 36_000;

/** Every transcript section of an existing summary note, with its gist when the meta line is there. */
export function parseExistingSections(noteContent: string): ExistingSection[] {
  return splitSectionNote(noteContent).sections.map((s) => {
    const meta = parseSlideMeta(s.managed);
    return { num: s.num, hash: s.hash, body: stripSlideMeta(s.managed).trim(), gist: meta?.gist ?? "", startMs: s.parsed?.startMs ?? null };
  });
}

/** Consecutive LLM sections, at most `maxSections` and `maxChars` of transcript per call. */
export function makeSectionBatches(sections: PlannedSection[], maxSections = SECTIONS_PER_CALL, maxChars = SECTION_CHARS_PER_CALL): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  for (const s of sections) {
    if (s.mode !== "llm") continue;
    if (cur.length > 0 && (cur.length + 1 > maxSections || chars + s.text.length > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(s.num);
    chars += s.text.length;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

export interface TranscriptPlanInput {
  segments: TranscriptSegment[] | TimedSegment[];
  /** Alt note id (the hash rule's fallback for an empty text). */
  sourceId: string;
  /** Previous note's sections; reuse needs the same transcript hash and a stored gist. */
  existing?: ExistingSection[];
  /** Reuse unchanged sections (setting "바뀐 슬라이드만 다시 생성"). */
  reuse?: boolean;
  capChars?: number;
}

export async function planTranscript(input: TranscriptPlanInput): Promise<TranscriptPlan> {
  const { sections: texts, timed, durationMs } = await transcriptSections(input.segments, input.sourceId, input.capChars ?? SECTION_CAP_CHARS);
  const pool = new Map<string, ExistingSection[]>();
  for (const e of input.existing ?? []) {
    if (!pool.has(e.hash)) pool.set(e.hash, []);
    pool.get(e.hash)!.push(e);
  }
  const used = new Set<ExistingSection>();
  let before = 0;
  let after = 0;
  const sections: PlannedSection[] = texts.map((t) => {
    const base = { num: t.num, hash: t.hash, startMs: t.startMs, endMs: t.endMs, text: t.text, rawChars: t.raw.length };
    const prev = pool.get(t.hash)?.shift();
    if (prev) used.add(prev);
    // Reused only when the section also starts at the same second: its summary cites times.
    const sameStart = prev?.startMs == null || t.startMs === null || Math.floor(t.startMs / 1000) * 1000 === prev.startMs;
    if (prev && prev.gist && sameStart && input.reuse !== false) {
      return { ...base, text: "", mode: "reuse", reused: { body: prev.body, gist: prev.gist } };
    }
    before += t.raw.length;
    after += t.text.length;
    return { ...base, mode: "llm", previous: prev };
  });
  // LLM sections without a hash match fall back to the unused section with the same number.
  for (const s of sections) {
    if (s.mode !== "llm" || s.previous) continue;
    const byNum = (input.existing ?? []).find((e) => !used.has(e) && e.num === s.num);
    if (byNum) {
      used.add(byNum);
      s.previous = byNum;
    }
  }
  return { sections, batches: makeSectionBatches(sections), timed, durationMs, transcriptChars: { before, after } };
}

/**
 * The sections a lecture without slides is verified against (spec 4.10):
 * the note's own sections (their headings carry the times, their meta the
 * gists), so evidence links point at headings the user sees. A note
 * without timed section headings (an older lecture-level note) gets the
 * split an import would make, with no heading links.
 */
export function verifySectionsFromNote(noteContent: string, segments: TimedSegment[]): VerifySection[] {
  const fromNote: VerifySection[] = [];
  for (const s of splitSectionNote(noteContent).sections) {
    const h = s.heading ? parseSectionHeading(s.heading) : null;
    if (!h || h.startMs === null || h.endMs === null) {
      fromNote.length = 0;
      break;
    }
    fromNote.push({ num: s.num, startMs: h.startMs, endMs: h.endMs, heading: h.text, gist: parseSlideMeta(s.managed)?.gist ?? "" });
  }
  if (fromNote.length > 0) return fromNote;
  return splitTranscriptSections(segments)
    .spans.filter((sp) => sp.startMs !== null && sp.endMs !== null)
    .map((sp) => ({ num: sp.num, startMs: sp.startMs as number, endMs: sp.endMs as number, heading: null, gist: "" }));
}
