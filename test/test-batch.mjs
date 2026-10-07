/**
 * Test: batched commentary and the full CLI lecture pipeline against the
 * fake claude/codex (no tokens): batch sizes, cache-friendly prompt order,
 * retry of only the failed slides, usage-limit stop, timeout, cancel, the
 * note it assembles, and a re-import that reuses every unchanged slide.
 * Run: node test/test-batch.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, FAKE_CODEX, fakeSession, isAlive } from "./helpers/fake-cli.mjs";

const m = await importTs("test/helpers/pipeline-entry.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function blank(w = 160, h = 120) {
  return { width: w, height: h, data: new Uint8Array(w * h).fill(255) };
}
function withBlock(page) {
  const img = blank();
  for (let y = 30; y < 110; y++) for (let x = 10 + page; x < 150; x++) img.data[y * img.width + x] = 60;
  return img;
}

/** 14 pages: cover, 12 content (pages 5-6 visual), thanks. */
async function makeDeck() {
  const layouts = [{ text: "Lecture 7 Caches", boxes: [] }];
  for (let i = 2; i <= 13; i++) {
    layouts.push({ text: i === 5 || i === 6 ? "" : `Slide ${i}: cache topic number ${i} with details ${"abc".repeat(i)} ${i * 7919}`, boxes: [] });
  }
  layouts.push({ text: "Thank you", boxes: [] });
  const grays = layouts.map((_, i) => (i === 4 || i === 5 ? withBlock(i) : blank()));
  const analysis = await m.analyzeSlides(layouts, grays, { sourceId: "note-1" });
  return { layouts, ...analysis };
}

const context = { title: "Lecture 7 Caches", subjectTags: ["cache", "memory"], knownConcepts: ["캐시"] };
const renderImage = async (page) => ({ pageNum: page, mimeType: "image/png", base64: PNG_1PX });

function provider(Provider, bin, job, usage, extra = {}) {
  return new Provider({ bin, model: "", effort: "medium", timeoutMs: 20000, workDir: job, usage, task: "commentary", ownsWorkDir: false, ...extra });
}

const d = await makeDeck();
const plan = m.planDeck({ ...d, transcript: "음 오늘은 캐시를 배웁니다. ".repeat(300), transcriptCapChars: 200, batchSize: 8, deckTitle: "L7" });
assert.deepEqual(plan.batches.map((b) => b.pages), [[2, 3, 4, 5], [6, 7, 8, 9], [10, 11, 12, 13]], "K/2 while a batch has an image");

// ---- happy path, both CLIs: prompt order, cache prefix, usage ----
for (const [label, Provider, bin] of [
  ["Claude", m.ClaudeCliProvider, FAKE_CLAUDE],
  ["Codex", m.CodexCliProvider, FAKE_CODEX],
]) {
  const s = fakeSession("ok");
  const job = m.createJobDir();
  const usage = new m.UsageTracker();
  try {
    const res = await new m.BatchCommentaryGenerator(provider(Provider, bin, job, usage)).generate({ plan, context, renderImage });
    assert.equal(res.errors.length, 0);
    assert.equal(res.slides.length, 14);
    assert.equal(res.slides[0].commentary, "표지: **Lecture 7 Caches**");
    assert.equal(res.slides[13].commentary, "강의를 마친다.");
assert.ok(res.slides[1].meta && m.parseSlideMeta(res.slides[1].meta).gist === "슬라이드 2의 요지");
    const calls = s.calls();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.images.length), [1, 1, 0], "images only for visual slides");
    // Byte-identical prefix (instructions + lecture context) across batches.
    const cut = (c) => c.stdin.slice(0, c.stdin.indexOf("[이번 묶음:"));
    assert.ok(cut(calls[0]).length > 100);
    assert.equal(cut(calls[1]), cut(calls[0]));
    assert.equal(cut(calls[2]), cut(calls[0]));
    assert.ok(cut(calls[0]).includes("과목 태그 (vault에 이미 있는 태그): cache, memory"));
    const order = ["[강의 공통 맥락]", "슬라이드 목록:", "[이번 묶음: 슬라이드 2, 3, 4, 5]", "### 슬라이드 2 (content)", "[전사 발췌]"];
    let pos = -1;
    for (const marker of order) {
      const at = calls[0].stdin.indexOf(marker);
      assert.ok(at > pos, `${marker} after the previous block`);
      pos = at;
    }
    assert.ok(!calls[0].stdin.includes("### 슬라이드 1 ("), "cover is not sent");
    const total = usage.total();
    assert.equal(total.calls, 3);
    assert.equal(total.imagesSent, 2);
    assert.ok(total.cachedInputTokens > 0);
    console.log(`PASS: ${label} batches of K and K/2, identical prompt prefix, images only for visual slides, templates without calls`);
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- retry only the failed slides ----
{
  const s = fakeSession("drop:3,short:7,dropalways:11");
  const job = m.createJobDir();
  try {
    const warn = console.warn;
    const res = await new m.BatchCommentaryGenerator(provider(m.ClaudeCliProvider, FAKE_CLAUDE, job, new m.UsageTracker())).generate({ plan, context, renderImage });
    console.warn = warn;
    const calls = s.calls();
    const pagesOf = (c) => [...c.stdin.matchAll(/^### 슬라이드 (\d+)/gm)].map((x) => Number(x[1]));
    assert.deepEqual(calls.map(pagesOf), [[2, 3, 4, 5], [3], [6, 7, 8, 9], [7], [10, 11, 12, 13], [11]]);
    assert.deepEqual(res.errors.map((e) => [e.slideNum, e.reason]), [[11, "응답에 이 슬라이드가 없음"]]);
    assert.equal(res.slides.length, 13, "failed slide has no section; it is listed in errors");
    console.log("PASS: missing and too-short slides retried alone, once; a slide failing twice is reported");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- answer checks: the floor follows how much the slide holds, the upper bounds have slack ----
{
  const slide = (page, kind, textChars, transcript) => ({ page, kind, textChars, transcript });
  const thin = slide(1, "content", 79, "");
  const content = slide(2, "content", 80, "");
  const spoken = slide(3, "content", 20, "교수님이 예를 든다");
  const visual = slide(4, "visual", 300, "");
  const check = (s, commentary) => m.checkBatchAnswer({ slides: [{ slide: s.page, commentary, gist: "요지다" }] }, [s]);
  const ok = (s, len) => check(s, "가".repeat(len)).ok.has(s.page);
  assert.deepEqual([ok(thin, 4), ok(thin, 5)], [false, true], "little to say: 5 characters");
  assert.ok(check(thin, "6강을 마친다.").ok.has(1), "a closing sentence passes");
  assert.deepEqual([ok(content, 39), ok(content, 40)], [false, true], "80 characters of text: 40");
  assert.deepEqual([ok(spoken, 39), ok(spoken, 40)], [false, true], "short text with a transcript: 40");
  assert.equal(check(content, "내용 없음.").failed.get(2), "해설이 너무 짧음 (6자)", "a junk answer is asked for again");
  assert.equal(check(spoken, "Parsing").failed.get(3), "해설이 너무 짧음 (7자)");
  assert.equal(m.minCommentaryChars(slide(5, "visual", 0, "  ")), 5, "a blank transcript is none");
  assert.deepEqual([ok(content, 1440), ok(content, 1441)], [true, false], "content: 900 x 1.6");
  assert.deepEqual([ok(visual, 1600), ok(visual, 1601)], [true, false], "visual: 1000 x 1.6");
  assert.equal(check(visual, "가".repeat(1601)).failed.get(4), "해설이 너무 김 (1601자)");
  console.log("PASS: answer checks: 5 characters for a slide with little to say, 40 otherwise; at most 1.6 times the upper bound");
}

// ---- usage limit stops the remaining batches ----
{
  const s = fakeSession("limit");
  const job = m.createJobDir();
  try {
    const res = await new m.BatchCommentaryGenerator(provider(m.CodexCliProvider, FAKE_CODEX, job, new m.UsageTracker())).generate({ plan, context, renderImage });
    assert.equal(s.calls().length, 1, "no retry and no further batches after a usage limit");
    assert.equal(res.errors.length, 12);
    assert.ok(res.errors.every((e) => /usage limit|사용 한도/.test(e.reason)));
    console.log("PASS: usage limit stops the run after one call, every remaining slide reported");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- timeout: the batch is retried once in halves; it counts toward the stop (review N1) ----
{
  const pagesOf = (c) => [...c.stdin.matchAll(/^### 슬라이드 (\d+)/gm)].map((x) => Number(x[1]));
  // Only 4-slide batches hang: the halves succeed.
  const s1 = fakeSession("hangbig:2");
  const job1 = m.createJobDir();
  try {
    const one = { ...plan, batches: plan.batches.slice(0, 1) };
    const res = await new m.BatchCommentaryGenerator(provider(m.ClaudeCliProvider, FAKE_CLAUDE, job1, new m.UsageTracker(), { timeoutMs: 800 })).generate({ plan: one, context, renderImage });
    assert.deepEqual(s1.calls().map(pagesOf), [[2, 3, 4, 5], [2, 3], [4, 5]]);
    assert.equal(res.generatedCount, 4);
    assert.equal(res.errors.filter((e) => e.slideNum <= 5).length, 0);
    console.log("PASS: a timed-out batch is retried once in two halves, which succeed");
  } finally {
    m.removeJobDir(job1);
    s1.cleanup();
  }
  // A slide missing from a half's answer goes through the normal one-time retry.
  const s2 = fakeSession("hangbig:2,drop:3");
  const job2 = m.createJobDir();
  try {
    const one = { ...plan, batches: plan.batches.slice(0, 1) };
    const res = await new m.BatchCommentaryGenerator(provider(m.ClaudeCliProvider, FAKE_CLAUDE, job2, new m.UsageTracker(), { timeoutMs: 800 })).generate({ plan: one, context, renderImage });
    assert.deepEqual(s2.calls().map(pagesOf), [[2, 3, 4, 5], [2, 3], [3], [4, 5]]);
    assert.equal(res.generatedCount, 4);
    assert.equal(res.errors.filter((e) => e.slideNum <= 5).length, 0);
    console.log("PASS: a slide missing from a split half is retried once alone");
  } finally {
    m.removeJobDir(job2);
    s2.cleanup();
  }
  // Everything hangs: batch, then its first half time out, which is 2 failures in a row: stop.
  const s = fakeSession("hang");
  const job = m.createJobDir();
  try {
    const res = await new m.BatchCommentaryGenerator(provider(m.ClaudeCliProvider, FAKE_CLAUDE, job, new m.UsageTracker(), { timeoutMs: 800 })).generate({ plan, context, renderImage });
    assert.deepEqual(s.calls().map(pagesOf), [[2, 3, 4, 5], [2, 3]]);
    assert.equal(res.errors.length, 12);
    assert.ok(res.errors.slice(0, 2).every((e) => /응답이 없어 중단/.test(e.reason)));
    assert.ok(res.errors.slice(2).every((e) => /2번 연속 실패/.test(e.reason)));
    console.log("PASS: repeated timeouts count as consecutive failures and stop the run");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- whole-call failures are not retried; two in a row stop the run ----
{
  const s = fakeSession("crash");
  const job = m.createJobDir();
  try {
    const res = await new m.BatchCommentaryGenerator(provider(m.CodexCliProvider, FAKE_CODEX, job, new m.UsageTracker())).generate({ plan, context, renderImage });
    const pagesOf = (c) => [...c.stdin.matchAll(/^### 슬라이드 (\d+)/gm)].map((x) => Number(x[1]));
    assert.deepEqual(s.calls().map(pagesOf), [[2, 3, 4, 5], [6, 7, 8, 9]], "no retry of a failed call; stop after 2 failures");
    assert.equal(res.errors.length, 12);
    assert.ok(res.errors.slice(8).every((e) => /2번 연속 실패/.test(e.reason)));
    console.log("PASS: failed calls are not retried, two consecutive failures stop the run");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- model text that mentions a limit is an invalid answer, not a usage limit (review L2) ----
{
  const s = fakeSession("textlimit");
  const job = m.createJobDir();
  try {
    const one = { ...plan, batches: plan.batches.slice(0, 1) };
    const res = await new m.BatchCommentaryGenerator(provider(m.ClaudeCliProvider, FAKE_CLAUDE, job, new m.UsageTracker())).generate({ plan: one, context, renderImage });
    assert.equal(s.calls().length, 2, "invalid answer asked for once more");
    assert.ok(res.errors.slice(0, 4).every((e) => /JSON 형식 오류/.test(e.reason)), JSON.stringify(res.errors));
    console.log("PASS: a model answer mentioning a limit is retried as invalid, not treated as a usage limit");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- failed re-import keeps the previous commentary (review H1) ----
{
  const previous = (page, hash, withMeta) => ({
    slideNum: page,
    hash,
    commentary: `이전 해설 ${page}`,
    imageSignal: withMeta ? "0".repeat(128) : null,
    gist: withMeta ? `이전 요지 ${page}` : "",
    meta: withMeta ? m.formatSlideMeta("0".repeat(128), `이전 요지 ${page}`) : "",
  });
  const existing = [previous(2, plan.slides[1].hash, true), previous(3, "ffffffff", true)];
  const withPrev = m.planDeck({ ...d, transcript: null, transcriptCapChars: 200, batchSize: 8, deckTitle: "L7", existing });
  assert.equal(withPrev.slides[1].previous.commentary, "이전 해설 2", "hash match");
  assert.equal(withPrev.slides[2].previous.commentary, "이전 해설 3", "same-number fallback");
  const s = fakeSession("dropalways:2,dropalways:3,dropalways:4");
  const job = m.createJobDir();
  try {
    const one = { ...withPrev, batches: withPrev.batches.slice(0, 1) };
    const res = await new m.BatchCommentaryGenerator(provider(m.ClaudeCliProvider, FAKE_CLAUDE, job, new m.UsageTracker())).generate({ plan: one, context, renderImage });
    const byNum = new Map(res.slides.map((x) => [x.slideNum, x]));
    assert.equal(byNum.get(2).commentary, "이전 해설 2");
    assert.equal(m.parseSlideMeta(byNum.get(2).meta).gist, "이전 요지 2", "old meta kept");
    assert.equal(byNum.get(3).commentary, "이전 해설 3");
    assert.equal(byNum.get(3).meta, undefined, "number match (other content): no reusable meta (review N3)");
    assert.ok(!res.gists.has(3), "and no stale gist");
    assert.ok(!byNum.has(4), "no previous section: listed as failed");
    assert.deepEqual(res.keptPrevious, [2, 3]);
    assert.equal(res.generatedCount, 1, "slide 5 was generated");
    assert.deepEqual(res.errors.filter((e) => e.slideNum <= 5).map((e) => e.slideNum), [2, 3, 4]);
    assert.match(res.errors[0].reason, /이전 해설을 유지/);
    console.log("PASS: failed slides keep their previous commentary and meta, and are listed as warnings");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- cancel mid-run ----
{
  const s = fakeSession("hang");
  const job = m.createJobDir();
  const ctrl = new AbortController();
  try {
    const p = new m.BatchCommentaryGenerator(provider(m.ClaudeCliProvider, FAKE_CLAUDE, job, new m.UsageTracker(), { signal: ctrl.signal })).generate({ plan, context, renderImage, signal: ctrl.signal });
    for (let i = 0; i < 50 && s.pids().length < 2; i++) await sleep(100);
    ctrl.abort();
    await assert.rejects(p, (e) => m.isAbortError(e));
    await sleep(300);
    for (const pid of s.pids()) assert.ok(!isAlive(pid));
    assert.equal(s.calls().length, 1, "no retry after cancel");
    console.log("PASS: cancel aborts the run and kills the CLI");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- full pipeline + note + re-import reuse ----
{
  const s = fakeSession("ok");
  const job = m.createJobDir();
  const usage = new m.UsageTracker();
  try {
    const commentaryLlm = provider(m.ClaudeCliProvider, FAKE_CLAUDE, job, usage);
    const conceptLlm = provider(m.ClaudeCliProvider, FAKE_CLAUDE, job, usage, { model: "haiku", effort: "low", task: "concepts" });
    const steps = [];
    const run = await m.runBatchedLecture({
      plan,
      context,
      subject: "CSED",
      language: "ko",
      altSummary: "Alt 요약",
      commentaryLlm,
      conceptLlm,
      renderImage,
      onStep: (st) => steps.push(st),
    });
    assert.deepEqual(steps, ["commentary", "overview", "concepts"]);
    assert.deepEqual(run.concepts.map((c) => c.name), ["캐시", "캐시 일관성"]);
    assert.deepEqual(run.tags, ["cache", "memory"]);
    assert.match(run.overview, /요약 텍스트/);
    const calls = s.calls();
    assert.equal(calls.length, 5, "3 batches + overview + concepts");
    assert.ok(calls[3].stdin.includes("p.2: 슬라이드 2의 요지") && calls[3].stdin.includes("Alt 요약"), "overview from gists + Alt summary");
    assert.ok(!calls[3].stdin.includes("### 슬라이드"), "overview does not resend slides");
    assert.ok(calls[4].argv.includes("haiku"), "concepts use the concept task model");
    assert.ok(calls[4].stdin.includes("Concept names linked in the slide commentary:\n캐시"));
    assert.equal(usage.total().calls, 5);

    const est = m.estimateLecture(plan, context, "Alt 요약", "claude-cli", "claude-cli");
    assert.equal(est.calls, calls.length, "estimate predicts the call count");
    assert.equal(est.imagesSent, 2);

    const altData = { title: "L7", summary: "Alt 요약", transcript: null, parseQuality: "full", metadata: { noteId: "note-1", createdAt: "" } };
    const note = (
      await new m.NoteGenerator(null).generatePageAnchored(
        altData,
        run.slidesResult,
        { processedSummary: run.overview, concepts: run.concepts, tags: run.tags, subjectSuggestion: "CSED" },
        "CSED"
      )
    ).lectureMarkdown;
    assert.equal(m.splitMultiManagedNote(note).sections.length, 14);

    // Re-import of the same deck: every generated slide is reused, no batch call.
    const again = m.planDeck({ ...d, transcript: null, transcriptCapChars: 200, batchSize: 8, deckTitle: "L7", existing: m.parseExistingSlides(note) });
    assert.equal(again.batches.length, 0);
    assert.equal(m.planCounts(again).reused, 12);
    const before = s.calls().length;
    const rerun = await m.runBatchedLecture({ plan: again, context, subject: "CSED", language: "ko", altSummary: "Alt 요약", commentaryLlm, conceptLlm, renderImage });
    assert.equal(s.calls().length - before, 2, "only overview + concepts, from stored gists");
    assert.equal(rerun.slidesResult.slides[1].commentary, run.slidesResult.slides[1].commentary);
    console.log("PASS: pipeline commentary -> overview (gists + Alt summary) -> concepts; estimate matches; re-import reuses unchanged slides");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// Link names the commentary used, including alias links and the escaped alias pipe inside a table.
{
  const names = m.wikilinkCandidates([
    "[[로터리 스케줄링 (Lottery Scheduling)]]은 ... [[티켓 (Ticket)|티켓]]",
    "| 개념 | 설명 |\n|---|---|\n| [[스트라이드 스케줄링 (Stride Scheduling)\\|스트라이드]] | 결정적 |",
    "[[개념#제목]] ![[그림.png]]",
  ]);
  assert.deepEqual(names.slice(0, 3), ["로터리 스케줄링 (Lottery Scheduling)", "티켓 (Ticket)", "스트라이드 스케줄링 (Stride Scheduling)"]);
  console.log("PASS: link candidates from plain, alias and table-escaped alias links");
}
