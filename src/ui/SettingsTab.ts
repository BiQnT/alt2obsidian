import { App, PluginSettingTab, Setting } from "obsidian";
import type Alt2ObsidianPlugin from "../main";
import { CliName, EffortLevel, PresetId, ProviderId, TaskId, TaskLLMSetting } from "../types";
import {
  applyPreset,
  EFFORT_LEVELS,
  isCliProvider,
  PRESET_LABELS,
  PROVIDER_LABELS,
  TASK_IDS,
  TASK_LABELS,
} from "../settings/llmSettings";
import { compactTokens } from "../llm/usage";

/** Aliases the Claude CLI resolves to its current models; offered as suggestions only. */
const CLAUDE_ALIASES = ["sonnet", "opus", "haiku"];
const TASK_PROVIDERS: ProviderId[] = ["claude-cli", "codex-cli", "gemini", "ollama"];

export class Alt2ObsidianSettingsTab extends PluginSettingTab {
  plugin: Alt2ObsidianPlugin;

  constructor(app: App, plugin: Alt2ObsidianPlugin) {
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
    containerEl.addClass("alt2obsidian-settings");

    containerEl.createEl("h2", { text: "Alt2Obsidian 설정" });
    const notice = containerEl.createDiv({ cls: "alt2obsidian-disclosure" });
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
    this.renderStorage(containerEl);
    this.renderHelp(containerEl);
  }

  // ---- LLM connections ----

  private renderConnections(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "LLM 연결" });
    const grid = containerEl.createDiv({ cls: "alt2obsidian-cards" });
    this.renderCliCard(grid, "claude", "Claude CLI", "claudePath");
    this.renderCliCard(grid, "codex", "Codex CLI", "codexPath");

    const gemini = grid.createDiv({ cls: "alt2obsidian-card" });
    gemini.createEl("h4", { text: "Gemini API" });
    gemini.createDiv({ cls: "alt2obsidian-card-status", text: this.settings.apiKey ? "API 키 입력됨" : "API 키 없음 (Gemini를 쓸 때만 필요)" });
    new Setting(gemini)
      .setName("API 키")
      .setDesc("Google AI Studio 키. 콤마로 여러 개를 넣으면 429 때 돌아가며 씁니다.")
      .addText((text) =>
        text
          .setPlaceholder("API 키 입력...")
          .setValue(this.settings.apiKey)
          .then((t) => {
            t.inputEl.type = "password";
          })
          .onChange(async (value) => {
            this.settings.apiKey = value;
            await this.save();
          })
      );
    new Setting(gemini)
      .setName("Gemini 모델")
      .setDesc("작업 표에서 모델을 비워 둔 Gemini 작업이 쓰는 모델")
      .addText((text) =>
        text
          .setPlaceholder("gemini-2.5-flash")
          .setValue(this.settings.geminiModel)
          .onChange(async (value) => {
            this.settings.geminiModel = value || "gemini-2.5-flash";
            await this.save();
          })
      );
    new Setting(gemini)
      .setName("API 요청 간격 (ms)")
      .setDesc("Gemini 호출 사이 대기 시간. 무료 등급이면 4000 이상 권장.")
      .addText((text) =>
        text
          .setPlaceholder("4000")
          .setValue(String(this.settings.rateDelayMs))
          .onChange(async (value) => {
            this.settings.rateDelayMs = Math.max(1000, parseInt(value) || 4000);
            await this.save();
          })
      );

    const ollama = grid.createDiv({ cls: "alt2obsidian-card" });
    ollama.createEl("h4", { text: "Ollama (로컬)" });
    new Setting(ollama)
      .setName("Endpoint")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.settings.ollamaEndpoint)
          .onChange(async (value) => {
            this.settings.ollamaEndpoint = value || "http://localhost:11434";
            await this.save();
          })
      );
    new Setting(ollama)
      .setName("기본 모델")
      .setDesc("슬라이드 해설에는 멀티모달 모델(예: llama3.2-vision:11b)")
      .addText((text) =>
        text
          .setPlaceholder("gemma3:4b")
          .setValue(this.settings.ollamaModel)
          .onChange(async (value) => {
            this.settings.ollamaModel = value || "gemma3:4b";
            await this.save();
          })
      );
  }

  private renderCliCard(
    grid: HTMLElement,
    name: CliName,
    label: string,
    pathKey: "claudePath" | "codexPath"
  ): void {
    const card = grid.createDiv({ cls: "alt2obsidian-card" });
    card.createEl("h4", { text: label });
    const status = card.createDiv({ cls: "alt2obsidian-card-status" });
    const renderStatus = () => {
      status.empty();
      const found = this.plugin.data.cliDetection[name];
      if (found) {
        status.addClass("is-ok");
        status.removeClass("is-missing");
        status.createDiv({ text: `찾음: ${found.version || "버전 확인 실패"}` });
        status.createDiv({ text: found.path, cls: "alt2obsidian-mono" });
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

    new Setting(card)
      .setName("실행 파일 경로")
      .setDesc("비워 두면 자동으로 찾습니다 (로그인 셸의 command -v 결과를 한 번 저장).")
      .addText((text) =>
        text
          .setPlaceholder(`/.../bin/${name}`)
          .setValue(this.settings[pathKey])
          .onChange(async (value) => {
            this.settings[pathKey] = value.trim();
            await this.save();
          })
      )
      .addButton((button) =>
        button.setButtonText("다시 찾기").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("찾는 중...");
          await this.plugin.detectCli(name, true);
          button.setDisabled(false);
          button.setButtonText("다시 찾기");
          renderStatus();
        })
      );
  }

  // ---- per-task table ----

  private renderTasks(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "작업별 모델" });
    new Setting(containerEl)
      .setName("프리셋")
      .setDesc("절약: 모든 작업에 경량 모델과 low effort. 품질: 해설과 검증에 상위 모델과 high effort. 프로바이더는 바꾸지 않습니다.")
      .addDropdown((dropdown) => {
        for (const id of Object.keys(PRESET_LABELS) as PresetId[]) dropdown.addOption(id, PRESET_LABELS[id]);
        dropdown.setValue(this.settings.preset).onChange(async (value) => {
          applyPreset(this.settings, value as PresetId);
          await this.save();
          this.display();
        });
      });

    const table = containerEl.createEl("table", { cls: "alt2obsidian-task-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["작업", "프로바이더", "모델", "effort"]) head.createEl("th", { text: h });
    const body = table.createEl("tbody");
    for (const id of TASK_IDS) this.renderTaskRow(body, id);
  }

  private renderTaskRow(body: HTMLElement, id: TaskId): void {
    const task = this.settings.tasks[id];
    const row = body.createEl("tr");
    const nameCell = row.createEl("td");
    nameCell.createDiv({ text: TASK_LABELS[id] });
    const reserved = id === "alignment" || id === "verification";
    if (id === "alignment") nameCell.createDiv({ cls: "alt2obsidian-muted", text: "이번 버전은 스크립트만 씀" });
    if (id === "verification") nameCell.createDiv({ cls: "alt2obsidian-muted", text: "노트 검증 기능과 함께 제공 예정" });

    const markCustom = () => {
      this.settings.preset = "custom";
    };

    const providerSelect = row.createEl("td").createEl("select", { cls: "dropdown" });
    const providers: Array<ProviderId | "none"> = id === "alignment" ? ["none", ...TASK_PROVIDERS] : TASK_PROVIDERS;
    for (const p of providers) {
      const opt = providerSelect.createEl("option", { text: PROVIDER_LABELS[p] });
      opt.value = p;
    }
    providerSelect.value = task.provider;
    providerSelect.disabled = reserved;
    providerSelect.addEventListener("change", async () => {
      task.provider = providerSelect.value as TaskLLMSetting["provider"];
      if (!isCliProvider(task.provider)) task.effort = "";
      markCustom();
      await this.save();
      this.display();
    });

    const modelCell = row.createEl("td");
    const listId = `alt2obsidian-models-${id}`;
    const input = modelCell.createEl("input", {
      type: "text",
      attr: { list: listId, placeholder: this.modelPlaceholder(task.provider) },
    });
    input.value = task.model;
    input.disabled = reserved || task.provider === "none";
    const datalist = modelCell.createEl("datalist", { attr: { id: listId } });
    for (const m of this.modelSuggestions(task.provider)) datalist.createEl("option", { attr: { value: m } });
    input.addEventListener("change", async () => {
      task.model = input.value.trim();
      markCustom();
      await this.save();
    });

    const effortSelect = row.createEl("td").createEl("select", { cls: "dropdown" });
    for (const level of EFFORT_LEVELS) {
      const opt = effortSelect.createEl("option", { text: level || "기본값" });
      opt.value = level;
    }
    effortSelect.value = task.effort;
    effortSelect.disabled = reserved || !isCliProvider(task.provider);
    effortSelect.addEventListener("change", async () => {
      task.effort = effortSelect.value as EffortLevel;
      markCustom();
      await this.save();
    });
  }

  private modelPlaceholder(provider: ProviderId | "none"): string {
    switch (provider) {
      case "claude-cli":
      case "codex-cli":
        return "비우면 CLI 기본 모델";
      case "gemini":
        return this.settings.geminiModel;
      case "ollama":
        return this.settings.ollamaModel;
      default:
        return "";
    }
  }

  private modelSuggestions(provider: ProviderId | "none"): string[] {
    if (provider === "none") return [];
    const recent = this.settings.recentModels[provider] ?? [];
    const extra = provider === "claude-cli" ? CLAUDE_ALIASES : [];
    return Array.from(new Set([...recent, ...extra]));
  }

  // ---- generation options ----

  private renderGeneration(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "생성 옵션" });
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

    numberSetting("배치 크기", "CLI 호출 한 번에 보낼 슬라이드 수. 이미지가 섞인 배치는 절반만 보냅니다.", () => g.batchSize, (n) => (g.batchSize = n), 1);
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
      .setDesc("이미지 비중이 높은 슬라이드를 Attachments에 저장하고 노트에 넣습니다. 설정만 먼저 저장되며, 삽입 기능은 다음 베타에서 켜집니다.")
      .addToggle((t) =>
        t.setValue(g.saveKeyDiagrams).onChange(async (value) => {
          g.saveKeyDiagrams = value;
          await this.save();
        })
      );
  }

  // ---- usage ----

  private renderUsage(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "사용량" });
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

  // ---- storage and help ----

  private renderStorage(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "저장" });
    new Setting(containerEl)
      .setName("저장 폴더")
      .setDesc("Vault 내에서 노트가 저장될 기본 폴더")
      .addText((text) =>
        text
          .setPlaceholder("Alt2Obsidian")
          .setValue(this.settings.baseFolderPath)
          .onChange(async (value) => {
            this.settings.baseFolderPath = value || "Alt2Obsidian";
            await this.save();
            this.plugin.updateBasePath();
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
    containerEl.createEl("h3", { text: "사용법" });
    const usageEl = containerEl.createEl("div", { cls: "setting-item-description" });
    usageEl.createEl("p", {
      text:
        "강의 노트는 PDF 슬라이드와 1:1로 대응하는 섹션으로 생성됩니다. " +
        "각 섹션 아래 `> [!note] 내 메모` 블록은 자유롭게 편집해도 다음 가져오기 때 그대로 보존됩니다.",
    });
    usageEl.createEl("p", {
      text:
        "강의 노트(.md)를 열고 명령 팔레트에서 'Open Synced Viewer (PDF + lecture .md)'를 실행하면 " +
        "PDF와 노트가 좌우로 동기 스크롤되는 전용 뷰가 열립니다.",
    });
  }
}
