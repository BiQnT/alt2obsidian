// Shared logic of the fake `claude` and `codex` executables used by the tests.
// They check the arguments the providers pass (so a wrong flag fails the
// test), read the prompt from stdin, and print canned output in the real
// CLI's format. No network, no tokens.
//
// Environment:
//   FAKE_CLI_LOG      append one JSON line per call {cli, argv, cwd, stdin, images}
//   FAKE_CLI_STATE    JSON file for per-test counters (retry scenarios)
//   FAKE_CLI_MODE     comma-separated: ok | drop:<page> | dropalways:<page> |
//                     short:<page> | hang | limit | badjson
//   FAKE_CLI_PIDFILE  (hang) the fake and its child write their pids here

"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function fail(msg, code = 2) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function readState() {
  const f = process.env.FAKE_CLI_STATE;
  if (!f) return { calls: 0, seen: {} };
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return { calls: 0, seen: {} };
  }
}

function writeState(state) {
  if (process.env.FAKE_CLI_STATE) fs.writeFileSync(process.env.FAKE_CLI_STATE, JSON.stringify(state));
}

function modes() {
  return (process.env.FAKE_CLI_MODE || "ok").split(",").map((m) => m.trim()).filter(Boolean);
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function checkJobDir(cwd) {
  if (!path.basename(cwd).startsWith("alt2obs-")) fail(`cwd is not a per-job temp folder: ${cwd}`);
}

/** Answer for the prompt, as an object (structured) or text. */
function answer(stdin, schema) {
  const state = readState();
  state.calls = (state.calls || 0) + 1;
  state.seen = state.seen || {};
  const ms = modes();
  let result;
  if (schema && schema.properties && schema.properties.slides) {
    const slides = [];
    const re = /^### 슬라이드 (\d+) \((\w+)\)/gm;
    let m;
    while ((m = re.exec(stdin)) !== null) {
      const page = Number(m[1]);
      const kind = m[2];
      const seen = (state.seen[page] = (state.seen[page] || 0) + 1);
      if (ms.includes(`dropalways:${page}`)) continue;
      if (ms.includes(`drop:${page}`) && seen === 1) continue;
      const short = ms.includes(`short:${page}`) && seen === 1;
      const body = short ? "짧음" : `슬라이드 ${page} 해설. [[캐시]]를 설명합니다. ` + "가".repeat(kind === "visual" ? 400 : 250);
      slides.push({ slide: page, commentary: body, gist: `슬라이드 ${page}의 요지` });
    }
    result = { slides };
  } else if (schema && schema.properties && schema.properties.concepts) {
    result = {
      concepts: [
        { name: "캐시", definition: "자주 쓰는 데이터를 가까이 두는 빠른 메모리. ".repeat(4), lectureContext: "p.2에서 소개.", example: "", caution: "", relatedConcepts: ["캐시 일관성"] },
        { name: "캐시 일관성", definition: "여러 캐시가 같은 주소에 대해 같은 값을 보게 하는 성질. ".repeat(3), lectureContext: "p.3", example: "MESI", caution: "", relatedConcepts: ["캐시"] },
      ],
      tags: ["cache", "memory"],
    };
  } else if (schema) {
    result = { ok: true };
  } else {
    result = `## 개요\n- 요약 텍스트 (호출 ${state.calls})`;
  }
  writeState(state);
  const inputTokens = Math.ceil(stdin.length / 3);
  return {
    result,
    usage: { input: inputTokens, cached: state.calls > 1 ? Math.floor(inputTokens / 2) : 0, output: 100 },
    call: state.calls,
  };
}

function hang() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (process.env.FAKE_CLI_PIDFILE) fs.writeFileSync(process.env.FAKE_CLI_PIDFILE, `${process.pid} ${child.pid}`);
  setInterval(() => {}, 1000);
}

function log(entry) {
  if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(entry) + "\n");
}

// ---- claude ----

const CLAUDE_BOOL = new Set(["-p", "--no-session-persistence", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands"]);
const CLAUDE_VALUE = new Set(["--output-format", "--setting-sources", "--system-prompt", "--tools", "--allowedTools", "--add-dir", "--model", "--effort", "--json-schema"]);

function runClaude() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version") {
    process.stdout.write("2.1.283 (Claude Code)\n");
    return;
  }
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (CLAUDE_BOOL.has(a)) flags[a] = true;
    else if (CLAUDE_VALUE.has(a)) {
      if (i + 1 >= argv.length) fail(`option '${a}' argument missing`);
      flags[a] = argv[++i];
    } else fail(`unknown option '${a}'`);
  }
  for (const req of ["-p", "--no-session-persistence", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands"]) {
    if (!flags[req]) fail(`missing ${req}`);
  }
  if (flags["--output-format"] !== "json") fail("--output-format must be json");
  if (flags["--setting-sources"] !== "") fail("--setting-sources must be empty");
  if (!flags["--system-prompt"]) fail("--system-prompt missing");
  if (flags["--effort"] !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(flags["--effort"])) {
    fail(`invalid effort ${flags["--effort"]}`);
  }
  let schema = null;
  if (flags["--json-schema"] !== undefined) {
    schema = JSON.parse(flags["--json-schema"]);
    if (schema.type !== "object") fail("schema must be an object schema");
  }
  const cwd = fs.realpathSync(process.cwd());
  checkJobDir(cwd);
  const stdin = readStdin();
  const images = [...stdin.matchAll(/^- 슬라이드 \d+: (.+)$/gm)].map((m) => m[1]);
  if (flags["--tools"] === "Read") {
    if (flags["--allowedTools"] !== "Read") fail("--allowedTools Read expected with images");
    if (flags["--add-dir"] !== cwd) fail(`--add-dir must be the job dir ${cwd}, got ${flags["--add-dir"]}`);
    if (images.length === 0) fail("Read enabled but no image files listed");
    for (const f of images) if (!fs.existsSync(f) || path.dirname(f) !== cwd) fail(`image not in job dir: ${f}`);
  } else if (flags["--tools"] === "") {
    if (images.length > 0 || flags["--add-dir"] !== undefined) fail("images listed but tools disabled");
  } else fail(`--tools must be "" or Read, got ${flags["--tools"]}`);
  log({ cli: "claude", argv, cwd, stdin, images });

  const ms = modes();
  if (ms.includes("hang")) return hang();
  if (ms.includes("limit")) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Your limit resets at 5pm." }));
    process.exit(1);
  }
  const a = answer(stdin, schema);
  const out = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: images.length > 0 ? 2 : 1,
    result: ms.includes("badjson") ? "이건 JSON이 아님" : typeof a.result === "string" ? a.result : JSON.stringify(a.result),
    total_cost_usd: 0.001,
    usage: {
      input_tokens: a.usage.input - a.usage.cached,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: a.usage.cached,
      output_tokens: a.usage.output,
    },
  };
  if (schema && !ms.includes("badjson")) out.structured_output = a.result;
  process.stdout.write(JSON.stringify(out));
}

// ---- codex ----

function runCodex() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version") {
    process.stdout.write("codex-cli 0.155.1\n");
    return;
  }
  if (argv[0] !== "exec") fail("expected exec subcommand");
  const flags = {};
  let images = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (["--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config"].includes(a)) flags[a] = true;
    else if (["--sandbox", "-C", "-o", "-m", "-c", "--output-schema"].includes(a)) {
      if (i + 1 >= argv.length) fail(`a value is required for '${a}'`);
      flags[a] = argv[++i];
    } else if (a === "-i") {
      images = argv.slice(i + 1);
      if (images.length === 0) fail("-i needs files");
      break;
    } else fail(`unexpected argument '${a}'`);
  }
  for (const req of ["--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config"]) if (!flags[req]) fail(`missing ${req}`);
  if (flags["--sandbox"] !== "read-only") fail("--sandbox read-only expected");
  const cwd = fs.realpathSync(process.cwd());
  if (flags["-C"] !== cwd) fail(`-C must equal cwd ${cwd}`);
  checkJobDir(cwd);
  if (!flags["-o"]) fail("-o missing");
  if (flags["-c"] !== undefined && !/^model_reasoning_effort="(low|medium|high|xhigh|max)"$/.test(flags["-c"])) fail(`bad -c ${flags["-c"]}`);
  let schema = null;
  if (flags["--output-schema"] !== undefined) schema = JSON.parse(fs.readFileSync(flags["--output-schema"], "utf8"));
  for (const f of images) if (!fs.existsSync(f)) fail(`image missing: ${f}`);
  const stdin = readStdin();
  log({ cli: "codex", argv, cwd, stdin, images });

  const ms = modes();
  if (ms.includes("hang")) return hang();
  const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
  emit({ type: "thread.started", thread_id: "fake" });
  emit({ type: "turn.started" });
  if (ms.includes("limit")) {
    emit({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } });
    process.exit(1);
  }
  const a = answer(stdin, schema);
  const text = ms.includes("badjson") ? "이건 JSON이 아님" : typeof a.result === "string" ? a.result : JSON.stringify(a.result);
  emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } });
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
  emit({ type: "turn.completed", usage: { input_tokens: a.usage.input, cached_input_tokens: a.usage.cached, output_tokens: a.usage.output, reasoning_output_tokens: 10 } });
  fs.writeFileSync(flags["-o"], text);
}

module.exports = { runClaude, runCodex };
