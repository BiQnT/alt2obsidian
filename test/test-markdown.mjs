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
  linkConceptNames("캐시 일관성 (Cache Coherence)은 캐시 사이의 문제다.", names),
  "[[캐시 일관성 (Cache Coherence)]]은 [[캐시]] 사이의 문제다."
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
  linkConceptNames("페이지 테이블 엔트리와 트리 구조", ["Tree (트리)"]),
  "페이지 테이블 엔트리와 [[Tree (트리)|트리]] 구조",
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
  "[[로터리 스케줄링 (Lottery Scheduling)|Lottery Scheduling]]과 Lottery Scheduling"
);
assert.equal(linkConceptNames("[[Lottery Scheduling (로터리 스케줄링)\\|LS]] | Lottery Scheduling", oldStyle), "[[Lottery Scheduling (로터리 스케줄링)\\|LS]] | Lottery Scheduling", "a table alias link counts as linked");

// Concept names: both orders are one concept, matched on either part.
assert.deepEqual(cn.parseConceptName("Lottery Scheduling (로터리 스케줄링)"), { full: "Lottery Scheduling (로터리 스케줄링)", english: "Lottery Scheduling", korean: "로터리 스케줄링" });
assert.deepEqual(cn.parseConceptName("로터리 스케줄링 (Lottery Scheduling)"), { full: "로터리 스케줄링 (Lottery Scheduling)", english: "Lottery Scheduling", korean: "로터리 스케줄링" });
assert.deepEqual(cn.parseConceptName("MESI 프로토콜 (MESI Protocol)"), { full: "MESI 프로토콜 (MESI Protocol)", english: "MESI Protocol", korean: "MESI 프로토콜" });
assert.deepEqual(cn.parseConceptName("TLB"), { full: "TLB", english: "TLB", korean: null });
assert.deepEqual(cn.parseConceptName("fork()"), { full: "fork()", english: "fork()", korean: null });
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
  buildOverviewSection("## 개요\n캐시 설명", ["캐시"]),
  "## 📋 전체 요약\n\n<!-- alt2obs:overview start -->\n### 개요\n[[캐시]] 설명\n<!-- alt2obs:overview end -->\n\n"
);
assert.equal(buildOverviewSection("  \n", ["캐시"]), "");
console.log("PASS: buildOverviewSection");
