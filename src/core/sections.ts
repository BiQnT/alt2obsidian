// Transcript section grammar (spec 4.10, 2.0.0-beta.6): the note of a
// lecture without slides ("전사만") has one section per stretch of about 12
// minutes of the transcript instead of one per slide. Pure module (no
// obsidian import), shared by the note generator, src/core/merge.ts, the
// note verifier and the Skill CLIs.
//
//   ## ⏱ 구간 3 [24:10~36:02]
//
//   <!-- alt2obs:section:3 hash:1a2b3c4d start -->
//   <section summary>
//
//   <!-- alt2obs:meta img:none gist:"..." -->
//   <!-- alt2obs:section:3 hash:1a2b3c4d end -->
//
//   > [!note] 내 메모
//   >
//
// The hash is the slide hash rule (src/core/slideHash.ts) applied to the
// section's raw transcript text, so a section whose transcript did not
// change keeps its hash and its summary is reused on re-import. The meta
// line is the slide meta grammar (src/core/slideMeta.ts) with no image
// signal. Slide markers (`alt2obs:slide:N`) are a different grammar: a note
// has either slide sections or transcript sections.

/** Heading text of section N (without "## "). */
export const SECTION_HEADING_WORD = "⏱ 구간";

/**
 * The patterns every section regex is built from (one source for the
 * generator, the merge, the verifier and the Skill): a heading line
 * "## ⏱ 구간 N" (any text may follow), and a start or end marker with
 * groups (num, hash, kind).
 */
export const SECTION_HEADING_PATTERN = "## ⏱ 구간 (\\d+)";
export const SECTION_MARKER_PATTERN = "<!-- alt2obs:section:(\\d+) hash:([0-9a-f]{8}) (start|end) -->";

/** A new regex for the start and end markers (global: callers iterate it). */
export function sectionMarkerRegex(): RegExp {
  return new RegExp(SECTION_MARKER_PATTERN, "g");
}

/** A heading line of some section, at the start of a line (multiline). */
export function sectionHeadingLineRegex(): RegExp {
  return new RegExp(`^${SECTION_HEADING_PATTERN}[^\\n]*$`, "gm");
}

export function hasSectionMarkers(content: string): boolean {
  return new RegExp(SECTION_MARKER_PATTERN).test(content);
}

export function sectionMarker(num: number, hash: string, kind: "start" | "end"): string {
  return `<!-- alt2obs:section:${num} hash:${hash} ${kind} -->`;
}

/** "12:03", or "1:02:03" past an hour (also the verifier's `[mm:ss]`). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  const mmss = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Inverse of `formatClock` ("12:03" or "1:02:03"); null for anything else. */
export function parseClock(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return ((m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

/** "[24:10~36:02]", or "" without times (a URL transcript has none). */
export function sectionRange(startMs: number | null, endMs: number | null): string {
  if (startMs === null || endMs === null) return "";
  return `[${formatClock(startMs)}~${formatClock(endMs)}]`;
}

/** Heading text without "## ": "⏱ 구간 3 [24:10~36:02]" (plain "~", never a dash). */
export function sectionHeadingText(num: number, startMs: number | null, endMs: number | null): string {
  const range = sectionRange(startMs, endMs);
  return `${SECTION_HEADING_WORD} ${num}${range ? ` ${range}` : ""}`;
}

export interface SectionHeading {
  num: number;
  startMs: number | null;
  endMs: number | null;
  /** The heading text without "## " (with the user's own text after the range, if any). */
  text: string;
  /** What the user wrote after the generated part ("" when nothing): kept across re-imports. */
  suffix: string;
  /** Exactly the generated form, nothing written after it. */
  plain: boolean;
}

const HEADING_RE = new RegExp(`^${SECTION_HEADING_PATTERN}(?: \\[([0-9:]+)~([0-9:]+)\\])?(.*)$`);

/** A section heading line (the generated form, possibly with the user's text after it), or null. */
export function parseSectionHeading(line: string): SectionHeading | null {
  const m = line.replace(/\r$/, "").match(HEADING_RE);
  if (!m) return null;
  // "## ⏱ 구간 12" must not read as section 1 followed by "2".
  if (m[4] && !/^\s/.test(m[4])) return null;
  const startMs = m[2] ? parseClock(m[2]) : null;
  const endMs = m[3] ? parseClock(m[3]) : null;
  const suffix = m[4].trim();
  return { num: Number(m[1]), startMs, endMs, text: line.replace(/\r$/, "").replace(/^## /, "").trim(), suffix, plain: suffix === "" };
}

/**
 * The heading as a wikilink subpath. Obsidian matches a `[[note#heading]]`
 * link by stripping these characters from both sides and collapsing spaces
 * (its `stripHeading`, read from the 1.14.4 app code), so "⏱ 구간 3
 * [24:10~36:02]" is linked as "⏱ 구간 3 24 10 36 02": no `[`, `]`, `:` or
 * `|` that would break the link syntax.
 */
export function headingLinkTarget(heading: string): string {
  return heading
    .replace(/[!"#$%&()*+,.:;<=>?@^`{|}~\\/[\]\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
