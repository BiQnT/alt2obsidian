import { ItemView, WorkspaceLeaf, TFile, Modal, setIcon } from "obsidian";
import type Alt2ObsidianPlugin from "../main";
import type { PreparedImport } from "../main";
import { ImportPreview, ExamPeriod, ImportUpdateSummary, LLMUsage } from "../types";
import { compactTokens } from "../llm/usage";
import { PROVIDER_LABELS } from "../settings/llmSettings";
import { AltNoteDetails, AltNoteSummary, inferSubject } from "../sources";
import { LocalNoteStatus, statusChip, VaultNoteInfo } from "../core/noteStatus";
import { alignmentStatus } from "../pipeline/alignment";

type Tab = "local" | "url";

/** Per-note list state: details and slide comparison load in the background. */
interface LocalItem {
  note: AltNoteSummary;
  details?: AltNoteDetails;
  pageCount?: number | null;
  status: LocalNoteStatus;
  el?: HTMLElement;
}

function formatLectureDate(date: string | null): string {
  const m = date?.match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${Number(m[1])}월 ${Number(m[2])}일` : "날짜 없음";
}

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
  /** Estimate panel and run panel of the CLI path (spec 5.5). */
  private cliPanel: HTMLElement | null = null;
  /** The running CLI import, aborted when the view closes (review M2). */
  private runController: AbortController | null = null;

  // ---- Alt local notes tab (spec 4.1, mockup "1. 가져오기 사이드바") ----
  private tab: Tab = "local";
  private statusChipEl: HTMLElement | null = null;
  private statusDetailEl: HTMLElement | null = null;
  private localPane: HTMLElement | null = null;
  private urlPane: HTMLElement | null = null;
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private searchInput: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;
  private items: LocalItem[] = [];
  private vaultNotes: VaultNoteInfo[] = [];
  private expanded = new Set<string>();
  private selectedId: string | null = null;
  private localSubjectInput: HTMLInputElement | null = null;
  private localPeriodSelect: HTMLSelectElement | null = null;
  private localImportBtn: HTMLButtonElement | null = null;
  /** Bumped on every refresh so a stale background loop stops. */
  private loadGeneration = 0;
  private busy = false;

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

    this.renderHeader(container);
    this.localPane = container.createDiv({ cls: "alt2obsidian-local-pane" });
    this.renderLocalPane(this.localPane);
    this.urlPane = container.createDiv({ cls: "alt2obsidian-url-pane" });
    this.renderInputSection(this.urlPane);
    this.renderProgressSection(container);
    this.cliPanel = container.createDiv({ cls: "alt2obsidian-cli-panel" });
    this.cliPanel.hide();
    this.renderMessageSection(container);
    this.renderRecentSection(container);
    this.renderExamSection(container);
    this.switchTab(this.tab);
    void this.refreshLocal();
  }

  // ---- header, tabs, Alt connection ----

  private renderHeader(container: Element): void {
    const head = container.createDiv({ cls: "alt2obsidian-head" });
    const row = head.createDiv({ cls: "alt2obsidian-head-row" });
    row.createDiv({ cls: "alt2obsidian-head-title", text: "Alt2Obsidian" });
    this.statusChipEl = row.createEl("button", { cls: "alt2obsidian-status-chip", text: "Alt 확인 중..." });
    this.statusChipEl.setAttr("aria-label", "Alt 연결 다시 확인");
    this.statusChipEl.addEventListener("click", () => void this.refreshLocal());
    this.statusDetailEl = head.createDiv({ cls: "alt2obsidian-muted alt2obsidian-status-detail" });
    this.statusDetailEl.hide();
    const tabs = head.createDiv({ cls: "alt2obsidian-tabs" });
    for (const [id, label] of [["local", "Alt 노트 목록"], ["url", "URL 붙여넣기"]] as Array<[Tab, string]>) {
      const b = tabs.createEl("button", { text: label, cls: "alt2obsidian-tab" });
      b.addEventListener("click", () => this.switchTab(id));
      this.tabButtons.set(id, b);
    }
  }

  private switchTab(tab: Tab): void {
    this.tab = tab;
    for (const [id, b] of this.tabButtons) b.toggleClass("is-active", id === tab);
    this.localPane?.toggle(tab === "local");
    this.urlPane?.toggle(tab === "url");
  }

  private setConnection(label: string, kind: "api" | "db" | "none" | "busy", detail: string): void {
    if (!this.statusChipEl) return;
    this.statusChipEl.empty();
    this.statusChipEl.className = `alt2obsidian-status-chip is-${kind}`;
    this.statusChipEl.createSpan({ cls: "alt2obsidian-status-dot" });
    this.statusChipEl.appendText(label);
    if (this.statusDetailEl) {
      this.statusDetailEl.setText(detail);
      this.statusDetailEl.toggle(!!detail && kind !== "api");
    }
  }

  // ---- local notes list ----

  private renderLocalPane(pane: HTMLElement): void {
    const search = pane.createEl("label", { cls: "alt2obsidian-search" });
    const icon = search.createSpan({ cls: "alt2obsidian-search-icon" });
    setIcon(icon, "search");
    this.searchInput = search.createEl("input", { type: "text", placeholder: "강의 제목 검색" });
    this.searchInput.setAttr("aria-label", "Alt 노트 검색");
    this.searchInput.addEventListener("input", () => this.renderList());
    this.listEl = pane.createDiv({ cls: "alt2obsidian-note-list" });
    this.footerEl = pane.createDiv({ cls: "alt2obsidian-note-footer" });
    this.footerEl.hide();
  }

  /** Reconnect (API, else database copy) and reload the note list. */
  async refreshLocal(): Promise<void> {
    const gen = ++this.loadGeneration;
    this.setConnection("Alt 확인 중...", "busy", "");
    let result;
    try {
      result = await this.plugin.connectLocal();
    } catch (e) {
      result = { source: null, label: "연결 안 됨", detail: e instanceof Error ? e.message : String(e) };
    }
    if (gen !== this.loadGeneration) return;
    const kind = result.source ? result.source.mode : "none";
    this.setConnection(result.label, kind, result.detail);
    this.items = [];
    if (!result.source) {
      this.renderList("Alt 노트를 읽지 못했습니다. Alt를 실행한 뒤 상태 표시를 눌러 다시 확인하거나, URL 붙여넣기 탭을 쓰세요.");
      this.renderFooter();
      return;
    }
    try {
      const notes = await result.source.listNotes();
      if (gen !== this.loadGeneration) return;
      this.vaultNotes = this.plugin.vaultLectureNotes();
      this.items = notes.map((note) => ({ note, status: this.plugin.localNoteStatus(note, this.vaultNotes) }));
      if (this.expanded.size === 0 && this.items.length > 0) {
        // Open the folder of the most recent lecture, like the mockup.
        const recent = [...this.items].sort((a, b) => (b.note.lectureDate ?? "").localeCompare(a.note.lectureDate ?? ""))[0];
        this.expanded.add(this.groupKey(recent.note));
      }
    } catch (e) {
      this.renderList(`노트 목록을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.renderList();
    this.renderFooter();
    void this.loadDetails(gen);
  }

  private groupKey(note: AltNoteSummary): string {
    return note.folderPath.length > 0 ? note.folderPath.join(" / ") : "폴더 없음";
  }

  private renderList(emptyText?: string): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    if (emptyText) {
      list.createDiv({ cls: "alt2obsidian-empty", text: emptyText });
      return;
    }
    const q = (this.searchInput?.value ?? "").trim().toLowerCase();
    const shown = this.items.filter((it) => !q || it.note.title.toLowerCase().includes(q) || this.groupKey(it.note).toLowerCase().includes(q));
    if (shown.length === 0) {
      list.createDiv({ cls: "alt2obsidian-empty", text: this.items.length === 0 ? "Alt에 노트가 없습니다" : "검색 결과가 없습니다" });
      return;
    }
    const groups = new Map<string, LocalItem[]>();
    for (const it of shown) {
      const key = this.groupKey(it.note);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(it);
    }
    const keys = Array.from(groups.keys()).sort((a, b) => (a === "폴더 없음" ? 1 : b === "폴더 없음" ? -1 : a.localeCompare(b, "ko", { numeric: true })));
    for (const key of keys) {
      const open = !!q || this.expanded.has(key);
      const head = list.createDiv({ cls: "alt2obsidian-folder" });
      const caret = head.createSpan({ cls: "alt2obsidian-folder-caret" });
      setIcon(caret, open ? "chevron-down" : "chevron-right");
      head.createSpan({ text: key });
      head.createSpan({ cls: "alt2obsidian-folder-count", text: String(groups.get(key)!.length) });
      head.addEventListener("click", () => {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.renderList();
        void this.loadDetails(this.loadGeneration);
      });
      if (!open) continue;
      const notes = groups.get(key)!.sort((a, b) => (b.note.lectureDate ?? "").localeCompare(a.note.lectureDate ?? "") || a.note.title.localeCompare(b.note.title, "ko", { numeric: true }));
      for (const it of notes) this.renderItem(list, it);
    }
  }

  private renderItem(list: HTMLElement, it: LocalItem): void {
    const el = list.createDiv({ cls: "alt2obsidian-note-item" });
    el.toggleClass("is-selected", it.note.id === this.selectedId);
    it.el = el;
    this.fillItem(it);
    el.addEventListener("click", () => {
      this.selectedId = it.note.id;
      this.listEl?.querySelectorAll(".alt2obsidian-note-item").forEach((n) => n.removeClass("is-selected"));
      el.addClass("is-selected");
      this.renderFooter();
    });
  }

  private fillItem(it: LocalItem): void {
    const el = it.el;
    if (!el) return;
    el.empty();
    const top = el.createDiv({ cls: "alt2obsidian-note-row" });
    top.createSpan({ cls: "alt2obsidian-note-title", text: it.note.title });
    const chip = statusChip(it.status);
    top.createSpan({ cls: `alt2obsidian-chip ${chip.cls}`, text: chip.text });
    const meta: string[] = [formatLectureDate(it.note.lectureDate)];
    if (it.pageCount) meta.push(`슬라이드 ${it.pageCount}장`);
    else if (it.details && !it.details.hasSlides) meta.push("슬라이드 없음");
    if (it.details?.transcriptMinutes) meta.push(`전사 ${it.details.transcriptMinutes}분`);
    el.createDiv({ cls: "alt2obsidian-note-meta", text: meta.join(" · ") });
  }

  /**
   * Details (slides, transcript length, page count) and the slide comparison
   * of imported notes, one note at a time for the open folders.
   */
  private async loadDetails(gen: number): Promise<void> {
    const source = this.plugin.getLocalSource();
    if (!source) return;
    for (const it of this.items) {
      if (gen !== this.loadGeneration) return;
      if (!this.expanded.has(this.groupKey(it.note)) && !(this.searchInput?.value ?? "").trim() && it.note.id !== this.selectedId) continue;
      if (it.details) continue;
      try {
        it.details = await source.noteDetails(it.note.id);
        if (it.details.pdfPath) it.pageCount = await this.plugin.localPdfPageCount(it.details.pdfPath);
        if (it.status.kind === "new") it.status = this.plugin.localNoteStatus(it.note, this.vaultNotes, it.details.slidesTitle);
        if (it.status.kind === "imported" && it.details.pdfPath) {
          const changed = await this.plugin.slideChanges(it.status.path, it.details.pdfPath, it.note.id);
          if (it.status.kind === "imported") it.status = { ...it.status, changed };
        }
      } catch (e) {
        console.warn("[Alt2Obsidian] note details failed:", e);
        it.details = { hasSlides: false, slidesTitle: null, pdfPath: null, transcriptMinutes: null, timestamps: false };
      }
      if (gen !== this.loadGeneration) return;
      this.fillItem(it);
      if (it.note.id === this.selectedId) this.renderFooter();
    }
  }

  private selectedItem(): LocalItem | null {
    return this.items.find((it) => it.note.id === this.selectedId) ?? null;
  }

  /** Subject, alignment line, link offer and the import button for the selected note. */
  private renderFooter(): void {
    const footer = this.footerEl;
    if (!footer) return;
    footer.empty();
    const it = this.selectedItem();
    if (!it) {
      footer.hide();
      return;
    }
    footer.show();
    footer.createDiv({ cls: "alt2obsidian-footer-title", text: it.note.title });

    if (it.status.kind === "link") {
      const box = footer.createDiv({ cls: "alt2obsidian-link-offer" });
      box.createDiv({ text: "이미 가져온 노트와 같은 강의로 보입니다. 연결하면 다시 가져올 때 그 노트를 업데이트하고 메모를 보존합니다." });
      for (const c of it.status.candidates) {
        const row = box.createDiv({ cls: "alt2obsidian-link-row" });
        row.createSpan({ cls: "alt2obsidian-muted", text: c.path });
        const b = row.createEl("button", { text: "연결" });
        b.addEventListener("click", () => this.confirmLink(it, c));
      }
    }

    const subjectRow = footer.createDiv({ cls: "alt2obsidian-footer-row" });
    subjectRow.createEl("label", { text: "과목" });
    this.localSubjectInput = subjectRow.createEl("input", { type: "text" });
    const own = it.status.kind === "imported" ? this.vaultNotes.find((v) => v.path === (it.status as { path: string }).path) : undefined;
    this.localSubjectInput.value = own?.subject || inferSubject(it.note.folderPath, it.note.title);
    subjectRow.createSpan({ cls: "alt2obsidian-muted", text: own?.subject ? "기존 노트" : it.note.folderPath.length > 0 ? "Alt 폴더에서 추정" : "제목에서 추정" });

    const periodRow = footer.createDiv({ cls: "alt2obsidian-footer-row" });
    periodRow.createEl("label", { text: "시험" });
    this.localPeriodSelect = periodRow.createEl("select", { cls: "alt2obsidian-period-select" }) as HTMLSelectElement;
    for (const [value, text] of [["", "없음"], ["midterm", "중간고사"], ["final", "기말고사"]]) {
      const opt = this.localPeriodSelect.createEl("option", { text });
      opt.value = value;
    }

    const align = footer.createDiv({ cls: "alt2obsidian-align-line" });
    const d = it.details;
    if (!d) {
      align.setText("노트 정보를 읽는 중...");
      void this.loadDetails(this.loadGeneration);
    } else {
      const ok = d.timestamps && d.hasSlides;
      const icon = align.createSpan({ cls: ok ? "alt2obsidian-align-ok" : "alt2obsidian-align-off" });
      setIcon(icon, ok ? "check" : "minus");
      const hasTranscript = d.transcriptMinutes !== null;
      align.appendText(d.hasSlides ? alignmentStatus(d.timestamps, hasTranscript) : hasTranscript ? "슬라이드 없음 · 강의 요약 노트로 가져옴" : "슬라이드와 전사 없음");
    }

    const actions = footer.createDiv({ cls: "alt2obsidian-footer-actions" });
    if (it.status.kind === "imported") {
      const open = actions.createEl("button", { text: "노트 열기" });
      const path = it.status.path;
      open.addEventListener("click", () => this.app.workspace.openLinkText(path, "", false));
    }
    this.localImportBtn = actions.createEl("button", {
      text: it.status.kind === "imported" ? "다시 가져오기" : "가져오기",
      cls: "mod-cta alt2obsidian-footer-import",
    });
    this.localImportBtn.disabled = this.busy;
    this.localImportBtn.addEventListener("click", () => void this.handleLocalImport(it));
  }

  private confirmLink(it: LocalItem, candidate: VaultNoteInfo): void {
    new ConfirmModal(
      this.app,
      "기존 노트와 연결",
      `"${candidate.path}" 노트를 Alt 노트 "${it.note.title}"와 연결합니다. 노트 내용은 바뀌지 않고, frontmatter에 alt_local_id만 추가됩니다. 다음에 가져오면 이 노트를 업데이트합니다.`,
      "연결",
      async () => {
        try {
          await this.plugin.linkLocalNote(candidate.path, it.note.id);
          // metadataCache updates asynchronously: record the link locally too.
          const v = this.vaultNotes.find((n) => n.path === candidate.path);
          if (v) v.altLocalId = it.note.id;
          it.status = { kind: "imported", path: candidate.path, changed: null };
          it.details = undefined;
          this.fillItem(it);
          this.renderFooter();
          this.showSuccess("노트를 연결했습니다.");
        } catch (e) {
          this.showError(e instanceof Error ? e.message : String(e));
        }
      }
    ).open();
  }

  private async handleLocalImport(it: LocalItem): Promise<void> {
    const settings = this.plugin.data.settings;
    if (settings.tasks.commentary.provider === "gemini" && !settings.apiKey) {
      this.showError("API 키를 설정에서 입력해주세요");
      return;
    }
    const subject = this.localSubjectInput?.value.trim() || inferSubject(it.note.folderPath, it.note.title);
    const period = ((this.localPeriodSelect?.value as ExamPeriod | "") || undefined) as ExamPeriod | undefined;
    this.setLoading(true);
    this.clearMessage();
    try {
      this.updateProgress(5, "Alt에서 노트 읽는 중...");
      const preview = await this.plugin.previewLocal(it.note.id);
      for (const w of preview.bundle?.warnings ?? []) this.showNotice(w);
      if (this.plugin.isCliCommentary()) {
        await this.executeCliImport("", preview, subject, period);
      } else {
        await this.executeImport("", preview, subject, period);
      }
    } catch (e) {
      this.showError(e instanceof Error ? e.message : "알 수 없는 오류");
    } finally {
      this.setLoading(false);
    }
  }

  /** After an import: statuses of the list change (new -> imported). */
  private refreshStatuses(): void {
    this.vaultNotes = this.plugin.vaultLectureNotes();
    for (const it of this.items) {
      const next = this.plugin.localNoteStatus(it.note, this.vaultNotes, it.details?.slidesTitle);
      if (next.kind === "imported" && it.details?.pdfPath) it.details = undefined;
      it.status = next;
    }
    this.renderList();
    this.renderFooter();
    void this.loadDetails(this.loadGeneration);
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

    const settings = this.plugin.data.settings;
    if (settings.tasks.commentary.provider === "gemini" && !settings.apiKey) {
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

      const subject = this.subjectInput?.value?.trim() || undefined;
      const period = ((this.examPeriodSelect?.value as ExamPeriod | "") || undefined) as ExamPeriod | undefined;
      if (this.plugin.isCliCommentary()) {
        await this.executeCliImport(url, preview, subject, period);
      } else {
        await this.executeImport(url, preview, subject, period);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "알 수 없는 오류";
      this.showError(msg);
    } finally {
      this.setLoading(false);
    }
  }

  // ---- CLI path: estimate, confirm, run with live progress ----

  private async executeCliImport(url: string, preview: ImportPreview, subject: string | undefined, period: ExamPeriod | undefined): Promise<void> {
    let prepared = await this.plugin.prepareCliImport(url, preview, subject, period, (stage, pct) => this.updateProgress(pct, stage));
    this.hideProgress();

    for (;;) {
      const choice = await this.showEstimate(prepared);
      if (choice === "cancel") {
        this.hideCliPanel();
        this.showSuccess("가져오기를 취소했습니다. 토큰은 쓰지 않았습니다.");
        return;
      }
      if (choice === "fewer-images") {
        prepared = this.plugin.reduceImages(prepared);
        continue;
      }
      break;
    }

    const controller = new AbortController();
    this.runController = controller;
    const view = this.showRunPanel(prepared, () => controller.abort());
    try {
      const result = await this.plugin.runCliImport(prepared, {
        signal: controller.signal,
        onStep: (step) => view.step(step),
        onBatch: (p) => view.batch(p.batch, p.batches, p.retry),
        onUsage: (u) => view.usage(u),
        onProgress: (stage) => view.detail(stage),
        onConfirmUpdate: (summary) => this.confirmUpdate(summary),
      });
      this.hideCliPanel();
      await this.afterImport(result);
    } catch (e) {
      this.hideCliPanel();
      if (controller.signal.aborted) {
        this.showError("가져오기를 취소했습니다. 노트는 바뀌지 않았습니다.");
        return;
      }
      throw e;
    } finally {
      this.runController = null;
    }
  }

  private hideCliPanel(): void {
    this.cliPanel?.empty();
    this.cliPanel?.hide();
  }

  /** Pre-run estimate (spec 5.5). Resolves with the user's choice. */
  private showEstimate(prepared: PreparedImport): Promise<"start" | "fewer-images" | "cancel"> {
    const panel = this.cliPanel!;
    panel.empty();
    panel.show();
    const e = prepared.estimate;
    const tasks = this.plugin.data.settings.tasks;
    const model = tasks.commentary.model || "기본 모델";
    panel.createEl("h6", { text: "가져오기 전 예상 사용량", cls: "alt2obsidian-section-header" });
    panel.createDiv({
      cls: "alt2obsidian-estimate-main",
      text: `호출 ${e.calls}회 · 입력 약 ${compactTokens(e.inputTokens)} · 출력 약 ${compactTokens(e.outputTokens)} 토큰 · 이미지 ${e.imagesSent}장`,
    });
    const rows = panel.createEl("ul", { cls: "alt2obsidian-estimate-list" });
    rows.createEl("li", { text: `해설: ${PROVIDER_LABELS[tasks.commentary.provider]} (${model}${tasks.commentary.effort ? ", " + tasks.commentary.effort : ""})` });
    if (prepared.plan) {
      const skipped = e.slidesTemplated + e.slidesDeduped + e.slidesReused;
      rows.createEl("li", {
        text: `슬라이드 ${e.slidesTotal}장 중 ${e.slidesGenerated}장 생성, ${skipped}장 생략 (표지·목차·마무리 ${e.slidesTemplated}, 중복 ${e.slidesDeduped}, 변경 없음 ${e.slidesReused})`,
      });
      const t = prepared.plan.transcriptChars;
      if (t.before > 0) rows.createEl("li", { text: `전사 ${t.before.toLocaleString()}자를 ${t.after.toLocaleString()}자로 압축` });
      if (prepared.alignment) {
        const low = prepared.alignment.lowSpans.length;
        const check = tasks.alignment.provider !== "none" && low > 0 ? `, 불확실한 ${low}개는 ${PROVIDER_LABELS[tasks.alignment.provider]}로 확인` : low > 0 ? `, 불확실 ${low}개` : "";
        rows.createEl("li", { text: `전사 정렬: 슬라이드별 구간 ${prepared.alignment.result.spans.length}개${check}` });
      } else if (prepared.preview.altData.transcript) {
        rows.createEl("li", { text: "전사 타임스탬프가 없어 슬라이드마다 균등 분할합니다." });
      }
      if (prepared.plan.scanned) rows.createEl("li", { text: "텍스트 레이어가 없는 PDF라 모든 슬라이드를 이미지로 보냅니다." });
      if (prepared.fewerImages) rows.createEl("li", { text: "이미지 줄이기 적용됨: 텍스트가 있는 도표 슬라이드는 텍스트만 보냅니다." });
    } else {
      rows.createEl("li", { text: "PDF가 없어 슬라이드별 해설 없이 강의 요약 노트를 만듭니다." });
    }
    rows.createEl("li", { cls: "alt2obsidian-muted", text: "추정치입니다. 모델의 추론 토큰과 재시도는 포함하지 않습니다." });

    return new Promise((resolve) => {
      const cap = this.plugin.data.settings.generation.tokenCapPerLecture;
      if (prepared.overCap) {
        panel.createDiv({
          cls: "alt2obsidian-error",
          text: `강의당 토큰 상한(${compactTokens(cap)})을 넘을 것 같아 시작하지 않았습니다. 이미지를 줄이거나 설정에서 상한을 올리세요.`,
        });
      }
      const actions = panel.createDiv({ cls: "alt2obsidian-estimate-actions" });
      const start = actions.createEl("button", { text: prepared.overCap ? "상한 무시하고 시작" : "시작", cls: prepared.overCap ? "" : "mod-cta" });
      let armed = false;
      start.addEventListener("click", () => {
        // Over the cap: a second, explicit click is required (review L1).
        if (prepared.overCap && !armed) {
          armed = true;
          start.textContent = `상한 ${compactTokens(cap)}을 넘겨도 시작하려면 한 번 더 누르세요`;
          start.addClass("mod-warning");
          return;
        }
        resolve("start");
      });
      if (prepared.plan && e.imagesSent > 0 && !prepared.fewerImages) {
        const fewer = actions.createEl("button", { text: "이미지 줄이기", cls: prepared.overCap ? "mod-cta" : "" });
        fewer.addEventListener("click", () => resolve("fewer-images"));
      }
      const cancel = actions.createEl("button", { text: "취소" });
      cancel.addEventListener("click", () => resolve("cancel"));
    });
  }

  /** Steps, batch progress, live usage and a cancel button while the CLI runs. */
  private showRunPanel(prepared: PreparedImport, onCancel: () => void) {
    const panel = this.cliPanel!;
    panel.empty();
    panel.show();
    panel.createEl("h6", { text: `가져오는 중: ${prepared.preview.altData.title}`, cls: "alt2obsidian-section-header" });
    const steps = panel.createEl("ol", { cls: "alt2obsidian-steps" });
    const stepDefs: Array<[string, string]> = [
      ["prep", "준비 (분석·예산)"],
      ["commentary", "슬라이드 해설"],
      ["overview", "전체 요약"],
      ["concepts", "개념 추출"],
      ["save", "저장"],
    ];
    const items = new Map<string, HTMLElement>();
    for (const [id, label] of stepDefs) items.set(id, steps.createEl("li", { text: label }));
    items.get("prep")!.addClass("is-done");

    const barOuter = panel.createDiv({ cls: "alt2obsidian-progress-bar" });
    const bar = barOuter.createDiv({ cls: "alt2obsidian-progress-bar-fill" });
    const detail = panel.createDiv({ cls: "alt2obsidian-progress-text" });
    const usage = panel.createDiv({ cls: "alt2obsidian-usage-line", text: "사용량: 아직 호출 없음" });
    const cancel = panel.createEl("button", { text: "취소", cls: "alt2obsidian-cancel-btn" });
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      cancel.textContent = "취소하는 중...";
      onCancel();
    });

    let current = "prep";
    return {
      step: (id: string) => {
        // Writing has started: cancelling now could leave a half-written import (review L6).
        if (id === "save") {
          cancel.disabled = true;
          cancel.textContent = "저장 중에는 취소할 수 없습니다";
        }
        items.get(current)?.removeClass("is-active");
        items.get(current)?.addClass("is-done");
        current = id;
        items.get(id)?.addClass("is-active");
        if (id !== "commentary") bar.style.width = id === "save" ? "100%" : bar.style.width;
      },
      batch: (n: number, total: number, retry: boolean) => {
        bar.style.width = `${Math.round(((retry ? n : n - 1) / Math.max(1, total)) * 100)}%`;
        detail.textContent = retry ? `배치 ${n}/${total}: 실패한 슬라이드만 다시 요청 중` : `배치 ${n}/${total} 생성 중`;
      },
      usage: (u: LLMUsage) => {
        usage.textContent =
          `호출 ${u.calls}회 · 입력 ${compactTokens(u.inputTokens)} (캐시 ${compactTokens(u.cachedInputTokens)}) · ` +
          `출력 ${compactTokens(u.outputTokens)} · 이미지 ${u.imagesSent}장`;
      },
      detail: (text: string) => {
        detail.textContent = text;
      },
    };
  }

  private async executeImport(url: string, preview: ImportPreview, subject: string | undefined, examPeriod: ExamPeriod | undefined): Promise<void> {
    this.updateProgress(0, "LLM 처리 시작...");

    const result = await this.plugin.importNote(
      url,
      preview,
      subject,
      examPeriod,
      (stage, pct) => {
        this.updateProgress(pct, stage);
      },
      (summary) => this.confirmUpdate(summary)
    );

    this.hideProgress();
    await this.afterImport(result);
  }

  private async afterImport(result: import("../types").ImportRecord): Promise<void> {
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
    this.refreshStatuses();

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
    const settings = this.plugin.data.settings;
    if (settings.tasks.commentary.provider === "gemini" && !settings.apiKey) {
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
    this.busy = loading;
    if (this.localImportBtn) this.localImportBtn.disabled = loading;
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

  private showNotice(msg: string): void {
    this.messageContainer?.createDiv({ text: msg, cls: "alt2obsidian-muted" });
  }

  private confirmUpdate(summary: ImportUpdateSummary): Promise<boolean> {
    this.hideProgress();
    return new Promise((resolve) => {
      new UpdatePreviewModal(this.app, summary, resolve).open();
    });
  }

  async onClose(): Promise<void> {
    // Closing the view stops a running CLI import; its temp folder is removed.
    this.runController?.abort();
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: import("obsidian").App,
    private heading: string,
    private body: string,
    private confirmText: string,
    private onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.heading });
    contentEl.createEl("p", { text: this.body });
    const actions = contentEl.createDiv({ cls: "alt2obsidian-update-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: this.confirmText, cls: "mod-cta" });
    ok.addEventListener("click", () => {
      this.close();
      void this.onConfirm();
    });
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
    this.renderSlideChanges();
    for (const note of this.summary.notes ?? []) {
      contentEl.createEl("p", { text: note });
    }

    const actions = contentEl.createDiv({ cls: "alt2obsidian-update-actions" });
    const cancelBtn = actions.createEl("button", { text: "취소" });
    cancelBtn.addEventListener("click", () => this.finish(false));

    const confirmBtn = actions.createEl("button", {
      text: "업데이트",
      cls: "mod-cta",
    });
    confirmBtn.addEventListener("click", () => this.finish(true));

    // Most existing slides would become orphans: likely a different lecture
    // is being imported onto this note. Require an explicit opt-in.
    if (this.summary.confirmDeckReplacement) {
      confirmBtn.disabled = true;
      const warning = contentEl.createDiv({ cls: "alt2obsidian-update-section" });
      warning.createEl("p", {
        text: "기존 슬라이드의 절반 이상이 새 슬라이드와 맞지 않습니다. 다른 강의를 이 노트에 덮어쓰려는 것일 수 있습니다. 맞지 않는 슬라이드의 메모는 노트 끝 '삭제된 슬라이드' 구간으로 옮겨집니다.",
      });
      const label = warning.createEl("label");
      const checkbox = label.createEl("input", { type: "checkbox" });
      label.appendText(" 이 노트를 새 슬라이드 구성으로 교체하는 것이 맞습니다");
      checkbox.addEventListener("change", () => {
        confirmBtn.disabled = !checkbox.checked;
      });
      contentEl.appendChild(actions);
    }
  }

  private renderSlideChanges(): void {
    const { slideDrifts, slideReorders, slideInsertions, slideDeletions } = this.summary;
    if (!slideDrifts && !slideReorders && !slideInsertions && !slideDeletions) return;
    const fmt = (nums: number[]) =>
      nums.length > 0 ? ` (슬라이드 ${nums.slice(0, 12).join(", ")}${nums.length > 12 ? " ..." : ""})` : "";
    const drifts = slideDrifts ?? [];
    const reorders = slideReorders ?? [];
    const insertions = slideInsertions ?? [];
    const deletions = slideDeletions ?? [];
    this.renderList("슬라이드 변경", [
      `내용 변경(drift): ${drifts.length}개${fmt(drifts.map((d) => d.slideNum))}`,
      `순서 이동: ${reorders.length}개${fmt(reorders.map((r) => r.to))}`,
      `새 슬라이드: ${insertions.length}개${fmt(insertions)}`,
      `삭제된 슬라이드(orphan): ${deletions.length}개${fmt(deletions.map((d) => d.slideNum))}`,
    ]);
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
