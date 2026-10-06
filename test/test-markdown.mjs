/**
 * Test: concept wikilink insertion and heading demotion (src/core/markdown.ts).
 * Run: node test/test-markdown.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";

const { linkConceptNames, demoteHeadings, buildOverviewSection } = await importTs("src/core/markdown.ts");
const cn = await importTs("src/core/conceptNames.ts");

const names = ["캐시", "캐시 일관성 (Cache Coherence)"];

// Longest name wins; the shorter name is not linked inside it.
assert.equal(
  linkConceptNames("캐시 일관성 (Cache Coherence)은 여러 캐시가 같은 값을 보게 한다.", names),
  "[[캐시 일관성 (Cache Coherence)]]은 여러 [[캐시]]가 같은 값을 보게 한다."
);
// Existing wikilinks (including aliased ones) are left alone, and a concept already linked is not linked again.
assert.equal(
  linkConceptNames("[[캐시 일관성 (Cache Coherence)]]와 [[캐시|cache]], 그리고 캐시", names),
  "[[캐시 일관성 (Cache Coherence)]]와 [[캐시|cache]], 그리고 캐시"
);
// Case-insensitive match, written with the canonical name; only the first mention is linked.
assert.equal(linkConceptNames("TLB and tlb", ["TLB"]), "[[TLB]] and tlb");
// `$` in a name is literal, regex metacharacters are escaped.
assert.equal(linkConceptNames("cost $& and a+b", ["$&", "a+b"]), "cost [[$&]] and [[a+b]]");
// No names: unchanged.
assert.equal(linkConceptNames("캐시", []), "캐시");

// 2.0.0-beta.5 names "English (한국어)": prose writes the English term; the link targets the note.
const newStyle = ["Lottery Scheduling (로터리 스케줄링)", "Stride Scheduling (스트라이드 스케줄링)", "Stride (스트라이드)"];
assert.equal(
  linkConceptNames("Lottery Scheduling은 ticket을 뽑습니다. lottery scheduling은 또 나옵니다.", newStyle),
  "[[Lottery Scheduling (로터리 스케줄링)|Lottery Scheduling]]은 ticket을 뽑습니다. lottery scheduling은 또 나옵니다.",
  "first mention only, the alias keeps the text as written"
);
assert.equal(
  linkConceptNames("Stride Scheduling은 `stride`를 씁니다. stride 값과 strides.", newStyle),
  "[[Stride Scheduling (스트라이드 스케줄링)|Stride Scheduling]]은 `stride`를 씁니다. [[Stride (스트라이드)|stride]] 값과 strides.",
  "longer term first; code spans untouched; an English term needs word boundaries"
);
assert.equal(
  linkConceptNames("Ticket Currency는 ticket을 나눕니다.", ["티켓 (Ticket)"]),
  "Ticket Currency는 [[티켓 (Ticket)|ticket]]을 나눕니다.",
  "a part that starts a longer capitalized term is not linked; the next mention is"
);
assert.equal(
  linkConceptNames("Lottery Scheduling은 Scheduling의 한 방식입니다.", ["Scheduling (스케줄링)"]),
  "Lottery Scheduling은 [[Scheduling (스케줄링)|Scheduling]]의 한 방식입니다.",
  "nor a part that ends one"
);
assert.equal(
  linkConceptNames("페이지 테이블 엔트리와 트리를 비교합니다.", ["Tree (트리)"]),
  "페이지 테이블 엔트리와 [[Tree (트리)|트리]]를 비교합니다.",
  "a Korean term does not start inside a word"
);
assert.equal(linkConceptNames("트리는 균형을 맞춥니다.", ["Tree (트리)"]), "[[Tree (트리)|트리]]는 균형을 맞춥니다.", "particles after it still match");
assert.equal(
  linkConceptNames(
    "https://en.wikipedia.org/wiki/Paging 와 [Paging 문서](https://x.org/Paging), ![Paging](p.png), $\\text{Paging}_i$, <span title=\"Paging\">, 각주[^Paging], ``a ` Paging`` 다음에 Paging",
    ["Paging (페이징)"]
  ),
  "https://en.wikipedia.org/wiki/Paging 와 [Paging 문서](https://x.org/Paging), ![Paging](p.png), $\\text{Paging}_i$, <span title=\"Paging\">, 각주[^Paging], ``a ` Paging`` 다음에 [[Paging (페이징)|Paging]]",
  "URLs, Markdown links and images, math, HTML tags, footnotes and double-backtick code are never linked"
);
assert.equal(
  linkConceptNames("| 방식 | 설명 |\n|---|---|\n| Lottery Scheduling | 무작위 |\n> | Stride | 결정적 |", newStyle),
  "| 방식 | 설명 |\n|---|---|\n| [[Lottery Scheduling (로터리 스케줄링)\\|Lottery Scheduling]] | 무작위 |\n> | [[Stride (스트라이드)\\|Stride]] | 결정적 |",
  "inside a table row (also in a callout) the alias pipe is escaped"
);
assert.equal(linkConceptNames("```\nLottery Scheduling\n```\n그리고 로터리 스케줄링.", newStyle), "```\nLottery Scheduling\n```\n그리고 [[Lottery Scheduling (로터리 스케줄링)|로터리 스케줄링]].", "fenced code untouched; the Korean part links too");
// An older note "한국어 (English)": the English term in prose links to that note, and a link in either order counts as linked.
const oldStyle = ["로터리 스케줄링 (Lottery Scheduling)"];
assert.equal(linkConceptNames("Lottery Scheduling은 무작위입니다.", oldStyle), "[[로터리 스케줄링 (Lottery Scheduling)|Lottery Scheduling]]은 무작위입니다.");
assert.equal(
  linkConceptNames("[[로터리 스케줄링 (Lottery Scheduling)|Lottery Scheduling]]과 Lottery Scheduling", ["Lottery Scheduling (로터리 스케줄링)"]),
  "[[Lottery Scheduling (로터리 스케줄링)|Lottery Scheduling]]과 Lottery Scheduling",
  "a link in the other order points at the given name and counts as linked"
);
assert.equal(linkConceptNames("[[Lottery Scheduling (로터리 스케줄링)\\|LS]] | Lottery Scheduling", oldStyle), "[[로터리 스케줄링 (Lottery Scheduling)\\|LS]] | Lottery Scheduling", "a table alias link is pointed at the note and counts as linked");

// Concept names: both orders are one concept, matched on either part.
assert.deepEqual(cn.parseConceptName("Lottery Scheduling (로터리 스케줄링)"), { full: "Lottery Scheduling (로터리 스케줄링)", english: "Lottery Scheduling", korean: "로터리 스케줄링", aliases: ["Lottery Scheduling"] });
assert.deepEqual(cn.parseConceptName("로터리 스케줄링 (Lottery Scheduling)"), { full: "로터리 스케줄링 (Lottery Scheduling)", english: "Lottery Scheduling", korean: "로터리 스케줄링", aliases: ["Lottery Scheduling"] });
assert.deepEqual(cn.parseConceptName("MESI 프로토콜 (MESI Protocol)"), { full: "MESI 프로토콜 (MESI Protocol)", english: "MESI Protocol", korean: "MESI 프로토콜", aliases: ["MESI Protocol"] });
assert.deepEqual(cn.parseConceptName("TLB"), { full: "TLB", english: "TLB", korean: null, aliases: ["TLB"] });
assert.deepEqual(cn.parseConceptName("fork()"), { full: "fork()", english: "fork()", korean: null, aliases: ["fork()"] });
assert.deepEqual(cn.parseConceptName("PTE (Page Table Entry)"), { full: "PTE (Page Table Entry)", english: "PTE", korean: null, aliases: ["PTE", "Page Table Entry"] }, "an acronym and its expansion are both names");
assert.deepEqual(cn.parseConceptName("Mutator (Operation)").aliases, ["Mutator (Operation)"], "a qualifier is not a second name");
assert.ok(cn.sameConcept("Write-Back Cache.", "Write-Back Cache"), "a trailing dot is dropped like in the file name");
assert.ok(cn.sameConcept("Lottery Scheduling (로터리 스케줄링)", "로터리 스케줄링 (Lottery Scheduling)"), "either order");
assert.ok(cn.sameConcept("lottery-scheduling (로터리스케줄링)", "로터리 스케줄링 (Lottery Scheduling)"), "case, spaces and hyphens ignored");
assert.ok(cn.sameConcept("Lottery Scheduling", "로터리 스케줄링 (Lottery Scheduling)"), "the English part alone");
assert.ok(cn.sameConcept("Ticket (추첨권)", "티켓 (Ticket)"), "the same English part with another Korean name");
assert.ok(cn.sameConcept("로터리 스케줄링", "Lottery Scheduling (로터리 스케줄링)"), "the Korean part alone");
assert.ok(cn.sameConcept("Context Switch (문맥 교환)", "문맥 교환 (Context Switching)"), "the same Korean part, English one word form apart");
assert.ok(!cn.sameConcept("Latency (지연)", "Delay (지연)"), "the same Korean part but plainly different English parts: two concepts");
assert.deepEqual(cn.normalizeConcepts([{ name: "Latency (지연)", definition: "a", relatedConcepts: ["delay"] }, { name: "Delay (지연)", definition: "b", relatedConcepts: [] }], ["지연 (Latency)"]).map((c) => [c.name, c.definition, c.relatedConcepts]), [["지연 (Latency)", "a", ["Delay (지연)"]], ["Delay (지연)", "b", []]], "neither merged into the other");
assert.ok(cn.sameConcept("I/O Scheduling (입출력 스케줄링)", "IO 스케줄링 (IO Scheduling)"), "a file name without the slash");
assert.ok(!cn.sameConcept("Stride (스트라이드)", "Stride Scheduling (스트라이드 스케줄링)"));
assert.equal(cn.findSameConcept("Lottery Scheduling (로터리 스케줄링)", ["캐시 (Cache)", "로터리 스케줄링 (Lottery Scheduling)"]), "로터리 스케줄링 (Lottery Scheduling)");
assert.equal(cn.findSameConcept("Context Switch (문맥 교환)", ["캐시 (Cache)"]), null);
const { ConceptRegistry } = await importTs("src/vault/ConceptRegistry.ts");
const reg = new ConceptRegistry();
assert.ok(reg.acquire("Lottery Scheduling (로터리 스케줄링)"));
assert.ok(!reg.acquire("로터리 스케줄링 (Lottery Scheduling)"), "the same concept in the other order is pending");
assert.ok(reg.has("lottery scheduling") && reg.acquire("Stride (스트라이드)"));
assert.ok(reg.acquire("Latency (지연)") && reg.acquire("Delay (지연)"), "two concepts with one Korean name can both be written");
reg.release("Lottery Scheduling (로터리 스케줄링)");
assert.ok(!reg.has("로터리 스케줄링") && reg.acquire("로터리 스케줄링 (Lottery Scheduling)"));
console.log("PASS: concept names in either order are one concept (English or Korean part), also while being written");
console.log("PASS: linkConceptNames (first mention, either name part, longest first, skips existing links and code, literal $)");

assert.equal(
  demoteHeadings("# A\n## B\n###### F\n#no-heading\n```\n## in code\n```\n~~~\n# tilde\n~~~\n### C"),
  "## A\n### B\n###### F\n#no-heading\n```\n## in code\n```\n~~~\n# tilde\n~~~\n#### C"
);
// ATX headings with up to 3 leading spaces; 4 spaces is code, not a heading.
assert.equal(demoteHeadings("   ## A\n    ## code"), "   ### A\n    ## code");
// Setext headings become ATX one level down, including multi-line paragraphs.
assert.equal(
  demoteHeadings("Title\n=====\n\nSub one\nsub two\n---\ntext"),
  "## Title\n\n### Sub one sub two\ntext"
);
// A thematic break after a blank line, list, or quote is not a setext underline.
assert.equal(demoteHeadings("para\n\n---\n- item\n---\n> q\n==="), "para\n\n---\n- item\n---\n> q\n===");
// A closing fence needs the same character and at least the opening length.
assert.equal(
  demoteHeadings("````\n```\n# still code\n````\n# out"),
  "````\n```\n# still code\n````\n## out"
);
assert.equal(demoteHeadings("```\n~~~\n# code\n```\n# out"), "```\n~~~\n# code\n```\n## out");
console.log("PASS: demoteHeadings (one level, fences untouched, h6 stays, indented ATX, setext, fence length)");

assert.equal(
  buildOverviewSection("## 캐시 개요\n캐시는 빠르다", ["캐시"]),
  "## 📋 전체 요약\n\n<!-- alt2obs:overview start -->\n### 캐시 개요\n[[캐시]]는 빠르다\n<!-- alt2obs:overview end -->\n\n",
  "headings are not linked"
);
assert.equal(buildOverviewSection("  \n", ["캐시"]), "");
console.log("PASS: buildOverviewSection");

// ---- review fixes (2.0.0-beta.5 review) ----
{
  // M1: a link the model wrote in the other name order (or bare English) is pointed at the real note.
  const known = ["로터리 스케줄링 (Lottery Scheduling)", "티켓 (Ticket)"];
  assert.equal(
    linkConceptNames("[[Lottery Scheduling (로터리 스케줄링)|Lottery Scheduling]]은 무작위입니다.", ["로터리 스케줄링 (Lottery Scheduling)"]),
    "[[로터리 스케줄링 (Lottery Scheduling)|Lottery Scheduling]]은 무작위입니다.",
    "a link in the wrong order is retargeted, its visible text kept"
  );
  assert.equal(
    linkConceptNames("[[Lottery Scheduling]]은 ticket을 뽑습니다.", ["로터리 스케줄링 (Lottery Scheduling)", "티켓 (Ticket)"]),
    "[[로터리 스케줄링 (Lottery Scheduling)|Lottery Scheduling]]은 [[티켓 (Ticket)|ticket]]을 뽑습니다.",
    "a bare English link is retargeted with the old target as its text"
  );
  assert.equal(
    linkConceptNames("| A | B |\n|---|---|\n| [[Ticket (티켓)\\|ticket]] | x |", [], known),
    "| A | B |\n|---|---|\n| [[티켓 (Ticket)\\|ticket]] | x |",
    "known names (not this lecture's) retarget links too, the table pipe stays escaped"
  );
  assert.equal(linkConceptNames("[[6강]]과 [[로터리 스케줄링 (Lottery Scheduling)#정의|정의]]", [], known), "[[6강]]과 [[로터리 스케줄링 (Lottery Scheduling)#정의|정의]]", "other notes and exact links are untouched");

  // M2: names without Hangul in either part (acronym and expansion) match the other forms.
  const same = (a, b) => assert.ok(cn.sameConcept(a, b), `${a} = ${b}`);
  const diff = (a, b) => assert.ok(!cn.sameConcept(a, b), `${a} != ${b}`);
  same("PTE (Page Table Entry)", "PTE (페이지 테이블 엔트리)");
  same("CFS (Completely Fair Scheduler)", "Completely Fair Scheduler (CFS)");
  same("TLB (Translation Look-Aside Buffer)", "Translation Lookaside Buffer (TLB)");
  same("TLB (Translation Look-Aside Buffer)", "TLB (변환 색인 버퍼)");
  same("DRAM (Dynamic RAM)", "DRAM (동적 램)");
  same("LR-SC (Load-Reserved Store-Conditional)", "LR/SC (Load-Reserved Store-Conditional)");
  same("GPGPU (General-Purpose GPU Computing)", "GPGPU (범용 GPU 컴퓨팅)");
  same("MESI Protocol (MESI 프로토콜)", "MESI 프로토콜 (Modified-Exclusive-Shared-Invalid)");
  same("NUMA (Non-Uniform Memory Access)", "Non-Uniform Memory Access (불균일 메모리 접근)");
  diff("Mutator (Operation)", "Observer (Operation)");
  diff("Contract (Programming)", "Function Specification");
  diff("SM (Streaming Multiprocessor)", "Shared Memory (공유 메모리)");
  diff("TLB Miss (TLB 미스)", "TLB (Translation Look-Aside Buffer)");
  diff("Latency (지연)", "Delay (지연)");
  diff("UMA (Uniform Memory Access)", "NUMA (Non-Uniform Memory Access)");

  // M4: a Korean part is not linked inside a longer word or a compound noun.
  const ko = ["Tree (트리)", "Bit (비트)", "Key (키)", "Table (테이블)", "Scheduling (스케줄링)", "Cache (캐시)"];
  for (const t of ["트리거가 걸립니다.", "비트맵을 씁니다.", "키보드로 입력합니다.", "페이지 테이블을 봅니다.", "로터리 스케줄링은 무작위입니다.", "캐시 일관성을 지킵니다."]) {
    assert.equal(linkConceptNames(t, ko), t, `nothing linked in "${t}"`);
  }
  assert.equal(linkConceptNames("트리에서는 탐색이 빠릅니다.", ko), "[[Tree (트리)|트리]]에서는 탐색이 빠릅니다.", "particles still match");
  assert.equal(linkConceptNames("정렬된 트리를 씁니다.", ko), "정렬된 [[Tree (트리)|트리]]를 씁니다.", "after a modifier");
  assert.equal(linkConceptNames("그 트리입니다.", ko), "그 [[Tree (트리)|트리]]입니다.", "after a determiner");
  console.log("PASS: review fixes: wrong-order links retargeted, acronym names match their expansion, Korean parts not linked inside words or compounds");
}
{
  const n = ["Lottery Scheduling (로터리 스케줄링)", "Ticket (티켓)"];
  // L1: a table without leading pipes still gets the escaped alias pipe.
  assert.equal(
    linkConceptNames("방식 | 설명\n---|---\nLottery Scheduling | 무작위", n),
    "방식 | 설명\n---|---\n[[Lottery Scheduling (로터리 스케줄링)\\|Lottery Scheduling]] | 무작위"
  );
  assert.equal(linkConceptNames("a | b 는 Lottery Scheduling입니다.", n), "a | b 는 [[Lottery Scheduling (로터리 스케줄링)|Lottery Scheduling]]입니다.", "a pipe outside a table is not a table");
  // L2: indented code, multi-line HTML comments, headings and bracketed text are not linked.
  assert.equal(
    linkConceptNames("    Lottery Scheduling()\n<!-- Lottery\nScheduling -->\n## Lottery Scheduling\n> [!definition] [Lottery Scheduling]\nLottery Scheduling입니다.", n),
    "    Lottery Scheduling()\n<!-- Lottery\nScheduling -->\n## Lottery Scheduling\n> [!definition] [Lottery Scheduling]\n[[Lottery Scheduling (로터리 스케줄링)|Lottery Scheduling]]입니다."
  );
  // L3: dollar amounts are not math.
  assert.equal(linkConceptNames("$5 와 Lottery Scheduling 그리고 $10", n), "$5 와 [[Lottery Scheduling (로터리 스케줄링)|Lottery Scheduling]] 그리고 $10");
  // L4: a sentence word next to the term is not a longer term.
  assert.equal(linkConceptNames("The Ticket is drawn.", n), "The [[Ticket (티켓)|Ticket]] is drawn.");
  assert.equal(linkConceptNames("Ticket Currency와 Ticket In use", n), "Ticket Currency와 [[Ticket (티켓)|Ticket]] In use");
  // L5: a Korean-only note does not absorb two different concepts with its Korean name; one alone it does.
  const two = cn.normalizeConcepts([{ name: "Latency (지연)", definition: "a", relatedConcepts: [] }, { name: "Delay (지연)", definition: "b", relatedConcepts: [] }], ["지연"]);
  assert.deepEqual(two.map((c) => c.name), ["Latency (지연)", "Delay (지연)"]);
  const one = cn.normalizeConcepts([{ name: "Latency (지연)", definition: "a", relatedConcepts: [] }], ["지연"]);
  assert.deepEqual(one.map((c) => c.name), ["지연"]);
  console.log("PASS: review fixes: tables without leading pipes, code/comments/headings/brackets skipped, dollar amounts, sentence words, ambiguous Korean-only notes");
}
{
  // Re-review HIGH: one acronym with two different expansions is two concepts; initials only when one side has no expansion.
  const differ = [
    ["UMA (Uniform Memory Access)", "Unified Memory Architecture (통합 메모리 구조)"],
    ["CAS (Compare-And-Swap)", "Column Address Strobe (열 주소 스트로브)"],
    ["DMA (Direct Memory Access)", "Dynamic Memory Allocation"],
    ["SMP (Symmetric Multiprocessor)", "Shared Memory Parallelism"],
    ["ILP (Instruction-Level Parallelism)", "Integer Linear Programming"],
    ["PCB (Process Control Block)", "Printed Circuit Board"],
    ["MPP (Massively Parallel Processor)", "Message Passing Protocol"],
    ["SM (Streaming Multiprocessor)", "SM (Shared Memory)"],
    ["PC (Program Counter)", "PC (Personal Computer)"],
    ["CS (Context Switch)", "CS (Critical Section)"],
    ["PC (프로그램 카운터)", "PC (개인용 컴퓨터)"],
    ["Ticket", "Ticket Currency (티켓 화폐)"],
  ];
  for (const [a, b] of differ) assert.ok(!cn.sameConcept(a, b) && !cn.sameConcept(b, a), `${a} != ${b}`);
  for (const [a, b] of [
    ["PTE (Page Table Entry)", "PTE (페이지 테이블 엔트리)"],
    ["CFS (Completely Fair Scheduler)", "Completely Fair Scheduler (CFS)"],
    ["TLB (Translation Look-Aside Buffer)", "Translation Lookaside Buffer (TLB)"],
    ["DRAM (Dynamic RAM)", "DRAM (동적 램)"],
    ["LR-SC (Load-Reserved Store-Conditional)", "LR/SC (Load-Reserved Store-Conditional)"],
    ["GPGPU (General-Purpose GPU Computing)", "GPGPU (범용 GPU 컴퓨팅)"],
    ["MESI Protocol (MESI 프로토콜)", "MESI 프로토콜 (Modified-Exclusive-Shared-Invalid)"],
    ["NUMA (Non-Uniform Memory Access)", "Non-Uniform Memory Access (불균일 메모리 접근)"],
    ["CPU", "Central Processing Unit"],
    ["CPU (중앙 처리 장치)", "Central Processing Unit (중앙 처리 장치)"],
  ]) assert.ok(cn.sameConcept(a, b) && cn.sameConcept(b, a), `${a} = ${b}`);
  // M1 retargeting uses the same rule, with the Korean-only safeguard.
  assert.equal(linkConceptNames("[[PC (Personal Computer)]]", [], ["PC (Program Counter)"]), "[[PC (Personal Computer)]]", "a different expansion is not retargeted");
  assert.equal(
    linkConceptNames("[[Latency (지연)]]과 [[Delay (지연)]]", [], ["지연"]),
    "[[Latency (지연)]]과 [[Delay (지연)]]",
    "two concepts sharing a Korean name are not both pointed at the Korean-only note"
  );
  assert.equal(linkConceptNames("[[Latency (지연)]]은 짧다", [], ["지연"]), "[[지연|Latency (지연)]]은 짧다", "one alone is");

  // Re-review MEDIUM: Korean mentions after a particle or verb ending, before a function word, are linked.
  const ko = ["Ticket (티켓)", "Red-Black Tree (레드-블랙 트리)", "Cache (캐시)", "Stride Scheduling (스트라이드 스케줄링)"];
  for (const [t, want] of [
    ["서버가 티켓을 받습니다.", "서버가 [[Ticket (티켓)|티켓]]을 받습니다."],
    ["프로세스가 티켓을 받습니다.", "프로세스가 [[Ticket (티켓)|티켓]]을 받습니다."],
    ["10개가 레드-블랙 트리에 있습니다.", "10개가 [[Red-Black Tree (레드-블랙 트리)|레드-블랙 트리]]에 있습니다."],
    ["사용자 단위(화폐)로 티켓을 나눕니다.", "사용자 단위(화폐)로 [[Ticket (티켓)|티켓]]을 나눕니다."],
    ["자기 티켓을 줍니다.", "자기 [[Ticket (티켓)|티켓]]을 줍니다."],
    ["빠르게 트리를 찾습니다. 레드-블랙 트리를 씁니다.", "빠르게 트리를 찾습니다. [[Red-Black Tree (레드-블랙 트리)|레드-블랙 트리]]를 씁니다."],
    ["속도를 위해 캐시를 둡니다.", "속도를 위해 [[Cache (캐시)|캐시]]를 둡니다."],
    ["스트라이드 스케줄링 같은 방식", "[[Stride Scheduling (스트라이드 스케줄링)|스트라이드 스케줄링]] 같은 방식"],
    ["레드-블랙 트리 같은 균형 트리", "[[Red-Black Tree (레드-블랙 트리)|레드-블랙 트리]] 같은 균형 트리"],
  ]) assert.equal(linkConceptNames(t, ko), want, t);

  // Re-review LOW: a nested list item indented with four spaces or a tab is not code.
  assert.equal(
    linkConceptNames("- 방식\n    - Lottery Scheduling은 무작위입니다.", ["Lottery Scheduling (로터리 스케줄링)"]),
    "- 방식\n    - [[Lottery Scheduling (로터리 스케줄링)|Lottery Scheduling]]은 무작위입니다."
  );
  assert.equal(linkConceptNames("- 방식\n\t- Ticket을 뽑습니다.", ["Ticket (티켓)"]), "- 방식\n\t- [[Ticket (티켓)|Ticket]]을 뽑습니다.");
  assert.equal(linkConceptNames("문단입니다.\n\n    Ticket()\n\nTicket을 뽑습니다.", ["Ticket (티켓)"]), "문단입니다.\n\n    Ticket()\n\n[[Ticket (티켓)|Ticket]]을 뽑습니다.", "an indented block after a blank line is still code");
  console.log("PASS: re-review: one acronym with two expansions stays two concepts, Korean mentions after particles and before function words, nested list items");
}
{
  // Re-check: only plural and verb endings (s, es, ing, ed, d) make two English names the same words.
  const apart = [["Process", "Processor"], ["Point", "Pointer"], ["Schedule", "Scheduler"], ["Read", "Reader"], ["Compute", "Computer"], ["Link", "Linker"], ["Load", "Loader"], ["Page", "Pager"], ["Bank", "Banker"], ["Port", "Portal"], ["Segment", "Segmenter"], ["Spin", "Spinner"]];
  for (const [a, b] of apart) {
    assert.ok(!cn.sameConcept(a, b) && !cn.sameConcept(b, a), `${a} != ${b}`);
    assert.ok(!cn.sameConcept(`${a} (같은말)`, `${b} (같은말)`), `${a} != ${b} with one Korean part`);
    assert.ok(!cn.sameConcept(a, `${b} (한국어)`), `${a} != ${b} (한국어)`);
  }
  assert.equal(linkConceptNames("[[Processor]]가 일합니다.", [], ["Process (프로세스)"]), "[[Processor]]가 일합니다.", "a link to Processor is not pointed at Process");
  assert.equal(linkConceptNames("[[Pointer]]를 따라갑니다.", ["Point (점)"]), "[[Pointer]]를 따라갑니다.");
  for (const [a, b] of [["Cache", "Caches"], ["Lock", "Locks"], ["Mutex", "Mutexes"], ["Monitor", "Monitors"], ["Context Switch", "Context Switching"], ["Compute", "Computed"]]) {
    assert.ok(cn.sameConcept(a, b) && cn.sameConcept(`${b} (한국어)`, a), `${a} = ${b}`);
  }
  // A known acronym inside an expansion is compared spelled out.
  assert.ok(cn.sameConcept("DRAM (Dynamic RAM)", "Dynamic Random Access Memory (동적 램)"));
  assert.ok(!cn.sameConcept("SRAM (Static RAM)", "Dynamic Random Access Memory (동적 램)"));
  console.log("PASS: re-check: only s, es, ing, ed, d endings join English names (Process is not Processor); RAM spelled out when comparing");
}
