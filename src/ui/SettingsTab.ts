import { App, PluginSettingTab, Setting } from "obsidian";
import type Alt2ObsidianPlugin from "../main";

export class Alt2ObsidianSettingsTab extends PluginSettingTab {
  plugin: Alt2ObsidianPlugin;

  constructor(app: App, plugin: Alt2ObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Alt2Obsidian 설정" });

    new Setting(containerEl)
      .setName("LLM 제공자")
      .setDesc("사용할 LLM 서비스를 선택하세요. Ollama는 로컬에서 무료·무제한 (GPU 권장).")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gemini", "Google Gemini / Gemma")
          .addOption("ollama", "Ollama (local)")
          .addOption("openai", "OpenAI (준비 중)")
          .addOption("claude", "Claude (준비 중)")
          .setValue(this.plugin.data.settings.provider)
          .onChange(async (value) => {
            this.plugin.data.settings.provider = value as
              | "gemini"
              | "openai"
              | "claude"
              | "ollama";
            await this.plugin.savePluginData();
            this.display(); // re-render to show/hide provider-specific fields
          })
      );

    if (this.plugin.data.settings.provider === "ollama") {
      new Setting(containerEl)
        .setName("Ollama endpoint")
        .setDesc("로컬 Ollama 서버 URL")
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:11434")
            .setValue(this.plugin.data.settings.ollamaEndpoint)
            .onChange(async (value) => {
              this.plugin.data.settings.ollamaEndpoint =
                value || "http://localhost:11434";
              await this.plugin.savePluginData();
            })
        );

      new Setting(containerEl)
        .setName("Ollama 모델")
        .setDesc(
          "텍스트만: gemma3:4b, gemma3:12b · 멀티모달(슬라이드 해설용): llama3.2-vision:11b. 'ollama pull <model>'로 먼저 다운로드 필요."
        )
        .addText((text) =>
          text
            .setPlaceholder("gemma3:4b")
            .setValue(this.plugin.data.settings.ollamaModel)
            .onChange(async (value) => {
              this.plugin.data.settings.ollamaModel = value || "gemma3:4b";
              await this.plugin.savePluginData();
            })
        );
    }

    new Setting(containerEl)
      .setName("API 키")
      .setDesc("개인 API 키를 입력하세요. Google AI Studio에서 무료로 발급 가능하며, 무료 등급으로도 충분히 사용할 수 있습니다.")
      .addText((text) =>
        text
          .setPlaceholder("API 키 입력...")
          .setValue(this.plugin.data.settings.apiKey)
          .then((t) => {
            t.inputEl.type = "password";
          })
          .onChange(async (value) => {
            this.plugin.data.settings.apiKey = value;
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Gemini 모델")
      .setDesc("사용할 Gemini 모델 이름")
      .addText((text) =>
        text
          .setPlaceholder("gemini-2.0-flash")
          .setValue(this.plugin.data.settings.geminiModel)
          .onChange(async (value) => {
            this.plugin.data.settings.geminiModel = value || "gemini-2.0-flash";
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("저장 폴더")
      .setDesc("Vault 내에서 노트가 저장될 기본 폴더")
      .addText((text) =>
        text
          .setPlaceholder("Alt2Obsidian")
          .setValue(this.plugin.data.settings.baseFolderPath)
          .onChange(async (value) => {
            this.plugin.data.settings.baseFolderPath =
              value || "Alt2Obsidian";
            await this.plugin.savePluginData();
            this.plugin.updateBasePath();
          })
      );

    new Setting(containerEl)
      .setName("API 요청 간격 (ms)")
      .setDesc(
        "LLM API 호출 간 대기 시간 (rate limit 방지). " +
          "1.1.0부터 강의 1개당 슬라이드 수만큼 호출되므로 " +
          "free-tier RPM 한계가 가까운 사용자는 4000ms 이상을 권장합니다."
      )
      .addText((text) =>
        text
          .setPlaceholder("4000")
          .setValue(String(this.plugin.data.settings.rateDelayMs))
          .onChange(async (value) => {
            const num = parseInt(value) || 4000;
            this.plugin.data.settings.rateDelayMs = Math.max(1000, num);
            await this.plugin.savePluginData();
          })
      );

    containerEl.createEl("h3", { text: "사용법" });
    const usageEl = containerEl.createEl("div", {
      cls: "setting-item-description",
    });
    usageEl.createEl("p", {
      text:
        "1.1.0부터 강의 노트는 PDF 슬라이드와 1:1로 페이지 별 섹션으로 생성됩니다. " +
        "각 섹션 안의 `> [!note] 내 메모` 블록은 자유롭게 편집해도 다음 import 시 그대로 보존됩니다.",
    });
    usageEl.createEl("p", {
      text:
        "강의 노트(.md)를 열고 명령 팔레트에서 'Open Synced Viewer (PDF + lecture .md)'를 실행하면 " +
        "PDF와 노트가 좌우로 동기 스크롤되는 전용 뷰가 열립니다. " +
        "PDF 페이지를 넘기면 노트의 해당 슬라이드 섹션으로 자동 스크롤됩니다.",
    });
  }
}
