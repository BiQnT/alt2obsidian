// Sidebar tab "노트 검증" (spec 4.6, mockup "5. 노트 검증 (노션 대조)"):
// input choice (vault markdown file, Notion MCP, paste), target lecture,
// a pre-run estimate (claims -> judged, retrieval by script at 0 tokens,
// expected tokens), run with progress and cancel, then the result counts
// and a link to the verification note.

import { App, setIcon } from "obsidian";
import type Alt2ObsPlugin from "../main";
import type { PreparedVerification } from "../main";
import { compactTokens } from "../llm/usage";
import { describeEffort, describeModel } from "../settings/llmSettings";
import { renderModelPicker } from "./modelPicker";
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
  private fileList: HTMLElement | null = null;
  private inputBoxes = new Map<InputKind, HTMLElement>();
  private kindButtons = new Map<InputKind, HTMLButtonElement>();
  private estimateEl: HTMLElement | null = null;
  private notionMarkdown: { url: string; markdown: string } | null = null;
  private controller: AbortController | null = null;
  private notionController: AbortController | null = null;
  private busy = false;

  constructor(
    private app: App,
    private plugin: Alt2ObsPlugin,
    private root: HTMLElement
  ) {}

  render(): void {
    const root = this.root;
    root.empty();
    root.createDiv({ cls: "alt2obs-muted", text: "내 노트를 슬라이드와 전사에 대조합니다. 근거 검색은 스크립트가 하고, 판정만 모델이 합니다. 원본 노트는 바꾸지 않습니다." });

    root.createEl("label", { cls: "alt2obs-field-label", text: "입력" });
    const kinds = root.createDiv({ cls: "alt2obs-tabs alt2obs-verify-kinds" });
    for (const k of Object.keys(INPUT_LABELS) as InputKind[]) {
      const b = kinds.createEl("button", { text: INPUT_LABELS[k], cls: "alt2obs-tab" });
      b.addEventListener("click", () => this.setKind(k));
      this.kindButtons.set(k, b);
    }

    // Vault markdown file (default: a Notion page exported as markdown).
    const fileBox = root.createDiv({ cls: "alt2obs-verify-input" });
    this.fileInput = fileBox.createEl("input", { type: "text", attr: { list: "alt2obs-verify-files", placeholder: "노트 파일 경로 (예: 노션/13강 정리.md)" } });
    this.fileList = fileBox.createEl("datalist", { attr: { id: "alt2obs-verify-files" } });
    this.fileInput.addEventListener("change", () => this.guessTarget(this.fileInput?.value ?? ""));
    this.inputBoxes.set("file", fileBox);

    // Notion MCP.
    const notionBox = root.createDiv({ cls: "alt2obs-verify-input" });
    const row = notionBox.createDiv({ cls: "alt2obs-input-row" });
    this.notionInput = row.createEl("input", { type: "text", placeholder: "https://www.notion.so/..." });
    const fetchBtn = row.createEl("button", { text: "가져오기" });
    fetchBtn.addEventListener("click", () => void this.fetchNotion(fetchBtn));
    const nm = this.plugin.notionFetchModel();
    this.notionStatus = notionBox.createDiv({
      cls: "alt2obs-muted",
      text: `Claude CLI가 Notion 조회 도구 하나만 불러 페이지 원문을 가져옵니다 (호출 1회, 내용은 도구 결과를 그대로 씀). 모델: ${describeModel("claude-cli", nm.model, this.plugin.modelCatalog())} · ${describeEffort(nm.effort)}.`,
    });
    this.inputBoxes.set("notion", notionBox);

    // Paste.
    const pasteBox = root.createDiv({ cls: "alt2obs-verify-input" });
    this.pasteInput = pasteBox.createEl("textarea", { attr: { rows: "6", placeholder: "노트 내용을 붙여넣으세요" } });
    this.inputBoxes.set("paste", pasteBox);

    root.createEl("label", { cls: "alt2obs-field-label", text: "대상 강의" });
    this.targetSelect = root.createEl("select", { cls: "dropdown alt2obs-verify-target" });
    this.refreshLists();

    const actions = root.createDiv({ cls: "alt2obs-estimate-actions" });
    const estimateBtn = actions.createEl("button", { text: "예상 사용량 보기", cls: "mod-cta" });
    estimateBtn.addEventListener("click", () => void this.prepare(estimateBtn));
    this.estimateEl = root.createDiv({ cls: "alt2obs-cli-panel" });
    this.estimateEl.hide();
    this.setKind(this.kind);
  }

  /** Vault files and lecture notes may change while the tab is hidden: rebuild the choices, keep the inputs. */
  refreshLists(): void {
    if (this.fileList) {
      this.fileList.empty();
      for (const p of this.plugin.verifySourceFiles()) this.fileList.createEl("option", { attr: { value: p } });
    }
    const select = this.targetSelect;
    if (!select) return;
    const current = select.value;
    select.empty();
    const targets = this.plugin.verifyTargets();
    if (targets.length === 0) select.createEl("option", { text: "가져온 강의 노트가 없습니다", attr: { value: "" } });
    for (const t of targets) select.createEl("option", { text: `${t.subject ? t.subject + " · " : ""}${t.title}${t.kind === "transcript" ? " (전사 요약)" : ""}`, attr: { value: t.path } });
    if (targets.some((t) => t.path === current)) select.value = current;
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
    // The fetch button becomes a cancel button while the call runs.
    if (this.notionController) {
      this.notionController.abort();
      return;
    }
    const controller = new AbortController();
    this.notionController = controller;
    btn.setText("취소");
    this.notionStatus.setText("Notion에서 가져오는 중...");
    try {
      const res = await this.plugin.fetchNotionMarkdown(url, controller.signal);
      this.notionMarkdown = { url, markdown: res.markdown };
      this.notionStatus.empty();
      this.notionStatus.createDiv({
        text:
          `가져왔습니다: ${res.markdown.length.toLocaleString()}자` +
          (res.lastEdited ? ` · 마지막 수정 ${res.lastEdited}` : "") +
          (res.unchanged ? " · 지난번과 같은 페이지" : "") +
          (res.model ? ` · 모델 ${res.model}` : ""),
      });
      for (const w of res.warnings) this.notionStatus.createDiv({ cls: "alt2obs-error", text: w });
    } catch (e) {
      this.notionMarkdown = null;
      this.notionStatus.empty();
      if (controller.signal.aborted) {
        this.notionStatus.setText("가져오기를 취소했습니다.");
        return;
      }
      const box = this.notionStatus.createDiv({ cls: e instanceof NotionMcpMissingError ? "alt2obs-link-offer" : "alt2obs-error" });
      box.setText(e instanceof Error ? e.message : String(e));
      if (e instanceof NotionMcpMissingError) {
        const fallback = box.createEl("button", { text: "보관함 파일로 검증" });
        fallback.addEventListener("click", () => this.setKind("file"));
      }
    } finally {
      this.notionController = null;
      btn.setText("가져오기");
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
    panel.createDiv({ cls: "alt2obs-progress-text", text: "주장 나누고 근거 찾는 중 (토큰 0)..." });
    try {
      const src = await this.readSource();
      const targetPath = this.targetSelect?.value ?? "";
      if (!targetPath) throw new Error("대상 강의를 고르세요.");
      const prepared = await this.plugin.prepareVerification({ targetPath, ...src });
      this.showEstimate(prepared);
    } catch (e) {
      panel.empty();
      panel.createDiv({ cls: "alt2obs-error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * Estimate with the verification model of this run: it can be changed
   * here for this run only (the estimate follows); "기본값으로 저장" makes
   * it the saved setting.
   */
  private showEstimate(prepared: PreparedVerification): void {
    const panel = this.estimateEl!;
    // The picker that changed keeps the keyboard focus across the redraw.
    const active = panel.ownerDocument.activeElement as HTMLElement | null;
    const focused = active && panel.contains(active) ? active.getAttribute("aria-label") : null;
    panel.empty();
    const e = prepared.estimate;
    const settings = this.plugin.data.settings;
    panel.createEl("h6", { text: "검증 전 예상 사용량", cls: "alt2obs-section-header" });
    panel.createDiv({ cls: "alt2obs-estimate-main", text: `주장 ${e.claims}개 → 판정 ${e.judged}개 · 입력 약 ${compactTokens(e.inputTokens)} · 출력 약 ${compactTokens(e.outputTokens)} 토큰` });
    renderModelPicker(panel.createDiv({ cls: "alt2obs-pickers" }), {
      task: "verification",
      label: "판정 모델",
      value: prepared.task,
      saved: settings.tasks.verification,
      catalog: this.plugin.modelCatalog(),
      recent: settings.recentModels,
      onChange: (next) => this.showEstimate(this.plugin.withVerifyChoice(prepared, next)),
      onSaveDefault: (next) => this.plugin.saveTaskDefault("verification", next),
    });
    const rows = panel.createEl("ul", { cls: "alt2obs-estimate-list" });
    const sections = prepared.plan.unit === "section";
    rows.createEl("li", {
      text: sections
        ? "근거 검색 (스크립트): 토큰 0 · 전사 구간 상위 2개 (슬라이드가 없는 강의라 녹음 전사만 근거, 전사 불확실 판정이 늘 수 있음)"
        : `근거 검색 (스크립트): 토큰 0 · 슬라이드 상위 2개${prepared.plan.hasTranscript ? ", 전사 상위 2개" : " (전사 없음)"}`,
    });
    if (e.contextEvidence > 0) rows.createEl("li", { text: `${sections ? "전사" : "슬라이드"}와 겹치는 용어가 없는 ${e.contextEvidence}개는 같은 절의 문맥(주변 주장, 제목)으로 근거 후보를 찾아 판정` });
    if (e.unmatched > 0) rows.createEl("li", { text: `근거 후보를 전혀 찾지 못한 ${e.unmatched}개는 판정하지 않고 결과 노트에 따로 적음` });
    if (e.likelyTrue > 0) rows.createEl("li", { text: `맞음 후보 ${e.likelyTrue}개는 묶음 뒤쪽에서 판정` });
    rows.createEl("li", {
      text: sections
        ? `누락 확인: 주장과 이어지지 않은 구간 ${e.uncoveredSlides}개${e.uncoveredSlides > 0 ? " (구간 요지만, 1회)" : ""}`
        : `누락 확인: 주장과 이어지지 않은 슬라이드 ${e.uncoveredSlides}장${e.uncoveredSlides > 0 ? " (제목과 핵심 문장만, 1회)" : ""}`,
    });
    rows.createEl("li", { text: `예상: 호출 ${e.calls}회 · 입력 약 ${compactTokens(e.inputTokens)} · 출력 약 ${compactTokens(e.outputTokens)} 토큰 (출력은 effort에 따라 늘려 잡음)` });
    rows.createEl("li", { text: `결과: ${prepared.outPath}` });
    if (e.unmatchedWarning) {
      panel.createDiv({
        cls: "alt2obs-error",
        text: `주장의 ${Math.round((e.unmatched / Math.max(1, e.claims)) * 100)}%가 ${sections ? "전사" : "슬라이드"}와 용어가 맞지 않아 근거를 찾지 못했습니다. 대상 강의가 맞는지, 노트에 영어 용어(괄호 병기)가 있는지 확인하세요.`,
      });
    }
    if (prepared.overCap) panel.createDiv({ cls: "alt2obs-error", text: "강의당 토큰 상한을 넘을 것 같습니다. 한 번 더 누르면 그래도 시작합니다." });
    const actions = panel.createDiv({ cls: "alt2obs-estimate-actions" });
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
    if (focused) (panel.querySelector(`select[aria-label="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
  }

  private async run(prepared: PreparedVerification): Promise<void> {
    const panel = this.estimateEl!;
    panel.empty();
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    panel.createEl("h6", { text: "검증 중", cls: "alt2obs-section-header" });
    const barOuter = panel.createDiv({ cls: "alt2obs-progress-bar" });
    const bar = barOuter.createDiv({ cls: "alt2obs-progress-bar-fill" });
    const detail = panel.createDiv({ cls: "alt2obs-progress-text", text: "판정 시작" });
    const t = prepared.task;
    const effort = ` · ${describeEffort(t.effort)}`;
    const modelLine = panel.createDiv({ cls: "alt2obs-usage-line alt2obs-model-line", text: `모델: ${describeModel(t.provider, t.model, this.plugin.modelCatalog())}${effort}` });
    const usage = panel.createDiv({ cls: "alt2obs-usage-line", text: "사용량: 아직 호출 없음" });
    const cancel = panel.createEl("button", { text: "취소", cls: "alt2obs-cancel-btn" });
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
        onModel: (model) => {
          if (model) modelLine.setText(`모델: ${model}${effort} (실제 실행)`);
        },
      });
      panel.empty();
      const c = res.counts;
      panel.createEl("h6", { text: "검증 결과", cls: "alt2obs-section-header" });
      const counts = panel.createDiv({ cls: "alt2obs-verify-counts" });
      for (const [label, n, cls] of [
        ["맞음", c["맞음"], "is-ok"],
        ["틀림", c["틀림"], "is-bad"],
        ["근거 없음", c["근거 없음"], "is-none"],
        ["전사 불확실", c["전사 불확실"], "is-unsure"],
        ["누락 후보", c.missing, "is-missing"],
      ] as Array<[string, number, string]>) {
        const chip = counts.createSpan({ cls: `alt2obs-chip ${cls}` });
        chip.setText(`${label} ${n}`);
      }
      for (const w of res.warnings) panel.createDiv({ cls: "alt2obs-muted", text: w });
      const open = panel.createEl("button", { cls: "mod-cta" });
      setIcon(open.createSpan(), "file-check");
      open.appendText(" 결과 노트 열기");
      open.addEventListener("click", () => this.app.workspace.openLinkText(res.path, "", false));
    } catch (e) {
      panel.empty();
      panel.createDiv({ cls: "alt2obs-error", text: controller.signal.aborted ? "검증을 취소했습니다. 결과 노트는 바뀌지 않았습니다." : e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  abort(): void {
    this.controller?.abort();
    this.notionController?.abort();
  }
}
