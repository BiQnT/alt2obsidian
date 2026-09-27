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
//   -c <key>=<value>                trims Codex's own prompt; every key below
//                                   was accepted by `codex exec --strict-config`
//                                   (unknown keys are ignored without it, so a
//                                   later CLI that drops one still runs):
//                                   project_doc_max_bytes=0 (no project
//                                   AGENTS.md), include_environment_context,
//                                   include_permissions_instructions,
//                                   include_apps_instructions,
//                                   include_collaboration_mode_instructions,
//                                   skills.include_instructions = false,
//                                   features.plugins/apps/multi_agent/memories
//                                   = false, web_search = "disabled"
// The global ~/.codex/AGENTS.md has no documented off switch short of moving
// CODEX_HOME (which would break auth), so it stays; see README.
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

/** Config overrides that shrink Codex's fixed per-call prompt (see header). */
export const CODEX_TRIM_CONFIG = [
  "project_doc_max_bytes=0",
  "include_environment_context=false",
  "include_permissions_instructions=false",
  "include_apps_instructions=false",
  "include_collaboration_mode_instructions=false",
  "skills.include_instructions=false",
  "features.plugins=false",
  "features.apps=false",
  "features.multi_agent=false",
  "features.memories=false",
  'web_search="disabled"',
];

/**
 * Codex's read-only sandbox still lets the agent read any file the user can
 * read. The first line of every prompt tells it to use only the given
 * content (accepted risk, documented in README and settings).
 */
export const CODEX_CONTENT_ONLY =
  "Use only the content in this message. Do not run commands, read files, or browse.";

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
  for (const kv of CODEX_TRIM_CONFIG) args.push("-c", kv);
  if (input.model) args.push("-m", input.model);
  if (input.effort) args.push("-c", `model_reasoning_effort="${input.effort}"`);
  if (input.schemaPath) args.push("--output-schema", input.schemaPath);
  if (input.imagePaths.length > 0) args.push("-i", ...input.imagePaths);
  return args;
}

export function codexPrompt(prompt: string, systemPrompt?: string): string {
  const head = systemPrompt?.trim() ? `${CODEX_CONTENT_ONLY}\n${systemPrompt.trim()}` : CODEX_CONTENT_ONLY;
  return `${head}\n\n${prompt}`;
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
  if (failure && !text) {
    const err = new CliRunError("exit", `Codex CLI 오류: ${failure.slice(0, 300)}`, "", stdout);
    err.cliError = failure;
    throw err;
  }
  if (!text) throw new CliRunError("exit", "Codex CLI 출력에서 응답을 찾지 못했습니다", "", stdout);
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
        timeoutMs: Math.round(this.config.timeoutMs * Math.max(1, call.timeoutScale ?? 1)),
        signal: call.signal,
      });
      return parseCodexEvents(out.stdout, readIfExists(lastMessagePath));
    } catch (e) {
      if (e instanceof CliRunError && e.kind === "exit" && e.stdout) {
        try {
          parseCodexEvents(e.stdout);
        } catch (parsed) {
          if (parsed instanceof Error) e.message = parsed.message;
          if (parsed instanceof CliRunError) e.cliError = parsed.cliError;
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
