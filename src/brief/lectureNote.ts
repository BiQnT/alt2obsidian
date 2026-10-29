// The parts of a lecture note the lecture brief and the question panel read
// (2.1.0 spec 4.2, 6.2): its frontmatter, the overview block, the slide or
// transcript sections with their gists, the memo callouts. Pure module (no
// obsidian import) so the plugin, the Node tests and the Skill CLI read a
// note the same way.
//
// A note is one of three kinds:
//   slides      slide markers (`<!-- alt2obs:slide:N hash:H start -->`); a
//               slide note wins even when its backup still holds sections
//   transcript  transcript section markers (spec 4.10)
//   lecture     neither: one managed block (`<!-- alt2obsidian:start -->`)

import { MANAGED_NOTE_END, MANAGED_NOTE_START } from "../types";
import { findOverviewBlock, hasMultiManagedMarkers, splitMultiManagedNote, splitSectionNote, toLf } from "../core/merge";
import { hasSectionMarkers } from "../core/sections";
import { parseSlideMeta, stripDiagramEmbed, stripSlideMeta } from "../core/slideMeta";

export type LectureNoteKind = "slides" | "transcript" | "lecture";

/** One slide or transcript section of a note, in note order. */
export interface NoteUnit {
  num: number;
  hash: string;
  /** The managed body as written (commentary or section summary, with its meta line). */
  managed: string;
  /** From the end marker to the next unit: the memo callout and anything the user wrote there. */
  after: string;
  /** The gist of the meta line, null without one (template slides of old notes, 1.x notes). */
  gist: string | null;
  /** Section heading times (transcript notes); null when the heading has none. */
  startMs: number | null;
  endMs: number | null;
}

export interface LectureNoteParts {
  frontmatter: Record<string, unknown>;
  kind: LectureNoteKind;
  /** Body of the overview block (`<!-- alt2obs:overview start -->`), null when there is none. */
  overview: string | null;
  units: NoteUnit[];
  /** A lecture-level note's managed block without its title line ("" when there is none). */
  managed: string;
  /** The note after its frontmatter. */
  body: string;
}

const FRONTMATTER = /^\uFEFF?---\n([\s\S]*?)\n---(?:\n|$)/;

/**
 * `key: value` lines of the frontmatter (JSON string values decoded, other
 * values as written, a `"..."` that is not JSON without its quotes). Enough
 * for the scalar keys the plugin writes; a list or a nested mapping is
 * kept as its text.
 */
export function readFrontmatter(text: string): Record<string, unknown> {
  const block = toLf(text).match(FRONTMATTER);
  const fm: Record<string, unknown> = {};
  if (!block) return fm;
  for (const line of block[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    let v: unknown = raw;
    if (raw.startsWith('"')) {
      try {
        v = JSON.parse(raw);
      } catch {
        v = raw.replace(/^"(.*)"$/, "$1");
      }
    }
    fm[m[1]] = v;
  }
  return fm;
}

/**
 * A lecture brief or subject brief (their frontmatter keys). A brief
 * carries the lecture's `alt_local_id`, but it is never a lecture note.
 */
export function isBriefFrontmatter(fm: Record<string, unknown> | null | undefined): boolean {
  return !!fm && (fm.alt2obs_brief !== undefined || fm.alt2obs_subject_brief !== undefined);
}

/** The note after its frontmatter (LF line ends). */
export function bodyOf(text: string): string {
  const lf = toLf(text);
  const block = lf.match(FRONTMATTER);
  return block ? lf.slice(block[0].length) : lf.replace(/^\uFEFF/, "");
}

/** A string frontmatter value, "" for anything else. */
export function fmString(fm: Record<string, unknown>, key: string): string {
  const v = fm[key];
  return typeof v === "string" ? v.trim() : "";
}

export function parseLectureNote(text: string): LectureNoteParts {
  const lf = toLf(text);
  const frontmatter = readFrontmatter(lf);
  const body = bodyOf(lf);
  const block = findOverviewBlock(body);
  const overview = block ? body.slice(block.bodyStart, block.bodyEnd).trim() : null;
  if (hasMultiManagedMarkers(body)) {
    const units = splitMultiManagedNote(body).sections.map(
      (s): NoteUnit => ({ num: s.slideNum, hash: s.hash, managed: s.managed, after: s.after, gist: parseSlideMeta(s.managed)?.gist ?? null, startMs: null, endMs: null })
    );
    return { frontmatter, kind: "slides", overview, units, managed: "", body };
  }
  if (hasSectionMarkers(body)) {
    const units = splitSectionNote(body).sections.map(
      (s): NoteUnit => ({
        num: s.num,
        hash: s.hash,
        managed: s.managed,
        after: s.after,
        gist: parseSlideMeta(s.managed)?.gist ?? null,
        startMs: s.parsed?.startMs ?? null,
        endMs: s.parsed?.endMs ?? null,
      })
    );
    return { frontmatter, kind: "transcript", overview, units, managed: "", body };
  }
  const start = body.indexOf(MANAGED_NOTE_START);
  const end = body.indexOf(MANAGED_NOTE_END);
  const managed = start >= 0 && end > start ? body.slice(start + MANAGED_NOTE_START.length, end).replace(/^\s*# [^\n]*\n/, "").trim() : "";
  return { frontmatter, kind: "lecture", overview, units: [], managed, body };
}

/**
 * Wikilinks as their text: `[[A|B]]` (also `[[A\|B]]` in a table) becomes
 * B, `[[A]]` becomes A. Embeds (`![[...]]`, `![..](..)`) are dropped. The
 * brief carries no links, so it adds no edges to the graph (spec 4.1).
 */
export function unwrapWikilinks(text: string): string {
  return text
    .replace(/!\[\[[^\]\n]*\]\]/g, "")
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "")
    .replace(/\[\[([^\]|\n]*?)(?:\\?\|([^\]\n]*))?\]\]/g, (_m, target: string, alias: string | undefined) => (alias ?? target).trim());
}

/** A whole line that is one alt2obs management comment (the rule of src/editor/managedComments.ts). */
const MANAGED_COMMENT_LINE = /^[ \t]*<!-- alt2obs(?:idian)?:[^\n]*?-->[ \t]*$/gm;

/** A slide's commentary or a section's summary as plain note text: no meta, diagram embed, management comments or links. */
export function commentaryText(managed: string): string {
  return unwrapWikilinks(stripDiagramEmbed(stripSlideMeta(toLf(managed))).replace(MANAGED_COMMENT_LINE, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The text of the `> [!note] 내 메모` callout in a unit's free space,
 * without the `> ` marks and the callout line; "" when it holds nothing.
 */
export function memoText(after: string): string {
  const lines = toLf(after).split("\n");
  const head = lines.findIndex((l) => /^\s*>\s*\[!note\][^\n]*내 메모/.test(l));
  if (head < 0) return "";
  const out: string[] = [];
  for (let i = head + 1; i < lines.length && /^\s*>/.test(lines[i]); i++) out.push(lines[i].replace(/^\s*> ?/, ""));
  return out.join("\n").trim();
}

/**
 * The first sentence of some note text as one plain line, cut to `max`
 * characters: headings, callout lines, list marks, emphasis and code ticks
 * are dropped first.
 */
export function firstSentence(text: string, max: number): string {
  const plain = unwrapWikilinks(toLf(text))
    .replace(MANAGED_COMMENT_LINE, "")
    .split("\n")
    .filter((l) => !/^\s*(#{1,6}\s|>\s*\[!|\||```)/.test(l))
    .map((l) => l.replace(/^\s*>\s?/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))
    .join(" ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const end = plain.search(/[.!?](?=\s|$)/);
  const sentence = end >= 0 ? plain.slice(0, end + 1) : plain;
  return Array.from(sentence).slice(0, max).join("").trim();
}

/** The slide or section heading nearest above a line (0-based) of a note, null above the first. */
export function unitAtLine(text: string, line: number): { unit: "slide" | "section"; num: number } | null {
  const lines = toLf(text).split("\n");
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    const slide = lines[i].match(/^## 📚 슬라이드 (\d+)(?!\d)/);
    if (slide) return { unit: "slide", num: Number(slide[1]) };
    const section = lines[i].match(/^## ⏱ 구간 (\d+)(?!\d)/);
    if (section) return { unit: "section", num: Number(section[1]) };
  }
  return null;
}
