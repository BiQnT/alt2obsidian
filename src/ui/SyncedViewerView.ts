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
.alt2obs-pdf-page {
  display: block;
  margin: 0 auto 12px;
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
  private intersectionObserver: IntersectionObserver | null = null;
  private mdRenderComponent: Component = new Component();

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
  }

  async onClose(): Promise<void> {
    this.tearDownIntersectionObserver();
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

    const nativeBtn = this.toolbarEl.createEl("button", {
      text: "Obsidian native PDF",
    });
    nativeBtn.onclick = () => this.openInNativeView();

    this.pageInfoEl = this.toolbarEl.createDiv({ cls: "alt2obs-page-info" });
    this.updatePageInfo();
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
    this.tearDownIntersectionObserver();
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

    // Render each page to a canvas synchronously into the pane (in order).
    // For very large decks this could be moved to lazy/visible-only rendering;
    // typical lectures (~50 pages) are fine to render up-front.
    for (let pageNum = 1; pageNum <= this.totalPages; pageNum++) {
      const placeholder = this.pdfPaneEl.createDiv({
        cls: "alt2obs-pdf-page-loading",
        text: `슬라이드 ${pageNum} / ${this.totalPages} 렌더 중…`,
      });
      try {
        const canvas = await this.renderPageToCanvas(pageNum);
        canvas.classList.add("alt2obs-pdf-page");
        canvas.dataset.pageNum = String(pageNum);
        placeholder.replaceWith(canvas);
        this.pageCanvases.push(canvas);
      } catch (renderErr) {
        placeholder.setText(`슬라이드 ${pageNum} 렌더 실패`);
        console.warn(
          `[Alt2Obsidian] SyncedViewer page ${pageNum} render failed:`,
          renderErr
        );
      }
    }

    this.setUpIntersectionObserver();
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

  private setUpIntersectionObserver(): void {
    this.tearDownIntersectionObserver();
    if (this.pageCanvases.length === 0) return;
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        // Pick the page with the largest visible intersection ratio.
        let best: { pageNum: number; ratio: number } | null = null;
        for (const entry of entries) {
          const target = entry.target as HTMLCanvasElement;
          const num = parseInt(target.dataset.pageNum ?? "0", 10);
          if (num === 0) continue;
          if (!best || entry.intersectionRatio > best.ratio) {
            best = { pageNum: num, ratio: entry.intersectionRatio };
          }
        }
        if (best && best.ratio > 0.3 && best.pageNum !== this.currentPage) {
          this.handlePageChange(best.pageNum);
        }
      },
      {
        root: this.pdfPaneEl,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    );
    for (const c of this.pageCanvases) this.intersectionObserver.observe(c);
  }

  private tearDownIntersectionObserver(): void {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
  }

  private handlePageChange(pageNum: number): void {
    this.currentPage = pageNum;
    this.updatePageInfo();
    this.scrollMarkdownToSlide(pageNum);
  }

  private scrollMarkdownToSlide(slideNum: number): void {
    const targetText = `📚 슬라이드 ${slideNum}`;
    const headings = this.mdPaneEl.querySelectorAll("h2");
    for (const h of Array.from(headings)) {
      const t = (h.textContent || "").trim();
      if (t.startsWith(targetText)) {
        (h as HTMLElement).scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
  }

  private gotoPage(pageNum: number): void {
    if (pageNum < 1 || pageNum > this.totalPages) return;
    const canvas = this.pageCanvases[pageNum - 1];
    if (!canvas) return;
    canvas.scrollIntoView({ behavior: "smooth", block: "start" });
    // The IntersectionObserver will pick up the change as the scroll lands;
    // optimistically update the toolbar now so the buttons feel responsive.
    this.handlePageChange(pageNum);
  }

  private async adjustScale(delta: number): Promise<void> {
    const next = Math.max(0.6, Math.min(3.0, this.scale + delta));
    if (Math.abs(next - this.scale) < 0.01) return;
    this.scale = next;
    if (!this.pdfDocument) return;
    // Re-render: replace each canvas in place with a higher-DPI version.
    this.tearDownIntersectionObserver();
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
    this.setUpIntersectionObserver();
  }

  private async openInNativeView(): Promise<void> {
    if (!this.pdfPath) return;
    const file = this.app.vault.getAbstractFileByPath(this.pdfPath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(file);
  }
}
