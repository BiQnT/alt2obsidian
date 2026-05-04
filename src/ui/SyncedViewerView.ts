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
// - IntersectionObserver tracks which page is currently the most visible
//   and emits a synthetic page-change → drives the right pane to scroll
//   the matching `## 📚 슬라이드 N` heading into view.
// - Page nav (◀/▶) scrolls the target canvas to the top of the pane.
// - Zoom (− / +) re-renders all pages at the new DPI scale.
// - "Obsidian native PDF" escape hatch button opens the file in Obsidian's
//   native PDF view in a split pane (which has find/select/annotation).

import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownRenderer,
  Notice,
  Component,
} from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export const VIEW_TYPE_SYNCED_VIEWER = "alt2obsidian-synced-viewer";

interface SyncedViewerState {
  mdPath: string | null;
  pdfPath: string | null;
}

const SYNCED_VIEWER_STYLE_ID = "alt2obs-synced-viewer-style";

const SYNCED_VIEWER_CSS = `
.alt2obs-synced-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.alt2obs-synced-toolbar {
  display: flex;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  flex-shrink: 0;
  align-items: center;
}
.alt2obs-synced-toolbar button {
  padding: 4px 10px;
  font-size: 12px;
}
.alt2obs-synced-toolbar .alt2obs-page-info {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 12px;
}
.alt2obs-synced-panes {
  display: flex;
  flex: 1;
  min-height: 0;
}
.alt2obs-pdf-pane {
  flex: 1;
  overflow: auto;
  background: var(--background-primary-alt);
  position: relative;
  min-width: 0;
  padding: 12px;
}
.alt2obs-pdf-page-wrapper {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  margin-bottom: 16px;
}
.alt2obs-pdf-page-label {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--background-secondary);
  padding: 2px 10px;
  border-radius: 4px;
  margin-bottom: 4px;
  align-self: flex-start;
  font-weight: 500;
}
.alt2obs-pdf-page-wrapper.is-current .alt2obs-pdf-page-label {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.alt2obs-pdf-page {
  display: block;
  margin: 0 auto;
  max-width: 100%;
  background: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.alt2obs-pdf-page-loading {
  text-align: center;
  color: var(--text-muted);
  padding: 16px;
}
.alt2obs-md-pane {
  flex: 1;
  overflow: auto;
  padding: 16px 22px;
  background: var(--background-primary);
  border-left: 1px solid var(--background-modifier-border);
  min-width: 0;
}
.alt2obs-md-pane .markdown-rendered {
  max-width: 100%;
}
.alt2obs-empty-state {
  padding: 32px;
  color: var(--text-muted);
  text-align: center;
}
`;

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

  private pdfDocument: any = null;
  private pageCanvases: HTMLCanvasElement[] = [];
  private pageWrappers: HTMLElement[] = [];
  private slideHeadings: Map<number, HTMLElement> = new Map();
  private pdfObserver: IntersectionObserver | null = null;
  private mdObserver: IntersectionObserver | null = null;
  private mdRenderComponent: Component = new Component();
  private syncTimer: number | null = null;
  private pendingPageNum: number | null = null;
  private mdSyncTimer: number | null = null;
  private pendingMdPageNum: number | null = null;
  // Suppression: when ONE side initiates a programmatic scroll on the OTHER
  // side, we ignore that other side's intersection events for a brief window
  // so the smooth-scroll doesn't bounce a return sync back. Single shared
  // timestamp keeps the logic simple.
  private suppressSyncUntil = 0;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SYNCED_VIEWER;
  }

  getDisplayText(): string {
    if (!this.mdPath) return "Synced Viewer";
    const name = this.mdPath.split("/").pop()?.replace(/\.md$/, "") ?? "Synced";
    return `${name} (Synced)`;
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    this.injectGlobalStyles();
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("alt2obs-synced-viewer");
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
    this.tearDownPdfObserver();
    this.tearDownMdObserver();
    this.mdRenderComponent.unload();
    if (this.pdfDocument) {
      try {
        await this.pdfDocument.destroy();
      } catch (_) {
        // ignore
      }
      this.pdfDocument = null;
    }
  }

  async setState(state: any, result: any): Promise<void> {
    const next: SyncedViewerState = state ?? { mdPath: null, pdfPath: null };
    if (next.mdPath !== this.mdPath || next.pdfPath !== this.pdfPath) {
      this.mdPath = next.mdPath;
      this.pdfPath = next.pdfPath;
      await this.loadCurrentPair();
    }
    return super.setState(state, result);
  }

  getState(): any {
    return { mdPath: this.mdPath, pdfPath: this.pdfPath };
  }

  async openPair(mdPath: string, pdfPath: string): Promise<void> {
    this.mdPath = mdPath;
    this.pdfPath = pdfPath;
    await this.loadCurrentPair();
  }

  private injectGlobalStyles(): void {
    if (!document.getElementById(SYNCED_VIEWER_STYLE_ID)) {
      const s = document.createElement("style");
      s.id = SYNCED_VIEWER_STYLE_ID;
      s.textContent = SYNCED_VIEWER_CSS;
      document.head.appendChild(s);
    }
  }

  private buildToolbar(root: HTMLElement): void {
    this.toolbarEl = root.createDiv({ cls: "alt2obs-synced-toolbar" });

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
      text: "Obsidian native PDF",
    });
    nativeBtn.onclick = () => this.openInNativeView();

    this.pageInfoEl = this.toolbarEl.createDiv({ cls: "alt2obs-page-info" });
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
    this.panesEl = root.createDiv({ cls: "alt2obs-synced-panes" });
    this.pdfPaneEl = this.panesEl.createDiv({ cls: "alt2obs-pdf-pane" });
    this.mdPaneEl = this.panesEl.createDiv({ cls: "alt2obs-md-pane" });
  }

  private renderEmptyState(): void {
    this.pdfPaneEl.empty();
    this.mdPaneEl.empty();
    this.mdPaneEl.createDiv({
      cls: "alt2obs-empty-state",
      text:
        "강의 노트를 선택한 뒤 'Open Synced Viewer' 명령을 실행하시거나 사이드바에서 노트를 여세요.",
    });
  }

  private updatePageInfo(): void {
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
    try {
      await this.loadMarkdown(this.mdPath);
    } catch (e) {
      console.warn("[Alt2Obsidian] SyncedViewer markdown load failed:", e);
      new Notice("강의 노트를 불러올 수 없습니다.");
    }
    try {
      await this.loadPdf(this.pdfPath);
    } catch (e) {
      console.warn("[Alt2Obsidian] SyncedViewer PDF load failed:", e);
      new Notice("PDF를 불러올 수 없습니다.");
    }
  }

  private async loadMarkdown(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.mdPaneEl.empty();
      this.mdPaneEl.createDiv({
        cls: "alt2obs-empty-state",
        text: `노트를 찾을 수 없습니다: ${path}`,
      });
      return;
    }
    const text = await this.app.vault.read(file);
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
  }

  /**
   * Re-render only the markdown pane (used by the vault.on("modify")
   * listener so the user sees their edits live without reopening the
   * viewer). Must rebuild the md observer + link handlers since the
   * H2 elements get replaced.
   */
  private async refreshMarkdownOnly(): Promise<void> {
    if (!this.mdPath) return;
    this.tearDownMdObserver();
    try {
      await this.loadMarkdown(this.mdPath);
    } catch (e) {
      console.warn("[Alt2Obsidian] SyncedViewer markdown refresh failed:", e);
      return;
    }
    this.setUpMdObserver();
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
        this.app.workspace.openLinkText(href, sourcePath, newLeaf);
      });
    });
    target.querySelectorAll("a.tag").forEach((node) => {
      const a = node as HTMLAnchorElement;
      a.addEventListener("click", (event) => {
        event.preventDefault();
        const href = a.getAttribute("href") || "";
        if (!href) return;
        // Tag clicks open the search panel — same as default Obsidian behavior.
        const search = (this.app as any).internalPlugins?.getPluginById?.(
          "global-search"
        );
        if (search?.instance?.openGlobalSearch) {
          search.instance.openGlobalSearch(`tag:${href.replace(/^#/, "")}`);
        }
      });
    });
  }

  private async loadPdf(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.pdfPaneEl.empty();
      this.pdfPaneEl.createDiv({
        cls: "alt2obs-empty-state",
        text: `PDF를 찾을 수 없습니다: ${path}`,
      });
      this.totalPages = 0;
      this.updatePageInfo();
      return;
    }
    const buffer = await this.app.vault.readBinary(file);

    // Tear down any previous document/observer/canvases.
    this.tearDownPdfObserver();
    this.tearDownMdObserver();
    if (this.pdfDocument) {
      try {
        await this.pdfDocument.destroy();
      } catch (_) {
        // ignore
      }
    }
    this.pageCanvases = [];
    this.pdfPaneEl.empty();

    this.pdfDocument = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    this.totalPages = this.pdfDocument.numPages;
    this.currentPage = 1;
    this.updatePageInfo();

    // Render each page to a canvas wrapped in a labelled container, stacked
    // vertically. Each wrapper carries data-page-num so the IntersectionObserver
    // (and the user) can identify which page they're looking at.
    this.pageCanvases = [];
    this.pageWrappers = [];
    for (let pageNum = 1; pageNum <= this.totalPages; pageNum++) {
      const wrapper = this.pdfPaneEl.createDiv({ cls: "alt2obs-pdf-page-wrapper" });
      wrapper.dataset.pageNum = String(pageNum);
      wrapper.createDiv({
        cls: "alt2obs-pdf-page-label",
        text: `슬라이드 ${pageNum} / ${this.totalPages}`,
      });
      const placeholder = wrapper.createDiv({
        cls: "alt2obs-pdf-page-loading",
        text: `렌더 중…`,
      });
      try {
        const canvas = await this.renderPageToCanvas(pageNum);
        canvas.classList.add("alt2obs-pdf-page");
        canvas.dataset.pageNum = String(pageNum);
        placeholder.replaceWith(canvas);
        this.pageCanvases.push(canvas);
        this.pageWrappers.push(wrapper);
      } catch (renderErr) {
        placeholder.setText(`슬라이드 ${pageNum} 렌더 실패`);
        console.warn(
          `[Alt2Obsidian] SyncedViewer page ${pageNum} render failed:`,
          renderErr
        );
      }
    }

    this.setUpPdfObserver();
    this.setUpMdObserver();
    this.applyCurrentPageHighlight();
  }

  private async renderPageToCanvas(pageNum: number): Promise<HTMLCanvasElement> {
    const page = await this.pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: this.scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  /**
   * PDF→md observer. Trigger band is a thin slice ~10–20% from the top of
   * the pane. Exactly one wrapper intersects this band at a time as the
   * user scrolls — much less jittery than a multi-threshold ratio compare.
   */
  private setUpPdfObserver(): void {
    this.tearDownPdfObserver();
    if (this.pageWrappers.length === 0) return;
    this.pdfObserver = new IntersectionObserver(
      (entries) => {
        if (Date.now() < this.suppressSyncUntil) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          const num = parseInt(target.dataset.pageNum ?? "0", 10);
          if (num === 0 || num === this.currentPage) continue;
          this.schedulePdfDrivenSync(num);
        }
      },
      {
        root: this.pdfPaneEl,
        rootMargin: "-10% 0px -80% 0px",
        threshold: 0,
      }
    );
    for (const w of this.pageWrappers) this.pdfObserver.observe(w);
  }

  private tearDownPdfObserver(): void {
    if (this.pdfObserver) {
      this.pdfObserver.disconnect();
      this.pdfObserver = null;
    }
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.pendingPageNum = null;
  }

  /**
   * md→PDF observer. Watches the `## 📚 슬라이드 N` h2 headings in the
   * rendered markdown pane. When the user scrolls the right pane, we
   * scroll the matching canvas wrapper into the left pane.
   */
  private setUpMdObserver(): void {
    this.tearDownMdObserver();
    this.slideHeadings.clear();
    const headings = this.mdPaneEl.querySelectorAll("h2");
    for (const h of Array.from(headings)) {
      const t = (h.textContent || "").trim();
      const m = t.match(/^📚 슬라이드 (\d+)/);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      this.slideHeadings.set(num, h as HTMLElement);
    }
    if (this.slideHeadings.size === 0) return;
    this.mdObserver = new IntersectionObserver(
      (entries) => {
        if (Date.now() < this.suppressSyncUntil) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          const text = (target.textContent || "").trim();
          const m = text.match(/^📚 슬라이드 (\d+)/);
          if (!m) continue;
          const num = parseInt(m[1], 10);
          if (num === this.currentPage) continue;
          this.scheduleMdDrivenSync(num);
        }
      },
      {
        root: this.mdPaneEl,
        rootMargin: "-10% 0px -80% 0px",
        threshold: 0,
      }
    );
    for (const h of this.slideHeadings.values()) this.mdObserver.observe(h);
  }

  private tearDownMdObserver(): void {
    if (this.mdObserver) {
      this.mdObserver.disconnect();
      this.mdObserver = null;
    }
    if (this.mdSyncTimer !== null) {
      window.clearTimeout(this.mdSyncTimer);
      this.mdSyncTimer = null;
    }
    this.pendingMdPageNum = null;
  }

  /**
   * Coalesce rapid PDF-side intersection events into a single md-pane sync.
   * While the user is scrolling fast through several pages, we keep
   * updating the pending target instead of firing N md-pane jumps; only
   * the LAST page seen in the trigger band when the scroll settles wins.
   */
  private schedulePdfDrivenSync(pageNum: number): void {
    this.pendingPageNum = pageNum;
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      const target = this.pendingPageNum;
      this.pendingPageNum = null;
      if (target !== null && target !== this.currentPage) {
        this.suppressSyncUntil = Date.now() + 600;
        this.handlePageChange(target);
      }
    }, 180);
  }

  /** Symmetric md→PDF coalescer. */
  private scheduleMdDrivenSync(pageNum: number): void {
    this.pendingMdPageNum = pageNum;
    if (this.mdSyncTimer !== null) window.clearTimeout(this.mdSyncTimer);
    this.mdSyncTimer = window.setTimeout(() => {
      this.mdSyncTimer = null;
      const target = this.pendingMdPageNum;
      this.pendingMdPageNum = null;
      if (target !== null && target !== this.currentPage) {
        this.suppressSyncUntil = Date.now() + 600;
        this.currentPage = target;
        this.updatePageInfo();
        this.applyCurrentPageHighlight();
        this.scrollPdfToPage(target);
      }
    }, 180);
  }

  private handlePageChange(pageNum: number): void {
    this.currentPage = pageNum;
    this.updatePageInfo();
    this.applyCurrentPageHighlight();
    this.scrollMarkdownToSlide(pageNum);
  }

  private applyCurrentPageHighlight(): void {
    for (const w of this.pageWrappers) {
      const num = parseInt(w.dataset.pageNum ?? "0", 10);
      w.classList.toggle("is-current", num === this.currentPage);
    }
  }

  /**
   * Scroll the corresponding canvas wrapper to the top of the PDF pane.
   * Used by md→PDF sync and by the page nav buttons.
   */
  private scrollPdfToPage(pageNum: number): void {
    const wrapper = this.pageWrappers[pageNum - 1];
    if (!wrapper) return;
    const wrapperTop = wrapper.offsetTop;
    this.pdfPaneEl.scrollTo({ top: wrapperTop - 8, behavior: "smooth" });
  }

  /**
   * Scroll the matching `## 📚 슬라이드 N` heading into view in the right
   * pane — but only if it isn't already comfortably visible. Avoids the
   * "yank" feeling when the user is mid-scrolling on the PDF side and the
   * corresponding md heading is already on screen.
   */
  private scrollMarkdownToSlide(slideNum: number): void {
    const targetText = `📚 슬라이드 ${slideNum}`;
    const headings = this.mdPaneEl.querySelectorAll("h2");
    for (const h of Array.from(headings)) {
      const t = (h.textContent || "").trim();
      if (!t.startsWith(targetText)) continue;
      const el = h as HTMLElement;
      const rect = el.getBoundingClientRect();
      const paneRect = this.mdPaneEl.getBoundingClientRect();
      const slack = 24; // a heading sitting just above/below the pane edge still counts as visible
      const alreadyVisible =
        rect.top >= paneRect.top - slack &&
        rect.top <= paneRect.bottom - slack;
      if (alreadyVisible) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }

  private gotoPage(pageNum: number): void {
    if (pageNum < 1 || pageNum > this.totalPages) return;
    this.suppressSyncUntil = Date.now() + 600;
    this.handlePageChange(pageNum);
    this.scrollPdfToPage(pageNum);
  }

  private async adjustScale(delta: number): Promise<void> {
    const next = Math.max(0.6, Math.min(3.0, this.scale + delta));
    if (Math.abs(next - this.scale) < 0.01) return;
    this.scale = next;
    if (!this.pdfDocument) return;
    // Re-render: replace each canvas in place with a higher-DPI version.
    this.tearDownPdfObserver();
    for (let i = 0; i < this.pageCanvases.length; i++) {
      const oldCanvas = this.pageCanvases[i];
      const pageNum = i + 1;
      try {
        const next = await this.renderPageToCanvas(pageNum);
        next.classList.add("alt2obs-pdf-page");
        next.dataset.pageNum = String(pageNum);
        oldCanvas.replaceWith(next);
        this.pageCanvases[i] = next;
      } catch (e) {
        console.warn(
          `[Alt2Obsidian] SyncedViewer rescale page ${pageNum} failed:`,
          e
        );
      }
    }
    this.setUpPdfObserver();
  }

  private async openInNativeView(): Promise<void> {
    if (!this.pdfPath) return;
    const file = this.app.vault.getAbstractFileByPath(this.pdfPath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(file);
  }
}
