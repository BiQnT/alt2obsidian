// Model choice at the moment of use (the sidebar's import estimate and the
// note verification estimate): provider, model and effort for one task, for
// this run only. The saved settings change only through "기본값으로 저장".

import { TaskId, TaskLLMSetting, EffortLevel, ProviderId } from "../types";
import {
  defaultTaskSetting,
  effortChoices,
  isCliProvider,
  ModelCatalog,
  modelChoices,
  PROVIDER_LABELS,
  TASK_PROVIDERS,
} from "../settings/llmSettings";

export interface ModelPickerOptions {
  task: TaskId;
  /** Row label, e.g. "해설 모델". */
  label: string;
  /** The choice for this run. */
  value: TaskLLMSetting;
  /** The saved setting (the default for every run). */
  saved: TaskLLMSetting;
  catalog: ModelCatalog;
  recent: Partial<Record<ProviderId, string[]>>;
  onChange(next: TaskLLMSetting): void;
  /** Makes the run's choice the saved default ("기본값으로 저장"). */
  onSaveDefault?(next: TaskLLMSetting): Promise<void>;
  disabled?: boolean;
}

export function sameTaskSetting(a: TaskLLMSetting, b: TaskLLMSetting): boolean {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

function select(parent: HTMLElement, aria: string, options: Array<{ value: string; label: string; title?: string }>, value: string, disabled: boolean): HTMLSelectElement {
  const el = parent.createEl("select", { cls: "dropdown alt2obsidian-picker-select" });
  el.setAttr("aria-label", aria);
  for (const o of options) {
    const opt = el.createEl("option", { text: o.label, attr: { value: o.value } });
    if (o.title) opt.setAttr("title", o.title);
  }
  el.value = value;
  el.disabled = disabled;
  return el;
}

/**
 * One task's provider, model and effort dropdowns. Changing the provider
 * loads that provider's task defaults, like the settings tab. When the
 * choice differs from the saved setting, a note says so and offers
 * "기본값으로 저장".
 */
export function renderModelPicker(container: HTMLElement, o: ModelPickerOptions): HTMLElement {
  const row = container.createDiv({ cls: "alt2obsidian-picker" });
  row.createDiv({ cls: "alt2obsidian-picker-label", text: o.label });
  const controls = row.createDiv({ cls: "alt2obsidian-picker-controls" });
  const v = o.value;
  const disabled = !!o.disabled;
  const providers: Array<{ value: string; label: string }> = TASK_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }));
  if (!isCliProvider(v.provider)) providers.unshift({ value: "none", label: PROVIDER_LABELS.none });
  const providerEl = select(controls, `${o.label} 프로바이더`, providers, v.provider, disabled);
  providerEl.addEventListener("change", () => o.onChange(defaultTaskSetting(providerEl.value as ProviderId, o.task)));
  if (isCliProvider(v.provider)) {
    const provider = v.provider;
    const models = modelChoices(provider, v.model, o.recent[provider] ?? [], o.catalog);
    const modelEl = select(controls, `${o.label} 모델`, models, v.model, disabled);
    // The model label is long ("Opus 5.5 (claude-opus-5-5)"): its own line, above provider and effort.
    modelEl.addClass("is-model");
    modelEl.addEventListener("change", () => {
      const model = modelEl.value;
      // Keep the effort when the new model lists it, else the CLI default.
      const efforts = effortChoices(provider, model, "", o.catalog);
      o.onChange({ provider, model, effort: efforts.includes(v.effort) ? v.effort : "" });
    });
    const efforts = effortChoices(provider, v.model, v.effort, o.catalog).map((l) => ({ value: l, label: l ? `effort ${l}` : "effort CLI 기본값" }));
    const effortEl = select(controls, `${o.label} effort`, efforts, v.effort, disabled);
    effortEl.addEventListener("change", () => o.onChange({ provider, model: v.model, effort: effortEl.value as EffortLevel }));
  }
  if (!sameTaskSetting(v, o.saved)) {
    const note = row.createDiv({ cls: "alt2obsidian-picker-note" });
    note.createSpan({ cls: "alt2obsidian-muted", text: "이번 실행에만 씁니다. 설정은 그대로입니다." });
    if (o.onSaveDefault) {
      const save = note.createEl("button", { text: "기본값으로 저장", cls: "alt2obsidian-picker-save" });
      save.disabled = disabled;
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await o.onSaveDefault!(v);
          note.empty();
          note.createSpan({ cls: "alt2obsidian-muted", text: "설정의 기본값으로 저장했습니다." });
        } catch (e) {
          save.disabled = false;
          note.createSpan({ cls: "alt2obsidian-error", text: `저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
        }
      });
    }
  }
  return row;
}
