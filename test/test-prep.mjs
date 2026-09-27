/**
 * Test: deterministic prep (SlideAnalyzer, TranscriptCompressor, page
 * layout), the generation plan, the budget estimate, the per-slide meta
 * comment and its marker compatibility, and the settings migration.
 * Pure code only: no CLI, no tokens.
 * Run: node test/test-prep.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importTs } from "./helpers/bundle-ts.mjs";
import { FIXTURE_PAGES, FIXTURE_PATH } from "./helpers/synthetic-pdf.mjs";

const m = await importTs("test/helpers/pipeline-entry.ts");

// ---- synthetic renders ----
function blank(w = 160, h = 120, v = 255) {
  return { width: w, height: h, data: new Uint8Array(w * h).fill(v) };
}
function fillRect(img, x0, y0, x1, y1, v = 0) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data[y * img.width + x] = v;
  return img;
}

// ---- text similarity and classification ----
{
  const a = "Cache coherence: MESI protocol keeps caches consistent across cores";
  assert.equal(m.textSimilarity(a, a), 1);
  assert.ok(m.textSimilarity(a, a + " (M)") >= 0.9, "animation build step is a near duplicate");
  assert.ok(m.textSimilarity(a, "Virtual memory and page tables with TLB") < 0.5);
  assert.equal(m.textSimilarity("", ""), 0);

  assert.equal(m.classifySlide(0, 30, "Computer Architecture Lecture 7", null), "cover");
  assert.equal(m.classifySlide(0, 30, "x".repeat(400), null), "content");
  // TOC: keyword as the whole first line, within the first 15% (min 3) pages (review M5).
  assert.equal(m.classifySlide(3, 30, "Contents1. Intro2. Caches", 0.01, ["3", "Contents", "1. Intro", "2. Caches"]), "toc");
  assert.equal(m.classifySlide(2, 30, "목차캐시와 메모리", 0.01, ["목차", "캐시와 메모리"]), "toc");
  assert.equal(m.classifySlide(20, 30, "Outline1. Intro", 0.01, ["Outline", "1. Intro"]), "content", "late outline slide is content");
  assert.equal(m.classifySlide(2, 30, "Contents of a cache line: tag, index", 0.01, ["Contents of a cache line: tag, index"]), "content");
  assert.equal(m.classifySlide(29, 30, "Thank you!", 0.02), "thanks");
  assert.equal(m.classifySlide(28, 30, "Q&A", 0.02), "thanks");
  assert.equal(m.classifySlide(29, 30, "질문: 왜 캐시가 빠른가?", 0.02, ["질문: 왜 캐시가 빠른가?"]), "content", "a question slide is not a closing slide");
  assert.equal(m.classifySlide(29, 30, "46Question?Announcements- Textbook reading: P&H Ch. 5.1", 0.02, ["46", "Question?", "Announcements", "- Textbook reading: P&H Ch. 5.1"]), "content");
  // Cover with a long disclaimer (lec13 page 1) (review A.5).
  const lec13Cover = [
    "CSED311 Computer Architecture \u2013 Lecture 13", // en dash as in the PDF
    "Memory Hierarchy & Cache",
    "Gwangsun Kim",
    "Department of Computer Science and Engineering",
    "POSTECH",
    "Disclaimer: Slides developed in part by Profs. Austin, Brehob, Falsafi, Hill, Hoe, Lipasti, Martin, Roth,",
    "Shen, Smith, Sohi, Tyson, Vijaykumar, Mutlu, and Wenisch @ Carnegie Mellon University, University",
    "of Michigan, Purdue University, University of Pennsylvania, University of Wisconsin.",
  ];
  assert.equal(m.classifySlide(0, 46, lec13Cover.join(""), 0.1, lec13Cover), "cover");
  const bulletFirst = ["Lecture 13 review", "• Caches keep recent data close to the CPU and reduce the average access time", "• Department of redundancy department"];
  assert.equal(m.classifySlide(0, 46, bulletFirst.join("") + "x".repeat(200), 0.1, bulletFirst), "content", "a first page with bullets is content");
  const noAffiliation = ["Lecture 13: Memory Hierarchy", "Why do we need caches? " + "Because main memory is slow. ".repeat(8)];
  assert.equal(m.classifySlide(0, 46, noAffiliation.join(""), 0.1, noAffiliation), "content", "title without author or affiliation is not a cover");
  assert.equal(m.classifySlide(10, 30, "Thank you for the feedback on homework 3, " + "details ".repeat(20), 0.0), "content");
  assert.equal(m.classifySlide(10, 30, "Figure 3", 0.2), "visual");
  assert.equal(m.classifySlide(10, 30, "x".repeat(200), 0.45), "visual");
  assert.equal(m.classifySlide(10, 30, "x".repeat(200), 0.05), "content");
  assert.equal(m.classifySlide(10, 30, "", null), "visual");
  // Build steps vs different slides (review M4).
  const base = "Cache hierarchy: L1 is small and fast, L2 is larger, main memory is slow";
  assert.ok(m.isBuildStep(base, base));
  assert.ok(m.isBuildStep(base, base + " and far"), "added text is a build step");
  assert.ok(!m.isBuildStep("Case 1: the block is in the cache and the tag matches", "Case 2: the block is in the cache and the tag matches"), "Case 1 vs Case 2");
  assert.ok(!m.isBuildStep("Hit latency is 10 ns and miss penalty is 100 ns for this cache", "Hit latency is 20 ns and miss penalty is 100 ns for this cache"), "changed number");
  assert.ok(!m.isBuildStep(base + " and far", base), "removing text is not a build step");
  assert.ok(!m.isBuildStep("Direct mapped cache: each block maps to exactly one line", "Fully associative cache: each block maps to any line"));
  console.log("PASS: text similarity and slide kind rules (cover, toc, thanks, content, visual), build-step detection");
}

// ---- image ratio and image signal ----
{
  const textOnly = fillRect(blank(), 10, 10, 150, 30);
  const boxes = [{ x: 0.05, y: 0.05, w: 0.9, h: 0.25 }];
  assert.ok(m.computeImageRatio(textOnly, boxes) < 0.02, "ink under text boxes does not count");
  const diagram = fillRect(fillRect(blank(), 10, 10, 150, 30), 20, 45, 140, 115, 90);
  const r = m.computeImageRatio(diagram, boxes);
  assert.ok(r > 0.3, `diagram area counts (${r})`);
  assert.equal(m.computeImageRatio(blank(), []), 0);

  const sig = m.imageSignal(diagram);
  assert.match(sig, /^[0-9a-f]{128}$/);
  assert.equal(m.imageSignal(diagram), sig, "deterministic");
  const noisy = { ...diagram, data: diagram.data.map((v, i) => (i % 97 === 0 ? Math.min(255, v + 3) : v)) };
  assert.ok(m.sameImageSignal(sig, m.imageSignal(noisy)), "anti-aliasing noise keeps the signal");
  const edited = fillRect(fillRect(blank(), 10, 10, 150, 30), 20, 45, 70, 115, 90);
  assert.ok(!m.sameImageSignal(sig, m.imageSignal(edited)), "changed figure changes the signal");
  // A small mark inside the figure: the average hash can miss it, the luminance grid does not (review M6).
  const marked = fillRect({ ...diagram, data: Uint8Array.from(diagram.data) }, 60, 60, 75, 75, 255);
  assert.ok(!m.sameImageSignal(sig, m.imageSignal(marked)), "small edit inside a figure changes the signal");
  assert.ok(!m.sameImageSignal(sig, null));
  assert.ok(!m.sameImageSignal(sig.slice(0, 64), sig.slice(0, 64)), "old 64-hex signals never match");
  assert.equal(m.signalDistance("f0", "0f"), 8);
  console.log("PASS: image ratio from renders and text boxes; 16x16 average-hash image signal");
}

// ---- analyzeSlides: dup runs, templates, scanned PDFs ----
{
  const build = "Pipelining overlaps instruction execution to raise throughput in the CPU";
  const layouts = [
    { text: "Lecture 7 Pipelining", boxes: [] },
    { text: "Contents1 Pipelining2 Hazards", boxes: [], lines: ["Contents", "1 Pipelining", "2 Hazards"] },
    { text: build, boxes: [] },
    { text: build + " IF", boxes: [] },
    { text: build + " IF ID", boxes: [] },
    { text: "Hazards stall the pipeline when an instruction depends on a previous one", boxes: [] },
    { text: "", boxes: [] },
    { text: "Thank you", boxes: [] },
  ];
  const grays = layouts.map((_, i) => (i === 6 ? fillRect(blank(), 10, 10, 150, 110, 60) : blank()));
  const { slides, scanned } = await m.analyzeSlides(layouts, grays, { sourceId: "n1" });
  assert.equal(scanned, false);
  assert.deepEqual(slides.map((s) => s.kind), ["cover", "toc", "content", "content", "content", "content", "visual", "thanks"]);
  assert.deepEqual(slides.map((s) => s.dupOf), [null, null, 5, 5, null, null, null, null], "animation run keeps only its last page");
  assert.deepEqual(slides.map((s) => s.sendImage), [false, false, false, false, false, false, true, false]);
  assert.equal(slides[2].hash, await m.computeSlideHash(build, 3, "n1"), "same hash rule as slideHash.ts");
  assert.match(m.templateCommentary(slides[2], "L7"), /\[\[#📚 슬라이드 5\|슬라이드 5\]\]/);
  assert.equal(m.templateCommentary(slides[0], "L7"), "표지 슬라이드: **Lecture 7 Pipelining**");
  assert.equal(m.templateCommentary(slides[5], "L7"), null);

  const textOnlyRule = await m.analyzeSlides(layouts, grays, { sourceId: "n1", imageRule: "text-only" });
  assert.ok(textOnlyRule.slides.every((s) => !s.sendImage), "text-only rule sends no images");

  const scan = await m.analyzeSlides(
    [{ text: "", boxes: [] }, { text: null, boxes: [] }, { text: "", boxes: [] }],
    [blank(), blank(), blank()],
    { sourceId: "n2", imageRule: "text-only" }
  );
  assert.equal(scan.scanned, true);
  assert.ok(scan.slides.every((s) => s.kind === "content" && s.sendImage), "a scan sends every page as an image");
  // Visual pages with the same text but different pictures are not merged.
  const fig = "Figure: pipeline diagram of the five stages";
  const vis = await m.analyzeSlides(
    [{ text: "Title", boxes: [] }, { text: fig, boxes: [] }, { text: fig, boxes: [] }],
    [blank(), fillRect(blank(), 10, 30, 80, 110, 60), fillRect(blank(), 10, 30, 150, 110, 60)],
    { sourceId: "v" }
  );
  assert.deepEqual(vis.slides.map((x) => [x.kind, x.dupOf]), [["cover", null], ["visual", null], ["visual", null]]);
  console.log("PASS: analyzeSlides kinds, near-duplicate runs, image rule, scanned PDF, visual steps need the same picture");
}

// ---- TranscriptCompressor ----
{
  assert.equal(m.removeFillers("음 그러니까 캐시는, 어, 빠른 메모리입니다."), "캐시는, 빠른 메모리입니다.");
  assert.equal(m.removeFillers("um so the cache uh is fast"), "so the cache is fast");
  assert.equal(m.removeFillers("음악과 어머니"), "음악과 어머니", "only whole-word fillers");
  assert.equal(m.removeFillers("이제 캐시를 막 채웁니다. mm 단위"), "이제 캐시를 막 채웁니다. mm 단위", "이제, 막, mm are kept (review L3)");
  assert.equal(m.removeFillers("뭐, 캐시가 뭐가 문제냐면 아... 느립니다"), "캐시가 뭐가 문제냐면 느립니다", "뭐/아 only before a comma or ellipsis");
  assert.equal(m.collapseRepeats("그래서 그래서 그래서 캐시가 캐시가 빠르다"), "그래서 캐시가 빠르다");
  assert.equal(m.collapseRepeats("the cache the cache is fast"), "the cache is fast");
  assert.deepEqual(
    m.dedupeSentences(["캐시는 빠릅니다.", "캐시는 빠릅니다.", "캐시는  빠릅니다!", "메모리는 느립니다."]),
    ["캐시는 빠릅니다.", "메모리는 느립니다."]
  );
  const sentences = ["오늘 날씨가 좋네요.", "캐시 일관성은 MESI로 유지됩니다.", "점심 뭐 먹을까요.", "MESI 상태는 네 가지입니다."];
  const kept = m.capSentences(sentences, "Cache coherence MESI protocol 캐시 일관성", 45);
  assert.deepEqual(kept, ["캐시 일관성은 MESI로 유지됩니다.", "MESI 상태는 네 가지입니다."], "overlap first, original order");
  const c = m.compressTranscript("음 음 오늘은 캐시를 배웁니다. 오늘은 캐시를 배웁니다. " + "잡담입니다. ".repeat(200), "캐시", 100);
  assert.ok(c.text.length <= 100 && c.text.startsWith("오늘은 캐시를 배웁니다."), c.text);
  assert.ok(c.originalChars > 1000);
  assert.deepEqual(m.compressTranscript(null, "x", 600), { text: "", originalChars: 0 });
  assert.deepEqual(m.splitTranscriptEvenly("abcdef", 3), ["ab", "cd", "ef"]);
  console.log("PASS: transcript fillers, repeats, duplicate sentences, per-slide cap by overlap");
}

// ---- page layout from pdfjs, PGM parsing ----
{
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(FIXTURE_PATH)), verbosity: 0 }).promise;
  const layouts = await m.extractPageLayouts(doc);
  const texts = await m.extractPageTexts(doc);
  await doc.destroy();
  assert.deepEqual(layouts.map((l) => l.text), texts, "layout text is the hash text");
  assert.equal(layouts.length, FIXTURE_PAGES.length);
  assert.equal(layouts[3].boxes.length, 0, "image-only page has no text boxes");
  for (const b of layouts[0].boxes) assert.ok(b.x >= 0 && b.x <= 1 && b.y >= 0 && b.y <= 1 && b.w > 0 && b.h > 0);

  const header = Buffer.from("P5\n# comment\n3 2\n255\n");
  const pgm = m.parsePgm(new Uint8Array(Buffer.concat([header, Buffer.from([0, 128, 255, 10, 20, 30])])));
  assert.deepEqual([pgm.width, pgm.height, Array.from(pgm.data)], [3, 2, [0, 128, 255, 10, 20, 30]]);
  assert.throws(() => m.parsePgm(new Uint8Array(Buffer.from("P6\n1 1\n255\n\0\0\0"))), /P5/);
  const g = m.rgbaToGray(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0]), 3, 1);
  assert.deepEqual(Array.from(g.data), [255, 0, 255], "transparent renders as white");
  console.log("PASS: page layouts (text equals hash text, normalized boxes), PGM and RGBA to gray");
}

// ---- plan, batches, reuse ----
async function deck(n, visualPages = []) {
  const layouts = [];
  for (let i = 1; i <= n; i++) layouts.push({ text: i === 1 ? "Title" : `Slide ${i} topic about caches and memory ${"x".repeat(i)} unique ${i * 7919}`, boxes: [] });
  const grays = layouts.map((_, i) => (visualPages.includes(i + 1) ? fillRect(blank(), 10, 30, 150, 110, 60) : blank()));
  return { layouts, grays, ...(await m.analyzeSlides(layouts, grays, { sourceId: "s" })) };
}
{
  const d = await deck(20, [5, 6, 7]);
  const plan = m.planDeck({ ...d, transcript: "캐시 ".repeat(2000), transcriptCapChars: 120, batchSize: 8, deckTitle: "T" });
  assert.equal(plan.slides[0].mode, "template");
  const llmPages = plan.slides.filter((s) => s.mode === "llm").map((s) => s.page);
  assert.equal(llmPages.length, 19);
  assert.deepEqual(plan.batches.map((b) => [b.pages[0], b.pages.length, b.hasImages]), [
    [2, 4, true],
    [6, 4, true],
    [10, 8, false],
    [18, 3, false],
  ]);
  assert.ok(plan.slides.every((s) => s.transcript.length <= 120));
  assert.ok(plan.transcriptChars.after < plan.transcriptChars.before);

  const fewer = m.withFewerImages(plan, 8);
  assert.equal(m.planCounts(fewer).images, 0, "visual slides with text go text-only");
  assert.ok(fewer.batches.length < plan.batches.length);

  // Near-duplicate run: the kept page gets the run's transcript, in order.
  const run = await m.analyzeSlides(
    [
      { text: "Title", boxes: [] },
      { text: "Pipelining overlaps instruction execution for throughput", boxes: [] },
      { text: "Pipelining overlaps instruction execution for throughput!", boxes: [] },
    ],
    [null, null, null],
    { sourceId: "s" }
  );
  const runPlan = m.planDeck({ layouts: [{ text: "Title" }, { text: "a" }, { text: "b" }], ...run, transcript: "AAAA. BBBB. CCCC.", transcriptCapChars: 600, batchSize: 8, deckTitle: "T" });
  assert.equal(runPlan.slides[1].mode, "template");
  assert.ok(runPlan.slides[2].transcript.indexOf("BBBB") < runPlan.slides[2].transcript.indexOf("CCCC"), runPlan.slides[2].transcript);
  console.log("PASS: plan modes, K and K/2 batches, transcript cap, fewer images, duplicate run transcript");
}

// ---- slide meta + marker compatibility + reuse ----
{
  const gist = "캐시 --> 일관성 -- 요지 \"따옴표\" > 끝";
  const meta = m.formatSlideMeta("a".repeat(64), gist);
  assert.ok(!meta.slice(4, -3).includes("--"), "no -- inside the comment");
  assert.deepEqual(m.parseSlideMeta(`본문\n${meta}`), { imageSignal: "a".repeat(64), gist });
  assert.equal(m.stripSlideMeta(`본문\n${meta}`), "본문");
  assert.equal(m.parseSlideMeta("1.x 본문"), null);
  assert.deepEqual(m.parseSlideMeta(m.formatSlideMeta(null, "g")), { imageSignal: null, gist: "g" });

  // 1.1.0 note (no meta) and 2.0 note (meta) through the unchanged marker grammar.
  const altData = { title: "L", summary: "", transcript: null, parseQuality: "full", metadata: { noteId: "n", createdAt: "" } };
  const llmResult = { processedSummary: "요약", concepts: [], tags: [], subjectSuggestion: "S" };
  const d = await deck(4);
  const sectionsOld = d.slides.map((s) => ({ slideNum: s.page, hash: s.hash, commentary: `해설 ${s.page}`, citedConcepts: [] }));
  const sectionsNew = d.slides.map((s) => ({ ...sectionsOld[s.page - 1], meta: m.formatSlideMeta(s.imageSignal, `요지 ${s.page}`) }));
  const gen = new m.NoteGenerator(null);
  const res = (slides) => ({ slides, errors: [], totalWallTimeMs: 0, perSlideWallTimeMs: [] });
  const oldNote = (await gen.generatePageAnchored(altData, res(sectionsOld), llmResult, "S")).lectureMarkdown;
  const newNote = (await gen.generatePageAnchored(altData, res(sectionsNew), llmResult, "S", ["alt2obs_usage: {calls: 1}"])).lectureMarkdown;

  // The 1.1.0 marker regex (copied from merge.ts at 1.1.0) still sees every slide.
  const MARKER_110 = /<!-- alt2obs:slide:(\d+) hash:([0-9a-f]{8})(?: dup:(\d+))? (start|end) -->/g;
  assert.equal([...newNote.matchAll(MARKER_110)].length, 8);
  assert.equal(m.splitMultiManagedNote(oldNote).sections.length, 4);
  assert.equal(m.splitMultiManagedNote(newNote).sections.length, 4);
  assert.ok(m.hasMultiManagedMarkers(newNote));
  assert.ok(newNote.includes("alt2obs_usage: {calls: 1}\n---"), "usage frontmatter line");
  assert.deepEqual(m.parseExistingSlides(oldNote).map((e) => [e.slideNum, e.gist, e.meta]), [1, 2, 3, 4].map((i) => [i, "", ""]), "1.1.0 notes: sections without metadata");
  assert.ok(newNote.includes("해설 2\n\n<!-- alt2obs:meta"), "meta separated by a blank line (review L10)");
  const existing = m.parseExistingSlides(newNote);
  assert.deepEqual(existing.map((e) => [e.slideNum, e.gist, e.commentary]), [1, 2, 3, 4].map((i) => [i, `요지 ${i}`, `해설 ${i}`]));

  // Memo survives 1.1.0 -> 2.0 -> 2.0 re-imports.
  const withMemo = oldNote.replace("> [!note] 내 메모\n> \n\n## 📚 슬라이드 3", "> [!note] 내 메모\n> 내가 쓴 메모\n\n## 📚 슬라이드 3");
  assert.notEqual(withMemo, oldNote);
  const merged = m.mergeNote(withMemo, newNote).merged;
  assert.ok(merged.includes("내가 쓴 메모"));
  assert.equal(m.parseExistingSlides(merged).filter((e) => e.gist).length, 4);
  // A 1.1.0 note gives no reuse (no gist, no image signal).
  assert.ok(m.planDeck({ ...d, transcript: null, transcriptCapChars: 600, batchSize: 8, deckTitle: "T", existing: m.parseExistingSlides(oldNote) }).slides.every((s) => s.mode !== "reuse"));
  assert.equal(m.mergeNote(merged, newNote).merged, merged, "re-import of an unchanged 2.0 note is idempotent");

  // Reuse needs text hash AND image signal.
  const same = m.planDeck({ ...d, transcript: null, transcriptCapChars: 600, batchSize: 8, deckTitle: "T", existing });
  assert.deepEqual(same.slides.map((s) => s.mode), ["template", "reuse", "reuse", "reuse"]);
  assert.equal(same.batches.length, 0, "nothing left to generate");
  assert.equal(same.slides[2].reused.commentary, "해설 3");
  const changedImage = { ...d, slides: d.slides.map((s) => (s.page === 3 ? { ...s, imageSignal: "f".repeat(64) } : s)) };
  const partly = m.planDeck({ ...changedImage, transcript: null, transcriptCapChars: 600, batchSize: 8, deckTitle: "T", existing });
  assert.deepEqual(partly.slides.map((s) => s.mode), ["template", "reuse", "llm", "reuse"], "image-only edit regenerates");
  const noRender = { ...d, slides: d.slides.map((s) => ({ ...s, imageSignal: null })) };
  assert.ok(m.planDeck({ ...noRender, transcript: null, transcriptCapChars: 600, batchSize: 8, deckTitle: "T", existing }).slides.every((s) => s.mode !== "reuse"), "no render, no reuse");
  console.log("PASS: meta comment round trip, 1.1.0 marker grammar unchanged, memos kept, reuse only on hash + image signal");
}

// ---- budget estimate ----
{
  assert.equal(m.estimateTextTokens("abcd"), 2);
  assert.equal(m.estimateTextTokens("가나다라마"), 5);
  assert.deepEqual(m.estimateCalls([{ promptText: "a".repeat(400), images: 2, outputTokens: 50, schema: true }], "claude-cli"), {
    calls: 1,
    // Claude: one turn (images inline, JSON asked in the prompt).
    inputTokens: 300 + 200 + 2 * 1060,
    outputTokens: 50,
    imagesSent: 2,
  });
  assert.equal(m.estimateCalls([{ promptText: "a".repeat(400), images: 0, outputTokens: 50, schema: true }], "codex-cli").inputTokens, 11900 + 200);
  assert.equal(m.estimateCalls([{ promptText: "a".repeat(400), images: 0, outputTokens: 50, schema: true }], "claude-cli").inputTokens, 300 + 200);
  assert.equal(m.exceedsCap({ inputTokens: 900, outputTokens: 200 }, 1000), true);
  assert.equal(m.exceedsCap({ inputTokens: 900, outputTokens: 200 }, 0), false);

  const d = await deck(20, [5, 6, 7]);
  const plan = m.planDeck({ ...d, transcript: null, transcriptCapChars: 600, batchSize: 8, deckTitle: "T" });
  const ctx = { title: "T", subjectTags: ["cache"], knownConcepts: ["캐시"] };
  const est = m.estimateLecture(plan, ctx, "요약", "claude-cli", "claude-cli");
  assert.equal(est.calls, plan.batches.length + 2, "batches + overview + concepts");
  assert.equal(est.imagesSent, 3);
  assert.deepEqual([est.slidesTotal, est.slidesGenerated, est.slidesTemplated, est.slidesDeduped, est.slidesReused], [20, 19, 1, 0, 0]);
  const fewer = m.estimateLecture(m.withFewerImages(plan, 8), ctx, "요약", "claude-cli", "claude-cli");
  assert.ok(fewer.inputTokens < est.inputTokens && fewer.imagesSent === 0);
  console.log(`PASS: budget estimate (${est.calls} calls, ~${est.inputTokens} in / ${est.outputTokens} out), fewer images lowers it`);
}

// ---- settings migration and presets ----
{
  const v1 = { apiKey: "k1,k2", provider: "gemini", geminiModel: "gemma-3-27b-it", baseFolderPath: "Lectures", language: "ko", rateDelayMs: 6000 };
  const { settings, needsCliDefault } = m.migrateSettings(v1);
  assert.equal(needsCliDefault, true);
  assert.deepEqual([settings.apiKey, settings.geminiModel, settings.baseFolderPath, settings.rateDelayMs], ["k1,k2", "gemma-3-27b-it", "Lectures", 6000]);
  assert.equal(settings.tasks.commentary.provider, "gemini");
  assert.equal(m.effectiveModel(settings, settings.tasks.commentary), "gemma-3-27b-it");
  assert.equal(settings.generation.batchSize, 8);
  assert.equal(settings.cliTimeoutSec, 300);
  assert.equal(m.migrateSettings({ provider: "ollama" }).settings.tasks.concepts.provider, "ollama");
  assert.equal(m.migrateSettings({ provider: "claude" }).settings.tasks.commentary.provider, "gemini", "1.x Claude stub maps to Gemini");

  m.applyClaudeDefaults(settings);
  assert.deepEqual(settings.tasks.commentary, { provider: "claude-cli", model: "sonnet", effort: "medium" });
  assert.deepEqual(settings.tasks.concepts, { provider: "claude-cli", model: "haiku", effort: "low" });
  assert.equal(settings.tasks.alignment.provider, "none");

  const again = m.migrateSettings(JSON.parse(JSON.stringify(settings)));
  assert.equal(again.needsCliDefault, false, "2.0 data is not migrated twice");
  assert.deepEqual(again.settings.tasks, settings.tasks);

  m.applyPreset(settings, "saving");
  assert.deepEqual([settings.tasks.commentary.model, settings.tasks.commentary.effort], ["haiku", "low"]);
  m.applyPreset(settings, "quality");
  assert.deepEqual([settings.tasks.commentary.model, settings.tasks.commentary.effort], ["opus", "high"]);
  assert.deepEqual([settings.tasks.concepts.model, settings.tasks.concepts.effort], ["haiku", "low"]);
  settings.tasks.commentary.provider = "codex-cli";
  m.applyPreset(settings, "quality");
  assert.deepEqual([settings.tasks.commentary.model, settings.tasks.commentary.effort], ["", "high"], "Codex keeps its default model");
  m.rememberModel(settings, "claude-cli", "sonnet");
  m.rememberModel(settings, "claude-cli", "haiku");
  m.rememberModel(settings, "claude-cli", "sonnet");
  assert.deepEqual(settings.recentModels["claude-cli"], ["sonnet", "haiku"]);
  // Review H2: a working 1.x setup is only offered the switch.
  const keyed = m.migrateSettings({ apiKey: "k", provider: "gemini" }).settings;
  assert.equal(m.cliDefaultAction(keyed, true), "offer");
  assert.equal(m.cliDefaultAction(m.migrateSettings({ provider: "ollama" }).settings, true), "offer");
  assert.equal(m.cliDefaultAction(m.migrateSettings({ provider: "gemini" }).settings, true), "switch", "no key: nothing working to keep");
  assert.equal(m.cliDefaultAction(m.migrateSettings(undefined).settings, false), "none", "CLI missing or logged out");
  // Review L9: unsafe saved values are dropped.
  const bad = m.migrateSettings({
    tasks: { commentary: { provider: "claude-cli", model: "--dangerously-skip-permissions", effort: "ultra; rm" }, concepts: { provider: "evil", model: "haiku", effort: "low" } },
  }).settings;
  assert.deepEqual(bad.tasks.commentary, { provider: "claude-cli", model: "", effort: "" });
  assert.equal(bad.tasks.concepts.provider, "gemini");
  assert.ok(m.isSafeModelName("claude-sonnet-4-5[1m]") && m.isSafeModelName("gpt-5.6-luna") && !m.isSafeModelName("-m") && !m.isSafeModelName("a b"));
  console.log("PASS: 1.x settings kept, CLI defaults (sonnet/haiku), switch only without a working setup, presets, recent models, unsafe values dropped");
}
