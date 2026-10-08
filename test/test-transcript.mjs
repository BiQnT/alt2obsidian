/**
 * Test: lectures without slides (spec 4.10, 2.0.0-beta.6) with the fake
 * claude (no tokens): lecture kind detection, section splitting of a 2 hour
 * transcript, the summary note's marker grammar, merges that keep the memos
 * (re-import, changed and removed sections, an older lecture-level note,
 * a summary note becoming a slide note after a PDF is attached), section
 * reuse on re-import, the batched pipeline and its estimate, verification
 * against transcript sections, and the PDF attach helpers. Every merge is
 * also run through the Skill CLI scripts/phase2/merge-note.mjs.
 * Run: node test/test-transcript.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, fakeSession } from "./helpers/fake-cli.mjs";

const m = await importTs("test/helpers/transcript-entry.ts");
const MIN = 60_000;
const tmp = mkdtempSync(join(tmpdir(), "transcript-test-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// ---- lecture kind (the user's Alt note types: "note", "slide", "legacy") ----
{
  const k = (f) => m.lectureKind({ altType: null, hasSlides: false, hasTranscript: true, attachedPdf: false, ...f });
  assert.equal(k({ altType: "note" }), "transcript", "a note-type lecture is transcript only");
  assert.equal(k({ altType: "slide", hasSlides: true }), "slides");
  assert.equal(k({ altType: "slide" }), "slides-missing", "slide type without slides yet: attach in Alt first");
  assert.equal(k({ altType: "legacy" }), "transcript", "legacy without slides: decided by the PDF");
  assert.equal(k({ altType: "legacy", hasSlides: true }), "slides");
  assert.equal(k({ altType: null }), "transcript", "URL import without a PDF");
  assert.equal(k({ altType: "note", attachedPdf: true }), "attached", "a PDF attached in the plugin makes it a slide lecture");
  assert.equal(k({ altType: "slide", attachedPdf: true }), "attached");
  assert.equal(k({ altType: "note", hasTranscript: false }), "empty");
  assert.deepEqual(
    ["slides", "attached", "slides-missing", "transcript", "empty"].map((x) => m.LECTURE_KIND_LABELS[x]),
    ["슬라이드", "슬라이드(PDF 첨부)", "슬라이드(미첨부)", "노트(전사만)", "노트(전사 없음)"]
  );
  assert.equal(k({ altType: "note", vaultCopy: true }), "vault-copy", "a slide note with its saved PDF stays a slide lecture");
  assert.equal(m.LECTURE_KIND_LABELS["vault-copy"], "슬라이드(저장된 PDF)");
  console.log("PASS: lecture kind: 노트(전사만) / 슬라이드 / 슬라이드(미첨부) / 슬라이드(PDF 첨부) from Alt's type, its slides and an attached PDF");
}

// ---- a 2 hour transcript ----
// Topics change at these minutes; segments every 6 s, a 6 s pause at each change.
const TOPICS = [0, 13, 25, 37.5, 51, 62, 76, 88, 101, 112];
const WORDS = [
  ["lexer", "token", "regex"],
  ["parser", "grammar", "derivation"],
  ["ambiguity", "precedence", "associativity"],
  ["firstset", "followset", "nullable"],
  ["lltable", "predictive", "recursive"],
  ["shift", "reduce", "handle"],
  ["lritem", "closure", "gotoset"],
  ["slr", "lookahead", "conflict"],
  ["lalr", "merging", "yacc"],
  ["semantic", "attribute", "action"],
];
function lecture(minutes = 120, edit = null) {
  const segs = [];
  let t = 0;
  let topic = 0;
  let i = 0;
  while (t < minutes * MIN) {
    const next = TOPICS[topic + 1];
    if (next !== undefined && t >= next * MIN) {
      topic++;
      t += 6000;
      continue;
    }
    const [a, b, c] = WORDS[topic];
    let text = `음 그러니까 ${a} ${b} 이야기입니다 ${c} 예시 ${i}번을 봅니다.`;
    if (edit && edit(i, t)) text += " 추가 설명입니다.";
    segs.push({ startMs: t, endMs: t + 4800, text, speaker: "" });
    t += 6000;
    i++;
  }
  return segs;
}
const segs2h = lecture();

{
  const { spans, timed } = m.splitTranscriptSections(segs2h);
  assert.equal(timed, true);
  assert.ok(spans.length >= 8 && spans.length <= 11, `a 2 hour lecture gives 8 to 11 sections, got ${spans.length}`);
  assert.equal(spans[0].from, 0);
  assert.equal(spans[spans.length - 1].to, segs2h.length);
  for (let k = 1; k < spans.length; k++) assert.equal(spans[k].from, spans[k - 1].to, "contiguous, cut on segment boundaries");
  const starts = spans.map((s) => s.startMs);
  for (let k = 0; k + 1 < spans.length; k++) {
    const len = (starts[k + 1] - starts[k]) / MIN;
    assert.ok(len >= 6 && len <= 15, `section ${k + 1} is ${len.toFixed(1)} min`);
  }
  assert.ok((spans[spans.length - 1].endMs - starts[starts.length - 1]) / MIN <= 15, "last section at most 15 minutes");
  // Topic-aware: a topic change inside the window is where the cut goes.
  const changes = TOPICS.slice(1).map((x) => x * MIN + 6000);
  const onTopic = starts.slice(1).filter((s) => changes.some((c) => Math.abs(s - c) <= 6000)).length;
  assert.ok(onTopic >= spans.length - 3, `cuts at topic changes: ${onTopic} of ${spans.length - 1} (${starts.map((s) => m.formatClock(s)).join(" ")})`);
  assert.deepEqual(m.splitTranscriptSections(segs2h).spans, spans, "deterministic");
  console.log(`PASS: a 2 hour transcript is cut into ${spans.length} sections of 6 to 15 minutes on segment boundaries, ${onTopic} cuts at topic changes (${starts.map((s) => m.formatClock(s)).join(", ")})`);

  // Compression: fillers gone, [mm:ss] lines, the cap holds.
  const { sections } = await m.transcriptSections(segs2h, "note-9", 600);
  const sec = sections[1];
  assert.ok(sec.text.split("\n").every((l) => /^\[\d\d:\d\d\] /.test(l)), "one [mm:ss] line per minute");
  assert.ok(!/(^|\s)음(\s|$)/.test(sec.text) && !sec.text.includes("그러니까"), "fillers removed");
  const body = sec.text.split("\n").map((l) => l.replace(/^\[[^\]]+\] /, "")).join(" ");
  assert.ok(body.length <= 600 + 20, `capped (${body.length})`);
  assert.ok(sec.raw.length > body.length);
  // Hashes: an edit inside one section changes that section's hash only.
  const edited = await m.transcriptSections(lecture(120, (i, t) => t >= sections[3].startMs && t < sections[3].startMs + 2 * MIN), "note-9");
  const base = await m.transcriptSections(segs2h, "note-9");
  assert.deepEqual(edited.sections.map((s) => s.startMs), base.sections.map((s) => s.startMs), "same cuts");
  assert.deepEqual(
    base.sections.map((s, k) => s.hash === edited.sections[k].hash),
    base.sections.map((_, k) => k !== 3),
    "only the edited section's hash changes"
  );
  console.log("PASS: sections are compressed ([mm:ss] lines, fillers out, capped) and hashed by their raw text");

  // Without timestamps (URL source): about 4,000 characters per section, no times.
  const untimed = segs2h.map((s) => ({ ...s, startMs: null, endMs: null }));
  const u = m.splitTranscriptSections(untimed);
  assert.equal(u.timed, false);
  assert.ok(u.spans.length >= 2 && u.spans.every((s) => s.startMs === null && s.endMs === null));
  const chars = u.spans.map((s) => u.segs.slice(s.from, s.to).reduce((n, x) => n + x.text.length + 1, 0));
  assert.ok(chars.slice(0, -1).every((c) => c >= 2500 && c <= 5600), chars.join(","));
  console.log(`PASS: an untimed transcript is cut by characters (${u.spans.length} sections, no times)`);
  // The URL source joins the whole transcript into one line: still cut into sections.
  const oneLine = [{ startMs: null, endMs: null, text: segs2h.map((x) => x.text).join(" "), speaker: "" }];
  const joined = m.splitTranscriptSections(oneLine);
  const joinedChars = joined.spans.map((sp) => joined.segs.slice(sp.from, sp.to).reduce((n, x) => n + x.text.length + 1, 0));
  assert.ok(joined.spans.length >= 10, `a space-joined transcript is not one section (${joined.spans.length})`);
  assert.ok(joinedChars.slice(0, -1).every((c) => c >= 2500 && c <= 5600), joinedChars.join(","));
  const noPunct = [{ startMs: null, endMs: null, text: "가나다라 ".repeat(5000), speaker: "" }];
  assert.ok(m.splitTranscriptSections(noPunct).spans.length >= 4, "no sentence ends: cut at spaces");
  console.log(`PASS: a URL transcript joined into one line is cut into ${joined.spans.length} sections of about 4,000 characters`);
}

// ---- the summary note and its grammar ----
const altData = (id = "note-9", kind = "alt-local") => ({ title: "L9", summary: "", pdfUrl: null, transcript: null, parseQuality: "full", metadata: { noteId: id, createdAt: "2026-09-30", visibility: null, sourceKind: kind } });
async function summaryNote(segments, opts = {}) {
  const plan = await m.planTranscript({ segments, sourceId: "note-9", existing: opts.existing, reuse: opts.reuse });
  const fail = new Set(opts.fail ?? []);
  const done = new Map(plan.sections.filter((s) => s.mode === "llm" && !fail.has(s.num)).map((s) => [s.num, { summary: `- 요약 ${s.num} (${s.hash}) [${m.formatClock(s.startMs ?? 0)}]`, gist: `구간 ${s.num} 요지다` }]));
  const result = m.assembleSections(plan, done, new Map([...fail].map((n) => [n, "응답에 이 구간이 없음"])));
  if (opts.warn) result.errors.push({ section: 0, reason: opts.warn });
  const { lectureMarkdown } = new m.NoteGenerator(null).generateTranscriptNote(
    altData(),
    { sections: result.sections, errors: result.errors },
    { processedSummary: "## 흐름\n- 전체 요약 (구간 1~2)", concepts: [], tags: ["parsing"], subjectSuggestion: "CSED423" },
    "CSED423",
    ['alt2obs_usage: {provider: "Claude CLI sonnet", calls: 3}'],
    "alt2obsidian",
    "2026-10-06"
  );
  return { plan, md: lectureMarkdown };
}
const addMemos = (md) => md.replace(/(<!-- alt2obs:section:(\d+) hash:[0-9a-f]{8} end -->\n\n> \[!note\] 내 메모\n> )/g, (_x, head, n) => `${head}memo ${n}`);
function memos(md) {
  const out = {};
  for (const x of md.matchAll(/## ⏱ 구간 (\d+)[^\n]*\n\n<!-- alt2obs:section:\d+ hash:[0-9a-f]{8} start -->[\s\S]*?<!-- alt2obs:section:\d+ hash:[0-9a-f]{8} end -->\n\n> \[!note\] 내 메모\n> ?(.*)/g)) out[x[1]] = x[2].trim();
  return out;
}
let cliRuns = 0;
function mergeBoth(existing, next) {
  const plugin = m.mergeNote(existing, next);
  writeFileSync(join(tmp, "a.md"), existing);
  writeFileSync(join(tmp, "b.md"), next);
  const args = [join(repo, "scripts/phase2/merge-note.mjs"), join(tmp, "a.md"), join(tmp, "b.md")];
  assert.equal(execFileSync("node", args, { encoding: "utf8" }), plugin.merged, "merge-note.mjs equals the plugin merge");
  const summary = JSON.parse(execFileSync("node", [...args, "--summary"], { encoding: "utf8" }));
  assert.equal(summary.mode, plugin.mode);
  assert.deepEqual(summary.deletions, plugin.deletions);
  assert.deepEqual(summary.notes, plugin.notes);
  cliRuns++;
  return plugin;
}

{
  const { plan, md } = await summaryNote(segs2h);
  const fm = md.slice(0, md.indexOf("\n---\n", 4));
  assert.match(fm, /\nalt_kind: "transcript"\n/);
  assert.match(fm, new RegExp(`\\nsection_count: ${plan.sections.length}\\n`));
  assert.match(fm, /\nalt_local_id: "note-9"\nalt_source: "alt-local"\n/);
  assert.ok(!/alt_alignment|slide_count/.test(fm), "no alignment, no slides");
  assert.ok(md.includes("# L9\n\n## 📋 전체 요약\n\n<!-- alt2obs:overview start -->\n### 흐름"), "overview block, headings demoted");
  const s1 = plan.sections[0];
  const s2 = plan.sections[1];
  const h2 = `## ⏱ 구간 2 [${m.formatClock(s2.startMs)}~${m.formatClock(s2.endMs)}]`;
  assert.ok(
    md.includes(`${h2}\n\n<!-- alt2obs:section:2 hash:${s2.hash} start -->\n- 요약 2 (${s2.hash}) [${m.formatClock(s2.startMs)}]\n\n<!-- alt2obs:meta img:none gist:"구간 2 요지다" -->\n<!-- alt2obs:section:2 hash:${s2.hash} end -->\n\n> [!note] 내 메모\n> \n`),
    "heading, markers, summary, meta (gist) and the memo callout outside the markers"
  );
  assert.ok(md.startsWith("---\n") && md.includes(`## ⏱ 구간 1 [00:00~${m.formatClock(s1.endMs)}]`));
  assert.ok(!/[\u2013\u2014]/.test(md), "no en or em dash in the note");
  assert.equal(m.hasMultiManagedMarkers(md), false, "not a slide note");
  assert.equal(m.hasSectionMarkers(md), true);
  assert.deepEqual(m.parseSectionHeading(h2), { num: 2, startMs: Math.floor(s2.startMs / 1000) * 1000, endMs: Math.floor(s2.endMs / 1000) * 1000, text: h2.slice(3), suffix: "", plain: true });
  assert.deepEqual(
    [m.parseSectionHeading("## ⏱ 구간 3 [24:10~36:02] 중요!").suffix, m.parseSectionHeading("## ⏱ 구간 3 [24:10~36:02] 중요!").plain, m.parseSectionHeading("## ⏱ 구간 12").num, m.parseSectionHeading("## 다른 제목")],
    ["중요!", false, 12, null]
  );
  assert.equal(m.headingLinkTarget("⏱ 구간 3 [1:02:03~1:14:00]"), "⏱ 구간 3 1 02 03 1 14 00");
  assert.equal(m.parseClock("1:02:03"), 3723000);
  assert.deepEqual(m.parseExistingSections(md).map((s) => [s.num, s.gist]), plan.sections.map((s) => [s.num, `구간 ${s.num} 요지다`]));
  // An overview or concept warning is about the whole lecture: "전체", not "구간 0".
  const warned = await summaryNote(segs2h, { warn: "개념 추출 실패" });
  assert.ok(warned.md.includes("- 전체: 개념 추출 실패") && !warned.md.includes("구간 0"));
  console.log(`PASS: summary note: alt_kind transcript, overview block, "## ⏱ 구간 N [mm:ss~mm:ss]" sections in section markers with the gist meta, memo callouts outside`);

  // Re-import, nothing changed: memos stay, and a second re-import changes nothing.
  const withMemos = addMemos(md);
  const again = mergeBoth(withMemos, md);
  assert.equal(again.mode, "sections");
  assert.deepEqual(memos(again.merged), memos(withMemos));
  assert.deepEqual(again.drifts.concat(again.deletions), [], "nothing moved or orphaned");
  assert.equal(mergeBoth(again.merged, md).merged, again.merged, "idempotent");
  // The reuse plan: every section unchanged, nothing sent.
  const re = await m.planTranscript({ segments: segs2h, sourceId: "note-9", existing: m.parseExistingSections(withMemos), reuse: true });
  assert.deepEqual(re.sections.map((s) => s.mode), plan.sections.map(() => "reuse"));
  assert.deepEqual(re.batches, []);
  const off = await m.planTranscript({ segments: segs2h, sourceId: "note-9", existing: m.parseExistingSections(withMemos), reuse: false });
  assert.ok(off.sections.every((s) => s.mode === "llm" && s.previous && s.previous.hash === s.hash), "setting off: regenerate, previous kept for failures");

  // One section's transcript changed: only it is regenerated; its memo stays (same number).
  const changedSegs = lecture(120, (_i, t) => t >= plan.sections[2].startMs && t < plan.sections[2].startMs + MIN);
  const changed = await summaryNote(changedSegs, { existing: m.parseExistingSections(withMemos), reuse: true });
  assert.deepEqual(changed.plan.sections.map((s) => s.mode), plan.sections.map((_, k) => (k === 2 ? "llm" : "reuse")));
  assert.equal(changed.plan.sections[2].previous.num, 3, "falls back to the same number");
  const merged = mergeBoth(withMemos, changed.md);
  assert.deepEqual(memos(merged.merged), memos(withMemos), "every memo kept");
  assert.deepEqual(merged.drifts.map((d) => d.slideNum), [3]);
  assert.ok(merged.merged.includes(`- 요약 3 (${changed.plan.sections[2].hash})`) && merged.merged.includes(`- 요약 1 (${plan.sections[0].hash})`), "changed section new, others reused");

  // A shorter recording: the sections that are gone keep their memos at the end.
  const short = await summaryNote(lecture(60));
  const cut = mergeBoth(withMemos, short.md);
  const kept = memos(cut.merged);
  assert.equal(Object.keys(kept).length, short.plan.sections.length);
  assert.ok(cut.merged.includes("## 🗑️ 사라진 구간 (orphan)"));
  for (const d of cut.deletions) assert.ok(cut.merged.includes(`<!-- alt2obs:orphan section:${d.slideNum} hash:${d.hash} -->\n> [!note] 내 메모\n> memo ${d.slideNum}`), `memo ${d.slideNum} kept in the orphan section`);
  assert.ok(cut.confirmDeckReplacement === false || cut.deletions.length > plan.sections.length / 2);
  // User text above and below the overview block is kept.
  const userText = withMemos.replace("# L9\n\n", "# L9\n\n내가 쓴 머리말\n\n");
  assert.ok(mergeBoth(userText, md).merged.includes("내가 쓴 머리말\n\n## 📋 전체 요약"));
  // A freshly written note re-imported unchanged is byte for byte the same file.
  assert.equal(mergeBoth(md, md).merged, md, "first re-import of an unchanged note changes nothing");
  // Text the user added after a heading's time range is kept.
  const hh = md.match(/## ⏱ 구간 3 [^\n]*/)[0];
  const tagged = withMemos.replace(hh, `${hh} 시험 범위`);
  const keptTag = mergeBoth(tagged, md).merged;
  assert.ok(keptTag.includes(`${hh} 시험 범위\n`), "the user's text after the range stays on the heading");
  assert.equal(mergeBoth(keptTag, md).merged, keptTag);
  // A memo line that looks like a heading stays in its memo, in place.
  const lookalike = withMemos.replace("> memo 2\n", "> memo 2\n\n## ⏱ 구간 3 다시 볼 것\n");
  const keptLook = mergeBoth(lookalike, md).merged;
  assert.ok(/> memo 2\n\n## ⏱ 구간 3 다시 볼 것\n\n## ⏱ 구간 3 \[/.test(keptLook), "the user's line stays under memo 2, before section 3");
  // The failure list is replaced on re-import, not kept in the last section's memo.
  const failing = await summaryNote(segs2h, { fail: [2] });
  assert.ok(failing.md.includes("<!-- alt2obs:failures start -->\n## ⚠️ 처리 실패 구간\n\n- 구간 2:"));
  const healed = mergeBoth(failing.md, md).merged;
  assert.ok(!healed.includes("처리 실패 구간") && !healed.includes("alt2obs:failures"), "a clean re-import drops the old list");
  const twice = mergeBoth(failing.md, failing.md).merged;
  assert.equal((twice.match(/처리 실패 구간/g) ?? []).length, 1, "one list, the new one");
  assert.equal(twice, failing.md);
  // A note saved with CRLF merges like any other, and is written back with CRLF.
  const crlf = mergeBoth(withMemos.replace(/\n/g, "\r\n"), md).merged;
  assert.deepEqual(memos(crlf.replace(/\r\n/g, "\n")), memos(withMemos));
  assert.ok(crlf.includes("\r\n") && !crlf.replace(/\r\n/g, "").includes("\n"), "every line ends in CRLF");
  // Two old sections became one new section: the second memo goes under it, labelled, not under 사라진 구간.
  const handMade = (sections) =>
    new m.NoteGenerator(null).generateTranscriptNote(altData(), { sections: sections.map(([num, hash, a, b]) => ({ num, hash, startMs: a * MIN, endMs: b * MIN, summary: `- 요약 ${num}` })), errors: [] }, { processedSummary: "", concepts: [], tags: [], subjectSuggestion: "S" }, "S", [], "alt2obsidian", "2026-10-06").lectureMarkdown;
  const three = addMemos(handMade([[1, "aaaaaaaa", 0, 10], [2, "bbbbbbbb", 10, 20], [3, "cccccccc", 20, 30]]));
  const two = handMade([[1, "aaaaaaaa", 0, 10], [2, "dddddddd", 10, 30]]);
  const joinedNote = mergeBoth(three, two);
  assert.ok(joinedNote.merged.includes("> memo 2\n\n<!-- alt2obs:merged section:3 hash:cccccccc -->\n**이전 구간 3 [20:00~30:00]의 메모**\n\n> [!note] 내 메모\n> memo 3"), "memo 3 under the merged section, labelled");
  assert.ok(!joinedNote.merged.includes("사라진 구간"));
  assert.deepEqual(joinedNote.deletions, []);
  assert.ok(joinedNote.notes.some((n) => n.includes("구간 3의 메모를 구간 2 아래로")));
  assert.equal(mergeBoth(joinedNote.merged, two).merged, joinedNote.merged, "stable on the next re-import");
  // Section boundaries moved (a stretch of the recording dropped): memos follow the shared time, not the number.
  const dropped = plan.sections[3];
  const shifted = segs2h
    .filter((x) => x.startMs < dropped.startMs || x.startMs > dropped.endMs)
    .map((x) => (x.startMs > dropped.endMs && x.startMs < plan.sections[4].endMs ? { ...x, text: `${x.text} 덧붙임` } : x));
  const moved = await summaryNote(shifted);
  const next4 = moved.plan.sections.find((x) => x.startMs === plan.sections[4].startMs);
  assert.ok(next4 && next4.num === 4 && next4.hash !== plan.sections[4].hash, "old section 5 is now section 4 with new text");
  const byTime = mergeBoth(withMemos, moved.md);
  assert.equal(memos(byTime.merged)["4"], "memo 5", "section 4 gets the memo of the section it overlaps");
  assert.ok(byTime.merged.includes("## 🗑️ 사라진 구간 (orphan)") && byTime.merged.includes("memo 4"), "the dropped section's memo is kept");
  // A summary that cites times is reused only for a section that starts at the same second.
  const shiftedStart = await m.planTranscript({ segments: segs2h, sourceId: "note-9", existing: m.parseExistingSections(withMemos).map((x) => ({ ...x, startMs: x.num === 2 ? 0 : x.startMs })), reuse: true });
  assert.deepEqual(shiftedStart.sections.map((x) => x.mode), plan.sections.map((_, i) => (i === 1 ? "llm" : "reuse")));
  // Text written under a section heading, and a section whose end marker was deleted, stay where they were.
  const h3 = md.match(/## ⏱ 구간 3 [^\n]*/)[0];
  const underHeading = withMemos.replace(`${h3}\n\n`, `${h3}\n\n제목 아래 내가 쓴 글\n\n`);
  const kept2 = mergeBoth(underHeading, md).merged;
  assert.ok(kept2.includes(`${h3}\n\n제목 아래 내가 쓴 글\n\n<!-- alt2obs:section:3 `), "text under the heading kept in place");
  assert.equal(mergeBoth(kept2, md).merged, kept2, "and stays on the next re-import");
  const s4 = plan.sections[3];
  const broken = withMemos.replace(`<!-- alt2obs:section:4 hash:${s4.hash} end -->`, "");
  const fromBroken = mergeBoth(broken, md).merged;
  assert.ok(fromBroken.includes("memo 4") && fromBroken.includes("memo 5"), "a section without its end marker keeps its text and memo");
  assert.equal((fromBroken.match(/<!-- alt2obs:section:4 hash:[0-9a-f]{8} start -->/g) ?? []).length, 1, "its leftover markers are not copied");
  assert.equal(mergeBoth(fromBroken, md).merged, fromBroken, "stable on the next re-import");
  console.log("PASS: re-import merge: unchanged note untouched, only changed sections regenerated, memos follow their section (hash, else number), memos of removed sections kept under 사라진 구간");

  // The older (2.0.0-beta.5) lecture-level note of the same lecture: kept whole as a backup.
  const legacy = '---\ntitle: "L9"\nalt_local_id: "note-9"\n---\n<!-- alt2obsidian:start -->\n# L9\n옛 요약\n<!-- alt2obsidian:end -->\n\n## 내 메모\n내가 쓴 메모\n';
  const fromLegacy = mergeBoth(legacy, md);
  assert.ok(fromLegacy.merged.startsWith(md.trimEnd()) && fromLegacy.merged.includes("## 이전 노트 백업") && fromLegacy.merged.includes("내가 쓴 메모"));
  assert.ok(fromLegacy.merged.includes('```yaml\n---\ntitle: "L9"\nalt_local_id: "note-9"\n---\n```'), "the old frontmatter is fenced in the backup");
  assert.ok(fromLegacy.merged.includes("전사 구간 요약 노트로 바뀌기 전의 강의 노트입니다"));
  assert.deepEqual(fromLegacy.notes, [m.TRANSCRIPT_MIGRATION_NOTE]);

  // A summary note never becomes a single block (refused like a slide note).
  assert.throws(() => m.mergeNote(withMemos, legacy), /전사 구간별 요약인데/);

  // A PDF was attached: the summary note becomes a slide note; every memo is kept in the backup.
  const slideNote = await (async () => {
    const slides = [];
    for (let i = 1; i <= 3; i++) slides.push({ slideNum: i, hash: await m.computeSlideHash(`slide ${i}`, i, "note-9"), commentary: `해설 ${i}`, citedConcepts: [] });
    return (await new m.NoteGenerator(null).generatePageAnchored(altData(), { slides, errors: [], totalWallTimeMs: 0, perSlideWallTimeMs: [] }, { processedSummary: "새 요약", concepts: [], tags: [], subjectSuggestion: "S" }, "S", ['alt_pdf_source: "attached"'])).lectureMarkdown;
  })();
  const converted = mergeBoth(userText, slideNote);
  assert.equal(converted.mode, "multi");
  assert.ok(converted.merged.startsWith(slideNote.trimEnd()), "the slide note first");
  for (const n of Object.keys(memos(withMemos))) assert.ok(converted.merged.includes(`memo ${n}`), `memo ${n} kept`);
  assert.ok(converted.merged.includes("내가 쓴 머리말"), "user text kept");
  assert.deepEqual(converted.notes, [m.TRANSCRIPT_TO_SLIDES_NOTE]);
  assert.ok(!/^alt_kind:/m.test(converted.merged.slice(0, converted.merged.indexOf("\n---\n", 4))), "the frontmatter is the slide note's");
  // And back: a slide note is never turned into a summary note.
  assert.throws(() => m.mergeNote(converted.merged, md), /슬라이드별 형식인데/);
  console.log("PASS: an older lecture-level note is backed up whole; a summary note becomes a slide note with its whole text (memos, own text) under 이전 노트 백업; downgrades refused");
}

// ---- pipeline with the fake claude: one batch, overview, concepts ----
{
  const s = fakeSession("ok");
  const job = m.createJobDir();
  try {
    const usage = new m.UsageTracker();
    const llm = new m.ClaudeCliProvider({ bin: FAKE_CLAUDE, model: "sonnet", effort: "low", timeoutMs: 30000, workDir: job, usage, task: "commentary", ownsWorkDir: false });
    const plan = await m.planTranscript({ segments: segs2h, sourceId: "note-9" });
    const context = { title: "L9", subjectTags: ["parsing"], knownConcepts: ["캐시"] };
    const est = m.estimateTranscriptSummary(plan, context, "", "claude-cli", "claude-cli", { commentaryEffort: "low", conceptEffort: "low" });
    // Section output with reasoning: the visible 150 to 800 tokens times 2.4, as the slide refit.
    assert.deepEqual([m.sectionOutputTokens(0), m.sectionOutputTokens(1000), m.sectionOutputTokens(10000)], [360, 768, 1920]);
    assert.equal(plan.batches.length, 1, "a 2 hour lecture fits one call");
    assert.equal(est.calls, 3);
    assert.equal(est.sectionsGenerated, plan.sections.length);
    const run = await m.runTranscriptSummary({ plan, context, subject: "CSED423", language: "ko", altSummary: "", commentaryLlm: llm, conceptLlm: llm });
    assert.equal(s.calls().length, est.calls, "estimated call count");
    assert.equal(run.sectionsResult.generatedCount, plan.sections.length);
    assert.ok(run.overview.includes("요약 텍스트"), "overview from the gists");
    assert.ok(s.calls()[1].stdin.includes(`구간 1 [00:00]: 구간 1의 요지다`), "the overview gets the section gists");
    assert.deepEqual(run.concepts.map((c) => c.name), ["캐시", "캐시 일관성"]);
    const first = s.calls()[0];
    assert.ok(first.stdin.includes("[강의 공통 맥락]") && first.stdin.includes("### 구간 1 [00:00~") && first.stdin.includes("[전사 (음성 인식, 군말과 반복 제거)]"));
    assert.ok(first.argv.includes("--system-prompt") && first.argv[first.argv.indexOf("--system-prompt") + 1].includes("STT"), "the section instructions");
    // A section of announcements gets one short line on purpose: accepted, not retried.
    const short = m.checkSectionAnswer({ sections: [{ section: 1, summary: "- 수업 안내뿐임 [00:12]", gist: "수업 안내다" }, { section: 2, summary: "-", gist: "x" }] }, plan.sections.slice(0, 2));
    assert.deepEqual([Array.from(short.ok.keys()), Array.from(short.failed.keys())], [[1], [2]]);
    // A section missing from the answer is asked for once more, alone.
    process.env.FAKE_CLI_MODE = "dropsection:2";
    rmSync(process.env.FAKE_CLI_STATE, { force: true });
    const n0 = s.calls().length;
    const retry = await m.runTranscriptSummary({ plan, context, subject: "CSED423", language: "ko", altSummary: "", commentaryLlm: llm, conceptLlm: llm });
    assert.equal(s.calls().length - n0, est.calls + 1);
    assert.equal(retry.sectionsResult.generatedCount, plan.sections.length);
    // Never answered: the previous summary is kept (re-import), listed as a failure.
    process.env.FAKE_CLI_MODE = "dropsectionalways:3";
    const prevPlan = await m.planTranscript({ segments: segs2h, sourceId: "note-9", existing: [{ num: 3, hash: plan.sections[2].hash, body: "이전 요약 3", gist: "이전 요지" }], reuse: false });
    const kept = await m.runTranscriptSummary({ plan: prevPlan, context, subject: "CSED423", language: "ko", altSummary: "", commentaryLlm: llm, conceptLlm: llm });
    assert.deepEqual(kept.sectionsResult.keptPrevious, [3]);
    assert.equal(kept.sectionsResult.sections[2].summary, "이전 요약 3");
    assert.match(kept.sectionsResult.errors[0].reason, /이전 요약을 유지/);
    process.env.FAKE_CLI_MODE = "ok";
    console.log(`PASS: pipeline: ${plan.sections.length} sections in one batch + overview + concepts = ${est.calls} calls as estimated; a dropped section is retried once; a failed one keeps its previous summary`);
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- verification against transcript sections ----
{
  const { plan, md } = await summaryNote(segs2h);
  const timed = segs2h.map((x) => ({ startMs: x.startMs, endMs: x.endMs, text: x.text }));
  const sections = m.verifySectionsFromNote(md, timed);
  assert.equal(sections.length, plan.sections.length);
  assert.ok(sections.every((x, k) => x.heading?.startsWith(`⏱ 구간 ${k + 1} [`) && x.gist === `구간 ${k + 1} 요지다`));
  const note = "# 내 노트\n- lalr merging은 yacc가 쓰는 방식이다\n- shift reduce handle 개념을 배웠다 (거짓)\n- 양자 얽힘은 무관한 주장이다\n";
  const vp = m.planVerification({ lecture: "L9", notePath: "Alt2Obsidian/CSED423/Lectures/L9.md", noteMarkdown: note, slideTexts: [], transcript: { segments: timed, spans: null }, sections });
  assert.equal(vp.unit, "section");
  assert.equal(vp.hasTranscript, true);
  const lalr = vp.claims[0];
  const lalrSection = plan.sections.findIndex((x) => x.startMs <= 105 * MIN && (x.endMs ?? 0) > 105 * MIN) + 1;
  assert.equal(lalr.slides[0].slide, lalrSection, "the section where LALR is taught");
  assert.ok(lalr.slides[0].startMs >= plan.sections[lalrSection - 1].startMs, "with the time it was said");
  assert.deepEqual(lalr.transcript, [], "no separate transcript evidence");
  const prompt = m.buildJudgePrompt("L9", vp.batches[0], "section");
  assert.match(prompt, new RegExp(`- 구간 ${lalrSection} \\[\\d\\d?:\\d\\d(:\\d\\d)?\\]: .*lalr`));
  assert.ok(!prompt.includes("슬라이드"));
  assert.ok(m.buildJudgeSystemPrompt("section").includes("STT") && m.buildJudgeSystemPrompt("section").includes("전사 불확실"));
  assert.equal(m.buildJudgeSystemPrompt(), m.buildJudgeSystemPrompt("slide"), "the slide path is unchanged");
  const missing = m.buildMissingPrompt(vp);
  assert.ok(missing && /- 구간 \d+ \[\d\d:\d\d~/.test(missing) && missing.includes("요지다"), "uncovered sections with their gist");
  const s = fakeSession("ok");
  const job = m.createJobDir();
  try {
    const llm = new m.ClaudeCliProvider({ bin: FAKE_CLAUDE, model: "sonnet", effort: "low", timeoutMs: 20000, workDir: job, ownsWorkDir: false });
    const est = m.estimateVerification(vp, "claude-cli", "low");
    const result = await m.runVerification(vp, llm);
    assert.equal(s.calls().length, est.calls);
    assert.equal(s.calls()[0].argv[s.calls()[0].argv.indexOf("--system-prompt") + 1], m.buildJudgeSystemPrompt("section"));
    const out = m.renderVerificationNote(result, { source: "[[내 노트]]", date: "2026-10-06", usageLine: null, model: "Claude CLI" });
    const sec = sections[lalrSection - 1];
    assert.ok(out.includes(`[[Alt2Obsidian/CSED423/Lectures/L9#${m.headingLinkTarget(sec.heading)}|L9 · 구간 ${lalrSection}]] [`), "evidence links to the section heading and the time");
    assert.ok(out.includes("녹음 전사(음성 인식)뿐입니다"));
    assert.equal(m.verdictCounts(result)["틀림"], 1);
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
  // Section numbers are the note's own, also when one was deleted by hand.
  const gappy = sections.filter((x) => x.num !== 3);
  const vg = m.planVerification({ lecture: "L9", notePath: "V/L9.md", noteMarkdown: note, slideTexts: [], transcript: { segments: timed, spans: null }, sections: gappy });
  const hit = vg.claims[0].slides[0];
  assert.equal(hit.slide, lalrSection, "the lalr section keeps its number with section 3 gone");
  assert.ok(!vg.uncovered.some((u) => u.slide === 3));
  // A lecture-level note without section headings: the import's split, links without a heading.
  const plain = m.verifySectionsFromNote("# L9\n본문\n", timed);
  assert.equal(plain.length, plan.sections.length);
  assert.ok(plain.every((x) => x.heading === null));
  const vp2 = m.planVerification({ lecture: "L9", notePath: "V/L9.md", noteMarkdown: note, slideTexts: [], transcript: { segments: timed, spans: null }, sections: plain });
  assert.equal(m.sectionLink({ title: "L9", path: "V/L9.md", sections: vp2.sections }, 2), "[[V/L9|L9 · 구간 2]]");
  console.log("PASS: verification without slides: transcript sections are the evidence (BM25 + glossary), prompts say 구간 N [mm:ss] and STT, links go to the section headings, the slide path is unchanged");
}

// ---- PDF attach helpers, PDF redirect ----
{
  const enc = (t) => new TextEncoder().encode(t).buffer;
  assert.equal(m.looksLikePdf(enc("%PDF-1.7\n...")), true);
  assert.equal(m.looksLikePdf(enc("\n\n%PDF-1.4")), true, "a little junk before the header");
  assert.equal(m.looksLikePdf(enc("hello, not a pdf")), false);
  assert.equal(m.attachedPdfPath("A/S/Lectures/L9.md"), "A/S/Lectures/L9.pdf");
  let read = false;
  await assert.rejects(m.readPickedFile({ name: "huge.pdf", size: m.MAX_ATTACH_BYTES + 1, arrayBuffer: async () => ((read = true), new ArrayBuffer(1)) }), /너무 큽니다/);
  assert.equal(read, false, "an oversized file is refused before it is read");
  assert.deepEqual(m.preservedFrontmatterLines({ alt_local_id: "l", alt_pdf_source: "attached" }, "alt-url", null), ['alt_local_id: "l"', 'alt_pdf_source: "attached"'], "the attached mark is carried over");
  assert.equal(m.markedAttached('---\ntitle: "L9"\nalt_pdf_source: "attached"\n---\nbody'), true, "read from the note text, not a lagging cache");
  assert.equal(m.markedAttached('\uFEFF---\r\nalt_pdf_source: attached\r\n---\r\n'), true);
  assert.equal(m.markedAttached("---\ntitle: x\n---\nalt_pdf_source: \"attached\"\n"), false, "only in the frontmatter");
  assert.equal(m.markedAttached(null), false);
  const picked = await m.readPickedFile(new File([new Uint8Array([37, 80, 68, 70, 45, 49])], "lec9.pdf"));
  assert.equal(picked.kind, "disk");
  assert.equal(picked.name, "lec9.pdf");
  assert.deepEqual(Array.from(new Uint8Array(picked.data)), [37, 80, 68, 70, 45, 49], "read into memory, no File.path");
  // A PDF next to a summary note opens as a plain PDF until the note is a slide note.
  const look = (fm) => ({ exists: () => true, frontmatter: () => fm, read: async () => "" });
  assert.equal(await m.lectureNoteForPdf("A/L9.pdf", look({ alt_local_id: "x", alt_kind: "transcript" })), null);
  assert.equal(await m.lectureNoteForPdf("A/L9.pdf", look({ alt_local_id: "x" })), "A/L9.md");
  console.log("PASS: PDF attach: header check, disk file read into an ArrayBuffer, sibling path; a summary note's PDF is not redirected to the viewer");
}

console.log(`PASS: merge-note.mjs matched the plugin merge in all ${cliRuns} transcript merges`);
