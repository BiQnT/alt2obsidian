import { ItemView, WorkspaceLeaf, TFile, Modal, setIcon } from "obsidian";
import type Alt2ObsidianPlugin from "../main";
import type { PreparedImport } from "../main";
import { ImportPreview, ImportUpdateSummary, LLMUsage, TaskId } from "../types";
import { compactTokens } from "../llm/usage";
import { describeEffort, describeModel, PROVIDER_LABELS } from "../settings/llmSettings";
import { renderModelPicker } from "./modelPicker";
import { AltNoteDetails, AltNoteSummary, inferSubject } from "../sources";
import { AltApiError } from "../sources/AltLocalApiSource";
import { LECTURE_KIND_LABELS, LectureKind, LocalNoteStatus, MissingPdfError, statusChip, VaultNoteInfo } from "../core/noteStatus";
import { attachedPdfPath } from "../core/pdfAttach";
import { SECTION_CAP_CHARS } from "../core/prep/TranscriptSections";
import { alignmentStatus } from "../pipeline/alignment";
import { VerifyPanel } from "./VerifyPanel";
import { pickPdf } from "./attachPdf";

type Tab = "local" | "url" | "verify";

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
  private verifyPane: HTMLElement | null = null;
  private verifyPanel: VerifyPanel | null = null;
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private searchInput: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;
  private items: LocalItem[] = [];
  private vaultNotes: VaultNoteInfo[] = [];
  private expanded = new Set<string>();
  private selectedId: string | null = null;
  private localSubjectInput: HTMLInputElement | null = null;
  /** Footer buttons that start work, disabled while an import runs. */
  private actionButtons: HTMLButtonElement[] = [];
  /** Subject typed for a note, kept while its panel re-renders. */
  private drafts = new Map<string, { subject?: string }>();
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
    this.verifyPane = container.createDiv({ cls: "alt2obsidian-verify-pane" });
    this.verifyPanel = new VerifyPanel(this.app, this.plugin, this.verifyPane);
    this.verifyPanel.render();
    this.renderProgressSection(container);
    this.cliPanel = container.createDiv({ cls: "alt2obsidian-cli-panel" });
    this.cliPanel.hide();
    this.renderMessageSection(container);
    this.renderRecentSection(container);
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
    for (const [id, label] of [["local", "Alt 노트 목록"], ["url", "URL 붙여넣기"], ["verify", "노트 검증"]] as Array<[Tab, string]>) {
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
    this.verifyPane?.toggle(tab === "verify");
    // Lists of notes and lectures may have changed since the tab was built.
    if (tab === "verify") this.verifyPanel?.refreshLists();
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
    void this.loadDetails();
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
        void this.loadDetails();
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
    if (it.details?.transcriptMinutes) meta.push(`전사 ${it.details.transcriptMinutes}분`);
    const line = el.createDiv({ cls: "alt2obsidian-note-meta" });
    // The lecture kind (spec 4.10): why a lecture has slide commentary or not.
    const kind = this.kindOf(it);
    const label = kind ? LECTURE_KIND_LABELS[kind] : it.note.type === "note" ? "노트" : null;
    if (label) {
      const chip = line.createSpan({ cls: `alt2obsidian-kind is-${kind ?? "note"}`, text: label });
      chip.setAttr("title", `Alt 노트 종류: ${it.note.type || "알 수 없음"}`);
      line.appendText(" ");
    }
    line.appendText(meta.join(" · "));
  }

  /** The vault note an import of this lecture writes (or the one it already has). */
  private notePathOf(it: LocalItem): string {
    if (it.status.kind === "imported") return it.status.path;
    return this.plugin.notePathForLocal(it.note, this.subjectFor(it));
  }

  /** Subject for an import of this lecture: the typed one, the existing note's, else the guess. */
  private subjectFor(it: LocalItem): string {
    const draft = this.drafts.get(it.note.id)?.subject?.trim();
    if (draft) return draft;
    const own = it.status.kind === "imported" ? this.vaultNotes.find((v) => v.path === (it.status as { path: string }).path) : undefined;
    return own?.subject || inferSubject(it.note.folderPath, it.note.title);
  }

  /** Lecture kind once the details are known (spec 4.10). */
  private kindOf(it: LocalItem): LectureKind | null {
    const d = it.details;
    if (!d) return null;
    return this.plugin.lectureKindFor({
      altType: it.note.type || null,
      hasSlides: d.hasSlides,
      hasTranscript: d.transcriptMinutes !== null,
      notePath: this.notePathOf(it),
    });
  }

  private detailsLoop: Promise<void> | null = null;
  private detailsAgain = false;

  /**
   * Details (slides, transcript length, page count) and the slide comparison
   * of imported notes, one note at a time for the open folders. One loop at
   * a time: a request while it runs makes it scan again when done.
   */
  private loadDetails(): Promise<void> {
    if (this.detailsLoop) {
      this.detailsAgain = true;
      return this.detailsLoop;
    }
    this.detailsLoop = (async () => {
      do {
        this.detailsAgain = false;
        await this.loadDetailsOnce(this.loadGeneration);
      } while (this.detailsAgain);
    })().finally(() => {
      this.detailsLoop = null;
    });
    return this.detailsLoop;
  }

  private async loadDetailsOnce(gen: number): Promise<void> {
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
        // The source failed mid-scan (connection lost, owner changed): stop
        // and reconnect instead of marking the remaining notes empty.
        if (e instanceof AltApiError && e.status === null) {
          if (gen === this.loadGeneration) void this.refreshLocal();
          return;
        }
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
    const title = footer.createDiv({ cls: "alt2obsidian-footer-title", text: it.note.title });
    // The lecture kind here too (spec 4.10): why the buttons below differ.
    const kindNow = this.kindOf(it);
    if (kindNow) {
      title.appendText(" ");
      title.createSpan({ cls: `alt2obsidian-kind is-${kindNow}`, text: LECTURE_KIND_LABELS[kindNow] }).setAttr("title", `Alt 노트 종류: ${it.note.type || "알 수 없음"}`);
    }

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
    const draft = this.drafts.get(it.note.id) ?? {};
    this.localSubjectInput.value = draft.subject ?? (own?.subject || inferSubject(it.note.folderPath, it.note.title));
    this.localSubjectInput.addEventListener("input", () => {
      this.drafts.set(it.note.id, { ...this.drafts.get(it.note.id), subject: this.localSubjectInput?.value ?? "" });
    });
    subjectRow.createSpan({ cls: "alt2obsidian-muted", text: own?.subject ? "기존 노트" : it.note.folderPath.length > 0 ? "Alt 폴더에서 추정" : "제목에서 추정" });

    const align = footer.createDiv({ cls: "alt2obsidian-align-line" });
    const d = it.details;
    const kind = this.kindOf(it);
    const hasTranscript = !!d && d.transcriptMinutes !== null;
    // A slides component whose file is not on this computer (a synced file not
    // downloaded yet) and no copy next to the note that an import could use.
    const fileMissing = kind === "slides" && !!d && !d.pdfPath && !this.plugin.siblingPdf(this.notePathOf(it));
    const line = (ok: boolean, text: string) => {
      const icon = align.createSpan({ cls: ok ? "alt2obsidian-align-ok" : "alt2obsidian-align-off" });
      setIcon(icon, ok ? "check" : "minus");
      align.appendText(text);
    };
    if (!d) {
      align.setText("노트 정보를 읽는 중...");
      void this.loadDetails();
    } else if (fileMissing) {
      line(false, "슬라이드 PDF 파일이 이 컴퓨터에 없습니다. Alt에서 슬라이드를 한 번 열어 내려받은 뒤 새로고침하세요.");
    } else if (kind === "slides") {
      line(d.timestamps, alignmentStatus(d.timestamps, hasTranscript));
    } else if (kind === "attached") {
      line(d.timestamps, `첨부한 PDF 사용 · ${alignmentStatus(d.timestamps, hasTranscript)}`);
      if (d.hasSlides && d.pdfPath) align.createDiv({ cls: "alt2obsidian-muted", text: "Alt에도 슬라이드가 있습니다. 지금은 첨부한 PDF를 씁니다." });
    } else if (kind === "vault-copy") {
      line(d.timestamps, `Alt에 지금 슬라이드가 없어 노트 옆에 저장된 PDF로 가져옵니다 · ${alignmentStatus(d.timestamps, hasTranscript)}`);
    } else if (kind === "slides-missing") {
      line(false, "슬라이드 강의인데 Alt에 아직 슬라이드가 없습니다. Alt에서 슬라이드를 첨부한 뒤 새로고침하세요. 지금 만들려면 PDF를 첨부하거나 전사로 요약 노트를 만드세요.");
    } else if (kind === "transcript") {
      line(false, `슬라이드 없는 강의 (전사 ${d.transcriptMinutes}분) · 전사 구간별 요약 노트를 만들거나 강의 PDF를 첨부하세요`);
    } else {
      line(false, "슬라이드와 전사 없음 · Alt 요약과 메모로 강의 노트를 만듭니다");
    }

    const actions = footer.createDiv({ cls: "alt2obsidian-footer-actions" });
    this.actionButtons = [];
    const button = (text: string, onClick: () => void, opts: { cta?: boolean; work?: boolean; title?: string } = {}) => {
      const b = actions.createEl("button", { text, cls: opts.cta ? "mod-cta alt2obsidian-footer-import" : "", attr: opts.title ? { title: opts.title } : {} });
      b.addEventListener("click", onClick);
      if (opts.work) {
        b.disabled = this.busy;
        this.actionButtons.push(b);
      }
      return b;
    };
    if (it.status.kind === "imported") {
      const path = it.status.path;
      const pdf = this.plugin.siblingPdf(path);
      const transcriptNote = this.vaultNotes.find((v) => v.path === path)?.kind === "transcript";
      if (pdf && !transcriptNote) {
        button("뷰어로 열기", () => void this.plugin.openSyncedViewer(path, pdf.path), { title: "PDF와 노트를 나란히, 스크롤을 맞춰 엽니다 (Synced Viewer)" });
      } else {
        // No slides: the viewer cannot open; say why and offer "PDF 첨부" (spec 4.10).
        button("뷰어로 열기", () => void this.plugin.explainNoViewer(path).then(() => this.refreshStatuses()), { title: "슬라이드가 없는 강의는 Synced Viewer가 없습니다" });
      }
      button("노트 열기", () => void this.app.workspace.openLinkText(path, "", false));
    }
    const imported = it.status.kind === "imported";
    // An imported slide note is never replaced by a note without slides.
    const slideNote = imported && !!this.vaultNotes.find((v) => v.path === (it.status as { path: string }).path)?.slideNote;
    if (!kind) {
      button(imported ? "다시 가져오기" : "가져오기", () => void this.handleLocalImport(it), { cta: true, work: true });
    } else if (fileMissing || kind === "slides-missing") {
      button("새로고침", () => void this.refreshLocal(), { cta: true, title: "Alt에서 슬라이드를 첨부했으면 노트를 다시 읽습니다" });
      button("PDF 첨부", () => void this.attachForLocal(it), { work: true });
      if (!slideNote) button(hasTranscript ? "요약 노트 만들기" : "강의 노트 만들기", () => void this.handleLocalImport(it, { withoutPdf: "summary" }), { work: true });
    } else if (kind === "slides" || kind === "attached" || kind === "vault-copy") {
      button(imported ? "다시 가져오기" : "가져오기", () => void this.handleLocalImport(it), { cta: true, work: true });
      if (kind === "attached") {
        const notePath = this.notePathOf(it);
        if (d?.hasSlides && d.pdfPath) {
          button("Alt 슬라이드로 바꾸기", () => void this.switchToAlt(it, notePath), { work: true, title: "다음 가져오기부터 첨부한 PDF 대신 Alt의 슬라이드를 씁니다" });
        }
        button("첨부 해제", () => void this.confirmDetach(it, notePath), { work: true, title: "첨부한 PDF 사본을 휴지통으로 옮기고 표시를 지웁니다 (보관함의 원래 파일은 그대로)" });
      }
    } else if (kind === "transcript") {
      button("PDF 첨부", () => void this.attachForLocal(it), { work: true, title: "강의 PDF를 골라 슬라이드 강의로 가져옵니다" });
      if (!slideNote) button(imported ? "요약 노트 다시 만들기" : "요약 노트 만들기", () => void this.handleLocalImport(it, { withoutPdf: "summary" }), { cta: true, work: true });
    } else {
      button(imported ? "다시 가져오기" : "강의 노트 만들기", () => void this.handleLocalImport(it, { withoutPdf: "summary" }), { cta: true, work: true });
    }
  }

  /** What happens to the attached PDF, for the confirmation text (only a plugin-made copy goes to the trash). */
  private attachedFate(notePath: string, rename: boolean, isCopy: boolean): string {
    const pdf = this.plugin.siblingPdf(notePath);
    const path = pdf?.path ?? attachedPdfPath(notePath);
    if (!pdf) return "";
    if (!isCopy) {
      return rename
        ? `${path}는 플러그인이 만든 사본이 아니거나 그 뒤 바뀐 파일이라 지우지 않고, Alt PDF가 그 자리에 저장되지 않도록 "${path.replace(/\.pdf$/i, "")} (첨부한 PDF).pdf"로 이름을 바꿔 둡니다.`
        : `${path}는 플러그인이 만든 사본이 아니거나 그 뒤 바뀐 파일이라 지우지 않고 그대로 둡니다.`;
    }
    return `첨부할 때 플러그인이 만든 사본(${path})은 시스템 휴지통으로 옮깁니다(안 되면 보관함의 .trash 폴더). 영구 삭제하지 않으며 원본 파일은 그대로입니다.`;
  }

  /** Message after the attached PDF left. */
  private releasedText(r: { pdfPath: string | null; trashed: boolean; keptAt: string | null }): string {
    if (!r.pdfPath) return "";
    if (r.trashed) return ` 첨부한 사본(${r.pdfPath})은 휴지통으로 옮겼습니다.`;
    return r.keptAt && r.keptAt !== r.pdfPath ? ` 원래 파일은 ${r.keptAt}로 이름을 바꿔 두었습니다.` : ` 원래 파일(${r.pdfPath})은 그대로 두었습니다.`;
  }

  /** "Alt 슬라이드로 바꾸기" after a confirmation: the attached PDF leaves, the mark goes; the next import uses Alt's PDF. */
  private async switchToAlt(it: LocalItem, notePath: string): Promise<void> {
    const isCopy = await this.plugin.attachedPdfIsCopy(notePath);
    new ConfirmModal(
      this.app,
      "Alt 슬라이드로 바꾸기",
      `다음 가져오기부터 첨부한 PDF 대신 Alt의 슬라이드를 쓰고, Alt PDF를 노트 옆에 저장합니다. ${this.attachedFate(notePath, true, isCopy)} 노트에서는 alt_pdf_source 줄만 지웁니다.`,
      "바꾸기",
      async () => {
        try {
          const r = await this.plugin.useAltSlides(notePath);
          this.showSuccess(`다음 가져오기부터 Alt의 슬라이드를 씁니다. 다시 가져오기를 누르세요.${this.releasedText(r)}`);
          this.refreshStatuses();
        } catch (e) {
          this.showError(e instanceof Error ? e.message : String(e));
        }
      }
    ).open();
  }

  /** "첨부 해제" after a confirmation: the attached PDF leaves, the mark goes. */
  private async confirmDetach(it: LocalItem, notePath: string): Promise<void> {
    const isCopy = await this.plugin.attachedPdfIsCopy(notePath);
    new ConfirmModal(
      this.app,
      "첨부 해제",
      `${this.attachedFate(notePath, false, isCopy)} 노트에서는 alt_pdf_source 줄만 지우고 내용은 바꾸지 않습니다. 이미 슬라이드 노트로 가져왔다면 다음 가져오기에는 PDF를 다시 첨부해야 합니다.`,
      "첨부 해제",
      async () => {
        try {
          const r = await this.plugin.detachPdf(notePath);
          this.showSuccess(`첨부를 해제했습니다.${this.releasedText(r)}`);
          this.refreshStatuses();
        } catch (e) {
          this.showError(e instanceof Error ? e.message : String(e));
        }
      }
    ).open();
  }

  /**
   * "PDF 첨부" for a lecture without slides: pick a PDF (vault or disk), copy
   * it next to the lecture note, then go on to the import estimate (nothing
   * is spent before "시작").
   */
  private async attachForLocal(it: LocalItem): Promise<void> {
    const ok = await this.attachTo(this.notePathOf(it), it.note.title);
    if (!ok) return;
    this.refreshStatuses();
    await this.handleLocalImport(it);
  }

  /** Picks and copies a PDF next to `notePath`; false when cancelled or it failed (the error is shown). */
  private async attachTo(notePath: string, title: string): Promise<boolean> {
    const existing = this.plugin.siblingPdf(notePath);
    const picked = await pickPdf(this.app, { title, target: existing?.path ?? attachedPdfPath(notePath), replacing: !!existing });
    if (!picked) return false;
    try {
      const res = await this.plugin.attachPdf(notePath, picked);
      this.showSuccess(`PDF를 첨부했습니다: ${res.pdfPath}`);
      return true;
    } catch (e) {
      this.showError(e instanceof Error ? e.message : String(e));
      return false;
    }
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

  private async handleLocalImport(it: LocalItem, opts: { withoutPdf?: "summary" } = {}): Promise<void> {
    const subject = this.subjectFor(it);
    this.setLoading(true);
    this.clearMessage();
    try {
      this.updateProgress(5, "Alt에서 노트 읽는 중...");
      const preview = await this.plugin.previewLocal(it.note.id);
      for (const w of preview.bundle?.warnings ?? []) this.showNotice(w);
      await this.executeCliImport("", preview, subject, opts);
      this.drafts.delete(it.note.id);
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
    void this.loadDetails();
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

  private async handleImport(): Promise<void> {
    const url = this.urlInput?.value?.trim();
    if (!url) {
      this.showError("URL을 입력해주세요");
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
      await this.executeCliImport(url, preview, subject);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "알 수 없는 오류";
      this.showError(msg);
    } finally {
      this.setLoading(false);
    }
  }

  // ---- CLI path: estimate, confirm, run with live progress ----

  private async executeCliImport(url: string, preview: ImportPreview, subject: string | undefined, opts: { withoutPdf?: "summary" } = {}): Promise<void> {
    let prepared: PreparedImport;
    try {
      prepared = await this.plugin.prepareCliImport(url, preview, subject, (stage, pct) => this.updateProgress(pct, stage), opts);
    } catch (e) {
      if (!(e instanceof MissingPdfError)) throw e;
      // No slides PDF: the user chooses (spec 4.10); nothing falls back silently.
      this.hideProgress();
      const choice = await this.showNoPdfChoice(preview.altData.title, e);
      if (choice === "retry") {
        this.hideCliPanel();
        this.updateProgress(5, "PDF를 다시 내려받는 중...");
        return this.executeCliImport(url, preview, subject, opts);
      }
      if (choice === "cancel") {
        this.hideCliPanel();
        this.showSuccess("가져오기를 취소했습니다. 토큰은 쓰지 않았습니다.");
        return;
      }
      if (choice === "attach") {
        this.hideCliPanel();
        if (!(await this.attachTo(e.notePath, preview.altData.title))) return;
        this.refreshStatuses();
        return this.executeCliImport(url, preview, subject, opts);
      }
      return this.executeCliImport(url, preview, subject, { withoutPdf: "summary" });
    }
    this.hideProgress();

    for (;;) {
      const shown = await this.showEstimate(prepared);
      const choice = shown.choice;
      prepared = shown.prepared;
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
        onModel: (task, model) => view.model(task, model),
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

  /**
   * A lecture without a slides PDF: "요약 노트 만들기", "PDF 첨부" or cancel;
   * when the PDF download failed, "다시 시도" comes first.
   */
  private showNoPdfChoice(title: string, e: MissingPdfError): Promise<"summary" | "attach" | "retry" | "cancel"> {
    const panel = this.cliPanel!;
    panel.empty();
    panel.show();
    return new Promise((resolve) => {
      panel.createEl("h6", { text: `${e.downloadError ? "슬라이드 PDF를 내려받지 못함" : "슬라이드 PDF 없음"}: ${title}`, cls: "alt2obsidian-section-header" });
      panel.createDiv({ cls: "alt2obsidian-muted", text: e.message });
      const rows = panel.createEl("ul", { cls: "alt2obsidian-estimate-list" });
      if (e.downloadError) rows.createEl("li", { text: "다시 시도: 네트워크나 공유 설정 문제였다면 다시 내려받아 슬라이드 강의로 가져옵니다." });
      rows.createEl("li", {
        text: e.hasTranscript
          ? "요약 노트: 전사를 약 12분 구간으로 나눠 구간별 요약(시각 표시), 전체 요약, 개념을 만듭니다. 예상 사용량은 다음 화면에서 봅니다."
          : "강의 노트: 전사가 없어 Alt 요약과 메모로 강의 노트를 만듭니다.",
      });
      rows.createEl("li", { text: `PDF 첨부: 보관함이나 컴퓨터의 PDF를 ${e.notePath.replace(/\.md$/, ".pdf")}로 복사하고 슬라이드 강의로 가져옵니다 (슬라이드별 해설, 전사 정렬, Synced Viewer).` });
      const actions = panel.createDiv({ cls: "alt2obsidian-estimate-actions" });
      const summaryText = e.hasTranscript ? "요약 노트 만들기" : "강의 노트 만들기";
      if (e.downloadError) actions.createEl("button", { text: "다시 시도", cls: "mod-cta" }).addEventListener("click", () => resolve("retry"));
      actions.createEl("button", { text: summaryText, cls: e.downloadError ? "" : "mod-cta" }).addEventListener("click", () => resolve("summary"));
      actions.createEl("button", { text: "PDF 첨부" }).addEventListener("click", () => resolve("attach"));
      actions.createEl("button", { text: "취소" }).addEventListener("click", () => resolve("cancel"));
    });
  }

  private hideCliPanel(): void {
    this.cliPanel?.empty();
    this.cliPanel?.hide();
  }

  /**
   * Pre-run estimate (spec 5.5) with the models of this run: the commentary
   * (also the overview) and concept models can be changed here for this run
   * only; the estimate is computed again for the choice. Resolves with the
   * user's choice and the import as last estimated.
   */
  private showEstimate(initial: PreparedImport): Promise<{ choice: "start" | "fewer-images" | "cancel"; prepared: PreparedImport }> {
    const panel = this.cliPanel!;
    panel.show();
    let prepared = initial;
    return new Promise((resolve) => {
      const render = () => {
        // The picker that changed keeps the keyboard focus across the redraw.
        const active = panel.ownerDocument.activeElement as HTMLElement | null;
        const focused = active && panel.contains(active) ? active.getAttribute("aria-label") : null;
        panel.empty();
        const e = prepared.estimate;
        const settings = this.plugin.data.settings;
        const catalog = this.plugin.modelCatalog();
        panel.createEl("h6", { text: "가져오기 전 예상 사용량", cls: "alt2obsidian-section-header" });
        panel.createDiv({
          cls: "alt2obsidian-estimate-main",
          text: `호출 ${e.calls}회 · 입력 약 ${compactTokens(e.inputTokens)} · 출력 약 ${compactTokens(e.outputTokens)} 토큰 · 이미지 ${e.imagesSent}장`,
        });
        const models = panel.createDiv({ cls: "alt2obsidian-pickers" });
        const pickers: Array<[TaskId, string]> = prepared.plan
          ? [["commentary", "해설·요약 모델"], ["concepts", "개념 추출 모델"]]
          : prepared.transcriptPlan
            ? [["commentary", "구간 요약·전체 요약 모델"], ["concepts", "개념 추출 모델"]]
            : [["commentary", "요약 모델"], ["concepts", "개념 추출 모델"]];
        for (const [task, label] of pickers) {
          renderModelPicker(models, {
            task,
            label,
            value: this.plugin.runTask(prepared, task),
            saved: settings.tasks[task],
            catalog,
            recent: settings.recentModels,
            onChange: (next) => {
              prepared = this.plugin.withRunChoice(prepared, task, next);
              render();
            },
            onSaveDefault: (next) => this.plugin.saveTaskDefault(task, next),
          });
        }
        const rows = panel.createEl("ul", { cls: "alt2obsidian-estimate-list" });
        if (prepared.plan) {
          const pdfPath = this.plugin.siblingPdf(prepared.notePath)?.path ?? attachedPdfPath(prepared.notePath);
          if (prepared.pdfSource === "attached") rows.createEl("li", { text: `첨부한 PDF를 슬라이드로 씁니다: ${pdfPath}` });
          if (prepared.altPdfIgnored) rows.createEl("li", { text: "Alt에도 슬라이드 PDF가 있지만 첨부한 PDF를 씁니다. Alt 슬라이드를 쓰려면 아래 목록 패널의 'Alt 슬라이드로 바꾸기'를 누르세요." });
          if (prepared.pdfSource === "vault") rows.createEl("li", { text: `Alt의 슬라이드 파일을 읽지 못해 노트 옆에 저장해 둔 PDF를 씁니다: ${pdfPath}` });
          const skipped = e.slidesTemplated + e.slidesDeduped + e.slidesReused;
          rows.createEl("li", {
            text: `슬라이드 ${e.slidesTotal}장 중 ${e.slidesGenerated}장 생성, ${skipped}장 생략 (표지·목차·마무리 ${e.slidesTemplated}, 중복 ${e.slidesDeduped}, 변경 없음 ${e.slidesReused})`,
          });
          const t = prepared.plan.transcriptChars;
          if (t.before > 0) rows.createEl("li", { text: `전사 ${t.before.toLocaleString()}자를 ${t.after.toLocaleString()}자로 압축` });
          if (prepared.alignment) {
            const low = prepared.alignment.lowSpans.length;
            const align = this.plugin.runTask(prepared, "alignment");
            const check =
              align.provider !== "none" && low > 0
                ? `, 불확실한 ${low}개는 ${PROVIDER_LABELS[align.provider]} ${describeModel(align.provider, align.model, catalog)} · ${describeEffort(align.effort)}로 확인`
                : low > 0
                  ? `, 불확실 ${low}개`
                  : "";
            rows.createEl("li", { text: `전사 정렬: 슬라이드별 구간 ${prepared.alignment.result.spans.length}개${check}` });
          } else if (prepared.preview.altData.transcript) {
            rows.createEl("li", { text: "전사 타임스탬프가 없어 슬라이드마다 균등 분할합니다." });
          }
          if (prepared.plan.scanned) rows.createEl("li", { text: "텍스트 레이어가 없는 PDF라 모든 슬라이드를 이미지로 보냅니다." });
          if (prepared.diagramPages.length > 0) rows.createEl("li", { text: `핵심 다이어그램 ${prepared.diagramPages.length}장 (슬라이드 ${prepared.diagramPages.join(", ")})을 Attachments/에 저장하고 노트에 넣습니다 (토큰 0)` });
          if (prepared.fewerImages) rows.createEl("li", { text: "이미지 줄이기 적용됨: 텍스트가 있는 도표 슬라이드는 텍스트만 보냅니다." });
        } else if (prepared.transcriptPlan) {
          const tp = prepared.transcriptPlan;
          const minutes = tp.durationMs !== null ? `${Math.max(1, Math.round(tp.durationMs / 60000))}분` : "";
          rows.createEl("li", {
            text: `전사${minutes ? ` ${minutes}` : ""}을 구간 ${tp.sections.length}개로 나눔: ${e.sectionsGenerated ?? 0}개 요약, ${e.sectionsReused ?? 0}개 변경 없음 (기존 요약 재사용)`,
          });
          if (tp.transcriptChars.before > 0) {
            rows.createEl("li", { text: `전사 ${tp.transcriptChars.before.toLocaleString()}자를 ${tp.transcriptChars.after.toLocaleString()}자로 압축 (구간당 최대 ${SECTION_CAP_CHARS.toLocaleString()}자)` });
          }
          if (!tp.timed) rows.createEl("li", { text: "전사에 시각이 없어(URL) 글자 수로 구간을 나눕니다. 구간에 시각이 없고, 이 노트는 노트 검증에 쓸 수 없습니다." });
          rows.createEl("li", { text: "슬라이드가 없어 슬라이드별 해설과 Synced Viewer는 없습니다. 강의 PDF를 첨부하면 슬라이드 노트로 바꿀 수 있습니다 (메모 보존)." });
        } else {
          rows.createEl("li", { text: "PDF와 전사가 없어 Alt 요약과 메모로 강의 노트를 만듭니다." });
        }
        rows.createEl("li", {
          cls: "alt2obsidian-muted",
          text: "추정치입니다. 출력 토큰은 effort에 따라 늘려 잡고(medium 기준), 모델에 따라서는 바꾸지 않습니다. 재시도는 포함하지 않습니다.",
        });

        const cap = settings.generation.tokenCapPerLecture;
        if (prepared.overCap) {
          panel.createDiv({
            cls: "alt2obsidian-error",
            text: `강의당 토큰 상한(${compactTokens(cap)})을 넘을 것 같아 시작하지 않았습니다. 이미지를 줄이거나 effort를 낮추거나 설정에서 상한을 올리세요.`,
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
          resolve({ choice: "start", prepared });
        });
        if (prepared.plan && e.imagesSent > 0 && !prepared.fewerImages) {
          const fewer = actions.createEl("button", { text: "이미지 줄이기", cls: prepared.overCap ? "mod-cta" : "" });
          fewer.addEventListener("click", () => resolve({ choice: "fewer-images", prepared }));
        }
        const cancel = actions.createEl("button", { text: "취소" });
        cancel.addEventListener("click", () => resolve({ choice: "cancel", prepared }));
        if (focused) (panel.querySelector(`select[aria-label="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
      };
      render();
    });
  }

  /** Steps, batch progress, live usage and a cancel button while the CLI runs. */
  private showRunPanel(prepared: PreparedImport, onCancel: () => void) {
    const panel = this.cliPanel!;
    panel.empty();
    panel.show();
    panel.createEl("h6", { text: `가져오는 중: ${prepared.preview.altData.title}`, cls: "alt2obsidian-section-header" });
    const steps = panel.createEl("ol", { cls: "alt2obsidian-steps" });
    const sections = !!prepared.transcriptPlan;
    const stepDefs: Array<[string, string]> = [
      ["prep", sections ? "준비 (전사 구간·예산)" : "준비 (분석·예산)"],
      ["commentary", sections ? "구간 요약" : "슬라이드 해설"],
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
    // The models of this run: as chosen, then as the CLI reports them (an alias becomes its full id).
    const catalog = this.plugin.modelCatalog();
    const labels: Partial<Record<string, string>> = { commentary: "해설", concepts: "개념", alignment: "정렬 확인" };
    const used = new Map<string, string>();
    const align = this.plugin.runTask(prepared, "alignment");
    const tasks: TaskId[] = align.provider !== "none" && (prepared.alignment?.lowSpans.length ?? 0) > 0 ? ["commentary", "concepts", "alignment"] : ["commentary", "concepts"];
    for (const task of tasks) {
      const t = this.plugin.runTask(prepared, task);
      used.set(task, `${describeModel(t.provider, t.model, catalog)} · ${describeEffort(t.effort)}`);
    }
    const modelLine = panel.createDiv({ cls: "alt2obsidian-usage-line alt2obsidian-model-line" });
    const showModels = () => modelLine.setText(`모델: ${Array.from(used.entries()).map(([t, m]) => `${labels[t] ?? t} ${m}`).join(" / ")}`);
    showModels();
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
        detail.textContent = retry ? `배치 ${n}/${total}: 실패한 ${sections ? "구간" : "슬라이드"}만 다시 요청 중` : `배치 ${n}/${total} 생성 중`;
      },
      usage: (u: LLMUsage) => {
        usage.textContent =
          `호출 ${u.calls}회 · 입력 ${compactTokens(u.inputTokens)} (캐시 ${compactTokens(u.cachedInputTokens)}) · ` +
          `출력 ${compactTokens(u.outputTokens)} · 이미지 ${u.imagesSent}장`;
      },
      detail: (text: string) => {
        detail.textContent = text;
      },
      model: (task: string, model: string) => {
        if (!labels[task] || !model) return;
        const t = this.plugin.runTask(prepared, task as TaskId);
        used.set(task, `${model} · ${describeEffort(t.effort)} (실제 실행)`);
        showModels();
      },
    };
  }

  private async afterImport(result: import("../types").ImportRecord): Promise<void> {
    const actionLabel = result.wasUpdate ? "업데이트 완료" : "가져오기 완료";
    this.showSuccess(`"${result.title}" → ${result.subject} ${actionLabel}!`);

    if (this.urlInput) this.urlInput.value = "";
    if (this.subjectInput) this.subjectInput.value = "";
    this.containerEl.querySelectorAll(".alt2obsidian-subject-chip").forEach(
      (c) => c.removeClass("is-active")
    );

    this.refreshRecentList();
    this.refreshStatuses();

    // With slides: the Synced Viewer (PDF and note scroll together). Without: the note.
    if (result.pdfPath && this.app.vault.getAbstractFileByPath(result.pdfPath) instanceof TFile) {
      await this.plugin.openSyncedViewer(result.path, result.pdfPath);
    } else {
      const noteFile = this.app.vault.getAbstractFileByPath(result.path);
      if (noteFile instanceof TFile) await this.app.workspace.getLeaf(false).openFile(noteFile);
    }
  }

  private setLoading(loading: boolean): void {
    this.busy = loading;
    for (const b of this.actionButtons) b.disabled = loading;
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
    this.verifyPanel?.abort();
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
        text:
          this.summary.unit === "section"
            ? "기존 구간의 절반 이상이 새 전사 구간과 맞지 않습니다. 다른 강의를 이 노트에 덮어쓰려는 것일 수 있습니다. 맞지 않는 구간의 메모는 노트 끝 '사라진 구간'으로 옮겨집니다."
            : "기존 슬라이드의 절반 이상이 새 슬라이드와 맞지 않습니다. 다른 강의를 이 노트에 덮어쓰려는 것일 수 있습니다. 맞지 않는 슬라이드의 메모는 노트 끝 '삭제된 슬라이드' 구간으로 옮겨집니다.",
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
    const unit = this.summary.unit === "section" ? "구간" : "슬라이드";
    const fmt = (nums: number[]) =>
      nums.length > 0 ? ` (${unit} ${nums.slice(0, 12).join(", ")}${nums.length > 12 ? " ..." : ""})` : "";
    const drifts = slideDrifts ?? [];
    const reorders = slideReorders ?? [];
    const insertions = slideInsertions ?? [];
    const deletions = slideDeletions ?? [];
    this.renderList(`${unit} 변경`, [
      `내용 변경(drift): ${drifts.length}개${fmt(drifts.map((d) => d.slideNum))}`,
      `순서 이동: ${reorders.length}개${fmt(reorders.map((r) => r.to))}`,
      `새 ${unit}: ${insertions.length}개${fmt(insertions)}`,
      `${this.summary.unit === "section" ? "사라진 구간" : "삭제된 슬라이드"}(orphan): ${deletions.length}개${fmt(deletions.map((d) => d.slideNum))}`,
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
