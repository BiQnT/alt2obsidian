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

// ---- which headings are slide sections ----
const heads = [
  { level: 2, text: "📋 전체 요약" },
  { level: 3, text: "슬라이드 2~3 정리" },
  { level: 2, text: "📚 슬라이드 1" },
  { level: 2, text: "📚 슬라이드 2" },
  { level: 3, text: "슬라이드 4 이후" },
  { level: 2, text: "📚 슬라이드 2" },
];
assert.deepEqual(sync.pickSlideHeadings(heads), [{ index: 2, num: 1 }, { index: 3, num: 2 }], "with 📚 h2 headings, overview subheadings and repeats do not count");
assert.deepEqual(
  sync.pickSlideHeadings([{ level: 3, text: "슬라이드 1 소개" }, { level: 2, text: "슬라이드 2" }, { level: 2, text: "정리" }]),
  [{ index: 0, num: 1 }, { index: 1, num: 2 }],
  "a hand-made note without them falls back to h2/h3 headings"
);

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
assert.equal(rendered.split("\n").length, note.split("\n").length, "comment lines become blank lines, nothing else moves");
assert.equal(mc.stripManagedComments("문단 1\n<!-- alt2obs:overview end -->\n문단 2"), "문단 1\n\n문단 2", "two text lines a marker sat between stay separate paragraphs");
assert.equal(mc.stripManagedComments("no markers\n"), "no markers\n");
assert.equal(mc.stripManagedComments("a\r\n<!-- alt2obs:overview end -->\r\nb"), "a\r\n\r\nb", "CRLF notes");
// The parser still sees every marker: the note text itself is never changed.
const merge = await importTs("src/core/merge.ts");
assert.ok(merge.hasMultiManagedMarkers(note));
console.log("PASS: management comment lines matched exactly (user comments and mixed lines kept), the viewer text blanks only them");

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
// Cursor on the meta line: it and the end marker right after it (one run) show; the start marker 3 lines up stays hidden.
const metaFrom = note.indexOf("<!-- alt2obs:meta");
state = state.update({ selection: EditorSelection.cursor(metaFrom + 5) }).state;
assert.deepEqual(hiddenTexts(state), managedLines.filter((l) => !l.startsWith("<!-- alt2obs:meta") && !l.includes("slide:2 hash:0743ab51 end")));
// Cursor on the line right after a marker (the commentary line): the start marker above shows.
const textFrom = note.indexOf("[[Proportional");
state = state.update({ selection: EditorSelection.cursor(textFrom + 3) }).state;
assert.ok(!hiddenTexts(state).some((l) => l.includes("slide:2 hash:0743ab51 start")), "the marker on the line before the cursor shows");
assert.ok(hiddenTexts(state).some((l) => l.startsWith("<!-- alt2obs:meta")), "the meta line two lines down stays hidden");
// Cursor on the blank line before the overview: overview start shows, the end marker (3 lines down) stays hidden.
const ovFrom = note.indexOf("<!-- alt2obs:overview start");
state = state.update({ selection: EditorSelection.cursor(ovFrom - 1) }).state;
assert.ok(!hiddenTexts(state).includes("<!-- alt2obs:overview start -->") && hiddenTexts(state).includes("<!-- alt2obs:overview end -->"));
// The cursor moving within one line keeps the very same decoration set (no redraw).
const decoA = state.facet(mc.EditorView.decorations)[0];
const moved = state.update({ selection: EditorSelection.cursor(ovFrom - 1) }).state;
assert.equal(moved.facet(mc.EditorView.decorations)[0], decoA, "same reveal set: decorations reused");

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
// A document without markers: nothing to hide, cursor moves cost nothing.
let plain = EditorState.create({ doc: "# 내 노트\n\n본문", extensions: [mc.managedCommentHider(() => true)] });
const plainDeco = plain.facet(mc.EditorView.decorations)[0];
plain = plain.update({ selection: EditorSelection.cursor(3) }).state;
assert.equal(plain.facet(mc.EditorView.decorations)[0], plainDeco);
assert.deepEqual(hiddenTexts(plain), []);

// Change filter: typing or deleting never lands inside a hidden marker or its newlines.
live = true;
let guarded = EditorState.create({ doc: note, extensions: [mc.managedCommentHider(() => live)], selection: EditorSelection.cursor(0) });
const metaLine = guarded.doc.lineAt(note.indexOf("<!-- alt2obs:meta"));
// A multi-cursor style deletion of the newline before the hidden meta line (the cursor itself is far away).
const del = guarded.update({ changes: { from: metaLine.from - 1, to: metaLine.from }, userEvent: "delete.backward" }).state;
assert.equal(del.doc.toString(), note, "deleting the newline next to a hidden marker is blocked");
const typed = guarded.update({ changes: { from: metaLine.from + 4, insert: "x" }, userEvent: "input.type" }).state;
assert.equal(typed.doc.toString(), note, "typing into a hidden marker is blocked");
// A multi-line replace spanning a hidden line is refused whole, not half applied.
const spanFrom = note.indexOf("[[Proportional");
const spanTo = note.indexOf("> [!note] 내 메모");
const span = guarded.update({ changes: { from: spanFrom, to: spanTo, insert: "새 본문\n" }, userEvent: "input.paste" }).state;
assert.equal(span.doc.toString(), note, "a paste over hidden lines changes nothing");
// The same with one change outside and one touching a hidden line: nothing applies.
const two = guarded.update({ changes: [{ from: 0, insert: "y" }, { from: metaLine.from + 4, insert: "x" }], userEvent: "input.type" }).state;
assert.equal(two.doc.toString(), note, "no partial edit");
const elsewhere = guarded.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }).state;
assert.equal(elsewhere.doc.toString(), "x" + note, "edits elsewhere go through");
const program = guarded.update({ changes: { from: metaLine.from - 1, to: metaLine.from } }).state;
assert.notEqual(program.doc.toString(), note, "changes that are not user input (plugins, merges) are not filtered");
// A visible marker (cursor next to it) can be edited and deleted.
guarded = guarded.update({ selection: EditorSelection.cursor(metaLine.from) }).state;
const visibleDel = guarded.update({ changes: { from: metaLine.from - 1, to: metaLine.from }, userEvent: "delete.backward" }).state;
assert.notEqual(visibleDel.doc.toString(), note);
console.log("PASS: Live Preview field hides management lines, reveals the run next to the cursor or selection, reuses decorations, filters edits into hidden lines, nothing in source mode");

// ---- opening a lecture PDF opens the Synced Viewer (src/ui/pdfOpen.ts) ----
{
  const po = await importTs("src/ui/pdfOpen.ts");
  const notes = {
    "L/6강.md": { fm: { alt_local_id: "id-6" }, text: "" },
    "L/7강.md": { fm: { title: "7강" }, text: "## 📚 슬라이드 1\n\n<!-- alt2obs:slide:1 hash:0a1b2c3d start -->\n본문\n<!-- alt2obs:slide:1 hash:0a1b2c3d end -->\n" },
    "L/skill.md": { fm: { source: "alt2obsidian-cc-skill" }, text: "" },
    "L/plain.md": { fm: { title: "그냥 노트" }, text: "# 그냥 노트\n<!-- alt2obs:slide:1 hash:xyz start --> 아님\n" },
    "L/empty-id.md": { fm: { alt_id: "  " }, text: "" },
  };
  let reads = 0;
  const lookup = {
    exists: (p) => p in notes,
    frontmatter: (p) => notes[p]?.fm ?? null,
    read: async (p) => (reads++, notes[p]?.text ?? ""),
  };
  assert.equal(await po.lectureNoteForPdf("L/6강.pdf", lookup), "L/6강.md", "Alt id in the frontmatter");
  assert.equal(reads, 0, "frontmatter decides without reading the note");
  assert.equal(await po.lectureNoteForPdf("L/6강.PDF", lookup), "L/6강.md", ".PDF works too");
  assert.equal(await po.lectureNoteForPdf("L/7강.Pdf", lookup), "L/7강.md", "slide markers in the text");
  assert.equal(await po.lectureNoteForPdf("L/skill.pdf", lookup), "L/skill.md", "a Skill import");
  assert.equal(await po.lectureNoteForPdf("L/plain.pdf", lookup), null, "a note without markers or Alt frontmatter");
  assert.equal(await po.lectureNoteForPdf("L/empty-id.pdf", lookup), null, "an empty id does not count");
  assert.equal(await po.lectureNoteForPdf("L/none.pdf", lookup), null, "no sibling note");
  assert.equal(await po.lectureNoteForPdf("L/6강.md", lookup), null, "not a PDF");

  const base = { enabled: true, viewType: "pdf", pdfPath: "L/6강.pdf", bypass: false, busy: false, notePath: "L/6강.md" };
  assert.deepEqual(po.decidePdfOpen(base), { action: "viewer", mdPath: "L/6강.md", pdfPath: "L/6강.pdf" });
  assert.deepEqual(po.decidePdfOpen({ ...base, enabled: false }), { action: "none", reason: "off" }, "setting off");
  assert.deepEqual(po.decidePdfOpen({ ...base, bypass: true }), { action: "none", reason: "bypass" }, "a 'PDF만 보기' tab stays a PDF");
  assert.deepEqual(po.decidePdfOpen({ ...base, busy: true }), { action: "none", reason: "busy" }, "no second redirect while one runs");
  assert.deepEqual(po.decidePdfOpen({ ...base, viewType: "alt2obs-synced-viewer" }), { action: "none", reason: "not-pdf-view" }, "the viewer itself is not redirected (no loop)");
  assert.deepEqual(po.decidePdfOpen({ ...base, viewType: null }), { action: "none", reason: "not-pdf-view" });
  assert.deepEqual(po.decidePdfOpen({ ...base, notePath: null }), { action: "none", reason: "not-lecture" }, "any other PDF opens as usual");
  console.log("PASS: lecture PDF detection (.pdf/.PDF, frontmatter or slide markers) and the viewer redirect decision (setting off, PDF-only tabs, no loop)");
}
