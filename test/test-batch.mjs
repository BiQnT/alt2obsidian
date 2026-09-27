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
    assert.equal(res.slides[0].commentary, "표지 슬라이드: **Lecture 7 Caches**");
    assert.equal(res.slides[13].commentary, "마무리 슬라이드입니다.");
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

// ---- timeout: batch retried once, then reported ----
{
  const small = m.planDeck({ ...d, transcript: null, transcriptCapChars: 200, batchSize: 8, deckTitle: "L7" });
  const one = { ...small, batches: small.batches.slice(0, 1) };
  const s = fakeSession("hang");
  const job = m.createJobDir();
  try {
    const res = await new m.BatchCommentaryGenerator(provider(m.ClaudeCliProvider, FAKE_CLAUDE, job, new m.UsageTracker(), { timeoutMs: 800 })).generate({ plan: one, context, renderImage });
    assert.equal(s.calls().length, 2);
    assert.equal(res.errors.length, 4);
    assert.ok(res.errors.every((e) => /응답이 없어 중단/.test(e.reason)));
    console.log("PASS: a timed-out batch is retried once, then its slides are reported");
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
