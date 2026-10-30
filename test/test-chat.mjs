/**
 * Test: what a question sends (2.1.0 spec 6, src/chat): the system prompt
 * and user message in their order and exact block headers, the transcript
 * lines (30 seconds or 200 characters, cleaned, capped by overlap), the
 * earlier conversation folded to 3,000 tokens, the estimate, the slide
 * range input, the "+ 자료 추가" plan (range and checks, the 8-slide limit,
 * the estimate), "메모에 저장" (the memo callout filled, appended to or
 * made, CRLF kept, kept by a re-import), the grounding marks of an answer,
 * the threads (LRU and the
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
      "```text",
      "Floating point addition\nsmall + large",
      "```",
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
  // Slide text sits in a text fence, so a page line starting with # is not a heading of the pack; the fence outgrows backticks in it.
  assert.match(m.renderFocusUnit({ ...unit, slideText: "# Title\n`a` ```b```", memo: "", transcript: [] }), /### 슬라이드 글\n````text\n# Title\n`a` ```b```\n````\n### 해설/);
  assert.equal(m.renderFocusUnit({ lecture: "6강", unit: "section", num: 3, range: "[24:00~36:00]", slideText: "", imageAttached: false, commentary: "- 요약", memo: "", transcript: [] }), "## 6강 · 구간 3 [24:00~36:00]\n### 요약\n- 요약");
  assert.equal(m.materialLabel([{ unit: "slide", num: 17 }], true), "슬라이드 17 기준");
  assert.equal(m.materialLabel([{ unit: "slide", num: 17 }, { unit: "slide", num: 18 }], true), "슬라이드 17, 18 기준");
  assert.equal(m.materialLabel([], true), "강의 브리프 기준");
  assert.equal(m.materialLabel([], false), "");
  assert.ok(!/[\u2013\u2014]/.test(INSTRUCTIONS), "no em or en dash in the instructions");
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
  // Another lecture's slides (the question sent L4, 12 slides): `[L4 슬라이드 N]`, lists and ranges, the heading's `·` too.
  const L4 = { notePath: "A/CSED423/Lectures/L4.md", name: "L4", subject: "CSED423", slides: 12 };
  const withOthers = { ...limits, notePath: "A/CSED423/Lectures/L5.md", name: "L5", lectures: [L4, { notePath: "A/CSED423/Lectures/Lec 3 Pipelining.md", name: "Lec 3 Pipelining", subject: "CSED423", slides: 40 }] };
  const other = m.parseCitations("[L4 슬라이드 3] [L4 슬라이드 2, 5~6] [L4 · 슬라이드 7] [Lec 3 Pipelining 슬라이드 33] [L5 슬라이드 25] [L4 슬라이드 13] [L3 슬라이드 1] [참고 슬라이드 2] [슬라이드 12]", withOthers);
  assert.deepEqual(
    other.filter((p) => p.kind === "slide").map((p) => [p.lecture?.name ?? null, p.slides]),
    [
      ["L4", [3]],
      ["L4", [2, 5, 6]],
      ["L4", [7]],
      ["Lec 3 Pipelining", [33]],
      [null, [25]],
      [null, [12]],
    ],
    "another lecture's slides by its own count; this lecture's name is a plain mark"
  );
  assert.ok(other.some((p) => p.kind === "text" && p.text.includes("[L4 슬라이드 13] [L3 슬라이드 1] [참고 슬라이드 2]")), "past that lecture's last slide, a lecture the question did not send, any other word: text");
  assert.equal(other.map((p) => p.text).join(""), "[L4 슬라이드 3] [L4 슬라이드 2, 5~6] [L4 · 슬라이드 7] [Lec 3 Pipelining 슬라이드 33] [L5 슬라이드 25] [L4 슬라이드 13] [L3 슬라이드 1] [참고 슬라이드 2] [슬라이드 12]");
  assert.deepEqual(m.parseCitations("[L4 슬라이드 3]", limits).map((p) => p.kind), ["text"], "no other lecture sent: text");
  // Words before the lecture's name: the last run of words that names a sent lecture (or this one) counts.
  const named = (t, l = withOthers) => m.parseCitations(t, l).filter((p) => p.kind === "slide").map((p) => [p.lecture?.notePath ?? null, p.slides[0]]);
  assert.deepEqual(named("[CSED423 · L4 슬라이드 3] [다른 강의 L4 슬라이드 4] [L4 강의 슬라이드 5] [CSED423 Lec 3 Pipelining 슬라이드 6] [L4 아니고 L5 슬라이드 7]"), [
    [L4.notePath, 3],
    [L4.notePath, 4],
    [L4.notePath, 5],
    ["A/CSED423/Lectures/Lec 3 Pipelining.md", 6],
    [null, 7],
  ], "subject before it, words around it; the last name wins (L5, this lecture)");
  // Two sent lectures of one name: the one in this lecture's subject folder.
  const twin = { notePath: "A/CSED311/Lectures/L4.md", name: "L4", subject: "컴퓨터구조", slides: 40 };
  assert.deepEqual(named("[L4 슬라이드 3]", { ...withOthers, lectures: [twin, L4] }), [[L4.notePath, 3]], "same subject folder first");
  assert.deepEqual(named("[L4 슬라이드 30]", { ...withOthers, lectures: [twin, L4] }), [], "its slide count decides (30 is past CSED423's L4)");
  assert.deepEqual(named("[L4 슬라이드 30]", { ...withOthers, notePath: "A/EECS/L9.md", lectures: [twin, L4] }), [[twin.notePath, 30]], "no lecture of that name in the folder: the first sent");
  // A subject named before the name decides first: the note's subject or its subject folder's name.
  assert.deepEqual(named("[CSED311 L4 슬라이드 3] [컴퓨터구조 · L4 슬라이드 4] [csed423 L4 슬라이드 5]", { ...withOthers, lectures: [L4, twin] }), [
    [twin.notePath, 3],
    [twin.notePath, 4],
    [L4.notePath, 5],
  ], "the subject before the name wins over this lecture's folder (folder name or subject, any case)");
  console.log("PASS: grounding marks: slide, list, range, section, mm:ss and h:mm:ss, outside badge; out-of-range marks stay text; [L4 슬라이드 N] for another lecture the question sent, by its slide count");
}

// ---- threads: made on the first question, LRU of 10 with turns, dividers, history (spec 5.1, 5.2, 5.4) ----
{
  const store = new m.ThreadStore();
  const turn = (slide, status = "done") => ({ id: m.newTurnId(), question: `q${slide}`, label: `슬라이드 ${slide} 기준`, slide, answer: `a${slide}`, status, request: { task: { provider: "claude-cli", model: "", effort: "" }, system: "", user: "", images: [] }, at: 0 });
  const ask = (path) => store.get(path).items.push({ kind: "turn", turn: turn(1) });
  assert.equal(store.peek("L0.md"), undefined, "looking at a lecture makes no thread");
  for (let i = 1; i <= 12; i++) ask(`L${i}.md`);
  assert.equal(store.peek("L1.md"), undefined, "the oldest two are dropped");
  assert.ok(store.peek("L3.md") && store.peek("L12.md"));
  ask("L3.md");
  ask("L13.md");
  assert.ok(store.peek("L3.md"), "a used thread moves to the front");
  assert.equal(store.peek("L4.md"), undefined);
  // A thread made for a question counts while it is asked; left without a turn it never pushes one out later.
  store.get("E.md");
  assert.equal(store.recent().length, 9, "the thread being asked in takes a place");
  ask("X.md");
  assert.equal(store.recent().length, 10, "the empty one no longer counts");
  assert.ok(store.peek("E.md") && store.peek("L6.md"));

  const t = store.get("L5.md");
  store.clear("L5.md");
  assert.equal(store.peek("L5.md"), undefined, "새 대화: the thread goes");
  const fresh = store.get("L5.md");
  m.moveThreadTo(fresh, 17);
  assert.equal(fresh.items.length, 0, "no divider before the first question");
  fresh.items.push({ kind: "turn", turn: turn(17) });
  m.moveThreadTo(fresh, 17);
  assert.equal(fresh.items.length, 1, "the same slide: no divider");
  m.moveThreadTo(fresh, 18);
  m.moveThreadTo(fresh, 19);
  assert.deepEqual(fresh.items.slice(1), [{ kind: "divider", slide: 19 }], "moving on before a question replaces the divider");
  m.moveThreadTo(fresh, 17);
  assert.equal(fresh.items.length, 1, "back on the conversation's slide: the divider goes");
  m.moveThreadTo(fresh, 18);
  fresh.items.push({ kind: "turn", turn: turn(18, "stopped") });
  fresh.items.push({ kind: "turn", turn: turn(18, "error") });
  fresh.items.push({ kind: "turn", turn: turn(18) });
  assert.deepEqual(m.historyOf(fresh).map((h) => h.question), ["q17", "q18"], "stopped and failed turns are not sent again");
  assert.deepEqual(m.historyOf(undefined), []);
  assert.equal(store.recent()[0].notePath, "L5.md", "recent: the last used first");
  assert.ok(t !== fresh);
  console.log("PASS: threads: made on the first question (looking makes none), 10 kept with turns (an empty one never counts), 새 대화 drops it, dividers on a followed slide change, history without stopped or failed turns");
}

// ---- runs belong to the store: they outlive the panel, stop on request (spec 5.4) ----
{
  const store = new m.ThreadStore();
  const thread = store.get("L5.md");
  const turn = { id: m.newTurnId(), question: "q", label: "", slide: 1, answer: "", status: "streaming", request: { task: { provider: "claude-cli", model: "sonnet", effort: "low" }, system: "S", user: "U", images: [] }, at: 0 };
  thread.items.push({ kind: "turn", turn });
  const events = [];
  const off = store.subscribe((e) => events.push([e.kind, e.turn.answer]));
  let release;
  const runner = {
    runChat: async (req) => {
      req.onDelta("첫 ");
      req.onReset();
      req.onDelta("다시 ");
      await new Promise((r) => (release = r));
      req.onDelta("끝");
      return { text: "다시 끝", usage: { calls: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, imagesSent: 0, costUsd: 0 }, model: "claude-sonnet-5-5" };
    },
    chatErrorInfo: (e) => ({ kind: "other", message: String(e) }),
  };
  const run = store.run(thread, turn, runner);
  assert.equal(store.isRunning(thread), true);
  off(); // the panel closes: nobody listens, the run goes on
  release();
  await run;
  assert.deepEqual(events, [["start", ""], ["delta", "첫 "], ["delta", ""], ["delta", "다시 "]], "events until the listener left; a reset empties the answer");
  assert.deepEqual([turn.status, turn.answer, turn.model, turn.usage.outputTokens, store.isRunning(thread)], ["done", "다시 끝", "claude-sonnet-5-5", 2, false], "the run finished in the thread without a panel");
  // Stop: what came stays, marked; a failure becomes the turn's error.
  const stopping = store.run(thread, turn, { runChat: (req) => new Promise((_, reject) => (req.onDelta("부분"), req.signal.addEventListener("abort", () => reject(new Error("aborted"))))), chatErrorInfo: runner.chatErrorInfo });
  store.stop(turn);
  await stopping;
  assert.deepEqual([turn.status, turn.answer], ["stopped", "부분"]);
  await store.run(thread, turn, { runChat: async () => { throw new Error("boom"); }, chatErrorInfo: (e) => ({ kind: "timeout", message: e.message }) });
  assert.deepEqual([turn.status, turn.error], ["error", { kind: "timeout", message: "boom" }]);
  // One run per thread: a second turn asked to run while one answers does not start.
  const second = { ...turn, id: m.newTurnId(), answer: "", status: "done", error: undefined };
  thread.items.push({ kind: "turn", turn: second });
  let secondCalls = 0;
  const lost = store.run(thread, turn, { runChat: (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")))), chatErrorInfo: runner.chatErrorInfo });
  await store.run(thread, second, { runChat: async () => (secondCalls++, { text: "x", usage: turn.usage, model: "" }), chatErrorInfo: runner.chatErrorInfo });
  assert.deepEqual([secondCalls, second.status], [0, "done"], "refused while the thread answers");
  // Unload: dropAll stops what runs, and nothing starts after it.
  store.dropAll();
  await lost;
  assert.equal(turn.status, "stopped");
  await store.run(thread, second, { runChat: async () => (secondCalls++, { text: "x", usage: turn.usage, model: "" }), chatErrorInfo: runner.chatErrorInfo });
  assert.equal(secondCalls, 0, "no run after dropAll");
  console.log("PASS: a run belongs to the thread store: it streams into the turn with or without a listener, a reset starts the answer over, stop keeps the part, errors land in the turn, one run per thread, unload stops it and refuses new runs");
}

// ---- model output made safe before rendering (review L6): context-free transforms ----
{
  const zw = String.fromCharCode(0x200b);
  const nbsp = String.fromCharCode(0xa0);
  const bare = (s) => s.split(zw).join("");
  const safe = (s) => m.safeAnswerMarkdown(s);
  // What a line's text is after its containers (quote marks, a front matter's ---, footnote labels, list markers, white space).
  const CONTAINERS = /^(?:[^\S\n]*(?:>|---|\[\^[^\]\n]+\]:|(?:[-*+]|\d{1,9}[.)])(?=\s|$)))*[^\S\n]*/;
  /** The output's invariants, which need no Markdown parser. */
  const invariants = (name, input) => {
    const out = safe(input);
    assert.ok(!/<[A-Za-z!/?]/.test(out), `${name}: no < that opens a tag, comment or declaration (a space after it in math)`);
    assert.ok(!out.includes("!["), `${name}: no ![`);
    assert.ok(!/`\s*\$?=/.test(out), `${name}: no backtick followed by = or $= after white space`);
    for (const line of out.split("\n")) {
      const text = line.slice(line.match(CONTAINERS)[0].length);
      // (A heading's === underline cannot read as a query: what follows its first = is another =.)
      assert.ok(!/^\$?=/.test(text) || /^={2,}\s*$/.test(text), `${name}: no line whose text opens with = or $=: ${JSON.stringify(line)}`);
      assert.ok(!text.startsWith("%%"), `${name}: no block comment opens: ${JSON.stringify(line)}`);
      const fence = text.match(/^(`{3,}|~{3,})(.*)$/);
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        const lang = fence[2].replace(/^[ \t]+/, "").split(/[ \t]/)[0];
        assert.ok(lang === "" || m.SAFE_LANGUAGES.has(lang.toLowerCase()), `${name}: fence language ${lang} is on the allow-list`);
      }
    }
    // Nothing else changes: each line only gains zero-width spaces (a space after < in math), or is a fence relabeled `text`.
    const inLines = input.replace(/\r\n?/g, "\n").split("\n");
    const outLines = out.split("\n");
    assert.equal(outLines.length, inLines.length, `${name}: no line added or removed`);
    for (const [i, line] of outLines.entries()) {
      const tight = (t) => t.replace(/<\s+/g, "<");
      const kept = tight(bare(line)) === tight(inLines[i]);
      const relabeled = /(`{3,}|~{3,})text$/.test(line) && inLines[i].startsWith(line.slice(0, -4));
      assert.ok(kept || relabeled, `${name}: line ${i} keeps its text: ${JSON.stringify(line)}`);
    }
    return out;
  };
  // Every input of the reviewer's reports (bypasses of the structure-guessing sanitizer), and the earlier ones.
  const evil = '<img src="https://evil.example/x.png">';
  const query = "`$= dv.paragraph(1)`";
  const cases = {
    known: "    ```\n```dataviewjs\ndv.paragraph(1)\n```",
    crlf: "```dataviewjs\r\ndv.paragraph(1)\r\n```",
    tabs: "\t```dataviewjs\ndv.x\n```\n-\t```dataviewjs\n\tdv.x\n\t```",
    tilde: "~~~dataviewjs\ndv.x\n~~~",
    nestedCallout: "> [!note]\n> > [!tip]\n> > ```dataviewjs\n> > dv.x\n> > ```",
    listMixed: "- a\n \t```dataviewjs\n  dv.x\n  ```\n1. b\n   ```DataviewJS title\n   dv.x\n   ```",
    entityLang: "```&#100;ataviewjs\ndv.x\n```",
    upper: "```DATAVIEWJS\nx\n```",
    query: "```query\ntag:#x\n```",
    mermaid: "```mermaid\ngraph TD; A-->B\n```",
    splitInline1: "text `$= dv.paragraph(1)\n`",
    splitInline2: "text `= this.file.name\nmore`",
    splitInlineNbsp: `text \`\n${nbsp}$= dv.paragraph(1)\``,
    splitInlineSpace: "text `\n= this.file.name`",
    rawCode: "<code>= this.file.name</code>",
    imgCodeAlt: "![`x`](https://evil.example/x.png)",
    imgRefCode: "![`r`]\n\n[`r`]: https://evil.example/x.png",
    imgMultiline: "![a\nb](https://evil.example/x.png)",
    imgUrlNextLine: "![a](\nhttps://evil.example/x.png)",
    imgEntity: "![a](https&#58;//evil.example/x.png)",
    imgEscape: "![a](https\\://evil.example/x.png)",
    imgProtoRel: "![a](//evil.example/x.png)",
    imgRefDef: "![a][r]\n\n[r]: https://evil.example/x.png",
    nestedListFence: `- a\n  - b\n  \`\`\`text\n${evil}\n${query}`,
    quoteInList: `- a\n  > \`\`\`text\n> ${evil}\n> ${query}`,
    wideMarker: `-     a\n  \`\`\`text\n${evil}\n${query}`,
    tabQuote: `> > \`\`\`text\n>\t\t> x\n> > ${evil}\n> > ${query}`,
    backtickInfo: `\`\`\`js \`x\`\ncode\n\`\`\`\n${evil}\n${query}`,
    closeTilde: `\`\`\`text\nx\n\`\`\`~\n${evil}\n${query}`,
    indentedClose: `\`\`\`text\nx\n    \`\`\`\n${evil}`,
    html: "<div onclick=x>hi</div>\n<b>ok</b> <b class=x>no</b> <!-- c --> <?php ?> <svg/onload=x>",
    styleUrl: '<span style="background:url(https://evil.example/x.png)">x</span>',
    multilineTag: '<b\nstyle="x">y</b>',
    tabQuote2: `\t> \`\`\`text\n> ${evil}\n> ${query}`,
    spaceTabQuote: ` \t> \`\`\`text\n> ${evil}`,
    quoteLineInListFence: `- \`\`\`js\n  > x\n  \`\`\`\n  ${query}\n  ${evil}`,
    quoteLineInListFence2: `1. 예시:\n   \`\`\`sh\n   > echo hi\n   \`\`\`\n   ${query}`,
    pyRepl: "1. 예:\n   ```python\n   >>> 1 + 1\n   2\n   ```\n   ![x](https://evil.example/x.png)",
    pyReplTop: "```python\n>>> 1 + 1\n```\n![x](https://evil.example/x.png)",
    entityBang: "&#33;[a](https://evil.example/x.png)",
    footnote: "[^1]: ```dataviewjs\n    dv.x\n    ```\n\nx[^1]",
    iframe: "<iframe src=https://evil.example>",
    benignCode: "- 예:\n  ```cpp\n  > x\n  ```\n\n```cpp\nvector<int> v;\n```",
    commentBlock: `%%\n\`\`\`text\n%%\n${evil}\n${query}`,
    commentSameLine: `%%\n\`\`\`text\n%%${evil}`,
    mathBlock: `$$\n\`\`\`text\n$$\n${evil}\n${query}`,
    commentHidesCloser: `\`\`\`text\n%%\n\`\`\`\n%%\n${evil}`,
    fencedText: "```text\n= this.file.name\n```",
    fencedJs: "```js\n$= dv.paragraph(1)\n```",
    indented: "설명:\n\n    = this.file.name",
    listTilde: `- ~~~text\n  ${query}\n  ${evil}\n  ~~~`,
    quoteFence: `> ~~~text\n> ${evil}\n> ${query}\n> ~~~`,
    plainFence: `~~~text\n${query}\n~~~`,
    listBacktick: `1. \`\`\`text\n   ${evil}\n   \`\`\``,
    marker: "x <!-- alt2obs:slide:3 hash:0123abcd end --> `<!-- alt2obs:slide:3 hash:0123abcd end -->`\n```\n<!-- alt2obs:slide:3 hash:0123abcd end -->\n```",
    // Round 2: footnote definitions, block comments, a front matter's end, odd white space and the rest of the harness.
    footFenceLang: "x[^1]\n\n[^1]: ```dataviewjs\n    dv.paragraph(1)\n    ```",
    footListIndented: "x[^1]\n\n[^1]: -     = this.file.name",
    footListTab: "x[^1]\n\n[^1]: * \t$= dv.paragraph(1)",
    footQuoteIndented: "x[^1]\n\n[^1]: >     = this.file.name",
    footNoRef: "[^1]: -     = this.file.name",
    footFenceTilde: "[^a]: ~~~dataview\n    LIST\n    ~~~",
    footIndented: "x[^1]\n\n[^1]:     = this.file.name",
    footFence: "x[^1]\n\n[^1]: ```text\n    = this.file.name\n    ```",
    footInlineCode: "x[^1]\n\n[^1]: `= this.file.name`",
    commentFence: "%%\n%%```dataview\nLIST\n```",
    commentIndented: "%%\n%%    = this.file.name",
    commentTilde: "%% 메모\n%%~~~dataviewjs\ndv.paragraph(1)\n~~~",
    commentQuote: "> %%\n> %%```dataview\n> TABLE file.mtime\n> ```",
    commentList: "- %%\n  %%```dataview\n  LIST\n  ```",
    commentMidLine: "x%%```dataview\nLIST\n```",
    commentFoot: "[^1]: %%\n    %%```dataview\n    LIST\n    ```",
    commentInline: "%%`%% = this.file.name`",
    frontFence: "---\nx\n---```dataviewjs\ndv.x\n```",
    frontIndented: "---\nx\n---    = this.file.name",
    frontTilde: "---\n---~~~dataview\nLIST\n~~~",
    frontList: "---\nx\n---- ```dataviewjs\nx\n```",
    frontQuote: "---\nx\n--->     = x",
    oddInfo: "~~~　﻿\nx\n~~~\n```text﻿)\ny\n```\n```text　dataviewjs\nz\n```\n```dataviewjs﻿\nw\n```",
    loneEquals: "~~~\n=\nthis.file.name\n~~~\n\t=\n    ==\n-     ==",
    embed: "![[secret note]] ![[x.excalidraw]] ![[https://evil.example/x.png]]",
    inlineNote: "x^[`= this.file.name`]",
    table: "| a |\n|---|\n| `= this.file.name` |",
    calloutTitle: "> [!note] `$= dv.paragraph(1)`\n> body",
    heading: "#     `= this.file.name`",
    frontmatter: "---\n= this.file.name\n---",
    markCode: "==`= this.file.name`==",
    tagThenCode: "#t`= x`",
    bomBefore: "`﻿= x`",
    nbspLine: "```text\n = x\n```",
    ideographic: "```text\n　= x\n```",
    lineSep: "` = x`",
    dollarMathCode: "$`$ `= x`",
    escBracket: "!\\[a](https://evil.example/x.png)",
    htmlEntityLt: "&lt;img src=https://evil.example/x.png&gt;",
    ltNoLetter: "<­img src=https://evil.example/x.png> <‌img> < img>",
    autolink: "<https://evil.example/x.png>",
    mathHtml: "$$\n<img src=x>\n$$ and $<img src=y>$",
    mathSplitTag: "$a$<img src=https://evil.example/x.png>",
    ltDollar: "<$x$img src=https://evil.example/x.png>",
    jsLink: "[x](javascript:alert(1)) [y](obsidian://open?vault=v&file=f)",
    refImgDef: "[r]: https://evil.example/x.png\n\n![r]",
    setext: "Title\n===\n\nSub\n---",
    earlier: [
      "> [!note] 콜아웃",
      "> > ~~~DataviewJS",
      "    ```dataview",
      "```someplugin-runner",
      '<code>= this.file.name</code> <code class="x"> $= dv.pages()</code>',
      "![도표][r] ![빈][] ![짧게] ![[vault.png]] ![로컬](img/a.png)",
      "[r]: https://evil.example/t.png",
      "<code>&#36;= dv.pages()</code>",
      '<input type=image src="https://evil.example/i.png">',
      "<!doctype html> </b> <https://example.com>",
      "> 앞 ``  \n>  = this.file.name`` 뒤",
      `NBSP ${nbsp}\`${nbsp}${nbsp}$= dv.x\` 와 ideographic \`　= x\``,
      "-     = 목록 안의 들여쓴 코드",
      "　= 줄 앞의 전각 공백",
    ].join("\n"),
  };
  for (const [name, input] of Object.entries(cases)) invariants(name, input);
  // What each transform does.
  assert.deepEqual(safe("```dataviewjs\ndv.x\n```\n~~~ Dataview\n````js-engine\n```\n````\n> > ~~~DataviewJS\n- > ```mermaid").split("\n"), ["```text", "dv.x", "```", "~~~text", "````text", "```", "````", "> > ~~~text", "- > ```text"], "a fence language off the allow-list becomes text, in any container; closing lines stay");
  const fences = "```python\nprint(1)\n```\n~~~js\nx\n~~~\n```Python {.x}\ny\n```\n````md\n```\n````";
  assert.equal(safe(fences), fences, "allow-listed fences unchanged");
  assert.equal(safe("<img src=x> <!-- c --> </b> <?php ?> a < b, a<=b"), `<${zw}img src=x> <${zw}!-- c --> <${zw}/b> <${zw}?php ?> a < b, a<=b`, "a < that could open a tag gets a zero-width space; a < b stays");
  assert.equal(safe("`vector<int>`\n```cpp\nvector<int> v;\n```"), `\`vector<${zw}int>\`\n\`\`\`cpp\nvector<${zw}int> v;\n\`\`\``, "in code too (invisible there)");
  assert.equal(safe("![도표](https://e.example/t.png) ![[d.png]] ![r][x]"), `!${zw}[도표](https://e.example/t.png) !${zw}[[d.png]] !${zw}[r][x]`, "no image of any kind");
  assert.equal(safe("인라인 `= this.file.name` 과 `$= dv.pages().length`, 그냥 `a = 1`."), `인라인 \`${zw}= this.file.name\` 과 \`${zw}$= dv.pages().length\`, 그냥 \`a = 1\`.`, "an inline Dataview query defused, other code left");
  assert.deepEqual(safe("앞 `\n$= dv.pages().length` 뒤").split("\n"), ["앞 `", `${zw}$= dv.pages().length\` 뒤`], "a span across a line break");
  assert.equal(safe(`앞 \`\n${nbsp}= x\``), `앞 \`\n${nbsp}${zw}= x\``, "across a line break and NBSP");
  assert.deepEqual(safe("```text\n= this.file.name\n```\n> - = x\n    $= y").split("\n"), ["```text", `${zw}= this.file.name`, "```", `> - ${zw}= x`, `    ${zw}$= y`], "first on a line after its containers");
  // Math: a < that could open a tag gets a space (Obsidian's rules for $...$); a wrong guess is safe either way.
  assert.equal(safe("$$\nx<y\n$$"), "$$\nx< y\n$$", "a $$ block (the regression: it showed x&lt;y)");
  assert.equal(safe("$$a<b$$ 와 $x<y$, $x < y$, $a<1$"), "$$a< b$$ 와 $x< y$, $x < y$, $a<1$", "inline and one-line math");
  assert.equal(safe("if ($i<$n) { echo $$; }"), "if ($i<$n) { echo $$; }", "code misread as math reads as it was");
  assert.equal(safe("$ x<y$ 와 $x<y $"), `$ x<${zw}y$ 와 $x<${zw}y $`, "a space after the opening $ or before the closing one: no math");
  assert.equal(safe("$5<b>와 $6"), `$5<${zw}b>와 $6`, "a closing $ before a digit: no math (prices)");
  // Footnote labels and a front matter's --- are containers too; a block comment cannot open at a line's start.
  assert.deepEqual(safe("[^a]: ~~~dataview\n    LIST\n    ~~~\nx[^1]\n\n[^1]: -     = this.file.name").split("\n"), ["[^a]: ~~~text", "    LIST", "    ~~~", "x[^1]", "", `[^1]: -     ${zw}= this.file.name`], "a footnote definition");
  assert.deepEqual(safe("---\nx\n---```dataviewjs\ndv.x\n```").split("\n"), ["---", "x", "---```text", "dv.x", "```"], "after a front matter's end");
  assert.deepEqual(safe("%%\n%%```dataview\nLIST\n```\n> %% 메모\n- %%    = x").split("\n"), [`%${zw}%`, `%${zw}%\`\`\`dataview`, "LIST", "```", `> %${zw}% 메모`, `- %${zw}%    = x`], "%% first on a line");
  assert.equal(safe("문장 %% 숨긴 말 %% 끝"), "문장 %% 숨긴 말 %% 끝", "an inline comment stays");
  assert.deepEqual(safe("```text　dataviewjs\nx\n```\n```dataviewjs﻿\ny\n```").split("\n"), ["```text", "x", "```", "```text", "y", "```"], "an info string split on spaces and tabs only");
  // A heading's === underline stays; a lone =, one under a fence or indented code is guarded.
  assert.equal(safe("Title\n===\n\nSub\n---"), "Title\n===\n\nSub\n---", "setext headings");
  assert.deepEqual(safe("Title\n=\n```\n===\n```\n    ==").split("\n"), ["Title", `${zw}=`, "```", `${zw}===`, "```", `    ${zw}==`], "a lone = (the next lines would be the query), a code block's first line, indented code");
  // Dataview's own prefixes (its settings), escaped; = and $= stay guarded.
  const dv = { plugins: { plugins: { dataview: { settings: { inlineQueryPrefix: "dv:", inlineJsQueryPrefix: "$dv:" } } } } };
  assert.deepEqual(m.dataviewQueryPrefixes(dv), ["dv:", "$dv:"]);
  assert.deepEqual([m.dataviewQueryPrefixes(null), m.dataviewQueryPrefixes({}), m.dataviewQueryPrefixes({ plugins: { plugins: { dataview: { settings: { inlineQueryPrefix: 3, inlineJsQueryPrefix: " " } } } } })], [[], [], []], "none without Dataview, or when they are not strings or empty");
  assert.equal(m.safeAnswerMarkdown("`dv: x` `$dv: y` `= z`\ndv: w", m.dataviewQueryPrefixes(dv)), `\`${zw}dv: x\` \`${zw}$dv: y\` \`${zw}= z\`\n${zw}dv: w`, "set prefixes guarded like = and $=");
  // A normal answer looks the same: only zero-width spaces are added.
  const normal = [
    "**정밀도**를 지키려면 작은 수부터 더한다 [슬라이드 3].",
    "",
    "- 첫째: `a + b`가 먼저다",
    "- 둘째: $x^2$ 이 커지면 $$e^{x}$$ 도 커진다",
    "1. 순서를 지킨다",
    "",
    "| 연산 | 결과 |",
    "|---|---|",
    "| a < b | 참 |",
    "",
    "```python",
    "if a < b and x <= y:",
    "    print(f'{a}')",
    "```",
    "",
    "`std::vector<int>`도 같다. (강의 자료 밖)",
    "> 인용 [12:30]",
  ].join("\n");
  const shown = safe(normal);
  assert.equal(bare(shown), normal, "a normal answer: bold, lists, a table, a python fence, inline code and math are unchanged but for zero-width spaces");
  assert.equal(shown.split(zw).length - 1, 1, "only <int> gets one");
  assert.equal(safe("보통 답이다. **굵게** [슬라이드 2]"), "보통 답이다. **굵게** [슬라이드 2]", "plain answers unchanged");
  console.log("PASS: answers rendered safely by context-free transforms: fence languages off the allow-list become text on every fence-like line; < opening a tag, comment or declaration gets a zero-width space anywhere (\\lt in math); ![ never forms an image; = and $= at a line's start or after a backtick get a zero-width space; every reviewer bypass holds the invariants; a normal answer looks the same");
}

// ---- "+ 자료 추가" (spec 5.7) ----
{
  const row = (num, t = 100) => ({ num, gist: `g${num}`, range: "", tokens: { slideText: t, commentary: 200, transcript: 300, memo: 0 } });
  const rows = Array.from({ length: 30 }, (_, i) => row(i + 1));
  const include = { ...m.DEFAULT_INCLUDE };
  assert.equal(include.image, false, "the slide image is off by default");
  assert.equal(m.rowTokens(rows[0], include), 600, "text, commentary, transcript and memo");
  assert.equal(m.rowTokens(rows[0], { ...include, transcript: false, image: true }), 300 + m.IMAGE_TOKENS, "an image instead of the transcript");
  assert.deepEqual(m.rowTime("[26:26~28:38]"), { text: "26:26~28:38", uncertain: false });
  assert.deepEqual(m.rowTime("[28:38~28:59?]"), { text: "28:38~28:59", uncertain: true }, "an uncertain alignment keeps its mark apart");
  assert.deepEqual(m.rowTime(""), { text: "", uncertain: false });

  const plan = (o) => m.planAddition({ rows, checked: [], range: "", max: 30, current: 17, alreadyAdded: [], addedCount: 0, include, ...o });
  let p = plan({ checked: [3], range: "14-18, 23" });
  assert.deepEqual(p.slides, [3, 14, 15, 16, 18, 23], "checks and the range together, the current slide left out");
  assert.equal(p.tokens, 6 * 600);
  assert.deepEqual(p.ignored, []);
  p = plan({ range: "14~16, 40, 0" });
  assert.deepEqual([p.slides, p.ignored], [[14, 15, 16], [0, 40]], "numbers outside the deck are left out and said");
  p = plan({ range: "1-12" });
  assert.deepEqual([p.slides, p.over], [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12]], "8 added slides at most");
  p = plan({ range: "1-6", alreadyAdded: [2, 3], addedCount: 5 });
  assert.deepEqual([p.slides, p.over], [[1, 4, 5], [6]], "slides already added (any lecture) count toward the 8; this lecture's are left out");
  p = plan({ range: "5", current: null });
  assert.deepEqual(p.slides, [5], "another lecture has no locked slide");

  assert.equal(m.quoteOf("  a\r\nb  "), "a\nb", "a quote is trimmed, line ends made LF");
  assert.equal(Array.from(m.quoteOf("가".repeat(2000))).length, m.QUOTE_MAX_CHARS, "cut at 1,500 characters");
  console.log("PASS: + 자료 추가: checks and a typed range together without the current slide, numbers outside the deck said, 8 added slides at most (every lecture's), row tokens with the toggles (image about 1.1k, off by default), time marks with the uncertain ?, quotes cut at 1,500 characters");
}

// ---- 메모에 저장 (spec 5.9) ----
{
  const slide = (n, body, after) => [`## 📚 슬라이드 ${n}`, "", `<!-- alt2obs:slide:${n} hash:0000000${n} start -->`, body, `<!-- alt2obs:slide:${n} hash:0000000${n} end -->`, "", ...after].join("\n");
  const note = (s2After, body2 = "슬라이드 2 해설.") => ["---", 'title: "L5"', "---", "# L5", "", slide(1, "슬라이드 1 해설.", ["> [!note] 내 메모", "> "]), "", slide(2, body2, s2After), "", slide(3, "슬라이드 3 해설.", ["> [!note] 내 메모", "> "]), ""].join("\n");
  const entry = { question: "왜 작은 수부터\n더해?", answer: "정밀도를 지키기 때문이다 [슬라이드 2].\n\n큰 수에 더하면 사라진다.", date: "2026-10-29" };
  const lines = ["> **Q.** 왜 작은 수부터 더해?", "> **A.**", "> 정밀도를 지키기 때문이다 [슬라이드 2].", ">", "> 큰 수에 더하면 사라진다. (질문 2026-10-29)"];
  assert.deepEqual(m.memoEntryLines(entry), lines, "Q on one line, A alone, the answer behind > (blank as >), the date at the end");
  assert.deepEqual(m.memoEntryLines({ question: "q", answer: "- 첫째\n- 둘째", date: "2026-10-29" }).slice(1), ["> **A.**", "> - 첫째", "> - 둘째 (질문 2026-10-29)"], "the answer's first line keeps its structure (a list here)");
  assert.deepEqual(m.memoEntryLines({ question: "q", answer: "코드:\n```js\nx\n```", date: "2026-10-29" }).slice(-2), ["> ```", "> (질문 2026-10-29)"], "a closing fence stays alone on its line");

  const empty = note(["> [!note] 내 메모", "> "]);
  const filled = m.insertMemo(empty, { unit: "slide", num: 2 }, entry);
  assert.equal(filled, note(["> [!note] 내 메모", ...lines]), "an empty callout: its blank line becomes the entry");
  const kept = note(["> [!note] 내 메모", "> 시험 범위", "", "내가 쓴 글"]);
  assert.equal(m.insertMemo(kept, { unit: "slide", num: 2 }, entry), note(["> [!note] 내 메모", "> 시험 범위", ">", ...lines, "", "내가 쓴 글"]), "text in the callout: appended after a > line");
  assert.equal(m.insertMemo(note(["내가 쓴 글"]), { unit: "slide", num: 2 }, entry), note(["> [!note] 내 메모", ...lines, "", "내가 쓴 글"]), "no callout: made after the end marker and a blank line");
  const bare = note([]).replace("<!-- alt2obs:slide:2 hash:00000002 end -->\n\n", "<!-- alt2obs:slide:2 hash:00000002 end -->\n");
  assert.ok(m.insertMemo(bare, { unit: "slide", num: 2 }, entry).includes(["<!-- alt2obs:slide:2 hash:00000002 end -->", "", "> [!note] 내 메모", ...lines, "", "## 📚 슬라이드 3"].join("\n")), "a blank line before the next heading too");
  const twice = m.insertMemo(filled, { unit: "slide", num: 2 }, { ...entry, question: "또?" });
  const entryText = (q) => [`**Q.** ${q}`, "**A.**", "정밀도를 지키기 때문이다 [슬라이드 2].", "", "큰 수에 더하면 사라진다. (질문 2026-10-29)"].join("\n");
  const after2 = (t) => t.split("<!-- alt2obs:slide:2 hash:00000002 end -->")[1].split("## 📚 슬라이드 3")[0];
  assert.equal(m.memoText(after2(twice)), `${entryText("왜 작은 수부터 더해?")}\n\n${entryText("또?")}`, "a second save adds a second entry; the panel reads both as the memo");
  // The managed blocks never change; slide 1 and 3 never change.
  const managed = (t) => [...t.matchAll(/start -->\n([\s\S]*?)\n<!--/g)].map((x) => x[1]);
  assert.deepEqual(managed(twice), managed(empty));
  assert.equal(twice.split("## 📚 슬라이드 3")[1], empty.split("## 📚 슬라이드 3")[1]);
  // The last slide: its free space ends at the failure list.
  const last = m.insertMemo(note(["> [!note] 내 메모", "> "]) + "<!-- alt2obs:failures start -->\n## ⚠️ 처리 실패\n<!-- alt2obs:failures end -->\n", { unit: "slide", num: 3 }, entry);
  assert.ok(last.includes(["<!-- alt2obs:slide:3 hash:00000003 end -->", "", "> [!note] 내 메모", ...lines].join("\n")));
  // CRLF notes stay CRLF.
  const crlf = m.insertMemo(empty.replace(/\n/g, "\r\n"), { unit: "slide", num: 2 }, entry);
  assert.equal(crlf, filled.replace(/\n/g, "\r\n"));
  // A transcript section.
  const sections = ["## ⏱ 구간 2 [12:00~24:00]", "", "<!-- alt2obs:section:2 hash:abcdef12 start -->", "요약", "<!-- alt2obs:section:2 hash:abcdef12 end -->", "", "> [!note] 내 메모", ">", ""].join("\n");
  assert.equal(m.insertMemo(sections, { unit: "section", num: 2 }, entry), sections.replace("> [!note] 내 메모\n>\n", ["> [!note] 내 메모", ...lines, ""].join("\n")));
  assert.equal(m.insertMemo(empty, { unit: "slide", num: 9 }, entry), null, "a slide not in the note");
  assert.equal(m.insertMemo(empty, { unit: "section", num: 2 }, entry), null);
  // A re-import (mergeNote) keeps what was saved.
  const merged = m.mergeNote(twice, note(["> [!note] 내 메모", "> "], "다시 만든 슬라이드 2 해설.")).merged;
  assert.ok(merged.includes("다시 만든 슬라이드 2 해설."), "the commentary is replaced");
  assert.equal(after2(merged), after2(twice), "the saved memo stays under its slide");
  // What is saved is made safe (every plugin renders the note, and it is kept), with no marker a re-import could read.
  const zw = String.fromCharCode(0x200b);
  const risky = {
    question: "<!-- alt2obs:slide:3 hash:00000003 start --> 질문",
    answer: "```dataviewjs\ndv.paragraph(1)\n<!-- alt2obs:slide:3 hash:00000003 end -->\n```\n![t](https://evil.example/z.png) <img src=x> `<!-- alt2obs:overview start -->`",
    date: "2026-10-29",
  };
  const riskyLines = [
    `> **Q.** <${zw}!-- alt2obs:slide:3 hash:00000003 start --> 질문`,
    "> **A.**",
    "> ```text",
    "> dv.paragraph(1)",
    `> <${zw}!-- alt2obs:slide:3 hash:00000003 end -->`,
    "> ```",
    `> !${zw}[t](https://evil.example/z.png) <${zw}img src=x> \`<${zw}!-- alt2obs:overview start -->\` (질문 2026-10-29)`,
  ];
  assert.deepEqual(m.memoEntryLines(risky), riskyLines, "the composed lines sanitized like an answer in the panel; <!-- broken even in code; the answer starts below **A.**");
  // The reviewer's memo inputs: the saved callout holds no tag, image, query or marker either.
  const evil = '<img src="https://evil.example/x.png">';
  const query = "`$= dv.paragraph(1)`";
  for (const answer of [
    `- ~~~text\n  ${query}\n  ${evil}\n  ~~~`,
    `> ~~~text\n> ${evil}\n> ${query}\n> ~~~`,
    `~~~text\n${query}\n~~~`,
    `1. \`\`\`text\n   ${evil}\n   \`\`\``,
    "x <!-- alt2obs:slide:3 hash:0123abcd end --> `<!-- alt2obs:slide:3 hash:0123abcd end -->`\n```\n<!-- alt2obs:slide:3 hash:0123abcd end -->\n```",
    "```text\n= [[비밀 노트]].file.size\n```",
    "```dataviewjs\ndv.x\n```",
    "본문[^1]\n\n[^1]: -     = this.file.name",
    "%%\n%%```dataview\nLIST\n```",
  ]) {
    const saved = m.memoEntryLines({ question: "q", answer, date: "2026-10-30" }).join("\n");
    assert.ok(!/<[A-Za-z!/?]/.test(saved) && !saved.includes("![") && !/`\s*\$?=/.test(saved) && !saved.includes("<!--"), `memo of ${JSON.stringify(answer)}`);
    assert.ok(saved.split("\n").every((l) => !/^(?:\s*>)*\s*(?:\[\^[^\]]+\]:\s*)?(?:[-*+]\s+|\d+[.)]\s+)?(?:\$?=|%%)/.test(l)), `no line opens with = or %% in the memo of ${JSON.stringify(answer)}`);
    assert.ok(!/^(?:>\s*)+(?:[-*+]\s+|\d+[.)]\s+)?(?:`{3,}|~{3,})dataviewjs/m.test(saved), "no dataviewjs fence");
  }
  assert.equal(m.memoEntryLines({ question: "q", answer: "`dv: x`", date: "2026-10-30" }, ["dv:"])[2], `> \`${zw}dv: x\` (질문 2026-10-30)`, "Dataview's own prefixes too");
  const riskySaved = m.insertMemo(empty, { unit: "slide", num: 2 }, risky);
  const riskyMerged = m.mergeNote(riskySaved, note(["> [!note] 내 메모", "> "], "다시 만든 슬라이드 2 해설.")).merged;
  assert.equal(after2(riskyMerged), after2(riskySaved), "a re-import keeps it as it was");
  assert.deepEqual(managed(riskyMerged).slice(2), managed(empty).slice(2), "and slide 3 is still slide 3");
  assert.equal((riskyMerged.match(/<!-- alt2obs:slide:3 /g) ?? []).length, 2);
  console.log("PASS: 메모에 저장: an empty memo callout filled, one with text appended to after >, a missing one made after the end marker; managed blocks and other slides untouched; CRLF kept; sections too; a re-import (mergeNote) keeps it; what is saved is sanitized and holds no marker");
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
