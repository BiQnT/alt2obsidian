/**
 * Opt-in smoke test against the REAL claude and codex CLIs. Spends a few
 * thousand tokens of your subscription, cheapest model, low effort:
 *   claude  one call: stream-json input with the 8x8 image inline, tools
 *           off, JSON format asked in the prompt (the batch path)
 *   codex   one --output-schema call with the image and the trim config
 * It checks that the command lines the providers build are accepted, that
 * the schema answer and usage come back, and that images get through.
 *
 * Run: ALT2OBS_SMOKE=1 node test/smoke-cli.mjs
 * Options (env): ALT2OBS_SMOKE_CLAUDE_MODEL (default haiku),
 *                ALT2OBS_SMOKE_CODEX_MODEL (default gpt-5.6-luna),
 *                ALT2OBS_SMOKE_ONLY=claude|codex
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { importTs } from "./helpers/bundle-ts.mjs";

if (process.env.ALT2OBS_SMOKE !== "1") {
  console.log("SKIP: set ALT2OBS_SMOKE=1 to call the real claude/codex CLIs (spends tokens)");
  process.exit(0);
}

const m = await importTs("test/helpers/cli-entry.ts");
const only = process.env.ALT2OBS_SMOKE_ONLY;

/** 8x8 solid red PNG. */
function redPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0]);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill([255, 0, 0]).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["word", "color"],
  properties: { word: { type: "string" }, color: { type: "string" } },
};
const SYSTEM = "You are a test responder. Answer only with the requested JSON.";
const PROMPT = 'Set "word" to "pong". Set "color" to the main color of the attached image, one lowercase English word.';

async function smokeClaude() {
  const bin = (await m.resolveCliBinary("claude", { configuredPath: "" })).path;
  const version = await m.readCliVersion(bin);
  const job = m.createJobDir();
  try {
    const args = m.buildClaudeArgs({ model: process.env.ALT2OBS_SMOKE_CLAUDE_MODEL ?? "haiku", effort: "low", systemPrompt: SYSTEM });
    const input = m.buildClaudeInput({
      prompt: PROMPT,
      schema: SCHEMA,
      images: [{ pageNum: 1, mimeType: "image/png", base64: redPng().toString("base64") }],
    });
    const started = Date.now();
    const out = await m.runCli({ bin, args, input, cwd: job, timeoutMs: 180000 });
    const raw = m.findClaudeResult(out.stdout);
    const parsed = m.parseClaudeOutput(out.stdout);
    console.log(`claude ${version} at ${bin}`);
    console.log(`  args: ${JSON.stringify(args)}`);
    console.log(`  stdout lines: ${out.stdout.trim().split("\n").length}, num_turns: ${raw.num_turns}, duration: ${Date.now() - started} ms`);
    console.log(`  result text: ${parsed.text}`);
    console.log(`  raw usage: ${JSON.stringify(raw.usage)}`);
    console.log(`  modelUsage: ${JSON.stringify(raw.modelUsage)}`);
    console.log(`  usage (from modelUsage): ${JSON.stringify(parsed.usage)}`);
    const answer = JSON.parse(parsed.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    assert.equal(answer.word, "pong");
    assert.match(String(answer.color), /red/);
    assert.equal(raw.num_turns, 1, "no tool turn: images inline, schema in the prompt");
    return parsed.usage;
  } finally {
    m.removeJobDir(job);
  }
}

async function smokeCodex() {
  const bin = (await m.resolveCliBinary("codex", { configuredPath: "" })).path;
  const version = await m.readCliVersion(bin);
  const job = m.createJobDir();
  try {
    const img = join(job, "slide-1.png");
    writeFileSync(img, redPng());
    const schemaPath = join(job, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(SCHEMA));
    const lastMessagePath = join(job, "last.txt");
    const args = m.buildCodexArgs({
      model: process.env.ALT2OBS_SMOKE_CODEX_MODEL ?? "gpt-5.6-luna",
      effort: "low",
      schemaPath,
      imagePaths: [img],
      workDir: job,
      lastMessagePath,
    });
    const started = Date.now();
    const out = await m.runCli({ bin, args, input: m.codexPrompt(PROMPT, SYSTEM), cwd: job, timeoutMs: 180000 });
    const parsed = m.parseCodexEvents(out.stdout);
    console.log(`codex ${version} at ${bin}`);
    console.log(`  args: ${JSON.stringify(args)}`);
    console.log(`  event types: ${[...new Set(out.stdout.trim().split("\n").map((l) => { try { return JSON.parse(l).type; } catch { return "(non-json)"; } }))].join(", ")}`);
    console.log(`  duration: ${Date.now() - started} ms`);
    console.log(`  answer: ${parsed.text}`);
    console.log(`  turn.completed usage: ${out.stdout.split("\n").filter((l) => l.includes("turn.completed")).join(" ")}`);
    console.log(`  usage: ${JSON.stringify(parsed.usage)}`);
    const answer = JSON.parse(parsed.text);
    assert.equal(answer.word, "pong");
    assert.match(String(answer.color), /red/);
    return parsed.usage;
  } finally {
    m.removeJobDir(job);
  }
}

if (!only || only === "claude") {
  await smokeClaude();
  console.log("PASS: claude CLI stream-json input with an inline image, one turn, JSON answer from the prompt, usage");
}
if (!only || only === "codex") {
  await smokeCodex();
  console.log("PASS: codex CLI flags, output schema, -i image, JSONL usage");
}
