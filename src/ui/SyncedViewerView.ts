// Synced Viewer ItemView (plan Task 1.5, A2 default contract).
//
// Hosts a vertical-split view inside Obsidian:
//   Left: pdfjs-dist PDFViewer instance (real text layer → text selection works)
//   Right: rendered markdown of the lecture .md
//
// Page-change in PDF (eventBus.on("pagechanging")) drives the markdown to
// scroll the matching `## 📚 슬라이드 N` heading into view. Two-way sync
// (md scroll → PDF page) deferred to 1.1.1; one-way is the dominant
// study flow.
//
// Spec criteria 6, 7. md→PDF (criterion 8) lands in 1.1.1.

import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownRenderer,
  Notice,
  Component,
} from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
// pdfjs PDFViewer + EventBus + LinkService — official A2 path.
import {
  PDFViewer,
  EventBus,
  PDFLinkService,
} from "pdfjs-dist/web/pdf_viewer.mjs";
// pdfjs-dist ships a viewer stylesheet; bundled as text via esbuild loader.
import pdfViewerCssText from "pdfjs-dist/web/pdf_viewer.css";

export const VIEW_TYPE_SYNCED_VIEWER = "alt2obsidian-synced-viewer";

interface SyncedViewerState {
  mdPath: string | null;
  pdfPath: string | null;
}

const PDF_VIEWER_STYLE_ID = "alt2obs-pdfjs-viewer-style";
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
}
.alt2obs-pdf-viewer-container {
  position: absolute;
  inset: 0;
  overflow: auto;
}
.alt2obs-md-pane {
  flex: 1;
  overflow: auto;
  padding: 16px 22px;
  background: var(--background-primary);
  border-left: 1px solid var(--background-modifier-border);
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

  private toolbarEl!: HTMLElement;
  private panesEl!: HTMLElement;
  private pdfPaneEl!: HTMLElement;
  private pdfViewerContainerEl!: HTMLElement;
  private mdPaneEl!: HTMLElement;
  private pageInfoEl!: HTMLElement;
  private prevButtonEl!: HTMLButtonElement;
  private nextButtonEl!: HTMLButtonElement;
  private nativeViewButtonEl!: HTMLButtonElement;

  private pdfDocument: any = null;
  private pdfViewer: PDFViewer | null = null;
  private eventBus: EventBus | null = null;
  private linkService: PDFLinkService | null = null;

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
    this.mdRenderComponent.unload();
    if (this.pdfViewer) {
      try {
        // PDFViewer doesn't expose a clean destroy; clearing the document is enough.
        this.pdfViewer.setDocument(null as any);
      } catch (_) {
        // ignore
      }
      this.pdfViewer = null;
    }
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

  /**
   * Public entry — open the viewer for the given .md + .pdf pair. Triggered
   * by the "Open Synced Viewer" command in main.ts.
   */
  async openPair(mdPath: string, pdfPath: string): Promise<void> {
    this.mdPath = mdPath;
    this.pdfPath = pdfPath;
    await this.loadCurrentPair();
  }

  private injectGlobalStyles(): void {
    if (!document.getElementById(PDF_VIEWER_STYLE_ID)) {
      const s = document.createElement("style");
      s.id = PDF_VIEWER_STYLE_ID;
      s.textContent = pdfViewerCssText;
      document.head.appendChild(s);
    }
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
    zoomOutBtn.onclick = () => this.adjustScale(-0.1);

    const zoomInBtn = this.toolbarEl.createEl("button", { text: "+" });
    zoomInBtn.onclick = () => this.adjustScale(0.1);

    this.nativeViewButtonEl = this.toolbarEl.createEl("button", {
      text: "Obsidian native PDF",
    });
    this.nativeViewButtonEl.onclick = () => this.openInNativeView();

    this.pageInfoEl = this.toolbarEl.createDiv({ cls: "alt2obs-page-info" });
    this.updatePageInfo();
  }

  private buildPanes(root: HTMLElement): void {
    this.panesEl = root.createDiv({ cls: "alt2obs-synced-panes" });
    this.pdfPaneEl = this.panesEl.createDiv({ cls: "alt2obs-pdf-pane" });
    this.pdfViewerContainerEl = this.pdfPaneEl.createDiv({
      cls: "alt2obs-pdf-viewer-container pdfViewer",
    });
    // PDFViewer requires a wrapper with the .pdfViewer class for its layout.
    // The wrapper container itself must scroll; pdfjs reads scroll from it.
    this.mdPaneEl = this.panesEl.createDiv({ cls: "alt2obs-md-pane" });
  }

  private renderEmptyState(): void {
    this.pdfViewerContainerEl.empty();
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
      this.pdfViewerContainerEl.empty();
      this.pdfViewerContainerEl.createDiv({
        cls: "alt2obs-empty-state",
        text: `PDF를 찾을 수 없습니다: ${path}`,
      });
      this.totalPages = 0;
      this.updatePageInfo();
      return;
    }
    const buffer = await this.app.vault.readBinary(file);

    // Tear down previous instance.
    if (this.pdfViewer) {
      try {
        this.pdfViewer.setDocument(null as any);
      } catch (_) {
        // ignore
      }
    }
    if (this.pdfDocument) {
      try {
        await this.pdfDocument.destroy();
      } catch (_) {
        // ignore
      }
    }
    this.pdfViewerContainerEl.empty();
    this.pdfViewerContainerEl.addClass("pdfViewer");

    // Build a fresh EventBus + LinkService + PDFViewer for this document.
    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({ eventBus: this.eventBus });

    // PDFViewer expects its container to be scrollable. We use the OUTER
    // pdfPaneEl as the scroll container (alt2obs-pdf-pane) and pass the
    // INNER element (alt2obs-pdf-viewer-container) as `viewer`. The outer
    // element is what scrolls; the inner holds the .page elements.
    this.pdfViewer = new PDFViewer({
      container: this.pdfPaneEl as HTMLDivElement,
      viewer: this.pdfViewerContainerEl as HTMLDivElement,
      eventBus: this.eventBus,
      linkService: this.linkService,
      textLayerMode: 1, // 1 = enabled (text selection works)
      annotationMode: 0, // disable annotation layer for now
    } as any);
    this.linkService.setViewer(this.pdfViewer);

    // Subscribe BEFORE setDocument so we don't miss the initial pagechanging.
    this.eventBus.on("pagesinit", () => {
      this.pdfViewer!.currentScaleValue = "page-width";
    });
    this.eventBus.on("pagechanging", (evt: { pageNumber: number }) => {
      this.handlePdfPageChange(evt.pageNumber);
    });

    this.pdfDocument = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    this.totalPages = this.pdfDocument.numPages;
    this.pdfViewer.setDocument(this.pdfDocument);
    this.linkService.setDocument(this.pdfDocument, null);
    this.currentPage = 1;
    this.updatePageInfo();
  }

  private handlePdfPageChange(pageNumber: number): void {
    if (pageNumber === this.currentPage) return;
    this.currentPage = pageNumber;
    this.updatePageInfo();
    this.scrollMarkdownToSlide(pageNumber);
  }

  private scrollMarkdownToSlide(slideNum: number): void {
    // Find the H2 heading for `## 📚 슬라이드 {slideNum}` in the rendered
    // markdown pane and scroll it into view. The rendered markdown puts H2
    // text inside <h2> elements; emoji + text are concatenated.
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
    if (!this.pdfViewer || pageNum < 1 || pageNum > this.totalPages) return;
    this.pdfViewer.currentPageNumber = pageNum;
  }

  private adjustScale(delta: number): void {
    if (!this.pdfViewer) return;
    const next = (this.pdfViewer.currentScale || 1) + delta;
    this.pdfViewer.currentScale = Math.max(0.5, Math.min(3.0, next));
  }

  private async openInNativeView(): Promise<void> {
    if (!this.pdfPath) return;
    const file = this.app.vault.getAbstractFileByPath(this.pdfPath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(file);
  }
}
