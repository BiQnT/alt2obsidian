// "+ 자료 추가" of the question panel (2.1.0 spec 5.7): slides of this
// lecture or another one, picked from a list or typed as a range, what
// each carries, and the estimate shown before adding. Pure: no obsidian
// import, unit-tested in Node.

import { parseSlideRange } from "./contextPack";

/** Slides added besides the current one, at most (spec 5.7). */
export const MAX_ADDED_SLIDES = 8;
/** Input tokens of one slide image (1024 px JPEG, Claude, spec 5.2). */
export const IMAGE_TOKENS = 1060;
/** A slide's text not read yet counts this much in the list (rough; a send counts exactly). */
export const SLIDE_TEXT_STANDIN_TOKENS = 150;
/** Selected note text kept for a quote (spec 5.7). */
export const QUOTE_MAX_CHARS = 1500;

/** What an added slide carries (the popover's toggles). */
export interface IncludeOptions {
  slideText: boolean;
  commentary: boolean;
  transcript: boolean;
  memo: boolean;
  /** The page as an image too (about 1.1k tokens each), off by default. */
  image: boolean;
}

export const DEFAULT_INCLUDE: IncludeOptions = { slideText: true, commentary: true, transcript: true, memo: true, image: false };

/** One slide in the popover's list. */
export interface SlideRow {
  num: number;
  gist: string;
  /** "[26:26~28:38]" or "" without an alignment (a trailing "?" inside when uncertain). */
  range: string;
  /** Rough tokens of each part, for the estimate (exact again when sent). */
  tokens: { slideText: number; commentary: number; transcript: number; memo: number };
}

/** The time of a row without its brackets and "?", and whether it is uncertain. */
export function rowTime(range: string): { text: string; uncertain: boolean } {
  const m = range.match(/^\[(.*?)(\?)?\]$/);
  return m ? { text: m[1], uncertain: !!m[2] } : { text: "", uncertain: false };
}

/** Tokens of one row with these toggles. */
export function rowTokens(row: SlideRow, include: IncludeOptions): number {
  return (
    (include.slideText ? row.tokens.slideText : 0) +
    (include.commentary ? row.tokens.commentary : 0) +
    (include.transcript ? row.tokens.transcript : 0) +
    (include.memo ? row.tokens.memo : 0) +
    (include.image ? IMAGE_TOKENS : 0)
  );
}

export interface AddPlan {
  /** Slides to add, in order (the current one and those already added left out). */
  slides: number[];
  /** Typed numbers outside 1..max. */
  ignored: number[];
  /** Picked but past the 8-slide limit. */
  over: number[];
  tokens: number;
}

/**
 * What "추가" would add: the checked slides and the typed range together,
 * without the current slide (it is always there) and the slides of this
 * lecture already added, up to 8 added slides in all (`addedCount`, every
 * lecture's).
 */
export function planAddition(o: {
  rows: SlideRow[];
  checked: number[];
  range: string;
  max: number;
  current: number | null;
  alreadyAdded: number[];
  addedCount: number;
  include: IncludeOptions;
}): AddPlan {
  const typed = parseSlideRange(o.range, o.max);
  const wanted = Array.from(new Set([...o.checked, ...typed.slides]))
    .filter((n) => n !== o.current && !o.alreadyAdded.includes(n))
    .sort((a, b) => a - b);
  const room = Math.max(0, MAX_ADDED_SLIDES - o.addedCount);
  const slides = wanted.slice(0, room);
  const byNum = new Map(o.rows.map((r) => [r.num, r]));
  const tokens = slides.reduce((n, s) => n + (byNum.has(s) ? rowTokens(byNum.get(s)!, o.include) : 0), 0);
  return { slides, ignored: typed.ignored, over: wanted.slice(room), tokens };
}

/** Selected note text as a quote: trimmed, cut to 1500 characters. */
export function quoteOf(text: string): string {
  const chars = Array.from(text.replace(/\r\n?/g, "\n").trim());
  return chars.length > QUOTE_MAX_CHARS ? chars.slice(0, QUOTE_MAX_CHARS).join("") : chars.join("");
}
