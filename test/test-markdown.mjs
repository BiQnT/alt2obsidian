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
console.log("PASS: demoteHeadings (one level, fences untouched, h6 stays)");

assert.equal(
  buildOverviewSection("## 개요\n캐시 설명", ["캐시"]),
  "## 📋 전체 요약\n\n<!-- alt2obs:overview start -->\n### 개요\n[[캐시]] 설명\n<!-- alt2obs:overview end -->\n\n"
);
assert.equal(buildOverviewSection("  \n", ["캐시"]), "");
console.log("PASS: buildOverviewSection");
