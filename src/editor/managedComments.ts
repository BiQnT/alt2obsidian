// Hiding the plugin's management comments (setting "관리 주석 숨기기").
//
// A lecture note carries one HTML comment per line for the plugin: slide
// markers (`<!-- alt2obs:slide:N hash:H start|end -->`), the per-slide
// metadata (`<!-- alt2obs:meta ... -->`), the overview markers and the 1.x
// single-block markers (`<!-- alt2obsidian:start|end -->`). Reading view
// never shows HTML comments, but Live Preview prints them as text. The note
// text is never changed here: src/core/merge.ts and the alt2obs Skill parse
// these lines on every re-import.
//
// - Live Preview: a CodeMirror 6 field replaces each such line with nothing
//   (a block decoration), except a line a selection touches, so the user can
//   still see and edit it. Source mode shows everything.
// - Synced Viewer: the lines are dropped from the text before rendering.

import { EditorState, Extension, RangeSetBuilder, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/** A whole line that is one alt2obs / alt2obsidian management comment. */
const MANAGED_LINE = /^[ \t]*<!-- alt2obs(?:idian)?:[^\n]*?-->[ \t]*$/;

export function isManagedCommentLine(line: string): boolean {
  return MANAGED_LINE.test(line);
}

/**
 * The note with its management comment lines emptied (for rendering only).
 * Each line becomes blank instead of disappearing, so two text lines a
 * marker sat between stay separate paragraphs.
 */
export function stripManagedComments(markdown: string): string {
  if (!markdown.includes("<!-- alt2obs")) return markdown;
  return markdown
    .split("\n")
    .map((line) => (isManagedCommentLine(line.replace(/\r$/, "")) ? (line.endsWith("\r") ? "\r" : "") : line))
    .join("\n");
}

export interface LineRange {
  from: number;
  to: number;
}

/** Every management comment line of a document (positions of the line text, without its newline). */
export function managedLines(doc: Text): LineRange[] {
  const out: LineRange[] = [];
  let pos = 0;
  for (const iter = doc.iterLines(); !iter.next().done; ) {
    const text = iter.value;
    const from = pos;
    pos += text.length + 1;
    if (text.length >= 14 && text.includes("<!-- alt2obs") && isManagedCommentLine(text)) out.push({ from, to: from + text.length });
  }
  return out;
}

/**
 * The lines to hide: all management lines except the ones near a cursor or
 * selection. "Near" is the line itself, the line just before or after it
 * (so the user sees a marker before deleting or typing into the newline
 * next to it), and the whole run of consecutive management lines touching
 * those, so arrowing past a block (meta line plus end marker) reveals it in
 * one step instead of one line at a time.
 */
export function hiddenLineRanges(state: EditorState, lines: LineRange[] = managedLines(state.doc)): LineRange[] {
  if (lines.length === 0) return [];
  const doc = state.doc;
  const revealedLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = Math.max(1, doc.lineAt(r.from).number - 1);
    const last = Math.min(doc.lines, doc.lineAt(r.to).number + 1);
    for (let n = first; n <= last; n++) revealedLines.add(n);
  }
  const numbers = lines.map((l) => doc.lineAt(l.from).number);
  const reveal = numbers.map((n) => revealedLines.has(n));
  // Spread the reveal along runs of consecutive management lines.
  for (let i = 1; i < numbers.length; i++) if (reveal[i - 1] && numbers[i] === numbers[i - 1] + 1) reveal[i] = true;
  for (let i = numbers.length - 2; i >= 0; i--) if (reveal[i + 1] && numbers[i] === numbers[i + 1] - 1) reveal[i] = true;
  return lines.filter((_, i) => !reveal[i]);
}

const hideLine = Decoration.replace({ block: true });

interface HiderValue {
  live: boolean;
  /** All management lines; recomputed only when the document changes. */
  lines: LineRange[];
  hidden: LineRange[];
  decorations: DecorationSet;
}

function sameRanges(a: LineRange[], b: LineRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.from === b[i].from && r.to === b[i].to);
}

function decorate(state: EditorState, live: boolean, lines: LineRange[], previous?: HiderValue): HiderValue {
  const hidden = live ? hiddenLineRanges(state, lines) : [];
  if (previous && previous.live === live && sameRanges(previous.hidden, hidden) && previous.lines === lines) return previous;
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of hidden) builder.add(r.from, r.to, hideLine);
  return { live, lines, hidden, decorations: builder.finish() };
}

/**
 * The editor extension. `isLivePreview` reads Obsidian's live preview flag
 * from the state (passed in so this module has no obsidian import and runs
 * in Node tests).
 * - A document without "<!-- alt2obs" costs one scan per edit and nothing
 *   per cursor move.
 * - A cursor move recomputes only the reveal set over the cached marker
 *   lines, and keeps the old decorations when nothing changed.
 * - A typing or deleting change that would touch a hidden line or the
 *   newline on either side of it is refused as a whole (a change filter),
 *   so a marker cannot be damaged or merged with text the user does not
 *   see, and no edit is half applied.
 */
export function managedCommentHider(isLivePreview: (state: EditorState) => boolean): Extension {
  const field = StateField.define<HiderValue>({
    create(state) {
      return decorate(state, isLivePreview(state), managedLines(state.doc));
    },
    update(value, tr) {
      const live = isLivePreview(tr.state);
      if (!tr.docChanged && !tr.selection && live === value.live) return value;
      const lines = tr.docChanged ? managedLines(tr.state.doc) : value.lines;
      if (lines.length === 0 && value.lines.length === 0 && live === value.live) return value;
      return decorate(tr.state, live, lines, tr.docChanged ? undefined : value);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
  const protect = EditorState.changeFilter.of((tr) => {
    if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return true;
    const value = tr.startState.field(field, false);
    if (!value || value.hidden.length === 0) return true;
    // A change touching a hidden line or its newlines is refused as a whole:
    // applying only the part outside would leave a half-done edit.
    let touches = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (value.hidden.some((r) => fromA <= r.to + 1 && toA >= r.from - 1)) touches = true;
    });
    return !touches;
  });
  return [field, protect];
}
