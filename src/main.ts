import { Plugin, Notice } from "obsidian";
import {
  PluginData,
  DEFAULT_PLUGIN_DATA,
  ImportRecord,
  ImportPreview,
  LLMProvider as ILLMProvider,
  ExamPeriod,
  ConceptData,
  ImportUpdateSummary,
  LectureMaterialContext,
  CliDetection,
  CliName,
  LLMUsage,
  ProviderId,
  TaskId,
} from "./types";
import { AltScraper } from "./scraper/AltScraper";
import { PdfProcessor } from "./pdf/PdfProcessor";
import { createTaskProvider } from "./llm/index";
import {
  cliNotFoundMessage,
  CliRunError,
  createJobDir,
  probeCliLogin,
  isExecutable,
  readCliVersion,
  removeJobDir,
  resolveCliBinary,
} from "./llm/cli/CliRunner";
import { UsageTracker, accumulateTotals, formatUsageFrontmatter } from "./llm/usage";
import {
  applyClaudeDefaults,
  batchSizeFor,
  cliDefaultAction,
  isCliProvider,
  migrateSettings,
  PROVIDER_LABELS,
  rememberModel,
} from "./settings/llmSettings";
import { analyzeSlides } from "./core/prep/SlideAnalyzer";
import { DeckPlan, parseExistingSlides, planDeck, withFewerImages } from "./pipeline/batchPlan";
import { estimateLecture, PipelineStep, runBatchedLecture } from "./pipeline/lecturePipeline";
import type { BatchProgress, LectureContext } from "./generator/BatchCommentaryGenerator";
import { BudgetEstimate, CallShape, estimateCalls, exceedsCap } from "./core/budget/estimate";
import conceptExtractionTemplateText from "../prompts/concept-extraction.md";
import { ConceptExtractor } from "./generator/ConceptExtractor";
import { NoteGenerator } from "./generator/NoteGenerator";
import { PerSlideCommentaryGenerator } from "./generator/PerSlideCommentaryGenerator";
import type { PerSlideGenerationResult } from "./types";
import { ExamSummaryGenerator } from "./generator/ExamSummaryGenerator";
import { VaultManager } from "./vault/VaultManager";
import { Alt2ObsidianSettingsTab } from "./ui/SettingsTab";
import {
  Alt2ObsidianSidebarView,
  VIEW_TYPE_SIDEBAR,
} from "./ui/SidebarView";
import {
  SyncedViewerView,
  VIEW_TYPE_SYNCED_VIEWER,
} from "./ui/SyncedViewerView";
import { TFile } from "obsidian";
import { sanitizeFilename, formatDate } from "./utils/helpers";
import { renderPrompt } from "./prompts/render";
import summaryFromTranscriptTemplate from "../prompts/summary-from-transcript.md";
import summaryFromTranscriptSystemTemplate from "../prompts/summary-from-transcript.system.md";
import summaryEnhanceTranscriptTemplate from "../prompts/summary-enhance-transcript.md";
import summaryEnhanceTranscriptSystemTemplate from "../prompts/summary-enhance-transcript.system.md";
import summaryEnhanceMaterialTemplate from "../prompts/summary-enhance-material.md";
import summaryEnhanceMaterialSystemTemplate from "../prompts/summary-enhance-material.system.md";
import summaryFromMaterialTemplate from "../prompts/summary-from-material.md";
import summaryFromMaterialSystemTemplate from "../prompts/summary-from-material.system.md";
import subjectDetectionTemplate from "../prompts/subject-detection.md";

/** A CLI import after prep and estimate, before any LLM call. */
export interface PreparedImport {
  url: string;
  preview: ImportPreview;
  subject: string;
  examPeriod?: ExamPeriod;
  notePath: string;
  pdfData: ArrayBuffer | null;
  /** null: no PDF, the lecture-level flow runs instead. */
  plan: DeckPlan | null;
  context: LectureContext;
  estimate: BudgetEstimate;
  overCap: boolean;
  fewerImages: boolean;
}

export interface CliImportHooks {
  signal?: AbortSignal;
  onStep?: (step: PipelineStep | "save") => void;
  onBatch?: (p: BatchProgress) => void;
  onUsage?: (total: LLMUsage) => void;
  onProgress?: (stage: string, percent: number) => void;
  onConfirmUpdate?: (summary: ImportUpdateSummary) => Promise<boolean>;
}

export default class Alt2ObsidianPlugin extends Plugin {
  data: PluginData = DEFAULT_PLUGIN_DATA;
  vaultManager: VaultManager | null = null;

  private scraper = new AltScraper();
  private pdfProcessor: PdfProcessor | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    // Initialize vault manager
    this.vaultManager = new VaultManager(
      this.app,
      this.data.settings.baseFolderPath
    );

    // Resolve the pdfjs worker via Obsidian's resource-path machinery so it
    // becomes an `app://local/...` URL the renderer can actually fetch.
    // Raw filesystem paths get prepended to `app://obsidian.md/` and fail.
    const workerVaultPath = `${this.manifest.dir}/pdf.worker.min.mjs`;
    const workerSrc =
      (this.app.vault.adapter as any).getResourcePath?.(workerVaultPath) ||
      workerVaultPath;
    this.pdfProcessor = new PdfProcessor(workerSrc);

    // Register sidebar view
    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
      return new Alt2ObsidianSidebarView(leaf, this);
    });

    // Register Synced Viewer (Task 1.5 — A2 default)
    this.registerView(VIEW_TYPE_SYNCED_VIEWER, (leaf) => {
      return new SyncedViewerView(leaf);
    });

    // Add ribbon icon
    this.addRibbonIcon("book-open", "Alt2Obsidian", () => {
      this.activateSidebarView();
    });

    // Add command
    this.addCommand({
      id: "open-sidebar",
      name: "Open Alt2Obsidian sidebar",
      callback: () => this.activateSidebarView(),
    });

    this.addCommand({
      id: "import-note",
      name: "Import Alt note from URL",
      callback: () => this.activateSidebarView(),
    });

    this.addCommand({
      id: "open-synced-viewer",
      name: "Open Synced Viewer (PDF + lecture .md)",
      callback: () => this.openSyncedViewerForActiveNote(),
    });

    // Register settings tab
    this.addSettingTab(new Alt2ObsidianSettingsTab(this.app, this));

    // The login-shell lookup can take a moment: run it after startup.
    this.app.workspace.onLayoutReady(() => {
      this.applyCliDefaultOnce().catch((e) => console.warn("[Alt2Obsidian] CLI default check failed:", e));
    });
  }

  onunload(): void {
    // Kill running CLI processes; their finally blocks remove the temp folders.
    this.abortAllJobs();
  }

  /**
   * Resolve the active note's sibling PDF and open both in the Synced
   * Viewer (Task 1.5). PDF is expected at `{same-folder}/{same-stem}.pdf`
   * (Task 1.4 sibling layout). If the active file isn't a markdown note or
   * has no sibling PDF, surface a Notice and bail.
   */
  async openSyncedViewerForActiveNote(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== "md") {
      new Notice("강의 노트(.md)를 활성화한 뒤 다시 시도하세요.");
      return;
    }
    const pdfPath = active.path.replace(/\.md$/, ".pdf");
    const pdfFile = this.app.vault.getAbstractFileByPath(pdfPath);
    if (!(pdfFile instanceof TFile)) {
      new Notice(
        `사이블링 PDF가 없습니다: ${pdfPath} — 강의를 import하면 PDF가 함께 저장됩니다.`
      );
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_SYNCED_VIEWER,
      active: true,
      state: { mdPath: active.path, pdfPath },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  updateBasePath(): void {
    this.vaultManager?.setBasePath(this.data.settings.baseFolderPath);
  }

  /**
   * Phase 1: Preview — scrape page and defer PDF download until import.
   */
  async previewImport(
    url: string,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<ImportPreview> {
    onProgress?.("Alt 노트 페이지 가져오는 중...", 10);
    const altData = await this.scraper.fetch(url);
    onProgress?.("Alt 노트 파싱 완료", 30);

    // Quick subject detection from title
    const codeMatch = altData.title.match(/([A-Z]{2,}[\s-]?\d{2,})/i);
    const suggestedSubject = codeMatch
      ? codeMatch[1].replace(/\s+/g, "").toUpperCase()
      : altData.title.split(/[\s-_]/)[0];

    onProgress?.("미리보기 준비 완료", 100);

    return {
      altData,
      pdfData: null,
      pdfUrl: altData.pdfUrl,
      suggestedSubject,
    };
  }

  /** True when slide commentary runs on a CLI provider (batched 2.0 path). */
  isCliCommentary(): boolean {
    return isCliProvider(this.data.settings.tasks.commentary.provider);
  }

  /**
   * Phase 2: Import with the Gemini/Ollama per-slide path (1.x flow,
   * unchanged prompts).
   */
  async importNote(
    url: string,
    preview: ImportPreview,
    subjectOverride?: string,
    examPeriod?: ExamPeriod,
    onProgress?: (stage: string, percent: number) => void,
    onConfirmUpdate?: (summary: ImportUpdateSummary) => Promise<boolean>
  ): Promise<ImportRecord> {
    const settings = this.data.settings;
    if (settings.tasks.commentary.provider === "gemini" && !settings.apiKey) {
      throw new Error("API 키를 설정에서 입력해주세요");
    }
    const job = createJobDir();
    const usage = new UsageTracker();
    try {
      const llm = await this.providerFor("commentary", job, usage);
      const conceptLlm = await this.providerFor("concepts", job, usage);
      return await this.runLegacyImport(url, preview, subjectOverride, examPeriod, llm, conceptLlm, onProgress, onConfirmUpdate);
    } finally {
      removeJobDir(job);
    }
  }

  private async providerFor(
    task: TaskId,
    workDir: string,
    usage: UsageTracker,
    signal?: AbortSignal
  ): Promise<ILLMProvider> {
    return createTaskProvider(this.data.settings.tasks[task], {
      settings: this.data.settings,
      resolveBin: (name) => this.resolveBin(name),
      workDir,
      usage,
      signal,
      task,
    });
  }

  private async runLegacyImport(
    url: string,
    preview: ImportPreview,
    subjectOverride: string | undefined,
    examPeriod: ExamPeriod | undefined,
    llm: ILLMProvider,
    conceptLlm: ILLMProvider,
    onProgress?: (stage: string, percent: number) => void,
    onConfirmUpdate?: (summary: ImportUpdateSummary) => Promise<boolean>,
    signal?: AbortSignal
  ): Promise<ImportRecord> {
    const altData = preview.altData;
    const pdfDataPromise = this.downloadPdfForImport(preview);
    const materialContextPromise = this.extractLectureMaterialContext(
      pdfDataPromise,
      `${altData.title}\n\n${altData.summary}`,
      onProgress
    );

    // For partial quality, skip LLM processing
    if (altData.parseQuality === "partial") {
      const subject = subjectOverride || "Unknown";
      return this.savePartialNote(
        altData,
        subject,
        url,
        llm,
        pdfDataPromise,
        materialContextPromise,
        onProgress,
        onConfirmUpdate,
        signal
      );
    }

    // Enhance summary with transcript if available
    if (altData.transcript) {
      const transcriptText = altData.transcript.slice(0, 15000);
      const summaryTooShort = !altData.summary || altData.summary.length < 500;
      const summaryAlreadyDetailed = altData.summary.length >= 2500;

      if (summaryTooShort) {
        onProgress?.("트랜스크립트에서 강의 노트 생성 중...", 10);
        const memoContext = altData.summary
          ? `\n\n[학생 메모]\n${altData.summary}`
          : "";

        altData.summary = await llm.generateText(
          renderPrompt(summaryFromTranscriptTemplate, {
            memoContext,
            transcript: transcriptText,
          }),
          {
            systemPrompt: renderPrompt(summaryFromTranscriptSystemTemplate, {}),
            maxOutputTokens: 4096,
          }
        );
      } else if (!summaryAlreadyDetailed) {
        onProgress?.("트랜스크립트로 요약 보강 중...", 10);

        altData.summary = await llm.generateText(
          renderPrompt(summaryEnhanceTranscriptTemplate, {
            summary: altData.summary,
            transcript: transcriptText,
          }),
          {
            systemPrompt: renderPrompt(summaryEnhanceTranscriptSystemTemplate, {}),
            maxOutputTokens: 8192,
          }
        );
      } else {
        onProgress?.("기존 요약이 충분해 보강 호출을 건너뜁니다...", 10);
      }
    }

    const materialContext = await materialContextPromise;
    if (materialContext) {
      onProgress?.("강의자료를 반영해 노트 보강 중...", 25);
      altData.summary = await this.enhanceSummaryWithLectureMaterial(
        llm,
        altData.summary,
        materialContext
      );
    }

    onProgress?.("LLM으로 개념 추출 중...", 30);

    // LLM: Extract concepts + detect subject. Inject the user's `language`
    // setting so Korean lectures don't get English concept fields (the older
    // prompt didn't pass language, which surfaced English concepts in the
    // user's CSED232 vault despite `language: "ko"`).
    const conceptExtractor = new ConceptExtractor(conceptLlm, this.data.settings.language);
    const subject = subjectOverride || preview.suggestedSubject;
    const vm = this.vaultManager!;
    const existingConceptNames = await vm.getExistingConceptNames(subject);

    const conceptResult = await conceptExtractor.extract(
      altData.summary,
      subject,
      Array.from(existingConceptNames)
    );
    conceptResult.concepts = this.normalizeConcepts(
      conceptResult.concepts,
      existingConceptNames
    );

    onProgress?.("개념 추출 완료", 50);

    // Per-slide commentary (page-anchored path) when PDF is available.
    // If the PDF is missing OR per-slide generation fails entirely,
    // slidesResult stays null and we fall back to the lecture-level
    // single-block generator below.
    const pdfData = await pdfDataPromise;
    let slidesResult: PerSlideGenerationResult | null = null;
    if (pdfData && this.pdfProcessor) {
      onProgress?.("PDF 슬라이드 해설 생성 중...", 55);
      const slideGen = new PerSlideCommentaryGenerator(llm, this.pdfProcessor);
      try {
        slidesResult = await slideGen.generate(pdfData, {
          transcript: altData.transcript,
          existingConceptNames: Array.from(existingConceptNames),
          sourceId: altData.metadata.noteId,
          onProgress: (slideNum, total) => {
            onProgress?.(
              `슬라이드 ${slideNum}/${total} 해설 중...`,
              55 + Math.round((slideNum / total) * 15)
            );
          },
        });
      } catch (e) {
        console.warn(
          "[Alt2Obsidian] per-slide gen failed, falling back to lecture-level:",
          e
        );
      }
    }

    // Generate markdown
    onProgress?.("마크다운 노트 생성 중...", 70);

    const llmResult = {
      processedSummary: altData.summary,
      concepts: conceptResult.concepts,
      tags: examPeriod ? [...conceptResult.tags, examPeriod] : conceptResult.tags,
      subjectSuggestion: subject,
    };

    const noteGenerator = new NoteGenerator(llm);
    const { lectureMarkdown, conceptNotes } =
      slidesResult && slidesResult.slides.length > 0
        ? await noteGenerator.generatePageAnchored(
            altData,
            slidesResult,
            llmResult,
            subject
          )
        : await noteGenerator.generate(altData, llmResult, subject);

    return this.saveLecture({
      url,
      altData,
      subject,
      examPeriod,
      lectureMarkdown,
      conceptNotes,
      pdfData,
      onProgress,
      onConfirmUpdate,
      signal,
    });
  }

  /** Writes the lecture note, concept notes and PDF, and records the import. */
  private async saveLecture(args: {
    url: string;
    altData: import("./types").AltNoteData;
    subject: string;
    examPeriod?: ExamPeriod;
    lectureMarkdown: string;
    conceptNotes: import("./types").ConceptNote[];
    pdfData: ArrayBuffer | null;
    onProgress?: (stage: string, percent: number) => void;
    onConfirmUpdate?: (summary: ImportUpdateSummary) => Promise<boolean>;
    /** A cancelled import must not write anything. */
    signal?: AbortSignal;
  }): Promise<ImportRecord> {
    const { url, altData, subject, examPeriod, lectureMarkdown, conceptNotes, pdfData, onProgress, onConfirmUpdate, signal } = args;
    const vm = this.vaultManager!;
    // Save everything to vault
    onProgress?.("Vault에 저장 중...", 90);

    const subjectFolder = `${vm.getBasePath()}/${sanitizeFilename(subject)}`;

    const noteFilename = sanitizeFilename(altData.title);
    const notePath = `${subjectFolder}/${noteFilename}.md`;
    const updateSummary = await vm.buildManagedNoteUpdateSummary(
      notePath,
      lectureMarkdown,
      conceptNotes.map((concept) => concept.name)
    );
    if (updateSummary.isUpdate && onConfirmUpdate) {
      const confirmed = await onConfirmUpdate(updateSummary);
      if (!confirmed) throw new Error("업데이트가 취소되었습니다");
      onProgress?.("Vault에 저장 중...", 90);
    }

    if (signal?.aborted) throw new CliRunError("aborted", "취소되었습니다");
    const saveResult = await vm.saveManagedNote(lectureMarkdown, notePath);
    await vm.saveConceptNotes(conceptNotes, noteFilename, subject);

    // Save raw PDF to vault for side-by-side view
    let pdfPath: string | undefined;
    if (pdfData) {
      onProgress?.("PDF 저장 중...", 95);
      const pdfFilename = sanitizeFilename(altData.title);
      const rawPdfPath = `${subjectFolder}/${pdfFilename}.pdf`;
      pdfPath = await vm.saveRawFile(pdfData, rawPdfPath);
    }

    onProgress?.("완료!", 100);

    const record: ImportRecord = {
      url,
      title: altData.title,
      subject,
      path: notePath,
      date: formatDate(),
      parseQuality: "full",
      altId: altData.metadata.noteId || undefined,
      examPeriod,
      pdfPath,
      wasUpdate: saveResult.wasUpdate,
      updateSummary,
    };
    record.wasUpdate = this.upsertRecentImport(record) || saveResult.wasUpdate;
    await this.savePluginData();

    return record;
  }

  // ---- 2.0 CLI path: prepare (no tokens) -> estimate -> run ----

  /**
   * Download and analyze the deck, plan the batches and estimate the tokens
   * (spec 5.1 to 5.5). Nothing is sent to an LLM here.
   */
  async prepareCliImport(
    url: string,
    preview: ImportPreview,
    subjectOverride: string | undefined,
    examPeriod: ExamPeriod | undefined,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<PreparedImport> {
    const settings = this.data.settings;
    // Fail before any work when a configured CLI cannot be found.
    for (const task of ["commentary", "concepts"] as TaskId[]) {
      const p = settings.tasks[task].provider;
      if (p === "claude-cli") await this.resolveBin("claude");
      if (p === "codex-cli") await this.resolveBin("codex");
    }
    const subject = subjectOverride || preview.suggestedSubject;
    const vm = this.vaultManager!;
    const altData = preview.altData;
    const notePath = `${vm.getBasePath()}/${sanitizeFilename(subject)}/${sanitizeFilename(altData.title)}.md`;
    const context: LectureContext = {
      title: altData.title,
      subjectTags: vm.getSubjectTags(subject),
      knownConcepts: Array.from(await vm.getExistingConceptNames(subject)),
    };

    onProgress?.("PDF 내려받는 중...", 10);
    const pdfData = altData.parseQuality === "partial" ? null : await this.downloadPdfForImport(preview);
    let plan: DeckPlan | null = null;
    if (pdfData && this.pdfProcessor) {
      onProgress?.("슬라이드 분석 중...", 20);
      const { layouts, grays } = await this.pdfProcessor.analyzeForPrep(pdfData, (page, total) =>
        onProgress?.(`슬라이드 분석 (${page}/${total})...`, 20 + Math.round((page / total) * 60))
      );
      if (layouts.length > 0) {
        const analysis = await analyzeSlides(layouts, grays, {
          sourceId: altData.metadata.noteId,
          imageRule: settings.generation.imageRule,
        });
        const existingNote = settings.generation.onlyChangedSlides ? await vm.readNoteIfExists(notePath) : null;
        plan = planDeck({
          ...analysis,
          layouts,
          transcript: altData.transcript,
          transcriptCapChars: settings.generation.transcriptCapChars,
          batchSize: batchSizeFor(settings.tasks.commentary.provider, settings.generation.batchSize),
          deckTitle: altData.title,
          existing: existingNote ? parseExistingSlides(existingNote) : undefined,
        });
      }
    }
    onProgress?.("예산 산정 완료", 100);
    return this.withEstimate({ url, preview, subject, examPeriod, notePath, pdfData, plan, context, fewerImages: false });
  }

  /** Same plan with visual slides sent as text only (spec 5.5 "fewer images"). */
  reduceImages(prepared: PreparedImport): PreparedImport {
    if (!prepared.plan) return prepared;
    return this.withEstimate({
      ...prepared,
      plan: withFewerImages(
        prepared.plan,
        batchSizeFor(this.data.settings.tasks.commentary.provider, this.data.settings.generation.batchSize)
      ),
      fewerImages: true,
    });
  }

  private withEstimate(p: Omit<PreparedImport, "estimate" | "overCap">): PreparedImport {
    const tasks = this.data.settings.tasks;
    const asProvider = (id: ProviderId | "none"): ProviderId => (id === "none" ? "claude-cli" : id);
    const estimate: BudgetEstimate = p.plan
      ? estimateLecture(p.plan, p.context, p.preview.altData.summary, asProvider(tasks.commentary.provider), asProvider(tasks.concepts.provider))
      : this.estimateLectureLevel(p.preview, asProvider(tasks.commentary.provider), asProvider(tasks.concepts.provider));
    return { ...p, estimate, overCap: exceedsCap(estimate, this.data.settings.generation.tokenCapPerLecture) };
  }

  /**
   * No PDF: the 1.x lecture-level flow (one transcript pass when there is a
   * transcript, then concepts), estimated from the same prompt templates.
   */
  private estimateLectureLevel(preview: ImportPreview, commentary: ProviderId, concepts: ProviderId): BudgetEstimate {
    const alt = preview.altData;
    const transcript = (alt.transcript ?? "").slice(0, 15000);
    const calls: CallShape[] = [];
    if (transcript && alt.summary.length < 2500) {
      calls.push({
        promptText: summaryEnhanceTranscriptSystemTemplate + summaryEnhanceTranscriptTemplate + alt.summary + transcript,
        images: 0,
        outputTokens: 3000,
        schema: false,
      });
    }
    const main = estimateCalls(calls, commentary);
    // Concepts read the (enhanced) summary: assume about 6000 characters.
    const concept = estimateCalls(
      [{ promptText: conceptExtractionTemplateText + "가".repeat(Math.max(alt.summary.length, 6000)), images: 0, outputTokens: 3800, schema: false }],
      concepts
    );
    return {
      calls: main.calls + concept.calls,
      inputTokens: main.inputTokens + concept.inputTokens,
      outputTokens: main.outputTokens + concept.outputTokens,
      imagesSent: 0,
      slidesTotal: 0,
      slidesGenerated: 0,
      slidesTemplated: 0,
      slidesDeduped: 0,
      slidesReused: 0,
    };
  }

  /** Every running CLI import, aborted on plugin unload (review M2). */
  private activeJobs = new Set<AbortController>();

  /**
   * Run a prepared CLI import. Cancel with `hooks.signal`; nothing is written
   * when cancelled. Usage is recorded even when the run fails or the update
   * is declined, since the tokens were spent.
   */
  async runCliImport(prepared: PreparedImport, hooks: CliImportHooks = {}): Promise<ImportRecord> {
    const settings = this.data.settings;
    const job = createJobDir();
    const usage = new UsageTracker();
    usage.onChange((total) => hooks.onUsage?.(total));
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (hooks.signal?.aborted) controller.abort();
    hooks.signal?.addEventListener("abort", forward, { once: true });
    this.activeJobs.add(controller);
    const signal = controller.signal;
    try {
      const commentaryLlm = await this.providerFor("commentary", job, usage, signal);
      const conceptLlm = await this.providerFor("concepts", job, usage, signal);
      const { preview, subject, examPeriod, url, plan, pdfData } = prepared;
      const altData = preview.altData;

      if (!plan || !pdfData) {
        // No PDF: 1.x lecture-level note, generated by the CLI provider.
        hooks.onStep?.("overview");
        return await this.runLegacyImport(url, preview, subject, examPeriod, commentaryLlm, conceptLlm, hooks.onProgress, hooks.onConfirmUpdate, signal);
      }

      const pdfProcessor = this.pdfProcessor!;
      const run = await runBatchedLecture({
        plan,
        context: prepared.context,
        subject,
        language: settings.language,
        altSummary: altData.summary,
        commentaryLlm,
        conceptLlm,
        renderImage: (page) => pdfProcessor.renderPageJpeg(pdfData, page),
        signal,
        onStep: hooks.onStep,
        onBatch: hooks.onBatch,
      });
      if (signal.aborted) throw new CliRunError("aborted", "취소되었습니다");
      // Nothing generated at all: keep the existing note as it is (review H1).
      const llmSlides = plan.slides.filter((s) => s.mode === "llm").length;
      if (llmSlides > 0 && run.slidesResult.generatedCount === 0) {
        const first = run.slidesResult.errors[0]?.reason ?? "알 수 없는 오류";
        throw new Error(`슬라이드 해설을 하나도 만들지 못해 노트를 저장하지 않았습니다: ${first}`);
      }

      hooks.onStep?.("save");
      const existingConceptNames = new Set(prepared.context.knownConcepts);
      const concepts = this.normalizeConcepts(run.concepts, existingConceptNames);
      const tags = examPeriod ? [...run.tags, examPeriod] : run.tags;
      const commentaryTask = settings.tasks.commentary;
      const providerLabel = `${PROVIDER_LABELS[commentaryTask.provider]}${commentaryTask.model ? " " + commentaryTask.model : ""}`;
      const errors = [
        ...run.slidesResult.errors,
        ...run.warnings.map((reason) => ({ slideNum: 0, reason })),
      ];
      const { lectureMarkdown, conceptNotes } = await new NoteGenerator(commentaryLlm).generatePageAnchored(
        altData,
        { ...run.slidesResult, errors },
        { processedSummary: run.overview, concepts, tags, subjectSuggestion: subject },
        subject,
        [formatUsageFrontmatter(usage.total(), providerLabel)]
      );
      return await this.saveLecture({
        url,
        altData,
        subject,
        examPeriod,
        lectureMarkdown,
        conceptNotes,
        pdfData,
        onProgress: hooks.onProgress,
        onConfirmUpdate: hooks.onConfirmUpdate,
        signal,
      });
    } finally {
      hooks.signal?.removeEventListener("abort", forward);
      this.activeJobs.delete(controller);
      removeJobDir(job);
      if (usage.total().calls > 0) {
        await this.recordUsage(usage).catch((e) => console.warn("[Alt2Obsidian] usage record failed:", e));
      }
    }
  }

  /** Abort every running CLI import (plugin unload). */
  abortAllJobs(): void {
    for (const c of this.activeJobs) c.abort();
  }

  /** Cumulative usage and recently used models (spec 5.5, 4.2). */
  private async recordUsage(usage: UsageTracker): Promise<void> {
    this.data.usageTotals = accumulateTotals(this.data.usageTotals, usage, formatDate());
    for (const task of ["commentary", "concepts"] as TaskId[]) {
      const t = this.data.settings.tasks[task];
      if (t.provider !== "none") rememberModel(this.data.settings, t.provider, t.model);
    }
    await this.savePluginData();
  }

  // ---- CLI binaries (spec 4.2 rule 1) ----

  /** Last lookup error per CLI, shown in the settings cards. */
  cliErrors: Partial<Record<CliName, string>> = {};

  /**
   * Find the CLI and read its version. `force` ignores the cached path (the
   * settings "다시 찾기" button). Never throws; null when not found.
   */
  async detectCli(name: CliName, force = false): Promise<CliDetection | null> {
    const settings = this.data.settings;
    try {
      const resolved = await resolveCliBinary(name, {
        configuredPath: name === "claude" ? settings.claudePath : settings.codexPath,
        cachedPath: force ? undefined : this.data.cliDetection[name]?.path,
      });
      let version = "";
      try {
        version = await readCliVersion(resolved.path);
      } catch (e) {
        console.warn(`[Alt2Obsidian] ${name} --version failed:`, e);
      }
      const detection = { path: resolved.path, version, detectedAt: new Date().toISOString() };
      this.data.cliDetection[name] = detection;
      delete this.cliErrors[name];
      await this.savePluginData();
      return detection;
    } catch (e) {
      this.cliErrors[name] = e instanceof Error ? e.message : String(e);
      if (force || this.data.cliDetection[name]) {
        delete this.data.cliDetection[name];
        await this.savePluginData();
      }
      return null;
    }
  }

  /** Path of the CLI for a call: the cached lookup when still valid, else a new lookup. */
  async resolveBin(name: CliName): Promise<string> {
    const configured = (name === "claude" ? this.data.settings.claudePath : this.data.settings.codexPath).trim();
    const cached = this.data.cliDetection[name];
    if (cached && (!configured || configured === cached.path) && isExecutable(cached.path)) return cached.path;
    const found = await this.detectCli(name);
    if (!found) throw new Error(this.cliErrors[name] || cliNotFoundMessage(name));
    return found.path;
  }

  /**
   * Once after a 1.x migration or a fresh install (review H2). Nothing here
   * calls a model: the check is `claude auth status`.
   * - A working 1.x setup (Gemini key, or Ollama) is kept; the settings show
   *   a "switch to Claude CLI" button and a Notice says so.
   * - Without one, the Claude CLI becomes the default when it is installed
   *   and logged in.
   */
  private async applyCliDefaultOnce(): Promise<void> {
    if (!this.data.pendingCliDefault) return;
    const claude = await this.detectCli("claude");
    const usable = !!claude && (await probeCliLogin("claude", claude.path));
    delete this.data.pendingCliDefault;
    const action = cliDefaultAction(this.data.settings, usable);
    if (action === "switch") {
      applyClaudeDefaults(this.data.settings);
      new Notice("Alt2Obsidian 2.0: 로그인된 Claude CLI를 찾아 슬라이드 해설과 개념 추출에 쓰도록 설정했습니다. 설정에서 바꿀 수 있습니다.");
    } else if (action === "offer") {
      this.data.cliSwitchOffered = true;
      new Notice("Alt2Obsidian 2.0: Claude CLI를 찾았습니다. 기존 설정은 그대로 두었습니다. API 키 없이 쓰려면 설정 > LLM 연결에서 'Claude CLI로 전환'을 누르세요.");
    }
    await this.savePluginData();
  }

  /** Settings button: switch the tasks to the Claude CLI after a free login check. */
  async switchToClaudeCli(): Promise<void> {
    const bin = await this.resolveBin("claude");
    if (!(await probeCliLogin("claude", bin))) {
      throw new Error("Claude CLI에 로그인되어 있지 않습니다. 터미널에서 claude를 한 번 실행해 로그인한 뒤 다시 시도하세요.");
    }
    applyClaudeDefaults(this.data.settings);
    delete this.data.cliSwitchOffered;
    await this.savePluginData();
  }

  async generateExamSummary(subject: string, period?: ExamPeriod): Promise<string> {
    const settings = this.data.settings;
    if (settings.tasks.commentary.provider === "gemini" && !settings.apiKey) {
      throw new Error("API 키를 설정에서 입력해주세요");
    }
    const job = createJobDir();
    try {
      const llm = await this.providerFor("commentary", job, new UsageTracker());
      const generator = new ExamSummaryGenerator(llm, this.vaultManager!);
      return await generator.generate(subject, period);
    } finally {
      removeJobDir(job);
    }
  }

  private async savePartialNote(
    altData: import("./types").AltNoteData,
    subject: string,
    url: string,
    llm: ILLMProvider,
    pdfDataPromise: Promise<ArrayBuffer | null>,
    materialContextPromise: Promise<LectureMaterialContext | null>,
    onProgress?: (stage: string, percent: number) => void,
    onConfirmUpdate?: (summary: ImportUpdateSummary) => Promise<boolean>,
    signal?: AbortSignal
  ): Promise<ImportRecord> {
    onProgress?.("부분 노트 생성 중...", 50);

    const materialContext = await materialContextPromise;
    if (materialContext) {
      onProgress?.("강의자료에서 노트 초안 생성 중...", 55);
      altData.summary = await this.generateSummaryFromLectureMaterial(
        llm,
        altData.summary,
        materialContext
      );
    }

    const noteGenerator = new NoteGenerator(llm);
    const { lectureMarkdown } = await noteGenerator.generate(
      altData,
      {
        processedSummary: altData.summary,
        concepts: [],
        tags: [],
        subjectSuggestion: subject,
      },
      subject
    );

    const vm = this.vaultManager!;
    const subjectFolder = `${vm.getBasePath()}/${sanitizeFilename(subject)}`;
    const noteFilename = sanitizeFilename(altData.title);
    const notePath = `${subjectFolder}/${noteFilename}.md`;
    const updateSummary = await vm.buildManagedNoteUpdateSummary(
      notePath,
      lectureMarkdown,
      []
    );
    if (updateSummary.isUpdate && onConfirmUpdate) {
      const confirmed = await onConfirmUpdate(updateSummary);
      if (!confirmed) throw new Error("업데이트가 취소되었습니다");
      onProgress?.("Vault에 저장 중...", 90);
    }

    if (signal?.aborted) throw new CliRunError("aborted", "취소되었습니다");
    const saveResult = await vm.saveManagedNote(lectureMarkdown, notePath);

    let pdfPath: string | undefined;
    const pdfData = await pdfDataPromise;
    if (pdfData) {
      const pdfFilename = sanitizeFilename(altData.title);
      const rawPdfPath = `${subjectFolder}/${pdfFilename}.pdf`;
      pdfPath = await vm.saveRawFile(pdfData, rawPdfPath);
    }

    onProgress?.("완료!", 100);

    const record: ImportRecord = {
      url,
      title: altData.title,
      subject,
      path: notePath,
      date: formatDate(),
      parseQuality: "partial",
      altId: altData.metadata.noteId || undefined,
      pdfPath,
      wasUpdate: saveResult.wasUpdate,
      updateSummary,
    };
    record.wasUpdate = this.upsertRecentImport(record) || saveResult.wasUpdate;
    await this.savePluginData();

    return record;
  }

  private async detectSubject(
    llm: ILLMProvider,
    title: string,
    _summary: string
  ): Promise<string> {
    // First try regex extraction from title (most reliable)
    const codeMatch = title.match(/([A-Z]{2,}[\s-]?\d{2,})/i);
    if (codeMatch) {
      return codeMatch[1].replace(/\s+/g, "").toUpperCase();
    }

    // Fallback to LLM only if no code found
    try {
      const prompt = renderPrompt(subjectDetectionTemplate, { title });

      const result = await llm.generateText(prompt, {
        maxOutputTokens: 20,
      });
      const cleaned = result.trim().replace(/['"*\n]/g, "").slice(0, 20);
      return cleaned || title.split(/[\s-_]/)[0];
    } catch {
      return title.split(/[\s-_]/)[0];
    }
  }

  private async enhanceSummaryWithLectureMaterial(
    llm: ILLMProvider,
    summary: string,
    materialContext: LectureMaterialContext
  ): Promise<string> {
    const prompt = renderPrompt(summaryEnhanceMaterialTemplate, {
      summary: this.truncateForPrompt(summary, 18000),
      pageCount: materialContext.pageCount,
      excerptPageCount: materialContext.pages.length,
      excerptScope: materialContext.truncated ? "일부 발췌" : "전체 발췌",
      materialText: materialContext.text,
    });

    return llm.generateText(prompt, {
      systemPrompt: renderPrompt(summaryEnhanceMaterialSystemTemplate, {}),
      maxOutputTokens: 8192,
    });
  }

  private async generateSummaryFromLectureMaterial(
    llm: ILLMProvider,
    fallbackSummary: string,
    materialContext: LectureMaterialContext
  ): Promise<string> {
    const memoContext = fallbackSummary
      ? `\n[Alt에서 가져온 제한적 내용]\n${this.truncateForPrompt(fallbackSummary, 4000)}\n`
      : "";
    const prompt = renderPrompt(summaryFromMaterialTemplate, {
      memoContext,
      pageCount: materialContext.pageCount,
      excerptPageCount: materialContext.pages.length,
      materialText: materialContext.text,
    });

    return llm.generateText(prompt, {
      systemPrompt: renderPrompt(summaryFromMaterialSystemTemplate, {}),
      maxOutputTokens: 8192,
    });
  }

  private async extractLectureMaterialContext(
    pdfDataPromise: Promise<ArrayBuffer | null>,
    seedText: string,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<LectureMaterialContext | null> {
    const pdfData = await pdfDataPromise;
    if (!pdfData || !this.pdfProcessor) return null;

    onProgress?.("강의자료 텍스트 추출 중...", 15);
    return this.pdfProcessor.extractLectureMaterialContext(
      pdfData,
      seedText,
      (page, total) => {
        const pct = 15 + Math.floor((page / total) * 10);
        onProgress?.(`강의자료 텍스트 추출 (${page}/${total})...`, pct);
      }
    );
  }

  private truncateForPrompt(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const head = text.slice(0, Math.floor(maxChars * 0.7));
    const tail = text.slice(text.length - Math.floor(maxChars * 0.3));
    return `${head}\n\n[...중간 내용 생략...]\n\n${tail}`;
  }

  private normalizeConcepts(
    concepts: ConceptData[],
    existingConceptNames: Set<string>
  ): ConceptData[] {
    const canonicalByKey = new Map<string, string>();
    for (const name of existingConceptNames) {
      canonicalByKey.set(this.normalizeConceptKey(name), name);
    }

    const merged = new Map<string, ConceptData>();
    for (const concept of concepts) {
      const rawName = concept.name.trim();
      if (!rawName) continue;

      const canonicalName =
        canonicalByKey.get(this.normalizeConceptKey(rawName)) || rawName;
      const current = merged.get(canonicalName);
      const next = { ...concept, name: canonicalName };

      if (current) {
        current.relatedConcepts.push(...next.relatedConcepts);
        current.definition = current.definition || next.definition;
        current.example = current.example || next.example;
        current.caution = current.caution || next.caution;
        current.lectureContext = current.lectureContext || next.lectureContext;
      } else {
        merged.set(canonicalName, next);
      }
    }

    const normalized = Array.from(merged.values());
    const allowed = new Set<string>();
    for (const concept of normalized) {
      allowed.add(concept.name.toLowerCase());
      allowed.add(sanitizeFilename(concept.name).toLowerCase());
      allowed.add(this.normalizeConceptKey(concept.name));
    }
    for (const name of existingConceptNames) {
      allowed.add(name.toLowerCase());
      allowed.add(sanitizeFilename(name).toLowerCase());
      allowed.add(this.normalizeConceptKey(name));
    }

    return normalized.map((concept) => ({
      ...concept,
      relatedConcepts: Array.from(new Set(concept.relatedConcepts))
        .map((name) => canonicalByKey.get(this.normalizeConceptKey(name)) || name)
        .filter((name) => {
          const key = this.normalizeConceptKey(name);
          return (
            key !== this.normalizeConceptKey(concept.name) &&
            (allowed.has(name.toLowerCase()) ||
              allowed.has(sanitizeFilename(name).toLowerCase()) ||
              allowed.has(key))
          );
        }),
    }));
  }

  private async downloadPdfForImport(
    preview: ImportPreview
  ): Promise<ArrayBuffer | null> {
    if (preview.pdfData) return preview.pdfData;
    if (!preview.pdfUrl || !this.pdfProcessor) return null;

    try {
      return await this.pdfProcessor.downloadPdf(preview.pdfUrl);
    } catch (e) {
      console.warn("[Alt2Obsidian] PDF download failed:", e);
      return null;
    }
  }

  private normalizeConceptKey(name: string): string {
    return sanitizeFilename(name)
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
  }

  private upsertRecentImport(record: ImportRecord): boolean {
    const existingIndex = this.data.recentImports.findIndex((item) =>
      this.isSameImportRecord(item, record)
    );
    const wasUpdate = existingIndex !== -1;
    const nextRecord = { ...record, wasUpdate };

    if (wasUpdate) {
      this.data.recentImports.splice(existingIndex, 1);
    }

    this.data.recentImports.unshift(nextRecord);

    const seen = new Set<string>();
    this.data.recentImports = this.data.recentImports.filter((item) => {
      const key = item.altId || item.url || item.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (this.data.recentImports.length > 50) {
      this.data.recentImports = this.data.recentImports.slice(0, 50);
    }

    return wasUpdate;
  }

  private isSameImportRecord(a: ImportRecord, b: ImportRecord): boolean {
    if (a.altId && b.altId) return a.altId === b.altId;
    if (a.url && b.url) return a.url === b.url;
    return a.path === b.path;
  }

  private async activateSidebarView(): Promise<void> {
    const existing =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);

    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_SIDEBAR,
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async loadPluginData(): Promise<void> {
    const saved = (await this.loadData()) || {};
    this.data = Object.assign({}, DEFAULT_PLUGIN_DATA, saved);
    // Keep every 1.x value; add the 2.0 per-task settings (spec 4.2).
    const { settings, needsCliDefault } = migrateSettings(saved.settings);
    this.data.settings = settings;
    this.data.recentImports = Array.isArray(saved.recentImports) ? saved.recentImports : [];
    this.data.cliDetection = { ...(saved.cliDetection ?? {}) };
    this.data.usageTotals = {
      ...DEFAULT_PLUGIN_DATA.usageTotals,
      ...(saved.usageTotals ?? {}),
      byProvider: { ...(saved.usageTotals?.byProvider ?? {}) },
    };
    if (needsCliDefault) this.data.pendingCliDefault = true;
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }
}
