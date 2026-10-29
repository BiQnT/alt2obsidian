/**
 * Test: what a question sends (2.1.0 spec 6, src/chat): the system prompt
 * and user message in their order and exact block headers, the transcript
 * lines (30 seconds or 200 characters, cleaned, capped by overlap), the
 * earlier conversation folded to 3,000 tokens, the estimate, the slide
 * range input, the grounding marks of an answer, the threads (LRU and the
 * "슬라이드 N으로 이동" dividers) and the note parts the panel reads.
 * No tokens, no obsidian.
 * Run: node test/test-chat.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";

const m = await importTs("test/helpers/chat-entry.ts");
const INSTRUCTIONS = readFileSync(join(repo, "prompts/chat.system.md"), "utf8");

// ---- the pack: order and formats (spec 6.1, 6.2) ----
{
  const unit = {
    lecture: "L5",
    unit: "slide",
    num: 17,
    range: "[29:06~35:56]",
    slideText: "Floating point addition\nsmall + large",
    imageAttached: false,
    commentary: "작은 수끼리 먼저 더해야 정밀도를 지킨다.",
    memo: "시험 범위",
    transcript: [{ startMs: 29 * 60_000 + 10_000, text: "작은 수를 먼저 더합니다." }, { startMs: 29 * 60_000 + 41_000, text: "큰 수에 더하면 사라집니다." }],
  };
  const pack = m.buildChatPack({
    instructions: INSTRUCTIONS,
    subject: "CSED423",
    lecture: "L5",
    neighbours: { prev: "L4", next: "L6" },
    brief: "## 개요\n부동소수점 덧셈을 다룬다.",
    extraBriefs: [],
    history: [{ label: "슬라이드 16 기준", question: "정밀도가 뭐야?", answer: "유효 숫자의 수다 [슬라이드 16]." }],
    focus: [unit],
    quote: "small + large\n= large",
    question: "왜 작은 수부터 더해?",
  });
  assert.equal(pack.system, `${INSTRUCTIONS.trim()}\n\n[강의 브리프: CSED423 · L5 (앞 강의: L4, 다음 강의: L6)]\n## 개요\n부동소수점 덧셈을 다룬다.`, "instructions, then the brief: the cached prefix");
  assert.equal(
    pack.user,
    [
      "[이전 대화]",
      "Q (슬라이드 16 기준): 정밀도가 뭐야?",
      "A: 유효 숫자의 수다 [슬라이드 16].",
      "",
      "[이번 자료]",
      "## L5 · 슬라이드 17 [29:06~35:56]",
      "### 슬라이드 글",
      "Floating point addition\nsmall + large",
      "### 해설",
      "작은 수끼리 먼저 더해야 정밀도를 지킨다.",
      "### 내 메모",
      "시험 범위",
      "### 전사",
      "[29:10] 작은 수를 먼저 더합니다.",
      "[29:41] 큰 수에 더하면 사라집니다.",
      "",
      "[선택한 글]",
      "> small + large",
      "> = large",
      "",
      "[질문]",
      "왜 작은 수부터 더해?",
    ].join("\n")
  );
  // No brief (or the brief chip off): one line. No history, no quote: those blocks are left out.
  const bare = m.buildChatPack({ instructions: "지시", subject: "CSED423", lecture: "L5", neighbours: { prev: null, next: "L6" }, brief: null, extraBriefs: [], history: [], focus: [], quote: null, question: "개요?" });
  assert.equal(bare.system, "지시\n\n[강의: CSED423 · L5 (브리프 없음)]");
  assert.equal(bare.user, "[질문]\n개요?");
  assert.equal(m.briefHeader("S", "L1", { prev: null, next: null }, true), "[강의 브리프: S · L1]");
  assert.equal(m.briefHeader("S", "L2", { prev: "L1", next: null }, true), "[강의 브리프: S · L2 (앞 강의: L1)]");
  // Extra briefs follow the lecture brief (phase 3 adds them; the shape is ready).
  const extra = m.buildSystemPrompt({ instructions: "지시", subject: "S", lecture: "L5", neighbours: { prev: null, next: null }, brief: "b", extraBriefs: [{ title: "과목 브리프: S", body: "- L1: x" }, { title: "다른 강의 브리프: S · L4", body: "c" }] });
  assert.equal(extra, "지시\n\n[강의 브리프: S · L5]\nb\n\n[과목 브리프: S]\n- L1: x\n\n[다른 강의 브리프: S · L4]\nc");
  // A page without a text layer goes as an image; a section unit has 요약 instead of 해설.
  assert.equal(m.renderFocusUnit({ ...unit, imageAttached: true, memo: "", transcript: [] }), "## L5 · 슬라이드 17 [29:06~35:56]\n### 슬라이드 글\n(글이 없는 페이지라 이미지를 함께 보냄)\n### 해설\n작은 수끼리 먼저 더해야 정밀도를 지킨다.");
  assert.equal(m.renderFocusUnit({ lecture: "6강", unit: "section", num: 3, range: "[24:00~36:00]", slideText: "", imageAttached: false, commentary: "- 요약", memo: "", transcript: [] }), "## 6강 · 구간 3 [24:00~36:00]\n### 요약\n- 요약");
  assert.equal(m.materialLabel([{ unit: "slide", num: 17 }], true), "슬라이드 17 기준");
  assert.equal(m.materialLabel([{ unit: "slide", num: 17 }, { unit: "slide", num: 18 }], true), "슬라이드 17, 18 기준");
  assert.equal(m.materialLabel([], true), "강의 브리프 기준");
  assert.equal(m.materialLabel([], false), "");
  assert.ok(!/[–—]/.test(INSTRUCTIONS), "no em or en dash in the instructions");
  console.log("PASS: question pack: system prompt (instructions, brief header with neighbours, extra briefs), user message blocks in order with exact headers, no-brief line, image and section units");
}

// ---- transcript lines: 30 s or 200 characters, cleaned, capped by overlap (spec 6.2) ----
{
  const at = (s) => s * 1000;
  const segs = [
    { startMs: at(10), endMs: at(14), text: "음 작은 수를 먼저 더합니다." },
    { startMs: at(15), endMs: at(20), text: "그래서 그래서 정밀도가 지켜집니다." },
    { startMs: at(41), endMs: at(45), text: "작은 수를 먼저 더합니다." },
    { startMs: at(46), endMs: at(50), text: "큰 수에 작은 수를 더하면 사라집니다." },
    { startMs: at(52), endMs: at(60), text: "가".repeat(210) + "." },
    { startMs: at(61), endMs: at(62), text: "다음 줄입니다." },
  ];
  const lines = m.transcriptLines(segs, 1200, "");
  assert.deepEqual(
    lines.map((l) => [l.startMs, l.text]),
    [
      [at(10), "작은 수를 먼저 더합니다. 그래서 정밀도가 지켜집니다."],
      [at(41), "큰 수에 작은 수를 더하면 사라집니다. " + "가".repeat(210) + "."],
      [at(61), "다음 줄입니다."],
    ],
    "grouped by 30 s, a new line after 200 characters, fillers and repeats removed, a sentence an earlier line has is dropped"
  );
  assert.equal(m.formatTranscriptLines(lines.slice(0, 1)), "[00:10] 작은 수를 먼저 더합니다. 그래서 정밀도가 지켜집니다.");
  // Over the cap: the lines sharing the most words with the slide and the question stay, in time order.
  const many = Array.from({ length: 12 }, (_, i) => ({ startMs: at(i * 40), endMs: at(i * 40 + 5), text: i === 7 ? "정밀도 손실은 작은 수 덧셈 순서로 막는다." : `관계없는 이야기 ${i}번째 줄입니다 ${"나".repeat(30)}.` }));
  const capped = m.transcriptLines(many, 120, "정밀도 덧셈 순서");
  assert.ok(capped.some((l) => l.text.startsWith("정밀도 손실")), "the line about the question stays");
  assert.ok(capped.reduce((n, l) => n + l.text.length + 8, 0) <= 120, "within the cap");
  assert.deepEqual(capped.map((l) => l.startMs), [...capped.map((l) => l.startMs)].sort((a, b) => a - b), "in time order");
  // Only the segments in the slide's aligned spans.
  const spans = [{ slide: 3, startMs: at(40), endMs: at(60), low: false }];
  assert.deepEqual(m.segmentsInSpans(segs, spans).map((s) => s.startMs), [at(41), at(46), at(52)]);
  console.log("PASS: transcript lines grouped by 30 seconds or 200 characters, cleaned and de-duplicated, capped by overlap with the slide and the question, in time order");
}

// ---- earlier conversation folded past 3,000 tokens (spec 6.3) ----
{
  const turn = (i) => ({ label: `슬라이드 ${i} 기준`, question: `${i}번째 질문은 무엇인가? ${"질".repeat(100)}`, answer: `${i}번째 답의 첫 문장이다. ${"답".repeat(600)}` });
  const small = m.foldHistory([turn(1), turn(2)]);
  assert.deepEqual([small.folded, small.dropped], [0, 0]);
  const big = m.foldHistory(Array.from({ length: 6 }, (_, i) => turn(i + 1)));
  assert.ok(big.folded > 0, "past the cap the oldest turns are folded");
  assert.match(big.entries[0], /^Q: 1번째 질문은 무엇인가\? 질+ → A: 1번째 답의 첫 문장이다\.$/);
  assert.equal(Array.from(big.entries[0].split(" → A: ")[0].slice(3)).length, 80, "the question cut to 80 characters");
  assert.ok(big.entries[big.entries.length - 1].startsWith("Q (슬라이드 6 기준):"), "the newest turn stays whole");
  assert.ok(m.estimateTextTokens(big.entries.join("\n\n")) <= m.HISTORY_TOKEN_CAP);
  // Still too long when every turn is one line: the oldest lines go.
  const huge = m.foldHistory(Array.from({ length: 80 }, (_, i) => turn(i + 1)));
  assert.equal(huge.folded, 80);
  assert.ok(huge.dropped > 0 && huge.entries.length === 80 - huge.dropped);
  assert.ok(huge.entries[0].startsWith(`Q: ${huge.dropped + 1}번째`), "the oldest are dropped first");
  const pack = m.buildChatPack({ instructions: "x", subject: "", lecture: "L", neighbours: { prev: null, next: null }, brief: null, extraBriefs: [], history: Array.from({ length: 6 }, (_, i) => turn(i + 1)), focus: [], quote: null, question: "q" });
  assert.equal(pack.folded, big.folded, "the pack reports how many were folded");
  console.log("PASS: earlier turns folded oldest first to one line (question 80, first answer sentence 120) past 3,000 tokens, then the oldest lines dropped");
}

// ---- estimate (spec 6.4) ----
{
  const pack = { system: "a".repeat(2000), user: "가".repeat(1000) };
  const claude = m.estimateChat(pack, "claude-cli", "low", 1);
  assert.deepEqual(claude, { input: m.estimateTextTokens(`${pack.system}\n\n${pack.user}`) + m.PROVIDER_COSTS["claude-cli"].fixedPerTurn + m.PROVIDER_COSTS["claude-cli"].perImage, output: Math.round(800 * 0.78), cached: 1000 });
  const codex = m.estimateChat(pack, "codex-cli", "medium", 0);
  assert.equal(codex.input, m.estimateTextTokens(`${pack.system}\n\n${pack.user}`) + 11900);
  assert.deepEqual([codex.output, codex.cached], [800, 0], "no cache line for Codex");
  console.log("PASS: question estimate: text plus the CLI's fixed tokens plus images, output 800 times the effort factor, cached prefix for Claude only");
}

// ---- slide range input (spec 5.6, 5.7) ----
{
  assert.deepEqual(m.parseSlideRange("14-18, 23", 30), { slides: [14, 15, 16, 17, 18, 23], ignored: [] });
  assert.deepEqual(m.parseSlideRange("14~16 15 40 0", 30), { slides: [14, 15, 16], ignored: [0, 40] }, "~ works, repeats merged, out of range listed");
  assert.deepEqual(m.parseSlideRange("18-16", 30).slides, [16, 17, 18]);
  assert.deepEqual(m.parseSlideRange("", 30), { slides: [], ignored: [] });
  console.log("PASS: slide range input: 14-18, 23 and 14~18, repeats merged, numbers outside the deck ignored and listed");
}

// ---- grounding marks (spec 5.5) ----
{
  const limits = { slides: 30, sections: 0, lengthMs: 60 * 60_000 };
  const parts = m.parseCitations("작은 수부터 [슬라이드 17]. 범위 [슬라이드 14~16], 둘 [슬라이드 3, 5]. 시각 [29:10]과 [1:00:59], 밖 [1:01:01]. 없는 [슬라이드 31] [구간 2]. 일반 지식이다 (강의 자료 밖)", limits);
  const kinds = parts.filter((p) => p.kind !== "text").map((p) => [p.kind, p.slides ?? p.ms ?? p.num ?? null]);
  assert.deepEqual(kinds, [
    ["slide", [17]],
    ["slide", [14, 15, 16]],
    ["slide", [3, 5]],
    ["time", 29 * 60_000 + 10_000],
    ["time", 3659_000],
    ["outside", null],
  ]);
  assert.equal(parts.map((p) => p.text).join(""), "작은 수부터 [슬라이드 17]. 범위 [슬라이드 14~16], 둘 [슬라이드 3, 5]. 시각 [29:10]과 [1:00:59], 밖 [1:01:01]. 없는 [슬라이드 31] [구간 2]. 일반 지식이다 (강의 자료 밖)", "nothing lost");
  assert.ok(parts.some((p) => p.kind === "text" && p.text.includes("[1:01:01]") && p.text.includes("[슬라이드 31] [구간 2]")), "past the end plus a minute, past the last slide, and sections of a slide note stay text");
  const sections = m.parseCitations("[구간 2]와 [구간 9]", { slides: 0, sections: 8, lengthMs: null });
  assert.deepEqual(sections.map((p) => p.kind), ["section", "text"], "[구간 9] past the last section stays text");
  assert.deepEqual(m.parseCitations("[99:00]", { slides: 0, sections: 0, lengthMs: null }).map((p) => p.kind), ["time"], "unknown length: every time");
  assert.deepEqual(m.parseCitations("[슬라이드 5~2]", limits).map((p) => p.kind), ["text"], "a backwards range stays text");
  console.log("PASS: grounding marks: slide, list, range, section, mm:ss and h:mm:ss, outside badge; out-of-range marks stay text");
}

// ---- threads: LRU of 10, dividers, history (spec 5.1, 5.2, 5.4) ----
{
  const store = new m.ThreadStore();
  for (let i = 1; i <= 12; i++) store.get(`L${i}.md`);
  assert.equal(store.peek("L1.md"), undefined, "the oldest two are dropped");
  assert.ok(store.peek("L3.md") && store.peek("L12.md"));
  store.get("L3.md");
  store.get("L13.md");
  assert.ok(store.peek("L3.md"), "a used thread moves to the front");
  assert.equal(store.peek("L4.md"), undefined);

  const t = store.get("L5.md");
  m.moveThreadTo(t, 17);
  assert.equal(t.items.length, 0, "no divider before the first question");
  const turn = (slide, status = "done") => ({ id: m.newTurnId(), question: `q${slide}`, label: `슬라이드 ${slide} 기준`, slide, answer: `a${slide}`, status, request: { task: { provider: "claude-cli", model: "", effort: "" }, system: "", user: "", images: [] }, at: 0 });
  t.items.push({ kind: "turn", turn: turn(17) });
  m.moveThreadTo(t, 17);
  assert.equal(t.items.length, 1, "the same slide: no divider");
  m.moveThreadTo(t, 18);
  m.moveThreadTo(t, 19);
  assert.deepEqual(t.items.slice(1), [{ kind: "divider", slide: 19 }], "moving on before a question replaces the divider");
  m.moveThreadTo(t, 17);
  assert.equal(t.items.length, 1, "back on the conversation's slide: the divider goes");
  m.moveThreadTo(t, 18);
  t.items.push({ kind: "turn", turn: turn(18, "stopped") });
  t.items.push({ kind: "turn", turn: turn(18, "error") });
  t.items.push({ kind: "turn", turn: turn(18) });
  assert.deepEqual(m.historyOf(t).map((h) => h.question), ["q17", "q18"], "stopped and failed turns are not sent again");
  assert.deepEqual(store.recent().map((x) => x.notePath), ["L5.md"], "recent threads: only with a turn");
  store.clear("L5.md");
  assert.deepEqual(store.peek("L5.md").items, []);
  console.log("PASS: threads: 10 most recent kept, dividers on a followed slide change (replaced, removed on return), history without stopped or failed turns");
}

// ---- note parts the panel reads ----
{
  const note = ["# L5", "## 📋 전체 요약", "x", "## 📚 슬라이드 3", "a", "b", "## ⏱ 구간 2 [00:00~01:00]", "c"].join("\n");
  assert.equal(m.unitAtLine(note, 2), null, "above the first slide");
  assert.deepEqual(m.unitAtLine(note, 5), { unit: "slide", num: 3 });
  assert.deepEqual(m.unitAtLine(note, 7), { unit: "section", num: 2 });
  assert.equal(m.memoText("\n\n> [!note] 내 메모\n> 첫 줄\n>\n> 둘째 줄\n\n뒤 글"), "첫 줄\n\n둘째 줄");
  assert.equal(m.memoText("\n\n> [!note] 내 메모\n> \n"), "", "an empty memo");
  assert.equal(m.commentaryText('본문 [[A (가)|A]]\n\n![[x.png]]\n\n<!-- alt2obs:meta img:none gist:"g" -->'), "본문 A");
  console.log("PASS: note parts for the panel: the slide or section above the cursor, memo text, commentary without meta, embeds or links");
}
