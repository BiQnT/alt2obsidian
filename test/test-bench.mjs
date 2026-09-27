/**
 * Test: the benchmark harness (scripts/bench/bench.mjs) end to end with the
 * fake claude/codex (no tokens): dry run, full run with a note written, and
 * the JSON metrics.
 * Run: node test/test-bench.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, FAKE_CODEX, fakeSession } from "./helpers/fake-cli.mjs";
import { FIXTURE_PATH } from "./helpers/synthetic-pdf.mjs";

const bench = (args) =>
  execFileSync("node", [join(repo, "scripts/bench/bench.mjs"), "--pdf", FIXTURE_PATH, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const s = fakeSession("ok");
try {
  const transcript = join(s.dir, "t.txt");
  writeFileSync(transcript, "음 오늘은 캐시를 배웁니다. 그러니까 캐시 일관성은 MESI 프로토콜로 유지됩니다. ".repeat(20));

  const dry = bench(["--provider", "claude-cli", "--dry-run"]);
  assert.match(dry, /\| mode +\| dry run/);
  assert.match(dry, /5 total: 2 generated, 2 template, 1 duplicate/);
  assert.equal(s.calls().length, 0, "dry run makes no CLI call");
  console.log("PASS: bench dry run prints the plan and estimate without calling a CLI");

  for (const [provider, bin] of [["claude-cli", FAKE_CLAUDE], ["codex-cli", FAKE_CODEX]]) {
    const before = s.calls().length;
    const out = join(s.dir, `${provider}.md`);
    const r = JSON.parse(bench(["--provider", provider, "--bin", bin, "--transcript", transcript, "--out", out, "--json", "--effort", "low"]));
    assert.equal(r.calls, 3, "1 batch + overview + concepts");
    assert.equal(s.calls().length - before, 3);
    assert.equal(r.estimate.calls, 3);
    assert.equal(r.imagesSent, 1, "the image-only fixture page is sent as an image");
    assert.ok(r.inputTokens > 0 && r.outputTokens > 0);
    assert.ok(r.cachedInputTokens > 0 && r.cacheHitPct > 0, "cache reads reported");
    assert.ok(r.transcriptChars.after < r.transcriptChars.before);
    const note = readFileSync(out, "utf8");
    assert.equal((note.match(/<!-- alt2obs:slide:\d+ hash:[0-9a-f]{8} start -->/g) ?? []).length, 5);
    assert.match(note, /## 📋 전체 요약/);
    console.log(`PASS: bench full run with fake ${provider}: ${r.calls} calls, ${r.inputTokens} in (${r.cacheHitPct}% cached), note written`);
  }
} finally {
  s.cleanup();
}
