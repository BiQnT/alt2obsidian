import { ItemView, WorkspaceLeaf, TFile, Modal } from "obsidian";
import type Alt2ObsidianPlugin from "../main";
import { ImportPreview, ExamPeriod, ImportUpdateSummary } from "../types";

export const VIEW_TYPE_SIDEBAR = "alt2obsidian-sidebar";

export class Alt2ObsidianSidebarView extends ItemView {
  private plugin: Alt2ObsidianPlugin;
  private urlInput: HTMLInputElement | null = null;
  private subjectInput: HTMLInputElement | null = null;
  private importBtn: HTMLButtonElement | null = null;
  private progressContainer: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private progressText: HTMLElement | null = null;
  private messageContainer: HTMLElement | null = null;
  private recentListContainer: HTMLElement | null = null;
  private examContainer: HTMLElement | null = null;
  private examPeriodSelect: HTMLSelectElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: Alt2ObsidianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR;
  }

  getDisplayText(): string {
    return "Alt2Obsidian";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("alt2obsidian-sidebar");

    this.renderInputSection(container);
    this.renderProgressSection(container);
    this.renderMessageSection(container);
    this.renderRecentSection(container);
    this.renderExamSection(container);
  }

  private renderInputSection(container: Element): void {
    const section = container.createDiv({ cls: "alt2obsidian-input-section" });

    // URL input row
    const urlRow = section.createDiv({ cls: "alt2obsidian-input-row" });
    this.urlInput = urlRow.createEl("input", {
      type: "text",
      placeholder: "Alt 노트 URL 붙여넣기...",
    });

    this.importBtn = urlRow.createEl("button", {
      text: "가져오기",
      cls: "alt2obsidian-import-btn mod-cta",
    });
    this.importBtn.addEventListener("click", () => this.handleImport());

    // Subject section
    const subjectRow = section.createDiv({ cls: "alt2obsidian-subject-input" });
    subjectRow.createEl("label", { text: "과목명" });

    // Show existing subjects as clickable chips
    const subjects = this.plugin.vaultManager?.getKnownSubjects() || [];
    if (subjects.length > 0) {
      const chipsContainer = subjectRow.createDiv({ cls: "alt2obsidian-subject-chips" });
      for (const s of subjects) {
        const chip = chipsContainer.createEl("span", {
          text: s,
          cls: "alt2obsidian-subject-chip",
        });
        chip.addEventListener("click", () => {
          if (this.subjectInput) this.subjectInput.value = s;
          // Toggle active state
          chipsContainer.querySelectorAll(".alt2obsidian-subject-chip").forEach(
            (c) => c.removeClass("is-active")
          );
          chip.addClass("is-active");
        });
      }
    }

    this.subjectInput = subjectRow.createEl("input", {
      type: "text",
      placeholder: subjects.length > 0
        ? "위에서 선택하거나 새 과목명 입력..."
        : "과목명 입력 (예: CSED311)",
    });

    // Exam period selection
    const periodRow = section.createDiv({ cls: "alt2obsidian-subject-input" });
    periodRow.createEl("label", { text: "시험 범위" });
    this.examPeriodSelect = periodRow.createEl("select", {
      cls: "alt2obsidian-period-select",
    }) as HTMLSelectElement;
    [
      { value: "", text: "없음" },
      { value: "midterm", text: "중간고사" },
      { value: "final", text: "기말고사" },
    ].forEach(({ value, text }) => {
      const opt = this.examPeriodSelect!.createEl("option", { text });
      opt.value = value;
    });
  }

  private renderProgressSection(container: Element): void {
    this.progressContainer = container.createDiv({
      cls: "alt2obsidian-progress",
    });
    this.progressContainer.hide();

    const barOuter = this.progressContainer.createDiv({
      cls: "alt2obsidian-progress-bar",
    });
    this.progressBar = barOuter.createDiv({
      cls: "alt2obsidian-progress-bar-fill",
    });
    this.progressText = this.progressContainer.createDiv({
      cls: "alt2obsidian-progress-text",
    });
  }

  private renderMessageSection(container: Element): void {
    this.messageContainer = container.createDiv();
  }

  private renderRecentSection(container: Element): void {
    container.createEl("h6", {
      text: "최근 가져온 노트",
      cls: "alt2obsidian-section-header",
    });

    this.recentListContainer = container.createDiv({
      cls: "alt2obsidian-recent-list",
    });
    this.refreshRecentList();
  }

  private renderExamSection(container: Element): void {
    container.createEl("h6", {
      text: "시험요약본",
      cls: "alt2obsidian-section-header",
    });

    this.examContainer = container.createDiv({
      cls: "alt2obsidian-exam-section",
    });
    this.refreshExamSection();
  }

  refreshRecentList(): void {
    if (!this.recentListContainer) return;
    this.recentListContainer.empty();

    // Filter out records whose files no longer exist in vault
    const validImports = this.plugin.data.recentImports.filter((record) =>
      this.app.vault.getAbstractFileByPath(record.path)
    );

    // Sync plugin data if stale entries were removed
    if (validImports.length !== this.plugin.data.recentImports.length) {
      this.plugin.data.recentImports = validImports;
      this.plugin.savePluginData();
    }

    if (validImports.length === 0) {
      this.recentListContainer.createDiv({
        text: "아직 가져온 노트가 없습니다",
        cls: "alt2obsidian-empty",
      });
      return;
    }

    for (const record of validImports.slice(0, 20)) {
      const item = this.recentListContainer.createDiv({
        cls: "alt2obsidian-recent-item",
      });

      item.createSpan({
        text: record.title,
        cls: "alt2obsidian-recent-item-title",
      });
      item.createSpan({
        text: record.subject,
        cls: "alt2obsidian-recent-item-subject",
      });
      item.createSpan({
        text: record.date,
        cls: "alt2obsidian-recent-item-date",
      });

      if (record.wasUpdate) {
        item.createSpan({
          text: "업데이트",
          cls: "alt2obsidian-recent-item-updated",
        });
      }

      if (record.parseQuality === "partial") {
        item.createSpan({
          text: "⚠",
          cls: "alt2obsidian-recent-item-partial",
          attr: { title: "Partial import" },
        });
      }

      item.addEventListener("click", () => {
        this.app.workspace.openLinkText(record.path, "", false);
      });
    }
  }

  refreshExamSection(): void {
    if (!this.examContainer) return;
    this.examContainer.empty();

    // Group recent imports by subject (only valid/existing files)
    const subjectMap = new Map<string, { midterm: number; final: number; none: number }>();
    for (const record of this.plugin.data.recentImports) {
      if (!this.app.vault.getAbstractFileByPath(record.path)) continue;
      const counts = subjectMap.get(record.subject) || { midterm: 0, final: 0, none: 0 };
      if (record.examPeriod === "midterm") counts.midterm++;
      else if (record.examPeriod === "final") counts.final++;
      else counts.none++;
      subjectMap.set(record.subject, counts);
    }

    if (subjectMap.size === 0) {
      this.examContainer.createDiv({
        text: "노트를 가져온 후 시험요약본을 생성할 수 있습니다",
        cls: "alt2obsidian-empty",
      });
      return;
    }

    for (const [subject, counts] of subjectMap) {
      const row = this.examContainer.createDiv({
        cls: "alt2obsidian-exam-subject",
      });

      const info = row.createDiv({ cls: "alt2obsidian-exam-subject-info" });
      info.createSpan({ text: subject, cls: "alt2obsidian-exam-subject-name" });

      const countParts: string[] = [];
      if (counts.midterm > 0) countParts.push(`중간 ${counts.midterm}`);
      if (counts.final > 0) countParts.push(`기말 ${counts.final}`);
      if (counts.none > 0) countParts.push(`미분류 ${counts.none}`);
      info.createSpan({
        text: ` (${countParts.join(" / ")})`,
        cls: "alt2obsidian-exam-subject-count",
      });

      const btnRow = row.createDiv({ cls: "alt2obsidian-exam-btn-row" });

      if (counts.midterm > 0) {
        const btn = btnRow.createEl("button", {
          text: "중간",
          cls: "alt2obsidian-exam-btn",
        });
        btn.addEventListener("click", () => this.handleExamSummary(subject, "midterm"));
      }

      if (counts.final > 0) {
        const btn = btnRow.createEl("button", {
          text: "기말",
          cls: "alt2obsidian-exam-btn",
        });
        btn.addEventListener("click", () => this.handleExamSummary(subject, "final"));
      }

      const allBtn = btnRow.createEl("button", {
        text: "전체",
        cls: "alt2obsidian-exam-btn",
      });
      allBtn.addEventListener("click", () => this.handleExamSummary(subject));
    }
  }

  private async handleImport(): Promise<void> {
    const url = this.urlInput?.value?.trim();
    if (!url) {
      this.showError("URL을 입력해주세요");
      return;
    }

    if (!this.plugin.data.settings.apiKey) {
      this.showError("API 키를 설정에서 입력해주세요");
      return;
    }

    this.setLoading(true);
    this.clearMessage();

    try {
      // Phase 1: Preview — scrape Alt note data.
      this.updateProgress(0, "Alt 노트 가져오는 중...");

      const preview = await this.plugin.previewImport(url, (stage, pct) => {
        this.updateProgress(pct, stage);
      });

      // Auto-fill subject if empty
      if (this.subjectInput && !this.subjectInput.value) {
        this.subjectInput.value = preview.suggestedSubject;
      }

      await this.executeImport(url, preview);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "알 수 없는 오류";
      this.showError(msg);
    } finally {
      this.setLoading(false);
    }
  }

  private async executeImport(url: string, preview: ImportPreview): Promise<void> {
    this.updateProgress(0, "LLM 처리 시작...");

    const periodValue = this.examPeriodSelect?.value as ExamPeriod | "" || undefined;
    const examPeriod = periodValue || undefined;

    const result = await this.plugin.importNote(
      url,
      preview,
      this.subjectInput?.value?.trim() || undefined,
      examPeriod,
      (stage, pct) => {
        this.updateProgress(pct, stage);
      },
      (summary) => this.confirmUpdate(summary)
    );

    this.hideProgress();
    const actionLabel = result.wasUpdate ? "업데이트 완료" : "가져오기 완료";
    this.showSuccess(`"${result.title}" → ${result.subject} ${actionLabel}!`);

    if (this.urlInput) this.urlInput.value = "";
    if (this.subjectInput) this.subjectInput.value = "";
    if (this.examPeriodSelect) this.examPeriodSelect.value = "";
    this.containerEl.querySelectorAll(".alt2obsidian-subject-chip").forEach(
      (c) => c.removeClass("is-active")
    );

    this.refreshRecentList();
    this.refreshExamSection();

    // Open note and PDF side by side
    await this.openSideBySide(result.path, result.pdfPath);
  }

  private async openSideBySide(notePath: string, pdfPath?: string): Promise<void> {
    const noteFile = this.app.vault.getAbstractFileByPath(notePath);
    if (!(noteFile instanceof TFile)) return;

    const noteLeaf = this.app.workspace.getLeaf(false);
    await noteLeaf.openFile(noteFile);

    if (pdfPath) {
      const pdfFile = this.app.vault.getAbstractFileByPath(pdfPath);
      if (pdfFile instanceof TFile) {
        // Split vertically: note on left, PDF on right
        const pdfLeaf = (this.app.workspace as any).getLeaf("split", "vertical");
        await pdfLeaf.openFile(pdfFile);
        // Keep focus on the note
        this.app.workspace.setActiveLeaf(noteLeaf, { focus: true });
      }
    }
  }

  private async handleExamSummary(subject: string, period?: ExamPeriod): Promise<void> {
    if (!this.plugin.data.settings.apiKey) {
      this.showError("API 키를 설정에서 입력해주세요");
      return;
    }

    this.clearMessage();
    const label = period === "midterm" ? "중간고사" : period === "final" ? "기말고사" : "전체";
    this.updateProgress(0, `${subject} ${label} 시험요약본 생성 중...`);

    try {
      const path = await this.plugin.generateExamSummary(subject, period);
      this.showSuccess(`시험요약본 생성 완료!`);
      this.hideProgress();

      // Open the generated file
      this.app.workspace.openLinkText(path, "", false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "알 수 없는 오류";
      this.showError(msg);
      this.hideProgress();
    }
  }

  private setLoading(loading: boolean): void {
    if (this.importBtn) {
      this.importBtn.disabled = loading;
      this.importBtn.textContent = loading ? "가져오는 중..." : "가져오기";
    }
    if (loading) {
      this.progressContainer?.show();
    }
  }

  private updateProgress(percent: number, text: string): void {
    this.progressContainer?.show();
    if (this.progressBar) {
      this.progressBar.style.width = `${Math.min(100, percent)}%`;
    }
    if (this.progressText) {
      this.progressText.textContent = text;
    }
  }

  private hideProgress(): void {
    this.progressContainer?.hide();
  }

  private showError(msg: string): void {
    if (!this.messageContainer) return;
    this.messageContainer.empty();
    this.hideProgress();

    const el = this.messageContainer.createDiv({ cls: "alt2obsidian-error" });
    el.createSpan({ text: msg });

    const retry = el.createSpan({
      text: "다시 시도",
      cls: "alt2obsidian-error-retry",
    });
    retry.addEventListener("click", () => {
      this.clearMessage();
      this.handleImport();
    });
  }

  private showSuccess(msg: string): void {
    if (!this.messageContainer) return;
    this.messageContainer.empty();
    this.messageContainer.createDiv({
      text: msg,
      cls: "alt2obsidian-success",
    });
  }

  private clearMessage(): void {
    this.messageContainer?.empty();
  }

  private confirmUpdate(summary: ImportUpdateSummary): Promise<boolean> {
    this.hideProgress();
    return new Promise((resolve) => {
      new UpdatePreviewModal(this.app, summary, resolve).open();
    });
  }

  async onClose(): Promise<void> {
    // Cleanup
  }
}

class UpdatePreviewModal extends Modal {
  private resolved = false;

  constructor(
    app: import("obsidian").App,
    private summary: ImportUpdateSummary,
    private resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("alt2obsidian-update-modal");

    contentEl.createEl("h2", { text: "기존 노트 업데이트" });
    contentEl.createEl("p", {
      text: `${this.summary.changedLineCount}개의 새 줄이 감지되었습니다. 관리 구간만 교체하고 내 메모는 보존합니다.`,
    });

    this.renderList("추가 섹션", this.summary.addedSections);
    this.renderList("제거 섹션", this.summary.removedSections);
    this.renderList("추가 개념", this.summary.addedConcepts);
    this.renderList("제거 개념", this.summary.removedConcepts);

    const actions = contentEl.createDiv({ cls: "alt2obsidian-update-actions" });
    const cancelBtn = actions.createEl("button", { text: "취소" });
    cancelBtn.addEventListener("click", () => this.finish(false));

    const confirmBtn = actions.createEl("button", {
      text: "업데이트",
      cls: "mod-cta",
    });
    confirmBtn.addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    if (!this.resolved) this.resolve(false);
  }

  private renderList(label: string, items: string[]): void {
    const section = this.contentEl.createDiv({
      cls: "alt2obsidian-update-section",
    });
    section.createEl("h3", { text: label });

    if (items.length === 0) {
      section.createEl("p", {
        text: "없음",
        cls: "alt2obsidian-update-empty",
      });
      return;
    }

    const list = section.createEl("ul");
    for (const item of items) {
      list.createEl("li", { text: item });
    }
  }

  private finish(confirmed: boolean): void {
    this.resolved = true;
    this.resolve(confirmed);
    this.close();
  }
}
