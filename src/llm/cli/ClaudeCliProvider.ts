// Claude Code CLI provider (`claude -p`, spec 2.4 and 4.2).
//
// Flags, checked against `claude --help` 2.1.283:
//   -p --output-format json         one JSON result with `result`, `usage`,
//                                   `total_cost_usd`, and `structured_output`
//                                   when --json-schema is given
//   --json-schema <schema>          structured output (spec 4.2 rule 4)
//   --system-prompt <text>          replaces the default coding-agent prompt:
//                                   the fixed instructions are ours and cacheable
//   --tools "" | Read               no tools, or Read only for slide images
//   --add-dir <jobDir>              the only extra folder Read may open
//   --no-session-persistence        nothing saved under ~/.claude
//   --setting-sources ""            no user/project/local settings (hooks,
//                                   plugins, permissions from the vault's user)
//   --strict-mcp-config             no MCP servers (none given via --mcp-config)
//   --safe-mode                     no CLAUDE.md, skills, plugins, hooks;
//                                   auth and model selection work normally
//   --disable-slash-commands        no skill listing in the prompt
//   --model, --effort               per-task settings
// The prompt goes through stdin; cwd is the per-job temp folder.

import { LLMUsage } from "../../types";
import { CliCall, CliCallResult, CliProviderBase } from "./CliProviderBase";
import { CliRunError, runCli } from "./CliRunner";

export interface ClaudeArgsInput {
  model: string;
  effort: string;
  systemPrompt?: string;
  schema?: Record<string, unknown>;
  withImages: boolean;
  workDir: string;
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--safe-mode",
    "--disable-slash-commands",
    "--system-prompt",
    input.systemPrompt?.trim() || "You are a helpful assistant.",
  ];
  if (input.withImages) {
    args.push("--tools", "Read", "--allowedTools", "Read", "--add-dir", input.workDir);
  } else {
    args.push("--tools", "");
  }
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.schema) args.push("--json-schema", JSON.stringify(input.schema));
  return args;
}

/** Appended after the per-call content so the cached prefix stays identical. */
export function imageFileBlock(paths: Array<{ pageNum: number; path: string }>): string {
  if (paths.length === 0) return "";
  return (
    "\n\n[슬라이드 이미지 파일: 답하기 전에 Read 도구로 각 파일을 모두 읽으시오]\n" +
    paths.map((p) => `- 슬라이드 ${p.pageNum}: ${p.path}`).join("\n")
  );
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

function findResult(stdout: string): ClaudeJsonResult | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return (parsed.filter((e) => e && e.type === "result").pop() as ClaudeJsonResult) ?? null;
    }
    return parsed as ClaudeJsonResult;
  } catch {
    // stream-json style: one object per line
    const lines = text.split("\n").reverse();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === "result") return obj as ClaudeJsonResult;
      } catch {
        // skip
      }
    }
    return null;
  }
}

export function claudeUsage(res: ClaudeJsonResult): LLMUsage {
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

/** Parse `claude -p --output-format json` stdout. Throws on an error result. */
export function parseClaudeOutput(stdout: string): CliCallResult {
  const res = findResult(stdout);
  if (!res) throw new Error(`Claude CLI 출력을 해석하지 못했습니다: ${stdout.slice(0, 200)}`);
  if (res.is_error || (res.subtype && res.subtype !== "success")) {
    throw new CliRunError("exit", `Claude CLI 오류 (${res.subtype ?? "error"}): ${String(res.result ?? "").slice(0, 300)}`, "", stdout);
  }
  return {
    text: typeof res.result === "string" ? res.result : "",
    structured: res.structured_output ?? undefined,
    usage: claudeUsage(res),
  };
}

export class ClaudeCliProvider extends CliProviderBase {
  name = "Claude CLI";
  maxInputTokens = 200000;
  readonly providerId = "claude-cli" as const;

  protected async invoke(call: CliCall, files: { images: string[] }): Promise<CliCallResult> {
    const args = buildClaudeArgs({
      model: this.config.model,
      effort: this.config.effort,
      systemPrompt: call.systemPrompt,
      schema: call.schema,
      withImages: files.images.length > 0,
      workDir: this.config.workDir,
    });
    const input =
      call.prompt +
      imageFileBlock(files.images.map((path, i) => ({ pageNum: call.images?.[i]?.pageNum ?? i + 1, path })));
    try {
      const out = await runCli({
        bin: this.config.bin,
        args,
        input,
        cwd: this.config.workDir,
        timeoutMs: this.config.timeoutMs,
        signal: call.signal,
      });
      return parseClaudeOutput(out.stdout);
    } catch (e) {
      // A non-zero exit often still prints the JSON result with the reason.
      if (e instanceof CliRunError && e.kind === "exit" && e.stdout) {
        const res = findResult(e.stdout);
        if (res?.result) e.message = `Claude CLI 오류: ${String(res.result).slice(0, 300)}`;
      }
      throw e;
    }
  }
}
