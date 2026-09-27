import { App, Modal } from "obsidian";
import type { MigrationPlan, MigrationResult } from "../vault/layoutMigration";

/**
 * Dry run of "Migrate 1.x vault layout" (spec 4.5): every move is listed
 * before anything happens; the apply button runs them and the modal then
 * shows what was moved and what was skipped.
 */
export class MigrationModal extends Modal {
  constructor(
    app: App,
    private plan: MigrationPlan,
    private apply: (plan: MigrationPlan) => Promise<MigrationResult>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("alt2obsidian-update-modal");
    contentEl.createEl("h2", { text: "1.x 폴더 구조 옮기기" });
    const p = this.plan;
    contentEl.createEl("p", {
      text:
        `강의 노트와 PDF를 과목 폴더 아래 ${"Lectures/"}로 옮깁니다. 파일은 Obsidian의 이름 바꾸기로 옮겨서 노트 안의 링크가 함께 갱신됩니다. ` +
        "지우거나 덮어쓰는 파일은 없습니다. Concepts/는 그대로이고 Exam/의 시험 요약은 건드리지 않습니다.",
    });
    if (p.moves.length === 0) {
      contentEl.createEl("p", { text: p.skipped.length > 0 ? "옮길 수 있는 파일이 없습니다. 아래 건너뛴 항목을 확인하세요." : "옮길 파일이 없습니다. 이미 새 구조입니다." });
    }
    this.renderList(`옮길 파일 (${p.moves.length})`, p.moves.map((m) => `${m.from} → ${m.to}`));
    if (p.skipped.length > 0) this.renderList(`건너뜀 (${p.skipped.length})`, p.skipped.map((s) => `${s.from}: ${s.reason}`));
    if (p.otherNotes.length > 0) this.renderList(`그대로 두는 다른 노트 (${p.otherNotes.length})`, p.otherNotes);
    if (p.examFiles > 0) contentEl.createEl("p", { cls: "alt2obsidian-muted", text: `Exam/ 폴더의 파일 ${p.examFiles}개는 그대로 둡니다.` });

    const actions = contentEl.createDiv({ cls: "alt2obsidian-update-actions" });
    actions.createEl("button", { text: "닫기" }).addEventListener("click", () => this.close());
    if (p.moves.length === 0) return;
    const run = actions.createEl("button", { text: `옮기기 (${p.moves.length}개)`, cls: "mod-cta" });
    run.addEventListener("click", async () => {
      run.disabled = true;
      run.textContent = "옮기는 중...";
      try {
        this.showResult(await this.apply(p));
      } catch (e) {
        run.disabled = false;
        run.textContent = `옮기기 (${p.moves.length}개)`;
        contentEl.createDiv({ cls: "alt2obsidian-error", text: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  private showResult(result: MigrationResult): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "폴더 구조 옮기기 완료" });
    contentEl.createEl("p", { text: `${result.moved.length}개를 옮겼고 ${result.skipped.length}개를 건너뛰었습니다. 다시 실행해도 이미 옮긴 파일은 그대로입니다.` });
    this.renderList("옮긴 파일", result.moved.map((m) => `${m.from} → ${m.to}`));
    if (result.skipped.length > 0) this.renderList("건너뜀", result.skipped.map((s) => `${s.from}: ${s.reason}`));
    const actions = contentEl.createDiv({ cls: "alt2obsidian-update-actions" });
    actions.createEl("button", { text: "닫기", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }

  private renderList(label: string, items: string[]): void {
    const section = this.contentEl.createDiv({ cls: "alt2obsidian-update-section" });
    section.createEl("h3", { text: label });
    if (items.length === 0) {
      section.createEl("p", { text: "없음", cls: "alt2obsidian-update-empty" });
      return;
    }
    const list = section.createEl("ul");
    for (const item of items) list.createEl("li", { text: item });
  }
}
