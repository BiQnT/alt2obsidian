/**
 * Test: the alt2obs Skill's per-slide prompts (scripts/phase2/slide-prompt.mjs,
 * src/prompts/slidePrompt.ts) render exactly as recorded, for aligned chunks
 * and for an even-split URL transcript; and the Skill and the plugin share
 * the same writing rules (the rule block of slide-commentary.system.md and
 * slide-commentary-batch.system.md is identical, and every prompt that writes
 * note text, concept notes included, carries one list of AI tells); the
 * Skill's overview prompts keep the short shape and the plugin's
 * lecture-level note prompts the whole note.
 * Run: node test/test-skill-prompts.mjs            (compare)
 *      node test/test-skill-prompts.mjs --update   (re-record the golden file)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "./helpers/bundle-ts.mjs";

const GOLDEN = join(repo, "test/fixtures/skill-slide-prompts.json");
const dir = mkdtempSync(join(tmpdir(), "alt-to-obs-skill-prompt-"));
const run = (...args) => JSON.parse(execFileSync("node", [join(repo, "scripts/phase2/slide-prompt.mjs"), ...args], { encoding: "utf8" }));
let recorded;
try {
  writeFileSync(join(dir, "concepts.json"), JSON.stringify(["캐시 (Cache)", "MESI 프로토콜 (MESI Protocol)"]));
  writeFileSync(join(dir, "chunks.json"), JSON.stringify(["오늘은 캐시를 배웁니다.", null, "  캐시 일관성은 MESI로 유지됩니다.  "]));
  writeFileSync(join(dir, "transcript.txt"), "음 오늘은 캐시를 배웁니다. 캐시 일관성은 MESI 프로토콜로 유지됩니다. 마지막으로 요약합니다.");
  recorded = {
    aligned: run("3", "--concepts", join(dir, "concepts.json"), "--chunks", join(dir, "chunks.json")),
    evenSplit: run("2", "--transcript", join(dir, "transcript.txt")),
    bare: run("1"),
    prep: (writeFileSync(join(dir, "prep.json"), JSON.stringify({ pages: [{ page: 1, transcript: "" }, { page: 2, transcript: "MESI 상태는 네 가지입니다." }] })), run("2", "--prep", join(dir, "prep.json"))),
  };
  assert.throws(() => execFileSync("node", [join(repo, "scripts/phase2/slide-prompt.mjs"), "0"], { stdio: "pipe" }), "a slide count is required");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (process.argv.includes("--update")) {
  writeFileSync(GOLDEN, JSON.stringify(recorded, null, 2) + "\n");
  console.log(`wrote ${GOLDEN}`);
} else {
  assert.deepEqual(recorded, JSON.parse(readFileSync(GOLDEN, "utf8")));
  console.log("PASS: Skill per-slide prompts (aligned chunks, even-split transcript, no extras) match the recorded fixture");
}
// Fragment formats the Skill relies on.
assert.match(recorded.aligned.slides[0].user, /\n\n\[기존 개념 목록 \(같은 의미면 이 이름을 그대로 쓰시오\. 새 개념은 새 이름으로 도입 가능\)\]\n캐시 \(Cache\), MESI 프로토콜 \(MESI Protocol\)\n\n\[해당 구간 음성 전사 [^\]]*\]\n오늘은 캐시를 배웁니다\.$/);
assert.ok(!recorded.aligned.slides[1].user.includes("음성 전사"), "no transcript block for a slide without a chunk");
assert.ok(recorded.aligned.slides[2].user.endsWith("\n캐시 일관성은 MESI로 유지됩니다."), "chunks are trimmed");
assert.ok(!recorded.bare.slides[0].user.includes("[기존 개념") && !recorded.bare.slides[0].user.includes("[해당 구간"));

// Same writing rules for the Skill and the plugin.
const block = (file) => {
  const t = readFileSync(join(repo, "prompts", file), "utf8");
  const start = t.indexOf("문체 (모두 지킨다):");
  assert.ok(start >= 0, `${file} has the 문체 block`);
  const end = t.indexOf("\n\n출력 형식:", start);
  return (end >= 0 ? t.slice(start, end) : t.slice(start)).trimEnd();
};
assert.equal(block("slide-commentary.system.md"), block("slide-commentary-batch.system.md"), "Skill and plugin share the writing rules");
console.log("PASS: the Skill's per-slide system prompt carries the plugin's writing rules unchanged");

// One list of Korean AI tells for every prompt that writes note text (review L9).
const tells = (file) => {
  const t = readFileSync(join(repo, "prompts", file), "utf8");
  const start = t.indexOf("   - 군더더기와 과장:");
  assert.ok(start >= 0, `${file} has the list of AI tells`);
  const end = t.indexOf("덧붙이는 말은 쉼표, 괄호, 새 문장으로 쓴다.\n", start);
  assert.ok(end > start, `${file}: the list ends with the dash rule`);
  return t.slice(start, end);
};
const sharedTells = tells("slide-commentary-batch.system.md");
const tellFiles = [
  "slide-commentary.system.md",
  "transcript-section-batch.system.md",
  "overview-from-gists.md",
  "overview-from-sections.md",
  "summary-from-transcript.md",
  "summary-enhance-transcript.md",
  "summary-enhance-material.md",
  "lecture-note-from-transcript.md",
  "lecture-note-enhance-transcript.md",
  "lecture-note-from-material.md",
  "lecture-note-enhance-material.md",
  "concept-extraction.md",
  "concept-extraction-gists.md",
  "concept-extraction-sections.md",
];
for (const file of tellFiles) assert.equal(tells(file), sharedTells, `${file} carries the shared list of AI tells`);
console.log(`PASS: the commentary, section, overview, summary, lecture note and concept prompts share one list of AI tells (${tellFiles.length + 1} files)`);

// Two roles of the text written from the transcript or the PDF text: the Skill's
// slide path puts a short overview above its per-slide commentary (summary-*.md,
// at most 1200 characters); the plugin's lecture-level note has no per-slide or
// per-section part, so that text is the whole note (lecture-note-*.md, at most 8000).
const prompt = (file) => readFileSync(join(repo, "prompts", file), "utf8");
// The Skill's overview prompts (summary-from-material.md went with the plugin's
// partial note, its only caller, to lecture-note-from-material.md).
const overviewFiles = ["summary-from-transcript.md", "summary-enhance-transcript.md", "summary-enhance-material.md"];
const noteFiles = ["lecture-note-from-transcript.md", "lecture-note-enhance-transcript.md", "lecture-note-enhance-material.md", "lecture-note-from-material.md"];
for (const file of overviewFiles) {
  const t = prompt(file);
  assert.ok(t.includes("- `## 흐름`:") && t.includes("callout(`> [!...]`), 표, 인용은 쓰지 않는다.") && t.includes("분량은 1200자 이내.") && !t.includes("상세 노트"), `${file} keeps the overview shape`);
}
for (const file of noteFiles) {
  const t = prompt(file);
  for (const part of ["- `## 개요`:", "- `## 핵심 개념`:", "- `## 상세 노트`:", "`**혼동하기 쉬운 점:**`", "callout(`> [!...]`)은 노트 전체에 두 개까지", "분량은 8000자 이내.", "\n## 상세 노트\n\n### 1. "]) {
    assert.ok(t.includes(part), `${file}: ${part}`);
  }
  assert.ok(!t.includes("## 흐름") && !t.includes("1200자"), `${file} is not the overview`);
  assert.equal(t.includes("`### 1. 주제 (p.3~5)`"), file.includes("material"), `${file}: page ranges only from the PDF excerpt`);
}
// The variables the plugin passes: the same as the overview prompts had.
const vars = (t) => [...new Set([...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();
assert.deepEqual(noteFiles.map((f) => vars(prompt(f))), [
  ["memoContext", "transcript"],
  ["summary", "transcript"],
  ["excerptPageCount", "excerptScope", "materialText", "pageCount", "summary"],
  ["excerptPageCount", "materialText", "memoContext", "pageCount"],
]);
const skill = readFileSync(join(repo, "scripts/phase2/SKILL.md"), "utf8");
for (const file of overviewFiles) assert.ok(skill.includes(file), `the Skill's overview still uses ${file}`);
const main = readFileSync(join(repo, "src/main.ts"), "utf8");
assert.ok(!main.includes("prompts/summary-"), "the plugin never puts the short overview where it is the whole note");
for (const file of [...noteFiles, "lecture-note.system.md"]) assert.ok(main.includes(`"../prompts/${file}"`), `the plugin's lecture-level note uses ${file}`);
console.log("PASS: the Skill's overview prompts keep the short shape (1200 characters); the plugin's lecture-level note prompts ask for the whole note (개요, 핵심 개념, 상세 노트, 8000 characters) with the variables it passes");
