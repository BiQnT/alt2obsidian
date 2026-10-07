import { App, Notice, PluginSettingTab, requireApiVersion, Setting } from "obsidian";
import type { SettingControl, SettingDefinition, SettingDefinitionItem } from "obsidian";
import type Alt2ObsPlugin from "../main";
import { CliName, DEFAULT_GENERATION, DEFAULT_SETTINGS, EffortLevel, ImageRule, PresetId, ProviderId, TaskId } from "../types";
import {
  applyPreset,
  defaultTaskSetting,
  describeDefault,
  effortChoices,
  isCliProvider,
  isSafeModelName,
  LEGACY_KEY_FIELDS,
  modelChoices,
  modelName,
  PRESET_LABELS,
  PROVIDER_LABELS,
  rememberModel,
  resolvedKey,
  TASK_IDS,
  TASK_LABELS,
  TASK_PROVIDERS,
} from "../settings/llmSettings";
import { compactTokens } from "../llm/usage";

/**
 * One row of the tab. The same rows are drawn by display() on Obsidian
 * before 1.13 and handed to Obsidian as definitions from 1.13 on (see
 * getSettingDefinitions()), so both show the same settings, texts and order.
 * The name, description and aliases are what 1.13's settings search finds.
 */
interface Row {
  name: string;
  /** The description as listed; a `setting` row may replace it when drawn. */
  desc?: string;
  aliases?: string[];
  /** Shown only while true, checked each time the tab is drawn. */
  visible?: () => boolean;
  /** A setting bound to one value (getControlValue / setControlValue). */
  control?: Control;
  /** A setting row that adds its own controls (and its live description). */
  setting?: (setting: Setting) => void;
  /** Not a setting row: a block of its own (the notice, the CLI cards, a note). */
  block?: (el: HTMLElement) => void;
}

interface Section {
  heading?: string;
  rows: Row[];
}

/**
 * A plain control. `key` is the value's path in the settings object; `set`
 * gets the value (false: refused, nothing saved), then the settings are
 * saved and `after` runs.
 */
type Control = { key: string; after?: () => void } & (
  | { type: "toggle"; get: () => boolean; set: (value: boolean) => void }
  | { type: "dropdown"; options: Record<string, string>; get: () => string; set: (value: string) => void }
  | { type: "text"; placeholder?: string; get: () => string; set: (value: string) => boolean | void }
  | { type: "number"; min: number; defaultValue: number; get: () => number; set: (value: number) => void }
);

export class Alt2ObsSettingsTab extends PluginSettingTab {
  plugin: Alt2ObsPlugin;

  constructor(app: App, plugin: Alt2ObsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.containerEl.addClass("alt-to-obs-settings");
  }

  private get settings() {
    return this.plugin.data.settings;
  }

  private async save(): Promise<void> {
    await this.plugin.savePluginData();
  }

  /**
   * Obsidian 1.13 and later draw the tab from these (display() is not
   * called) and index them for settings search: called when the tab is
   * added and on update(), so nothing here reads files or starts the CLI
   * lookup. That happens when a row is drawn.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.sections().map(
      (section): SettingDefinitionItem => ({ type: "group", heading: section.heading, items: section.rows.map((row) => definition(row)) })
    );
  }

  getControlValue(key: string): unknown {
    return this.findControl(key)?.get();
  }

  /** Writes one value: from Obsidian 1.13's controls and from the ones display() draws. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const control = this.findControl(key);
    if (!control) return;
    switch (control.type) {
      case "toggle":
        control.set(value === true);
        break;
      case "dropdown":
        if (typeof value !== "string" || !Object.keys(control.options).includes(value)) return;
        control.set(value);
        break;
      case "text":
        if (typeof value !== "string" || control.set(value) === false) return;
        break;
      case "number": {
        // A whole number, at least the minimum: a text field below 1.13
        // gives "8.5" and 1.13's number field 8.5, both kept as 8.
        const n = typeof value === "number" ? Math.trunc(value) : typeof value === "string" ? parseInt(value, 10) : NaN;
        if (!Number.isFinite(n) || n < control.min) return;
        control.set(n);
        break;
      }
    }
    await this.save();
    control.after?.();
  }

  /**
   * Obsidian before 1.13 (minAppVersion is 1.7.2). From 1.13 on Obsidian
   * draws the tab from getSettingDefinitions() and does not call this.
   */
  display(): void {
    this.drawTab();
  }

  /** Draws the tab again after a change that alters other rows. */
  private redraw(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.drawTab();
  }

  /** The tab as drawn before Obsidian 1.13: a heading per section, then its rows. */
  private drawTab(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const section of this.sections()) {
      if (section.heading) new Setting(containerEl).setName(section.heading).setHeading();
      for (const row of section.rows) {
        if (row.visible && !row.visible()) continue;
        if (row.block) {
          row.block(containerEl);
          continue;
        }
        const setting = new Setting(containerEl).setName(row.name);
        if (row.desc) setting.setDesc(row.desc);
        if (row.control) this.addControl(setting, row.control);
        else row.setting?.(setting);
      }
    }
  }

  /** A plain control as display() draws it (numbers in text fields, as before 1.13). */
  private addControl(setting: Setting, control: Control): void {
    const write = (value: unknown) => this.setControlValue(control.key, value);
    switch (control.type) {
      case "toggle":
        setting.addToggle((t) => t.setValue(control.get()).onChange(write));
        break;
      case "dropdown":
        setting.addDropdown((d) => {
          for (const [value, label] of Object.entries(control.options)) d.addOption(value, label);
          d.setValue(control.get()).onChange(write);
        });
        break;
      case "text":
        setting.addText((t) => {
          if (control.placeholder) t.setPlaceholder(control.placeholder);
          t.setValue(control.get()).onChange(write);
        });
        break;
      case "number":
        setting.addText((t) => t.setValue(String(control.get())).onChange(write));
        break;
    }
  }

  private findControl(key: string): Control | undefined {
    for (const section of this.sections()) {
      for (const row of section.rows) if (row.control?.key === key) return row.control;
    }
    return undefined;
  }

  /**
   * Every row of the tab, in order. Cheap: no file is read and nothing is
   * started here. Values are read when a row is drawn, never kept, so a
   * reloaded settings object is picked up.
   */
  private sections(): Section[] {
    return [
      {
        rows: [
          {
            name: "외부 프로그램 실행과 구독 사용량 안내",
            desc: DISCLOSURE,
            aliases: ["Claude Code", "Codex", "CLI", "usage"],
            block: (el) => {
              const notice = el.createDiv({ cls: "alt-to-obs-disclosure" });
              notice.createEl("strong", { text: "외부 프로그램 실행과 구독 사용량 안내" });
              notice.createEl("p", { text: DISCLOSURE });
            },
          },
        ],
      },
      { heading: "LLM 연결", rows: this.connectionRows() },
      { heading: "작업별 모델", rows: this.taskRows() },
      { heading: "생성 옵션", rows: this.generationRows() },
      { heading: "사용량", rows: [this.usageRow()] },
      { heading: "보기", rows: this.viewRows() },
      { heading: "저장", rows: this.storageRows() },
      {
        heading: "사용법",
        rows: [
          {
            name: "사용법",
            desc: HELP.join(" "),
            aliases: ["help", "synced viewer", "내 메모"],
            block: (el) => {
              const usageEl = el.createDiv({ cls: "setting-item-description" });
              for (const text of HELP) usageEl.createEl("p", { text });
            },
          },
        ],
      },
    ];
  }

  // ---- LLM connections ----

  private connectionRows(): Row[] {
    return [
      {
        // The two cards, side by side when there is room. Found in settings
        // search by their path field.
        name: "실행 파일 경로",
        desc: CLI_PATH_DESC,
        aliases: ["Claude CLI", "Codex CLI", "Claude Code", "Codex", "CLI", "path", "다시 찾기"],
        block: (el) => {
          const grid = el.createDiv({ cls: "alt-to-obs-cards" });
          this.renderCliCard(grid, "claude", "Claude CLI", "claudePath");
          const codexCard = this.renderCliCard(grid, "codex", "Codex CLI", "codexPath");
          codexCard.createDiv({
            cls: "alt-to-obs-muted",
            text:
              "Codex는 호출마다 자체 지시문과 ~/.codex/AGENTS.md가 함께 실려 고정 비용이 큽니다 (이 플러그인 설정으로 줄인 뒤에도 호출당 약 12k 토큰). " +
              "그래서 Codex는 배치 크기의 두 배로 묶어 보냅니다. 또 읽기 전용 샌드박스라도 Codex는 사용자 계정이 읽을 수 있는 파일을 읽을 수 있습니다. " +
              "프롬프트로 주어진 내용만 쓰라고 지시하지만, 이 위험을 감수하는 경우에만 쓰세요.",
          });
        },
      },
      this.legacyKeysRow(),
    ];
  }

  /** Legacy API keys still in data.json (none: an empty list). */
  private legacyKeys(): string[] {
    const stored = this.settings as unknown as Record<string, unknown>;
    return LEGACY_KEY_FIELDS.filter((k) => {
      const value = stored[k];
      return typeof value === "string" && value.trim() !== "";
    });
  }

  /**
   * API keys kept from 1.x and beta.3 (Gemini, the old Claude API stub).
   * Nothing uses them any more; they stay only so a rollback keeps working.
   * Shown only while one is stored; removal asks for a second click.
   */
  private legacyKeysRow(): Row {
    const desc = (present: string[]) =>
      `예전 버전에서 저장한 API 키(${present.join(", ")})가 data.json에 남아 있습니다. 지금 버전은 쓰지 않습니다. ` +
      "지우면 2.0.0-beta.3 이하로 되돌렸을 때 Gemini 키를 다시 넣어야 합니다.";
    return {
      name: "이전 API 키 지우기",
      desc: desc(this.legacyKeys()),
      aliases: ["API key", "Gemini", "data.json"],
      visible: () => this.legacyKeys().length > 0,
      setting: (setting) => {
        setting.setDesc(desc(this.legacyKeys()));
        let armed = false;
        setting.addButton((b) =>
          b.setButtonText("지우기").onClick(async () => {
            if (!armed) {
              armed = true;
              b.setButtonText("한 번 더 누르면 지웁니다");
              // The warning look by class: setWarning() is deprecated on
              // 1.13, where it adds classes the reset below would miss.
              b.buttonEl.addClass("mod-warning");
              window.setTimeout(() => {
                if (!armed) return;
                armed = false;
                b.setButtonText("지우기");
                b.buttonEl.removeClass("mod-warning");
              }, 5000);
              return;
            }
            armed = false;
            const stored = this.settings as unknown as Record<string, unknown>;
            for (const k of LEGACY_KEY_FIELDS) delete stored[k];
            await this.save();
            new Notice("이전 API 키를 data.json에서 지웠습니다.");
            this.redraw();
          })
        );
      },
    };
  }

  private renderCliCard(
    grid: HTMLElement,
    name: CliName,
    label: string,
    pathKey: "claudePath" | "codexPath"
  ): HTMLElement {
    const card = grid.createDiv({ cls: "alt-to-obs-card" });
    card.createDiv({ cls: "alt-to-obs-card-title", text: label });
    const status = card.createDiv({ cls: "alt-to-obs-card-status" });
    const renderStatus = () => {
      status.empty();
      const found = this.plugin.data.cliDetection[name];
      if (found) {
        status.addClass("is-ok");
        status.removeClass("is-missing");
        status.createDiv({ text: `찾음: ${found.version || "버전 확인 실패"}` });
        status.createDiv({ text: found.path, cls: "alt-to-obs-mono" });
        if (found.warning) status.createDiv({ text: found.warning, cls: "alt-to-obs-muted" });
      } else {
        status.addClass("is-missing");
        status.removeClass("is-ok");
        status.createDiv({ text: this.plugin.cliErrors[name] || "아직 찾지 않았습니다. '다시 찾기'를 누르세요." });
      }
    };
    renderStatus();
    if (!this.plugin.data.cliDetection[name] && !this.plugin.cliErrors[name]) {
      status.setText("찾는 중...");
      this.plugin.detectCli(name).then(renderStatus, renderStatus);
    }

    // Plain blocks, not a Setting row: Obsidian lays a Setting out as one
    // flex line whose description may shrink to a one-character column next
    // to a control that cannot shrink. Here the description is a block of
    // the card's full width whatever Obsidian's setting-item rules are.
    const field = card.createDiv({ cls: "alt-to-obs-card-field" });
    field.createDiv({ cls: "alt-to-obs-card-label", text: "실행 파일 경로" });
    field.createDiv({ cls: "alt-to-obs-card-desc", text: CLI_PATH_DESC });
    const row = field.createDiv({ cls: "alt-to-obs-card-row" });
    const input = row.createEl("input", { type: "text", placeholder: `/.../bin/${name}` });
    input.value = this.settings[pathKey];
    input.setAttr("aria-label", `${label} 실행 파일 경로`);
    input.addEventListener("input", () => {
      this.settings[pathKey] = input.value.trim();
      void this.save();
    });
    const button = row.createEl("button", { text: "다시 찾기" });
    button.addEventListener("click", () => {
      button.disabled = true;
      button.setText("찾는 중...");
      void this.plugin.detectCli(name, true).finally(() => {
        button.disabled = false;
        button.setText("다시 찾기");
        renderStatus();
      });
    });
    return card;
  }

  // ---- per-task table ----

  private taskRows(): Row[] {
    const notes: Partial<Record<TaskId, string>> = {
      alignment: "정렬은 스크립트로 항상 합니다. 프로바이더를 고르면 불확실한 구간만 한 번 더 확인합니다 (기본 끔).",
      verification: "사이드바 '노트 검증' 탭에서 씁니다. 주장 20개씩 판정합니다.",
    };
    return [
      {
        name: "프리셋",
        desc:
          "절약: 모든 작업에 경량 모델(Claude는 haiku)과 effort low. 품질: 해설과 검증에 상위 모델(Claude는 opus)과 effort high. " +
          "프로바이더는 바꾸지 않습니다. 아래에서 직접 바꾸면 '사용자 지정'이 됩니다.",
        aliases: ["preset", "model", "effort"],
        control: {
          type: "dropdown",
          key: "preset",
          options: PRESET_LABELS,
          get: () => this.settings.preset,
          set: (value) => applyPreset(this.settings, value as PresetId),
          // The task rows show the preset's models.
          after: () => this.redraw(),
        },
      },
      ...TASK_IDS.map(
        (id): Row => ({
          name: TASK_LABELS[id],
          desc: notes[id],
          aliases: ["model", "effort", "provider", "Claude", "Codex", TASK_ALIASES[id]],
          setting: (setting) => this.renderTaskRow(setting, id, notes[id]),
        })
      ),
      {
        name: "모델 목록",
        desc: MODEL_NOTE,
        aliases: ["model", "effort", "alias"],
        block: (el) => el.createDiv({ cls: "alt-to-obs-muted alt-to-obs-settings-note", text: MODEL_NOTE }),
      },
      {
        name: "Notion MCP 조회 도구",
        desc:
          "노트 검증에서 노션 URL을 넣으면 Claude CLI가 이 도구 하나만 써서 페이지 원문을 가져옵니다. 비우면 `claude mcp list`에서 Notion 서버를 찾아 " +
          "mcp__<서버>__notion-fetch를 씁니다. Notion MCP가 없으면 터미널에서 `claude mcp add --transport http notion https://mcp.notion.com/mcp` 후 `/mcp`로 로그인하세요.",
        aliases: ["Notion", "MCP", "노션"],
        control: {
          type: "text",
          key: "notionFetchTool",
          placeholder: "자동",
          get: () => this.settings.notionFetchTool,
          set: (value) => {
            const v = value.trim();
            if (v && !/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(v)) return false;
            this.settings.notionFetchTool = v;
          },
        },
      },
    ];
  }

  /**
   * One task: provider, model and effort as dropdowns. The model list holds
   * the CLI's known models, "CLI 기본값" and "직접 입력" (a text field for
   * any other id). Changing the provider loads that provider's task defaults.
   */
  private renderTaskRow(setting: Setting, id: TaskId, note: string | undefined): void {
    const catalog = this.plugin.modelCatalog();
    const task = this.settings.tasks[id];
    const recommended = describeDefault(isCliProvider(task.provider) ? task.provider : "claude-cli", id);
    let lastText = "";
    if (isCliProvider(task.provider)) {
      // The id the CLI reported on the last run with this model (an alias resolves to a full id).
      const last = catalog.resolved[resolvedKey(task.provider, task.model)];
      const name = last ? modelName(task.provider, last.id, catalog) : "";
      if (last) lastText = `마지막 실행: ${last.id}${name !== last.id ? ` (${name})` : ""}, ${last.at}.`;
    }
    setting.setDesc([note, recommended ? `권장: ${recommended}.` : "", lastText].filter(Boolean).join(" "));
    setting.settingEl.addClass("alt-to-obs-task-setting");
    const changed = async (rerender: boolean) => {
      this.settings.preset = "custom";
      await this.save();
      if (rerender) this.redraw();
    };

    setting.addDropdown((d) => {
      if (id === "alignment") d.addOption("none", PROVIDER_LABELS.none);
      for (const p of TASK_PROVIDERS) d.addOption(p, PROVIDER_LABELS[p]);
      d.setValue(task.provider).onChange(async (value) => {
        this.settings.tasks[id] = defaultTaskSetting(value as ProviderId | "none", id);
        await changed(true);
      });
      d.selectEl.setAttr("aria-label", `${TASK_LABELS[id]} 프로바이더`);
    });
    if (!isCliProvider(task.provider)) return;
    const provider = task.provider;

    const CUSTOM = "*custom"; // never a model name: those start with a letter or digit
    const choices = modelChoices(provider, task.model, this.settings.recentModels[provider] ?? [], catalog);
    let customInput: HTMLInputElement | null = null;
    let modelSelect: HTMLSelectElement | null = null;
    setting.addDropdown((d) => {
      modelSelect = d.selectEl;
      for (const c of choices) d.addOption(c.value, c.label);
      // The model's description as the option tooltip.
      for (const c of choices) if (c.title) d.selectEl.querySelector(`option[value="${CSS.escape(c.value)}"]`)?.setAttr("title", c.title);
      d.addOption(CUSTOM, "직접 입력...");
      d.setValue(task.model).onChange(async (value) => {
        if (value === CUSTOM) {
          customInput?.show();
          customInput?.focus();
          return;
        }
        customInput?.hide();
        task.model = value;
        // The effort list depends on the model.
        await changed(true);
      });
      d.selectEl.setAttr("aria-label", `${TASK_LABELS[id]} 모델`);
      d.selectEl.addClass("alt-to-obs-model-select");
    });
    setting.addText((text) => {
      customInput = text.inputEl;
      text.setPlaceholder(provider === "claude-cli" ? "예: claude-opus-5-5" : "예: gpt-6-luna");
      text.inputEl.addClass("alt-to-obs-model-input");
      text.inputEl.hide();
      text.inputEl.addEventListener("input", () => {
        // Checked while typing: a model name is passed as one CLI argument (review N8).
        text.inputEl.toggleClass("is-invalid", !isSafeModelName(text.inputEl.value.trim()));
      });
      // Leaving the field empty puts the dropdown back on the saved model.
      text.inputEl.addEventListener("blur", () => {
        if (text.inputEl.value.trim()) return;
        text.inputEl.hide();
        text.inputEl.removeClass("is-invalid");
        if (modelSelect) modelSelect.value = task.model;
      });
      text.inputEl.addEventListener("change", () => {
        const value = text.inputEl.value.trim();
        if (!value) return;
        if (!isSafeModelName(value)) {
          new Notice(`모델 이름을 저장하지 않았습니다 (영문, 숫자와 . _ : / @ [ ] - 만, '-'로 시작 불가): ${value}`);
          return;
        }
        task.model = value;
        rememberModel(this.settings, provider, value);
        void changed(true);
      });
    });

    setting.addDropdown((d) => {
      for (const level of effortChoices(provider, task.model, task.effort, catalog)) d.addOption(level, level ? `effort ${level}` : "effort CLI 기본값");
      d.setValue(task.effort).onChange(async (value) => {
        task.effort = value as EffortLevel;
        await changed(false);
      });
      d.selectEl.setAttr("aria-label", `${TASK_LABELS[id]} effort`);
    });
  }

  // ---- generation options ----

  private generationRows(): Row[] {
    const g = () => this.settings.generation;
    return [
      {
        name: "배치 크기",
        desc: "CLI 호출 한 번에 보낼 슬라이드 수. 이미지가 섞인 배치는 절반만 보냅니다. Codex는 호출당 고정 비용이 커서 이 값의 두 배로 묶습니다.",
        aliases: ["batch", "Codex"],
        control: { type: "number", key: "generation.batchSize", min: 1, defaultValue: DEFAULT_GENERATION.batchSize, get: () => g().batchSize, set: (n) => (g().batchSize = n) },
      },
      {
        name: "이미지 전송 규칙",
        desc: "자동: 도표·그림 위주 슬라이드와 텍스트가 없는 스캔 PDF만 이미지(긴 변 1024px JPEG)를 함께 보냅니다.",
        aliases: ["image", "PDF"],
        control: {
          type: "dropdown",
          key: "generation.imageRule",
          options: { auto: "자동", "text-only": "텍스트만 (스캔 PDF 제외)" },
          get: () => g().imageRule,
          set: (value) => (g().imageRule = value as ImageRule),
        },
      },
      {
        name: "슬라이드당 전사 상한 (자)",
        desc: "군말과 반복을 지운 뒤 슬라이드 내용과 겹치는 문장부터 이 길이까지 남깁니다.",
        aliases: ["transcript"],
        control: {
          type: "number",
          key: "generation.transcriptCapChars",
          min: 0,
          defaultValue: DEFAULT_GENERATION.transcriptCapChars,
          get: () => g().transcriptCapChars,
          set: (n) => (g().transcriptCapChars = n),
        },
      },
      {
        name: "강의당 토큰 상한",
        desc: "예상 입력+출력 토큰이 이 값을 넘으면 시작 전에 멈춥니다. 0이면 상한 없음.",
        aliases: ["token", "limit"],
        control: {
          type: "number",
          key: "generation.tokenCapPerLecture",
          min: 0,
          defaultValue: DEFAULT_GENERATION.tokenCapPerLecture,
          get: () => g().tokenCapPerLecture,
          set: (n) => (g().tokenCapPerLecture = n),
        },
      },
      {
        name: "CLI 호출 제한 시간 (초)",
        desc:
          "호출 하나가 이 시간을 넘기면 중단합니다. 슬라이드 여러 장을 묶은 호출은 반으로 나눠 한 번 더 보내고, 한 장만 보낸 호출은 다시 보내지 않습니다" +
          "(그 슬라이드는 처리 실패로 남고, 예전 해설이 있으면 그대로 둡니다). 8장보다 많이 묶은 호출과 이미지가 든 호출은 제한 시간을 그만큼 늘려 잡습니다.",
        aliases: ["timeout", "CLI"],
        control: {
          type: "number",
          key: "cliTimeoutSec",
          min: 30,
          defaultValue: DEFAULT_SETTINGS.cliTimeoutSec,
          get: () => this.settings.cliTimeoutSec,
          set: (n) => (this.settings.cliTimeoutSec = n),
        },
      },
      {
        name: "바뀐 슬라이드만 다시 생성",
        desc: "다시 가져올 때 텍스트 해시와 이미지 신호가 모두 같은 슬라이드는 기존 해설을 그대로 씁니다.",
        aliases: ["re-import", "hash"],
        control: { type: "toggle", key: "generation.onlyChangedSlides", get: () => g().onlyChangedSlides, set: (value) => (g().onlyChangedSlides = value) },
      },
      {
        name: "핵심 다이어그램 이미지 저장",
        desc: "도표·그림 위주 슬라이드(강의당 최대 8장)를 과목 폴더 안 Attachments/<강의>-<쪽>.png 파일로 저장하고 해당 슬라이드 해설 안에 넣습니다. 스크립트로 고르므로 토큰이 들지 않습니다.",
        aliases: ["diagram", "image", "Attachments"],
        control: { type: "toggle", key: "generation.saveKeyDiagrams", get: () => g().saveKeyDiagrams, set: (value) => (g().saveKeyDiagrams = value) },
      },
    ];
  }

  // ---- usage ----

  private usageRow(): Row {
    return {
      name: "누적 사용량",
      aliases: ["usage", "token", "토큰", "호출"],
      setting: (setting) => {
        const u = this.plugin.data.usageTotals;
        setting.setDesc(
          u.calls === 0
            ? "아직 기록이 없습니다."
            : `${u.since || "처음"}부터 강의 ${u.lectures}개, 호출 ${u.calls}회, 입력 ${compactTokens(u.inputTokens)} 토큰 ` +
                `(캐시 ${compactTokens(u.cachedInputTokens)}), 출력 ${compactTokens(u.outputTokens)} 토큰, 이미지 ${u.imagesSent}장`
        );
        setting.addButton((b) =>
          b.setButtonText("초기화").onClick(async () => {
            this.plugin.data.usageTotals = {
              calls: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              imagesSent: 0,
              costUsd: 0,
              lectures: 0,
              byProvider: {},
              since: "",
            };
            await this.save();
            this.redraw();
          })
        );
      },
    };
  }

  // ---- reading ----

  private viewRows(): Row[] {
    return [
      {
        name: "관리 주석 숨기기",
        desc:
          "강의 노트의 <!-- alt2obs:... --> 줄(슬라이드 표시, 해시, 메타데이터, 요약 구간 표시)을 Live Preview와 synced viewer에서 감춥니다. " +
          "커서가 그 줄이나 바로 위아래 줄에 있으면 보이고, 소스 모드에서는 항상 보입니다. 감춘 줄은 실수로 지워지지 않게 편집을 막습니다. " +
          "직접 쓴 줄이라도 한 줄 전체가 <!-- alt2obs 로 시작하는 주석이면 함께 감춰집니다. 노트 내용은 바뀌지 않으며 이 줄들은 다시 가져올 때 메모를 지키는 데 쓰이니 지우지 마세요.",
        aliases: ["comment", "alt2obs", "Live Preview"],
        control: {
          type: "toggle",
          key: "hideManagedComments",
          get: () => this.settings.hideManagedComments,
          set: (value) => (this.settings.hideManagedComments = value),
          after: () => this.plugin.applyCommentHiding(),
        },
      },
      {
        name: "강의 PDF를 열면 뷰어로 열기",
        desc:
          "파일 탐색기나 링크로 강의 PDF(같은 폴더에 같은 이름의 강의 노트가 있는 PDF)를 열면 그 탭이 PDF와 노트를 나란히 보여주는 synced viewer로 바뀝니다. " +
          "같은 강의의 뷰어가 이미 열려 있으면 그 탭을 보여줍니다. 뷰어의 'PDF만 보기'로 연 탭, Obsidian을 켤 때나 이 설정을 켤 때 이미 열려 있던 PDF 탭은 그대로 둡니다. " +
          "강의 노트(.md)를 열 때는 바뀌지 않습니다.",
        aliases: ["PDF", "viewer", "synced viewer"],
        control: {
          type: "toggle",
          key: "openPdfInViewer",
          get: () => this.settings.openPdfInViewer,
          set: (value) => {
            this.settings.openPdfInViewer = value;
            // PDF tabs already open stay PDFs; only PDFs opened from now on become the viewer.
            if (value) this.plugin.keepOpenPdfTabsPlain();
          },
        },
      },
    ];
  }

  // ---- storage ----

  private storageRows(): Row[] {
    return [
      {
        name: "저장 폴더",
        desc: "Vault 내에서 노트가 저장될 기본 폴더",
        aliases: ["folder", "vault"],
        control: {
          type: "text",
          key: "baseFolderPath",
          placeholder: DEFAULT_SETTINGS.baseFolderPath,
          get: () => this.settings.baseFolderPath,
          set: (value) => {
            this.settings.baseFolderPath = value || DEFAULT_SETTINGS.baseFolderPath;
          },
          after: () => this.plugin.updateBasePath(),
        },
      },
      {
        name: "Alt 데이터 폴더",
        desc:
          "Alt 노트 목록을 읽을 Alt 앱 데이터 폴더. 비우면 기본 위치(macOS: ~/Library/Application Support/alt, Windows: %APPDATA%\\alt, Linux: ~/.config/alt). " +
          "플러그인은 이 폴더를 읽기만 합니다. Alt가 실행 중이면 로컬 API(토큰 파일)로 읽고, API를 쓸 수 없으면(Alt가 꺼져 있거나, Alt 설정에서 로컬 서버를 껐거나, " +
          "그 포트의 프로그램이 Alt인지 확인하지 못한 경우) 데이터베이스를 임시 폴더에 복사해 읽습니다. Alt가 실행 중이어도 동기화된 슬라이드 파일의 위치를 찾을 때는 " +
          "사본을 만듭니다. 사본은 다시 연결하거나 플러그인을 끌 때 지웁니다.",
        aliases: ["Alt", "folder", "database", "DB", "token"],
        control: {
          type: "text",
          key: "altDataDir",
          placeholder: "(기본 위치)",
          get: () => this.settings.altDataDir,
          set: (value) => {
            this.settings.altDataDir = value.trim();
          },
        },
      },
      {
        name: "개념 노트 언어",
        aliases: ["language", "concept"],
        control: {
          type: "dropdown",
          key: "language",
          options: { ko: "한국어", en: "English" },
          get: () => this.settings.language,
          set: (value) => (this.settings.language = value as "ko" | "en"),
        },
      },
    ];
  }
}

const DISCLOSURE =
  "Claude CLI나 Codex CLI를 고르면 이 플러그인이 컴퓨터에 설치된 claude / codex 프로그램을 직접 실행합니다. " +
  "호출은 사용자 계정의 구독 한도(또는 API 사용량)를 소모합니다. 실행은 vault 밖 임시 폴더에서 읽기 전용으로 하고, " +
  "노트는 플러그인만 씁니다. 가져오기 전에 사이드바에서 예상 호출 수와 토큰을 확인할 수 있습니다.";

const CLI_PATH_DESC = "비워 두면 자동으로 찾습니다 (로그인 셸의 command -v 결과를 한 번 저장).";

const MODEL_NOTE =
  "모델 목록: 버전이 붙은 항목(예: Opus 5.5)은 그 모델 이름을 그대로 CLI에 넘겨 늘 같은 모델로 실행합니다. sonnet, opus 같은 별칭은 CLI가 그때의 최신 모델로 바꿔 실행하며, " +
  "괄호 안의 '현재'는 마지막 실행에서 CLI가 알려 준 모델입니다. 목록은 Claude Code와 Codex가 저장해 둔 모델 목록에서 읽습니다(모델 호출 없음). " +
  "effort 목록은 고른 모델이 지원하는 단계만 보여줍니다. 모르는 모델은 모든 단계를 보여주며, 지원하지 않는 단계는 CLI가 처리합니다(오류가 나면 effort를 낮추세요). " +
  "사이드바의 가져오기와 노트 검증에서도 실행 직전에 이번 실행의 모델을 바꿀 수 있습니다. 여기 값은 그 기본값입니다.";

const HELP = [
  "강의 노트는 PDF 슬라이드와 1:1로 대응하는 섹션으로 생성됩니다. " +
    "각 섹션 아래 `> [!note] 내 메모` 블록은 자유롭게 편집해도 다음 가져오기 때 그대로 보존됩니다.",
  "강의 PDF를 열면 PDF와 노트가 좌우로 동기 스크롤되는 synced viewer가 열립니다('보기' 설정에서 끌 수 있음). " +
    "강의 노트(.md)에서는 명령 팔레트의 'Open synced viewer (PDF + lecture .md)'나 사이드바의 '뷰어로 열기'를 쓰세요.",
];

/** One more search word per task. */
const TASK_ALIASES: Record<TaskId, string> = {
  commentary: "commentary",
  concepts: "concepts",
  alignment: "transcript",
  verification: "verification",
};

/** A row as an Obsidian 1.13 definition. */
function definition(row: Row): SettingDefinition {
  const base = { name: row.name, desc: row.desc, aliases: row.aliases, visible: row.visible };
  const { control, setting, block } = row;
  if (control) return { ...base, control: obsidianControl(control) };
  if (setting) return { ...base, render: (s) => setting(s) };
  return {
    ...base,
    render: (s) => {
      // A block in place of the row's name and description.
      s.settingEl.empty();
      s.settingEl.addClass("alt-to-obs-settings-block");
      block?.(s.settingEl);
    },
  };
}

function obsidianControl(control: Control): SettingControl {
  switch (control.type) {
    case "toggle":
      return { type: "toggle", key: control.key };
    case "dropdown":
      return { type: "dropdown", key: control.key, options: control.options };
    case "text":
      return { type: "text", key: control.key, placeholder: control.placeholder };
    case "number":
      return { type: "number", key: control.key, min: control.min, defaultValue: control.defaultValue };
  }
}
