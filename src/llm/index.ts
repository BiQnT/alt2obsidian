import { Alt2ObsidianSettings, CliName, LLMProvider, TaskLLMSetting } from "../types";
import { ClaudeCliProvider } from "./cli/ClaudeCliProvider";
import { CodexCliProvider } from "./cli/CodexCliProvider";
import { UsageTracker } from "./usage";

export interface TaskProviderContext {
  settings: Alt2ObsidianSettings;
  /** Resolves the CLI binary (settings path, cached lookup, login shell). */
  resolveBin(name: CliName): Promise<string>;
  /** Per-job temp folder outside the vault. */
  workDir: string;
  usage: UsageTracker;
  signal?: AbortSignal;
  task: string;
}

/** Provider for one task's settings (spec 4.2 per-task table). */
export async function createTaskProvider(task: TaskLLMSetting, ctx: TaskProviderContext): Promise<LLMProvider> {
  const s = ctx.settings;
  const timeoutMs = Math.max(30, s.cliTimeoutSec || 300) * 1000;
  switch (task.provider) {
    case "claude-cli":
    case "codex-cli": {
      const config = {
        bin: await ctx.resolveBin(task.provider === "claude-cli" ? "claude" : "codex"),
        model: task.model.trim(),
        effort: task.effort,
        timeoutMs,
        workDir: ctx.workDir,
        usage: ctx.usage,
        task: ctx.task,
        signal: ctx.signal,
        // The job owns the folder; several task providers share it.
        ownsWorkDir: false,
      };
      return task.provider === "claude-cli" ? new ClaudeCliProvider(config) : new CodexCliProvider(config);
    }
    default:
      throw new Error("이 작업에는 LLM이 설정되어 있지 않습니다");
  }
}
