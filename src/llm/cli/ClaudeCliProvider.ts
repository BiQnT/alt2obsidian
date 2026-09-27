// Claude Code CLI provider (`claude -p`, spec 2.4 and 4.2).
//
// Flags, checked against `claude --help` 2.1.283 and smoke-tested:
//   -p --input-format stream-json   the prompt is one user message on stdin,
//                                   as API content blocks: text plus base64
//                                   images inline, so no tool is needed to
//                                   read slide images
//   --output-format stream-json --verbose
//                                   required with stream-json input; the last
//                                   line is the result event (`result`,
//                                   `usage`, `modelUsage`, `total_cost_usd`)
//   --system-prompt <text>          replaces the default coding-agent prompt:
//                                   the fixed instructions are ours and cacheable
//   --tools ""                      no tools at all, so every call is a single
//                                   model turn and the model cannot touch files
//   --no-session-persistence        nothing saved under ~/.claude
//   --setting-sources ""            no user/project/local settings
//   --strict-mcp-config             no MCP servers
//   --safe-mode                     no CLAUDE.md, skills, plugins, hooks;
//                                   auth and model selection work normally
//   --disable-slash-commands        no skill listing in the prompt
//   --model, --effort               per-task settings
// `--json-schema` is not used: Claude answers it through an extra tool turn
// that re-sends the whole prompt (measured: 2 turns instead of 1). The
// answer format is stated in the prompt and validated in code instead.

import { LLMUsage } from "../../types";
import { CliCall, CliCallResult, CliProviderBase } from "./CliProviderBase";
import { CliRunError, runCli } from "./CliRunner";

export interface ClaudeArgsInput {
  model: string;
  effort: string;
  systemPrompt?: string;
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--safe-mode",
    "--disable-slash-commands",
    "--system-prompt",
    input.systemPrompt?.trim() || "You are a helpful assistant.",
    "--tools",
    "",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  return args;
}

/** Appended last (after the per-call content) so the cached prefix stays identical. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return (
    "\n\n[출력 형식] 다음 JSON 스키마를 따르는 JSON 객체 하나만 출력하시오. 코드 블록이나 설명 없이 JSON만.\n" +
    JSON.stringify(schema)
  );
}

/** One stream-json user message: the prompt text, then the images as base64 blocks. */
export function buildClaudeInput(call: Pick<CliCall, "prompt" | "schema" | "images">): string {
  const text = call.prompt + (call.schema ? schemaInstruction(call.schema) : "");
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const img of call.images ?? []) {
    content.push({ type: "text", text: `[슬라이드 ${img.pageNum} 이미지]` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.base64 } });
  }
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, ModelUsageEntry>;
}

/** The result event: last `{"type":"result"}` line of stream-json (or a single JSON result). */
export function findClaudeResult(stdout: string): ClaudeJsonResult | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && obj.type === "result") return obj as ClaudeJsonResult;
    } catch {
      // not a JSON line
    }
  }
  return null;
}

/**
 * Usage of the whole call. `modelUsage` sums every turn and every model the
 * CLI used, so it is preferred; `usage` is the fallback when it is absent.
 */
export function claudeUsage(res: ClaudeJsonResult): LLMUsage {
  const models = Object.values(res.modelUsage ?? {});
  if (models.length > 0) {
    let input = 0;
    let cached = 0;
    let output = 0;
    for (const m of models) {
      input += (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
      cached += m.cacheReadInputTokens ?? 0;
      output += m.outputTokens ?? 0;
    }
    return { calls: 1, inputTokens: input, cachedInputTokens: cached, outputTokens: output, imagesSent: 0, costUsd: res.total_cost_usd ?? 0 };
  }
  const u = res.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  return {
    calls: 1,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached,
    cachedInputTokens: cached,
    outputTokens: u.output_tokens ?? 0,
    imagesSent: 0,
    costUsd: res.total_cost_usd ?? 0,
  };
}

/** Parse `claude -p --output-format stream-json` stdout. Throws on an error result. */
export function parseClaudeOutput(stdout: string): CliCallResult {
  const res = findClaudeResult(stdout);
  if (!res) throw new CliRunError("exit", "Claude CLI 출력에서 결과를 찾지 못했습니다", "", stdout);
  if (res.is_error || (res.subtype && res.subtype !== "success")) {
    const err = new CliRunError(
      "exit",
      `Claude CLI 오류 (${res.subtype ?? "error"}): ${String(res.result ?? "").slice(0, 300)}`,
      "",
      stdout
    );
    // With is_error the result field is the CLI's error message, not model text.
    err.cliError = String(res.result ?? res.subtype ?? "");
    throw err;
  }
  return { text: typeof res.result === "string" ? res.result : "", usage: claudeUsage(res) };
}

export class ClaudeCliProvider extends CliProviderBase {
  name = "Claude CLI";
  maxInputTokens = 200000;
  readonly providerId = "claude-cli" as const;
  protected usesFiles = false;

  protected async invoke(call: CliCall): Promise<CliCallResult> {
    const args = buildClaudeArgs({ model: this.config.model, effort: this.config.effort, systemPrompt: call.systemPrompt });
    try {
      const out = await runCli({
        bin: this.config.bin,
        args,
        input: buildClaudeInput(call),
        cwd: this.config.workDir,
        timeoutMs: this.config.timeoutMs,
        signal: call.signal,
      });
      return parseClaudeOutput(out.stdout);
    } catch (e) {
      // A non-zero exit often still prints the result event with the reason.
      if (e instanceof CliRunError && e.kind === "exit" && e.stdout) {
        const res = findClaudeResult(e.stdout);
        if (res?.result) {
          e.message = `Claude CLI 오류: ${String(res.result).slice(0, 300)}`;
          e.cliError = String(res.result);
        }
      }
      throw e;
    }
  }
}
