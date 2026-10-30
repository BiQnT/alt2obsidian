// Grounding marks in an answer (2.1.0 spec 5.5): `[슬라이드 N]`,
// `[슬라이드 N, M]`, `[슬라이드 N~M]`, `[구간 N]`, `[mm:ss]` / `[h:mm:ss]` and
// `(강의 자료 밖)` become chips, and `[L4 슬라이드 N]` (the same lists and
// ranges, `[L4 · 슬라이드 N]` and `[CSED423 · L4 슬라이드 N]` too) for a
// slide of another lecture whose material the question sent.
// A mark that points outside its lecture (a slide past the last one, a
// time past the end plus a minute, a lecture the question did not send)
// stays text. Pure: the panel applies this to the rendered answer's text
// nodes, never inside code.

import { parseClock } from "../core/sections";
import { subjectFolderOfNote } from "../vault/layout";

/** A lecture whose material a question sent, as its `[L4 슬라이드 N]` marks need it. */
export interface CitedLecture {
  notePath: string;
  name: string;
  /** Its subject (the note's `subject`, else its subject folder's name). */
  subject: string;
  slides: number;
}

export type CitationPart =
  | { kind: "text"; text: string }
  | {
      kind: "slide";
      text: string;
      slides: number[];
      /** Another lecture (`[L4 슬라이드 3]`); none for this lecture. */
      lecture?: CitedLecture;
    }
  | { kind: "section"; text: string; num: number }
  | { kind: "time"; text: string; ms: number }
  | { kind: "outside"; text: string };

export interface CitationLimits {
  /** Slides of the lecture (0: no slide chips). */
  slides: number;
  /** Transcript sections of a summary note (0: none). */
  sections: number;
  /** Length of the lecture (transcript end, else alignment end); null when unknown (every time is kept). */
  lengthMs: number | null;
  /** This lecture's note (its subject folder wins between two sent lectures of one name). */
  notePath?: string;
  /** This lecture's name: `[<name> 슬라이드 N]` is a plain slide mark. */
  name?: string;
  /** Other lectures whose material the question sent, with their slide counts. */
  lectures?: CitedLecture[];
}

/** A time mark more than this past the lecture's end stays text. */
export const TIME_SLACK_MS = 60_000;

const SLIDES = "(\\d+(?:\\s*~\\s*\\d+)?(?:\\s*,\\s*\\d+(?:\\s*~\\s*\\d+)?)*)";
const MARK = new RegExp(`\\[([^[\\]\\n]{1,80}?)\\s+(?:·\\s*)?슬라이드\\s*${SLIDES}\\]|\\[슬라이드\\s*${SLIDES}\\]|\\[구간\\s*(\\d+)\\]|\\[((?:\\d+:)?\\d{1,2}:\\d{2})\\]|\\(강의 자료 밖\\)`, "g");

/** The slides a `[슬라이드 ...]` list names, or null when one of them is outside 1..max. */
function slideList(list: string, max: number): number[] | null {
  const out: number[] = [];
  for (const item of list.split(",")) {
    const [a, b] = item.split("~").map((x) => Number(x.trim()));
    const end = b === undefined ? a : b;
    if (!(a >= 1 && end <= max && a <= end)) return null;
    for (let n = a; n <= end; n++) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** A name's words, `·` counted as a space. */
function words(name: string): string {
  return name.split(/[\s·]+/).filter(Boolean).join(" ");
}

/**
 * The lecture the words before `슬라이드` name: the last run of them that
 * is this lecture's name (null) or a sent lecture's; undefined for none.
 * When two sent lectures have that name, the words before it that name a
 * subject (`[CSED311 L4 슬라이드 2]`) decide, then this lecture's subject
 * folder, then the order they were sent in.
 */
function citedLecture(label: string, limits: CitationLimits): CitedLecture | null | undefined {
  const w = words(label).split(" ");
  const folder = limits.notePath === undefined ? null : subjectFolderOfNote(limits.notePath);
  for (let end = w.length; end > 0; end--) {
    for (let start = 0; start < end; start++) {
      const run = w.slice(start, end).join(" ");
      if (limits.name !== undefined && words(limits.name) === run) return null;
      const named = (limits.lectures ?? []).filter((l) => words(l.name) === run);
      if (named.length === 0) continue;
      const before = ` ${w.slice(0, start).join(" ")} `.toLowerCase();
      const subjectNamed = named.filter((l) =>
        [l.subject, subjectFolderOfNote(l.notePath).split("/").pop() ?? ""].some((s) => words(s) !== "" && before.includes(` ${words(s).toLowerCase()} `))
      );
      const pool = subjectNamed.length > 0 ? subjectNamed : named;
      return pool.find((l) => subjectFolderOfNote(l.notePath) === folder) ?? pool[0];
    }
  }
  return undefined;
}

/** The text cut into plain runs and marks. */
export function parseCitations(text: string, limits: CitationLimits): CitationPart[] {
  const parts: CitationPart[] = [];
  let last = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const prev = parts[parts.length - 1];
    if (prev?.kind === "text") prev.text += t;
    else parts.push({ kind: "text", text: t });
  };
  for (const m of text.matchAll(MARK)) {
    const at = m.index ?? 0;
    pushText(text.slice(last, at));
    last = at + m[0].length;
    let part: CitationPart | null = null;
    if (m[1] !== undefined) {
      const other = citedLecture(m[1], limits);
      const slides = other === undefined ? null : slideList(m[2], other ? other.slides : limits.slides);
      if (slides) part = { kind: "slide", text: m[0], slides, ...(other ? { lecture: other } : {}) };
    } else if (m[3] !== undefined) {
      const slides = slideList(m[3], limits.slides);
      if (slides) part = { kind: "slide", text: m[0], slides };
    } else if (m[4] !== undefined) {
      const num = Number(m[4]);
      if (num >= 1 && num <= limits.sections) part = { kind: "section", text: m[0], num };
    } else if (m[5] !== undefined) {
      const ms = parseClock(m[5]);
      if (ms !== null && (limits.lengthMs === null || ms <= limits.lengthMs + TIME_SLACK_MS)) part = { kind: "time", text: m[0], ms };
    } else part = { kind: "outside", text: m[0] };
    if (part) parts.push(part);
    else pushText(m[0]);
  }
  pushText(text.slice(last));
  return parts;
}
