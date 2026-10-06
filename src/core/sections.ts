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
export const SECTION_HEADING_PREFIX = `## ${SECTION_HEADING_WORD}`;

/** Start and end markers of a section's managed block. */
export const SECTION_MARKER_RE = /<!-- alt2obs:section:(\d+) hash:([0-9a-f]{8}) (start|end) -->/g;

export function hasSectionMarkers(content: string): boolean {
  return /<!-- alt2obs:section:\d+ hash:[0-9a-f]{8} (start|end) -->/.test(content);
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
  /** The heading text without "## ". */
  text: string;
}

const HEADING_RE = /^## ⏱ 구간 (\d+)(?: \[([0-9:]+)~([0-9:]+)\])?[ \t]*$/;

/** A section heading line, or null. */
export function parseSectionHeading(line: string): SectionHeading | null {
  const m = line.match(HEADING_RE);
  if (!m) return null;
  const startMs = m[2] ? parseClock(m[2]) : null;
  const endMs = m[3] ? parseClock(m[3]) : null;
  return { num: Number(m[1]), startMs, endMs, text: line.replace(/^## /, "").trim() };
}

/** Every section heading of a note, in order. */
export function sectionHeadings(content: string): SectionHeading[] {
  const out: SectionHeading[] = [];
  for (const line of content.split("\n")) {
    const h = parseSectionHeading(line.replace(/\r$/, ""));
    if (h) out.push(h);
  }
  return out;
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
