/**
 * Test: Synced Viewer scroll math (src/ui/viewerSync.ts) and hiding of the
 * alt2obs management comments (src/editor/managedComments.ts): the line
 * matcher, the text the viewer renders, and the Live Preview editor field
 * (CodeMirror state only, no DOM). The real 2.0.0-beta.3 note layout is used.
 * Run: node test/test-viewer.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";

const sync = await importTs("src/ui/viewerSync.ts");
const mc = await importTs("test/helpers/viewer-entry.ts");

// ---- headings of old and new notes ----
assert.equal(sync.slideNumberFromHeading("📚 슬라이드 12"), 12);
assert.equal(sync.slideNumberFromHeading("  📚 슬라이드 3 캐시 구조"), 3, "a title after the number");
assert.equal(sync.slideNumberFromHeading("슬라이드 7"), 7, "a heading without the emoji");
assert.equal(sync.slideNumberFromHeading("📋 전체 요약"), null);
assert.equal(sync.slideNumberFromHeading("슬라이드 2~3 정리"), 2);
assert.equal(sync.slideNumberFromHeading("📚 슬라이드 1x"), 1);
assert.equal(sync.slideNumberFromHeading("📚 슬라이드 10"), 10, "10 is not read as 1");

// ---- the section a pane shows ----
const sections = [
  { num: 1, top: 400 },
  { num: 2, top: 900 },
  { num: 3, top: 1500 },
];
assert.equal(sync.sectionAt(sections, 100), null, "above slide 1 (the overview): no sync");
assert.equal(sync.sectionAt(sections, 400), 1);
assert.equal(sync.sectionAt(sections, 899), 1);
assert.equal(sync.sectionAt(sections, 1200), 2);
assert.equal(sync.sectionAt(sections, 99999), 3);
assert.equal(sync.sectionAt([], 10), null);

// ---- where to scroll the note for a page ----
const headings = new Map([[1, "h1"], [2, "h2"], [5, "h5"]]);
assert.equal(sync.headingForSlide(headings, 2), "h2");
assert.equal(sync.headingForSlide(headings, 4), "h2", "a page without a section: the closest earlier one");
assert.equal(sync.headingForSlide(headings, 9), "h5");
assert.equal(sync.headingForSlide(new Map([[3, "h3"]]), 1), "h3", "before the first section: the first one");
assert.equal(sync.headingForSlide(new Map(), 1), null);
console.log("PASS: viewer sync: slide headings (with and without emoji), section under the probe line, nearest heading");

// ---- management comment lines (2.0.0-beta.3 note, slide 2, abridged) ----
const note = [
  "---",
  'title: "6강"',
  "---",
  "# 6강",
  "",
  "## 📋 전체 요약",
  "",
  "<!-- alt2obs:overview start -->",
  "### 비례 배분 스케줄링 (슬라이드 2~3)",
  "- 티켓 비율이 곧 CPU 점유 비율",
  "<!-- alt2obs:overview end -->",
  "",
  "## 📚 슬라이드 2",
  "",
  "<!-- alt2obs:slide:2 hash:0743ab51 start -->",
  "[[Proportional Share Scheduler]]는 CPU 시간의 일정 비율을 보장합니다.",
  "",
  '<!-- alt2obs:meta img:' + "f".repeat(128) + ' gist:"\\uBE44\\uB840 \\u002d\\u002d\\u003e" -->',
  "<!-- alt2obs:slide:2 hash:0743ab51 end -->",
  "",
  "> [!note] 내 메모",
  "> <!-- 내 주석은 그대로 -->",
  "<!-- alt2obsidian:start -->",
  "  <!-- alt2obs:slide:3 hash:abcdef12 dup:2 start -->  ",
  "<!-- alt2obs:slide:4 hash:abcdef12 start --> 뒤에 글",
].join("\n");
const managedLines = note.split("\n").filter((l) => mc.isManagedCommentLine(l));
assert.equal(managedLines.length, 7, "overview x2, slide x2, meta, 1.x block marker, indented dup marker");
assert.ok(!mc.isManagedCommentLine("> <!-- 내 주석은 그대로 -->"), "the user's own comments stay");
assert.ok(!mc.isManagedCommentLine("<!-- alt2obs:slide:4 hash:abcdef12 start --> 뒤에 글"), "a line with other text stays visible");

const rendered = mc.stripManagedComments(note);
assert.ok(!rendered.includes("alt2obs:slide:2") && !rendered.includes("alt2obs:meta") && !rendered.includes("alt2obs:overview"));
assert.ok(rendered.includes("## 📚 슬라이드 2") && rendered.includes("[[Proportional Share Scheduler]]") && rendered.includes("> <!-- 내 주석은 그대로 -->"));
assert.equal(rendered.split("\n").length, note.split("\n").length - 7, "only the comment lines are dropped");
assert.equal(mc.stripManagedComments("no markers\n"), "no markers\n");
assert.equal(mc.stripManagedComments("a\r\n<!-- alt2obs:overview end -->\r\nb"), "a\r\nb", "CRLF notes");
// The parser still sees every marker: the note text itself is never changed.
const merge = await importTs("src/core/merge.ts");
assert.ok(merge.hasMultiManagedMarkers(note));
console.log("PASS: management comment lines matched exactly (user comments and mixed lines kept), viewer text drops only them");

// ---- Live Preview field ----
const { EditorState, EditorSelection } = mc;
let live = true;
const ext = mc.managedCommentHider(() => live);
const hiddenTexts = (state) => {
  const out = [];
  state.facet(mc.EditorView.decorations).forEach((d) => {
    const set = typeof d === "function" ? d(null) : d;
    set.between(0, state.doc.length, (from, to) => void out.push(state.doc.sliceString(from, to)));
  });
  return out;
};
let state = EditorState.create({ doc: note, extensions: [ext] });
assert.deepEqual(hiddenTexts(state), managedLines, "every management line hidden while the cursor is elsewhere");
// Cursor on the meta line: that line shows, the others stay hidden.
const metaFrom = note.indexOf("<!-- alt2obs:meta");
state = state.update({ selection: EditorSelection.cursor(metaFrom + 5) }).state;
assert.deepEqual(hiddenTexts(state), managedLines.filter((l) => !l.startsWith("<!-- alt2obs:meta")));
// A selection across slide 2 reveals all its lines.
const s2 = note.indexOf("<!-- alt2obs:slide:2");
const e2 = note.indexOf("end -->", s2 + 40) + 7;
state = state.update({ selection: EditorSelection.range(s2, e2) }).state;
assert.equal(hiddenTexts(state).filter((l) => l.includes("slide:2") || l.includes("alt2obs:meta")).length, 0);
// Typing keeps the ranges right.
state = state.update({ changes: { from: 0, insert: "x\n" }, selection: EditorSelection.cursor(0) }).state;
assert.deepEqual(hiddenTexts(state), managedLines);
// Source mode (live preview off): nothing hidden.
live = false;
state = state.update({ selection: EditorSelection.cursor(1) }).state;
assert.deepEqual(hiddenTexts(state), []);
console.log("PASS: Live Preview field hides management lines, shows the line under the cursor or selection, nothing in source mode");
