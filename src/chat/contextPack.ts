// What one question sends (2.1.0 spec 6): the material pack, the earlier
// conversation folded to a budget, and the estimate. Pure module (no
// obsidian import), unit-tested in Node.
//
// System prompt (the same bytes for every question of a lecture, so the
// CLI's prompt cache serves it from the second question on):
//   <prompts/chat.system.md>
//
//   [강의 브리프: CSED423 · L5 (앞 강의: L4, 다음 강의: L6)]
//   <brief body>
//   [과목 브리프: ...] / [다른 강의 브리프: ...]       (when added)
// User message, in this order, each block only when it has content:
//   [이전 대화]  [이번 자료]  [선택한 글]  [질문]
//
// The focus is a list of units (a slide or a transcript section of some
// lecture), so several slides, other lectures and sections fit without a
// new shape; what each unit carries is decided by the caller (the chips).

import { estimateTextTokens, PROVIDER_COSTS } from "../core/budget/estimate";
import { segmentInSpan, StoredSpan } from "../core/prep/TranscriptAligner";
import { collapseRepeats, contentTokens, dedupeSentences, removeFillers, splitSentences } from "../core/prep/TranscriptCompressor";
import { formatClock } from "../core/sections";
import { EFFORT_OUTPUT_FACTOR } from "../settings/llmSettings";
import type { EffortLevel, ProviderId } from "../types";

/** A transcript line holds the segments of at most this long a stretch... */
export const TRANSCRIPT_LINE_MS = 30_000;
/** ...or about this many characters (spec 6.2). */
export const TRANSCRIPT_LINE_CHARS = 200;
/** Transcript cap of a transcript section (a slide uses the setting "슬라이드당 전사 상한"). */
export const SECTION_TRANSCRIPT_CAP = 1500;
/** Earlier turns past this many tokens are folded (spec 6.3). */
export const HISTORY_TOKEN_CAP = 3000;
/** Output a question is expected to take at medium effort (only for the cap check, spec 6.4). */
export const CHAT_OUTPUT_TOKENS = 800;
/** A PDF page with less text than this (whitespace removed) is sent as an image (spec 6.2). */
export const TEXTLESS_PAGE_CHARS = 40;
const FOLDED_QUESTION_CHARS = 80;
const FOLDED_ANSWER_CHARS = 120;

export interface TimedText {
  startMs: number;
  endMs: number;
  text: string;
}

/** One `[mm:ss] ...` line of transcript. */
export interface TranscriptLine {
  startMs: number;
  text: string;
}

/** The segments that start inside any of the spans (a slide's aligned stretches), in time order. */
export function segmentsInSpans(segments: TimedText[], spans: StoredSpan[]): TimedText[] {
  return segments.filter((seg) => spans.some((s) => segmentInSpan(seg.startMs, s))).sort((a, b) => a.startMs - b.startMs);
}

function sentenceKey(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[\s,.!?…"'`]+/g, "");
}

/**
 * A unit's transcript as lines (spec 6.2): segments grouped by 30 seconds or
 * 200 characters, each line cleaned of fillers and repeats and of sentences
 * an earlier line already holds. Over `capChars` the lines that share the
 * most words with `priorityText` (the slide text and the question) stay,
 * shown in time order.
 */
export function transcriptLines(segments: TimedText[], capChars: number, priorityText: string): TranscriptLine[] {
  const groups: TranscriptLine[] = [];
  let current: TranscriptLine | null = null;
  for (const seg of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (!current || seg.startMs - current.startMs >= TRANSCRIPT_LINE_MS || current.text.length >= TRANSCRIPT_LINE_CHARS) {
      current = { startMs: seg.startMs, text: seg.text.trim() };
      groups.push(current);
    } else current.text += ` ${seg.text.trim()}`;
  }
  const seen = new Set<string>();
  const lines: TranscriptLine[] = [];
  for (const g of groups) {
    const kept = dedupeSentences(splitSentences(collapseRepeats(removeFillers(g.text)))).filter((s) => {
      const key = sentenceKey(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (kept.length > 0) lines.push({ startMs: g.startMs, text: kept.join(" ") });
  }
  const size = (l: TranscriptLine) => l.text.length + formatClock(l.startMs).length + 3;
  if (lines.reduce((n, l) => n + size(l), 0) <= capChars) return lines;
  const terms = contentTokens(priorityText);
  const ranked = lines
    .map((l, i) => {
      let score = 0;
      for (const t of contentTokens(l.text)) if (terms.has(t)) score++;
      return { l, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const keep = new Set<number>();
  let used = 0;
  for (const r of ranked) {
    if (used + size(r.l) > capChars) continue;
    keep.add(r.i);
    used += size(r.l);
  }
  return lines.filter((_, i) => keep.has(i));
}

export function formatTranscriptLines(lines: TranscriptLine[]): string {
  return lines.map((l) => `[${formatClock(l.startMs)}] ${l.text}`).join("\n");
}

/** One slide (or transcript section) of the material, with what the chips let through. */
export interface FocusUnit {
  /** Its lecture's name (note stem). */
  lecture: string;
  unit: "slide" | "section";
  num: number;
  /** "[29:06~35:56]" or "". */
  range: string;
  /** The page text ("" when not sent). */
  slideText: string;
  /** A page without a text layer is sent as an image instead. */
  imageAttached: boolean;
  /** The commentary (slide) or the section summary. */
  commentary: string;
  memo: string;
  transcript: TranscriptLine[];
}

/** A finished earlier turn of the thread. */
export interface HistoryTurn {
  /** What it was asked about, e.g. "슬라이드 17 기준" ("" for none). */
  label: string;
  question: string;
  answer: string;
}

export interface ChatPackInput {
  /** prompts/chat.system.md */
  instructions: string;
  subject: string;
  lecture: string;
  neighbours: { prev: string | null; next: string | null };
  /** The brief body (no frontmatter, no title); null when there is none or it is off. */
  brief: string | null;
  /** The subject brief and other lectures' briefs, after the brief (spec 6.2). */
  extraBriefs: Array<{ title: string; body: string }>;
  history: HistoryTurn[];
  focus: FocusUnit[];
  /** Text the user selected in the note, null when none. */
  quote: string | null;
  question: string;
}

export interface ChatPack {
  system: string;
  user: string;
  /** Earlier turns shortened to one line (dropped ones included). */
  folded: number;
  /** Folded turns dropped as well. */
  dropped: number;
}

function lectureLabel(subject: string, lecture: string): string {
  return subject ? `${subject} · ${lecture}` : lecture;
}

/** "[강의 브리프: CSED423 · L5 (앞 강의: L4, 다음 강의: L6)]", or "[강의: CSED423 · L5 (브리프 없음)]" without a brief. */
export function briefHeader(subject: string, lecture: string, neighbours: { prev: string | null; next: string | null }, hasBrief: boolean): string {
  const label = lectureLabel(subject, lecture);
  if (!hasBrief) return `[강의: ${label} (브리프 없음)]`;
  const around = [neighbours.prev ? `앞 강의: ${neighbours.prev}` : "", neighbours.next ? `다음 강의: ${neighbours.next}` : ""].filter(Boolean).join(", ");
  return `[강의 브리프: ${label}${around ? ` (${around})` : ""}]`;
}

/** The system prompt: instructions, then the brief (or the one line without it), then any extra briefs. */
export function buildSystemPrompt(input: Pick<ChatPackInput, "instructions" | "subject" | "lecture" | "neighbours" | "brief" | "extraBriefs">): string {
  const brief = input.brief?.trim() ?? "";
  const blocks = [input.instructions.trim(), brief ? `${briefHeader(input.subject, input.lecture, input.neighbours, true)}\n${brief}` : briefHeader(input.subject, input.lecture, input.neighbours, false)];
  for (const extra of input.extraBriefs) if (extra.body.trim()) blocks.push(`[${extra.title}]\n${extra.body.trim()}`);
  return blocks.join("\n\n");
}

/**
 * Slide text in a `text` fence (spec 6.2), so a page line starting with
 * `#` is not read as a heading of the pack; the fence is longer than any
 * backtick run in the text.
 */
export function fencedText(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** "## L5 · 슬라이드 17 [29:06~35:56]" with its parts (spec 6.2). */
export function renderFocusUnit(u: FocusUnit): string {
  const slide = u.unit === "slide";
  const parts = [`## ${u.lecture} · ${slide ? "슬라이드" : "구간"} ${u.num}${u.range ? ` ${u.range}` : ""}`];
  if (slide && u.imageAttached) parts.push("### 슬라이드 글\n(글이 없는 페이지라 이미지를 함께 보냄)");
  else if (slide && u.slideText.trim()) parts.push(`### 슬라이드 글\n${fencedText(u.slideText.trim())}`);
  if (u.commentary.trim()) parts.push(`### ${slide ? "해설" : "요약"}\n${u.commentary.trim()}`);
  if (u.memo.trim()) parts.push(`### 내 메모\n${u.memo.trim()}`);
  if (u.transcript.length > 0) parts.push(`### 전사\n${formatTranscriptLines(u.transcript)}`);
  return parts.join("\n");
}

function historyEntry(t: HistoryTurn): string {
  return `Q${t.label ? ` (${t.label})` : ""}: ${t.question.trim()}\nA: ${t.answer.trim()}`;
}

function firstAnswerSentence(answer: string): string {
  const plain = answer.replace(/\s+/g, " ").trim();
  const end = plain.search(/[.!?](?=\s|$)/);
  return end >= 0 ? plain.slice(0, end + 1) : plain;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}

/**
 * Earlier turns within `cap` tokens (spec 6.3): past the cap the oldest
 * turns become one line each (`Q: <80> → A: <first sentence, 120>`), oldest
 * first; still past it, the oldest one-liners are dropped.
 */
export function foldHistory(turns: HistoryTurn[], cap = HISTORY_TOKEN_CAP): { entries: string[]; folded: number; dropped: number } {
  const entries = turns.map(historyEntry);
  const total = () => estimateTextTokens(entries.join("\n\n"));
  let folded = 0;
  while (total() > cap && folded < turns.length) {
    const t = turns[folded];
    entries[folded] = `Q: ${clip(t.question, FOLDED_QUESTION_CHARS)} → A: ${clip(firstAnswerSentence(t.answer), FOLDED_ANSWER_CHARS)}`;
    folded++;
  }
  let dropped = 0;
  while (total() > cap && entries.length > 0) {
    entries.shift();
    dropped++;
  }
  return { entries, folded, dropped };
}

export function buildChatPack(input: ChatPackInput): ChatPack {
  const history = foldHistory(input.history);
  const blocks: string[] = [];
  if (history.entries.length > 0) blocks.push(`[이전 대화]\n${history.entries.join("\n\n")}`);
  if (input.focus.length > 0) blocks.push(`[이번 자료]\n${input.focus.map(renderFocusUnit).join("\n\n")}`);
  const quote = input.quote?.trim();
  if (quote) blocks.push(`[선택한 글]\n${quote.split("\n").map((l) => `> ${l}`).join("\n")}`);
  blocks.push(`[질문]\n${input.question.trim()}`);
  return { system: buildSystemPrompt(input), user: blocks.join("\n\n"), folded: history.folded, dropped: history.dropped };
}

export interface ChatEstimate {
  /** Input tokens: the text, the CLI's own per-call tokens, the images. */
  input: number;
  /** Output for the cap check: 800 times the effort factor. */
  output: number;
  /** The part a repeated question reads from the prompt cache (Claude: the system prompt), else 0. */
  cached: number;
}

/** The estimate of spec 6.4. */
export function estimateChat(pack: Pick<ChatPack, "system" | "user">, provider: ProviderId, effort: EffortLevel, images: number): ChatEstimate {
  const costs = PROVIDER_COSTS[provider];
  return {
    input: estimateTextTokens(`${pack.system}\n\n${pack.user}`) + costs.fixedPerTurn + images * costs.perImage,
    output: Math.round(CHAT_OUTPUT_TOKENS * EFFORT_OUTPUT_FACTOR[effort]),
    cached: provider === "claude-cli" ? estimateTextTokens(pack.system) : 0,
  };
}

/**
 * Slide numbers typed as "14-18, 23" (or "14~18"): in order, without
 * repeats; numbers outside 1..`max` are left out and listed in `ignored`.
 */
export function parseSlideRange(text: string, max: number): { slides: number[]; ignored: number[] } {
  const slides = new Set<number>();
  const ignored = new Set<number>();
  const add = (n: number) => (n >= 1 && n <= max ? slides.add(n) : ignored.add(n));
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)[-~](\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let n = a; n <= b && n - a < 1000; n++) add(n);
    } else if (/^\d+$/.test(part)) add(Number(part));
  }
  return { slides: [...slides].sort((a, b) => a - b), ignored: [...ignored].sort((a, b) => a - b) };
}

/** Words of a question about other lectures: `L4`, `3강`, `lec 3`, "지난 강의", "이전 강의", "다른 강의", "몇 강" (spec 5.10). */
const OTHER_LECTURE_WORDS = [/L\d+/, /\d+\s*강/, /lec\s*\d+/i, /(?:지난|이전|다른)\s*강의/, /몇\s*강/];

/** The question asks about other lectures: the panel offers the subject brief once before sending it (spec 5.10). */
export function suggestsSubjectBrief(question: string): boolean {
  return OTHER_LECTURE_WORDS.some((re) => re.test(question));
}

/** "슬라이드 17 기준", "슬라이드 17, 18 기준", "강의 브리프 기준", or "" (what a question was asked about). */
export function materialLabel(focus: Array<Pick<FocusUnit, "unit" | "num">>, withBrief: boolean): string {
  if (focus.length > 0) return `${focus[0].unit === "slide" ? "슬라이드" : "구간"} ${focus.map((u) => u.num).join(", ")} 기준`;
  return withBrief ? "강의 브리프 기준" : "";
}
