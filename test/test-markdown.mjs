/**
 * Test: concept wikilink insertion and heading demotion (src/core/markdown.ts).
 * Run: node test/test-markdown.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";

const { linkConceptNames, demoteHeadings, buildOverviewSection } = await importTs("src/core/markdown.ts");

const names = ["캐시", "캐시 일관성 (Cache Coherence)"];

// Longest name wins; the shorter name is not linked inside it.
assert.equal(
  linkConceptNames("캐시 일관성 (Cache Coherence)은 캐시 사이의 문제다.", names),
  "[[캐시 일관성 (Cache Coherence)]]은 [[캐시]] 사이의 문제다."
);
// Existing wikilinks (including aliased ones) are left alone.
assert.equal(
  linkConceptNames("[[캐시 일관성 (Cache Coherence)]]와 [[캐시|cache]], 그리고 캐시", names),
  "[[캐시 일관성 (Cache Coherence)]]와 [[캐시|cache]], 그리고 [[캐시]]"
);
// Case-insensitive match, written with the canonical name.
assert.equal(linkConceptNames("TLB and tlb", ["TLB"]), "[[TLB]] and [[TLB]]");
// `$` in a name is literal, regex metacharacters are escaped.
assert.equal(linkConceptNames("cost $& and a+b", ["$&", "a+b"]), "cost [[$&]] and [[a+b]]");
// No names: unchanged.
assert.equal(linkConceptNames("캐시", []), "캐시");
console.log("PASS: linkConceptNames (longest first, skips existing links, literal $)");

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
