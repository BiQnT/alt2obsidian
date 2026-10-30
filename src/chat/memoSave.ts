// "메모에 저장" of the question panel (2.1.0 spec 5.9): an answer kept in
// the memo callout (`> [!note] 내 메모`) of the slide or section the
// question was about. The callout is looked for after that unit's end
// marker, before the next heading; an empty one is filled, one with text
// gets the answer appended after a `>` line, a missing one is made after
// the end marker. The managed blocks are never touched, so a re-import
// (mergeNote) keeps what was saved. What is saved is made safe first, as
// the panel renders an answer (the note is rendered by every plugin and
// kept), which also leaves no `<!--` that a re-import could read as a
// marker. A CRLF note stays CRLF. Pure: no obsidian import, unit-tested in
// Node.

import { toLf } from "../core/merge";
import { safeAnswerMarkdown } from "./safeMarkdown";

/** The slide (or transcript section) whose memo gets the answer. */
export interface MemoTarget {
  unit: "slide" | "section";
  num: number;
}

export interface MemoEntry {
  question: string;
  answer: string;
  /** YYYY-MM-DD. */
  date: string;
}

const MEMO_TITLE = "> [!note] 내 메모";
/** The memo callout's title line, as the panel reads it (lectureNote.memoText). */
const MEMO_CALLOUT = /^\s*>\s*\[!note\][^\n]*내 메모/;
const UNIT_HEADING = /^## (?:📚 슬라이드|⏱ 구간) \d+/;

/**
 * The callout lines of one saved answer: `> **Q.** <question on one
 * line>`, `> **A.**` alone on its line (the answer's first line keeps its
 * structure: a fence, a list, a heading), the answer lines behind `> `
 * (`>` for a blank one), and ` (질문 YYYY-MM-DD)` at the end (on its own
 * line after a closing code fence, which must stay alone on its line).
 * The lines as composed are made safe as the panel renders an answer.
 */
export function memoEntryLines(e: MemoEntry): string[] {
  const answer = toLf(e.answer).replace(/^\s*\n/, "").trimEnd().split("\n");
  const lines = [`> **Q.** ${e.question.replace(/\s+/g, " ").trim()}`, "> **A.**", ...answer.map((l) => (l.trim() ? `> ${l}` : ">"))];
  const stamp = `(질문 ${e.date})`;
  if (/^\s*(`{3,}|~{3,})\s*$/.test(answer[answer.length - 1])) lines.push(`> ${stamp}`);
  else lines[lines.length - 1] += ` ${stamp}`;
  return safeAnswerMarkdown(lines.join("\n")).split("\n");
}

function headingOf(target: MemoTarget): RegExp {
  return target.unit === "slide" ? new RegExp(`^## 📚 슬라이드 ${target.num}\\s*$`) : new RegExp(`^## ⏱ 구간 ${target.num}(?:\\s|$)`);
}

function endMarkerOf(target: MemoTarget): RegExp {
  return target.unit === "slide"
    ? new RegExp(`^<!-- alt2obs:slide:${target.num} hash:[0-9a-f]{8}(?: dup:\\d+)? end -->\\s*$`)
    : new RegExp(`^<!-- alt2obs:section:${target.num} hash:[0-9a-f]{8} end -->\\s*$`);
}

/** The note with the entry in the unit's memo callout, null when the unit (its heading or end marker) is not in the note. */
export function insertMemo(note: string, target: MemoTarget, entry: MemoEntry): string | null {
  const lines = toLf(note).split("\n");
  const heading = lines.findIndex((l) => headingOf(target).test(l));
  if (heading < 0) return null;
  const endMarker = endMarkerOf(target);
  let end = -1;
  for (let i = heading + 1; i < lines.length && !UNIT_HEADING.test(lines[i]); i++) {
    if (endMarker.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  // The unit's free space: up to the next heading or plugin marker (the next unit, the failure list).
  let stop = end + 1;
  while (stop < lines.length && !/^## /.test(lines[stop]) && !lines[stop].startsWith("<!-- alt2obs:")) stop++;
  const entryLines = memoEntryLines(entry);
  const title = lines.slice(end + 1, stop).findIndex((l) => MEMO_CALLOUT.test(l));
  if (title < 0) {
    // No callout: a new one after the end marker and a blank line.
    const after = lines[end + 1];
    const block = ["", MEMO_TITLE, ...entryLines, ...(after !== undefined && after.trim() ? [""] : [])];
    lines.splice(end + 1, 0, ...block);
  } else {
    const start = end + 1 + title;
    let last = start;
    while (last + 1 < stop && /^\s*>/.test(lines[last + 1])) last++;
    const body = lines.slice(start + 1, last + 1);
    // Only blank callout lines (the `> ` a new note has): the entry takes their place.
    if (body.every((l) => /^\s*>\s*$/.test(l))) lines.splice(start + 1, body.length, ...entryLines);
    else lines.splice(last + 1, 0, ">", ...entryLines);
  }
  const text = lines.join("\n");
  return note.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}
