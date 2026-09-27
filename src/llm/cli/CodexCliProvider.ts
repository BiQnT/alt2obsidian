// Codex CLI provider (`codex exec`, spec 2.4 and 4.2).
//
// Flags, checked against `codex exec --help` 0.155.1:
//   --json                          JSONL events on stdout; `turn.completed`
//                                   carries usage (input, cached input, output)
//   --output-schema <file>          structured output (spec 4.2 rule 4)
//   -o <file>                       last agent message, a fallback for the text
//   --sandbox read-only             the agent cannot write anywhere
//   -C <jobDir>, --skip-git-repo-check
//                                   work in the per-job temp folder, which is
//                                   not a git repo and has no AGENTS.md
//   --ephemeral                     no session files under ~/.codex
//   --ignore-user-config            skip ~/.codex/config.toml (MCP servers,
//                                   hooks, profiles); auth still uses CODEX_HOME
//   -m, -c model_reasoning_effort="<level>"
//                                   per-task model and effort
//   -i <file>...                    slide images (last on the command line,
//                                   since the option takes several values)
// Codex has no system prompt flag, so the fixed instructions lead the stdin
// prompt, which keeps the shared prefix identical across batches.

import { readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { LLMUsage } from "../../types";
import { CliCall, CliCallResult, CliProviderBase } from "./CliProviderBase";
import { CliRunError, runCli } from "./CliRunner";

export interface CodexArgsInput {
  model: string;
  effort: string;
  schemaPath?: string;
  imagePaths: string[];
  workDir: string;
  lastMessagePath: string;
}

export function buildCodexArgs(input: CodexArgsInput): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "-C",
    input.workDir,
    "-o",
    input.lastMessagePath,
  ];
  if (input.model) args.push("-m", input.model);
  if (input.effort) args.push("-c", `model_reasoning_effort="${input.effort}"`);
  if (input.schemaPath) args.push("--output-schema", input.schemaPath);
  if (input.imagePaths.length > 0) args.push("-i", ...input.imagePaths);
  return args;
}

export function codexPrompt(prompt: string, systemPrompt?: string): string {
  return systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${prompt}` : prompt;
}

/** Parse `codex exec --json` JSONL. Throws when the turn failed. */
export function parseCodexEvents(stdout: string, lastMessage = ""): CliCallResult {
  let text = "";
  let failure = "";
  const usage: LLMUsage = { calls: 1, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, imagesSent: 0, costUsd: 0 };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
      text = ev.item.text;
    } else if (ev.type === "turn.completed" && ev.usage) {
      usage.inputTokens += Number(ev.usage.input_tokens ?? 0);
      usage.cachedInputTokens += Number(ev.usage.cached_input_tokens ?? 0);
      usage.outputTokens += Number(ev.usage.output_tokens ?? 0);
    } else if (ev.type === "turn.failed") {
      failure = String(ev.error?.message ?? "turn failed");
    } else if (ev.type === "error") {
      failure = String(ev.message ?? "error");
    }
  }
  if (!text && lastMessage.trim()) text = lastMessage;
  if (failure && !text) throw new CliRunError("exit", `Codex CLI 오류: ${failure.slice(0, 300)}`, "", stdout);
  if (!text) throw new Error(`Codex CLI 출력에서 응답을 찾지 못했습니다: ${stdout.slice(0, 200)}`);
  return { text, usage };
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

let lastMessageCounter = 0;

export class CodexCliProvider extends CliProviderBase {
  name = "Codex CLI";
  maxInputTokens = 272000;
  readonly providerId = "codex-cli" as const;

  protected async invoke(call: CliCall, files: { images: string[]; schema?: string }): Promise<CliCallResult> {
    const lastMessagePath = join(this.config.workDir, `last-message-${++lastMessageCounter}.txt`);
    const args = buildCodexArgs({
      model: this.config.model,
      effort: this.config.effort,
      schemaPath: files.schema,
      imagePaths: files.images,
      workDir: this.config.workDir,
      lastMessagePath,
    });
    try {
      const out = await runCli({
        bin: this.config.bin,
        args,
        input: codexPrompt(call.prompt, call.systemPrompt),
        cwd: this.config.workDir,
        timeoutMs: this.config.timeoutMs,
        signal: call.signal,
      });
      return parseCodexEvents(out.stdout, readIfExists(lastMessagePath));
    } catch (e) {
      if (e instanceof CliRunError && e.kind === "exit" && e.stdout) {
        try {
          parseCodexEvents(e.stdout);
        } catch (parsed) {
          if (parsed instanceof Error) e.message = parsed.message;
        }
      }
      throw e;
    } finally {
      try {
        unlinkSync(lastMessagePath);
      } catch {
        // not written
      }
    }
  }
}
