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

import { EditorState, Extension, RangeSetBuilder, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/** A whole line that is one alt2obs / alt2obsidian management comment. */
const MANAGED_LINE = /^[ \t]*<!-- alt2obs(?:idian)?:[^\n]*?-->[ \t]*$/;

export function isManagedCommentLine(line: string): boolean {
  return MANAGED_LINE.test(line);
}

/** The note without its management comment lines (for rendering only). */
export function stripManagedComments(markdown: string): string {
  if (!markdown.includes("<!-- alt2obs")) return markdown;
  return markdown
    .split("\n")
    .filter((line) => !isManagedCommentLine(line.replace(/\r$/, "")))
    .join("\n");
}

/** Line ranges [from, to] to hide in a document, skipping lines a selection touches. */
export function hiddenLineRanges(state: EditorState): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const doc = state.doc;
  const sel = state.selection.ranges;
  let pos = 0;
  for (const iter = doc.iterLines(); !iter.next().done; ) {
    const text = iter.value;
    const from = pos;
    const to = pos + text.length;
    pos = to + 1;
    if (text.length < 14 || !isManagedCommentLine(text)) continue;
    if (sel.some((r) => r.from <= to && r.to >= from)) continue;
    out.push({ from, to });
  }
  return out;
}

const hideLine = Decoration.replace({ block: true });

function buildDecorations(state: EditorState, active: boolean): DecorationSet {
  if (!active) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of hiddenLineRanges(state)) builder.add(r.from, r.to, hideLine);
  return builder.finish();
}

/**
 * The editor extension. `isLivePreview` reads Obsidian's live preview flag
 * from the state (passed in so this module has no obsidian import and runs
 * in Node tests).
 */
export function managedCommentHider(isLivePreview: (state: EditorState) => boolean): Extension {
  return StateField.define<{ live: boolean; decorations: DecorationSet }>({
    create(state) {
      const live = isLivePreview(state);
      return { live, decorations: buildDecorations(state, live) };
    },
    update(value, tr) {
      const live = isLivePreview(tr.state);
      if (!tr.docChanged && !tr.selection && live === value.live) return value;
      return { live, decorations: buildDecorations(tr.state, live) };
    },
    provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
  });
}
