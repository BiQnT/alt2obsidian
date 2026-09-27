/**
 * Note verifier acceptance (spec 4.6): a note with 20 true statements and 5
 * wrong ones (test/fixtures/verify/lec13.json, labels only) checked against
 * the real lec13 deck and its timestamped transcript. Target: at least 4 of
 * the 5 wrong statements judged "틀림", at most 1 true statement judged
 * "틀림".
 *
 * The deck and transcript are the user's own lecture data and are not
 * committed: pass the folder holding them (names as in the fixture's
 * `inputs`), or set ALT2OBS_VERIFY_DATA. Without the data the script says
 * so and exits 0.
 *
 * Without --run nothing is sent to a model: the script prints the claim
 * split, the evidence plan and the estimate. With --run it judges once with
 * the real Claude CLI (default sonnet, effort low; --model / --effort to
 * change). The missing-slide call is left out (not part of the criterion)
 * and a guard stops at 3 calls, retries included.
 *
 * --fixture lec13-ko uses the same statements in Korean without English
 * terms (a Korean note on English slides); --no-transcript leaves the
 * transcript out; --fake judges with the fake claude of test/fixtures/bin
 * (no tokens) to show every claim reaches the judge.
 *
 * Run: node test/eval-verify.mjs [dataDir] [--fixture lec13|lec13-ko] [--no-transcript] [--run | --fake] [--bin <claude>] [--out results.json]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = args.find((a, i) => !a.startsWith("--") && !["--out", "--model", "--effort", "--bin", "--fixture"].includes(args[i - 1])) || process.env.ALT2OBS_VERIFY_DATA;
const fixture = JSON.parse(readFileSync(join(repo, `test/fixtures/verify/${opt("--fixture") ?? "lec13"}.json`), "utf8"));
if (!dataDir || !existsSync(join(dataDir, fixture.inputs.pdf)) || !existsSync(join(dataDir, fixture.inputs.transcript))) {
  console.log("INFO: verifier eval skipped (lecture data is the user's own and not committed; pass its folder or set ALT2OBS_VERIFY_DATA)");
  process.exit(0);
}

const m = await importTs("test/helpers/verify-entry.ts");
const a = await importTs("test/helpers/alignment-entry.ts");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(dataDir, fixture.inputs.pdf))), verbosity: 0 }).promise;
const slideTexts = (await a.extractPageLayouts(doc)).map(a.layoutAlignmentText);
await doc.destroy();
const raw = JSON.parse(readFileSync(join(dataDir, fixture.inputs.transcript), "utf8"));
const segmentsRaw = raw.flatMap((e) => (e.segments ?? []).map((s) => ({ startMs: s.start, endMs: s.end, text: s.text ?? "", speaker: s.speaker ?? "" })));
const alignment = a.alignLecture(slideTexts, segmentsRaw);
const segments = a.timedSegments(segmentsRaw);
const note = `# ${fixture.lecture} 정리\n\n` + fixture.statements.map((s) => `- ${s.text}`).join("\n") + "\n";
const plan = m.planVerification({
  lecture: fixture.lecture,
  noteMarkdown: note,
  slideTexts,
  transcript: args.includes("--no-transcript") ? null : { segments, spans: alignment ? m.parseAlignment(alignment.value) : null },
});
const byText = new Map(fixture.statements.map((s) => [s.text, s]));
const unmatched = plan.claims.filter((c) => !byText.has(c.claim.text));
if (plan.claims.length !== fixture.statements.length || unmatched.length > 0) {
  console.error(`claim split does not match the statements: ${plan.claims.length} claims, unmatched: ${unmatched.map((c) => c.claim.text).join(" | ")}`);
  process.exit(1);
}
// The missing-slide call is not part of the acceptance criterion.
plan.uncovered = [];
const est = m.estimateVerification(plan, "claude-cli");
const hitAt = plan.claims.filter((c) => c.slides.some((h) => h.slide === byText.get(c.claim.text).slide)).length;
const sources = {};
for (const c of plan.claims) sources[c.unmatched ? "unmatched" : c.source] = (sources[c.unmatched ? "unmatched" : c.source] ?? 0) + 1;
console.log(
  `Plan: ${est.claims} claims, ${est.judged} judged (${est.likelyTrue} likely true, last; evidence ${JSON.stringify(sources)}), ${est.unmatched} unmatched${est.unmatchedWarning ? " (over 30%: warned)" : ""}; ` +
    `labelled slide in the top 2 for ${hitAt}/${plan.claims.length}; estimate ${est.calls} calls, ${est.inputTokens} input, ${est.outputTokens} output tokens`
);

if (args.includes("--fake")) {
  const { FAKE_CLAUDE, fakeSession } = await import("./helpers/fake-cli.mjs");
  const session = fakeSession("ok");
  const job = m.createJobDir();
  try {
    const llm = new m.ClaudeCliProvider({ bin: FAKE_CLAUDE, model: "sonnet", effort: "low", timeoutMs: 60000, workDir: job, ownsWorkDir: false });
    const result = await m.runVerification(plan, llm);
    const judged = result.items.filter((i) => i.verdict !== null).length;
    console.log(`Fake judge: ${judged}/${plan.claims.length} claims got a verdict, ${result.unmatched.length} listed as unmatched, ${session.calls().length} fake calls (no tokens)`);
  } finally {
    m.removeJobDir(job);
    session.cleanup();
  }
  process.exit(0);
}

if (!args.includes("--run")) {
  console.log("INFO: dry run (no model call). Add --run to judge with the Claude CLI.");
  process.exit(0);
}

// The claude on this process's PATH (a login shell may find an older install first); --bin overrides.
const bin = opt("--bin") ?? execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
console.log(`Claude CLI: ${bin} (${version})`);
const job = m.createJobDir();
const usage = new m.UsageTracker();
const MAX_CALLS = 3;
let calls = 0;
try {
  const cli = new m.ClaudeCliProvider({ bin, model: opt("--model") ?? "sonnet", effort: opt("--effort") ?? "low", timeoutMs: 600000, workDir: job, usage, task: "verification", ownsWorkDir: false });
  const llm = {
    name: cli.name,
    maxInputTokens: cli.maxInputTokens,
    estimateTokens: (t) => cli.estimateTokens(t),
    generateText: () => Promise.reject(new Error("not used")),
    generateJSON: (prompt, validate, options) => {
      if (calls >= MAX_CALLS) return Promise.reject(new Error(`eval call budget (${MAX_CALLS}) reached`));
      calls++;
      return cli.generateJSON(prompt, validate, options);
    },
  };
  const started = Date.now();
  const result = await m.runVerification(plan, llm);
  const verdicts = ["맞음", "틀림", "근거 없음", "전사 불확실", null];
  const table = { true: Object.fromEntries(verdicts.map((v) => [String(v), 0])), false: Object.fromEntries(verdicts.map((v) => [String(v), 0])) };
  const rows = result.items.map((it) => {
    const s = byText.get(it.evidence.claim.text);
    table[s.label][String(it.verdict)]++;
    return { id: s.id, label: s.label, verdict: it.verdict, reason: it.reason, byScript: it.byScript, evidence: it.evidence.slides.map((h) => h.slide) };
  });
  const caught = table.false["틀림"];
  const falseAlarms = table.true["틀림"];
  const u = usage.total();
  console.log("\n| truth \\ verdict | 맞음 | 틀림 | 근거 없음 | 전사 불확실 | 판정 실패 |");
  console.log("|---|---|---|---|---|---|");
  for (const label of ["true", "false"]) {
    const r = table[label];
    console.log(`| ${label === "true" ? "맞는 문장 (20)" : "틀린 문장 (5)"} | ${r["맞음"]} | ${r["틀림"]} | ${r["근거 없음"]} | ${r["전사 불확실"]} | ${r["null"]} |`);
  }
  console.log(`\nWrong caught: ${caught}/5 (target >= 4). False 틀림: ${falseAlarms} (target <= 1). ${caught >= 4 && falseAlarms <= 1 ? "PASS" : "FAIL"}`);
  console.log(`Usage: ${u.calls} calls, input ${u.inputTokens} (cached ${u.cachedInputTokens}), output ${u.outputTokens}, API-equivalent $${u.costUsd}; ${Math.round((Date.now() - started) / 1000)} s`);
  for (const r of rows.filter((x) => x.verdict !== (x.label === "true" ? "맞음" : "틀림"))) {
    console.log(`  #${r.id} (${r.label}) -> ${r.verdict ?? "판정 실패"}: ${r.reason} [slides ${r.evidence.join(", ")}]`);
  }
  const out = opt("--out");
  if (out) writeFileSync(out, JSON.stringify({ table, caught, falseAlarms, usage: u, rows }, null, 2));
} finally {
  m.removeJobDir(job);
}
