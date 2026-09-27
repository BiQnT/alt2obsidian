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
      m.runCli({ bin: FAKE_CLAUDE, args: ["-p", "--output-format", "json", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--system-prompt", "s", "--tools", ""], input: "hi", cwd: job, timeoutMs: 1500 }),
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
    const p = m.runCli({ bin: FAKE_CODEX, args: ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "-C", job, "-o", join(job, "o.txt")], input: "hi", cwd: job, timeoutMs: 60000, signal: ctrl.signal });
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
      assert.equal(calls[0].stdin, "요약해 주세요", "prompt goes through stdin");
      assert.deepEqual(calls[0].argv.slice(calls[0].argv.indexOf("--model"), calls[0].argv.indexOf("--model") + 4), ["--model", "test-model", "--effort", "low"]);
    } else {
      assert.ok(calls[0].stdin.startsWith("SYS\n\n요약해 주세요"), "codex: fixed instructions lead the stdin prompt");
      assert.ok(calls[0].argv.includes('model_reasoning_effort="low"'));
    }
    assert.equal(calls[2].images.length, 1, "image passed as a file");
    assert.deepEqual(readdirSync(job), [], "temp images and schema files removed after the call");
    const total = usage.total();
    assert.equal(total.calls, 3);
    assert.equal(total.imagesSent, 1);
    assert.ok(total.inputTokens > 0 && total.outputTokens === 300 && total.cachedInputTokens > 0);

    // Unparsable answer: one retry, then a clear error.
    process.env.FAKE_CLI_MODE = "badjson";
    await quiet(() => assert.rejects(make().generateJSON("x", (r) => r, { schema: SCHEMA })));
    assert.equal(s.calls().length, 5, "invalid JSON asked once more, not more");

    // Subscription limit: surfaced as a usage-limit error.
    process.env.FAKE_CLI_MODE = "limit";
    await assert.rejects(make().generateText("x"), (e) => m.isUsageLimitError(e));

    // Wrong flag value is rejected by the fake (guards the argument builders).
    process.env.FAKE_CLI_MODE = "ok";
    await assert.rejects(make({ effort: "bogus" }).generateText("x"), (e) => e.kind === "exit");

    console.log(`PASS: ${label} CLI provider text, schema JSON, image file, usage, retry once, usage limit, flag check`);
  } finally {
    m.removeJobDir(job);
    s.cleanup();
  }
}

// Output parsers on the documented formats.
{
  const c = m.parseClaudeOutput(
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"a\":1}", structured_output: { a: 1 }, total_cost_usd: 0.02, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 85, output_tokens: 7 } })
  );
  assert.deepEqual(c.usage, { calls: 1, inputTokens: 100, cachedInputTokens: 85, outputTokens: 7, imagesSent: 0, costUsd: 0.02 });
  assert.deepEqual(c.structured, { a: 1 });
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
