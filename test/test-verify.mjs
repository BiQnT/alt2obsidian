/**
 * Test: the note verifier (spec 4.6) with the fake claude (no tokens):
 * claim splitting, BM25 evidence (slides top 2, aligned transcript top 2),
 * script-only "근거 없음", likely-true claims last, batches of 20, the
 * estimate from the exact prompts, the shared retry rules, the missing-slide
 * call, the verification note and its re-run merge.
 * Run: node test/test-verify.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, fakeSession } from "./helpers/fake-cli.mjs";

const m = await importTs("test/helpers/verify-entry.ts");

// ---- claims ----
{
  const note = [
    "---",
    "title: 13강 노트",
    "---",
    "# 메모리 계층",
    "",
    "캐시는 SRAM으로 만든다. DRAM은 SRAM보다 느리다! 예: e.g. L1 cache는 3.5 ns 정도.",
    "",
    "- [ ] **Temporal locality**: 최근 접근한 데이터는 곧 다시 접근된다",
    "  * 공간 지역성은 가까운 주소를 곧 접근하는 성질",
    "> [!note] 콜아웃",
    "> 콜아웃 안의 문장도 주장이다.",
    "[[다른 노트]]",
    "https://example.com/page",
    "![img](a.png)",
    "```",
    "code line is not a claim",
    "```",
    "| 계층 | 속도 |",
    "|---|---|",
    "| 레지스터 | 가장 빠름 |",
    "<aside>",
    "Notion 콜아웃의 설명 문장입니다.",
    "</aside>",
    "---",
    "짧음",
    "캐시는 SRAM으로 만든다.",
  ].join("\n");
  const claims = m.splitClaims(note);
  assert.deepEqual(
    claims.map((c) => c.text),
    [
      "캐시는 SRAM으로 만든다.",
      "DRAM은 SRAM보다 느리다!",
      "예: e.g. L1 cache는 3.5 ns 정도.",
      "Temporal locality: 최근 접근한 데이터는 곧 다시 접근된다",
      "공간 지역성은 가까운 주소를 곧 접근하는 성질",
      "콜아웃 안의 문장도 주장이다.",
      "레지스터 · 가장 빠름",
      "Notion 콜아웃의 설명 문장입니다.",
    ]
  );
  assert.deepEqual(claims.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(claims[3].line, 8);
  assert.equal(claims[0].section, "메모리 계층");
  const extra = m.splitClaims([
    "# 절",
    "$$",
    "T_i = t_i + m_i T_{i+1} 수식 안의 줄",
    "$$",
    "$$ x = 1 한 줄 수식 $$",
    "    indented code line here",
    "- 목록 항목입니다",
    "    목록 안의 들여쓴 줄입니다",
    "| 헤더 칸 | 헤더 둘 |",
    "|---|---|",
    "| 레지스터 | 가장 빠름 |",
    "캐시 적중",
    "ok fine",
  ].join("\n"));
  assert.deepEqual(extra.map((c) => c.text), ["목록 항목입니다", "목록 안의 들여쓴 줄입니다", "레지스터 · 가장 빠름", "캐시 적중"], "math blocks, indented code, table headers and short Latin lines skipped; 4 Hangul characters are enough");
  console.log("PASS: claims: sentences and bullets with their section; headings, links, code, math, table headers, images, rules, short and repeated lines dropped");
}

// ---- plan, evidence, estimate ----
const slides = [
  "Lecture 13 Memory Hierarchy\nProf. Kim, Department of CSE, University",
  "Ideal memory\nZero access time (latency)\nInfinite capacity\nZero cost\nInfinite bandwidth",
  "The problem\nBigger is slower: SRAM < 1 ns, DRAM ~ 100 ns, disk ~ 10 ms\nFaster is more expensive",
  "Locality\nTemporal locality: a recently accessed item is likely to be accessed again soon\nSpatial locality: nearby addresses are likely to be accessed soon",
  "Cache basics\nA cache holds recently used blocks in SRAM close to the processor\nHit and miss",
  "Write policies\nWrite-through updates memory on every write\nWrite-back writes a dirty block when it is evicted",
  "Course logistics\nHomework 4 due Friday",
  "Thank you",
];
const seg = (sec, text) => ({ startMs: sec * 1000, endMs: sec * 1000 + 4000, text });
const segments = [
  seg(0, "welcome to lecture thirteen memory hierarchy"),
  seg(60, "an ideal memory would have zero access time and infinite capacity"),
  seg(125, "SRAM is fast but expensive, DRAM is slower but dense"),
  seg(200, "temporal locality means we access the same item again soon"),
  seg(300, "a cache keeps recently used blocks in SRAM near the processor"),
  seg(400, "with write back we only write the dirty block on eviction"),
];
const spans = m.parseAlignment("1:0-50 2:50-120 3:120-190 4:190-290 5:290-390 6:390-500");
const note = [
  "# Memory",
  "- 이상적인 메모리는 access time이 0이고 capacity가 무한하다",
  "- DRAM은 SRAM보다 빠르다 (거짓)",
  "- Temporal locality: 최근에 access한 item은 곧 다시 access된다",
  "- cache는 최근 쓴 block을 processor 가까운 SRAM에 둔다",
  "- write back은 dirty block을 evict할 때 쓴다",
  "# 잡담",
  "- 양자 컴퓨터는 큐비트를 쓴다",
  "- 주말에는 영화를 보았다",
].join("\n");
const plan = m.planVerification({ lecture: "13강", notePath: "Alt2Obsidian/CS/Lectures/13강.md", noteMarkdown: note, slideTexts: slides, transcript: { segments, spans } }, 3);
assert.equal(plan.claims.length, 7);
const byText = (t) => plan.claims.find((c) => c.claim.text.includes(t));
assert.equal(byText("이상적인").slides[0].slide, 2, "ideal memory claim finds slide 2 first");
assert.equal(byText("DRAM은").slides[0].slide, 3);
assert.equal(byText("Temporal").slides[0].slide, 4);
assert.equal(byText("Temporal").transcript[0].slide, 4, "transcript chunk carries its aligned slide");
assert.equal(byText("Temporal").transcript[0].startMs, 200000);
assert.ok(byText("Temporal").slides.length <= 2 && byText("Temporal").transcript.length <= 2);
assert.equal(byText("Temporal").slides[0].excerpt, slides[3].replace(/\s+/g, " "), "a short slide is sent whole");
assert.equal(byText("양자").unmatched, true, "no evidence by any route: not judged");
assert.equal(byText("주말").unmatched, true);
assert.equal(byText("DRAM은").likelyTrue, false, "comparisons with numbers or negation are never likely true");
const likely = plan.claims.filter((c) => c.likelyTrue).map((c) => c.claim.id);
assert.ok(likely.length > 0, "a claim that copies the slide terms is a likely-true candidate");
assert.deepEqual(plan.judged.slice(-likely.length).map((c) => c.claim.id), likely, "likely-true claims are judged last");
assert.equal(plan.judged.length, 5);
assert.deepEqual(plan.batches.map((b) => b.length), [3, 2]);
assert.ok(plan.uncovered.some((u) => u.slide === 7), "logistics slide has no claim");
assert.ok(!plan.uncovered.some((u) => u.slide === 1 || u.slide === 8), "cover and closing slides are not missing candidates");
const est = m.estimateVerification(plan, "claude-cli");
assert.equal(est.claims, 7);
assert.equal(est.judged, 5);
assert.equal(est.unmatched, 2);
assert.equal(est.unmatchedWarning, false, "2 of 7 is under 30%");
assert.equal(est.calls, 3, "2 judge batches + 1 missing call");
assert.ok(est.inputTokens > 0 && est.outputTokens > 0);
const prompt = m.buildJudgePrompt("13강", plan.batches[0]);
assert.match(prompt, /### 주장 \d+\n/);
assert.match(prompt, /- 슬라이드 \d+: /);
assert.match(prompt, /- 전사 \[\d\d:\d\d\] \(슬라이드 \d+ 구간\): /);
assert.equal(m.formatTimestamp(723000), "12:03");
assert.equal(m.formatTimestamp(3723000), "1:02:03");
console.log(`PASS: evidence (slides top 2, aligned transcript top 2), unmatched claims apart, likely-true last, batches, estimate (${est.calls} calls, ${est.inputTokens} input tokens)`);

// ---- pure Korean notes on English slides, no transcript (the main case) ----
{
  const ko = [
    "# 지역성",
    "- 최근에 참조한 항목은 곧 다시 참조될 가능성이 높다",
    "- 공간 지역성은 가까운 주소를 곧 접근하는 성질이다",
    "# 캐시",
    "- 캐시는 최근에 쓴 블록을 프로세서 가까이에 둔다",
    "- 그림으로 보면 이해가 쉽다",
    "- 이것은 거짓으로 적은 문장이다",
    "# 쓰기 정책",
    "- 두 가지 방식이 있다",
  ].join("\n");
  const kp = m.planVerification({ lecture: "13강", noteMarkdown: ko, slideTexts: slides, transcript: null });
  const k = (t) => kp.claims.find((c) => c.claim.text.includes(t));
  assert.equal(kp.unmatched.length, 0, "every Korean claim reaches the judge");
  assert.equal(kp.judged.length, 6);
  assert.equal(k("공간 지역성").source, "direct", "technical Korean terms find the English slide through the glossary");
  assert.equal(k("공간 지역성").slides[0].slide, 4);
  assert.equal(k("최근에 참조").source, "neighbour", "one shared term is weak: the neighbour's strong match is used");
  assert.equal(k("최근에 참조").slides[0].slide, 4);
  assert.equal(k("캐시는").slides[0].slide, 5);
  assert.equal(k("그림으로").source, "neighbour", "no shared term: the nearby claims' slides");
  assert.deepEqual(k("그림으로").slides.map((h) => h.slide).sort(), k("캐시는").slides.map((h) => h.slide).sort());
  assert.equal(k("두 가지").source, "heading", "alone in its section: the heading's slides");
  assert.equal(k("두 가지").slides[0].slide, 6);
  assert.deepEqual(m.englishHints("캐시메모리의 지역성은"), ["memory", "cache", "locality"]);
  assert.deepEqual(m.englishHints("최근에 빠른 시간 안에"), [], "everyday words give no hints");
  const kprompt = kp.batches.map((b) => m.buildJudgePrompt("13강", b)).join("\n");
  assert.match(kprompt, /그림으로 보면 이해가 쉽다\n근거 \(주장과 겹치는 용어가 없어 같은 절의 문맥으로 찾은 후보\):\n- 슬라이드 \d+: /);
  const ks = fakeSession("ok");
  const kjob = m.createJobDir();
  try {
    const kllm = new m.ClaudeCliProvider({ bin: FAKE_CLAUDE, model: "sonnet", effort: "medium", timeoutMs: 20000, workDir: kjob, ownsWorkDir: false });
    const kres = await m.runVerification(kp, kllm);
    assert.equal(kres.items.length, 6);
    assert.ok(kres.items.every((i) => i.verdict !== null), "the (fake) judge gave every Korean claim a verdict");
    assert.equal(kres.unmatched.length, 0);
    const kmd = m.renderVerificationNote(kres, { source: "x", date: "2026-09-28", usageLine: null, model: "fake" });
    assert.match(kmd, /> \[!failure\] 틀림 \(문맥 근거, 확인 필요\)\n> "이것은 거짓으로 적은 문장이다"/, "a 틀림 on context evidence is flagged for a look");
    assert.match(kmd, /> \[!success\]- 맞음 \(문맥 근거\)/);
  } finally {
    m.removeJobDir(kjob);
    ks.cleanup();
  }
  // A filler sentence with one generic hit never lends slides to its neighbours
  // (a physics deck: "exam" is on the schedule slide only).
  const thermo = [
    "Thermodynamics lecture 3\nProf. Park, Department of Physics",
    "First law\nThe internal energy change equals heat added minus work done: dU = Q - W",
    "Second law\nThe entropy of an isolated system never decreases",
    "Schedule\nMidterm exam next week, homework due Friday",
  ];
  const tp = m.planVerification({
    lecture: "열역학 3강",
    noteMarkdown: ["# 열역학", "- exam 준비를 슬슬 해야겠다", "- 고립계의 무질서도는 줄어들지 않는다"].join("\n"),
    slideTexts: thermo,
    transcript: null,
  });
  const filler = tp.claims.find((c) => c.claim.text.includes("exam"));
  const entropy = tp.claims.find((c) => c.claim.text.includes("무질서도"));
  assert.equal(filler.source, "weak", "one generic shared word is not a direct match");
  assert.ok(entropy.source !== "neighbour" && !entropy.slides.some((h) => h.slide === 4), "the filler's schedule slide is never the entropy claim's evidence");
  assert.equal(entropy.unmatched, true, "no route found evidence: listed apart");

  // Nothing matches at all: every claim unmatched, the estimate warns.
  const none = m.planVerification({ lecture: "13강", noteMarkdown: "- 주말에는 영화를 보았다\n- 날씨가 맑았다", slideTexts: slides, transcript: null });
  const ne = m.estimateVerification(none, "claude-cli");
  assert.equal(ne.unmatched, 2);
  assert.equal(ne.unmatchedWarning, true);
  console.log("PASS: pure Korean claims over English slides without a transcript reach the judge (glossary terms, neighbour and heading evidence); nothing-matches warns");
}

// ---- links, verdict spacing, merge ----
{
  assert.equal(m.lectureLink({ title: "13강", path: "A/CS/Lectures/13강.md" }, 3), "[[A/CS/Lectures/13강#📚 슬라이드 3|13강 · 슬라이드 3]]");
  assert.equal(m.lectureLink({ title: "13강", path: "A/CS/Lectures/13강.md" }), "[[A/CS/Lectures/13강|13강]]");
  assert.equal(m.lectureLink({ title: "13강", path: null }, 3), "[[13강#📚 슬라이드 3|13강 · 슬라이드 3]]");
  assert.equal(m.frontmatterLectureLink({ title: "13강", path: "A/CS/Lectures/13강.md" }), "[[A/CS/Lectures/13강|13강]]");
  assert.equal(m.frontmatterLectureLink({ title: "[OS] 3강 #2", path: "A/C#/Lectures/[OS] 3강 #2.md" }), "[[OS 3강 2]]", "frontmatter never gets a percent-encoded Markdown link");
  assert.equal(
    m.lectureLink({ title: "[OS] 3강 #2", path: "A/C#/Lectures/[OS] 3강 #2.md" }, 5),
    "[OS 3강 2 · 슬라이드 5](A/C%23/Lectures/%5BOS%5D%203%EA%B0%95%20%232.md#%F0%9F%93%9A%20%EC%8A%AC%EB%9D%BC%EC%9D%B4%EB%93%9C%205)",
    "a name with # [ ] becomes a percent-encoded Markdown link"
  );
  const batch = plan.batches[0];
  const ok = m.checkJudgeAnswer({ results: batch.map((e) => ({ id: e.claim.id, v: "근거없음", r: " 이유 " })) }, batch);
  assert.ok([...ok.ok.values()].every((x) => x.v === "근거 없음"), "verdicts match without spaces");
  const md = "---\n---\n# x\n<!-- alt2obs:verify start -->\n> \"&lt;!-- alt2obs:verify end -->\"\n<!-- alt2obs:verify end -->\n\n## 내 메모\n내 줄\n";
  const merged = m.mergeVerificationNote(md, md.replace("# x", "# y"));
  assert.ok(merged.includes("# y") && merged.includes("내 줄") && merged.split("내 줄").length === 2);
  console.log("PASS: path-qualified links with alias (encoded Markdown link for # ^ [ ] |), verdicts without spaces, merge at the last end marker");
}

// ---- run with the fake claude ----
const s = fakeSession("ok,dropclaim:2");
const job = m.createJobDir();
try {
  const usage = new m.UsageTracker();
  const llm = new m.ClaudeCliProvider({ bin: FAKE_CLAUDE, model: "sonnet", effort: "medium", timeoutMs: 20000, workDir: job, usage, task: "verification", ownsWorkDir: false });
  const progress = [];
  const result = await m.runVerification(plan, llm, { onProgress: (p) => progress.push(p) });
  const calls = s.calls();
  assert.equal(calls.length, 4, "2 batches + 1 retry of the dropped claim + 1 missing call");
  assert.match(calls[1].stdin, /주장 번호: 2$/m, "the missing claim is asked for once more, alone");
  assert.ok(calls.every((c) => !c.stdin.includes("양자")), "an unmatched claim is never sent");
  const v = Object.fromEntries(result.items.map((i) => [i.evidence.claim.id, i.verdict]));
  assert.equal(v[2], "틀림");
  assert.equal(v[1], "맞음");
  assert.equal(result.items.length, 5);
  assert.equal(result.unmatched.length, 2);
  assert.deepEqual(result.missing.map((x) => x.slide), [plan.uncovered[0].slide]);
  assert.equal(usage.total().calls, 4);
  assert.ok(progress.some((p) => p.step === "missing"));

  const md = m.renderVerificationNote(result, { source: "[[13강 내 노트]]", date: "2026-09-28", usageLine: m.formatUsageFrontmatter(usage.total(), "Claude CLI sonnet"), model: "Claude CLI sonnet" });
  assert.match(md, /^---\nlecture: "\[\[Alt2Obsidian\/CS\/Lectures\/13강\|13강\]\]"\n/);
  assert.match(md, /verdicts: \{"맞음": 4, "틀림": 1, "근거 없음": 0, "전사 불확실": 0, "누락 후보": 1\}/);
  assert.match(md, /alt2obs_usage: \{provider: "Claude CLI sonnet", calls: 4,/);
  assert.match(md, /> 맞음 4 · 틀림 1 · 근거 없음 0 · 전사 불확실 0 · 누락 후보 1 · 근거 검색 실패 2\n/);
  assert.match(md, /## ❌ 틀림 \(1\)\n\n> \[!failure\] 틀림\n> "DRAM은 SRAM보다 빠르다 \(거짓\)"\n> 근거와 비교함 \(틀림\)\n> 근거: \[\[Alt2Obsidian\/CS\/Lectures\/13강#📚 슬라이드 3\|13강 · 슬라이드 3\]\]/);
  assert.match(md, /> 근거: .*\[02:05\] \(슬라이드 3\)/, "transcript time links");
  assert.match(md, /> \[!success\]- 맞음/, "correct claims folded");
  assert.match(md, /## 📭 누락 후보 \(1\)\n\n- \[\[Alt2Obsidian\/CS\/Lectures\/13강#📚 슬라이드 \d+\|13강 · 슬라이드 \d+\]\]/);
  assert.match(md, /## 🔎 용어 불일치로 근거 검색 실패 \(2\)\n\n판정이 아닙니다[^\n]*\n\n- "양자 컴퓨터는 큐비트를 쓴다"\n- "주말에는 영화를 보았다"/);
  assert.ok(md.indexOf("## ❌ 틀림") < md.indexOf("## ✅ 맞음"));
  assert.ok(!/[\u2013\u2014]/.test(md), "no dashes");

  // Re-run keeps what the user wrote below the block, replaces the rest.
  const edited = md.replace("## 내 메모\n", "## 내 메모\n시험 전에 슬라이드 3 다시 보기\n");
  const next = md.replace("맞음 4 ·", "맞음 5 ·");
  const merged = m.mergeVerificationNote(edited, next);
  assert.ok(merged.includes("맞음 5 ·") && merged.includes("시험 전에 슬라이드 3 다시 보기"));
  assert.equal(m.mergeVerificationNote(null, next), next);
  const userFile = "# 내가 만든 파일\n지우면 안 됨\n";
  const kept = m.mergeVerificationNote(userFile, next);
  assert.ok(kept.startsWith(next.trimEnd()) && kept.includes("지우면 안 됨"), "a file without the managed block is kept in full");
  console.log("PASS: run: batches through the shared retry rules, unmatched claims never sent, missing call, note rendering and re-run merge");

  // Usage limit: the run stops, every remaining claim reported, nothing thrown.
  process.env.FAKE_CLI_MODE = "limit";
  const stopped = await m.runVerification(plan, llm);
  assert.ok(stopped.items.every((i) => i.verdict === null && /usage limit|사용 한도/.test(i.reason)));
  assert.ok(stopped.warnings.some((w) => /판정하지 못했습니다/.test(w)));
  console.log("PASS: a usage limit stops the verification and reports every remaining claim");
} finally {
  m.removeJobDir(job);
  s.cleanup();
}

// ---- Notion MCP input (fake claude: `mcp list`, `mcp get` and the Notion-only call) ----
{
  const { mkdtempSync, rmSync, statSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const listing = [
    "Checking MCP server health…",
    "[mcp-sdk] some warning line: with a colon - noise",
    "claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected",
    "plugin:vercel-plugin:vercel: https://mcp.vercel.com (HTTP) - ! Needs authentication",
    "claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected",
  ].join("\n");
  const servers = m.parseMcpList(listing);
  assert.deepEqual(servers.map((x) => [x.name, x.connected]), [["claude.ai Gmail", true], ["plugin:vercel-plugin:vercel", false], ["claude.ai Notion", true]]);
  assert.equal(m.mcpToolName(m.findNotionServer(servers).name), "mcp__claude_ai_Notion__notion-fetch");
  assert.equal(m.mcpToolName("notion"), "mcp__notion__notion-fetch");
  const details = m.parseMcpGet("notion:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n  URL: https://mcp.notion.com/mcp\n");
  assert.deepEqual(details, { scope: "User config", type: "http", url: "https://mcp.notion.com/mcp", hasHeaders: false });
  assert.equal(m.strictMcpConfig("notion", details), '{"mcpServers":{"notion":{"type":"http","url":"https://mcp.notion.com/mcp"}}}');
  assert.equal(m.strictMcpConfig("notion", { ...details, hasHeaders: true }), null, "headers cannot be restated");
  assert.equal(m.strictMcpConfig("notion", { ...details, type: "stdio" }), null);
  const plan = { toolName: "mcp__notion__notion-fetch", settingSources: "", strictConfig: null, deny: m.notionDenyList("mcp__notion__notion-fetch", ["claude.ai Gmail", "plugin:x:y"], false) };
  assert.ok(plan.deny.includes("mcp__claude_ai_Gmail") && plan.deny.includes("mcp__plugin_x_y"), "every other server denied");
  assert.ok(plan.deny.includes("mcp__notion__notion-convert-page-to-skill") && plan.deny.includes("mcp__notion__notion-update-page"));
  assert.ok(!plan.deny.includes("mcp__notion__notion-fetch"));
  assert.throws(() => m.buildNotionFetchArgs({ model: "", effort: "", plan: { ...plan, toolName: "--tools" } }), /올바르지 않습니다/);
  const args = m.buildNotionFetchArgs({ model: "haiku", effort: "low", plan });
  assert.ok(!args.includes("--safe-mode"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]), { disableAllHooks: true });
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__notion__notion-fetch");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(m.notionPageId("https://www.notion.so/me/13-Memory-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?pvs=4"), "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d");
  // Content comes from the tool result: JSON form and plain text form.
  assert.deepEqual(m.pageFromToolResult(JSON.stringify({ text: "# 제목\n- 내용", page_last_edited_at: "2026-01-01T00:00:00Z", truncated: false })), { markdown: "# 제목\n- 내용\n", lastEdited: "2026-01-01T00:00:00Z", truncated: false });
  assert.equal(m.pageFromToolResult('<page>\npage_last_edited_at: "2026-02-02T00:00:00Z"\n- 내용\n</page>').lastEdited, "2026-02-02T00:00:00Z");
  assert.equal(m.pageFromToolResult(JSON.stringify({ text: "x", truncated: true })).truncated, true);
  assert.equal(m.pageFromToolResult("long page ... [truncated]").truncated, true);
  const pageUrl = "https://www.notion.so/me/Lec-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
  const ev = (type, content) => JSON.stringify({ type, message: { content } });
  const use = (id, input) => ev("assistant", [{ type: "tool_use", id, name: "mcp__notion__notion-fetch", input }]);
  const result = (id, text, isError = false) => ev("user", [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }]);
  const stream = [
    use("w", { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }), // a different page first
    result("w", "WRONG PAGE"),
    use("a", { id: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" }),
    result("a", "PAGE"),
    use("b", { id: pageUrl }),
    result("b", "SECOND FETCH"),
    result("other", "NOT THIS"),
    JSON.stringify({ type: "result", stop_reason: "end_turn" }),
  ].join("\n");
  assert.deepEqual(m.parseNotionStream(stream, "mcp__notion__notion-fetch", pageUrl), { toolUsed: true, fetchCount: 3, matched: true, resultText: "PAGE", isError: false, stopReason: "end_turn" }, "the first successful result for the requested page");
  assert.equal(m.parseNotionStream(stream, "mcp__x__notion-fetch", pageUrl).toolUsed, false);
  const failedFirst = [use("a", { id: pageUrl }), result("a", "rate limited", true), use("b", { id: pageUrl }), result("b", "PAGE")].join("\n");
  assert.equal(m.parseNotionStream(failedFirst, "mcp__notion__notion-fetch", pageUrl).resultText, "PAGE", "a failed result is passed over for a later success");
  const onlyOther = [use("w", { id: "ffffffffffffffffffffffffffffffff" }), result("w", "WRONG PAGE")].join("\n");
  assert.deepEqual(m.parseNotionStream(onlyOther, "mcp__notion__notion-fetch", pageUrl).matched, false);
  assert.equal(m.fetchInputMatches({ url: pageUrl }, pageUrl), true);
  assert.equal(m.fetchInputMatches({ id: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d" }, pageUrl), true);
  assert.equal(m.fetchInputMatches({ id: "notion://docs/enhanced-markdown-spec" }, pageUrl), false);
  // A plugin's .mcp.json entry.
  assert.deepEqual(m.detailsFromMcpJson({ mcpServers: { notion: { type: "http", url: "https://mcp.notion.com/mcp" } } }, "notion"), { scope: "plugin", type: "http", url: "https://mcp.notion.com/mcp", hasHeaders: false });
  assert.equal(m.detailsFromMcpJson({ notion: { url: "https://x", headers: { Authorization: "Bearer y" } } }, "notion").hasHeaders, true);
  assert.deepEqual(m.pluginServerParts("plugin:notion-tools:notion"), { plugin: "notion-tools", server: "notion" });
  console.log("PASS: Notion MCP: servers from `claude mcp list`, strict config from `claude mcp get`, deny list, hooks and user settings off, page from the tool result");

  const s2 = fakeSession("ok");
  const job2 = m.createJobDir();
  const cacheDir = join(mkdtempSync(join(tmpdir(), "alt2obs-notion-test-")), "notion");
  const url = "https://www.notion.so/me/13-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
  try {
    const usage = new m.UsageTracker();
    const provider = () => new m.NotionFetchProvider({ bin: FAKE_CLAUDE, model: "haiku", effort: "low", timeoutMs: 20000, workDir: job2, usage, task: "notion-fetch", ownsWorkDir: false });
    const fetch = (extra = {}) => m.fetchNotionPage(provider(), { bin: FAKE_CLAUDE, url, cacheDir, workDir: job2, ...extra });
    // No Notion MCP: setup guidance, no model call.
    process.env.FAKE_NOTION_MCP = "none";
    await assert.rejects(fetch(), (e) => e instanceof m.NotionMcpMissingError && /claude mcp add/.test(e.message));
    process.env.FAKE_NOTION_MCP = "failed";
    await assert.rejects(fetch(), /연결되어 있지 않습니다/);
    assert.equal(usage.total().calls, 0, "no model call without a connected Notion MCP");
    await assert.rejects(fetch({ url: "https://example.com/x" }), /노션 페이지 URL/);

    // A user-added server: strict config with only that server.
    process.env.FAKE_NOTION_MCP = "connected";
    const first = await fetch();
    assert.equal(first.strict, true);
    assert.equal(first.unchanged, false);
    assert.equal(first.markdown, "# 13강 노트\n\n- 캐시는 SRAM으로 만든다\n- DRAM은 SRAM보다 빠르다 (거짓)\n", "the tool result, not the model's DONE text");
    assert.equal(first.lastEdited, "2026-09-20T10:00:00.000Z");
    const files = readdirSync(cacheDir);
    assert.deepEqual(files, ["1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.json"]);
    assert.equal(statSync(join(cacheDir, files[0])).mode & 0o777, 0o600, "cache file 0600");
    assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
    assert.equal((await fetch()).unchanged, true, "same last edited time: reported unchanged");
    process.env.FAKE_NOTION_EDITED = "2026-09-27T09:00:00.000Z";
    process.env.FAKE_NOTION_PAGE = "- 새 내용 문장입니다";
    const edited = await fetch();
    assert.equal(edited.unchanged, false);
    assert.match(edited.markdown, /새 내용/);
    // A claude.ai connector: no strict config, every other server denied (checked by the fake).
    process.env.FAKE_NOTION_MCP = "connector";
    const viaConnector = await fetch();
    assert.equal(viaConnector.strict, false);
    assert.equal(viaConnector.server, "claude.ai Notion");
    // The model never called the tool: the tool was not available in this call, named with the server.
    process.env.FAKE_NOTION_NO_TOOL = "1";
    await assert.rejects(fetch(), (e) => !(e instanceof m.NotionMcpMissingError) && /이번 호출에서 쓰이지 않았습니다\. 서버: claude\.ai Notion/.test(e.message));
    delete process.env.FAKE_NOTION_NO_TOOL;
    // Another page fetched first: its result is not used, and two fetches are warned about.
    process.env.FAKE_NOTION_WRONG_FIRST = "1";
    const wrongFirst = await fetch();
    assert.doesNotMatch(wrongFirst.markdown, /다른 페이지/);
    assert.ok(wrongFirst.warnings.some((w) => /2번 일어났습니다/.test(w)));
    delete process.env.FAKE_NOTION_WRONG_FIRST;
    process.env.FAKE_NOTION_ID = "ffffffffffffffffffffffffffffffff";
    await assert.rejects(fetch(), /다른 페이지만 조회했습니다/);
    delete process.env.FAKE_NOTION_ID;
    // A result Claude Code saved to a file: read in full only from ~/.claude/projects/**/tool-results/.
    const home = mkdtempSync(join(tmpdir(), "alt2obs-home-"));
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(home, ".claude/projects/p/tool-results"), { recursive: true });
    process.env.FAKE_NOTION_PERSISTED = join(home, ".claude/projects/p/tool-results/out.txt");
    process.env.FAKE_NOTION_PAGE = "- 아주 긴 페이지의 전체 내용";
    const persisted = await fetch({ home });
    assert.equal(persisted.markdown, "- 아주 긴 페이지의 전체 내용\n", "the full result from the saved file");
    assert.deepEqual(persisted.warnings, []);
    process.env.FAKE_NOTION_PERSISTED = join(home, "elsewhere.txt");
    const outside = await fetch({ home });
    assert.ok(outside.warnings.some((w) => /잘렸습니다/.test(w)), "a saved file outside tool-results is not read: truncated");
    delete process.env.FAKE_NOTION_PERSISTED;
    delete process.env.FAKE_NOTION_PAGE;
    // A plugin's Notion server: restated from the plugin's .mcp.json, else user settings with hooks off.
    process.env.FAKE_NOTION_MCP = "plugin";
    const viaPluginLoose = await fetch({ home });
    assert.equal(viaPluginLoose.strict, false, "no .mcp.json found: user settings, hooks off, other servers denied");
    const pluginDir = join(home, ".claude/plugins/cache/mkt/notion-tools/1.0.0");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { notion: { type: "http", url: "https://mcp.notion.com/mcp" } } }));
    const viaPlugin = await fetch({ home });
    assert.equal(viaPlugin.strict, true, "restated from the plugin's .mcp.json");
    assert.equal(viaPlugin.server, "plugin:notion-tools:notion");
    rmSync(home, { recursive: true, force: true });
    process.env.FAKE_NOTION_ERROR = "object_not_found";
    await assert.rejects(fetch(), /가져오지 못했습니다: object_not_found/);
    delete process.env.FAKE_NOTION_ERROR;
    process.env.FAKE_NOTION_TRUNC = "1";
    assert.ok((await fetch()).warnings.some((w) => /잘렸습니다/.test(w)), "a truncated page is flagged");
    delete process.env.FAKE_NOTION_TRUNC;
    // Cancel.
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(fetch({ signal: ctrl.signal }));
    // A tool name from the settings is used as given.
    process.env.FAKE_NOTION_MCP = "connected";
    const before = s2.calls().length;
    await fetch({ toolName: "mcp__notion__notion-fetch" });
    assert.ok(s2.calls().slice(before).some((c) => c.argv.includes("--allowedTools") && c.argv.includes("mcp__notion__notion-fetch")));
    console.log("PASS: Notion fetch: setup guidance without MCP, strict config for a user server, connector with every other server denied, page from the tool result, cached (0600), truncation flagged, cancel");
  } finally {
    for (const k of ["FAKE_NOTION_MCP", "FAKE_NOTION_EDITED", "FAKE_NOTION_PAGE", "FAKE_NOTION_NO_TOOL", "FAKE_NOTION_ERROR", "FAKE_NOTION_TRUNC", "FAKE_NOTION_WRONG_FIRST", "FAKE_NOTION_ID", "FAKE_NOTION_PERSISTED"]) delete process.env[k];
    m.removeJobDir(job2);
    s2.cleanup();
    rmSync(join(cacheDir, ".."), { recursive: true, force: true });
  }
}
