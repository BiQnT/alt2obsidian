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
  // Effort scales the output (medium = the fitted figures), never the input; the model does not count.
  const shape = [{ promptText: "a".repeat(400), images: 0, outputTokens: 1000, schema: true }];
  assert.deepEqual(["", "low", "medium", "high", "xhigh", "max"].map((e) => m.estimateCalls(shape, "claude-cli", e).outputTokens), [1000, 780, 1000, 1300, 2260, 2480]);
  assert.equal(m.estimateCalls(shape, "claude-cli", "max").inputTokens, m.estimateCalls(shape, "claude-cli", "low").inputTokens);
  assert.equal(m.exceedsCap({ inputTokens: 900, outputTokens: 200 }, 1000), true);
  assert.equal(m.exceedsCap({ inputTokens: 900, outputTokens: 200 }, 0), false);

  const d = await deck(20, [5, 6, 7]);
  const plan = m.planDeck({ ...d, transcript: null, transcriptCapChars: 600, batchSize: 8, deckTitle: "T" });
  const ctx = { title: "T", subjectTags: ["cache"], knownConcepts: ["캐시"] };
  const est = m.estimateLecture(plan, ctx, "요약", "claude-cli", "claude-cli");
  assert.equal(est.calls, plan.batches.length + 2, "batches + overview + concepts");
  const high = m.estimateLecture(plan, ctx, "요약", "claude-cli", "claude-cli", { commentaryEffort: "high", conceptEffort: "low" });
  assert.equal(high.inputTokens, est.inputTokens, "effort does not change the input");
  assert.ok(high.outputTokens > est.outputTokens, "high effort: more output expected");
  assert.equal(est.imagesSent, 3);
  assert.deepEqual([est.slidesTotal, est.slidesGenerated, est.slidesTemplated, est.slidesDeduped, est.slidesReused], [20, 19, 1, 0, 0]);
  const fewer = m.estimateLecture(m.withFewerImages(plan, 8), ctx, "요약", "claude-cli", "claude-cli");
  assert.ok(fewer.inputTokens < est.inputTokens && fewer.imagesSent === 0);
  console.log(`PASS: budget estimate (${est.calls} calls, ~${est.inputTokens} in / ${est.outputTokens} out), fewer images lowers it`);
}

// ---- settings migration and presets ----
{
  // 1.x data (Gemini was the only working provider): every value kept, the default table, told once.
  const v1 = { apiKey: "k1,k2", provider: "gemini", geminiModel: "gemma-3-27b-it", baseFolderPath: "Lectures", language: "ko", rateDelayMs: 6000 };
  const { settings, needsCliDefault, removedFrom, movedTasks } = m.migrateSettings(v1);
  assert.equal(needsCliDefault, true);
  assert.deepEqual(removedFrom, ["gemini"], "1.x users are told Gemini is gone");
  assert.deepEqual(movedTasks, ["commentary", "concepts", "verification"], "the default table may still move to Codex");
  assert.deepEqual(m.migrateSettings({ provider: "ollama", baseFolderPath: "A" }).removedFrom, ["ollama"]);
  assert.deepEqual([settings.apiKey, settings.geminiModel, settings.baseFolderPath, settings.rateDelayMs], ["k1,k2", "gemma-3-27b-it", "Lectures", 6000], "unknown 1.x keys kept (rollback)");
  assert.deepEqual(settings.tasks.commentary, { provider: "claude-cli", model: "sonnet", effort: "medium" });
  assert.deepEqual(settings.tasks.concepts, { provider: "claude-cli", model: "haiku", effort: "low" });
  assert.deepEqual(settings.tasks.verification, { provider: "claude-cli", model: "sonnet", effort: "medium" });
  assert.equal(settings.tasks.alignment.provider, "none");
  assert.equal(settings.settingsVersion, 3);
  assert.equal(settings.generation.batchSize, 8);
  assert.equal(settings.cliTimeoutSec, 300);
  const fresh = m.migrateSettings(undefined);
  assert.deepEqual([fresh.needsCliDefault, fresh.removedFrom, fresh.filled], [true, [], []], "fresh install: CLI chosen once, no removal notice");

  // 2.0 beta data with tasks on Gemini/Ollama: those tasks move to the Claude CLI defaults.
  const beta = m.migrateSettings({
    settingsVersion: 2,
    tasks: {
      commentary: { provider: "gemini", model: "gemini-2.5-flash", effort: "" },
      concepts: { provider: "ollama", model: "gemma3:4b", effort: "" },
      alignment: { provider: "none", model: "", effort: "" },
      verification: { provider: "codex-cli", model: "gpt-5.6-luna", effort: "high" },
    },
  });
  assert.deepEqual([beta.needsCliDefault, beta.removedFrom.sort(), beta.movedTasks], [true, ["gemini", "ollama"], ["commentary", "concepts"]]);
  assert.deepEqual(beta.settings.tasks.commentary, { provider: "claude-cli", model: "sonnet", effort: "medium" });
  assert.deepEqual(beta.settings.tasks.concepts, { provider: "claude-cli", model: "haiku", effort: "low" });
  assert.deepEqual(beta.settings.tasks.verification, { provider: "codex-cli", model: "gpt-5.6-luna", effort: "high" }, "a CLI task is kept");
  // No logged-in Claude CLI but Codex installed: the Claude tasks move to Codex.
  assert.equal(m.chooseCli(true, true), "claude-cli");
  assert.equal(m.chooseCli(false, true), "codex-cli");
  assert.equal(m.chooseCli(false, false), null);
  // A task the user set to the Claude CLI is not in movedTasks and never moves.
  beta.settings.tasks.alignment = { provider: "claude-cli", model: "haiku", effort: "low" };
  m.moveClaudeTasksToCodex(beta.settings, beta.movedTasks);
  assert.deepEqual(beta.settings.tasks.commentary, { provider: "codex-cli", model: "", effort: "medium" });
  assert.deepEqual(beta.settings.tasks.concepts, { provider: "codex-cli", model: "", effort: "low" });
  assert.deepEqual(beta.settings.tasks.alignment, { provider: "claude-cli", model: "haiku", effort: "low" }, "an explicit Claude task stays");
  const mixed = m.migrateSettings({ settingsVersion: 2, tasks: { commentary: { provider: "claude-cli", model: "opus", effort: "high" }, concepts: { provider: "gemini", model: "", effort: "" } } });
  assert.deepEqual(mixed.movedTasks, ["concepts"], "only the task moved off Gemini");
  m.moveClaudeTasksToCodex(mixed.settings, mixed.movedTasks);
  assert.deepEqual(mixed.settings.tasks.commentary, { provider: "claude-cli", model: "opus", effort: "high" });
  assert.equal(mixed.settings.tasks.concepts.provider, "codex-cli");
  // Notices: Ollama users are told their lecture text now goes to a cloud CLI.
  assert.match(m.removedProviderMessage(["ollama"], "claude-cli"), /Ollama 지원이 끝났습니다.*Claude CLI로 옮겼습니다.*클라우드/);
  assert.doesNotMatch(m.removedProviderMessage(["gemini"], "codex-cli"), /클라우드/);
  assert.match(m.removedProviderMessage(["gemini", "ollama"], null), /Gemini API와 Ollama 지원이 끝났습니다.*설치하고 로그인/);

  // Before version 3 an empty model or effort meant "whatever the CLI uses": filled with the task default once.
  const empty = m.migrateSettings({
    settingsVersion: 2,
    tasks: {
      commentary: { provider: "claude-cli", model: "", effort: "" },
      concepts: { provider: "claude-cli", model: "", effort: "" },
      alignment: { provider: "none", model: "", effort: "" },
      verification: { provider: "codex-cli", model: "", effort: "" },
    },
  });
  assert.deepEqual([empty.needsCliDefault, empty.removedFrom], [false, []]);
  assert.deepEqual(m.describeFilled(empty.filled), ["슬라이드 해설: 모델 sonnet, effort medium", "개념 추출: 모델 haiku, effort low", "노트 검증: effort medium"], "the user is told what changed");
  assert.deepEqual(empty.settings.tasks.commentary, { provider: "claude-cli", model: "sonnet", effort: "medium" });
  assert.deepEqual(empty.settings.tasks.concepts, { provider: "claude-cli", model: "haiku", effort: "low" });
  assert.deepEqual(empty.settings.tasks.verification, { provider: "codex-cli", model: "", effort: "medium" });
  assert.deepEqual(empty.settings.tasks.alignment, { provider: "none", model: "", effort: "" });
  // From version 3 on, "" is the explicit "CLI 기본값" choice and stays.
  const chosen = JSON.parse(JSON.stringify(empty.settings));
  chosen.tasks.commentary = { provider: "claude-cli", model: "", effort: "" };
  const again = m.migrateSettings(chosen);
  assert.deepEqual([again.needsCliDefault, again.removedFrom, again.filled], [false, [], []], "version 3 data is not migrated twice");
  assert.deepEqual(again.settings.tasks.commentary, { provider: "claude-cli", model: "", effort: "" });
  assert.deepEqual(m.defaultTaskSetting("claude-cli", "alignment"), { provider: "claude-cli", model: "haiku", effort: "low" });
  assert.deepEqual(m.defaultTaskSetting("none", "alignment"), { provider: "none", model: "", effort: "" });

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
  // Review L9: unsafe saved values are dropped; unknown providers fall back to the default.
  const bad = m.migrateSettings({
    settingsVersion: 3,
    tasks: { commentary: { provider: "claude-cli", model: "--dangerously-skip-permissions", effort: "ultra; rm" }, concepts: { provider: "evil", model: "haiku", effort: "low" } },
    recentModels: { "claude-cli": ["sonnet", "-x"], gemini: ["gemini-2.5-flash"] },
  }).settings;
  assert.deepEqual(bad.tasks.commentary, { provider: "claude-cli", model: "", effort: "" });
  assert.equal(bad.tasks.concepts.provider, "claude-cli");
  assert.deepEqual(bad.recentModels, { "claude-cli": ["sonnet"] }, "recent models only for the CLI providers");
  assert.ok(m.isSafeModelName("claude-sonnet-4-5[1m]") && m.isSafeModelName("gpt-5.6-luna") && !m.isSafeModelName("-m") && !m.isSafeModelName("a b"));
  // Model dropdowns: Claude aliases, Codex ids from its models cache (visible ones, by priority), recent and current values, CLI default.
  const cache = JSON.stringify({ models: [
    { slug: "gpt-6-sol", visibility: "list", priority: 3 },
    { slug: "gpt-reserve", visibility: "hide", priority: 1 },
    { slug: "gpt-6-astra", visibility: "list", priority: 2 },
    { slug: "-bad", visibility: "list", priority: 0 },
    { display_name: "no slug" },
  ] });
  assert.deepEqual(m.parseCodexModelsCache(cache), ["gpt-6-astra", "gpt-6-sol"]);
  assert.deepEqual(m.parseCodexModelsCache("not json"), []);
  const withLevels = m.parseCodexModels(JSON.stringify({ models: [
    { slug: "gpt-6-luna", visibility: "list", priority: 4, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }] },
    { slug: "gpt-5.5", visibility: "list", priority: 13, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "ultra" }] },
  ] }));
  assert.deepEqual(withLevels.efforts["gpt-5.5"], ["low", "medium", "high", "xhigh"], "levels outside the plugin's list are dropped");
  assert.deepEqual(m.effortChoices("codex-cli", "gpt-5.5", "medium", withLevels), ["", "low", "medium", "high", "xhigh"], "only what that Codex model lists");
  assert.deepEqual(m.effortChoices("codex-cli", "gpt-5.5", "max", withLevels), ["", "low", "medium", "high", "xhigh", "max"], "the saved value stays visible");
  assert.deepEqual(m.effortChoices("codex-cli", "", "", withLevels), m.EFFORT_LEVELS, "CLI default model: every level");
  assert.deepEqual(m.effortChoices("claude-cli", "sonnet", "", withLevels), m.EFFORT_LEVELS);
  assert.deepEqual(m.parseCodexModelsCache("{}"), []);
  // Claude model dropdown: versioned models with names and ids, then the aliases with what they stand for now, then older models.
  const noCatalog = { claude: [], codex: { models: [], efforts: {} }, resolved: {} };
  const claudeValues = m.modelChoices("claude-cli", "sonnet", [], noCatalog).map((c) => c.value);
  assert.deepEqual(claudeValues, ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "fable", "opus", "sonnet", "haiku", "claude-sonnet-5", ""], "built-in list without Claude Code's catalog");
  const labels = Object.fromEntries(m.modelChoices("claude-cli", "", [], noCatalog).map((c) => [c.value, c.label]));
  assert.equal(labels["claude-opus-5-5"], "Opus 5.5 (claude-opus-5-5)");
  assert.equal(labels["claude-haiku-4-5-20251001"], "Haiku 4.5 (claude-haiku-4-5-20251001)");
  assert.equal(labels.opus, "opus (최신 Opus, 현재 Opus 5.5)", "an alias with its checked target");
  assert.equal(labels.fable, "fable (최신 Fable, 현재 Fable 5.1)");
  assert.match(labels[""], /CLI 기본값/);
  // A run recorded what an alias resolved to: that wins over the checked mapping.
  const seen = { ...noCatalog, resolved: { "claude-cli:opus": { id: "claude-opus-6", at: "2026-11-01" } } };
  assert.equal(m.modelLabel("claude-cli", "opus", seen), "opus (최신 Opus, 현재 claude-opus-6)");
  assert.equal(m.aliasTarget("opus", seen), "claude-opus-6");
  assert.deepEqual(m.modelChoices("claude-cli", "claude-sonnet-4-5", ["my-model"], noCatalog).map((c) => c.value).slice(-3), ["my-model", "claude-sonnet-4-5", ""], "recent and current custom ids are listed");
  // Claude Code's own catalog cache (~/.claude/cache/model-catalog): names, sections, effort options.
  const catalogJson = JSON.stringify({ version: 2, catalog: { surface: "cc", config: { models: [
    { id: "claude-sonnet-5", name: "Sonnet 5", section: "overflow", thinking: { type: "effort", effort_options: [{ id: "low" }, { id: "high" }] } },
    { id: "claude-opus-5-5", name: "Opus 5.5", description: "For complex work", section: "main", thinking: { type: "effort", effort_options: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }, { id: "ultra" }] } },
    { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", section: "main", thinking: { type: "none" } },
    { id: "-bad", name: "x", section: "main" },
  ] } } });
  const claude = m.parseClaudeModelCatalog(catalogJson);
  assert.deepEqual(claude.map((x) => [x.id, x.name, !!x.older]), [["claude-opus-5-5", "Opus 5.5", false], ["claude-haiku-4-5-20251001", "Haiku 4.5", false], ["claude-sonnet-5", "Sonnet 5", true]], "current first, unsafe ids dropped");
  assert.deepEqual(claude[0].efforts, ["low", "medium", "high", "xhigh", "max"], "levels outside the plugin's list are dropped");
  assert.deepEqual(claude[1].efforts, [], "a model without effort");
  assert.deepEqual(m.parseClaudeModelCatalog("nope"), []);
  const cat = { claude, codex: { models: [], efforts: {} }, resolved: {} };
  assert.deepEqual(m.modelChoices("claude-cli", "", [], cat).map((c) => c.value), ["claude-opus-5-5", "claude-haiku-4-5-20251001", "fable", "opus", "sonnet", "haiku", "claude-sonnet-5", ""]);
  assert.equal(m.modelChoices("claude-cli", "", [], cat)[0].title, "For complex work", "the description is the tooltip");
  assert.deepEqual(m.effortChoices("claude-cli", "claude-haiku-4-5-20251001", "low", cat), ["", "low"], "Haiku lists no effort: only the CLI default and the saved value");
  assert.deepEqual(m.effortChoices("claude-cli", "haiku", "", cat), [""], "an alias uses its target's levels");
  assert.deepEqual(m.effortChoices("claude-cli", "claude-sonnet-5", "", cat), ["", "low", "high"]);
  assert.deepEqual(m.effortChoices("claude-cli", "", "", cat), m.EFFORT_LEVELS, "CLI default model: every level");
  // Codex names and descriptions from its cache.
  const codexCat = { ...noCatalog, codex: m.parseCodexModels(JSON.stringify({ models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier intelligence.", visibility: "list", priority: 2 }, { slug: "gpt-6-luna", visibility: "list", priority: 4 }] })) };
  const codexChoices = m.modelChoices("codex-cli", "", [], codexCat);
  assert.deepEqual(codexChoices.map((c) => [c.value, c.label, c.title]), [["gpt-6-astra", "GPT-6-Astra (gpt-6-astra)", "Frontier intelligence."], ["gpt-6-luna", "gpt-6-luna", undefined], ["", "CLI 기본값 (Codex 기본 모델)", undefined]]);
  assert.deepEqual(m.modelChoices("codex-cli", "", [], ["gpt-6-astra"]).map((c) => c.value), ["gpt-6-astra", ""], "a plain id list still works");
  assert.equal(m.describeModel("claude-cli", "", noCatalog), "CLI 기본 모델");
  assert.equal(m.describeModel("claude-cli", "claude-sonnet-5-5", noCatalog), "Sonnet 5.5 (claude-sonnet-5-5)");
  assert.equal(m.describeDefault("claude-cli", "concepts"), "haiku · effort low");
  assert.equal(m.describeDefault("codex-cli", "commentary"), "CLI 기본 모델 · effort medium");
  assert.equal(m.describeDefault("none", "alignment"), "");
  console.log("PASS: settings migration (Gemini/Ollama tasks to a CLI, empty model/effort to task defaults once), presets, recent models, unsafe values dropped");
}

// ---- key diagram selection and embed (spec 4.8) ----
{
  const info = (page, kind, imageRatio, extra = {}) => ({ page, hash: "00000000", textChars: 100, imageRatio, kind, dupOf: null, sendImage: false, title: "", imageSignal: null, ...extra });
  const slides = [
    info(1, "cover", 0.6),
    info(2, "visual", 0.35),
    info(3, "content", 0.1),
    info(4, "visual", 0.9, { dupOf: 5 }),
    info(5, "visual", 0.9),
    info(6, "visual", 0.1, { textChars: 10 }),
    info(7, "visual", null),
    ...Array.from({ length: 10 }, (_, k) => info(8 + k, "visual", 0.4 + k * 0.01)),
  ];
  const picked = m.selectKeyDiagrams(slides, false);
  assert.equal(picked.length, m.MAX_KEY_DIAGRAMS);
  assert.ok(picked.includes(5) && !picked.includes(4) && !picked.includes(1) && !picked.includes(6) && !picked.includes(7) && !picked.includes(2));
  assert.deepEqual(picked, [...picked].sort((a, b) => a - b), "deck order");
  assert.deepEqual(m.selectKeyDiagrams(slides, true), [], "scanned PDF: no diagrams");
  // The embed sits inside the managed block and is stripped when the body is reused.
  const embed = m.formatDiagramEmbed("A/S/Attachments/lec-5.png");
  assert.equal(embed, "![[A/S/Attachments/lec-5.png]]");
  const managed = `해설 본문 [[캐시]]\n\n${embed}\n\n${m.formatSlideMeta(null, "요지")}`;
  const note = `---\ntitle: x\n---\n# x\n\n## 📚 슬라이드 5\n\n<!-- alt2obs:slide:5 hash:abcdef12 start -->\n${managed}\n<!-- alt2obs:slide:5 hash:abcdef12 end -->\n`;
  const [prev] = m.parseExistingSlides(note);
  assert.equal(prev.commentary, "해설 본문 [[캐시]]");
  assert.equal(prev.gist, "요지");
  assert.equal(m.stripDiagramEmbed("본문\n\n![[그림 설명.png]]\n"), "본문");
  assert.equal(m.stripDiagramEmbed("본문 ![[inline.png]] 뒤"), "본문 ![[inline.png]] 뒤", "only a trailing embed line");
  assert.equal(m.stripDiagramEmbed("본문\n\n![[A/S/Attachments/[OS] 3강-5.png]]"), "본문", "an older embed with brackets is stripped too");
  assert.equal(m.stripDiagramEmbed("본문 ![[x.png]]"), "본문 ![[x.png]]", "an inline embed ending a line is kept");
  const odd = m.formatDiagramEmbed("A/C#/Attachments/OS 3강-5.png");
  assert.equal(odd, "![OS 3강-5](A/C%23/Attachments/OS%203%EA%B0%95-5.png)", "a folder with # gets a Markdown image");
  assert.equal(m.stripDiagramEmbed(`본문\n\n${odd}`), "본문");
  console.log("PASS: key diagrams: visual pages by ink share, capped, no templates, build steps or scans; embed stripped from reused bodies");
}
