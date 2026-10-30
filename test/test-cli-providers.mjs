/**
 * Test: CliRunner (spawn, timeout, cancel, process-group kill, binary
 * lookup, timers) and the Claude/Codex CLI providers, against the fake
 * executables in test/fixtures/bin. The fakes reject any flag the real CLIs would not
 * get from us, so a wrong command line fails here. No tokens are spent.
 * Run: node test/test-cli-providers.mjs
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import timers from "node:timers";
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

// The call's timers: window's where there is a window (Obsidian), Node's
// `timers` where there is none. The stub child has no pid, so no process
// starts and no signal is sent; it closes when the test says.
{
  let child = null;
  const spawnFn = () => {
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
  };
  const run = (timeoutMs) => m.runCli({ bin: "/fake/claude", args: [], platform: "darwin", spawnFn, timeoutMs });
  const AFTER_TIMEOUT = [m.KILL_GRACE_MS, 2 * m.KILL_GRACE_MS]; // SIGKILL, then give up

  const set = [];
  const cleared = [];
  globalThis.window = { setTimeout: (fn, ms) => set.push({ fn, ms }), clearTimeout: (id) => void cleared.push(id) };
  try {
    const p = run(12345);
    assert.deepEqual(set.map((t) => t.ms), [12345], "the timeout is set with window.setTimeout");
    set[0].fn();
    assert.deepEqual(set.map((t) => t.ms), [12345, ...AFTER_TIMEOUT], "then the SIGKILL and give-up timers");
    child.emit("close", null);
    await assert.rejects(p, (e) => e.kind === "timeout");
    assert.deepEqual(cleared, [1, 2, 3], "all three cleared with window.clearTimeout");
  } finally {
    delete globalThis.window;
  }

  const nodeSet = [];
  const nodeCleared = [];
  const { setTimeout: realSet, clearTimeout: realClear } = timers;
  timers.setTimeout = (fn, ms) => (nodeSet.push(ms), realSet(fn, ms));
  timers.clearTimeout = (t) => (nodeCleared.push(t), realClear(t));
  syncBuiltinESMExports();
  try {
    const p = run(30);
    assert.deepEqual(nodeSet, [30], "no window: the timeout is a Node timer");
    await sleep(150);
    assert.deepEqual(nodeSet, [30, ...AFTER_TIMEOUT], "it fired, and the SIGKILL and give-up timers are Node timers too");
    child.emit("close", null);
    await assert.rejects(p, (e) => e.kind === "timeout");
    assert.equal(nodeCleared.length, 3, "all three cleared with Node's clearTimeout");
  } finally {
    timers.setTimeout = realSet;
    timers.clearTimeout = realClear;
    syncBuiltinESMExports();
  }
  console.log("PASS: runCli's timers are window's where there is a window, Node's where there is none");
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
    assert.equal(await m.probeCliLogin("codex", FAKE_CODEX), true, "codex login status: exit 0 and a line starting with Logged in");
    assert.equal(await m.probeCliLogin("codex", exe), false, "a line that does not start with Logged in");
    // The child PATH starts with the binary's folder (nvm node for #!/usr/bin/env node).
    assert.ok(m.childPath("/x/nvm/bin/claude", "/usr/bin").startsWith("/x/nvm/bin:"));
    console.log("PASS: binary lookup order (settings, cache, login shell, common folders, error) and version");
  } finally {
    delete process.env.FAKE_SHELL_RESULT;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- CLI feature check: --help must list every flag; older than tested only warns ----
{
  const dir = mkdtempSync(join(tmpdir(), "resolve-ver-"));
  try {
    const fullHelp = (await import("node:child_process")).execFileSync(FAKE_CLAUDE, ["--help"], { encoding: "utf8" });
    const mk = (sub, version, help, extra = "") => {
      mkdirSync(join(dir, sub));
      const f = join(dir, sub, "claude");
      writeFileSync(join(dir, sub, "help.txt"), help);
      writeFileSync(f, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nif [ "$1" = "--help" ]; then cat "${join(dir, sub, "help.txt")}"; exit 0; fi\n${extra}\n`);
      chmodSync(f, 0o755);
      return f;
    };
    const lacking = mk("brew", "2.1.77", fullHelp.replace("--safe-mode", "--safe-modes-x"), 'echo "error: unknown option \'--safe-mode\'" >&2; exit 1');
    const olderFull = mk("npm", "2.1.200", fullHelp);
    const cur = mk("nvm", "2.1.283", fullHelp);
    const newer = mk("local", "2.2.0", fullHelp);
    assert.equal(m.TESTED_CLI_VERSION.claude, "2.1.283");
    assert.deepEqual(m.missingCliFeatures("claude", fullHelp), []);
    assert.deepEqual(m.missingCliFeatures("claude", fullHelp.replace("--safe-mode", "")), ["--safe-mode"]);
    assert.deepEqual(m.missingCliFeatures("claude", fullHelp.replace('"dontAsk", ', "")), ["dontAsk"]);
    assert.deepEqual(m.missingCliFeatures("codex", (await import("node:child_process")).execFileSync(FAKE_CODEX, ["exec", "--help"], { encoding: "utf8" })), []);
    assert.deepEqual(m.parseSemver("2.1.283 (Claude Code)"), [2, 1, 283]);
    assert.equal(m.versionAtLeast("2.1.77", "2.1.283"), false);
    const opts = { configuredPath: "", shell: FAKE_SHELL, checkFeatures: true };
    // The login shell finds the one missing a flag first (like /opt/homebrew/bin before nvm): skipped.
    process.env.FAKE_SHELL_RESULT = lacking;
    const r = await m.resolveCliBinary("claude", { ...opts, extraDirs: [join(dir, "nvm")] });
    assert.deepEqual(r, { path: cur, source: "common-path", version: "2.1.283 (Claude Code)", optional: ["--include-partial-messages"] });
    assert.equal((await m.resolveCliBinary("claude", { ...opts, cachedPath: lacking, extraDirs: [join(dir, "nvm"), join(dir, "local")] })).path, newer, "the newest usable one wins");
    // Older than tested but every flag present: used, with a warning only.
    const soft = await m.resolveCliBinary("claude", { ...opts, extraDirs: [join(dir, "npm")] });
    assert.equal(soft.path, olderFull);
    assert.match(soft.warning, /시험한 버전 2\.1\.283보다 오래되었습니다/);
    // Only a binary missing a flag: a clear block naming it and the flag.
    await assert.rejects(m.resolveCliBinary("claude", { ...opts, extraDirs: [] }), (e) => e.message.includes(`${lacking} (2.1.77 (Claude Code), 없는 옵션: --safe-mode)`));
    // A configured one missing a flag: the error names the usable alternatives.
    process.env.FAKE_SHELL_RESULT = "";
    await assert.rejects(m.resolveCliBinary("claude", { ...opts, configuredPath: lacking, extraDirs: [join(dir, "nvm")] }), (e) => e.message.includes(lacking) && e.message.includes(cur));
    assert.equal((await m.resolveCliBinary("claude", { ...opts, configuredPath: olderFull, extraDirs: [] })).source, "settings");
    // A help text missing a flag at or above the tested version: used, with a warning.
    const terseNew = mk("terse", "2.3.0", fullHelp.replace("--disable-slash-commands", ""));
    const terse = await m.resolveCliBinary("claude", { ...opts, configuredPath: terseNew, extraDirs: [] });
    assert.equal(terse.path, terseNew);
    assert.match(terse.warning, /--disable-slash-commands 옵션이 보이지 않지만/);
    // An "unknown option" exit at run time becomes the update message, fatal for the run.
    const provider = new m.ClaudeCliProvider({ bin: lacking, model: "", effort: "", timeoutMs: 10000, workDir: dir, ownsWorkDir: false });
    await assert.rejects(provider.generateText("hi"), (e) => e.kind === "spawn" && /업데이트/.test(e.message) && m.isFatalCliError(e));
    console.log("PASS: CLI feature check: a binary missing a flag is skipped or blocked, older than tested only warns, newest usable picked, unknown option mapped");
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
  // The model that ran: the modelUsage entry with the most output (an alias comes back as its full id).
  assert.equal(mu.model, "claude-sonnet");
  assert.equal(c.model, undefined, "no modelUsage and no model in the init event: unknown");
  const fromInit = m.parseClaudeOutput(
    [JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }), JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } })].join("\n")
  );
  assert.equal(fromInit.model, "claude-opus-5-5", "else the init event's model");
  assert.equal(m.formatUsageFrontmatter({ calls: 2, inputTokens: 10, cachedInputTokens: 5, outputTokens: 3, imagesSent: 0, costUsd: 0 }, "Claude CLI sonnet", { model: "claude-sonnet-5-5", effort: "medium", conceptModel: "claude-sonnet-5-5" }),
    'alt2obs_usage: {provider: "Claude CLI sonnet", model: "claude-sonnet-5-5", effort: "medium", calls: 2, input: 10, cached: 5, output: 3, images: 0}', "the concept model only when it differs");
  const tracker = new m.UsageTracker();
  const seenRecords = [];
  tracker.onRecord((e) => seenRecords.push(e.task));
  tracker.record({ calls: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, imagesSent: 0, costUsd: 0, provider: "claude-cli", model: "sonnet", resolvedModel: "claude-sonnet-5-5", task: "commentary" });
  tracker.record({ calls: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, imagesSent: 0, costUsd: 0, provider: "codex-cli", model: "gpt-6-luna", resolvedModel: "", task: "concepts" });
  assert.equal(tracker.modelFor("commentary"), "claude-sonnet-5-5", "the id the CLI reported");
  assert.equal(tracker.modelFor("concepts"), "gpt-6-luna", "else the requested model");
  assert.equal(tracker.modelFor("verification"), null);
  assert.deepEqual(seenRecords, ["commentary", "concepts"]);
  // Robust JSON extraction (review N2).
  assert.deepEqual(m.parseJsonText('{"a":1}'), { a: 1 });
  assert.deepEqual(m.parseJsonText('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(m.parseJsonText('Here you go:\n{"a":{"b":2}}\nHope this helps.'), { a: { b: 2 } });
  assert.deepEqual(m.parseJsonText('First try:\n```json\n{"a":1,\n```\nFixed:\n```json\n{"a":2}\n```\nDone.'), { a: 2 }, "last fenced block");
  assert.throws(() => m.parseJsonText("no json here"));
  // A raw `\|` (a table wikilink) inside a JSON string is repaired; nothing else is.
  const linkIn = (json) => m.parseJsonText(json).c;
  assert.equal(linkIn(String.raw`{"c":"| [[A (가)\\|a]] |"}`), String.raw`| [[A (가)\|a]] |`, "a valid \\\\| is read as is");
  assert.equal(m.repairPipeEscapes(String.raw`{"c":"[[A (가)\\|a]]"}`), String.raw`{"c":"[[A (가)\\|a]]"}`, "a valid \\\\| is left alone");
  assert.equal(linkIn(String.raw`{"c":"| [[A (가)\|a]] |"}`), String.raw`| [[A (가)\|a]] |`, "a raw \\| is repaired");
  assert.equal(linkIn(String.raw`{"c":"x\\\|y"}`), String.raw`x\\|y`, "an escaped backslash, then a raw \\|");
  assert.equal(linkIn(String.raw`{"c":"say \"hi\" [[A\|b]] \u00e9\n"}`), 'say "hi" [[A\\|b]] é\n', "other escapes and quotes inside the string stay");
  assert.equal(linkIn('Here you go:\n' + String.raw`{"c":"[[A\|b]]"}` + '\nDone.'), String.raw`[[A\|b]]`, "repaired in the brace span too");
  assert.equal(linkIn('```json\n' + String.raw`{"c":"[[A\|b]]"}` + '\n```'), String.raw`[[A\|b]]`, "and in a fence");
  assert.equal(m.repairPipeEscapes(String.raw`{"c":1} \| {"d":"\q"}`), String.raw`{"c":1} \| {"d":"\q"}`, "outside strings and other escapes: untouched");
  for (const bad of [String.raw`{"c":"\q"}`, String.raw`{"c":"[[A\|b]] \q"}`]) {
    let expected;
    try {
      JSON.parse(bad);
    } catch (e) {
      expected = e.message;
    }
    assert.throws(() => m.parseJsonText(bad), (e) => e instanceof SyntaxError && e.message === expected, "other invalid escapes still fail, with the original error");
  }
  // Login failure only from the CLI's error field, never stderr noise (review N6).
  const noisy = new m.CliRunError("exit", "x", "warn: GET /v1/oauth token refresh 401 from a plugin");
  assert.equal(m.isAuthError(noisy), false);
  assert.equal(m.isFatalCliError(noisy), false);
  const auth = new m.CliRunError("exit", "x");
  auth.cliError = "Not logged in. Please run /login";
  assert.ok(m.isAuthError(auth) && m.isFatalCliError(auth));
  assert.equal(m.isFatalCliError(new m.CliRunError("timeout", "t")), false, "a timeout is not fatal (review N1)");
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
  console.log("PASS: Claude JSON result and Codex JSONL parsing (usage with cache reads); a raw \\| in a JSON string is repaired, other invalid escapes still fail");
}

// ---- streamed answers (2.1.0 spec 7.1) ----

// runCli's line callback: every stdout line as it arrives, the last piece without a line break at the end.
{
  const lines = [];
  const out = await m.runCli({
    bin: process.execPath,
    args: ["-e", "process.stdout.write('a\\r\\nb'); setTimeout(() => process.stdout.write('c\\nd\\n\\ne'), 50)"],
    onStdoutLine: (l) => lines.push(l),
  });
  assert.deepEqual(lines, ["a", "bc", "d", "", "e"], "pieces joined into lines, CR dropped, the tail at close");
  assert.equal(out.stdout, "a\r\nbc\nd\n\ne", "the whole stdout is still collected");
  const quietLines = [];
  await quiet(() => m.runCli({ bin: process.execPath, args: ["-e", "console.log('x'); console.log('y')"], onStdoutLine: (l) => (quietLines.push(l), l === "x" && (() => { throw new Error("listener"); })()) }));
  assert.deepEqual(quietLines, ["x", "y"], "a listener error does not stop the run");
  console.log("PASS: runCli hands stdout over line by line (CRLF, a split line, the unterminated tail) and survives a listener error");
}

// The stream_event line format of Claude Code 2.1.312; everything else is not answer text.
{
  const real = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"아"}},"session_id":"s","parent_tool_use_id":null,"uuid":"u","api_message_id":"m"}';
  assert.equal(m.streamTextDelta(real), "아");
  assert.equal(m.streamTextDelta('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"x"}}}'), null, "thinking pieces are not the answer");
  assert.equal(m.streamTextDelta('{"type":"stream_event","event":{"type":"message_start"}}'), null);
  assert.equal(m.streamTextDelta('{"type":"result","result":"stream_event"}'), null);
  assert.equal(m.streamTextDelta("not json stream_event"), null);
  // The flag is optional: listed in the help, or not.
  assert.deepEqual(m.presentOptionalFeatures("claude", "  --include-partial-messages  Include partial message chunks"), ["--include-partial-messages"]);
  assert.deepEqual(m.presentOptionalFeatures("claude", "  --include-partial-messages-v2\n  --verbose"), [], "a longer flag is not this one");
  assert.deepEqual(m.presentOptionalFeatures("codex", "anything"), []);
  assert.ok(!m.REQUIRED_CLI_FEATURES.claude.includes(m.PARTIAL_MESSAGES_FLAG), "not a required feature: an older CLI still works");
  assert.ok(m.buildClaudeArgs({ model: "", effort: "", partialMessages: true }).includes("--include-partial-messages"));
  assert.ok(!m.buildClaudeArgs({ model: "", effort: "" }).includes("--include-partial-messages"));
  console.log("PASS: stream_event text pieces parsed (thinking and other events ignored); --include-partial-messages is an optional help feature");
}

// The lookup records the optional flags of the CLI it picks.
{
  const s = fakeSession("ok");
  try {
    const found = await m.resolveCliBinary("claude", { configuredPath: FAKE_CLAUDE, checkFeatures: true });
    assert.deepEqual(found.optional, ["--include-partial-messages"], "listed in the fake's help");
    process.env.FAKE_CLAUDE_NO_PARTIAL = "1";
    const older = await m.resolveCliBinary("claude", { configuredPath: FAKE_CLAUDE, checkFeatures: true });
    assert.equal(older.optional, undefined, "an older help without it: no optional features, still usable");
    console.log("PASS: CLI lookup records --include-partial-messages when the help lists it");
  } finally {
    delete process.env.FAKE_CLAUDE_NO_PARTIAL;
    s.cleanup();
  }
}

// Claude streamText: pieces in order, then the final text, usage and model from the result line as before.
{
  const s = fakeSession("ok");
  const job = m.createJobDir();
  const usage = new m.UsageTracker();
  const answer = "슬라이드 17의 **Leftmost Derivation**은 x - (2 * y)로 평가된다 [슬라이드 17]. 시각은 [29:10]이다.";
  process.env.FAKE_CLI_TEXT = answer;
  const make = (features) => new m.ClaudeCliProvider({ bin: FAKE_CLAUDE, model: "sonnet", effort: "low", timeoutMs: 20000, workDir: job, usage, task: "chat", features });
  try {
    const pieces = [];
    const text = await make([m.PARTIAL_MESSAGES_FLAG]).streamText("질문", { systemPrompt: "SYS", onDelta: (t) => pieces.push(t) });
    assert.equal(text, answer);
    assert.ok(pieces.length > 5, `several pieces (${pieces.length})`);
    assert.equal(pieces.join(""), answer, "the pieces in order make the answer");
    const call = s.calls()[0];
    assert.ok(call.argv.includes("--include-partial-messages"), "the flag is passed");
    assert.equal(call.argv[call.argv.indexOf("--system-prompt") + 1], "SYS");
    const rec = usage.entries()[0];
    assert.deepEqual([rec.task, rec.resolvedModel, rec.outputTokens], ["chat", "claude-sonnet-5-5", 100], "usage and the model from the result line");

    // Without the optional feature: no flag, one onDelta with the whole answer at the end.
    const whole = [];
    const text2 = await make([]).streamText("질문", { onDelta: (t) => whole.push(t) });
    assert.equal(text2, answer);
    assert.deepEqual(whole, [answer], "one piece: the whole answer");
    assert.ok(!s.calls()[1].argv.includes("--include-partial-messages"), "the flag is not passed when the help lacks it");
    console.log("PASS: Claude streamText streams text_delta pieces in order; final text, usage and model from the result; without the feature one onDelta at the end");

    // The CLI retries the turn mid-stream (a new message_start after some text): the answer starts over.
    process.env.FAKE_CLI_MODE = "streamretry";
    let shown = "";
    let resets = 0;
    const retried = await make([m.PARTIAL_MESSAGES_FLAG]).streamText("질문", { onDelta: (t) => (shown += t), onReset: () => ((shown = ""), resets++) });
    assert.equal(retried, answer);
    assert.deepEqual([shown, resets], [answer, 1], "the first try's pieces dropped once, then the answer");
    assert.ok(m.isMessageStart('{"type":"stream_event","event":{"type":"message_start","message":{}}}') && !m.isMessageStart('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}}'));
    console.log("PASS: a message_start after streamed text starts the answer over (onReset)");

    // Stop while streaming: the pieces so far arrived, the call is aborted and the process group killed.
    process.env.FAKE_CLI_MODE = "streamhang";
    const ctrl = new AbortController();
    const got = [];
    const p = make([m.PARTIAL_MESSAGES_FLAG]).streamText("질문", { signal: ctrl.signal, onDelta: (t) => got.push(t) });
    for (let i = 0; i < 100 && got.length < 2; i++) await sleep(50);
    assert.deepEqual(got, Array.from(answer).slice(0, 8).join("").match(/.{1,4}/gu), "two pieces before the stop");
    ctrl.abort();
    await assert.rejects(p, (e) => m.isAbortError(e));
    await sleep(300);
    for (const pid of s.pids()) assert.ok(!isAlive(pid), `pid ${pid} killed on stop`);
    console.log("PASS: stopping a streamed answer keeps the pieces received and kills the CLI");
  } finally {
    delete process.env.FAKE_CLI_TEXT;
    m.removeJobDir(job);
    s.cleanup();
  }
}

// Codex: no partial answer; streamText calls onDelta once with the whole answer.
{
  const s = fakeSession("ok");
  const job = m.createJobDir();
  process.env.FAKE_CLI_TEXT = "Codex 답변이다 [슬라이드 3].";
  try {
    const p = new m.CodexCliProvider({ bin: FAKE_CODEX, model: "", effort: "low", timeoutMs: 20000, workDir: job, task: "chat", features: [] });
    const pieces = [];
    const text = await p.streamText("질문", { systemPrompt: "SYS", onDelta: (t) => pieces.push(t) });
    assert.equal(text, "Codex 답변이다 [슬라이드 3].");
    assert.deepEqual(pieces, [text]);
    assert.match(s.calls()[0].stdin, /^Use only the content in this message\..*\nSYS\n\n질문$/s, "instructions lead the stdin prompt");
    console.log("PASS: Codex streamText falls back to one onDelta with the whole answer");
  } finally {
    delete process.env.FAKE_CLI_TEXT;
    m.removeJobDir(job);
    s.cleanup();
  }
}
