// The lecture brief's AI part (2.1.0 spec 4.5): what the professor
// stressed, questions asked in class and points easy to confuse, plus one
// line for the subject brief. One light-model call per lecture over
// candidate sentences a script picked from the transcript (no tokens to
// pick them); no candidates, no call. The answer is checked by the script
// before it reaches the vault: times within the lecture, slides within the
// deck, nothing that copies the transcript (spec C7: no verbatim
// transcript in the vault). Pure: no obsidian import, shared with the
// Skill CLI.

import { segmentInSpan, StoredSpan } from "../core/prep/TranscriptAligner";
import { collapseRepeats, dedupeSentences, removeFillers, splitSentences } from "../core/prep/TranscriptCompressor";
import { formatClock, parseClock } from "../core/sections";
import { shortHash } from "../core/slideHash";
import { renderPrompt } from "../prompts/render";
import type { TimedText } from "../chat/contextPack";
import type { LectureNoteKind } from "./lectureNote";
import type { MapEntry } from "./lectureBrief";
import systemTemplate from "../../prompts/lecture-brief.system.md";
import userTemplate from "../../prompts/lecture-brief.user.md";

/** Words that mark a sentence the professor may have stressed (spec 4.5). */
export const CANDIDATE_WORDS = /시험|중요|꼭|반드시|기억|헷갈|주의|실수|질문|퀴즈|과제|숙제|exam|quiz|important|remember|homework|assignment|midterm|final/i;
/** Candidate text sent at most. */
export const CANDIDATE_CAP_CHARS = 3000;
/** A merged stretch longer than this starts a new one (its own time), so one long stretch never fills the cap. */
const STRETCH_MAX_CHARS = 400;
/** Expected output of the call at medium effort (the estimate, spec 4.5). */
export const BRIEF_AI_OUTPUT_TOKENS = 800;
/** A quoted span that repeats a candidate for longer than this is a copy (spec 4.5, C7). */
const COPY_LIMIT = 20;
/** So is unquoted text that repeats a candidate this long with this much Hangul in it (a shared English term is not a copy). */
const COPY_WINDOW = 40;
const COPY_WINDOW_HANGUL = 10;
/** "...", '...' (not an apostrophe inside a word), “...”, ‘...’, 「...」, 『...』. */
const QUOTED = /"([^"]*)"|(?<![A-Za-z])'([^'\n]*)'(?![A-Za-z])|“([^”]*)”|‘([^’]*)’|「([^」]*)」|『([^』]*)』/g;
const ITEM_CHARS = 100;
const ONE_LINE_CHARS = 80;
const CAPS = { emphasis: 6, qa: 4, pitfalls: 4 };

/** A stretch of the transcript worth a look: the matching sentence and its neighbours. */
export interface Candidate {
  startMs: number;
  /** The slide aligned to its time, null without an alignment. */
  slide: number | null;
  text: string;
}

export function formatCandidate(c: Candidate): string {
  return `[${formatClock(c.startMs)}]${c.slide !== null ? ` (슬라이드 ${c.slide})` : ""} ${c.text}`;
}

/**
 * Candidate sentences (spec 4.5): every sentence with a candidate word or
 * ending in a question mark, with the sentence before and after it;
 * overlapping stretches merged (up to 400 characters each), fillers and
 * repeats removed. To cover the
 * whole lecture they are taken from the front and the back in turn, and
 * the taking stops at `capChars`; they come back in time order.
 */
export function pickCandidates(segments: TimedText[], spans: StoredSpan[], capChars = CANDIDATE_CAP_CHARS): Candidate[] {
  const sentences: Array<{ startMs: number; text: string }> = [];
  for (const seg of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    for (const text of splitSentences(collapseRepeats(removeFillers(seg.text)))) sentences.push({ startMs: seg.startMs, text });
  }
  const marked = new Set<number>();
  sentences.forEach((s, i) => {
    if (!CANDIDATE_WORDS.test(s.text) && !/[?？]$/.test(s.text.trim())) return;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < sentences.length) marked.add(j);
  });
  const groups: Candidate[] = [];
  let run: Array<{ startMs: number; text: string }> = [];
  const flush = () => {
    if (run.length === 0) return;
    const startMs = run[0].startMs;
    const slide = spans.find((s) => segmentInSpan(startMs, s))?.slide ?? null;
    groups.push({ startMs, slide, text: dedupeSentences(run.map((s) => s.text)).join(" ") });
    run = [];
  };
  sentences.forEach((s, i) => {
    if (!marked.has(i)) return flush();
    if (run.length > 0 && run.reduce((n, r) => n + r.text.length + 1, 0) + s.text.length > STRETCH_MAX_CHARS) flush();
    run.push(s);
  });
  flush();
  const order: number[] = [];
  for (let lo = 0, hi = groups.length - 1; lo <= hi; ) {
    order.push(lo++);
    if (lo <= hi) order.push(hi--);
  }
  const keep = new Set<number>();
  let used = 0;
  for (const i of order) {
    const size = formatCandidate(groups[i]).length + 1;
    if (used + size > capChars) break;
    keep.add(i);
    used += size;
  }
  return groups.filter((_, i) => keep.has(i));
}

/** The prompt of the AI part and the hash of its input (`ai_hash`, spec 4.3). */
export interface BriefAiInput {
  system: string;
  user: string;
  hash: string;
  candidates: Candidate[];
  /** The candidate text as sent (the copy check reads it). */
  candidateText: string;
  /** The transcript's last end; null when unknown. */
  lengthMs: number | null;
  /** Slides (or sections) a `slide` may name. */
  units: number;
}

export interface BriefAiFacts {
  title: string;
  subject: string;
  kind: LectureNoteKind;
  /** The slide (or section) map of the script part: its gists. */
  map: MapEntry[];
  /** Slides (or sections) of the note. */
  units: number;
  transcript: TimedText[];
  /** The note's alignment (slide labels of the candidates); [] without one. */
  spans: StoredSpan[];
}

/** The AI part's input; null when the transcript has no candidate (then there is no call). */
export async function briefAiInput(f: BriefAiFacts): Promise<BriefAiInput | null> {
  const candidates = pickCandidates(f.transcript, f.spans);
  if (candidates.length === 0) return null;
  const lengthMs = f.transcript.length > 0 ? Math.max(...f.transcript.map((s) => s.endMs)) : null;
  const candidateText = candidates.map(formatCandidate).join("\n");
  const unit = f.kind === "transcript" ? "구간 " : "";
  const user = renderPrompt(userTemplate, {
    title: f.title,
    subject: f.subject || "(과목 없음)",
    duration: lengthMs !== null ? formatClock(lengthMs) : "알 수 없음",
    gists: f.map.map((e) => `${unit}${e.num}: ${e.text}`).join("\n") || "(요지 없음)",
    candidates: candidateText,
  });
  const system = renderPrompt(systemTemplate, {});
  return { system, user, hash: await shortHash(`${system}\n\n${user}`), candidates, candidateText, lengthMs, units: f.units };
}

export interface BriefAi {
  oneLine: string;
  emphasis: Array<{ t: string; slide: number | null; text: string }>;
  qa: Array<{ t: string; q: string; a: string }>;
  pitfalls: string[];
}

/** The answer format, enforced by Codex (--output-schema) and stated to Claude in the prompt. */
export const BRIEF_AI_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["one_line", "emphasis", "qa", "pitfalls"],
  properties: {
    one_line: { type: "string" },
    emphasis: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["t", "slide", "text"],
        properties: { t: { type: "string" }, slide: { type: ["integer", "null"] }, text: { type: "string" } },
      },
    },
    qa: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["t", "q", "a"],
        properties: { t: { type: "string" }, q: { type: "string" }, a: { type: "string" } },
      },
    },
    pitfalls: { type: "array", items: { type: "string" } },
  },
};

function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const chars = Array.from(v.replace(/\s+/g, " ").trim());
  return chars.slice(0, max).join("").trim();
}

/**
 * True when the text copies the candidates (spec 4.5): a quoted span in it
 * shares more than 20 identical characters with them, or a 40-character
 * stretch outside quotes holding at least 10 Hangul characters is in them
 * as it is.
 */
export function copiesCandidate(text: string, candidateText: string): boolean {
  const t = text.replace(/\s+/g, " ");
  const c = candidateText.replace(/\s+/g, " ");
  const shares = (part: string, len: number, counts: (window: string) => boolean) => {
    for (let i = 0; i + len <= part.length; i++) {
      const window = part.slice(i, i + len);
      if (counts(window) && c.includes(window)) return true;
    }
    return false;
  };
  const outside: string[] = [];
  let last = 0;
  for (const m of t.matchAll(QUOTED)) {
    const quoted = m.slice(1).find((g) => g !== undefined) ?? "";
    if (shares(quoted, COPY_LIMIT + 1, () => true)) return true;
    outside.push(t.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
  }
  outside.push(t.slice(last));
  return outside.some((part) => shares(part, COPY_WINDOW, (w) => (w.match(/[가-힣]/g) ?? []).length >= COPY_WINDOW_HANGUL));
}

/**
 * The AI answer checked (spec 4.5): an item whose time is past the lecture
 * or unreadable goes, a slide outside 1..units becomes null, an item that
 * copies the transcript goes, texts are cut to 100 characters (one_line to
 * 80) and the lists to 6, 4 and 4. Throws only when the answer is not an
 * object (the call is asked once more then).
 */
export function validateBriefAi(raw: unknown, input: Pick<BriefAiInput, "lengthMs" | "units" | "candidateText">): BriefAi {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("브리프 AI 답이 JSON 객체가 아닙니다");
  const r = raw as Record<string, unknown>;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const time = (v: unknown): string | null => {
    const ms = typeof v === "string" ? parseClock(v) : null;
    if (ms === null || (input.lengthMs !== null && ms > input.lengthMs)) return null;
    return formatClock(ms);
  };
  const ok = (...texts: string[]) => texts.every((t) => t.length > 0) && !texts.some((t) => copiesCandidate(t, input.candidateText));
  const emphasis: BriefAi["emphasis"] = [];
  for (const item of list(r.emphasis)) {
    const e = (item ?? {}) as Record<string, unknown>;
    const t = time(e.t);
    const text = clean(e.text, ITEM_CHARS);
    if (!t || !ok(text)) continue;
    const slide = typeof e.slide === "number" && Number.isInteger(e.slide) && e.slide >= 1 && e.slide <= input.units ? e.slide : null;
    emphasis.push({ t, slide, text });
  }
  const qa: BriefAi["qa"] = [];
  for (const item of list(r.qa)) {
    const e = (item ?? {}) as Record<string, unknown>;
    const t = time(e.t);
    const q = clean(e.q, ITEM_CHARS);
    const a = clean(e.a, ITEM_CHARS);
    if (t && ok(q, a)) qa.push({ t, q, a });
  }
  const pitfalls = list(r.pitfalls)
    .map((p) => clean(p, ITEM_CHARS))
    .filter((p) => ok(p));
  const oneLine = clean(r.one_line, ONE_LINE_CHARS);
  return {
    oneLine: oneLine && !copiesCandidate(oneLine, input.candidateText) ? oneLine : "",
    emphasis: emphasis.slice(0, CAPS.emphasis),
    qa: qa.slice(0, CAPS.qa),
    pitfalls: pitfalls.slice(0, CAPS.pitfalls),
  };
}

/** The three AI sections of the brief (an empty one left out, spec 4.2). */
export function renderAiSections(ai: BriefAi, kind: LectureNoteKind): string {
  const unit = kind === "transcript" ? "구간" : "슬라이드";
  const sections: string[] = [];
  if (ai.emphasis.length > 0) sections.push(`## 강조점\n${ai.emphasis.map((e) => `- [${e.t}] ${e.slide !== null ? `${unit} ${e.slide}: ` : ""}${e.text}`).join("\n")}`);
  if (ai.qa.length > 0) sections.push(`## 강의 중 질문\n${ai.qa.map((e) => `- [${e.t}] Q. ${e.q} A. ${e.a}`).join("\n")}`);
  if (ai.pitfalls.length > 0) sections.push(`## 헷갈리기 쉬운 점\n${ai.pitfalls.map((p) => `- ${p}`).join("\n")}`);
  return sections.join("\n\n");
}

export type AiPartStatus = "ok" | "failed" | "none";

/** `ai_part` as written in the frontmatter, e.g. `{status: "ok", model: "claude-haiku-5-5", input: 4120, output: 760}`. */
export function formatAiPart(status: AiPartStatus, run?: { model: string; input: number; output: number }): string {
  const fields = [`status: ${JSON.stringify(status)}`];
  if (run?.model) fields.push(`model: ${JSON.stringify(run.model)}`);
  if (run) fields.push(`input: ${run.input}`, `output: ${run.output}`);
  return `{${fields.join(", ")}}`;
}

/** The status of an `ai_part` value ("" when it is not there or not readable). */
export function aiPartStatus(part: string): string {
  return part.match(/status:\s*"?([a-z]+)"?/)?.[1] ?? "";
}
