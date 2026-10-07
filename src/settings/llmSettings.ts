// Per-task LLM settings (spec 4.2): migrations, presets, recent models.
// Pure module (no obsidian import) so it is unit-tested in Node.

import {
  Alt2ObsSettings,
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

/** API key fields of 1.x and 2.0.0-beta.3 settings that nothing reads any more. */
export const LEGACY_KEY_FIELDS = ["apiKey", "geminiApiKey", "claudeApiKey"];

/** Providers of 2.0.0-beta.3 and earlier that are gone; their tasks move to a CLI. */
const REMOVED_PROVIDERS = ["gemini", "ollama"];

const SETTINGS_VERSION = 3;

export function isCliProvider(p: ProviderId | "none"): p is ProviderId {
  return p === "claude-cli" || p === "codex-cli";
}

/** Model names are passed as one argv entry: refuse anything that could read as a flag. */
export function isSafeModelName(model: string): boolean {
  return model === "" || /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,120}$/.test(model);
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
  settings: Alt2ObsSettings;
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
  const raw = (saved && typeof saved === "object" ? saved : {}) as Partial<Alt2ObsSettings> & Record<string, unknown>;
  const settings: Alt2ObsSettings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    generation: { ...DEFAULT_GENERATION, ...(raw.generation ?? {}) },
    recentModels: pickRecentModels(raw.recentModels),
    tasks: cloneTasks(CLAUDE_TASK_DEFAULTS),
    settingsVersion: SETTINGS_VERSION,
    notionFetchTool: typeof raw.notionFetchTool === "string" ? raw.notionFetchTool.trim() : "",
    hideManagedComments: raw.hideManagedComments !== false,
    openPdfInViewer: raw.openPdfInViewer !== false,
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

function pickRecentModels(raw: unknown): Alt2ObsSettings["recentModels"] {
  const out: Alt2ObsSettings["recentModels"] = {};
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
export function moveClaudeTasksToCodex(settings: Alt2ObsSettings, ids: TaskId[]): void {
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
  const head = `Alt2Obs: ${names} 지원이 끝났습니다. `;
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
export function applyPreset(settings: Alt2ObsSettings, preset: PresetId): void {
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

export function rememberModel(settings: Alt2ObsSettings, provider: ProviderId, model: string): void {
  const m = model.trim();
  if (!m) return;
  const list = (settings.recentModels[provider] ?? []).filter((x) => x !== m);
  settings.recentModels[provider] = [m, ...list].slice(0, 8);
}

// ---- model catalog (names and versions for the dropdowns) ----

/** A model the dropdowns can offer, with its display name. */
export interface ModelInfo {
  /** The value passed to the CLI (`--model` / `-m`). */
  id: string;
  /** Display name with the version, e.g. "Sonnet 5.5" or "GPT-6-Astra". */
  name: string;
  description?: string;
  /** Effort levels the model lists; undefined = unknown (every level), [] = none. */
  efforts?: EffortLevel[];
  /** The level the CLI uses when none is given (Claude Code's "Recommended" option, Codex's default_reasoning_level). */
  defaultEffort?: EffortLevel;
  /** Listed after the current models (Claude's "overflow" section). */
  older?: boolean;
}

/**
 * Claude models when Claude Code's own model catalog cache is missing
 * (it appears once Claude Code has been used interactively). Ids and names
 * as listed by Claude Code 2.1.291 on 2026-10-06 (its catalog and the
 * model table in the CLI); each id is passed to `claude --model` as it is
 * (claude-sonnet-5 and, through its alias, claude-fable-5-1 and
 * claude-sonnet-5-5 were checked with a real call).
 */
export const CLAUDE_FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "claude-opus-5-5", name: "Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", efforts: [] },
  { id: "claude-sonnet-5", name: "Sonnet 5", older: true },
];

/**
 * Aliases the Claude CLI resolves to the latest model of a family
 * (`claude --help`: "an alias for the latest model"). `knownId` is what the
 * alias resolved to when checked with Claude Code 2.1.291 on 2026-10-06:
 * fable and sonnet by a real call each (the result's modelUsage key), opus
 * from Claude Code's catalog for an account set to "opus", haiku from an
 * earlier plugin run's modelUsage. After every real call the plugin records
 * the id the CLI actually used, which wins over this table.
 */
export const CLAUDE_ALIASES: Array<{ alias: string; family: string; knownId: string }> = [
  { alias: "fable", family: "Fable", knownId: "claude-fable-5-1" },
  { alias: "opus", family: "Opus", knownId: "claude-opus-5-5" },
  { alias: "sonnet", family: "Sonnet", knownId: "claude-sonnet-5-5" },
  { alias: "haiku", family: "Haiku", knownId: "claude-haiku-4-5-20251001" },
];

/** The alias names, for code that only needs to know a value is an alias. */
export const CLAUDE_MODEL_ALIASES = CLAUDE_ALIASES.map((a) => a.alias);

/** The id a run resolved a requested model to (plugin data `resolvedModels`). */
export interface ResolvedModel {
  id: string;
  /** Day of the run, YYYY-MM-DD. */
  at: string;
}

/** Key of `resolvedModels`: provider and the requested value ("" = CLI default). */
export function resolvedKey(provider: ProviderId, requested: string): string {
  return `${provider}:${requested}`;
}

/** Everything the model dropdowns need. */
export interface ModelCatalog {
  claude: ModelInfo[];
  codex: CodexModels;
  resolved: Record<string, ResolvedModel>;
}

function effortList(raw: unknown): EffortLevel[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .map((l): unknown => (l && typeof l === "object" ? (l as { effort?: unknown; id?: unknown }).effort ?? (l as { id?: unknown }).id : l))
    .filter((e): e is EffortLevel => typeof e === "string" && e !== "" && EFFORT_LEVELS.includes(e as EffortLevel));
}

/**
 * Claude models from Claude Code's own catalog cache
 * (~/.claude/cache/model-catalog/<account>-cc.json, written by Claude Code;
 * reading it costs nothing). Current models first, older ("overflow") ones
 * after. Empty when the file is missing or not in the expected shape.
 */
export function parseClaudeModelCatalog(text: string): ModelInfo[] {
  try {
    const data = JSON.parse(text) as { catalog?: { config?: { models?: unknown } } };
    const models = data.catalog?.config?.models;
    if (!Array.isArray(models)) return [];
    const out: ModelInfo[] = [];
    for (const m of models) {
      if (!m || typeof m !== "object") continue;
      const r = m as { id?: unknown; name?: unknown; description?: unknown; section?: unknown; thinking?: { type?: unknown; effort_options?: unknown } };
      if (typeof r.id !== "string" || !isSafeModelName(r.id) || !r.id) continue;
      const info: ModelInfo = { id: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : r.id };
      if (typeof r.description === "string" && r.description) info.description = r.description;
      if (r.thinking?.type === "none") info.efforts = [];
      else if (Array.isArray(r.thinking?.effort_options)) {
        info.efforts = effortList(r.thinking.effort_options);
        const recommended = (r.thinking.effort_options as Array<{ id?: unknown; badge?: { message?: unknown } }>).find((o) => o?.badge?.message === "Recommended");
        const level = effortList(recommended ? [recommended] : [])[0];
        if (level) info.defaultEffort = level;
      }
      if (r.section !== undefined && r.section !== "main") info.older = true;
      out.push(info);
    }
    return [...out.filter((m) => !m.older), ...out.filter((m) => m.older)];
  } catch {
    return [];
  }
}

export interface CodexModels {
  /** Visible model ids by Codex's priority. */
  models: string[];
  /** Effort levels each model lists (supported_reasoning_levels), limited to the plugin's levels. */
  efforts: Record<string, EffortLevel[]>;
  /** Display names, descriptions and default levels from the cache (display_name, description, default_reasoning_level). */
  info?: Record<string, { name: string; description?: string; defaultEffort?: EffortLevel }>;
}

/**
 * Models from the Codex CLI's own cache ($CODEX_HOME/models_cache.json,
 * written by Codex; reading it costs nothing). Empty when the file is
 * missing or not in the expected shape.
 */
export function parseCodexModels(text: string): CodexModels {
  const out: CodexModels = { models: [], efforts: {}, info: {} };
  try {
    const data = JSON.parse(text) as { models?: unknown };
    if (!Array.isArray(data.models)) return out;
    const visible = (data.models as unknown[])
      .filter((m): m is { slug: string; display_name?: unknown; description?: unknown; default_reasoning_level?: unknown; visibility?: string; priority?: number; supported_reasoning_levels?: unknown } => !!m && typeof (m as { slug?: unknown }).slug === "string")
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .filter((m) => isSafeModelName(m.slug))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
    for (const m of visible) {
      out.models.push(m.slug);
      const levels = effortList(m.supported_reasoning_levels);
      if (levels.length > 0) out.efforts[m.slug] = levels;
      const name = typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : m.slug;
      const entry: { name: string; description?: string; defaultEffort?: EffortLevel } = { name };
      if (typeof m.description === "string" && m.description) entry.description = m.description;
      const def = effortList([m.default_reasoning_level])[0];
      if (def) entry.defaultEffort = def;
      out.info![m.slug] = entry;
    }
  } catch {
    return { models: [], efforts: {}, info: {} };
  }
  return out;
}

/** Visible Codex model ids only (see parseCodexModels). */
export function parseCodexModelsCache(text: string): string[] {
  return parseCodexModels(text).models;
}

/** The id an alias stands for now: the last run's resolved id, else the checked mapping. */
export function aliasTarget(alias: string, catalog: Pick<ModelCatalog, "resolved">): string | null {
  const seen = catalog.resolved[resolvedKey("claude-cli", alias)]?.id;
  return seen || CLAUDE_ALIASES.find((a) => a.alias === alias)?.knownId || null;
}

/** When the built-in alias table was checked (shown next to a target no run has confirmed yet). */
export const CLAUDE_ALIASES_CHECKED = "2026-10";

/** Catalog entry for a Claude id or alias (aliases through their current target). */
function claudeInfo(model: string, catalog: ModelCatalog): ModelInfo | undefined {
  const list = catalog.claude.length > 0 ? catalog.claude : CLAUDE_FALLBACK_MODELS;
  const id = CLAUDE_MODEL_ALIASES.includes(model) ? aliasTarget(model, catalog) : model;
  return id ? list.find((m) => m.id === id) ?? CLAUDE_FALLBACK_MODELS.find((m) => m.id === id) : undefined;
}

/** "Opus 5.5" for a known id, the id itself otherwise. */
export function modelName(provider: ProviderId, id: string, catalog: ModelCatalog): string {
  if (provider === "codex-cli") return catalog.codex.info?.[id]?.name ?? id;
  return claudeInfo(id, catalog)?.name ?? id;
}

/** What the catalog knows about a model's effort levels (undefined: unknown model). */
function effortInfo(provider: ProviderId, model: string, catalog: ModelCatalog): { efforts?: EffortLevel[]; defaultEffort?: EffortLevel } {
  if (!model) return {};
  if (provider === "codex-cli") return { efforts: catalog.codex.efforts[model], defaultEffort: catalog.codex.info?.[model]?.defaultEffort };
  const info = claudeInfo(model, catalog);
  return { efforts: info?.efforts, defaultEffort: info?.defaultEffort };
}

/**
 * Effort dropdown entries: "" (CLI 기본값) plus the levels the chosen model
 * lists when that is known (Claude Code's or Codex's model cache), else
 * every level. The saved value is always kept so the dropdown can show it.
 */
export function effortChoices(provider: ProviderId, model: string, current: EffortLevel, catalog: ModelCatalog): EffortLevel[] {
  const known = effortInfo(provider, model, catalog).efforts;
  if (!known) return EFFORT_LEVELS;
  return EFFORT_LEVELS.filter((l) => l === "" || l === current || known.includes(l));
}

/**
 * The effort level the estimate counts for a task: none (factor 1) for a
 * model without effort levels (Haiku 4.5 ignores it); for "" (CLI 기본값)
 * the model's own default level when the catalog names it, else unknown
 * (factor 1); otherwise the chosen level.
 */
export function estimateEffort(provider: ProviderId | "none", model: string, effort: EffortLevel, catalog: ModelCatalog): EffortLevel {
  if (!isCliProvider(provider)) return effort;
  const info = effortInfo(provider, model, catalog);
  if (info.efforts && info.efforts.length === 0) return "";
  return effort || info.defaultEffort || "";
}

export interface ModelChoice {
  value: string;
  label: string;
  /** Tooltip (the model's description). */
  title?: string;
}

/**
 * How a model value reads in the dropdowns and the run panels:
 * - a versioned id: "Opus 5.5 (claude-opus-5-5)", or the bare id when unknown;
 * - an alias: "opus (최신 Opus, 현재 Opus 5.5)" when a run recorded what it
 *   resolved to, else "opus (최신 Opus, Opus 5.5, 기준일 2026-10)" from the
 *   built-in table;
 * - "": the CLI's own default.
 */
export function modelLabel(provider: ProviderId, model: string, catalog: ModelCatalog): string {
  if (!model) return provider === "claude-cli" ? "CLI 기본값 (계정 기본 모델)" : "CLI 기본값 (Codex 기본 모델)";
  if (provider === "claude-cli") {
    const alias = CLAUDE_ALIASES.find((a) => a.alias === model);
    if (alias) {
      const seen = catalog.resolved[resolvedKey("claude-cli", model)]?.id;
      if (seen) return `${model} (최신 ${alias.family}, 현재 ${modelName(provider, seen, catalog)})`;
      return `${model} (최신 ${alias.family}, ${modelName(provider, alias.knownId, catalog)}, 기준일 ${CLAUDE_ALIASES_CHECKED})`;
    }
  }
  const name = modelName(provider, model, catalog);
  return name !== model ? `${name} (${model})` : model;
}

/**
 * Model dropdown entries for a provider: the known models with their
 * versions (Claude: Claude Code's catalog or the built-in list, then the
 * aliases; Codex: its models cache), recently typed models, the current
 * value if it is none of these, then "CLI 기본값" (""). The settings tab
 * adds "직접 입력".
 */
export function modelChoices(provider: ProviderId, current: string, recent: string[], full: ModelCatalog): ModelChoice[] {
  let known: string[];
  const titles = new Map<string, string>();
  if (provider === "claude-cli") {
    const list = full.claude.length > 0 ? full.claude : CLAUDE_FALLBACK_MODELS;
    for (const m of list) if (m.description) titles.set(m.id, m.description);
    known = [...list.filter((m) => !m.older).map((m) => m.id), ...CLAUDE_MODEL_ALIASES, ...list.filter((m) => m.older).map((m) => m.id)];
  } else {
    known = full.codex.models;
    for (const [slug, info] of Object.entries(full.codex.info ?? {})) if (info.description) titles.set(slug, info.description);
  }
  const values = Array.from(new Set([...known, ...recent, ...(current ? [current] : [])]));
  return [
    ...values.map((value) => {
      const c: ModelChoice = { value, label: modelLabel(provider, value, full) };
      const title = titles.get(value);
      if (title) c.title = title;
      return c;
    }),
    { value: "", label: modelLabel(provider, "", full) },
  ];
}

/** "Sonnet 5.5 (claude-sonnet-5-5)" or "sonnet (최신 Sonnet, 현재 Sonnet 5.5)" for a run line; "CLI 기본 모델" for "". */
export function describeModel(provider: ProviderId | "none", model: string, catalog: ModelCatalog): string {
  if (!isCliProvider(provider)) return "";
  return model ? modelLabel(provider, model, catalog) : "CLI 기본 모델";
}

/** "effort high", or "effort CLI 기본값" for "" (never counted as medium in the label). */
export function describeEffort(effort: EffortLevel): string {
  return `effort ${effort || "CLI 기본값"}`;
}

/** "sonnet · medium" for a task's recommended setting, "" for "none". */
export function describeDefault(provider: ProviderId | "none", id: TaskId): string {
  if (!isCliProvider(provider)) return "";
  const d = TASK_DEFAULTS[provider][id];
  return `${d.model || "CLI 기본 모델"} · effort ${d.effort}`;
}

/**
 * Output-token multiplier of an effort level, relative to medium (the
 * level the per-slide output estimates were fitted at). From the relative
 * effort cost index Claude Code 2.1.291 ships (low 0.6, medium 0.77, high 1,
 * xhigh 1.74, max 1.91); Codex is assumed to scale the same way. "" is an
 * unknown level (a model without effort levels, or a CLI default the
 * catalog does not name; see `estimateEffort`): factor 1.
 */
export const EFFORT_OUTPUT_FACTOR: Record<EffortLevel, number> = {
  "": 1,
  low: 0.78,
  medium: 1,
  high: 1.3,
  xhigh: 2.26,
  max: 2.48,
};

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
