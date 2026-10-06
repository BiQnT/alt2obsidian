/**
 * Test: the alt2obs Skill's per-slide prompts (scripts/phase2/slide-prompt.mjs,
 * src/prompts/slidePrompt.ts) render exactly as recorded, for aligned chunks
 * and for an even-split URL transcript; and the Skill and the plugin share
 * the same writing rules (the rule block of slide-commentary.system.md and
 * slide-commentary-batch.system.md is identical).
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
const dir = mkdtempSync(join(tmpdir(), "alt2obs-skill-prompt-"));
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
  const start = t.indexOf("문체 (모두 지킵니다):");
  assert.ok(start >= 0, `${file} has the 문체 block`);
  const end = t.indexOf("\n\n출력 형식:", start);
  return (end >= 0 ? t.slice(start, end) : t.slice(start)).trimEnd();
};
assert.equal(block("slide-commentary.system.md"), block("slide-commentary-batch.system.md"), "Skill and plugin share the writing rules");
console.log("PASS: the Skill's per-slide system prompt carries the plugin's writing rules unchanged");
