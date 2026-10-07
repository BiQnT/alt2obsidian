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
  assert.match(dry, /5 total: 3 generated, 1 template, 1 duplicate/);
  assert.equal(s.calls().length, 0, "dry run makes no CLI call");
  console.log("PASS: bench dry run prints the plan and estimate without calling a CLI");

  // The plugin's transcript cache: timestamps align the transcript to the slides.
  const cache = join(s.dir, "t.json");
  const plain = join(s.dir, "t-plain.txt");
  const talk = [
    ["alpha introduction to caches", "today we start caches"],
    ["beta cache coherence", "the MESI protocol keeps cache coherence", "cache coherence with MESI"],
    ["a picture of the bus"],
    ["gamma summary and questions", "summary of caches and questions"],
  ].flatMap((group) => [0, 1, 2, 3].flatMap(() => group));
  writeFileSync(cache, JSON.stringify({ v: 1, id: "bench", segments: talk.map((t, i) => [i * 15000, (i + 1) * 15000, t]) }));
  writeFileSync(plain, talk.join("\n"));
  const aligned = JSON.parse(bench(["--provider", "claude-cli", "--transcript", cache, "--dry-run", "--json"]));
  const even = JSON.parse(bench(["--provider", "claude-cli", "--transcript", plain, "--dry-run", "--json"]));
  assert.equal(aligned.transcriptAligned, true, "cache JSON is aligned by its timestamps");
  assert.equal(even.transcriptAligned, false, "the same text as plain text is split evenly");
  assert.ok(aligned.transcriptChars.before > 0 && aligned.transcriptChars.before !== even.transcriptChars.before, "the slides get the aligned spans");
  assert.match(bench(["--provider", "claude-cli", "--transcript", cache, "--dry-run"]), /\| transcript per slide +\| aligned by timestamps/);
  // A broken cache file is named in the error.
  const broken = join(s.dir, "broken.json");
  writeFileSync(broken, '{"v":1,"segments":[[0,1000,"cut off');
  assert.throws(
    () => bench(["--provider", "claude-cli", "--transcript", broken, "--dry-run"]),
    (e) => e.stderr.includes(`${broken}: not a transcript cache JSON (`),
    "the error names the file"
  );
  console.log("PASS: bench reads the plugin's transcript cache JSON and aligns it by its timestamps; plain text is split evenly; a broken cache file is named");

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
