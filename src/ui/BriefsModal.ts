import { App, Modal, Notice } from "obsidian";
import { compactTokens } from "../llm/usage";

/** The lectures "모든 강의 브리프 만들기" would build (spec 4.6). */
export interface AllBriefsPlan {
  /** Lecture notes whose brief is missing or older than the note. */
  todo: Array<{ notePath: string; hasTranscript: boolean }>;
  /** Lecture notes whose brief the user edited: never overwritten here. */
  edited: string[];
  /** The AI part for the lectures with a transcript and candidates, null when none would call. */
  aiEstimate: { calls: number; inputTokens: number; outputTokens: number } | null;
}

export interface AllBriefsResult {
  made: number;
  skipped: number;
  failed: number;
  /** Stopped with the cancel button before the end. */
  cancelled: boolean;
}

export interface BriefsHost {
  planAllBriefs(): Promise<AllBriefsPlan>;
  buildAllBriefs(
    plan: AllBriefsPlan,
    withAi: boolean,
    o: { signal: AbortSignal; onProgress(done: number, total: number, notePath: string): void }
  ): Promise<AllBriefsResult>;
}

/**
 * "모든 강의 브리프 만들기" (spec 4.6): how many lectures have no brief (or
 * one older than the note) and how many briefs the user edited (skipped),
 * then the script part only (no tokens) or with the AI emphasis (the
 * estimate shown), with progress, cancel and a summary at the end.
 */
export class BriefsModal extends Modal {
  private controller: AbortController | null = null;

  constructor(
    app: App,
    private host: BriefsHost
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("alt-to-obs-update-modal");
    contentEl.createEl("h2", { text: "모든 강의 브리프 만들기" });
    const status = contentEl.createEl("p", { text: "강의 노트를 살펴보는 중..." });
    void this.host.planAllBriefs().then(
      (plan) => this.showPlan(plan),
      (e) => status.setText(`살펴보지 못했습니다: ${e instanceof Error ? e.message : String(e)}`)
    );
  }

  onClose(): void {
    this.controller?.abort();
  }

  private showPlan(plan: AllBriefsPlan): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "모든 강의 브리프 만들기" });
    const withTranscript = plan.todo.filter((t) => t.hasTranscript).length;
    contentEl.createEl("p", {
      text:
        `브리프가 없거나 노트보다 오래된 강의 ${plan.todo.length}개` +
        (plan.edited.length > 0 ? `, 직접 고친 브리프 ${plan.edited.length}개는 건너뜁니다.` : "."),
    });
    contentEl.createEl("p", {
      cls: "alt-to-obs-muted",
      text: "스크립트만: 노트의 개요, 흐름, 슬라이드별 요지와 시각으로 만듭니다. 강조점 포함: 전사가 있는 강의는 교수님이 강조한 점과 강의 중 질문을 경량 모델로 한 번씩 더 뽑습니다.",
    });
    const actions = contentEl.createDiv({ cls: "alt-to-obs-update-actions" });
    if (plan.todo.length === 0) {
      actions.createEl("button", { text: "닫기", cls: "mod-cta" }).addEventListener("click", () => this.close());
      return;
    }
    actions.createEl("button", { text: "스크립트만 (토큰 0)", cls: "mod-cta" }).addEventListener("click", () => void this.run(plan, false));
    const ai = plan.aiEstimate;
    const aiBtn = actions.createEl("button", {
      text: ai ? `강조점 포함 (예상 호출 ${ai.calls}회 · 입력 약 ${compactTokens(ai.inputTokens)} · 출력 약 ${compactTokens(ai.outputTokens)})` : "강조점 포함 (전사가 있는 강의 없음)",
    });
    aiBtn.disabled = !ai || withTranscript === 0;
    aiBtn.addEventListener("click", () => void this.run(plan, true));
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
  }

  private async run(plan: AllBriefsPlan, withAi: boolean): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "브리프 만드는 중" });
    const line = contentEl.createEl("p", { cls: "alt-to-obs-briefs-progress", text: `0/${plan.todo.length}` });
    const actions = contentEl.createDiv({ cls: "alt-to-obs-update-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    const controller = new AbortController();
    this.controller = controller;
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      cancel.setText("취소하는 중...");
      controller.abort();
    });
    new Notice(`브리프 ${plan.todo.length}개를 만듭니다${withAi ? " (강조점 포함)" : ""}.`);
    let result: AllBriefsResult;
    try {
      result = await this.host.buildAllBriefs(plan, withAi, {
        signal: controller.signal,
        onProgress: (done, total, notePath) => line.setText(`${done}/${total}: ${notePath.split("/").pop()?.replace(/\.md$/, "") ?? notePath}`),
      });
    } catch (e) {
      line.setText(`멈췄습니다: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      this.controller = null;
    }
    const summary = `${result.cancelled ? "취소했습니다. " : ""}만든 브리프 ${result.made}개, 건너뜀 ${result.skipped}개, 실패 ${result.failed}개.`;
    contentEl.empty();
    contentEl.createEl("h2", { text: result.cancelled ? "브리프 만들기 취소" : "브리프 만들기 완료" });
    contentEl.createEl("p", { cls: "alt-to-obs-briefs-summary", text: summary });
    new Notice(summary);
    contentEl.createDiv({ cls: "alt-to-obs-update-actions" }).createEl("button", { text: "닫기", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }
}
