// Lecture brief (2.1.0 spec 4): a short file per lecture that the question
// panel sends in place of the whole lecture (overview, flow, one line per
// slide with its transcript times, key concepts). Pure module (no obsidian
// import), shared with the Skill CLI.
//
//   ---
//   alt2obs_brief: 1
//   lecture: "<note path>"   subject, lecture_alt_local_id, kind
//   source_hash: "<8 hex>"   what the script part was built from
//   ai_hash: ""              input of the AI part ("" without one)
//   ai_part: {status: "none"}
//   body_hash: "<8 hex>"     the body as the plugin wrote it
//   built: "YYYY-MM-DD"      size_tokens
//   ---
//   # <lecture> brief
//   ## 개요 / ## 흐름 / ## 슬라이드 지도 (구간 지도) / ## 핵심 개념
//   ## 강조점 / ## 강의 중 질문 / ## 헷갈리기 쉬운 점      (AI part)
//
// The script part costs no tokens and is rebuilt whenever the note's source
// changes; the AI part (phase 2) is carried over as it is. A body whose hash
// is not `body_hash` was edited by the user and is never overwritten without
// the user's say. The subject brief lists the subject's lectures, one line
// each, assembled from the lecture briefs (no tokens).

import { estimateTextTokens } from "../core/budget/estimate";
import { toLf } from "../core/merge";
import { parseAlignment, spansForSlide, StoredSpan } from "../core/prep/TranscriptAligner";
import { formatClock } from "../core/sections";
import { shortHash } from "../core/slideHash";
import { stemOf, subjectFolderOfNote } from "../vault/layout";
import { bodyOf, commentaryText, firstSentence, fmString, isBriefFrontmatter, LectureNoteKind, NoteUnit, parseLectureNote, readFrontmatter, unwrapWikilinks } from "./lectureNote";

/** Brief format version: part of `source_hash`, so a new format rebuilds every brief once. */
export const BRIEF_FORMAT_VERSION = 1;
/** Body size (estimateTextTokens) above which the slide map's gists are cut (spec 4.2). */
export const BRIEF_TOKEN_CAP = 4000;
/** A slide without a gist: the first sentence of its commentary, cut to this. */
const FALLBACK_GIST_CHARS = 70;
/** Gists of a brief over the cap. */
const SHORT_GIST_CHARS = 40;
/** A lecture-level note without an overview block: this much of its managed block. */
const LECTURE_HEAD_CHARS = 1500;
/** The subject brief's line per lecture when the AI part gave none. */
const ONE_LINE_CHARS = 100;

/** Section titles of the AI part, in order (spec 4.2). */
export const AI_SECTIONS = ["강조점", "강의 중 질문", "헷갈리기 쉬운 점"];

/** One line of the slide (or section) map. */
export interface MapEntry {
  num: number;
  /** "[26:26~28:38]", "[28:38~28:59?]" when the alignment is uncertain, "" without times. */
  range: string;
  text: string;
}

/** The script part of a brief, built from the note alone (no tokens). */
export interface BriefScript {
  lecture: string;
  stem: string;
  subject: string;
  altLocalId: string;
  kind: LectureNoteKind;
  sourceHash: string;
  overview: string;
  flow: string;
  concepts: string;
  map: MapEntry[];
}

/** A lecture note's subject: its frontmatter `subject`, else the name of its subject folder. */
export function subjectOfNote(notePath: string, fm: Record<string, unknown>): string {
  return fmString(fm, "subject") || subjectFolderOfNote(notePath).split("/").pop() || "";
}

function cut(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? chars.slice(0, max).join("").trim() : text.trim();
}

/**
 * The overview block's three parts (### 개요, ### 핵심 개념, ### 흐름 after
 * the overview's headings were demoted; ## also read). An overview without
 * those headings is all 개요.
 */
function overviewParts(overview: string): { overview: string; flow: string; concepts: string } {
  const parts: Record<string, string[]> = { 개요: [], 흐름: [], "핵심 개념": [] };
  let current: string[] | null = null;
  let known = false;
  for (const line of toLf(overview).split("\n")) {
    const h = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (h) {
      current = parts[h[1]] ?? null;
      if (current) known = true;
      continue;
    }
    current?.push(line);
  }
  if (!known) return { overview: cut(overview, LECTURE_HEAD_CHARS), flow: "", concepts: "" };
  const text = (k: string) => parts[k].join("\n").trim();
  return { overview: text("개요"), flow: text("흐름"), concepts: text("핵심 개념") };
}

/** "[26:26~28:38]" from a slide's aligned spans (first start, last end), with "?" when one is uncertain; "" without spans. */
export function alignedRange(spans: StoredSpan[]): string {
  if (spans.length === 0) return "";
  const low = spans.some((s) => s.low) ? "?" : "";
  return `[${formatClock(spans[0].startMs)}~${formatClock(spans[spans.length - 1].endMs)}${low}]`;
}

function unitRange(kind: LectureNoteKind, u: NoteUnit, alignment: StoredSpan[]): string {
  if (kind === "slides") return alignedRange(spansForSlide(alignment, u.num));
  return u.startMs !== null && u.endMs !== null ? `[${formatClock(u.startMs)}~${formatClock(u.endMs)}]` : "";
}

function mapLine(kind: LectureNoteKind, e: MapEntry, maxChars: number | null): string {
  const text = maxChars === null ? e.text : cut(e.text, maxChars);
  return `- ${kind === "transcript" ? "구간 " : ""}${e.num}${e.range ? ` ${e.range}` : ""} ${text}`;
}

/** The script part of a lecture note's brief (spec 4.2), with its `source_hash` (spec 4.3). */
export async function buildBriefScript(notePath: string, noteText: string): Promise<BriefScript> {
  const parts = parseLectureNote(noteText);
  const fm = parts.frontmatter;
  const alignmentValue = fmString(fm, "alt_alignment");
  const alignment = parseAlignment(alignmentValue);
  let ov = { overview: "", flow: "", concepts: "" };
  if (parts.overview) ov = overviewParts(unwrapWikilinks(parts.overview));
  else if (parts.kind === "lecture") ov.overview = cut(unwrapWikilinks(parts.managed), LECTURE_HEAD_CHARS);
  // A lecture-level note: overview and key concepts only (spec 4.2).
  if (parts.kind === "lecture") ov.flow = "";
  const map: MapEntry[] = parts.units
    .map((u) => ({
      num: u.num,
      range: unitRange(parts.kind, u, alignment),
      text: (u.gist !== null ? unwrapWikilinks(u.gist) : firstSentence(commentaryText(u.managed), FALLBACK_GIST_CHARS)).replace(/\s+/g, " ").trim(),
    }))
    .filter((e) => e.text.length > 0);
  const source = [
    `alt2obs_brief:${BRIEF_FORMAT_VERSION}`,
    parts.kind,
    parts.units.map((u) => `${u.num}:${u.hash}`).join(" "),
    parts.overview ?? parts.managed,
    map.map((e) => mapLine(parts.kind, e, null)).join("\n"),
    alignmentValue,
  ].join("\n");
  return {
    lecture: notePath,
    stem: stemOf(notePath),
    subject: subjectOfNote(notePath, fm),
    altLocalId: fmString(fm, "alt_local_id"),
    kind: parts.kind,
    sourceHash: await shortHash(source),
    ...ov,
    map,
  };
}

/** The brief body: title, script sections, then the AI sections (empty sections left out). */
export function renderBriefBody(script: BriefScript, aiSections: string, gistChars: number | null): string {
  const section = (title: string, content: string) => (content.trim() ? `## ${title}\n${content.trim()}` : "");
  const mapTitle = script.kind === "transcript" ? "구간 지도" : "슬라이드 지도";
  return (
    [
      `# ${script.stem} brief`,
      section("개요", script.overview),
      section("흐름", script.flow),
      section(mapTitle, script.map.map((e) => mapLine(script.kind, e, gistChars)).join("\n")),
      section("핵심 개념", script.concepts),
      aiSections.trim(),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

/** Body hash as written to `body_hash`: LF line ends, trailing white space ignored. */
export async function briefBodyHash(body: string): Promise<string> {
  return shortHash(toLf(body).replace(/\s+$/, ""));
}

/** The AI sections of a brief body (from the first AI heading to the end), "" when there are none. */
export function aiSectionsOf(body: string): string {
  const m = toLf(body).match(new RegExp(`^## (?:${AI_SECTIONS.join("|")})\\s*$`, "m"));
  return m && m.index !== undefined ? toLf(body).slice(m.index).trim() : "";
}

/** The AI part carried into a new brief: its sections and frontmatter values as they were. */
export interface CarriedAi {
  sections: string;
  /** `ai_hash` ("" without an AI part). */
  hash: string;
  /** `ai_part` as written, e.g. `{status: "ok", model: "claude-haiku-5-5", input: 4120, output: 760}`. */
  part: string;
}

const NO_AI_PART = '{status: "none"}';

/** The whole brief file. Over the size cap the slide map's gists are cut to 40 characters (spec 4.2). */
export async function composeBrief(script: BriefScript, ai: CarriedAi | null, today: string): Promise<string> {
  const sections = ai?.sections ?? "";
  let body = renderBriefBody(script, sections, null);
  if (estimateTextTokens(body) > BRIEF_TOKEN_CAP) body = renderBriefBody(script, sections, SHORT_GIST_CHARS);
  const lines = [
    "---",
    "alt2obs_brief: 1",
    `lecture: ${JSON.stringify(script.lecture)}`,
    `subject: ${JSON.stringify(script.subject)}`,
    // Never `alt_local_id`: that key finds the lecture note (imports, the Skill's lookup, Dataview).
    `lecture_alt_local_id: ${JSON.stringify(script.altLocalId)}`,
    `kind: ${JSON.stringify(script.kind)}`,
    `source_hash: ${JSON.stringify(script.sourceHash)}`,
    `ai_hash: ${JSON.stringify(ai?.hash ?? "")}`,
    `ai_part: ${ai?.part || NO_AI_PART}`,
    `body_hash: ${JSON.stringify(await briefBodyHash(body))}`,
    `built: ${JSON.stringify(today)}`,
    `size_tokens: ${estimateTextTokens(body)}`,
    "---",
  ];
  return `${lines.join("\n")}\n${body}`;
}

/** True when the body is not what the plugin wrote (or the file is not a brief at all). */
export async function isEditedBrief(text: string): Promise<boolean> {
  const fm = readFrontmatter(text);
  return !isBriefFrontmatter(fm) || (await briefBodyHash(bodyOf(text))) !== fmString(fm, "body_hash");
}

/**
 * State of a lecture's brief against its note (spec 4.4, 5.6):
 * - missing: no file;
 * - ok: built from the note as it is now;
 * - outdated: the note changed since, the brief is the plugin's (rebuilt without asking);
 * - edited: the user changed the brief, the note did not change since;
 * - edited-stale: the user changed the brief and the note changed since.
 */
export type BriefStatus = "missing" | "ok" | "outdated" | "edited" | "edited-stale";

export async function briefStatus(existing: string | null, script: BriefScript): Promise<BriefStatus> {
  if (existing === null) return "missing";
  const same = fmString(readFrontmatter(existing), "source_hash") === script.sourceHash;
  if (await isEditedBrief(existing)) return same ? "edited" : "edited-stale";
  return same ? "ok" : "outdated";
}

export type BriefDecision = { action: "write"; text: string } | { action: "keep"; reason: "same" | "edited" };

/**
 * What a build does with the existing file (spec 4.4): a new brief; nothing
 * when the source did not change; the script part again with the old AI
 * sections when it did; nothing for a brief the user edited. `force` (the
 * user asked to rebuild) writes in every case; an edited brief's AI
 * sections are not carried then (they are the user's text). Otherwise the
 * AI part's frontmatter (ai_hash, ai_part) is carried even without
 * sections, so an AI part with nothing to say or a failed one is not made
 * again for nothing.
 */
export async function planBriefUpdate(existing: string | null, script: BriefScript, opts: { today: string; force?: boolean }): Promise<BriefDecision> {
  if (existing === null) return { action: "write", text: await composeBrief(script, null, opts.today) };
  const edited = await isEditedBrief(existing);
  if (edited && !opts.force) return { action: "keep", reason: "edited" };
  const fm = readFrontmatter(existing);
  if (!opts.force && fmString(fm, "source_hash") === script.sourceHash) return { action: "keep", reason: "same" };
  // The AI part goes along as it is (sections, hash and status, even an empty or failed one), unless the user edited the brief.
  const ai: CarriedAi | null = edited ? null : { sections: aiSectionsOf(bodyOf(existing)), hash: fmString(fm, "ai_hash"), part: fmString(fm, "ai_part") };
  return { action: "write", text: await composeBrief(script, ai, opts.today) };
}

/** What the question panel sends of a brief: the body without the frontmatter and the `# ... brief` title (spec 6.1). */
export function briefChatBody(text: string): string {
  return bodyOf(text).replace(/^\s*# [^\n]*\n+/, "").trim();
}

/** A section's text in a brief body ("" when it is not there). */
export function briefSection(body: string, title: string): string {
  const lines = toLf(body).split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

// ---- lecture order (subject brief, previous and next lecture) ----

/**
 * Lectures in course order: by `alt_created` when every one has it, else
 * by name in natural order (L2 before L10), as spec 4.2 says.
 */
export function orderLectures<T extends { name: string; altCreated?: string }>(lectures: T[]): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, "ko", { numeric: true });
  const dated = lectures.every((l) => !!l.altCreated);
  return [...lectures].sort((a, b) => (dated ? (a.altCreated ?? "").localeCompare(b.altCreated ?? "") || byName(a, b) : byName(a, b)));
}

/** The lectures before and after one (by name) in that order; null at either end. */
export function neighbourLectures(name: string, lectures: Array<{ name: string; altCreated?: string }>): { prev: string | null; next: string | null } {
  const order = orderLectures(lectures).map((l) => l.name);
  const i = order.indexOf(name);
  if (i < 0) return { prev: null, next: null };
  return { prev: i > 0 ? order[i - 1] : null, next: i + 1 < order.length ? order[i + 1] : null };
}

// ---- subject brief (spec 4.4) ----

export interface SubjectBriefEntry {
  name: string;
  /** alt_created, else the note's date (YYYY-MM-DD), "" when neither. */
  date: string;
  altCreated?: string;
  kind: LectureNoteKind;
  /** Slides or sections of the note. */
  count: number;
  oneLine: string;
}

/** A lecture's line in the subject brief: the AI part's `one_line`, else the first sentence of its 개요 (100 characters). */
export function oneLineOf(briefText: string): string {
  const own = fmString(readFrontmatter(briefText), "one_line");
  return own || firstSentence(briefSection(bodyOf(briefText), "개요"), ONE_LINE_CHARS);
}

export function subjectBriefBody(subject: string, entries: SubjectBriefEntry[]): string {
  const lines = orderLectures(entries).map((e) => {
    const unit = e.kind === "slides" ? `슬라이드 ${e.count}장` : e.kind === "transcript" ? `구간 ${e.count}개` : "";
    const facts = [e.date, unit].filter(Boolean).join(", ");
    return `- ${e.name}${facts ? ` (${facts})` : ""}${e.oneLine ? `: ${e.oneLine}` : ""}`;
  });
  return `# ${subject} subject brief\n\n${lines.join("\n")}\n`;
}

/** The subject brief file: written when its lines changed, never over the user's edits. */
export async function planSubjectBriefUpdate(existing: string | null, subject: string, entries: SubjectBriefEntry[], today: string): Promise<BriefDecision> {
  const body = subjectBriefBody(subject, entries);
  if (existing !== null) {
    const fm = readFrontmatter(existing);
    const old = bodyOf(existing);
    if (fm.alt2obs_subject_brief === undefined || (await briefBodyHash(old)) !== fmString(fm, "body_hash")) return { action: "keep", reason: "edited" };
    if (toLf(old).trim() === body.trim()) return { action: "keep", reason: "same" };
  }
  const lines = ["---", "alt2obs_subject_brief: 1", `subject: ${JSON.stringify(subject)}`, `body_hash: ${JSON.stringify(await briefBodyHash(body))}`, `built: ${JSON.stringify(today)}`, "---"];
  return { action: "write", text: `${lines.join("\n")}\n${body}` };
}
