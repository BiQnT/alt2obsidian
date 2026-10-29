/**
 * Test: the lecture brief's script part (2.1.0 spec 4.1 to 4.4, src/brief):
 * built from a slide note, a transcript summary note, a lecture-level note
 * and a 1.x note without gists; wikilinks unwrapped; the three hashes; a
 * brief the user edited is kept; the AI sections are carried over when the
 * note changes; the size cap; the subject brief; lecture order; briefs are
 * never taken for lecture notes. No tokens, no obsidian.
 * Run: node test/test-brief.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";

const m = await importTs("test/helpers/brief-entry.ts");
const TODAY = "2026-10-29";
const NOTE = "Alt2Obsidian/CSED423/Lectures/L5.md";

/** A slide note in the plugin's 2.0 format. */
function slideNote({ gist14 = "같은 문장 x - 2 * y도 유도 방식에 따라 parse tree와 평가 순서가 달라진다.", overviewExtra = "", crlf = false } = {}) {
  const slide = (n, body, gist) => [
    `## 📚 슬라이드 ${n}`,
    "",
    `<!-- alt2obs:slide:${n} hash:${String(n).padStart(8, "a")} start -->`,
    body,
    "",
    gist === null ? "" : m.formatSlideMeta(null, gist),
    `<!-- alt2obs:slide:${n} hash:${String(n).padStart(8, "a")} end -->`,
    "",
    "> [!note] 내 메모",
    "> ",
    "",
  ].join("\n");
  const text = [
    "---",
    'title: "L5"',
    'subject: "CSED423"',
    "tags: [csed423]",
    'date: "2026-10-01"',
    'source: "alt2obsidian"',
    "slide_count: 3",
    'alt_created: "2026-09-30"',
    'alt_local_id: "01a0a896-9b8d-76da-bc0f-02710d511217"',
    'alt_alignment: "14:1586-1718 15:1718-1739? 16:1739-1800"',
    "---",
    "# L5",
    "",
    "## 📋 전체 요약",
    "",
    "<!-- alt2obs:overview start -->",
    "### 개요",
    "Parse tree와 [[Derivation (유도)|Derivation]] 순서가 평가에 주는 영향을 다룬다." + overviewExtra,
    "",
    "### 핵심 개념",
    "- **Leftmost Derivation:** 가장 왼쪽 [[Nonterminal (비단말)]]부터 바꾸는 유도다.",
    "",
    "### 흐름",
    "1. Derivation과 parse tree (슬라이드 14~16)",
    "<!-- alt2obs:overview end -->",
    "",
    slide(14, "같은 문장도 [[Derivation (유도)|유도]]에 따라 다르다.\n\n![[Alt2Obsidian/CSED423/Attachments/L5-14.png]]", gist14),
    slide(15, "Leftmost Derivation의 parse tree는 곱셈을 먼저 하는 `x - (2 * y)`로 평가된다. 두 번째 문장이다.", null),
    slide(16, "> [!definition] Rightmost\n> 오른쪽부터 바꾼다.", "Rightmost Derivation은 가장 오른쪽 nonterminal부터 바꾼다."),
  ].join("\n");
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

// ---- slide note: the format of spec 4.2 ----
{
  const script = await m.buildBriefScript(NOTE, slideNote());
  assert.equal(script.kind, "slides");
  assert.equal(script.subject, "CSED423");
  assert.equal(script.altLocalId, "01a0a896-9b8d-76da-bc0f-02710d511217");
  const text = await m.composeBrief(script, null, TODAY);
  const fm = m.readFrontmatter(text);
  assert.deepEqual(
    Object.keys(fm),
    ["alt2obs_brief", "lecture", "subject", "lecture_alt_local_id", "kind", "source_hash", "ai_hash", "ai_part", "body_hash", "built", "size_tokens"],
    "the frontmatter keys of spec 4.2, in order"
  );
  assert.equal(fm.lecture_alt_local_id, "01a0a896-9b8d-76da-bc0f-02710d511217");
  assert.ok(!/^alt_local_id:/m.test(text), "never alt_local_id: that key finds the lecture note (imports, the Skill, Dataview)");
  assert.deepEqual([fm.alt2obs_brief, fm.lecture, fm.kind, fm.ai_hash, fm.ai_part, fm.built], ["1", NOTE, "slides", "", '{status: "none"}', TODAY]);
  assert.match(fm.source_hash, /^[0-9a-f]{8}$/);
  assert.match(fm.body_hash, /^[0-9a-f]{8}$/);
  const body = m.bodyOf(text);
  assert.equal(
    body,
    [
      "# L5 brief",
      "",
      "## 개요",
      "Parse tree와 Derivation 순서가 평가에 주는 영향을 다룬다.",
      "",
      "## 흐름",
      "1. Derivation과 parse tree (슬라이드 14~16)",
      "",
      "## 슬라이드 지도",
      "- 14 [26:26~28:38] 같은 문장 x - 2 * y도 유도 방식에 따라 parse tree와 평가 순서가 달라진다.",
      "- 15 [28:38~28:59?] Leftmost Derivation의 parse tree는 곱셈을 먼저 하는 x - (2 * y)로 평가된다.",
      "- 16 [28:59~30:00] Rightmost Derivation은 가장 오른쪽 nonterminal부터 바꾼다.",
      "",
      "## 핵심 개념",
      "- **Leftmost Derivation:** 가장 왼쪽 Nonterminal (비단말)부터 바꾸는 유도다.",
      "",
    ].join("\n")
  );
  assert.doesNotMatch(body, /\[\[|\]\]/, "no wikilinks in a brief");
  assert.equal(Number(fm.size_tokens), m.estimateTextTokens(body));
  // The gist's escaped "-" (- in the meta comment) comes back as "-"; a slide without a gist uses its first sentence.
  assert.match(slideNote(), /x \\u002d 2/);
  // CRLF notes give the same brief.
  const crlf = await m.buildBriefScript(NOTE, slideNote({ crlf: true }));
  assert.equal(crlf.sourceHash, script.sourceHash, "CRLF and LF: the same source");
  console.log("PASS: slide note brief: frontmatter keys, 개요/흐름/슬라이드 지도/핵심 개념, times from alt_alignment (uncertain ?), gist escapes, first-sentence fallback, no wikilinks");
}

// ---- transcript summary note and lecture-level note (spec 4.2 kinds) ----
{
  const section = (n, start, end, summary, gist) => [
    `## ⏱ 구간 ${n} [${start}~${end}]`,
    "",
    `<!-- alt2obs:section:${n} hash:${String(n).padStart(8, "b")} start -->`,
    summary,
    "",
    m.formatSlideMeta(null, gist),
    `<!-- alt2obs:section:${n} hash:${String(n).padStart(8, "b")} end -->`,
    "",
    "> [!note] 내 메모",
    "> 내가 쓴 메모",
    "",
  ].join("\n");
  const transcript = [
    "---",
    'title: "6강"',
    'subject: "CSED5"',
    'alt_kind: "transcript"',
    "section_count: 2",
    "---",
    "# 6강",
    "",
    "## 📋 전체 요약",
    "",
    "<!-- alt2obs:overview start -->",
    "### 개요",
    "캐시를 다룬다.",
    "<!-- alt2obs:overview end -->",
    "",
    section(1, "00:00", "12:03", "- 구간 1 요약 [00:10]", "캐시의 필요성을 설명한다."),
    section(2, "12:03", "1:02:03", "- 구간 2 요약", "캐시 일관성을 다룬다."),
  ].join("\n");
  const t = await m.buildBriefScript("Alt2Obsidian/CSED5/Lectures/6강.md", transcript);
  assert.equal(t.kind, "transcript");
  const tb = m.bodyOf(await m.composeBrief(t, null, TODAY));
  assert.match(tb, /## 구간 지도\n- 구간 1 \[00:00~12:03\] 캐시의 필요성을 설명한다\.\n- 구간 2 \[12:03~1:02:03\] 캐시 일관성을 다룬다\./);
  assert.doesNotMatch(tb, /슬라이드 지도|## 흐름/, "no slide map, and no flow when the overview has none");

  // A lecture-level note without an overview block: the first 1500 characters of its managed block.
  const long = "강의 내용 문장이다. ".repeat(200);
  const lecture = ['---', 'title: "L1"', "---", "<!-- alt2obsidian:start -->", "# L1", "", `[[캐시]]를 배운다. ${long}`, "<!-- alt2obsidian:end -->", "", "## 내 메모", ""].join("\n");
  const l = await m.buildBriefScript("Alt2Obsidian/CSED311/L1.md", lecture);
  assert.equal(l.kind, "lecture");
  assert.equal(l.subject, "CSED311", "no subject in the frontmatter: the subject folder's name");
  const headChars = Array.from(l.overview).length;
  assert.ok(headChars <= 1500 && headChars >= 1490, `cut at 1500 characters (${headChars} after trimming)`);
  assert.ok(l.overview.startsWith("캐시를 배운다."), "title line dropped, links unwrapped");
  const lb = m.bodyOf(await m.composeBrief(l, null, TODAY));
  assert.match(lb, /^# L1 brief\n\n## 개요\n캐시를 배운다\./);
  assert.doesNotMatch(lb, /지도|## 흐름/);
  // A lecture-level note with an overview block: overview and key concepts only.
  const withOverview = lecture.replace("<!-- alt2obsidian:start -->", "<!-- alt2obs:overview start -->\n### 개요\n짧은 개요다.\n\n### 핵심 개념\n- **A:** a다.\n\n### 흐름\n1. x\n<!-- alt2obs:overview end -->\n\n<!-- alt2obsidian:start -->");
  const lo = m.bodyOf(await m.composeBrief(await m.buildBriefScript("Alt2Obsidian/CSED311/L1.md", withOverview), null, TODAY));
  assert.equal(lo, "# L1 brief\n\n## 개요\n짧은 개요다.\n\n## 핵심 개념\n- **A:** a다.\n");
  console.log("PASS: transcript note brief (구간 지도 with heading times, h:mm:ss) and lecture-level note brief (managed block head, or overview and key concepts only)");
}

// ---- 1.x note without gists or alignment; an overview without the three headings ----
{
  const old = [
    "---",
    'title: "Old"',
    "---",
    "# Old",
    "",
    "<!-- alt2obs:overview start -->",
    "자유 형식 요약이다. [[A|에이]]를 다룬다.",
    "<!-- alt2obs:overview end -->",
    "",
    "## 📚 슬라이드 1",
    "<!-- alt2obs:slide:1 hash:11111111 start -->",
    "## 소제목\n\n- **첫 불릿:** 첫 문장이다. 둘째 문장이다.",
    "<!-- alt2obs:slide:1 hash:11111111 end -->",
    "",
    "## 📚 슬라이드 2",
    "<!-- alt2obs:slide:2 hash:22222222 start -->",
    "",
    "<!-- alt2obs:slide:2 hash:22222222 end -->",
    "",
    "## 📚 슬라이드 3",
    "<!-- alt2obs:slide:3 hash:33333333 start -->",
    "가".repeat(120),
    "<!-- alt2obs:slide:3 hash:33333333 end -->",
  ].join("\n");
  const s = await m.buildBriefScript("V/S/Old.md", old);
  const b = m.bodyOf(await m.composeBrief(s, null, TODAY));
  assert.equal(b, `# Old brief\n\n## 개요\n자유 형식 요약이다. 에이를 다룬다.\n\n## 슬라이드 지도\n- 1 첫 불릿: 첫 문장이다.\n- 3 ${"가".repeat(70)}\n`, "no times without an alignment; an empty slide is left out; the fallback is cut to 70 characters");
  assert.equal(m.unwrapWikilinks("[[A]] [[B|b]] [[C\\|c]] [[D#h|d]] ![[x.png]] ![a](b.png)"), "A b c d  ");
  // Obsidian's Properties writes single-quoted scalars.
  assert.deepEqual(m.readFrontmatter("---\nsubject: 'CSED''423'\nalt_alignment: '1:0-30 2:30-60?'\nn: 3\n---\nx"), { subject: "CSED'423", alt_alignment: "1:0-30 2:30-60?", n: "3" });
  // A gist with a link (a model may write one) is unwrapped too.
  const linked = old.replace("<!-- alt2obs:slide:2 hash:22222222 start -->\n", `<!-- alt2obs:slide:2 hash:22222222 start -->\n본문\n\n${m.formatSlideMeta(null, "[[Pipeline (파이프라인)|Pipeline]]의 단계를 나눈다.")}\n`);
  assert.match(m.bodyOf(await m.composeBrief(await m.buildBriefScript("V/S/Old.md", linked), null, TODAY)), /\n- 2 Pipeline의 단계를 나눈다\.\n/);
  console.log("PASS: 1.x note without gists or alignment (first sentence, empty slide left out), free-form overview, wikilink forms");
}

// ---- hashes, user edits, AI sections carried over (spec 4.3, 4.4) ----
{
  const script = await m.buildBriefScript(NOTE, slideNote());
  const again = await m.buildBriefScript(NOTE, slideNote());
  assert.equal(again.sourceHash, script.sourceHash, "the same note: the same source hash");
  const changedGist = await m.buildBriefScript(NOTE, slideNote({ gist14: "바뀐 요지다." }));
  assert.notEqual(changedGist.sourceHash, script.sourceHash, "a gist changed: another source hash");
  const changedOverview = await m.buildBriefScript(NOTE, slideNote({ overviewExtra: " 한 문장 더." }));
  assert.notEqual(changedOverview.sourceHash, script.sourceHash, "the overview changed");
  const realigned = await m.buildBriefScript(NOTE, slideNote().replace("16:1739-1800", "16:1739-1900"));
  assert.notEqual(realigned.sourceHash, script.sourceHash, "the alignment changed");

  const first = await m.planBriefUpdate(null, script, { today: TODAY });
  assert.equal(first.action, "write");
  assert.equal(await m.isEditedBrief(first.text), false);
  assert.deepEqual(await m.planBriefUpdate(first.text, again, { today: "2026-11-01" }), { action: "keep", reason: "same" }, "unchanged source: the file is not touched");
  assert.equal(await m.briefStatus(first.text, again), "ok");
  assert.equal(await m.briefStatus(first.text, changedGist), "outdated");
  assert.equal(await m.briefStatus(null, script), "missing");

  // The user edits the body: kept; the panel says "edited", or "edited-stale" once the note changed.
  const edited = first.text.replace("## 핵심 개념", "## 핵심 개념\n- 내가 더한 줄");
  assert.equal(await m.isEditedBrief(edited), true);
  assert.equal(await m.briefStatus(edited, again), "edited");
  assert.equal(await m.briefStatus(edited, changedGist), "edited-stale");
  assert.deepEqual(await m.planBriefUpdate(edited, changedGist, { today: TODAY }), { action: "keep", reason: "edited" }, "an import never overwrites the user's brief");
  const forced = await m.planBriefUpdate(edited, changedGist, { today: TODAY, force: true });
  assert.equal(forced.action, "write", "새로 만들기 (after the user confirms) overwrites");
  assert.doesNotMatch(forced.text, /내가 더한 줄/);
  // Only the body counts: Obsidian rewriting the frontmatter is not an edit; line ends and trailing space are not either.
  assert.equal(await m.isEditedBrief(first.text.replace('alt2obs_brief: 1', 'alt2obs_brief: 1\ncssclasses: []')), false);
  assert.equal(await m.isEditedBrief(first.text.replace(/\n/g, "\r\n") + "\n\n"), false);
  assert.equal(await m.isEditedBrief("# 내 파일\n"), true, "a file that is not a brief counts as the user's");

  // AI sections (phase 2 writes them) are carried over when only the script part changes.
  const ai = "## 강조점\n- [33:10] 슬라이드 17: 작은 수끼리 먼저 더한다.\n\n## 헷갈리기 쉬운 점\n- 평가 순서와 유도 순서는 다르다.";
  const withAi = await m.composeBrief(script, { sections: ai, hash: "3b10c2d4", part: '{status: "ok", model: "claude-haiku-5-5", input: 4120, output: 760}' }, TODAY);
  assert.equal(await m.isEditedBrief(withAi), false);
  assert.equal(m.aiSectionsOf(m.bodyOf(withAi)), ai);
  const next = await m.planBriefUpdate(withAi, changedGist, { today: TODAY });
  assert.equal(next.action, "write");
  const nfm = m.readFrontmatter(next.text);
  assert.deepEqual([nfm.ai_hash, nfm.ai_part, nfm.source_hash], ["3b10c2d4", '{status: "ok", model: "claude-haiku-5-5", input: 4120, output: 760}', changedGist.sourceHash]);
  assert.ok(m.bodyOf(next.text).endsWith(`## 핵심 개념\n- **Leftmost Derivation:** 가장 왼쪽 Nonterminal (비단말)부터 바꾸는 유도다.\n\n${ai}\n`), "script part rebuilt, AI sections after it as they were");
  assert.match(m.bodyOf(next.text), /- 14 \[26:26~28:38\] 바뀐 요지다\./);
  // A brief of the first build (format 1, the lecture's id as alt_local_id) is rebuilt once: the format version is in the source hash.
  assert.equal(m.BRIEF_FORMAT_VERSION, 2);
  const firstBuild = first.text.replace(/^lecture_alt_local_id:/m, "alt_local_id:").replace(/^source_hash: "[0-9a-f]{8}"$/m, 'source_hash: "0badf00d"');
  const migrated = await m.planBriefUpdate(firstBuild, script, { today: TODAY });
  assert.equal(migrated.action, "write");
  assert.ok(!/^alt_local_id:/m.test(migrated.text) && /^lecture_alt_local_id:/m.test(migrated.text), "the old key is gone");
  // An AI part that found nothing (or failed) has no sections: its hash and status still go along.
  const failed = await m.composeBrief(script, { sections: "", hash: "77aa77aa", part: '{status: "failed", model: "claude-haiku-5-5"}' }, TODAY);
  const kept = m.readFrontmatter((await m.planBriefUpdate(failed, changedGist, { today: TODAY })).text);
  assert.deepEqual([kept.ai_hash, kept.ai_part], ["77aa77aa", '{status: "failed", model: "claude-haiku-5-5"}'], "ai_hash and ai_part carried without sections");
  // The chat body: no frontmatter, no title.
  assert.ok(m.briefChatBody(withAi).startsWith("## 개요\nParse tree와"));
  console.log("PASS: source/AI/body hashes, unchanged source left alone, user edits detected and kept (forced rebuild overwrites), AI sections carried with ai_hash and ai_part");
}

// ---- size cap: gists cut to 40 characters past 4000 tokens ----
{
  const slides = Array.from({ length: 120 }, (_, i) => {
    const n = i + 1;
    return [`## 📚 슬라이드 ${n}`, `<!-- alt2obs:slide:${n} hash:${String(n).padStart(8, "c")} start -->`, "해설.", m.formatSlideMeta(null, `${n}번 슬라이드의 요지는 이렇게 아주 길게 이어지는 한 문장으로 쓰여 있어서 마흔 자를 훌쩍 넘는다.`), `<!-- alt2obs:slide:${n} hash:${String(n).padStart(8, "c")} end -->`].join("\n");
  });
  const big = ["---", 'title: "Big"', "---", "# Big", "", ...slides].join("\n");
  const script = await m.buildBriefScript("V/S/Lectures/Big.md", big);
  assert.ok(m.estimateTextTokens(m.renderBriefBody(script, "", null)) > m.BRIEF_TOKEN_CAP, "the full body is over the cap");
  const body = m.bodyOf(await m.composeBrief(script, null, TODAY));
  const line = body.split("\n").find((l) => l.startsWith("- 1 "));
  assert.equal(line, `- 1 ${Array.from("1번 슬라이드의 요지는 이렇게 아주 길게 이어지는 한 문장으로 쓰여 있어서 마흔 자를 훌쩍 넘는다.").slice(0, 40).join("").trim()}`);
  console.log("PASS: a brief over 4000 tokens cuts its slide map gists to 40 characters");
}

// ---- the store: write on import, subject brief, lecture order (spec 4.4) ----
{
  const files = new Map();
  const writes = [];
  const store = {
    read: async (p) => (files.has(p) ? files.get(p) : null),
    write: async (p, t) => void (writes.push(p), files.set(p, t)),
    list: async (folder) => [...files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/") && p.endsWith(".md")),
  };
  const L = (n) => `Alt2Obsidian/CSED423/Lectures/L${n}.md`;
  files.set(L(5), slideNote());
  files.set(L(10), slideNote().replace('alt_created: "2026-09-30"', 'alt_created: "2026-10-20"'));
  files.set(L(4), slideNote().replace('alt_created: "2026-09-30"', 'alt_created: "2026-09-23"').replace("### 개요\nParse tree", "### 개요\nLexer와 Parser의 역할을 나눈다. 그 다음 문장. Parse tree"));
  const r5 = await m.updateLectureBrief(store, L(5), { today: TODAY });
  assert.deepEqual(r5, { path: "Alt2Obsidian/CSED423/Briefs/L5 brief.md", result: "written" });
  assert.equal(m.briefPathForNote(L(5)), r5.path);
  assert.equal(m.briefPathForNote("Alt2Obsidian/CSED311/old.md"), "Alt2Obsidian/CSED311/Briefs/old brief.md", "1.x layout: Briefs/ under the subject folder");
  assert.equal(m.subjectBriefPath("Alt2Obsidian/CSED423", "CSED423"), "Alt2Obsidian/CSED423/Briefs/CSED423 subject brief.md");
  assert.equal(m.chatsFolderForNote(L(5)), "Alt2Obsidian/CSED423/Chats");
  assert.ok(m.SUBJECT_SUBDIRS.includes("Briefs") && m.SUBJECT_SUBDIRS.includes("Chats"), "the 1.x migration leaves Briefs/ and Chats/ alone");
  await m.updateLectureBrief(store, L(10), { today: TODAY });
  await m.updateLectureBrief(store, L(4), { today: TODAY });
  const subject = files.get("Alt2Obsidian/CSED423/Briefs/CSED423 subject brief.md");
  assert.equal(
    m.bodyOf(subject),
    "# CSED423 subject brief\n\n" +
      "- L4 (2026-09-23, 슬라이드 3장): Lexer와 Parser의 역할을 나눈다.\n" +
      "- L5 (2026-09-30, 슬라이드 3장): Parse tree와 Derivation 순서가 평가에 주는 영향을 다룬다.\n" +
      "- L10 (2026-10-20, 슬라이드 3장): Parse tree와 Derivation 순서가 평가에 주는 영향을 다룬다.\n",
    "by alt_created; the first sentence of each 개요"
  );
  assert.deepEqual(Object.keys(m.readFrontmatter(subject)), ["alt2obs_subject_brief", "subject", "body_hash", "built"]);

  // A lecture whose name ends in " subject" is still a lecture: the frontmatter decides, not the file name.
  files.set("Alt2Obsidian/CSED423/Lectures/Intro subject.md", slideNote().replace('alt_created: "2026-09-30"', 'alt_created: "2026-09-01"'));
  await m.updateLectureBrief(store, "Alt2Obsidian/CSED423/Lectures/Intro subject.md", { today: TODAY });
  assert.match(m.bodyOf(files.get("Alt2Obsidian/CSED423/Briefs/CSED423 subject brief.md")), /^- Intro subject \(2026-09-01, 슬라이드 3장\):/m);
  files.delete("Alt2Obsidian/CSED423/Lectures/Intro subject.md");
  files.delete("Alt2Obsidian/CSED423/Briefs/Intro subject brief.md");
  await m.updateSubjectBrief(store, L(5), "CSED423", TODAY);
  // Importing again without a change writes nothing.
  writes.length = 0;
  assert.deepEqual(await m.updateLectureBrief(store, L(5), { today: "2026-11-02" }), { path: r5.path, result: "same" });
  assert.deepEqual(writes, [], "no write, no call");
  // The note changed: the brief and the subject brief are written again.
  files.set(L(5), slideNote({ gist14: "새 요지다.", overviewExtra: "" }).replace("Parse tree와 [[Derivation", "Derivation 순서를 본다. Parse tree와 [[Derivation"));
  await m.updateLectureBrief(store, L(5), { today: TODAY });
  assert.deepEqual(writes, [r5.path, "Alt2Obsidian/CSED423/Briefs/CSED423 subject brief.md"]);
  assert.match(m.bodyOf(files.get("Alt2Obsidian/CSED423/Briefs/CSED423 subject brief.md")), /- L5 \(2026-09-30, 슬라이드 3장\): Derivation 순서를 본다\./);
  // The user edits the subject brief: it is never overwritten.
  const ownSubject = files.get("Alt2Obsidian/CSED423/Briefs/CSED423 subject brief.md") + "- 내 줄\n";
  files.set("Alt2Obsidian/CSED423/Briefs/CSED423 subject brief.md", ownSubject);
  files.set(L(10), files.get(L(10)).replace("Rightmost Derivation은", "바뀐 Rightmost Derivation은"));
  writes.length = 0;
  await m.updateLectureBrief(store, L(10), { today: TODAY });
  assert.deepEqual(writes, ["Alt2Obsidian/CSED423/Briefs/L10 brief.md"], "the edited subject brief is kept");
  // The lecture brief the user edited is kept on an import too; the state says so.
  const own = files.get(r5.path).replace("## 흐름", "## 흐름\n- 내 메모");
  files.set(r5.path, own);
  files.set(L(5), files.get(L(5)).replace("새 요지다.", "또 바뀐 요지다."));
  assert.equal((await m.updateLectureBrief(store, L(5), { today: TODAY })).result, "edited");
  assert.equal(files.get(r5.path), own);
  const state = await m.readLectureBrief(store, L(5));
  assert.equal(state.status, "edited-stale");
  assert.match(state.body, /^## 개요/);
  await assert.rejects(m.readLectureBrief(store, L(9)), /강의 노트를 찾지 못했습니다/, "a note that is not there");
  console.log("PASS: brief store: Briefs/<lecture> brief.md, subject brief by lecture order with one line each, unchanged import writes nothing, user edits kept (lecture and subject brief)");
}

// ---- lecture order, neighbours; briefs are not lecture notes ----
{
  const list = [{ name: "L10" }, { name: "L2" }, { name: "L1" }];
  assert.deepEqual(m.orderLectures(list).map((l) => l.name), ["L1", "L2", "L10"], "natural order by name");
  const dated = [{ name: "B", altCreated: "2026-09-02" }, { name: "A", altCreated: "2026-09-09" }];
  assert.deepEqual(m.orderLectures(dated).map((l) => l.name), ["B", "A"], "by alt_created when every lecture has it");
  assert.deepEqual(m.neighbourLectures("L2", list), { prev: "L1", next: "L10" });
  assert.deepEqual(m.neighbourLectures("L1", list), { prev: null, next: "L2" });
  const briefFm = m.readFrontmatter(await m.composeBrief(await m.buildBriefScript(NOTE, slideNote()), null, TODAY));
  assert.equal(m.isBriefFrontmatter(briefFm), true);
  assert.equal(m.isLectureFrontmatter(briefFm), false, "a brief is not a lecture note");
  assert.equal(m.isLectureFrontmatter({ ...briefFm, alt_local_id: "x" }), false, "not even with alt_local_id (a brief written before the key was renamed)");
  assert.equal(m.isLectureNote(briefFm, "<!-- alt2obs:slide:1 hash:aaaaaaaa start -->"), false);
  assert.equal(m.isLectureNote({ alt_local_id: "x" }, null), true);
  assert.equal(m.isLectureNote({}, "<!-- alt2obs:section:2 hash:bbbbbbbb start -->"), true, "section markers");
  assert.equal(m.isLectureNote({ title: "x" }, "plain"), false);
  console.log("PASS: lecture order (alt_created or natural name order), previous and next lecture, briefs never count as lecture notes");
}

// ---- the AI part (spec 4.5): candidates, the prompt, the checked answer, the store's reuse rules ----
{
  const at = (sec) => sec * 1000;
  const seg = (sec, text) => ({ startMs: at(sec), endMs: at(sec) + 4000, text });
  const transcript = [
    seg(0, "오늘은 parse tree를 봅니다."),
    seg(10, "음 이건 그냥 설명입니다."),
    seg(20, "앞 문장입니다."),
    seg(30, "이 부분은 시험에 꼭 나옵니다."),
    seg(40, "뒤 문장입니다."),
    seg(50, "다른 이야기입니다."),
    seg(60, "또 다른 이야기입니다."),
    seg(70, "왜 왼쪽부터 유도하죠?"),
    seg(80, "그 다음 이야기입니다."),
    seg(90, "더 다른 이야기입니다."),
    seg(100, "Remember the precedence rule."),
  ];
  const spans = [{ slide: 14, startMs: 0, endMs: at(60), low: false }, { slide: 15, startMs: at(60), endMs: at(120), low: false }];
  const cands = m.pickCandidates(transcript, spans);
  assert.deepEqual(
    cands.map(m.formatCandidate),
    [
      "[00:20] (슬라이드 14) 앞 문장입니다. 이 부분은 시험에 꼭 나옵니다. 뒤 문장입니다.",
      "[01:00] (슬라이드 15) 또 다른 이야기입니다. 왜 왼쪽부터 유도하죠? 그 다음 이야기입니다. 더 다른 이야기입니다. Remember the precedence rule.",
    ],
    "a keyword or a question mark, with the sentences around it, touching stretches merged; time and aligned slide in front"
  );
  assert.deepEqual(m.pickCandidates(transcript, []).map((c) => c.slide), [null, null], "no alignment: no slide label");
  // The cap takes from both ends in turn, so the whole lecture is covered; the result is in time order.
  const many = Array.from({ length: 60 }, (_, i) => seg(i * 60, `${i}번째 중요한 내용입니다 ${"가".repeat(80)}.`));
  const capped = m.pickCandidates(many, [], 1000);
  assert.ok(capped.length > 0 && capped.map(m.formatCandidate).join("\n").length <= 1000);
  assert.ok(m.pickCandidates(many, []).every((c) => c.text.length <= 400), "a long run of candidates is cut into stretches of 400 characters");
  assert.ok(capped[0].startMs === 0 && capped[capped.length - 1].startMs > at(50 * 60), "the first and the last stretches both made it");
  assert.deepEqual(capped.map((c) => c.startMs), [...capped.map((c) => c.startMs)].sort((a, b) => a - b));
  // No candidate: no input, no call.
  assert.equal(await m.briefAiInput({ title: "L5", subject: "S", kind: "slides", map: [], units: 0, transcript: [seg(0, "평범한 이야기입니다.")], spans: [] }), null);

  const script = await m.buildBriefScript(NOTE, slideNote());
  const input = await m.aiInputFor(script, transcript);
  assert.match(input.user, /^강의: L5\n과목: CSED423\n강의 길이: 01:44\n\n\[슬라이드별 요지\]\n14: 같은 문장 x - 2 \* y도/);
  assert.ok(input.user.endsWith("Remember the precedence rule."));
  assert.match(input.system, /JSON 객체 하나만 답한다/);
  assert.ok(!/[\u2013\u2014]/.test(input.system + input.user), "no dashes in the prompt");
  assert.equal(input.lengthMs, at(104));
  assert.equal(input.units, 16);
  assert.equal((await m.aiInputFor(script, transcript)).hash, input.hash, "the same input: the same ai_hash");
  assert.notEqual((await m.aiInputFor(script, transcript.slice(0, 6))).hash, input.hash, "other candidates: another ai_hash");

  // The checked answer.
  const raw = {
    one_line: "Derivation 순서가 평가 순서를 정한다는 내용을 다루는 강의로, 이 문장은 여든 자를 넘기려고 일부러 길게 늘여 쓴 문장이다 가나다라마바사",
    emphasis: [
      { t: "00:30", slide: 14, text: "유도 순서가 시험에 나온다고 했다." },
      { t: "1:00:00", slide: 14, text: "강의 길이를 넘는 시각이다." },
      { t: "xx", slide: 14, text: "읽을 수 없는 시각이다." },
      { t: "00:20", slide: 99, text: "덱 밖 슬라이드는 null이 된다." },
      { t: "00:20", slide: null, text: "앞 문장입니다. 이 부분은 시험에 꼭 나옵니다. 그대로다." },
      ...Array.from({ length: 8 }, (_, i) => ({ t: "00:40", slide: 15, text: `강조점 ${i}다.` })),
    ],
    qa: [{ t: "01:10", q: "왜 왼쪽부터 유도하는가?", a: "곱셈을 먼저 묶어야 해서다." }, { t: "01:10", q: "x", a: "" }],
    pitfalls: ["유도 순서와 평가 순서를 헷갈리기 쉽다." + "가".repeat(120), 3],
  };
  const ai = m.validateBriefAi(raw, input);
  assert.equal(Array.from(ai.oneLine).length, 80, "one_line cut to 80 characters");
  assert.deepEqual(ai.emphasis.slice(0, 2), [{ t: "00:30", slide: 14, text: "유도 순서가 시험에 나온다고 했다." }, { t: "00:20", slide: null, text: "덱 밖 슬라이드는 null이 된다." }], "past the lecture or unreadable: dropped; a copy of a candidate: dropped; a slide outside the deck: null");
  assert.equal(ai.emphasis.length, 6, "6 at most");
  assert.deepEqual(ai.qa, [{ t: "01:10", q: "왜 왼쪽부터 유도하는가?", a: "곱셈을 먼저 묶어야 해서다." }], "an empty answer drops the item");
  assert.equal(ai.pitfalls.length, 1);
  assert.equal(Array.from(ai.pitfalls[0]).length, 100, "texts cut to 100 characters");
  assert.equal(m.copiesCandidate("이 부분은 시험에 꼭 나옵니다. 뒤 문장입", input.candidateText), true, "more than 20 identical characters");
  assert.equal(m.copiesCandidate("이 부분은 시험에 꼭 나옵", input.candidateText), false);
  assert.throws(() => m.validateBriefAi([1], input), /JSON 객체가 아닙니다/, "not an object: asked once more");
  assert.deepEqual(m.validateBriefAi({}, input), { oneLine: "", emphasis: [], qa: [], pitfalls: [] }, "empty lists are fine");
  assert.equal(
    m.renderAiSections(ai, "slides").split("\n").slice(0, 3).join("\n"),
    "## 강조점\n- [00:30] 슬라이드 14: 유도 순서가 시험에 나온다고 했다.\n- [00:20] 덱 밖 슬라이드는 null이 된다."
  );
  assert.equal(m.renderAiSections({ oneLine: "", emphasis: [], qa: [], pitfalls: [] }, "slides"), "", "nothing: no section");

  // The store: made, reused, retried after a failure, carried over a script change, none without candidates.
  const files = new Map([[NOTE, slideNote()]]);
  const store = { read: async (p) => files.get(p) ?? null, write: async (p, t) => void files.set(p, t), list: async () => [] };
  let calls = 0;
  let fail = false;
  const step = (segs) => ({
    transcript: segs,
    run: async (prompt, validate) => {
      calls++;
      if (fail) throw new Error("usage limit");
      assert.equal(prompt.user, input.user);
      return { ai: validate(raw), model: "claude-haiku-5-5", input: 4120, output: 760 };
    },
  });
  const BRIEF = "Alt2Obsidian/CSED423/Briefs/L5 brief.md";
  const r1 = await m.updateLectureBrief(store, NOTE, { today: TODAY, ai: step(transcript) });
  assert.deepEqual([r1.result, r1.ai, calls], ["written", "ok", 1]);
  const made = files.get(BRIEF);
  assert.match(made, /^ai_hash: "[0-9a-f]{8}"$/m);
  assert.match(made, /^ai_part: \{status: "ok", model: "claude-haiku-5-5", input: 4120, output: 760\}$/m);
  assert.match(made, /^one_line: "Derivation 순서가/m);
  assert.equal(m.oneLineOf(made), ai.oneLine, "the subject brief takes one_line");
  assert.match(m.bodyOf(made), /\n## 강조점\n- \[00:30\] 슬라이드 14: /);
  assert.equal(await m.isEditedBrief(made), false);
  const r2 = await m.updateLectureBrief(store, NOTE, { today: TODAY, ai: step(transcript) });
  assert.deepEqual([r2.result, r2.ai, calls], ["same", "reused", 1], "same input, a good part: no call, no write");
  // Only the overview changed: the script part again, the AI part carried, no call.
  files.set(NOTE, slideNote({ overviewExtra: " 한 문장 더." }));
  const r3 = await m.updateLectureBrief(store, NOTE, { today: TODAY, ai: step(transcript) });
  assert.deepEqual([r3.result, r3.ai, calls], ["written", "reused", 1]);
  assert.match(files.get(BRIEF), /한 문장 더\.[\s\S]*## 강조점\n- \[00:30\]/);
  // Other candidates: a new call; it fails: the script part with ai_part failed (sections dropped), and the next run tries again.
  fail = true;
  const r4 = await m.updateLectureBrief(store, NOTE, { today: TODAY, ai: { ...step(transcript.slice(0, 6)), run: step([]).run } });
  assert.deepEqual([r4.result, r4.ai, r4.aiError, calls], ["written", "failed", "usage limit", 2]);
  assert.match(files.get(BRIEF), /^ai_part: \{status: "failed"\}$/m);
  assert.ok(!/## 강조점/.test(files.get(BRIEF)));
  fail = false;
  const r5 = await m.updateLectureBrief(store, NOTE, { today: TODAY, ai: { transcript: transcript.slice(0, 6), run: async (p, v) => (calls++, { ai: v({ one_line: "다시 만든 줄이다", emphasis: [], qa: [], pitfalls: ["다시 만든 점이다."] }), model: "m", input: 1, output: 1 }) } });
  assert.deepEqual([r5.ai, calls], ["ok", 3], "a failed part is made again");
  // No candidate: ai_part none, no call.
  const r6 = await m.updateLectureBrief(store, NOTE, { today: TODAY, ai: step([seg(0, "평범한 이야기입니다.")]) });
  assert.deepEqual([r6.ai, calls], ["none", 3]);
  assert.match(files.get(BRIEF), /^ai_part: \{status: "none"\}$/m);
  // A brief the user edited: no call at all.
  files.set(BRIEF, files.get(BRIEF) + "\n내가 쓴 줄\n");
  const r7 = await m.updateLectureBrief(store, NOTE, { today: TODAY, ai: step(transcript) });
  assert.deepEqual([r7.result, calls], ["edited", 3]);
  console.log("PASS: brief AI part: candidates (keywords, questions, neighbours, merged, [mm:ss] and slide, both ends under the cap), the prompt and ai_hash, the checked answer (time, slide, copy, caps), sections and one_line, reuse, retry after a failure, none without candidates, no call for an edited brief");
}
