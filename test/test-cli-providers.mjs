/**
 * Test: CliRunner (spawn, timeout, cancel, process-group kill, binary
 * lookup) and the Claude/Codex CLI providers, against the fake executables
 * in test/fixtures/bin. The fakes reject any flag the real CLIs would not
 * get from us, so a wrong command line fails here. No tokens are spent.
 * Run: node test/test-cli-providers.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTs } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, FAKE_CODEX, FAKE_SHELL, fakeSession, isAlive } from "./helpers/fake-cli.mjs";

const m = await importTs("test/helpers/cli-entry.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origWarn = console.warn;
const quiet = async (fn) => {
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
  }
};

// ---- runCli ----
{
  const out = await m.runCli({ bin: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], input: "안녕 stdin" });
  assert.equal(out.stdout, "안녕 stdin");
  assert.equal(out.exitCode, 0);

  await assert.rejects(
    m.runCli({ bin: process.execPath, args: ["-e", "console.error('boom'); process.exit(3)"] }),
    (e) => e.kind === "exit" && e.exitCode === 3 && /boom/.test(e.message)
  );
  await assert.rejects(m.runCli({ bin: "/nonexistent/claude", args: [] }), (e) => e.kind === "not-found");
  // A shell metacharacter in an argument is data, not syntax.
  const lit = await m.runCli({ bin: process.execPath, args: ["-e", "console.log(process.argv[1])", "$(rm -rf ~); `x` | y"] });
  assert.equal(lit.stdout.trim(), "$(rm -rf ~); `x` | y");
  console.log("PASS: runCli stdin, exit code, not-found, arguments passed without a shell");
}

// Timeout kills the whole process group (the CLI and its child).
{
  const s = fakeSession("hang");
  const job = m.createJobDir();
  try {
    const started = Date.now();
    await assert.rejects(
      m.runCli({ bin: FAKE_CLAUDE, args: m.buildClaudeArgs({ model: "", effort: "", systemPrompt: "s" }), input: m.buildClaudeInput({ prompt: "hi" }), cwd: job, timeoutMs: 1500 }),
      (e) => e.kind === "timeout"
    );
    assert.ok(Date.now() - started < 6000, "timeout returns promptly");
    const pids = s.pids();
    assert.equal(pids.length, 2, "fake wrote its pid and its child's pid");
    await sleep(300);
    for (const pid of pids) assert.ok(!isAlive(pid), `pid ${pid} killed with the group`);
    console.log("PASS: timeout kills the CLI and its child process");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// Cancel through AbortSignal, before and during the call.
{
  const s = fakeSession("hang");
  const job = m.createJobDir();
  try {
    const ctrl = new AbortController();
    const p = m.runCli({ bin: FAKE_CODEX, args: m.buildCodexArgs({ model: "", effort: "", imagePaths: [], workDir: job, lastMessagePath: join(job, "o.txt") }), input: m.codexPrompt("hi"), cwd: job, timeoutMs: 60000, signal: ctrl.signal });
    for (let i = 0; i < 50 && s.pids().length < 2; i++) await sleep(100);
    ctrl.abort();
    await assert.rejects(p, (e) => m.isAbortError(e));
    await sleep(300);
    for (const pid of s.pids()) assert.ok(!isAlive(pid), `pid ${pid} killed on cancel`);
    await assert.rejects(m.runCli({ bin: FAKE_CODEX, args: [], signal: ctrl.signal }), (e) => m.isAbortError(e));
    console.log("PASS: cancel kills the process group; an aborted signal never spawns");
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// ---- binary lookup ----
{
  const dir = mkdtempSync(join(tmpdir(), "resolve-"));
  try {
    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin);
    const exe = join(fakeBin, "claude");
    writeFileSync(exe, "#!/bin/sh\necho 1.0\n");
    chmodSync(exe, 0o755);
    const none = { shell: FAKE_SHELL, extraDirs: [] };

    assert.deepEqual(await m.resolveCliBinary("claude", { configuredPath: exe, ...none }), { path: exe, source: "settings" });
    await assert.rejects(m.resolveCliBinary("claude", { configuredPath: "/nope/claude", ...none }), /설정한 claude 경로/);
    assert.equal((await m.resolveCliBinary("claude", { configuredPath: "", cachedPath: exe, ...none })).source, "cache");

    process.env.FAKE_SHELL_RESULT = exe;
    assert.deepEqual(await m.resolveCliBinary("claude", { configuredPath: "", cachedPath: "/gone/claude", ...none }), { path: exe, source: "login-shell" });
    process.env.FAKE_SHELL_RESULT = "";
    assert.deepEqual(await m.resolveCliBinary("claude", { configuredPath: "", shell: FAKE_SHELL, extraDirs: [dir, fakeBin] }), { path: exe, source: "common-path" });
    await assert.rejects(m.resolveCliBinary("codex", { configuredPath: "", ...none }), /codex CLI를 찾지 못했습니다/);
    assert.equal(await m.readCliVersion(FAKE_CLAUDE), "2.1.283 (Claude Code)");
    // The child PATH starts with the binary's folder (nvm node for #!/usr/bin/env node).
    assert.ok(m.childPath("/x/nvm/bin/claude", "/usr/bin").startsWith("/x/nvm/bin:"));
    console.log("PASS: binary lookup order (settings, cache, login shell, common folders, error) and version");
  } finally {
    delete process.env.FAKE_SHELL_RESULT;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- providers ----
const SCHEMA = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

for (const [label, Provider, bin] of [
  ["Claude", m.ClaudeCliProvider, FAKE_CLAUDE],
  ["Codex", m.CodexCliProvider, FAKE_CODEX],
]) {
  const s = fakeSession("ok");
  const job = m.createJobDir();
  const usage = new m.UsageTracker();
  const make = (extra = {}) =>
    new Provider({ bin, model: "test-model", effort: "low", timeoutMs: 20000, workDir: job, usage, task: "commentary", ...extra });
  try {
    const p = make();
    const text = await p.generateText("요약해 주세요", { systemPrompt: "SYS" });
    assert.match(text, /요약 텍스트/);
    const json = await p.generateJSON("json please", (r) => r, { systemPrompt: "SYS", schema: SCHEMA });
    assert.deepEqual(json, { ok: true });
    const withImage = await p.generateJSON("look", (r) => r, {
      systemPrompt: "SYS",
      schema: SCHEMA,
      images: [{ pageNum: 4, mimeType: "image/png", base64: PNG_1PX }],
    });
    assert.deepEqual(withImage, { ok: true });
    const calls = s.calls();
    assert.equal(calls.length, 3);
    if (label === "Claude") {
      assert.ok(calls[0].argv.includes("--system-prompt") && calls[0].argv[calls[0].argv.indexOf("--system-prompt") + 1] === "SYS");
      assert.equal(calls[0].stdin, "요약해 주세요", "prompt goes through stdin as a stream-json user message");
      assert.ok(!calls[0].argv.includes("--json-schema") && !calls[0].argv.includes("--add-dir"), "no schema turn, no file access");
      assert.ok(calls[1].stdin.includes("[출력 형식]"), "JSON format asked in the prompt");
      assert.deepEqual(calls[0].argv.slice(calls[0].argv.indexOf("--model"), calls[0].argv.indexOf("--model") + 4), ["--model", "test-model", "--effort", "low"]);
    } else {
      assert.ok(calls[0].stdin.startsWith("Use only the content in this message."), "codex: content-only instruction first");
      assert.ok(calls[0].stdin.includes("SYS\n\n요약해 주세요"), "codex: fixed instructions lead the stdin prompt");
      assert.ok(calls[0].argv.includes('model_reasoning_effort="low"'));
    }
    assert.equal(calls[2].images.length, 1, label === "Claude" ? "image passed inline" : "image passed as a file");
    assert.deepEqual(readdirSync(job), [], "no temp files left after the call");
    const total = usage.total();
    assert.equal(total.calls, 3);
    assert.equal(total.imagesSent, 1);
    assert.ok(total.inputTokens > 0 && total.outputTokens === 300 && total.cachedInputTokens > 0);

    // Unparsable answer: one retry, then a clear error.
    process.env.FAKE_CLI_MODE = "badjson";
    await quiet(() => assert.rejects(make().generateJSON("x", (r) => r, { schema: SCHEMA })));
    assert.equal(s.calls().length, 5, "invalid JSON asked once more, not more");

    // Subscription limit: a fatal usage-limit error, read from the CLI's error field.
    process.env.FAKE_CLI_MODE = "limit";
    await assert.rejects(make().generateText("x"), (e) => m.isUsageLimitError(e) && m.isFatalCliError(e));
    // A crash is a call failure, but not fatal.
    process.env.FAKE_CLI_MODE = "crash";
    await assert.rejects(make().generateText("x"), (e) => e.kind === "exit" && !m.isFatalCliError(e));

    // Model and effort are checked before anything runs (review L9).
    process.env.FAKE_CLI_MODE = "ok";
    assert.throws(() => make({ effort: "bogus" }), /effort/);
    assert.throws(() => make({ model: "--dangerously-skip-permissions" }), /모델 이름/);

    console.log(`PASS: ${label} CLI provider text, schema JSON, image file, usage, retry once, usage limit, flag check`);
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// Output parsers on the documented formats.
{
  const c = m.parseClaudeOutput(
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"a\":1}", total_cost_usd: 0.02, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 85, output_tokens: 7 } }),
    ].join("\n")
  );
  assert.deepEqual(c.usage, { calls: 1, inputTokens: 100, cachedInputTokens: 85, outputTokens: 7, imagesSent: 0, costUsd: 0.02 });
  assert.equal(c.text, "{\"a\":1}");
  // modelUsage (all turns, all models) wins over usage (review A.3).
  const mu = m.parseClaudeOutput(
    JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "x",
      usage: { input_tokens: 10, output_tokens: 1 },
      modelUsage: {
        "claude-sonnet": { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 900, cacheCreationInputTokens: 50 },
        "claude-haiku": { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    })
  );
  assert.deepEqual([mu.usage.inputTokens, mu.usage.cachedInputTokens, mu.usage.outputTokens], [1070, 900, 45]);
  // A model answer that mentions a limit is not a usage-limit error (review L2).
  const modelText = new Error("응답 JSON 형식 오류: I hit a usage limit, sorry");
  assert.equal(m.isUsageLimitError(modelText), false);
  assert.throws(() => m.parseClaudeOutput(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "" })), /error_max_turns/);
  const x = m.parseCodexEvents(
    [
      '{"type":"thread.started"}',
      "not json",
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
      '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":20,"output_tokens":5}}',
    ].join("\n")
  );
  assert.equal(x.text, "hello");
  assert.deepEqual(x.usage, { calls: 1, inputTokens: 50, cachedInputTokens: 20, outputTokens: 5, imagesSent: 0, costUsd: 0 });
  assert.throws(() => m.parseCodexEvents('{"type":"turn.failed","error":{"message":"quota"}}'), /quota/);
  console.log("PASS: Claude JSON result and Codex JSONL parsing (usage with cache reads)");
}
