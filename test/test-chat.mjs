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
  console.log("PASS: grounding marks: slide, list, range, section, mm:ss and h:mm:ss, outside badge; out-of-range marks stay text");
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

// ---- model output made safe before rendering (review L6) ----
{
  const answer = [
    "답이다 [슬라이드 3].",
    "```dataviewjs",
    "dv.paragraph(app.vault.getFiles().length)",
    "```",
    "~~~ Dataview",
    "LIST FROM #x",
    "~~~",
    "```python",
    "print('![x](http://ok.example/a.png)')",
    "```",
    "인라인 `= this.file.name` 과 `$= dv.pages().length`, 그냥 `a = 1`.",
    "그림 ![도표](https://evil.example/t.png \"t\") 와 ![](http://e.example/x.gif), 볼트 그림 ![[d.png]].",
    '<img src="https://evil.example/p.png"> <iframe src="https://e.example"></iframe>',
    "````js-engine",
    "```",
    "return 1",
    "````",
  ].join("\n");
  const safe = m.safeAnswerMarkdown(answer).split("\n");
  assert.equal(safe[1], "```text", "dataviewjs becomes a plain text fence");
  assert.equal(safe[2], "dv.paragraph(app.vault.getFiles().length)", "its lines stay");
  assert.equal(safe[4], "~~~text", "a tilde fence, any case");
  assert.equal(safe[7], "```python", "other languages stay");
  assert.equal(safe[8], "print('![x](http://ok.example/a.png)')", "nothing changes inside code");
  const zw = String.fromCharCode(0x200b);
  assert.equal(safe[10], `인라인 \`${zw}= this.file.name\` 과 \`${zw}$= dv.pages().length\`, 그냥 \`a = 1\`.`, "inline Dataview queries defused, other code left");
  assert.equal(safe[11], "그림 [도표](https://evil.example/t.png) 와 [http://e.example/x.gif](http://e.example/x.gif), 볼트 그림 ![[d.png]].", "remote images become links; vault embeds stay");
  assert.equal(safe[12], '&lt;img src="https://evil.example/p.png"> &lt;iframe src="https://e.example">&lt;/iframe>', "raw media HTML shown as text");
  assert.deepEqual(safe.slice(13), ["````text", "```", "return 1", "````"], "a longer fence keeps its inner backticks");
  assert.equal(m.safeAnswerMarkdown("보통 답이다. **굵게** [슬라이드 2]"), "보통 답이다. **굵게** [슬라이드 2]", "plain answers unchanged");
  // The reviewer's bypasses: fences inside quotes, callouts, lists and indents; any unknown language; raw <code>; reference images; CSS url().
  const bypass = [
    "> ```dataviewjs",
    "> dv.paragraph(1)",
    "> ```",
    "> [!note] 콜아웃",
    "> > ~~~DataviewJS",
    "> > x",
    "> > ~~~",
    "- ```dataviewjs",
    "  dv.paragraph(2)",
    "  ```",
    "    ```dataview",
    "    LIST",
    "    ```",
    "```someplugin-runner",
    "run()",
    "```",
    "```Python {.x}",
    "print(1)",
    "```",
    '<code>= this.file.name</code> <code class="x"> $= dv.pages()</code> <code>a = 1</code>',
    "![도표][r] ![빈][] ![짧게] ![[vault.png]] ![로컬](img/a.png)",
    "[r]: https://evil.example/t.png",
    '<span style="background:url(https://evil.example/b.png)">x</span> <div style=\'background: URL( "https://e.example" )\'>y</div>',
  ].join("\n");
  const out = m.safeAnswerMarkdown(bypass).split("\n");
  assert.deepEqual(out.slice(0, 3), ["> ```text", "> dv.paragraph(1)", "> ```"], "a fence in a quote");
  assert.equal(out[4], "> > ~~~text", "a fence in a nested quote or callout");
  assert.deepEqual(out.slice(7, 10), ["- ```text", "  dv.paragraph(2)", "  ```"], "a fence in a list item");
  assert.equal(out[10], "    ```text", "an indented fence");
  assert.equal(out[13], "```text", "any language not on the allow-list");
  assert.equal(out[16], "```Python {.x}", "allowed languages in any case, with attributes");
  assert.equal(out[19], '&lt;code>= this.file.name&lt;/code> &lt;code class="x"> $= dv.pages()&lt;/code> &lt;code>a = 1&lt;/code>', "raw <code> is text");
  assert.equal(out[20], "[도표][r] [빈][] [짧게] ![[vault.png]] ![로컬](img/a.png)", "reference and shortcut images become links; vault embeds and local images stay");
  assert.equal(out[22], '&lt;span style="background:url(https://evil.example/b.png)">x&lt;/span> &lt;div style=\'background: URL( "https://e.example" )\'>y&lt;/div>', "tags with a style attribute are text");
  // A fence opened in a quote ends with the quote: what follows is made safe again.
  const leaked = m.safeAnswerMarkdown("> ```python\n> x\n\n![t](https://evil.example/z.png)").split("\n");
  assert.equal(leaked[3], "[t](https://evil.example/z.png)", "a quote's unclosed fence does not shield later lines");
  const listLeak = m.safeAnswerMarkdown("- ```python\n  x\nnext ![t](https://evil.example/z.png)").split("\n");
  assert.equal(listLeak[2], "next [t](https://evil.example/z.png)", "nor does a list item's");
  // An indented line is an indented code block (or paragraph text), not a fence opener: the next line opens a real fence.
  assert.deepEqual(m.safeAnswerMarkdown("    ```\n```dataviewjs\ndv.paragraph(1)\n```").split("\n"), ["    ```", "```text", "dv.paragraph(1)", "```"], "a fence after an indented ``` line");
  assert.equal(m.safeAnswerMarkdown("    ```\n![t](https://evil.example/z.png)").split("\n")[1], "[t](https://evil.example/z.png)", "an indented ``` line shields nothing");
  assert.deepEqual(m.safeAnswerMarkdown("- a\n\n        ```\n<img src=x>").split("\n").slice(2), ["        ```", "&lt;img src=x>"], "nor does one indented past its list item's 3 columns");
  // Every fence-like line, inside a fence or not, after any containers.
  assert.equal(m.safeAnswerMarkdown("- > ```dataviewjs\n  > x\n  > ```"), "- > ```text\n  > x\n  > ```", "a quote in a list item");
  assert.deepEqual(m.safeAnswerMarkdown("````md\n```dataviewjs\nx\n```\n````").split("\n"), ["````md", "```text", "x", "```", "````"], "a fence-like line inside a fence; closing lines stay");
  assert.equal(m.safeAnswerMarkdown("```mermaid\ngraph TD; A-->B\n```").split("\n")[0], "```text", "mermaid is not on the allow-list (labels can hold HTML)");
  // Inline code that starts at the end of a line.
  assert.deepEqual(m.safeAnswerMarkdown("앞 `\n$= dv.pages().length` 뒤").split("\n"), ["앞 `", `${zw}$= dv.pages().length\` 뒤`], "a span across a line break");
  assert.deepEqual(m.safeAnswerMarkdown("> 앞 ``  \n>  = this.file.name`` 뒤").split("\n"), ["> 앞 ``  ", `>  ${zw}= this.file.name\`\` 뒤`], "also in a quote");
  // Raw HTML: text, but for plain formatting without attributes.
  const kept = "<b>굵게</b> H<sub>2</sub>O x<sup>2</sup> <br> <br/> <br /> <kbd>Ctrl</kbd> <mark>m</mark> <em>e</em> <strong>s</strong> <i>i</i> <u>u</u> <s>s</s> <https://example.com> a < b";
  assert.equal(m.safeAnswerMarkdown(kept), kept, "plain formatting tags, autolinks and a lone < stay");
  const html = [
    "<code><span>$= dv.pages()</span></code>",
    "<code>&#36;= dv.pages()</code>",
    '<table><tr><td background="https://evil.example/b.png">x</td></tr></table>',
    '<input type=image src="https://evil.example/i.png">',
    '<b class="x">b</b> <BR style="x">',
    "<!-- alt2obs:slide:1 hash:00000000 end --> <!doctype html> <?php ?>",
    "<img",
    'src="https://evil.example/p.png">',
    "vector<int> `vector<int>`",
  ].join("\n");
  assert.deepEqual(m.safeAnswerMarkdown(html).split("\n"), [
    "&lt;code>&lt;span>$= dv.pages()&lt;/span>&lt;/code>",
    "&lt;code>&#36;= dv.pages()&lt;/code>",
    '&lt;table>&lt;tr>&lt;td background="https://evil.example/b.png">x&lt;/td>&lt;/tr>&lt;/table>',
    '&lt;input type=image src="https://evil.example/i.png">',
    '&lt;b class="x">b</b> &lt;BR style="x">',
    "&lt;!-- alt2obs:slide:1 hash:00000000 end --> &lt;!doctype html> &lt;?php ?>",
    "&lt;img",
    'src="https://evil.example/p.png">',
    "vector&lt;int> `vector<int>`",
  ], "every other tag, comment and declaration is text (a tag split over lines too); code is untouched");
  console.log("PASS: answers rendered safely: every fence-like line (in quotes, callouts, lists, indents, inside fences) keeps only an allow-listed language, an indented ``` line opens no fence, inline Dataview queries are defused (also across a line break), raw HTML is text but for plain formatting tags, remote and reference images become links, code untouched");
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
  const lines = ["> **Q.** 왜 작은 수부터 더해?", "> **A.** 정밀도를 지키기 때문이다 [슬라이드 2].", ">", "> 큰 수에 더하면 사라진다. (질문 2026-10-29)"];
  assert.deepEqual(m.memoEntryLines(entry), lines, "Q on one line, A's first line, the rest behind > (blank as >), the date at the end");
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
  const entryText = (q) => [`**Q.** ${q}`, "**A.** 정밀도를 지키기 때문이다 [슬라이드 2].", "", "큰 수에 더하면 사라진다. (질문 2026-10-29)"].join("\n");
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
    "> **Q.** &lt;!-- alt2obs:slide:3 hash:00000003 start --> 질문",
    "> **A.**",
    "> ```text",
    "> dv.paragraph(1)",
    `> <${zw}!-- alt2obs:slide:3 hash:00000003 end -->`,
    "> ```",
    `> [t](https://evil.example/z.png) &lt;img src=x> \`<${zw}!-- alt2obs:overview start -->\` (질문 2026-10-29)`,
  ];
  assert.deepEqual(m.memoEntryLines(risky), riskyLines, "sanitized like an answer in the panel; <!-- broken even in code; a fence opening the answer starts below **A.**");
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
