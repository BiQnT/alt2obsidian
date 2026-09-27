// Per-task LLM settings (spec 4.2): 1.x migration, presets, recent models.
// Pure module (no obsidian import) so it is unit-tested in Node.

import {
  Alt2ObsidianSettings,
  CLAUDE_TASK_DEFAULTS,
  DEFAULT_GENERATION,
  DEFAULT_SETTINGS,
  EffortLevel,
  PresetId,
  ProviderId,
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

export const PROVIDER_LABELS: Record<ProviderId | "none", string> = {
  "claude-cli": "Claude CLI",
  "codex-cli": "Codex CLI",
  gemini: "Gemini API",
  ollama: "Ollama",
  none: "없음 (스크립트만)",
};

export const PRESET_LABELS: Record<PresetId, string> = {
  saving: "절약",
  quality: "품질",
  custom: "사용자 지정",
};

export const EFFORT_LEVELS: EffortLevel[] = ["", "low", "medium", "high", "xhigh", "max"];

export function isCliProvider(p: ProviderId | "none"): p is "claude-cli" | "codex-cli" {
  return p === "claude-cli" || p === "codex-cli";
}

/** 1.x single provider mapped to a 2.0 provider. The 1.x Claude/OpenAI entries were empty stubs. */
function legacyProvider(p: unknown): ProviderId {
  return p === "ollama" ? "ollama" : "gemini";
}

function cloneTasks(tasks: Record<TaskId, TaskLLMSetting>): Record<TaskId, TaskLLMSetting> {
  const out = {} as Record<TaskId, TaskLLMSetting>;
  for (const id of TASK_IDS) out[id] = { ...tasks[id] };
  return out;
}

/**
 * Settings from saved plugin data. Every existing value is kept. When the
 * data has no `tasks` (1.x, or a fresh install) the tasks use the 1.x
 * provider and `needsCliDefault` is true: the caller looks for a Claude CLI
 * once and, if found, switches the tasks to it with `applyClaudeDefaults`.
 */
export function migrateSettings(saved: unknown): { settings: Alt2ObsidianSettings; needsCliDefault: boolean } {
  const raw = (saved && typeof saved === "object" ? saved : {}) as Partial<Alt2ObsidianSettings>;
  const settings: Alt2ObsidianSettings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    generation: { ...DEFAULT_GENERATION, ...(raw.generation ?? {}) },
    recentModels: { ...(raw.recentModels ?? {}) },
    tasks: cloneTasks(DEFAULT_SETTINGS.tasks),
    settingsVersion: 2,
  };
  const hadTasks = !!raw.tasks && typeof raw.tasks === "object";
  if (hadTasks) {
    for (const id of TASK_IDS) settings.tasks[id] = { ...DEFAULT_SETTINGS.tasks[id], ...(raw.tasks as any)[id] };
  } else {
    const p = legacyProvider(raw.provider);
    for (const id of ["commentary", "concepts", "verification"] as TaskId[]) {
      settings.tasks[id] = { provider: p, model: "", effort: "" };
    }
  }
  return { settings, needsCliDefault: !hadTasks };
}

/** Spec 4.2 defaults: commentary and verification on the user's default model, concepts on Haiku. */
export function applyClaudeDefaults(settings: Alt2ObsidianSettings): void {
  for (const id of ["commentary", "concepts", "verification"] as TaskId[]) {
    settings.tasks[id] = { ...CLAUDE_TASK_DEFAULTS[id] };
  }
  settings.preset = "custom";
}

/** Light model per CLI for the saving preset. Codex has no stable alias, so its default model is kept. */
const LIGHT_MODEL: Partial<Record<ProviderId, string>> = { "claude-cli": "haiku" };
const TOP_MODEL: Partial<Record<ProviderId, string>> = { "claude-cli": "opus" };

/**
 * Presets change model and effort, never the provider.
 * - saving: every task on the light model with low effort.
 * - quality: commentary and verification on the top model with high effort;
 *   concepts stay light.
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

/** Model actually used for a task: the task's model, or the 1.x field for Gemini/Ollama. */
export function effectiveModel(settings: Alt2ObsidianSettings, task: TaskLLMSetting): string {
  if (task.model.trim()) return task.model.trim();
  if (task.provider === "gemini") return settings.geminiModel;
  if (task.provider === "ollama") return settings.ollamaModel;
  return "";
}
