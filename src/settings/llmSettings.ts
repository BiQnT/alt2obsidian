// Per-task LLM settings (spec 4.2): migrations, presets, recent models.
// Pure module (no obsidian import) so it is unit-tested in Node.

import {
  Alt2ObsidianSettings,
  CLAUDE_TASK_DEFAULTS,
  DEFAULT_GENERATION,
  DEFAULT_SETTINGS,
  EffortLevel,
  PresetId,
  ProviderId,
  TASK_DEFAULTS,
  TaskId,
  TaskLLMSetting,
} from "../types";

export const TASK_IDS: TaskId[] = ["commentary", "concepts", "alignment", "verification"];

export const TASK_LABELS: Record<TaskId, string> = {
  commentary: "슬라이드 해설",
  concepts: "개념 추출",
  alignment: "전사 정렬 확인",
  verification: "노트 검증",
};

/** The providers a task can use (the alignment check can also be "none"). */
export const TASK_PROVIDERS: ProviderId[] = ["claude-cli", "codex-cli"];

export const PROVIDER_LABELS: Record<ProviderId | "none", string> = {
  "claude-cli": "Claude CLI",
  "codex-cli": "Codex CLI",
  none: "없음 (스크립트만)",
};

export const PRESET_LABELS: Record<PresetId, string> = {
  saving: "절약",
  quality: "품질",
  custom: "사용자 지정",
};

/** "" = the CLI's own default. Both CLIs accept the rest (`claude --help`, Codex models cache). */
export const EFFORT_LEVELS: EffortLevel[] = ["", "low", "medium", "high", "xhigh", "max"];

/** Providers of 2.0.0-beta.3 and earlier that are gone; their tasks move to a CLI. */
const REMOVED_PROVIDERS = ["gemini", "ollama"];

const SETTINGS_VERSION = 3;

export function isCliProvider(p: ProviderId | "none"): p is ProviderId {
  return p === "claude-cli" || p === "codex-cli";
}

/** Model names are passed as one argv entry: refuse anything that could read as a flag. */
export function isSafeModelName(model: string): boolean {
  return model === "" || /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,120}$/.test(model);
}

/** A task's setting with the provider's defaults (spec 4.2 / D5). */
export function defaultTaskSetting(provider: ProviderId | "none", id: TaskId): TaskLLMSetting {
  if (!isCliProvider(provider)) return { provider: "none", model: "", effort: "" };
  return { provider, ...TASK_DEFAULTS[provider][id] };
}

/** Saved task settings with unknown provider, unknown effort or unsafe model reset to defaults. */
export function sanitizeTask(raw: unknown, fallback: TaskLLMSetting): TaskLLMSetting {
  const t = (raw && typeof raw === "object" ? raw : {}) as Partial<TaskLLMSetting>;
  const known: Array<ProviderId | "none"> = [...TASK_PROVIDERS, "none"];
  const provider = known.includes(t.provider as ProviderId) ? (t.provider as TaskLLMSetting["provider"]) : fallback.provider;
  const effort = EFFORT_LEVELS.includes(t.effort as EffortLevel) ? (t.effort as EffortLevel) : "";
  const model = typeof t.model === "string" && isSafeModelName(t.model.trim()) ? t.model.trim() : "";
  return { provider, model, effort };
}

function cloneTasks(tasks: Record<TaskId, TaskLLMSetting>): Record<TaskId, TaskLLMSetting> {
  const out = {} as Record<TaskId, TaskLLMSetting>;
  for (const id of TASK_IDS) out[id] = { ...tasks[id] };
  return out;
}

export interface MigrationOutcome {
  settings: Alt2ObsidianSettings;
  /** The CLI choice (Claude, else Codex) still has to be made once: see `chooseCli`. */
  needsCliDefault: boolean;
  /** A task was on Gemini or Ollama (or the data is 1.x): the user is told once. */
  removedProviders: boolean;
}

/**
 * Settings from saved plugin data.
 * - No `tasks` (1.x data or a fresh install): the default table (Claude CLI).
 *   1.x could only run Gemini or Ollama, so 1.x data counts as moved.
 * - A task on Gemini or Ollama: that task gets the Claude CLI defaults.
 * - Data before version 3: a CLI task with an empty model or effort gets the
 *   task default, so the table shows what actually runs (an empty value used
 *   to mean "whatever the CLI is set to"). "CLI 기본값" stays selectable.
 * Unknown keys (the 1.x Gemini key and model) are kept as they are.
 */
export function migrateSettings(saved: unknown): MigrationOutcome {
  const raw = (saved && typeof saved === "object" ? saved : {}) as Partial<Alt2ObsidianSettings> & Record<string, unknown>;
  const settings: Alt2ObsidianSettings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    generation: { ...DEFAULT_GENERATION, ...(raw.generation ?? {}) },
    recentModels: pickRecentModels(raw.recentModels),
    tasks: cloneTasks(CLAUDE_TASK_DEFAULTS),
    settingsVersion: SETTINGS_VERSION,
    notionFetchTool: typeof raw.notionFetchTool === "string" ? raw.notionFetchTool.trim() : "",
  };
  const savedTasks = raw.tasks && typeof raw.tasks === "object" ? (raw.tasks as unknown as Record<string, unknown>) : null;
  if (!savedTasks) {
    return { settings, needsCliDefault: true, removedProviders: saved !== undefined && saved !== null && Object.keys(raw).length > 0 };
  }
  let removed = false;
  const before3 = typeof raw.settingsVersion !== "number" || raw.settingsVersion < SETTINGS_VERSION;
  for (const id of TASK_IDS) {
    const rawTask = savedTasks[id] as { provider?: unknown } | undefined;
    if (rawTask && REMOVED_PROVIDERS.includes(String(rawTask.provider))) {
      settings.tasks[id] = defaultTaskSetting("claude-cli", id);
      removed = true;
      continue;
    }
    const task = sanitizeTask(rawTask, CLAUDE_TASK_DEFAULTS[id]);
    if (before3 && isCliProvider(task.provider)) {
      const d = TASK_DEFAULTS[task.provider][id];
      if (!task.model) task.model = d.model;
      if (!task.effort) task.effort = d.effort;
    }
    settings.tasks[id] = task;
  }
  return { settings, needsCliDefault: removed, removedProviders: removed };
}

function pickRecentModels(raw: unknown): Alt2ObsidianSettings["recentModels"] {
  const out: Alt2ObsidianSettings["recentModels"] = {};
  if (!raw || typeof raw !== "object") return out;
  for (const p of TASK_PROVIDERS) {
    const list = (raw as Record<string, unknown>)[p];
    if (Array.isArray(list)) out[p] = list.filter((m): m is string => typeof m === "string" && isSafeModelName(m));
  }
  return out;
}

/**
 * The CLI to use after a migration: the Claude CLI when it is installed and
 * logged in, else the Codex CLI when it is installed, else null (nothing
 * changes; the user installs one).
 */
export function chooseCli(claudeUsable: boolean, codexFound: boolean): ProviderId | null {
  if (claudeUsable) return "claude-cli";
  return codexFound ? "codex-cli" : null;
}

/** Moves every Claude CLI task to the Codex CLI with the Codex task defaults. */
export function moveClaudeTasksToCodex(settings: Alt2ObsidianSettings): void {
  for (const id of TASK_IDS) {
    if (settings.tasks[id].provider === "claude-cli") settings.tasks[id] = defaultTaskSetting("codex-cli", id);
  }
}

/** Light model per CLI for the saving preset. Codex has no stable alias, so its default model is kept. */
const LIGHT_MODEL: Partial<Record<ProviderId, string>> = { "claude-cli": "haiku" };
const TOP_MODEL: Partial<Record<ProviderId, string>> = { "claude-cli": "opus" };

/**
 * Presets change model and effort, never the provider.
 * - saving: every task on the light model with low effort.
 * - quality: commentary and verification on the top model with high effort;
 *   concepts stay light.
 * - custom: nothing changes (it is what any manual edit switches to).
 */
export function applyPreset(settings: Alt2ObsidianSettings, preset: PresetId): void {
  settings.preset = preset;
  if (preset === "custom") return;
  for (const id of TASK_IDS) {
    const t = settings.tasks[id];
    if (!isCliProvider(t.provider)) continue;
    const heavy = id === "commentary" || id === "verification";
    if (preset === "saving" || !heavy) {
      t.model = LIGHT_MODEL[t.provider] ?? "";
      t.effort = "low";
    } else {
      t.model = TOP_MODEL[t.provider] ?? "";
      t.effort = "high";
    }
  }
}

export function rememberModel(settings: Alt2ObsidianSettings, provider: ProviderId, model: string): void {
  const m = model.trim();
  if (!m) return;
  const list = (settings.recentModels[provider] ?? []).filter((x) => x !== m);
  settings.recentModels[provider] = [m, ...list].slice(0, 8);
}

/** Aliases the Claude CLI resolves to its current models (`claude --help`: "an alias for the latest model"). */
export const CLAUDE_MODEL_ALIASES = ["sonnet", "opus", "haiku"];

/**
 * Model ids the Codex CLI lists, from its own models cache
 * ($CODEX_HOME/models_cache.json, written by Codex; reading it costs
 * nothing): visible models by Codex's priority. [] when the file is
 * missing or not in the expected shape.
 */
export function parseCodexModelsCache(text: string): string[] {
  try {
    const data = JSON.parse(text) as { models?: unknown };
    if (!Array.isArray(data.models)) return [];
    return data.models
      .filter((m): m is { slug: string; visibility?: string; priority?: number } => !!m && typeof m.slug === "string")
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .filter((m) => isSafeModelName(m.slug))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => m.slug);
  } catch {
    return [];
  }
}

export interface ModelChoice {
  value: string;
  label: string;
}

/**
 * Model dropdown entries for a provider: the known models (Claude aliases,
 * or the Codex models cache), recently typed models, the current value if
 * it is none of these, then "CLI 기본값" (""). The UI adds "직접 입력".
 */
export function modelChoices(provider: ProviderId, current: string, recent: string[], codexModels: string[]): ModelChoice[] {
  const known = provider === "claude-cli" ? CLAUDE_MODEL_ALIASES : codexModels;
  const values = Array.from(new Set([...known, ...recent, ...(current ? [current] : [])]));
  return [
    ...values.map((value) => ({ value, label: value })),
    { value: "", label: provider === "claude-cli" ? "CLI 기본값 (계정 기본 모델)" : "CLI 기본값 (Codex 기본 모델)" },
  ];
}

/** "sonnet · medium" for a task's recommended setting, "" for "none". */
export function describeDefault(provider: ProviderId | "none", id: TaskId): string {
  if (!isCliProvider(provider)) return "";
  const d = TASK_DEFAULTS[provider][id];
  return `${d.model || "CLI 기본 모델"} · effort ${d.effort}`;
}

/**
 * Slides per call for a provider. Codex carries about 12k fixed tokens per
 * call (its instructions and ~/.codex/AGENTS.md), so it gets twice the
 * batch size to spread that cost; the image rule (half with images) applies
 * on top.
 */
export function batchSizeFor(provider: ProviderId | "none", base: number): number {
  const k = Math.max(1, Math.floor(base));
  return provider === "codex-cli" ? k * 2 : k;
}
