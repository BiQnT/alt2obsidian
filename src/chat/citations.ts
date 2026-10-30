// Grounding marks in an answer (2.1.0 spec 5.5): `[슬라이드 N]`,
// `[슬라이드 N, M]`, `[슬라이드 N~M]`, `[구간 N]`, `[mm:ss]` / `[h:mm:ss]` and
// `(강의 자료 밖)` become chips, and `[L4 슬라이드 N]` (the same lists and
// ranges, `[L4 · 슬라이드 N]` too) for a slide of another lecture whose
// material the question sent.
// A mark that points outside its lecture (a slide past the last one, a
// time past the end plus a minute, a lecture the question did not send)
// stays text. Pure: the panel applies this to the rendered answer's text
// nodes, never inside code.

import { parseClock } from "../core/sections";

export type CitationPart =
  | { kind: "text"; text: string }
  | {
      kind: "slide";
      text: string;
      slides: number[];
      /** Another lecture's name (`[L4 슬라이드 3]`); none for this lecture. */
      lecture?: string;
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
  /** This lecture's name: `[<name> 슬라이드 N]` is a plain slide mark. */
  name?: string;
  /** Other lectures whose material the question sent, with their slide counts. */
  lectures?: Array<{ name: string; slides: number }>;
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
      const name = m[1].trim();
      const other = name === limits.name ? null : limits.lectures?.find((l) => l.name === name);
      const slides = other === undefined ? null : slideList(m[2], other ? other.slides : limits.slides);
      if (slides) part = { kind: "slide", text: m[0], slides, ...(other ? { lecture: other.name } : {}) };
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
