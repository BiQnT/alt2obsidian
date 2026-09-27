/**
 * Test: TranscriptAligner (spec 4.3) on synthetic lectures, the frontmatter
 * format, the per-slide chunks fed to the batch planner, the optional LLM
 * check (fake claude, no tokens), and the accuracy on the draft-labelled
 * lectures when their data folder is present (test/eval-alignment.mjs).
 * Run: node test/test-alignment.mjs [alignmentDataDir]
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { importTs } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, fakeSession } from "./helpers/fake-cli.mjs";

const m = await importTs("test/helpers/alignment-entry.ts");

// ---- tokenizer ----
{
  const en = m.alignTokens("The caches and the TLBs, directories");
  assert.ok(en.includes("tlb") && en.includes("directory"), `english stems: ${en}`);
  assert.deepEqual(m.alignTokens("cache caches tables table directories directory"), ["cache", "cache", "table", "table", "directory", "directory"], "plural forms share a token");
  assert.ok(!en.includes("the") && !en.includes("and"), "english stopwords dropped");
  const ko = m.alignTokens("캐시는 메모리에서 데이터를 가져옵니다 그리고 여러분");
  assert.ok(ko.includes("캐시") && ko.includes("메모리") && ko.includes("데이터"), `korean particles cut: ${ko}`);
  assert.ok(!ko.includes("그리고") && !ko.includes("여러분"), "korean stopwords dropped");
  assert.deepEqual(m.alignTokens("𝐿𝑑 language"), ["ld", "language"], "NFKC folds math letters");
  assert.ok(m.alignTokens("32 bit and 64 KB").includes("32"), "numbers kept");
  console.log("PASS: tokenizer (English stems and stopwords, Korean particles and stopwords, NFKC, numbers)");
}

// ---- synthetic lecture: forward, skip, off-topic chatter, revisit ----
const slides = [
  "Lecture 5 Virtual Memory\nProfessor Kim, Department of Computer Science",
  "Page Tables\npage table entry, valid bit, physical frame number",
  "Translation Lookaside Buffer\nTLB hit, TLB miss, associativity of the TLB",
  "Page Faults\npage fault handler, disk, swap space, eviction",
  "Replacement Policies\nLRU, FIFO, clock algorithm, Belady anomaly",
  "Wrap-up\nkey takeaways, homework five, next week: file systems",
];
// STT-like: short segments (about 5 s), several per slide.
const talk = [
  // [slide the talk is about (0 = off-topic), sentence]
  [1, "welcome to lecture five about virtual memory"],
  [1, "today virtual memory is the whole topic"],
  [0, "before we start the homework deadline moved to friday"],
  [0, "please check the course website for the new date"],
  [0, "and the midterm room is also posted there"],
  [2, "a page table maps virtual pages to physical frames"],
  [2, "each page table entry has a valid bit"],
  [2, "the entry also stores the physical frame number"],
  [2, "if the valid bit is zero the page is not in memory"],
  [2, "so the page table entry tells us where the frame is"],
  [3, "the TLB caches recent translations so a TLB hit is fast"],
  [3, "on a TLB miss we walk the page table and fill the TLB"],
  [3, "TLB associativity matters for the TLB miss rate"],
  [3, "a fully associative TLB has fewer conflicts"],
  [3, "so the TLB hit rate is usually very high"],
  // slide 4 skipped: straight to replacement
  [5, "for replacement we can use LRU or FIFO"],
  [5, "LRU evicts the least recently used page"],
  [5, "the clock algorithm approximates LRU cheaply"],
  [5, "FIFO is simple but has the Belady anomaly"],
  [5, "Belady anomaly shows FIFO can get worse with more frames"],
  [6, "to wrap up, the key takeaways are on homework five"],
  [6, "next week we start file systems, see you next week"],
];
// A closing recap of slide 3 (a revisit), used in the second case below.
const recap = [
  [3, "going back to the TLB for a moment, a TLB miss is costly"],
  [3, "the TLB associativity and TLB hit rate really matter"],
  [3, "a TLB miss means walking the page table again"],
  [3, "that is why the TLB is fully associative in many designs"],
];
// STT-like pace: a slide is discussed for about a minute (each slide
// sentence three times), off-topic lines once.
const pace = (lines) => lines.flatMap((t) => (t[0] === 0 ? [t] : [t, t, t]));
const spoken = pace(talk);
const segments = spoken.map(([, text], i) => ({ startMs: i * 5000, endMs: i * 5000 + 4800, text }));
{
  const res = m.alignTranscript(slides, segments);
  const truth = spoken.map(([s]) => s);
  const pred = res.segmentSlides;
  const labelled = truth.map((t, i) => [t, pred[i]]).filter(([t]) => t !== 0);
  const acc = labelled.filter(([t, p]) => t === p).length / labelled.length;
  assert.ok(acc >= 0.8, `accuracy ${acc} (${pred.join(",")})`);
  assert.ok(!pred.includes(4), "the skipped slide gets no segment");
  assert.deepEqual(res.spans.map((s) => s.slide), [1, 2, 3, 5, 6], "forward order, slide 4 skipped");
  assert.ok(truth.every((t, i) => t !== 0 || pred[i] <= 2), "off-topic talk does not jump ahead");
  for (const s of res.spans) assert.ok(s.confidence >= 0 && s.confidence <= 1);
  console.log(`PASS: synthetic lecture aligned (skip, off-topic), accuracy ${(acc * 100).toFixed(0)}%`);

  // Going back is allowed but costly by default (tuned on real lectures,
  // where most "revisits" by vocabulary were false). A long closing recap
  // is found with a cheaper backward move.
  const withRecap = [...spoken, ...recap.flatMap((t) => new Array(6).fill(t))];
  const recapSegs = withRecap.map(([, text], i) => ({ startMs: i * 5000, endMs: i * 5000 + 4800, text }));
  const back = m.alignTranscript(slides, recapSegs, { backCost: 1 });
  assert.deepEqual(back.spans.map((s) => s.slide), [1, 2, 3, 5, 6, 3], "the recap is a second span of slide 3");
  console.log("PASS: backward moves: a closing recap becomes a second span of the revisited slide");

  // Frontmatter round trip: spans tile the time axis, "?" marks low confidence.
  const value = m.formatAlignment(back.spans);
  const parsed = m.parseAlignment(value);
  assert.equal(parsed.length, back.spans.length);
  parsed.forEach((p, i) => {
    assert.equal(p.slide, back.spans[i].slide);
    if (i > 0) assert.equal(p.startMs, parsed[i - 1].endMs, "a span ends where the next starts");
    assert.equal(p.low, back.spans[i].confidence < m.LOW_CONFIDENCE);
  });
  assert.deepEqual(m.parseAlignment("1:0-10 bad 2:10-5 3:10-20.5?"), [
    { slide: 1, startMs: 0, endMs: 10000, low: false },
    { slide: 3, startMs: 10000, endMs: 20500, low: true },
  ]);
  // Same-second boundaries: every segment lands in exactly one span, none is lost.
  const fine = [
    { slide: 1, startMs: 0, endMs: 1200, fromSegment: 0, toSegment: 2, confidence: 0.9 },
    { slide: 2, startMs: 1300, endMs: 1900, fromSegment: 2, toSegment: 3, confidence: 0.9 },
    { slide: 3, startMs: 1950, endMs: 3000, fromSegment: 3, toSegment: 4, confidence: 0.2 },
  ];
  const fineValue = m.formatAlignment(fine);
  assert.equal(fineValue, "1:0-1.3 2:1.3-1.9 3:1.9-3?");
  const stored = m.parseAlignment(fineValue);
  for (const [start, slide] of [[0, 1], [700, 1], [1300, 2], [1950, 3]]) {
    const owners = stored.filter((sp) => m.segmentInSpan(start, sp)).map((sp) => sp.slide);
    assert.deepEqual(owners, [slide], `segment at ${start} ms`);
  }
  assert.deepEqual(m.parseAlignment(undefined), []);
  assert.equal(m.spansForSlide(parsed, 3).length, 2);
  console.log(`PASS: alt_alignment format round trip ("${value}")`);

  // Chunks: each slide's own sentences, revisits included, skipped slide null.
  const chunks = m.chunksFromAlignment(back, recapSegs, slides.length);
  assert.equal(chunks[3], null);
  assert.ok(chunks[2].includes("walk the page table") && chunks[2].includes("going back to the TLB"));
  assert.ok(!chunks[1].includes("TLB"), "no neighbour text in the page table chunk");
  console.log("PASS: per-slide chunks follow the alignment, not an even split");
}

// ---- textless slides ----
{
  // Scanned or image-only deck: no text to match, even split instead.
  const timed = segments.map((s) => ({ ...s, speaker: "" }));
  assert.equal(m.alignLecture(slides.map(() => ""), timed), null, "image-only deck");
  assert.equal(m.alignLecture(slides, timed, { scanned: true }), null, "scanned deck");
  assert.equal(m.alignLecture(["Page Tables page table entry", "", "", "", "", "Replacement LRU FIFO clock"], timed), null, "under half of the slides have text");
  // Textless slides inside a text deck share the talk that matches no slide text.
  const deck = [slides[0], slides[1], "", "   ", slides[4], slides[5]];
  // Lecture pace: about a minute per slide (5 s segments), a minute on the image slides.
  const pics = [
    [1, "welcome to lecture five about virtual memory"],
    [1, "today virtual memory is the whole topic"],
    [2, "a page table maps virtual pages to physical frames"],
    [2, "each page table entry has a valid bit"],
    ...Array.from({ length: 4 }, (_, i) => [3, `look at this picture, the arrows go from here to there, number ${i}`]),
    [5, "for replacement we can use LRU or FIFO"],
    [5, "the clock algorithm approximates LRU cheaply"],
    [6, "to wrap up, the key takeaways are on homework five"],
    [6, "next week we start file systems"],
  ];
  const picSegs = pics
    .flatMap((t) => new Array(t[0] === 3 ? 3 : 6).fill(t))
    .map(([, text], i) => ({ startMs: i * 5000, endMs: i * 5000 + 4800, text, speaker: "" }));
  const al = m.alignLecture(deck, picSegs);
  assert.ok(al, "a text deck with a few textless slides is aligned");
  assert.ok(al.chunks[2] && al.chunks[3], `both textless slides get talk: ${JSON.stringify(al.chunks.map((c) => (c ? c.slice(0, 20) : null)))}`);
  assert.ok(al.chunks[2].includes("picture") && al.chunks[3].includes("picture"));
  const onSlide2 = (al.chunks[1].match(/picture/g) ?? []).length;
  assert.ok(onSlide2 <= 3, `most unmatched talk goes to the textless slides, not the neighbour (${onSlide2} on slide 2)`);
  console.log("PASS: textless slides: scanned or mostly image-only decks fall back to the even split; textless slides in a text deck share the unmatched talk");
  // Minute-per-slide pace (5 s segments). A deck with an image slide (3).
  const deck2 = [slides[0], slides[1], "", slides[4], slides[5]];
  const run = (lines) => lines.flatMap(([t, text, times]) => new Array(times).fill([t, text]));
  const segsOf = (spoken) => spoken.map(([, text], i) => ({ startMs: i * 5000, endMs: i * 5000 + 4800, text, speaker: "" }));
  const head = [
    [1, "welcome to lecture five about virtual memory", 6],
    [2, "a page table maps virtual pages to physical frames", 6],
    [2, "each page table entry has a valid bit and a frame number", 6],
  ];
  const tail = [
    [4, "for replacement we can use LRU or FIFO", 6],
    [4, "the clock algorithm approximates LRU cheaply", 6],
    [5, "to wrap up, the key takeaways are on homework five", 6],
  ];
  // (a) Short chatter at the end of slide 2, then straight on to slide 4:
  // the image slide is skipped and the chatter stays on slide 2.
  const spokenA = run([...head, [0, "by the way the homework deadline moved to friday", 1], [0, "and the midterm room is posted", 1], ...tail]);
  const rA = m.alignLecture(deck2, segsOf(spokenA)).result.segmentSlides;
  spokenA.forEach(([t, text], i) => {
    if (t === 0) assert.equal(rA[i], 2, `chatter at the end of slide 2 stays there: "${text}" got ${rA[i]} (${rA.join(",")})`);
  });
  // (b) A minute of talk about the image slide: most of it goes to the image slide.
  const spokenB = run([...head, ...Array.from({ length: 4 }, (_, i) => [3, `now look at this picture, the arrows go from here to there, part ${i}`, 3]), ...tail]);
  const rB = m.alignLecture(deck2, segsOf(spokenB)).result.segmentSlides;
  const imageTalk = spokenB.map(([t], i) => [t, rB[i]]).filter(([t]) => t === 3);
  // The 15 s scoring window lets both neighbours pull the edge lines; at least half go to the image slide.
  assert.ok(imageTalk.filter(([, p]) => p === 3).length * 2 >= imageTalk.length, `talk during the image slide goes to it (${rB.join(",")})`);
  console.log("PASS: short chatter at the end of a slide before a skipped image slide stays on that slide; a minute of talk during an image slide goes to it");
}

// ---- Korean talk over English slides (sparse overlap) ----
{
  // Most segments share no token with their slide. Text-slide accuracy must
  // not drop below the aligner before image-slide handling (commit 5ebb1ea's
  // parent measured 52.5% here; 5ebb1ea itself dropped to 50.0%).
  const koDeck = [
  "Lecture 6 Indexing\nDatabase Systems, Department of Computer Science",
  "B+ Tree Structure\nroot node, internal node, leaf node, fanout, balanced height",
  "B+ Tree Search\nsearch key, traverse from root to leaf, logarithmic cost",
  "",
  "B+ Tree Insertion\nsplit a full leaf, push up the separator key, root split",
  "B+ Tree Deletion\nmerge underfull nodes, redistribute entries, occupancy",
  "Hash Index\nhash function, bucket, overflow chain, static hashing",
  "Extendible Hashing\ndirectory, global depth, local depth, bucket split",
  "Summary\nindex choice, range query, equality query",
];
  const koTalk = [
  [1, "자 오늘은 인덱싱 얘기를 해볼게요"],
  [1, "지난 시간에 이어서 계속 가겠습니다"],
  [2, "비플러스 트리는 root 부터 시작하는 구조예요"],
  [2, "중간에 있는 노드들은 이렇게 연결돼 있고요"],
  [2, "leaf 에는 실제 데이터 포인터가 들어갑니다"],
  [2, "그래서 높이가 항상 균형이 맞아요"],
  [3, "검색할 때는 위에서부터 내려갑니다"],
  [3, "search key 를 비교하면서 한 칸씩 가요"],
  [3, "비용은 로그 스케일이라 빠르죠"],
  [4, "이 그림을 보시면 화살표가 이렇게 가요"],
  [4, "여기서 저기로 넘어가는 거 보이시죠"],
  [5, "삽입할 때 꽉 차 있으면 쪼개야 돼요"],
  [5, "split 하고 나서 가운데 값을 위로 올립니다"],
  [5, "루트까지 올라가면 높이가 하나 늘어나요"],
  [6, "삭제는 반대로 합치는 거예요"],
  [6, "merge 가 안 되면 옆에서 빌려옵니다"],
  [7, "해시 인덱스는 좀 다른 방식이에요"],
  [7, "hash function 으로 bucket 을 찾아요"],
  [7, "넘치면 overflow 로 이어 붙이고요"],
  [8, "확장 해싱은 디렉터리를 두 배로 늘려요"],
  [8, "global depth 랑 local depth 를 비교합니다"],
  [9, "정리하면 상황에 맞게 고르시면 됩니다"],
];
  const spokenKo = koTalk.flatMap((t) => new Array(6).fill(t));
  const segsKo = spokenKo.map(([, text], i) => ({ startMs: i * 5000, endMs: i * 5000 + 4800, text }));
  const pKo = m.alignTranscript(koDeck, segsKo).segmentSlides;
  const onText = spokenKo.map(([t], i) => [t, pKo[i]]).filter(([t]) => koDeck[t - 1].trim());
  const accKo = onText.filter(([t, p]) => t === p).length / onText.length;
  assert.ok(accKo >= 0.525, );
  console.log();
}

// ---- Korean talk over English slides (sparse overlap) ----
{
  // Most segments share no token with their slide. Text-slide accuracy must
  // not drop below the aligner before image-slide handling (commit 5ebb1ea's
  // parent measured 52.5% here; 5ebb1ea itself dropped to 50.0%).
  const koDeck = [
    "Lecture 6 Indexing\nDatabase Systems, Department of Computer Science",
    "B+ Tree Structure\nroot node, internal node, leaf node, fanout, balanced height",
    "B+ Tree Search\nsearch key, traverse from root to leaf, logarithmic cost",
    "",
    "B+ Tree Insertion\nsplit a full leaf, push up the separator key, root split",
    "B+ Tree Deletion\nmerge underfull nodes, redistribute entries, occupancy",
    "Hash Index\nhash function, bucket, overflow chain, static hashing",
    "Extendible Hashing\ndirectory, global depth, local depth, bucket split",
    "Summary\nindex choice, range query, equality query",
  ];
  const koTalk = [
    [1, "자 오늘은 인덱싱 얘기를 해볼게요"],
    [1, "지난 시간에 이어서 계속 가겠습니다"],
    [2, "비플러스 트리는 root 부터 시작하는 구조예요"],
    [2, "중간에 있는 노드들은 이렇게 연결돼 있고요"],
    [2, "leaf 에는 실제 데이터 포인터가 들어갑니다"],
    [2, "그래서 높이가 항상 균형이 맞아요"],
    [3, "검색할 때는 위에서부터 내려갑니다"],
    [3, "search key 를 비교하면서 한 칸씩 가요"],
    [3, "비용은 로그 스케일이라 빠르죠"],
    [4, "이 그림을 보시면 화살표가 이렇게 가요"],
    [4, "여기서 저기로 넘어가는 거 보이시죠"],
    [5, "삽입할 때 꽉 차 있으면 쪼개야 돼요"],
    [5, "split 하고 나서 가운데 값을 위로 올립니다"],
    [5, "루트까지 올라가면 높이가 하나 늘어나요"],
    [6, "삭제는 반대로 합치는 거예요"],
    [6, "merge 가 안 되면 옆에서 빌려옵니다"],
    [7, "해시 인덱스는 좀 다른 방식이에요"],
    [7, "hash function 으로 bucket 을 찾아요"],
    [7, "넘치면 overflow 로 이어 붙이고요"],
    [8, "확장 해싱은 디렉터리를 두 배로 늘려요"],
    [8, "global depth 랑 local depth 를 비교합니다"],
    [9, "정리하면 상황에 맞게 고르시면 됩니다"],
  ];
  const spokenKo = koTalk.flatMap((t) => new Array(6).fill(t));
  const segsKo = spokenKo.map(([, text], i) => ({ startMs: i * 5000, endMs: i * 5000 + 4800, text }));
  const pKo = m.alignTranscript(koDeck, segsKo).segmentSlides;
  const onText = spokenKo.map(([t], i) => [t, pKo[i]]).filter(([t]) => koDeck[t - 1].trim());
  const accKo = onText.filter(([t, p]) => t === p).length / onText.length;
  assert.ok(accKo >= 0.525, `text-slide accuracy ${(accKo * 100).toFixed(1)}% (${pKo.join(",")})`);
  console.log(`PASS: Korean talk over English slides: text-slide accuracy ${(accKo * 100).toFixed(1)}% (not below the pre-5ebb1ea 52.5%)`);
}

// ---- alignLecture: timestamps required ----
{
  const timed = segments.map((s) => ({ ...s, speaker: "" }));
  assert.ok(m.alignLecture(slides, timed));
  assert.equal(m.alignLecture(slides, timed.map((s) => ({ ...s, startMs: null, endMs: null }))), null, "URL source: even split");
  assert.equal(m.alignLecture(slides, []), null);
  assert.equal(m.alignLecture([], timed), null);
  // Joined components are sorted; an untimed segment keeps its text on a slide.
  const mixed = [...timed.slice(11).reverse(), ...timed.slice(0, 10), { ...timed[10], startMs: null, endMs: null, text: "untimed line" }];
  const fixed = m.timedSegments(mixed);
  assert.equal(fixed.length, timed.length);
  assert.ok(fixed.every((x, i) => i === 0 || x.startMs >= fixed[i - 1].startMs), "sorted by time");
  assert.ok(fixed.some((x) => x.text === "untimed line"), "untimed text kept");
  assert.equal(m.alignmentStatus(true, true), "전사 타임스탬프 있음 · 슬라이드에 자동 정렬");
  assert.equal(m.alignmentStatus(false, true), "전사 타임스탬프 없음 · 균등 분할");
  console.log("PASS: alignment runs only with timestamps; the status line says which");
}

// ---- planDeck uses the aligned chunks ----
{
  const layouts = slides.map((t) => ({ text: t.replace(/\n/g, ""), boxes: [], lines: t.split("\n") }));
  const analysis = await m.analyzeSlides(layouts, layouts.map(() => null), { sourceId: "local-1" });
  const al = m.alignLecture(layouts.map(m.layoutAlignmentText), segments.map((s) => ({ ...s, speaker: "" })));
  const plan = m.planDeck({ ...analysis, layouts, transcript: segments.map((s) => s.text).join("\n"), transcriptChunks: al.chunks, transcriptCapChars: 2000, batchSize: 8, deckTitle: "L5" });
  const p3 = plan.slides.find((s) => s.page === 3);
  assert.ok(p3.transcript.includes("TLB") && !p3.transcript.includes("Belady"), `slide 3 transcript: ${p3.transcript}`);
  const even = m.planDeck({ ...analysis, layouts, transcript: segments.map((s) => s.text).join("\n"), transcriptCapChars: 2000, batchSize: 8, deckTitle: "L5" });
  assert.notEqual(even.slides[2].transcript, p3.transcript, "even split differs");
  const swapped = m.withTranscriptChunks(plan, al.chunks.map((c, i) => (i === 2 ? "replacement text for slide three." : c)), 2000);
  assert.equal(swapped.slides[2].transcript, "replacement text for slide three.");
  assert.deepEqual(swapped.batches, plan.batches);
  console.log("PASS: planDeck takes the aligned chunks; withTranscriptChunks swaps them after a check");
}

// ---- optional LLM check (fake claude) ----
{
  const s = fakeSession("ok");
  const job = m.createJobDir();
  try {
    // Weak evidence everywhere: every span is low confidence.
    const vague = segments.map((x, i) => ({ ...x, text: i % 2 ? "okay so yes" : "right, let us continue" }));
    const al = m.alignLecture(slides, vague.map((x) => ({ ...x, speaker: "" })));
    assert.ok(al.lowSpans.length > 0);
    const prompt = m.buildAlignmentCheckPrompt("L5", al, slides);
    assert.ok(prompt.includes("[part 1] current guess") && prompt.includes("candidates:"));
    const usage = new m.UsageTracker();
    const llm = new m.ClaudeCliProvider({ bin: FAKE_CLAUDE, model: "haiku", effort: "low", timeoutMs: 20000, workDir: job, usage, task: "alignment", ownsWorkDir: false });
    const checked = await m.checkAlignmentWithLlm(llm, "L5", al, slides);
    assert.equal(s.calls().length, 1, "one call for all uncertain spans");
    assert.ok(checked.llmChanged > 0, "the check moved spans");
    assert.notEqual(checked.value, al.value);
    assert.equal(usage.total().calls, 1);
    // Nothing uncertain: no call.
    const sure = m.alignLecture(slides, segments.map((x) => ({ ...x, speaker: "" })));
    const noLow = { ...sure, lowSpans: [] };
    assert.equal(await m.checkAlignmentWithLlm(llm, "L5", noLow, slides), noLow);
    assert.equal(s.calls().length, 1);
    console.log(`PASS: the alignment check sends the uncertain spans in one call and applies the answer (${checked.llmChanged} moved)`);
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- accuracy on the draft labels (only with the lecture data) ----
{
  const dataDir = process.argv[2] || process.env.ALT2OBS_ALIGN_DATA;
  if (dataDir && existsSync(dataDir)) {
    const { evaluate } = await import("./eval-alignment.mjs");
    const rows = await evaluate(dataDir);
    for (const r of rows) {
      assert.ok(r.aligner > r.even, `${r.lecture}: aligner ${r.aligner} must beat the even split ${r.even}`);
      console.log(`PASS: ${r.lecture} (draft labels): aligner ${(r.aligner * 100).toFixed(1)}% vs even split ${(r.even * 100).toFixed(1)}%`);
    }
  } else {
    console.log("INFO: draft-label accuracy not run here (lecture data is the user's own and not committed; pass its folder or set ALT2OBS_ALIGN_DATA)");
  }
}
