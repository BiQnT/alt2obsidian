// "PDF 첨부" (spec 4.10): pick a PDF from the vault (fuzzy search over its
// PDFs) or from disk (a file input read into memory; nothing depends on the
// deprecated `File.path`). The plugin copies it next to the lecture note
// (src/main.ts `attachPdf`).

import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";

export type PickedPdf = { kind: "vault"; path: string } | { kind: "disk"; name: string; data: ArrayBuffer };

/** A file picked on disk (a browser `File`), read into memory. */
export async function readPickedFile(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<PickedPdf> {
  return { kind: "disk", name: file.name, data: await file.arrayBuffer() };
}

class VaultPdfSuggestModal extends FuzzySuggestModal<TFile> {
  private done = false;

  constructor(
    app: App,
    private onDone: (file: TFile | null) => void
  ) {
    super(app);
    this.setPlaceholder("첨부할 PDF 검색 (보관함)");
    this.emptyStateText = "보관함에 PDF가 없습니다";
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => f.extension.toLowerCase() === "pdf")
      .sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.finish(file);
  }

  onClose(): void {
    // Obsidian closes the modal before it reports the choice: wait a tick.
    window.setTimeout(() => this.finish(null), 50);
  }

  private finish(file: TFile | null): void {
    if (this.done) return;
    this.done = true;
    this.onDone(file);
  }
}

class PdfSourceModal extends Modal {
  private done = false;

  constructor(
    app: App,
    private opts: { title: string; target: string; replacing: boolean },
    private onDone: (picked: PickedPdf | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("alt2obsidian-attach-modal");
    contentEl.createEl("h2", { text: "강의 PDF 첨부" });
    contentEl.createEl("p", { text: `"${this.opts.title}"의 슬라이드 PDF를 고르세요. ${this.opts.target}로 복사하고, 이후 가져오기는 이 강의를 슬라이드 강의로 다룹니다 (슬라이드별 해설, 전사 정렬, Synced Viewer, 슬라이드 대조 검증).` });
    if (this.opts.replacing) contentEl.createEl("p", { cls: "alt2obsidian-error", text: `이미 있는 ${this.opts.target}를 고른 PDF로 바꿉니다.` });
    const actions = contentEl.createDiv({ cls: "alt2obsidian-update-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const fromVault = actions.createEl("button", { text: "보관함에서 고르기" });
    fromVault.addEventListener("click", () => {
      // Hand over to the vault picker; this modal's close must not answer null.
      const onDone = this.onDone;
      this.done = true;
      this.close();
      new VaultPdfSuggestModal(this.app, (file) => onDone(file ? { kind: "vault", path: file.path } : null)).open();
    });
    const input = contentEl.createEl("input", { type: "file", attr: { accept: "application/pdf,.pdf" } });
    input.style.display = "none";
    const fromDisk = actions.createEl("button", { text: "컴퓨터에서 고르기", cls: "mod-cta" });
    fromDisk.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void readPickedFile(file).then(
        (picked) => this.finish(picked),
        () => this.finish(null)
      );
    });
  }

  private finish(picked: PickedPdf | null): void {
    if (this.done) return;
    this.done = true;
    this.onDone(picked);
    this.close();
  }

  onClose(): void {
    this.finish(null);
  }
}

/** Asks where the PDF comes from and returns it, or null when cancelled. */
export function pickPdf(app: App, opts: { title: string; target: string; replacing: boolean }): Promise<PickedPdf | null> {
  return new Promise((resolve) => new PdfSourceModal(app, opts, resolve).open());
}

/** A message with buttons; resolves with the chosen button's id, or null when closed. */
export function choose(app: App, heading: string, paragraphs: string[], buttons: Array<{ id: string; text: string; cta?: boolean }>): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      resolve(id);
    };
    const modal = new (class extends Modal {
      onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: heading });
        for (const p of paragraphs) contentEl.createEl("p", { text: p });
        const actions = contentEl.createDiv({ cls: "alt2obsidian-update-actions" });
        for (const b of buttons) {
          const el = actions.createEl("button", { text: b.text, cls: b.cta ? "mod-cta" : "" });
          el.addEventListener("click", () => {
            finish(b.id);
            this.close();
          });
        }
      }
      onClose(): void {
        finish(null);
      }
    })(app);
    modal.open();
  });
}
