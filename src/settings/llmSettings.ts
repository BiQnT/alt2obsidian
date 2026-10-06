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

export type RemovedProvider = "gemini" | "ollama";

/** A task whose empty model or effort ("CLI 기본값") the version 3 migration filled. */
export interface FilledTask {
  id: TaskId;
  model?: string;
  effort?: EffortLevel;
}

export interface MigrationOutcome {
  settings: Alt2ObsidianSettings;
  /** The CLI choice (Claude, else Codex) still has to be made once: see `chooseCli`. */
  needsCliDefault: boolean;
  /**
   * Tasks this migration put on the Claude CLI defaults (moved off
   * Gemini/Ollama, or the default table of 1.x data and fresh installs).
   * Only these may move on to Codex; a task the user set to the Claude CLI
   * is never rewritten.
   */
  movedTasks: TaskId[];
  /** Removed providers the data used (1.x data: its single provider). The user is told once. */
  removedFrom: RemovedProvider[];
  /** Empty model/effort filled with the task defaults (version 3); the user is told once. */
  filled: FilledTask[];
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
    hideManagedComments: raw.hideManagedComments !== false,
  };
  const savedTasks = raw.tasks && typeof raw.tasks === "object" ? (raw.tasks as unknown as Record<string, unknown>) : null;
  if (!savedTasks) {
    const has1x = saved !== undefined && saved !== null && Object.keys(raw).length > 0;
    const removedFrom: RemovedProvider[] = has1x ? [(raw as { provider?: unknown }).provider === "ollama" ? "ollama" : "gemini"] : [];
    const movedTasks = TASK_IDS.filter((id) => settings.tasks[id].provider === "claude-cli");
    return { settings, needsCliDefault: true, movedTasks, removedFrom, filled: [] };
  }
  const movedTasks: TaskId[] = [];
  const removedFrom = new Set<RemovedProvider>();
  const filled: FilledTask[] = [];
  const before3 = typeof raw.settingsVersion !== "number" || raw.settingsVersion < SETTINGS_VERSION;
  for (const id of TASK_IDS) {
    const rawTask = savedTasks[id] as { provider?: unknown } | undefined;
    if (rawTask && REMOVED_PROVIDERS.includes(String(rawTask.provider))) {
      settings.tasks[id] = defaultTaskSetting("claude-cli", id);
      movedTasks.push(id);
      removedFrom.add(String(rawTask.provider) as RemovedProvider);
      continue;
    }
    const task = sanitizeTask(rawTask, CLAUDE_TASK_DEFAULTS[id]);
    if (before3 && isCliProvider(task.provider)) {
      const d = TASK_DEFAULTS[task.provider][id];
      const change: FilledTask = { id };
      if (!task.model && d.model) task.model = change.model = d.model;
      if (!task.effort && d.effort) task.effort = change.effort = d.effort;
      if (change.model || change.effort) filled.push(change);
    }
    settings.tasks[id] = task;
  }
  return { settings, needsCliDefault: movedTasks.length > 0, movedTasks, removedFrom: Array.from(removedFrom), filled };
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

/**
 * Moves the given tasks (the ones a migration just set) from the Claude CLI
 * to the Codex CLI with the Codex task defaults. Other tasks, including
 * ones the user set to the Claude CLI, stay.
 */
export function moveClaudeTasksToCodex(settings: Alt2ObsidianSettings, ids: TaskId[]): void {
  for (const id of ids) {
    if (settings.tasks[id].provider === "claude-cli") settings.tasks[id] = defaultTaskSetting("codex-cli", id);
  }
}

/** One line per filled task, e.g. "슬라이드 해설: 모델 sonnet, effort medium". */
export function describeFilled(filled: FilledTask[]): string[] {
  return filled.map((f) => {
    const parts = [f.model ? `모델 ${f.model}` : "", f.effort ? `effort ${f.effort}` : ""].filter(Boolean);
    return `${TASK_LABELS[f.id]}: ${parts.join(", ")}`;
  });
}

/** The once-only Notice after Gemini/Ollama tasks moved to a CLI. */
export function removedProviderMessage(removedFrom: RemovedProvider[], cli: ProviderId | null): string {
  const names = removedFrom.map((p) => (p === "ollama" ? "Ollama" : "Gemini API")).join("와 ") || "Gemini API와 Ollama";
  const head = `Alt2Obsidian: ${names} 지원이 끝났습니다. `;
  const where = cli ? `해당 작업을 ${PROVIDER_LABELS[cli]}로 옮겼습니다. 설정의 '작업별 모델'에서 확인하세요.` : "Claude Code나 Codex CLI를 설치하고 로그인한 뒤 설정의 'LLM 연결'에서 '다시 찾기'를 누르세요.";
  const cloud = removedFrom.includes("ollama")
    ? " 이제 슬라이드 텍스트와 전사가 이 컴퓨터의 Ollama 대신 클라우드 모델(Claude 또는 Codex 계정)로 보내집니다. 원하지 않으면 가져오기 전에 설정을 확인하세요."
    : "";
  return head + where + cloud;
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

export interface CodexModels {
  /** Visible model ids by Codex's priority. */
  models: string[];
  /** Effort levels each model lists (supported_reasoning_levels), limited to the plugin's levels. */
  efforts: Record<string, EffortLevel[]>;
}

/**
 * Models from the Codex CLI's own cache ($CODEX_HOME/models_cache.json,
 * written by Codex; reading it costs nothing). Empty when the file is
 * missing or not in the expected shape.
 */
export function parseCodexModels(text: string): CodexModels {
  const out: CodexModels = { models: [], efforts: {} };
  try {
    const data = JSON.parse(text) as { models?: unknown };
    if (!Array.isArray(data.models)) return out;
    const visible = data.models
      .filter((m): m is { slug: string; visibility?: string; priority?: number; supported_reasoning_levels?: unknown } => !!m && typeof m.slug === "string")
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .filter((m) => isSafeModelName(m.slug))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
    for (const m of visible) {
      out.models.push(m.slug);
      if (Array.isArray(m.supported_reasoning_levels)) {
        const levels = m.supported_reasoning_levels
          .map((l) => (l && typeof l === "object" ? (l as { effort?: unknown }).effort : l))
          .filter((e): e is EffortLevel => typeof e === "string" && e !== "" && EFFORT_LEVELS.includes(e as EffortLevel));
        if (levels.length > 0) out.efforts[m.slug] = levels;
      }
    }
  } catch {
    return { models: [], efforts: {} };
  }
  return out;
}

/** Visible Codex model ids only (see parseCodexModels). */
export function parseCodexModelsCache(text: string): string[] {
  return parseCodexModels(text).models;
}

/**
 * Effort dropdown entries: "" (CLI 기본값) plus the levels the chosen model
 * lists when that is known (Codex models cache), else every level. The
 * saved value is always kept so the dropdown can show it.
 */
export function effortChoices(provider: ProviderId, model: string, current: EffortLevel, codex: CodexModels): EffortLevel[] {
  const known = provider === "codex-cli" && model ? codex.efforts[model] : undefined;
  if (!known) return EFFORT_LEVELS;
  return EFFORT_LEVELS.filter((l) => l === "" || l === current || known.includes(l));
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
