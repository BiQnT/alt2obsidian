// Synced Viewer ItemView (plan Task 1.5).
//
// Originally targeted A2 (pdfjs-dist `web/pdf_viewer.mjs` with EventBus +
// PDFViewer + text-layer for native text selection). Pivoted to A4
// (canvas-only) at first manual QA because pdfjs-dist@4.10.38 ships an
// internal version skew between `web/pdf_viewer.mjs` (Viewer 4.10.38) and
// the pdfjs runtime its viewer code is bundled against (API 5.3.34); the
// Viewer's strict version check throws on every setDocument regardless of
// which pdf.mjs build we import. See git log 2026-05-03 hotfix sequence.
//
// A4 contract:
// - Render each PDF page to a `<canvas>` stacked vertically in the left pane
//   (uses legacy pdfjs that PdfProcessor already proves working).
// - Scroll listeners on both panes find the slide being read (the last page
//   or `## 📚 슬라이드 N` heading above a line a quarter down the pane) and
//   scroll the other pane to it. A scroll the viewer starts itself is not
//   synced back (guarded until its scrollend). 2.0.0-beta.4 replaced the
//   IntersectionObserver bands, which only fired while a page or heading
//   crossed a thin band, dropped crossings during a 600 ms suppression
//   window, and were wired only after every page had rendered.
// - Page nav (◀/▶) scrolls the target canvas to the top of the pane.
// - Zoom (− / +) re-renders all pages at the new DPI scale.
// - "PDF만 보기" opens the file in Obsidian's own PDF view in a split pane
//   (find, select, annotation). Opening a lecture PDF normally turns that
//   tab into this viewer (setting "강의 PDF를 열면 뷰어로 열기"); a tab
//   opened with this button is left as a plain PDF.

import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownRenderer,
  Notice,
  Component,
  ViewStateResult,
} from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseAlignment, segmentInSpan, spansForSlide, StoredSpan } from "../core/prep/TranscriptAligner";
import { headingForSlide, pickSlideHeadings, PROBE_SHARE, sectionAt } from "./viewerSync";
import { stripManagedComments } from "../editor/managedComments";

/** Timestamped transcript of a local note (plugin cache, else Alt). */
export type TranscriptLoader = (altLocalId: string) => Promise<Array<{ startMs: number; endMs: number; text: string }> | null>;

function mmss(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const sec = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

export const VIEW_TYPE_SYNCED_VIEWER = "alt2obsidian-synced-viewer";

interface SyncedViewerState {
  mdPath: string | null;
  pdfPath: string | null;
  /** Opened in place of a lecture PDF tab (see setState). */
  replacesPdf?: boolean;
}

type Pane = "pdf" | "md";

export class SyncedViewerView extends ItemView {
  private mdPath: string | null = null;
  private pdfPath: string | null = null;
  private currentPage = 1;
  private totalPages = 0;
  private scale = 1.5; // page-render DPI multiplier; user can adjust via ± buttons

  private toolbarEl!: HTMLElement;
  private panesEl!: HTMLElement;
  private pdfPaneEl!: HTMLElement;
  private mdPaneEl!: HTMLElement;
  private pageInfoEl!: HTMLElement;
  private prevButtonEl!: HTMLButtonElement;
  private nextButtonEl!: HTMLButtonElement;

  private pdfDocument: PDFDocumentProxy | null = null;
  private pageCanvases: HTMLCanvasElement[] = [];
  private pageWrappers: HTMLElement[] = [];
  private slideHeadings: Map<number, HTMLElement> = new Map();
  private mdRenderComponent: Component = new Component();
  /** One animation frame per pane coalesces scroll events. */
  private scrollFrame: Record<Pane, number> = { pdf: 0, md: 0 };
  /** Scrolling the other pane waits until the reader settles on a slide. */
  private followTimer: number | null = null;
  /**
   * A pane the viewer is scrolling itself: its scroll events are not synced
   * back until the scroll ends (scrollend, or the time limit when the target
   * was already in place and no scroll happened).
   */
  private guardUntil: Record<Pane, number> = { pdf: 0, md: 0 };
  /** Re-checks a pane once its guard has run out (a scroll the guard swallowed is synced then). */
  private guardTimer: Record<Pane, number | null> = { pdf: null, md: null };
  /** Pairs loaded at least once: reloading the same pair keeps both reading positions. */
  private loadedPair: string | null = null;
  /**
   * A pane being (re)loaded: its scroll events are ignored and it is not
   * scrolled to follow the other pane until the load ends.
   */
  private loading: Record<Pane, boolean> = { pdf: false, md: false };
  /** Set by onClose: scroll events that still arrive are ignored. */
  private closed = false;
  /** `alt_alignment` of the note (spec 4.9); empty = scroll sync by headings only. */
  private alignment: StoredSpan[] = [];
  private altLocalId: string | null = null;
  private transcript: Array<{ startMs: number; endMs: number; text: string }> | null = null;
  private transcriptOpen = false;
  /** One transcript load at a time (page changes re-render while it loads). */
  private transcriptLoading: Promise<void> | null = null;
  /** The note id a load was attempted for (a missing transcript is not retried on every page). */
  private transcriptTried: string | null = null;
  private transcriptPanelEl: HTMLElement | null = null;
  private transcriptBtnEl: HTMLButtonElement | null = null;
  private syncModeEl: HTMLElement | null = null;
  constructor(
    leaf: WorkspaceLeaf,
    private loadTranscript?: TranscriptLoader,
    /** Setting "관리 주석 숨기기": drop the alt2obs comment lines before rendering. */
    private hideManagedComments: () => boolean = () => true,
    /** "PDF만 보기": the plugin opens a plain PDF tab it will not turn back into this viewer. */
    private openNativePdf?: (pdfPath: string) => Promise<void>
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SYNCED_VIEWER;
  }

  getDisplayText(): string {
    if (!this.mdPath) return "Synced viewer";
    const name = this.mdPath.split("/").pop()?.replace(/\.md$/, "") ?? "Synced";
    return `${name} (Synced)`;
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("alt-to-obs-synced-viewer");
    this.buildToolbar(root);
    this.buildPanes(root);
    this.renderEmptyState();
    // When the user edits the .md elsewhere (e.g., via the "📝 노트 편집"
    // split-pane editor), re-render the right pane so they see their changes
    // without manually reopening the viewer. registerEvent ties the
    // subscription to the view's lifecycle so it auto-cleans on close.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.mdPath) {
          // Don't await — fire-and-forget refresh; observers will rewire.
          void this.refreshMarkdownOnly();
        }
      })
    );
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.cancelFollow();
    for (const pane of ["pdf", "md"] as Pane[]) {
      if (this.scrollFrame[pane]) window.cancelAnimationFrame(this.scrollFrame[pane]);
      this.scrollFrame[pane] = 0;
      if (this.guardTimer[pane] !== null) window.clearTimeout(this.guardTimer[pane]);
      this.guardTimer[pane] = null;
    }
    this.mdRenderComponent.unload();
    if (this.pdfDocument) {
      try {
        await this.pdfDocument.destroy();
      } catch {
        // ignore
      }
      this.pdfDocument = null;
    }
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const next = (state ?? { mdPath: null, pdfPath: null }) as SyncedViewerState;
    // Opened in place of a lecture PDF tab: keep that PDF out of the tab's
    // history, or Back would show it and turn it into this viewer again.
    if (next.replacesPdf && result) result.history = false;
    if (next.mdPath !== this.mdPath || next.pdfPath !== this.pdfPath) {
      this.mdPath = next.mdPath;
      this.pdfPath = next.pdfPath;
      await this.loadCurrentPair();
    }
    return super.setState(state, result);
  }

  getState(): Record<string, unknown> {
    return { mdPath: this.mdPath, pdfPath: this.pdfPath };
  }

  async openPair(mdPath: string, pdfPath: string): Promise<void> {
    this.mdPath = mdPath;
    this.pdfPath = pdfPath;
    await this.loadCurrentPair();
  }

  private buildToolbar(root: HTMLElement): void {
    this.toolbarEl = root.createDiv({ cls: "alt-to-obs-synced-toolbar" });

    this.prevButtonEl = this.toolbarEl.createEl("button", { text: "◀ 이전" });
    this.prevButtonEl.onclick = () => this.gotoPage(this.currentPage - 1);

    this.nextButtonEl = this.toolbarEl.createEl("button", { text: "다음 ▶" });
    this.nextButtonEl.onclick = () => this.gotoPage(this.currentPage + 1);

    const zoomOutBtn = this.toolbarEl.createEl("button", { text: "−" });
    zoomOutBtn.onclick = () => this.adjustScale(-0.2);

    const zoomInBtn = this.toolbarEl.createEl("button", { text: "+" });
    zoomInBtn.onclick = () => this.adjustScale(0.2);

    const editBtn = this.toolbarEl.createEl("button", { text: "📝 노트 편집" });
    editBtn.onclick = () => this.openMdInEditor();

    const nativeBtn = this.toolbarEl.createEl("button", {
      text: "PDF만 보기",
      attr: { title: "Obsidian의 PDF 보기로 엽니다 (찾기, 선택, 주석). 이 탭은 뷰어로 바뀌지 않습니다." },
    });
    nativeBtn.onclick = () => this.openInNativeView();

    this.syncModeEl = this.toolbarEl.createSpan({ cls: "alt-to-obs-sync-mode", text: "정렬 기준 동기화 · 전사 매칭" });
    this.syncModeEl.hide();
    this.transcriptBtnEl = this.toolbarEl.createEl("button", { text: "전사 패널" });
    this.transcriptBtnEl.onclick = () => void this.toggleTranscript();
    this.transcriptBtnEl.hide();

    this.pageInfoEl = this.toolbarEl.createDiv({ cls: "alt-to-obs-page-info" });
    this.updatePageInfo();
  }

  /**
   * Open the lecture .md in a regular editable Obsidian leaf next to the
   * Synced Viewer. The right markdown pane in this view is a static
   * `MarkdownRenderer.render` snapshot — read-only by design — so editing
   * happens in a normal editor leaf and the viewer auto-refreshes via
   * the `vault.on("modify")` listener registered in onOpen.
   */
  private async openMdInEditor(): Promise<void> {
    if (!this.mdPath) return;
    const file = this.app.vault.getAbstractFileByPath(this.mdPath);
    if (!(file instanceof TFile)) {
      new Notice(`노트를 찾을 수 없습니다: ${this.mdPath}`);
      return;
    }
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(file);
  }

  private buildPanes(root: HTMLElement): void {
    this.panesEl = root.createDiv({ cls: "alt-to-obs-synced-panes" });
    this.pdfPaneEl = this.panesEl.createDiv({ cls: "alt-to-obs-pdf-pane" });
    const column = this.panesEl.createDiv({ cls: "alt-to-obs-md-column" });
    this.mdPaneEl = column.createDiv({ cls: "alt-to-obs-md-pane" });
    this.transcriptPanelEl = column.createDiv({ cls: "alt-to-obs-transcript-panel" });
    this.transcriptPanelEl.hide();
    for (const pane of ["pdf", "md"] as Pane[]) {
      const el = this.paneEl(pane);
      this.registerDomEvent(el, "scroll", () => this.onPaneScroll(pane), { passive: true });
      this.registerDomEvent(el, "scrollend", () => {
        if (this.guardUntil[pane] > Date.now()) this.guard(pane, 50, true);
      });
    }
  }

  /** Alignment facts from the note's frontmatter (spec 4.9). */
  private readAlignment(file: TFile): void {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    this.alignment = parseAlignment(fm?.alt_alignment);
    const id = typeof fm?.alt_local_id === "string" ? fm.alt_local_id : null;
    if (id !== this.altLocalId) {
      this.transcript = null;
      this.transcriptTried = null;
    }
    this.altLocalId = id;
    const aligned = this.alignment.length > 0;
    this.syncModeEl?.toggle(aligned);
    this.transcriptBtnEl?.toggle(aligned && !!this.altLocalId && !!this.loadTranscript);
    if (!aligned && this.transcriptOpen) {
      this.transcriptOpen = false;
      this.transcriptPanelEl?.hide();
    }
  }

  private async toggleTranscript(): Promise<void> {
    this.transcriptOpen = !this.transcriptOpen;
    this.transcriptBtnEl?.toggleClass("is-active", this.transcriptOpen);
    this.transcriptPanelEl?.toggle(this.transcriptOpen);
    if (this.transcriptOpen) await this.renderTranscript();
  }

  /** The current slide's transcript segments with [mm:ss], from its aligned spans. */
  private async renderTranscript(): Promise<void> {
    const panel = this.transcriptPanelEl;
    if (!panel || !this.transcriptOpen) return;
    if (!this.transcript && this.altLocalId && this.loadTranscript && (this.transcriptLoading || this.transcriptTried !== this.altLocalId)) {
      if (!this.transcriptLoading) {
        this.transcriptTried = this.altLocalId;
        panel.empty();
        panel.createDiv({ cls: "alt-to-obs-empty-state", text: "전사를 불러오는 중..." });
        const id = this.altLocalId;
        const load = this.loadTranscript;
        this.transcriptLoading = load(id)
          .then((t) => {
            if (id === this.altLocalId) this.transcript = t;
          })
          .finally(() => {
            this.transcriptLoading = null;
          });
      }
      await this.transcriptLoading;
      if (!this.transcriptOpen) return;
    }
    panel.empty();
    const slide = this.currentPage;
    const spans = spansForSlide(this.alignment, slide);
    const head = panel.createDiv({ cls: "alt-to-obs-transcript-head" });
    head.createSpan({ text: `전사 · 슬라이드 ${slide} 구간${spans.some((s) => s.low) ? " (정렬 불확실)" : ""}` });
    head.createSpan({
      cls: "alt-to-obs-transcript-range",
      text: spans.map((s) => `${mmss(s.startMs)} - ${mmss(s.endMs)}`).join(", "),
    });
    const body = panel.createDiv({ cls: "alt-to-obs-transcript-body" });
    if (!this.transcript) {
      body.createDiv({ cls: "alt-to-obs-empty-state", text: "전사를 찾지 못했습니다. Alt를 실행하거나 노트를 다시 가져오세요." });
      return;
    }
    const segs = this.transcript.filter((seg) => spans.some((s) => segmentInSpan(seg.startMs, s)));
    if (segs.length === 0) {
      body.createDiv({ cls: "alt-to-obs-empty-state", text: "이 슬라이드에 정렬된 전사가 없습니다." });
      return;
    }
    for (const seg of segs) {
      const row = body.createDiv({ cls: "alt-to-obs-seg" });
      row.createSpan({ cls: "alt-to-obs-seg-time", text: `[${mmss(seg.startMs)}]` });
      row.createSpan({ text: seg.text });
    }
  }

  private renderEmptyState(): void {
    this.pdfPaneEl.empty();
    this.mdPaneEl.empty();
    this.mdPaneEl.createDiv({
      cls: "alt-to-obs-empty-state",
      text:
        "강의 노트를 선택한 뒤 'Open synced viewer' 명령을 실행하시거나 사이드바에서 노트를 여세요.",
    });
  }

  private updatePageInfo(): void {
    if (this.transcriptOpen) void this.renderTranscript();
    if (this.totalPages === 0) {
      this.pageInfoEl.setText("페이지 —");
    } else {
      this.pageInfoEl.setText(`페이지 ${this.currentPage} / ${this.totalPages}`);
    }
    if (this.prevButtonEl) this.prevButtonEl.disabled = this.currentPage <= 1;
    if (this.nextButtonEl)
      this.nextButtonEl.disabled =
        this.totalPages === 0 || this.currentPage >= this.totalPages;
  }

  private async loadCurrentPair(): Promise<void> {
    if (!this.mdPath || !this.pdfPath) {
      this.renderEmptyState();
      return;
    }
    // The same pair again (a re-import): keep where the reader was in both panes.
    const pair = `${this.mdPath}\n${this.pdfPath}`;
    const reload = this.loadedPair === pair;
    this.loadedPair = pair;
    const mdTop = reload ? this.mdPaneEl.scrollTop : undefined;
    const pdfTop = reload ? this.pdfPaneEl.scrollTop : undefined;
    try {
      await this.loadMarkdown(this.mdPath, mdTop);
    } catch (e) {
      console.warn("[Alt2Obs] SyncedViewer markdown load failed:", e);
      new Notice("강의 노트를 불러올 수 없습니다.");
    }
    try {
      await this.loadPdf(this.pdfPath, pdfTop);
    } catch (e) {
      console.warn("[Alt2Obs] SyncedViewer PDF load failed:", e);
      new Notice("PDF를 불러올 수 없습니다.");
    }
  }

  /**
   * Render the note into the right pane. The pane is guarded for the whole
   * load: emptying it resets its scroll and fires a scroll event while the
   * old headings are gone, which must not move the PDF. `restoreTop` puts
   * the reading position back before the guard is released.
   */
  private async loadMarkdown(path: string, restoreTop?: number): Promise<void> {
    this.cancelFollow();
    this.loading.md = true;
    this.slideHeadings.clear();
    try {
      await this.renderMarkdown(path);
      if (restoreTop !== undefined) this.mdPaneEl.scrollTop = restoreTop;
    } finally {
      this.loading.md = false;
      this.guard("md", 100, true);
      // The PDF moved while the note was loading: bring the note to it now.
      const shown = this.slideInPane("md");
      if (shown !== null && shown !== this.currentPage) this.scrollMarkdownToSlide(this.currentPage);
    }
  }

  private async renderMarkdown(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.mdPaneEl.empty();
      this.mdPaneEl.createDiv({
        cls: "alt-to-obs-empty-state",
        text: `노트를 찾을 수 없습니다: ${path}`,
      });
      return;
    }
    const raw = await this.app.vault.read(file);
    const text = this.hideManagedComments() ? stripManagedComments(raw) : raw;
    this.readAlignment(file);
    this.mdRenderComponent.unload();
    this.mdRenderComponent = new Component();
    this.mdRenderComponent.load();
    this.mdPaneEl.empty();
    const target = this.mdPaneEl.createDiv({ cls: "markdown-rendered" });
    await MarkdownRenderer.render(
      this.app,
      text,
      target,
      file.path,
      this.mdRenderComponent
    );
    this.attachInternalLinkHandlers(target, file.path);
    this.collectSlideHeadings();
  }

  /**
   * Re-render only the markdown pane (used by the vault.on("modify")
   * listener so the user sees their edits live without reopening the
   * viewer). Must rebuild the md observer + link handlers since the
   * H2 elements get replaced.
   */
  async refreshMarkdownOnly(): Promise<void> {
    if (!this.mdPath) return;
    try {
      // Keep the reading position after an edit elsewhere.
      await this.loadMarkdown(this.mdPath, this.mdPaneEl.scrollTop);
    } catch (e) {
      console.warn("[Alt2Obs] SyncedViewer markdown refresh failed:", e);
    }
  }

  /**
   * Wire click handlers for `.internal-link` (wikilinks) and `.tag` anchors
   * inside the rendered markdown. Without this, links inside a custom
   * ItemView don't navigate — Obsidian's default link handler only fires
   * on the workspace's own MarkdownView path.
   *
   * Convention: data-href carries the unresolved link text (e.g.
   * "Big-O 표기법"), Cmd/Ctrl-click opens in a new pane.
   */
  private attachInternalLinkHandlers(
    target: HTMLElement,
    sourcePath: string
  ): void {
    target.querySelectorAll("a.internal-link").forEach((node) => {
      const a = node as HTMLAnchorElement;
      a.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
        if (!href) return;
        const newLeaf =
          (event as MouseEvent).metaKey || (event as MouseEvent).ctrlKey;
        void this.app.workspace.openLinkText(href, sourcePath, newLeaf);
      });
    });
    target.querySelectorAll("a.tag").forEach((node) => {
      const a = node as HTMLAnchorElement;
      a.addEventListener("click", (event) => {
        event.preventDefault();
        const href = a.getAttribute("href") || "";
        if (!href) return;
        // Tag clicks open the search panel, as in Obsidian's own views
        // (the core Search plugin; not part of the public API, so optional).
        const app = this.app as unknown as {
          internalPlugins?: { getPluginById?: (id: string) => { instance?: { openGlobalSearch?: (query: string) => void } } | null };
        };
        const search = app.internalPlugins?.getPluginById?.("global-search");
        search?.instance?.openGlobalSearch?.(`tag:${href.replace(/^#/, "")}`);
      });
    });
  }

  private async loadPdf(path: string, restoreTop?: number): Promise<void> {
    this.cancelFollow();
    this.loading.pdf = true;
    try {
      await this.renderPdf(path, restoreTop);
    } finally {
      this.loading.pdf = false;
      this.guard("pdf", 100, true);
    }
  }

  private async renderPdf(path: string, restoreTop?: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.pdfPaneEl.empty();
      this.pdfPaneEl.createDiv({
        cls: "alt-to-obs-empty-state",
        text: `PDF를 찾을 수 없습니다: ${path}`,
      });
      this.totalPages = 0;
      this.updatePageInfo();
      return;
    }
    const buffer = await this.app.vault.readBinary(file);

    // Drop any previous document and canvases.
    this.cancelFollow();
    if (this.pdfDocument) {
      try {
        await this.pdfDocument.destroy();
      } catch {
        // ignore
      }
    }
    this.pageCanvases = [];
    this.pageWrappers = [];
    this.pdfPaneEl.empty();

    const doc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    this.pdfDocument = doc;
    this.totalPages = doc.numPages;
    this.currentPage = 1;
    this.updatePageInfo();

    // Render each page to a canvas wrapped in a labelled container, stacked
    // vertically. Each wrapper carries data-page-num so the scroll sync
    // (and the user) can identify which page they're looking at.
    this.pageCanvases = [];
    this.pageWrappers = [];
    for (let pageNum = 1; pageNum <= this.totalPages; pageNum++) {
      const wrapper = this.pdfPaneEl.createDiv({ cls: "alt-to-obs-pdf-page-wrapper" });
      wrapper.dataset.pageNum = String(pageNum);
      // Listed before rendering, so sync works while later pages still render.
      this.pageWrappers.push(wrapper);
      wrapper.createDiv({
        cls: "alt-to-obs-pdf-page-label",
        text: `슬라이드 ${pageNum} / ${this.totalPages}`,
      });
      const placeholder = wrapper.createDiv({
        cls: "alt-to-obs-pdf-page-loading",
        text: `렌더 중…`,
      });
      try {
        const canvas = await this.renderPageToCanvas(pageNum);
        canvas.classList.add("alt-to-obs-pdf-page");
        canvas.dataset.pageNum = String(pageNum);
        placeholder.replaceWith(canvas);
        this.pageCanvases.push(canvas);
      } catch (renderErr) {
        placeholder.setText(`슬라이드 ${pageNum} 렌더 실패`);
        console.warn(
          `[Alt2Obs] SyncedViewer page ${pageNum} render failed:`,
          renderErr
        );
      }
    }

    if (restoreTop !== undefined) {
      this.pdfPaneEl.scrollTop = restoreTop;
      this.currentPage = this.slideInPane("pdf") ?? 1;
      this.updatePageInfo();
    }
    this.applyCurrentPageHighlight();
  }

  private async renderPageToCanvas(pageNum: number): Promise<HTMLCanvasElement> {
    if (!this.pdfDocument) throw new Error("no PDF document");
    const page = await this.pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: this.scale });
    const canvas = createEl("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  private paneEl(pane: Pane): HTMLElement {
    return pane === "pdf" ? this.pdfPaneEl : this.mdPaneEl;
  }

  /**
   * Slide sections of the rendered note: the `## 📚 슬라이드 N` h2 headings;
   * only a note without any falls back to h2/h3 headings starting with
   * "슬라이드 N" (hand-made notes), so overview subheadings never count.
   */
  private collectSlideHeadings(): void {
    this.slideHeadings.clear();
    const els = Array.from(this.mdPaneEl.querySelectorAll<HTMLElement>("h2, h3"));
    const picked = pickSlideHeadings(els.map((h) => ({ level: h.tagName === "H2" ? 2 : 3, text: h.textContent || "" })));
    for (const { index, num } of picked) this.slideHeadings.set(num, els[index]);
  }

  /** Top of an element in its pane's scroll coordinates. */
  private topInPane(pane: HTMLElement, el: HTMLElement): number {
    return el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  }

  /** The slide the pane is showing, or null (above slide 1, or nothing rendered). */
  private slideInPane(pane: Pane): number | null {
    const el = this.paneEl(pane);
    const probe = el.scrollTop + el.clientHeight * PROBE_SHARE;
    const sections =
      pane === "pdf"
        ? this.pageWrappers.filter((w) => w.isConnected).map((w) => ({ num: parseInt(w.dataset.pageNum ?? "0", 10), top: this.topInPane(el, w) }))
        : Array.from(this.slideHeadings.entries())
            .filter(([, h]) => h.isConnected)
            .map(([num, h]) => ({ num, top: this.topInPane(el, h) }))
            .sort((a, b) => a.top - b.top);
    // At the very bottom the last section counts even if its top never reaches the probe line.
    if (sections.length > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2 && el.scrollTop > 0) {
      return sections[sections.length - 1].num;
    }
    return sectionAt(sections, probe);
  }

  private onPaneScroll(pane: Pane): void {
    if (this.closed || this.scrollFrame[pane]) return;
    this.scrollFrame[pane] = window.requestAnimationFrame(() => {
      this.scrollFrame[pane] = 0;
      if (this.loading[pane] || this.guardUntil[pane] > Date.now()) return;
      const slide = this.slideInPane(pane);
      if (slide === null || slide === this.currentPage) return;
      this.currentPage = slide;
      this.updatePageInfo();
      this.applyCurrentPageHighlight();
      this.followLater(pane === "pdf" ? "md" : "pdf", slide);
    });
  }

  /** Scroll the other pane once the reader has stayed on a slide for a moment. */
  private followLater(pane: Pane, slide: number): void {
    this.cancelFollow();
    this.followTimer = window.setTimeout(() => {
      this.followTimer = null;
      if (slide !== this.currentPage || this.loading[pane]) return;
      if (pane === "md") this.scrollMarkdownToSlide(slide);
      else this.scrollPdfToPage(slide);
    }, 150);
  }

  /**
   * Ignore the pane's scroll events for `ms`. When the guard runs out the
   * pane is checked once, so a scroll the reader made meanwhile still syncs.
   */
  private guard(pane: Pane, ms: number, shorten = false): void {
    // A shorter guard never cuts a longer one short unless asked (scrollend ends a programmatic scroll).
    const until = Date.now() + ms;
    if (!shorten && until < this.guardUntil[pane]) return;
    this.guardUntil[pane] = until;
    if (this.guardTimer[pane] !== null) window.clearTimeout(this.guardTimer[pane]);
    this.guardTimer[pane] = window.setTimeout(() => {
      this.guardTimer[pane] = null;
      if (this.guardUntil[pane] <= Date.now()) this.onPaneScroll(pane);
    }, ms + 10);
  }

  private cancelFollow(): void {
    if (this.followTimer !== null) {
      window.clearTimeout(this.followTimer);
      this.followTimer = null;
    }
  }

  /** A scroll started by the viewer; its own scroll events are not synced back. */
  private scrollPaneTo(pane: Pane, top: number): void {
    const el = this.paneEl(pane);
    const target = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    if (Math.abs(el.scrollTop - target) < 2) return;
    this.guard(pane, 1500);
    el.scrollTo({ top: target, behavior: "smooth" });
  }

  private applyCurrentPageHighlight(): void {
    for (const w of this.pageWrappers) {
      const num = parseInt(w.dataset.pageNum ?? "0", 10);
      w.classList.toggle("is-current", num === this.currentPage);
    }
  }

  /** Scroll the page's canvas to the top of the PDF pane (md to PDF sync, page buttons). */
  private scrollPdfToPage(pageNum: number): void {
    const wrapper = this.pageWrappers[pageNum - 1];
    if (!wrapper) return;
    this.scrollPaneTo("pdf", this.topInPane(this.pdfPaneEl, wrapper) - 8);
  }

  /**
   * Scroll the slide's heading (or the closest earlier one, when the note
   * has no section for that page) near the top of the note pane.
   */
  private scrollMarkdownToSlide(slideNum: number): void {
    const heading = headingForSlide(this.slideHeadings, slideNum);
    if (!heading) return;
    this.scrollPaneTo("md", this.topInPane(this.mdPaneEl, heading) - 8);
  }

  private gotoPage(pageNum: number): void {
    if (pageNum < 1 || pageNum > this.totalPages) return;
    this.cancelFollow();
    this.currentPage = pageNum;
    this.updatePageInfo();
    this.applyCurrentPageHighlight();
    this.scrollMarkdownToSlide(pageNum);
    this.scrollPdfToPage(pageNum);
  }

  private async adjustScale(delta: number): Promise<void> {
    const next = Math.max(0.6, Math.min(3.0, this.scale + delta));
    if (Math.abs(next - this.scale) < 0.01) return;
    this.scale = next;
    if (!this.pdfDocument) return;
    // Re-render: replace each canvas in place with a higher-DPI version.
    for (let i = 0; i < this.pageCanvases.length; i++) {
      const oldCanvas = this.pageCanvases[i];
      const pageNum = i + 1;
      try {
        const next = await this.renderPageToCanvas(pageNum);
        next.classList.add("alt-to-obs-pdf-page");
        next.dataset.pageNum = String(pageNum);
        oldCanvas.replaceWith(next);
        this.pageCanvases[i] = next;
      } catch (e) {
        console.warn(
          `[Alt2Obs] SyncedViewer rescale page ${pageNum} failed:`,
          e
        );
      }
    }
    // Page heights changed: put the current page back at the top.
    this.scrollPdfToPage(this.currentPage);
  }

  private async openInNativeView(): Promise<void> {
    if (!this.pdfPath) return;
    if (this.openNativePdf) {
      await this.openNativePdf(this.pdfPath);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(this.pdfPath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(file);
  }
}
