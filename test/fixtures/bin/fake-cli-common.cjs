// Shared logic of the fake `claude` and `codex` executables used by the tests.
// They check the arguments the providers pass (so a wrong flag fails the
// test), read the prompt from stdin, and print canned output in the real
// CLI's format. No network, no tokens.
//
// Environment:
//   FAKE_CLI_LOG      append one JSON line per call {cli, argv, cwd, stdin, images}
//   FAKE_CLI_STATE    JSON file for per-test counters (retry scenarios)
//   FAKE_CLI_MODE     comma-separated: ok | drop:<page> | dropalways:<page> |
//                     short:<page> | hang | limit | badjson | textlimit |
//                     crash | loggedout | hangbig:<n> (hang when the batch has more than n slides)
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
  } else if (schema && schema.properties && schema.properties.parts) {
    // Alignment check: move every part to its first candidate that is not the current guess.
    const parts = [];
    for (const block of stdin.split(/\n(?=\[part \d+\])/)) {
      const head = block.match(/^\[part (\d+)\] current guess: slide (\d+)/m);
      if (!head) continue;
      const cands = [...block.matchAll(/^  - 슬라이드 (\d+):/gm)].map((x) => Number(x[1]));
      const other = cands.find((c) => c !== Number(head[2]));
      parts.push({ id: Number(head[1]), slide: other ?? Number(head[2]) });
    }
    result = { parts };
  } else if (schema && schema.properties && schema.properties.results) {
    // Note verification: "틀림" for claims that say 거짓, "전사 불확실" for 잡음, else "맞음".
    const results = [];
    const re = /^### 주장 (\d+)\n(.*)$/gm;
    let m;
    while ((m = re.exec(stdin)) !== null) {
      const id = Number(m[1]);
      const seen = (state.seen[`c${id}`] = (state.seen[`c${id}`] || 0) + 1);
      if (ms.includes(`dropclaim:${id}`) && seen === 1) continue;
      const v = /거짓/.test(m[2]) ? "틀림" : /잡음/.test(m[2]) ? "전사 불확실" : "맞음";
      results.push({ id, v, r: `근거와 비교함 (${v})` });
    }
    result = { results };
  } else if (schema && schema.properties && schema.properties.missing) {
    const first = stdin.match(/^- 슬라이드 (\d+):/m);
    result = { missing: first ? [{ s: Number(first[1]), r: "노트에 없음" }] : [] };
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

/** hangbig:<n>: true when this prompt carries more than n slides. */
function hangsForBatch(stdin) {
  const m = modes().find((x) => x.startsWith("hangbig:"));
  if (!m) return false;
  const n = (stdin.match(/^### 슬라이드 \d+/gm) || []).length;
  return n > Number(m.split(":")[1]);
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

const CLAUDE_BOOL = new Set(["-p", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands"]);
const CLAUDE_VALUE = new Set(["--input-format", "--output-format", "--setting-sources", "--system-prompt", "--tools", "--model", "--effort", "--permission-mode", "--allowedTools", "--disallowedTools"]);

// Notion MCP (FAKE_NOTION_MCP=connected|failed|none, default none).
function runClaudeMcpList() {
  const state = process.env.FAKE_NOTION_MCP || "none";
  log({ cli: "claude", argv: ["mcp", "list"], cwd: process.cwd(), stdin: "" });
  process.stdout.write("Checking MCP server health…\n\n");
  process.stdout.write("claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected\n");
  if (state === "connected") process.stdout.write("notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected\n");
  if (state === "failed") process.stdout.write("notion: https://mcp.notion.com/mcp (HTTP) - ✘ Failed to connect\n");
}

/** The Notion fetch call: only the Notion tool, the user's MCP config kept. */
function checkNotionFlags(flags) {
  if (flags["--strict-mcp-config"] || flags["--safe-mode"]) fail("the Notion call must keep the user's MCP servers");
  if (flags["--tools"] !== "") fail("--tools must be \"\" (no built-in tools)");
  if (flags["--permission-mode"] !== "dontAsk") fail("--permission-mode dontAsk expected");
  if (!/^mcp__[A-Za-z0-9_-]+__notion-fetch$/.test(flags["--allowedTools"])) fail(`only the Notion fetch tool may be allowed, got ${flags["--allowedTools"]}`);
  if (flags["--setting-sources"] !== "user") fail("--setting-sources user expected");
  const server = flags["--allowedTools"].slice(0, flags["--allowedTools"].lastIndexOf("__") + 2);
  const denied = (flags["--disallowedTools"] || "").split(",");
  for (const t of ["notion-update-page", "notion-create-pages", "notion-move-pages"]) if (!denied.includes(server + t)) fail(`${server + t} must be denied`);
}

function notionAnswer(stdin) {
  const edited = process.env.FAKE_NOTION_EDITED || "2026-09-20T10:00:00.000Z";
  const cached = (stdin.match(/exactly `([^`]*)`/) || [])[1];
  if (process.env.FAKE_NOTION_ERROR) return `ERROR: ${process.env.FAKE_NOTION_ERROR}`;
  if (cached === edited) return `last_edited_time: ${edited}\nUNCHANGED`;
  const page = process.env.FAKE_NOTION_PAGE || "# 13강 노트\n\n- 캐시는 SRAM으로 만든다\n- DRAM은 SRAM보다 빠르다 (거짓)";
  return `last_edited_time: ${edited}\n---\n${page}`;
}

function runClaude() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version") {
    process.stdout.write("2.1.283 (Claude Code)\n");
    return;
  }
  if (argv[0] === "mcp" && argv[1] === "list") return runClaudeMcpList();
  if (argv[0] === "auth" && argv[1] === "status") {
    const loggedIn = process.env.FAKE_CLAUDE_LOGGED_OUT !== "1";
    process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" }));
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
  const notion = flags["--allowedTools"] !== undefined;
  const required = notion ? ["-p", "--verbose", "--no-session-persistence", "--disable-slash-commands"] : ["-p", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands"];
  if (notion) checkNotionFlags(flags);
  else if (flags["--permission-mode"] !== undefined) fail("--permission-mode is only for the Notion call");
  for (const req of required) {
    if (!flags[req]) fail(`missing ${req}`);
  }
  if (flags["--input-format"] !== "stream-json") fail("--input-format must be stream-json");
  if (flags["--output-format"] !== "stream-json") fail("--input-format=stream-json requires output-format=stream-json");
  if (!notion && flags["--setting-sources"] !== "") fail("--setting-sources must be empty");
  if (flags["--tools"] !== "") fail(`--tools must be "" (no tools), got ${flags["--tools"]}`);
  if (!flags["--system-prompt"]) fail("--system-prompt missing");
  if (flags["--effort"] !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(flags["--effort"])) {
    fail(`invalid effort ${flags["--effort"]}`);
  }
  if (flags["--model"] !== undefined && flags["--model"].startsWith("-")) fail("model looks like a flag");
  const cwd = fs.realpathSync(process.cwd());
  checkJobDir(cwd);
  const raw = readStdin().trim();
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    fail("stdin must be one stream-json user message");
  }
  if (msg.type !== "user" || msg.message?.role !== "user" || !Array.isArray(msg.message.content)) fail("bad user message");
  const texts = msg.message.content.filter((c) => c.type === "text").map((c) => c.text);
  const images = msg.message.content.filter((c) => c.type === "image");
  for (const img of images) {
    if (img.source?.type !== "base64" || !/^image\/(png|jpeg)$/.test(img.source.media_type) || !img.source.data) fail("bad image block");
  }
  const stdin = texts[0] ?? "";
  // The JSON format is asked in the prompt: the schema is the last line.
  let schema = null;
  const marker = stdin.lastIndexOf("[출력 형식]");
  if (marker >= 0) schema = JSON.parse(stdin.slice(marker).split("\n").pop());
  log({ cli: "claude", argv, cwd, stdin, images: images.map((i) => i.source.media_type) });

  const ms = modes();
  if (ms.includes("hang") || hangsForBatch(stdin)) return hang();
  const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
  emit({ type: "system", subtype: "init", model: flags["--model"] ?? "default" });
  if (ms.includes("limit")) {
    emit({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Your limit resets at 5pm." });
    process.exit(1);
  }
  if (ms.includes("loggedout")) {
    emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in. Please run /login" });
    process.exit(1);
  }
  if (ms.includes("crash")) {
    process.stderr.write("internal error\n");
    process.exit(3);
  }
  const a = answer(stdin, schema);
  const text = notion
    ? notionAnswer(stdin)
    : ms.includes("badjson")
    ? "이건 JSON이 아님"
    : ms.includes("textlimit")
      ? "Sorry, I reached my usage limit on this topic."
    : typeof a.result === "string"
      ? a.result
      : "```json\n" + JSON.stringify(a.result) + "\n```";
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const modelName = flags["--model"] ?? "claude-default";
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: text,
    total_cost_usd: 0.001,
    usage: { input_tokens: a.usage.input - a.usage.cached, cache_creation_input_tokens: 0, cache_read_input_tokens: a.usage.cached, output_tokens: a.usage.output },
    modelUsage: {
      [modelName]: { inputTokens: a.usage.input - a.usage.cached, outputTokens: a.usage.output, cacheReadInputTokens: a.usage.cached, cacheCreationInputTokens: 0 },
    },
  });
}

// ---- codex ----

function runCodex() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version") {
    process.stdout.write("codex-cli 0.155.1\n");
    return;
  }
  if (argv[0] === "login" && argv[1] === "status") {
    process.stderr.write("Logged in using ChatGPT\n");
    return;
  }
  if (argv[0] !== "exec") fail("expected exec subcommand");
  const flags = {};
  let images = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (["--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config"].includes(a)) flags[a] = true;
    else if (a === "-c") {
      if (i + 1 >= argv.length) fail("a value is required for '-c'");
      const kv = argv[++i];
      if (!/^[a-z_.]+=/.test(kv)) fail(`bad -c ${kv}`);
      if (kv.startsWith("model_reasoning_effort=")) flags["-c"] = kv;
      else (flags.trim = flags.trim || []).push(kv);
    } else if (["--sandbox", "-C", "-o", "-m", "--output-schema"].includes(a)) {
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
  if (!(flags.trim || []).includes("project_doc_max_bytes=0")) fail("trim config missing");
  const stdin = readStdin();
  if (!stdin.startsWith("Use only the content in this message.")) fail("content-only instruction missing");
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
  if (ms.includes("crash")) {
    process.stderr.write("internal error\n");
    process.exit(3);
  }
  const a = answer(stdin, schema);
  const text = ms.includes("badjson") ? "이건 JSON이 아님" : typeof a.result === "string" ? a.result : JSON.stringify(a.result);
  emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } });
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
  emit({ type: "turn.completed", usage: { input_tokens: a.usage.input, cached_input_tokens: a.usage.cached, output_tokens: a.usage.output, reasoning_output_tokens: 10 } });
  fs.writeFileSync(flags["-o"], text);
}

module.exports = { runClaude, runCodex };
