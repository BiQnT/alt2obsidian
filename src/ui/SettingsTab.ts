import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type Alt2ObsPlugin from "../main";
import { CliName, DEFAULT_SETTINGS, EffortLevel, PresetId, ProviderId, TaskId } from "../types";
import {
  applyPreset,
  defaultTaskSetting,
  describeDefault,
  effortChoices,
  isCliProvider,
  isSafeModelName,
  LEGACY_KEY_FIELDS,
  ModelCatalog,
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

export class Alt2ObsSettingsTab extends PluginSettingTab {
  plugin: Alt2ObsPlugin;

  constructor(app: App, plugin: Alt2ObsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private get settings() {
    return this.plugin.data.settings;
  }

  private async save(): Promise<void> {
    await this.plugin.savePluginData();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("alt-to-obs-settings");

    const notice = containerEl.createDiv({ cls: "alt-to-obs-disclosure" });
    notice.createEl("strong", { text: "외부 프로그램 실행과 구독 사용량 안내" });
    notice.createEl("p", {
      text:
        "Claude CLI나 Codex CLI를 고르면 이 플러그인이 컴퓨터에 설치된 claude / codex 프로그램을 직접 실행합니다. " +
        "호출은 사용자 계정의 구독 한도(또는 API 사용량)를 소모합니다. 실행은 vault 밖 임시 폴더에서 읽기 전용으로 하고, " +
        "노트는 플러그인만 씁니다. 가져오기 전에 사이드바에서 예상 호출 수와 토큰을 확인할 수 있습니다.",
    });

    this.renderConnections(containerEl);
    this.renderTasks(containerEl);
    this.renderGeneration(containerEl);
    this.renderUsage(containerEl);
    this.renderView(containerEl);
    this.renderStorage(containerEl);
    this.renderHelp(containerEl);
  }

  // ---- LLM connections ----

  private renderConnections(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("LLM 연결").setHeading();
    const grid = containerEl.createDiv({ cls: "alt-to-obs-cards" });
    this.renderCliCard(grid, "claude", "Claude CLI", "claudePath");
    const codexCard = this.renderCliCard(grid, "codex", "Codex CLI", "codexPath");
    codexCard.createDiv({
      cls: "alt-to-obs-muted",
      text:
        "Codex는 호출마다 자체 지시문과 ~/.codex/AGENTS.md가 함께 실려 고정 비용이 큽니다 (이 플러그인 설정으로 줄인 뒤에도 호출당 약 12k 토큰). " +
        "그래서 Codex는 배치 크기의 두 배로 묶어 보냅니다. 또 읽기 전용 샌드박스라도 Codex는 사용자 계정이 읽을 수 있는 파일을 읽을 수 있습니다. " +
        "프롬프트로 주어진 내용만 쓰라고 지시하지만, 이 위험을 감수하는 경우에만 쓰세요.",
    });
    this.renderLegacyKeys(containerEl);
  }

  /**
   * API keys kept from 1.x and beta.3 (Gemini, the old Claude API stub).
   * Nothing uses them any more; they stay only so a rollback keeps working.
   * Shown only while one is stored; removal asks for a second click.
   */
  private renderLegacyKeys(containerEl: HTMLElement): void {
    const stored = this.settings as unknown as Record<string, unknown>;
    const present = LEGACY_KEY_FIELDS.filter((k) => {
      const value = stored[k];
      return typeof value === "string" && value.trim() !== "";
    });
    if (present.length === 0) return;
    let armed = false;
    new Setting(containerEl)
      .setName("이전 API 키 지우기")
      .setDesc(
        `예전 버전에서 저장한 API 키(${present.join(", ")})가 data.json에 남아 있습니다. 지금 버전은 쓰지 않습니다. ` +
          "지우면 2.0.0-beta.3 이하로 되돌렸을 때 Gemini 키를 다시 넣어야 합니다."
      )
      .addButton((b) =>
        b.setButtonText("지우기").onClick(async () => {
          if (!armed) {
            armed = true;
            b.setButtonText("한 번 더 누르면 지웁니다");
            b.setWarning();
            window.setTimeout(() => {
              if (!armed) return;
              armed = false;
              b.setButtonText("지우기");
              b.buttonEl.removeClass("mod-warning");
            }, 5000);
            return;
          }
          armed = false;
          for (const k of LEGACY_KEY_FIELDS) delete stored[k];
          await this.save();
          new Notice("이전 API 키를 data.json에서 지웠습니다.");
          this.display();
        })
      );
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
    field.createDiv({ cls: "alt-to-obs-card-desc", text: "비워 두면 자동으로 찾습니다 (로그인 셸의 command -v 결과를 한 번 저장)." });
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

  private renderTasks(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("작업별 모델").setHeading();
    new Setting(containerEl)
      .setName("프리셋")
      .setDesc(
        "절약: 모든 작업에 경량 모델(Claude는 haiku)과 effort low. 품질: 해설과 검증에 상위 모델(Claude는 opus)과 effort high. " +
          "프로바이더는 바꾸지 않습니다. 아래에서 직접 바꾸면 '사용자 지정'이 됩니다."
      )
      .addDropdown((dropdown) => {
        for (const id of Object.keys(PRESET_LABELS) as PresetId[]) dropdown.addOption(id, PRESET_LABELS[id]);
        dropdown.setValue(this.settings.preset).onChange(async (value) => {
          applyPreset(this.settings, value as PresetId);
          await this.save();
          this.display();
        });
      });

    const catalog = this.plugin.modelCatalog();
    for (const id of TASK_IDS) this.renderTaskRow(containerEl, id, catalog);
    containerEl.createDiv({
      cls: "alt-to-obs-muted alt-to-obs-settings-note",
      text:
        "모델 목록: 버전이 붙은 항목(예: Opus 5.5)은 그 모델 이름을 그대로 CLI에 넘겨 늘 같은 모델로 실행합니다. sonnet, opus 같은 별칭은 CLI가 그때의 최신 모델로 바꿔 실행하며, " +
        "괄호 안의 '현재'는 마지막 실행에서 CLI가 알려 준 모델입니다. 목록은 Claude Code와 Codex가 저장해 둔 모델 목록에서 읽습니다(모델 호출 없음). " +
        "effort 목록은 고른 모델이 지원하는 단계만 보여줍니다. 모르는 모델은 모든 단계를 보여주며, 지원하지 않는 단계는 CLI가 처리합니다(오류가 나면 effort를 낮추세요). " +
        "사이드바의 가져오기와 노트 검증에서도 실행 직전에 이번 실행의 모델을 바꿀 수 있습니다. 여기 값은 그 기본값입니다.",
    });

    new Setting(containerEl)
      .setName("Notion MCP 조회 도구")
      .setDesc(
        "노트 검증에서 노션 URL을 넣으면 Claude CLI가 이 도구 하나만 써서 페이지 원문을 가져옵니다. 비우면 `claude mcp list`에서 Notion 서버를 찾아 " +
          "mcp__<서버>__notion-fetch를 씁니다. Notion MCP가 없으면 터미널에서 `claude mcp add --transport http notion https://mcp.notion.com/mcp` 후 `/mcp`로 로그인하세요."
      )
      .addText((text) =>
        text
          .setPlaceholder("자동")
          .setValue(this.settings.notionFetchTool)
          .onChange(async (value) => {
            const v = value.trim();
            if (v && !/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(v)) return;
            this.settings.notionFetchTool = v;
            await this.save();
          })
      );
  }

  /**
   * One task: provider, model and effort as dropdowns. The model list holds
   * the CLI's known models, "CLI 기본값" and "직접 입력" (a text field for
   * any other id). Changing the provider loads that provider's task defaults.
   */
  private renderTaskRow(containerEl: HTMLElement, id: TaskId, catalog: ModelCatalog): void {
    const task = this.settings.tasks[id];
    const notes: Partial<Record<TaskId, string>> = {
      alignment: "정렬은 스크립트로 항상 합니다. 프로바이더를 고르면 불확실한 구간만 한 번 더 확인합니다 (기본 끔).",
      verification: "사이드바 '노트 검증' 탭에서 씁니다. 주장 20개씩 판정합니다.",
    };
    const recommended = describeDefault(isCliProvider(task.provider) ? task.provider : "claude-cli", id);
    let lastText = "";
    if (isCliProvider(task.provider)) {
      // The id the CLI reported on the last run with this model (an alias resolves to a full id).
      const last = catalog.resolved[resolvedKey(task.provider, task.model)];
      const name = last ? modelName(task.provider, last.id, catalog) : "";
      if (last) lastText = `마지막 실행: ${last.id}${name !== last.id ? ` (${name})` : ""}, ${last.at}.`;
    }
    const desc = [notes[id], recommended ? `권장: ${recommended}.` : "", lastText].filter(Boolean).join(" ");
    const setting = new Setting(containerEl).setName(TASK_LABELS[id]).setDesc(desc);
    setting.settingEl.addClass("alt-to-obs-task-setting");
    const changed = async (rerender: boolean) => {
      this.settings.preset = "custom";
      await this.save();
      if (rerender) this.display();
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

  private renderGeneration(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("생성 옵션").setHeading();
    const g = this.settings.generation;
    const numberSetting = (
      name: string,
      desc: string,
      get: () => number,
      set: (n: number) => void,
      min: number
    ) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text.setValue(String(get())).onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isFinite(n) || n < min) return;
            set(n);
            await this.save();
          })
        );

    numberSetting("배치 크기", "CLI 호출 한 번에 보낼 슬라이드 수. 이미지가 섞인 배치는 절반만 보냅니다. Codex는 호출당 고정 비용이 커서 이 값의 두 배로 묶습니다.", () => g.batchSize, (n) => (g.batchSize = n), 1);
    new Setting(containerEl)
      .setName("이미지 전송 규칙")
      .setDesc("자동: 도표·그림 위주 슬라이드와 텍스트가 없는 스캔 PDF만 이미지(긴 변 1024px JPEG)를 함께 보냅니다.")
      .addDropdown((d) =>
        d
          .addOption("auto", "자동")
          .addOption("text-only", "텍스트만 (스캔 PDF 제외)")
          .setValue(g.imageRule)
          .onChange(async (value) => {
            g.imageRule = value as typeof g.imageRule;
            await this.save();
          })
      );
    numberSetting("슬라이드당 전사 상한 (자)", "군말과 반복을 지운 뒤 슬라이드 내용과 겹치는 문장부터 이 길이까지 남깁니다.", () => g.transcriptCapChars, (n) => (g.transcriptCapChars = n), 0);
    numberSetting("강의당 토큰 상한", "예상 입력+출력 토큰이 이 값을 넘으면 시작 전에 멈춥니다. 0이면 상한 없음.", () => g.tokenCapPerLecture, (n) => (g.tokenCapPerLecture = n), 0);
    numberSetting("CLI 호출 제한 시간 (초)", "호출 하나가 이 시간을 넘기면 중단하고 그 슬라이드를 한 번 다시 요청합니다.", () => this.settings.cliTimeoutSec, (n) => (this.settings.cliTimeoutSec = n), 30);
    new Setting(containerEl)
      .setName("바뀐 슬라이드만 다시 생성")
      .setDesc("다시 가져올 때 텍스트 해시와 이미지 신호가 모두 같은 슬라이드는 기존 해설을 그대로 씁니다.")
      .addToggle((t) =>
        t.setValue(g.onlyChangedSlides).onChange(async (value) => {
          g.onlyChangedSlides = value;
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName("핵심 다이어그램 이미지 저장")
      .setDesc("도표·그림 위주 슬라이드(강의당 최대 8장)를 과목 폴더 안 Attachments/<강의>-<쪽>.png 파일로 저장하고 해당 슬라이드 해설 안에 넣습니다. 스크립트로 고르므로 토큰이 들지 않습니다.")
      .addToggle((t) =>
        t.setValue(g.saveKeyDiagrams).onChange(async (value) => {
          g.saveKeyDiagrams = value;
          await this.save();
        })
      );
  }

  // ---- usage ----

  private renderUsage(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("사용량").setHeading();
    const u = this.plugin.data.usageTotals;
    const desc =
      u.calls === 0
        ? "아직 기록이 없습니다."
        : `${u.since || "처음"}부터 강의 ${u.lectures}개, 호출 ${u.calls}회, 입력 ${compactTokens(u.inputTokens)} 토큰 ` +
          `(캐시 ${compactTokens(u.cachedInputTokens)}), 출력 ${compactTokens(u.outputTokens)} 토큰, 이미지 ${u.imagesSent}장`;
    new Setting(containerEl)
      .setName("누적 사용량")
      .setDesc(desc)
      .addButton((b) =>
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
          this.display();
        })
      );
  }

  // ---- reading ----

  private renderView(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("보기").setHeading();
    new Setting(containerEl)
      .setName("관리 주석 숨기기")
      .setDesc(
        "강의 노트의 <!-- alt2obs:... --> 줄(슬라이드 표시, 해시, 메타데이터, 요약 구간 표시)을 Live Preview와 synced viewer에서 감춥니다. " +
          "커서가 그 줄이나 바로 위아래 줄에 있으면 보이고, 소스 모드에서는 항상 보입니다. 감춘 줄은 실수로 지워지지 않게 편집을 막습니다. " +
          "직접 쓴 줄이라도 한 줄 전체가 <!-- alt2obs 로 시작하는 주석이면 함께 감춰집니다. 노트 내용은 바뀌지 않으며 이 줄들은 다시 가져올 때 메모를 지키는 데 쓰이니 지우지 마세요."
      )
      .addToggle((t) =>
        t.setValue(this.settings.hideManagedComments).onChange(async (value) => {
          this.settings.hideManagedComments = value;
          await this.save();
          this.plugin.applyCommentHiding();
        })
      );
    new Setting(containerEl)
      .setName("강의 PDF를 열면 뷰어로 열기")
      .setDesc(
        "파일 탐색기나 링크로 강의 PDF(같은 폴더에 같은 이름의 강의 노트가 있는 PDF)를 열면 그 탭이 PDF와 노트를 나란히 보여주는 synced viewer로 바뀝니다. " +
          "같은 강의의 뷰어가 이미 열려 있으면 그 탭을 보여줍니다. 뷰어의 'PDF만 보기'로 연 탭, Obsidian을 켤 때나 이 설정을 켤 때 이미 열려 있던 PDF 탭은 그대로 둡니다. " +
          "강의 노트(.md)를 열 때는 바뀌지 않습니다."
      )
      .addToggle((t) =>
        t.setValue(this.settings.openPdfInViewer).onChange(async (value) => {
          this.settings.openPdfInViewer = value;
          // PDF tabs already open stay PDFs; only PDFs opened from now on become the viewer.
          if (value) this.plugin.keepOpenPdfTabsPlain();
          await this.save();
        })
      );
  }

  // ---- storage and help ----

  private renderStorage(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("저장").setHeading();
    new Setting(containerEl)
      .setName("저장 폴더")
      .setDesc("Vault 내에서 노트가 저장될 기본 폴더")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.baseFolderPath)
          .setValue(this.settings.baseFolderPath)
          .onChange(async (value) => {
            this.settings.baseFolderPath = value || DEFAULT_SETTINGS.baseFolderPath;
            await this.save();
            this.plugin.updateBasePath();
          })
      );
    new Setting(containerEl)
      .setName("Alt 데이터 폴더")
      .setDesc(
        "Alt 노트 목록을 읽을 Alt 앱 데이터 폴더. 비우면 기본 위치(macOS: ~/Library/Application Support/alt, Windows: %APPDATA%\\alt). " +
          "플러그인은 이 폴더를 읽기만 합니다: Alt가 실행 중이면 로컬 API(토큰 파일), 꺼져 있으면 데이터베이스를 임시 폴더에 복사해 읽습니다."
      )
      .addText((text) =>
        text
          .setPlaceholder("(기본 위치)")
          .setValue(this.settings.altDataDir)
          .onChange(async (value) => {
            this.settings.altDataDir = value.trim();
            await this.save();
          })
      );
    new Setting(containerEl)
      .setName("개념 노트 언어")
      .addDropdown((d) =>
        d
          .addOption("ko", "한국어")
          .addOption("en", "English")
          .setValue(this.settings.language)
          .onChange(async (value) => {
            this.settings.language = value as "ko" | "en";
            await this.save();
          })
      );
  }

  private renderHelp(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("사용법").setHeading();
    const usageEl = containerEl.createDiv({ cls: "setting-item-description" });
    usageEl.createEl("p", {
      text:
        "강의 노트는 PDF 슬라이드와 1:1로 대응하는 섹션으로 생성됩니다. " +
        "각 섹션 아래 `> [!note] 내 메모` 블록은 자유롭게 편집해도 다음 가져오기 때 그대로 보존됩니다.",
    });
    usageEl.createEl("p", {
      text:
        "강의 PDF를 열면 PDF와 노트가 좌우로 동기 스크롤되는 synced viewer가 열립니다('보기' 설정에서 끌 수 있음). " +
        "강의 노트(.md)에서는 명령 팔레트의 'Open synced viewer (PDF + lecture .md)'나 사이드바의 '뷰어로 열기'를 쓰세요.",
    });
  }
}
