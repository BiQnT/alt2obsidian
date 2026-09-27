// Sidebar tab "노트 검증" (spec 4.6, mockup "5. 노트 검증 (노션 대조)"):
// input choice (vault markdown file, Notion MCP, paste), target lecture,
// a pre-run estimate (claims -> judged, retrieval by script at 0 tokens,
// expected tokens), run with progress and cancel, then the result counts
// and a link to the verification note.

import { App, setIcon } from "obsidian";
import type Alt2ObsidianPlugin from "../main";
import type { PreparedVerification } from "../main";
import { compactTokens } from "../llm/usage";
import { PROVIDER_LABELS } from "../settings/llmSettings";
import { NotionMcpMissingError } from "../verify/notionFetch";
import { normalizeTitle } from "../core/noteStatus";

type InputKind = "file" | "notion" | "paste";

const INPUT_LABELS: Record<InputKind, string> = {
  file: "보관함 파일",
  notion: "Notion MCP",
  paste: "붙여넣기",
};

export class VerifyPanel {
  private kind: InputKind = "file";
  private fileInput: HTMLInputElement | null = null;
  private notionInput: HTMLInputElement | null = null;
  private notionStatus: HTMLElement | null = null;
  private pasteInput: HTMLTextAreaElement | null = null;
  private targetSelect: HTMLSelectElement | null = null;
  private inputBoxes = new Map<InputKind, HTMLElement>();
  private kindButtons = new Map<InputKind, HTMLButtonElement>();
  private estimateEl: HTMLElement | null = null;
  private notionMarkdown: { url: string; markdown: string } | null = null;
  private controller: AbortController | null = null;
  private busy = false;

  constructor(
    private app: App,
    private plugin: Alt2ObsidianPlugin,
    private root: HTMLElement
  ) {}

  render(): void {
    const root = this.root;
    root.empty();
    root.createDiv({ cls: "alt2obsidian-muted", text: "내 노트를 슬라이드와 전사에 대조합니다. 근거 검색은 스크립트가 하고, 판정만 모델이 합니다. 원본 노트는 바꾸지 않습니다." });

    root.createEl("label", { cls: "alt2obsidian-field-label", text: "입력" });
    const kinds = root.createDiv({ cls: "alt2obsidian-tabs alt2obsidian-verify-kinds" });
    for (const k of Object.keys(INPUT_LABELS) as InputKind[]) {
      const b = kinds.createEl("button", { text: INPUT_LABELS[k], cls: "alt2obsidian-tab" });
      b.addEventListener("click", () => this.setKind(k));
      this.kindButtons.set(k, b);
    }

    // Vault markdown file (default: a Notion page exported as markdown).
    const fileBox = root.createDiv({ cls: "alt2obsidian-verify-input" });
    this.fileInput = fileBox.createEl("input", { type: "text", attr: { list: "alt2obsidian-verify-files", placeholder: "노트 파일 경로 (예: 노션/13강 정리.md)" } });
    const list = fileBox.createEl("datalist", { attr: { id: "alt2obsidian-verify-files" } });
    for (const p of this.plugin.verifySourceFiles()) list.createEl("option", { attr: { value: p } });
    this.fileInput.addEventListener("change", () => this.guessTarget(this.fileInput?.value ?? ""));
    this.inputBoxes.set("file", fileBox);

    // Notion MCP.
    const notionBox = root.createDiv({ cls: "alt2obsidian-verify-input" });
    const row = notionBox.createDiv({ cls: "alt2obsidian-input-row" });
    this.notionInput = row.createEl("input", { type: "text", placeholder: "https://www.notion.so/..." });
    const fetchBtn = row.createEl("button", { text: "가져오기" });
    fetchBtn.addEventListener("click", () => void this.fetchNotion(fetchBtn));
    this.notionStatus = notionBox.createDiv({ cls: "alt2obsidian-muted", text: "Claude CLI의 Notion MCP로 원문 마크다운만 가져옵니다 (호출 1회, 바뀌지 않은 페이지는 캐시 사용)." });
    this.inputBoxes.set("notion", notionBox);

    // Paste.
    const pasteBox = root.createDiv({ cls: "alt2obsidian-verify-input" });
    this.pasteInput = pasteBox.createEl("textarea", { attr: { rows: "6", placeholder: "노트 내용을 붙여넣으세요" } });
    this.inputBoxes.set("paste", pasteBox);

    root.createEl("label", { cls: "alt2obsidian-field-label", text: "대상 강의" });
    this.targetSelect = root.createEl("select", { cls: "dropdown alt2obsidian-verify-target" });
    const targets = this.plugin.verifyTargets();
    if (targets.length === 0) this.targetSelect.createEl("option", { text: "가져온 강의 노트가 없습니다", attr: { value: "" } });
    for (const t of targets) this.targetSelect.createEl("option", { text: `${t.subject ? t.subject + " · " : ""}${t.title}`, attr: { value: t.path } });

    const actions = root.createDiv({ cls: "alt2obsidian-estimate-actions" });
    const estimateBtn = actions.createEl("button", { text: "예상 사용량 보기", cls: "mod-cta" });
    estimateBtn.addEventListener("click", () => void this.prepare(estimateBtn));
    this.estimateEl = root.createDiv({ cls: "alt2obsidian-cli-panel" });
    this.estimateEl.hide();
    this.setKind(this.kind);
  }

  private setKind(kind: InputKind): void {
    this.kind = kind;
    for (const [k, b] of this.kindButtons) b.toggleClass("is-active", k === kind);
    for (const [k, box] of this.inputBoxes) box.toggle(k === kind);
  }

  /** Target lecture whose title matches the chosen file name, when there is one. */
  private guessTarget(path: string): void {
    if (!this.targetSelect) return;
    const stem = normalizeTitle(path.split("/").pop()?.replace(/\.md$/, "") ?? "");
    if (!stem) return;
    const hit = this.plugin.verifyTargets().find((t) => {
      const title = normalizeTitle(t.title);
      return title.length > 0 && (stem.includes(title) || title.includes(stem));
    });
    if (hit) this.targetSelect.value = hit.path;
  }

  private async fetchNotion(btn: HTMLButtonElement): Promise<void> {
    const url = this.notionInput?.value.trim() ?? "";
    if (!url || !this.notionStatus) return;
    btn.disabled = true;
    this.notionStatus.setText("Notion에서 가져오는 중...");
    try {
      const res = await this.plugin.fetchNotionMarkdown(url);
      this.notionMarkdown = { url, markdown: res.markdown };
      this.notionStatus.setText(
        `${res.fromCache ? "바뀌지 않아 캐시를 썼습니다" : "가져왔습니다"}: ${res.markdown.length.toLocaleString()}자` + (res.lastEdited ? ` · 마지막 수정 ${res.lastEdited}` : "")
      );
    } catch (e) {
      this.notionMarkdown = null;
      this.notionStatus.empty();
      const box = this.notionStatus.createDiv({ cls: e instanceof NotionMcpMissingError ? "alt2obsidian-link-offer" : "alt2obsidian-error" });
      box.setText(e instanceof Error ? e.message : String(e));
      if (e instanceof NotionMcpMissingError) {
        const fallback = box.createEl("button", { text: "보관함 파일로 검증" });
        fallback.addEventListener("click", () => this.setKind("file"));
      }
    } finally {
      btn.disabled = false;
    }
  }

  /** The checked note's markdown and how the result names it. */
  private async readSource(): Promise<{ markdown: string; source: string; sourcePath?: string }> {
    if (this.kind === "paste") return { markdown: this.pasteInput?.value ?? "", source: "붙여넣기" };
    if (this.kind === "notion") {
      const url = this.notionInput?.value.trim() ?? "";
      if (!this.notionMarkdown || this.notionMarkdown.url !== url) throw new Error("먼저 '가져오기'로 노션 페이지를 가져오세요.");
      return { markdown: this.notionMarkdown.markdown, source: url };
    }
    const path = this.fileInput?.value.trim() ?? "";
    const content = path ? await this.plugin.vaultManager?.readNoteIfExists(path) : null;
    if (content === null || content === undefined) throw new Error(`노트 파일을 찾지 못했습니다: ${path || "(비어 있음)"}`);
    return { markdown: content, source: `[[${path.replace(/\.md$/, "")}]]`, sourcePath: path };
  }

  private async prepare(btn: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    const panel = this.estimateEl!;
    btn.disabled = true;
    panel.empty();
    panel.show();
    panel.createDiv({ cls: "alt2obsidian-progress-text", text: "주장 나누고 근거 찾는 중 (토큰 0)..." });
    try {
      const src = await this.readSource();
      const targetPath = this.targetSelect?.value ?? "";
      if (!targetPath) throw new Error("대상 강의를 고르세요.");
      const prepared = await this.plugin.prepareVerification({ targetPath, ...src });
      this.showEstimate(prepared);
    } catch (e) {
      panel.empty();
      panel.createDiv({ cls: "alt2obsidian-error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      btn.disabled = false;
    }
  }

  private showEstimate(prepared: PreparedVerification): void {
    const panel = this.estimateEl!;
    panel.empty();
    const e = prepared.estimate;
    const task = this.plugin.data.settings.tasks.verification;
    panel.createEl("h6", { text: "검증 전 예상 사용량", cls: "alt2obsidian-section-header" });
    panel.createDiv({ cls: "alt2obsidian-estimate-main", text: `주장 ${e.claims}개 → 판정 ${e.judged}개` });
    const rows = panel.createEl("ul", { cls: "alt2obsidian-estimate-list" });
    rows.createEl("li", { text: `근거 검색 (스크립트): 토큰 0 · 슬라이드 상위 2개${prepared.plan.hasTranscript ? ", 전사 상위 2개" : " (전사 없음)"}` });
    if (e.scriptOnly > 0) rows.createEl("li", { text: `겹치는 용어가 없는 ${e.scriptOnly}개는 호출 없이 '근거 없음'` });
    if (e.likelyTrue > 0) rows.createEl("li", { text: `맞음 후보 ${e.likelyTrue}개는 묶음 뒤쪽에서 판정` });
    rows.createEl("li", { text: `누락 확인: 주장과 이어지지 않은 슬라이드 ${e.uncoveredSlides}장${e.uncoveredSlides > 0 ? " (제목과 핵심 문장만, 1회)" : ""}` });
    rows.createEl("li", { text: `예상: 호출 ${e.calls}회 · 입력 약 ${compactTokens(e.inputTokens)} · 출력 약 ${compactTokens(e.outputTokens)} 토큰` });
    rows.createEl("li", { text: `판정: ${PROVIDER_LABELS[task.provider]} (${task.model || "기본 모델"}${task.effort ? ", " + task.effort : ""})` });
    rows.createEl("li", { text: `결과: ${prepared.outPath}` });
    if (prepared.overCap) panel.createDiv({ cls: "alt2obsidian-error", text: "강의당 토큰 상한을 넘을 것 같습니다. 한 번 더 누르면 그래도 시작합니다." });
    const actions = panel.createDiv({ cls: "alt2obsidian-estimate-actions" });
    const run = actions.createEl("button", { text: "검증 실행", cls: "mod-cta" });
    let armed = !prepared.overCap;
    run.disabled = e.calls === 0 && e.claims === 0;
    run.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        run.addClass("mod-warning");
        return;
      }
      void this.run(prepared);
    });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => {
      panel.empty();
      panel.hide();
    });
  }

  private async run(prepared: PreparedVerification): Promise<void> {
    const panel = this.estimateEl!;
    panel.empty();
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    panel.createEl("h6", { text: "검증 중", cls: "alt2obsidian-section-header" });
    const barOuter = panel.createDiv({ cls: "alt2obsidian-progress-bar" });
    const bar = barOuter.createDiv({ cls: "alt2obsidian-progress-bar-fill" });
    const detail = panel.createDiv({ cls: "alt2obsidian-progress-text", text: "판정 시작" });
    const usage = panel.createDiv({ cls: "alt2obsidian-usage-line", text: "사용량: 아직 호출 없음" });
    const cancel = panel.createEl("button", { text: "취소", cls: "alt2obsidian-cancel-btn" });
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      controller.abort();
    });
    try {
      const res = await this.plugin.runVerification(prepared, {
        signal: controller.signal,
        onProgress: (p) => {
          bar.style.width = `${Math.round((p.judged / Math.max(1, p.total)) * 100)}%`;
          detail.setText(p.step === "missing" ? "누락 후보 확인 중" : p.retry ? `묶음 ${p.batch}/${p.batches}: 빠진 주장만 다시 요청 중` : `묶음 ${p.batch}/${p.batches} 판정 중`);
        },
        onUsage: (u) => usage.setText(`호출 ${u.calls}회 · 입력 ${compactTokens(u.inputTokens)} (캐시 ${compactTokens(u.cachedInputTokens)}) · 출력 ${compactTokens(u.outputTokens)}`),
      });
      panel.empty();
      const c = res.counts;
      panel.createEl("h6", { text: "검증 결과", cls: "alt2obsidian-section-header" });
      const counts = panel.createDiv({ cls: "alt2obsidian-verify-counts" });
      for (const [label, n, cls] of [
        ["맞음", c["맞음"], "is-ok"],
        ["틀림", c["틀림"], "is-bad"],
        ["근거 없음", c["근거 없음"], "is-none"],
        ["전사 불확실", c["전사 불확실"], "is-unsure"],
        ["누락 후보", c.missing, "is-missing"],
      ] as Array<[string, number, string]>) {
        const chip = counts.createSpan({ cls: `alt2obsidian-chip ${cls}` });
        chip.setText(`${label} ${n}`);
      }
      for (const w of res.warnings) panel.createDiv({ cls: "alt2obsidian-muted", text: w });
      const open = panel.createEl("button", { cls: "mod-cta" });
      setIcon(open.createSpan(), "file-check");
      open.appendText(" 결과 노트 열기");
      open.addEventListener("click", () => this.app.workspace.openLinkText(res.path, "", false));
    } catch (e) {
      panel.empty();
      panel.createDiv({ cls: "alt2obsidian-error", text: controller.signal.aborted ? "검증을 취소했습니다. 결과 노트는 바뀌지 않았습니다." : e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  isBusy(): boolean {
    return this.busy;
  }

  abort(): void {
    this.controller?.abort();
  }
}
