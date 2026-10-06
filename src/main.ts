import { editorLivePreviewField, Plugin, Notice, WorkspaceLeaf } from "obsidian";
import type { CodexModels, ModelCatalog, ModelInfo } from "./settings/llmSettings";
import type { Extension } from "@codemirror/state";
import { managedCommentHider } from "./editor/managedComments";
import {
  PluginData,
  DEFAULT_PLUGIN_DATA,
  ImportRecord,
  ImportPreview,
  LLMProvider as ILLMProvider,
  ConceptData,
  ImportUpdateSummary,
  LectureMaterialContext,
  CliDetection,
  CliName,
  EffortLevel,
  LLMUsage,
  ProviderId,
  TaskId,
  TaskLLMSetting,
} from "./types";
import { AltPublicUrlSource, bundleFromAltData } from "./sources/AltPublicUrlSource";
import { AltLocalSource, altUserDataDir, connectAltLocal, ConnectResult, inferSubject, LectureBundle } from "./sources";
import { alignLecture, buildAlignmentCheckPrompt, checkAlignmentWithLlm, LectureAlignment } from "./pipeline/alignment";
import { layoutAlignmentText } from "./core/prep/pageLayout";
import { computeSlideHash } from "./core/slideHash";
import { splitMultiManagedNote } from "./core/merge";
import { isLinkCandidate, LocalNoteStatus, slideChangeCount, VaultNoteInfo } from "./core/noteStatus";
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
  batchSizeFor,
  chooseCli,
  migrateSettings,
  describeFilled,
  isCliProvider,
  moveClaudeTasksToCodex,
  parseClaudeModelCatalog,
  parseCodexModels,
  removedProviderMessage,
  PROVIDER_LABELS,
  rememberModel,
  resolvedKey,
  sanitizeTask,
  estimateEffort,
} from "./settings/llmSettings";
import { analyzeSlides, selectKeyDiagrams } from "./core/prep/SlideAnalyzer";
import { DeckPlan, makeBatches, parseExistingSlides, planDeck, withFewerImages, withTranscriptChunks } from "./pipeline/batchPlan";
import { estimateLecture, PipelineStep, runBatchedLecture } from "./pipeline/lecturePipeline";
import type { BatchProgress, LectureContext } from "./generator/BatchCommentaryGenerator";
import { BudgetEstimate, CallShape, estimateCalls, exceedsCap } from "./core/budget/estimate";
import conceptExtractionTemplateText from "../prompts/concept-extraction.md";
import { ConceptExtractor } from "./generator/ConceptExtractor";
import { insertFrontmatterLine, NoteGenerator } from "./generator/NoteGenerator";
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
import { promises as fsp, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join as joinPath } from "node:path";
import { pluginCacheDir } from "./sources/altPaths";
import { sanitizeFilename, formatDate } from "./utils/helpers";
import { attachmentPathForNote, lecturePath, verificationPathForNote } from "./vault/layout";
import {
  estimateVerification,
  mergeVerificationNote,
  planVerification,
  renderVerificationNote,
  runVerification as runNoteVerification,
  verdictCounts,
  VerifyEstimate,
  VerifyInput,
  VerifyPlan,
  VerifyProgress,
} from "./verify/NoteVerifier";
import { fetchNotionPage, NotionFetchProvider, NotionFetchResult } from "./verify/notionFetch";
import { parseAlignment } from "./core/prep/TranscriptAligner";
import { applyLayoutMigration, MigrationPlan, MigrationResult, planLayoutMigration, VaultFileEntry } from "./vault/layoutMigration";
import { MigrationModal } from "./ui/MigrationModal";
import { normalizeConcepts } from "./core/conceptNames";
import { decidePdfOpen, lectureNoteForPdf } from "./ui/pdfOpen";
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
  notePath: string;
  pdfData: ArrayBuffer | null;
  /** null: no PDF, the lecture-level flow runs instead. */
  plan: DeckPlan | null;
  context: LectureContext;
  estimate: BudgetEstimate;
  overCap: boolean;
  fewerImages: boolean;
  /** Timestamped transcript aligned to the slides (spec 4.3); null = even split. */
  alignment: LectureAlignment | null;
  /** Page texts the alignment used (alignment check prompt). */
  slideTexts: string[];
  /** Pages saved to Attachments/ and embedded (spec 4.8); empty when the setting is off. */
  diagramPages: number[];
  /**
   * Model choices for this run only (the sidebar's picker), by task. Tasks
   * not listed use the saved settings; the settings are never changed here.
   */
  overrides: Partial<Record<TaskId, TaskLLMSetting>>;
}

/** A verification after claims, evidence and estimate, before any LLM call. */
export interface PreparedVerification {
  targetPath: string;
  /** Verification/<lecture> verification.md */
  outPath: string;
  /** How the checked note is named in the result ("[[path]]", a Notion URL, "붙여넣기"). */
  source: string;
  plan: VerifyPlan;
  estimate: VerifyEstimate;
  overCap: boolean;
  /** The verification model for this run (the panel's picker); the saved setting otherwise. */
  task: TaskLLMSetting;
}

export interface VerifyRunResult {
  path: string;
  counts: ReturnType<typeof verdictCounts>;
  warnings: string[];
}

export interface CliImportHooks {
  signal?: AbortSignal;
  onStep?: (step: PipelineStep | "save") => void;
  onBatch?: (p: BatchProgress) => void;
  onUsage?: (total: LLMUsage) => void;
  /** A task's call reported the model it used (an alias comes back as the full id). */
  onModel?: (task: string, model: string) => void;
  onProgress?: (stage: string, percent: number) => void;
  onConfirmUpdate?: (summary: ImportUpdateSummary) => Promise<boolean>;
}

export default class Alt2ObsidianPlugin extends Plugin {
  data: PluginData = DEFAULT_PLUGIN_DATA;
  vaultManager: VaultManager | null = null;

  private urlSource = new AltPublicUrlSource();
  private pdfProcessor: PdfProcessor | null = null;
  /** Current Alt local source (API or database copy); see `connectLocal`. */
  private localSource: AltLocalSource | null = null;
  /** Slide hashes of local PDFs by path + size + mtime (sidebar status). */
  private textCache = new Map<string, Array<string | null>>();
  private pageCountCache = new Map<string, number>();

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
      return new SyncedViewerView(
        leaf,
        (id) => this.loadTranscript(id),
        () => this.data.settings.hideManagedComments,
        (pdfPath) => this.openNativePdf(pdfPath)
      );
    });

    // Live Preview: hide the alt2obs management comment lines (setting "관리 주석 숨기기").
    this.registerEditorExtension(this.editorExtensions);
    this.applyCommentHiding();

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
      name: "Import Alt note (local list or URL)",
      callback: () => this.activateSidebarView(),
    });

    this.addCommand({
      id: "migrate-vault-layout",
      name: "Migrate 1.x vault layout",
      callback: () => new MigrationModal(this.app, this.planVaultMigration(), (plan) => this.applyVaultMigration(plan)).open(),
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
      // Lecture PDFs opened from now on go to the Synced Viewer (setting
      // "강의 PDF를 열면 뷰어로 열기"). Registered after the layout is
      // restored, and the PDF tabs it restored are left as plain PDFs.
      if (this.data.settings.openPdfInViewer) this.keepOpenPdfTabsPlain();
      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          if (file instanceof TFile) void this.onPdfOpened(file).catch((e) => console.warn("[Alt2Obsidian] lecture PDF redirect failed:", e));
        })
      );
    });
    // Prune the transcript cache once the metadata cache has indexed every
    // note: before that, a note's alt_local_id may be missing and its
    // transcript would be dropped.
    let pruned = false;
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        if (pruned) return;
        pruned = true;
        this.pruneTranscriptCache().catch((e) => console.warn("[Alt2Obsidian] transcript cache prune failed:", e));
      })
    );
  }

  onunload(): void {
    // Kill running CLI processes; their finally blocks remove the temp folders.
    this.abortAllJobs();
    this.unloaded = true;
    this.localSource?.close?.();
    this.localSource = null;
  }
  private unloaded = false;

  /**
   * Resolve the active note's sibling PDF and open both in the Synced
   * Viewer (Task 1.5). PDF is expected at `{same-folder}/{same-stem}.pdf`
   * (Task 1.4 sibling layout). If the active file isn't a markdown note or
   * has no sibling PDF, surface a Notice and bail.
   */
  async openSyncedViewerForActiveNote(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    // The lecture PDF works too: its note is the .md with the same name.
    const mdPath = active?.extension.toLowerCase() === "pdf" ? active.path.replace(/\.pdf$/i, ".md") : active?.extension === "md" ? active.path : null;
    if (!mdPath || !(this.app.vault.getAbstractFileByPath(mdPath) instanceof TFile)) {
      new Notice("강의 노트(.md)나 그 PDF를 연 뒤 다시 시도하세요.");
      return;
    }
    const pdfFile = this.siblingPdf(mdPath);
    if (!pdfFile) {
      new Notice(`같은 폴더에 같은 이름의 PDF가 없습니다: ${mdPath.replace(/\.md$/, ".pdf")}. 강의를 가져오면 PDF가 함께 저장됩니다.`);
      return;
    }
    await this.openSyncedViewer(mdPath, pdfFile.path);
  }

  /**
   * Tabs showing a PDF the user opened as a plain PDF on purpose ("PDF만
   * 보기" in the viewer, or restored at startup), with that PDF's path: that
   * PDF is never turned into the Synced Viewer in that tab. Another lecture
   * PDF opened in the same tab still is.
   */
  private nativePdfLeaves = new WeakMap<WorkspaceLeaf, string>();
  /**
   * PDF tabs open right now stay plain PDFs: called when the redirect starts
   * (startup, the setting turned on), so only PDFs opened afterwards are
   * turned into the viewer, not tabs the user already had.
   */
  keepOpenPdfTabsPlain(): void {
    for (const leaf of this.app.workspace.getLeavesOfType?.("pdf") ?? []) {
      const file = (leaf.getViewState?.().state as { file?: unknown } | undefined)?.file ?? (leaf.view as { file?: TFile | null })?.file?.path;
      if (typeof file === "string") this.nativePdfLeaves.set(leaf, file);
    }
  }

  /** PDFs being turned into a viewer right now (no second redirect while it runs). */
  private redirecting = new Set<string>();

  /**
   * A file was opened. When it is a lecture PDF shown in a normal PDF tab,
   * that tab becomes the Synced Viewer for the PDF and its note (or the
   * open viewer of the same pair is shown and the PDF tab closed). See
   * `decidePdfOpen` for when nothing happens.
   */
  async onPdfOpened(file: TFile): Promise<void> {
    if (!/\.pdf$/i.test(file.path)) return;
    const leaf = this.pdfLeafFor(file.path);
    const notePath = this.data.settings.openPdfInViewer
      ? await lectureNoteForPdf(file.path, {
          exists: (p) => this.app.vault.getAbstractFileByPath(p) instanceof TFile,
          frontmatter: (p) => {
            const f = this.app.vault.getAbstractFileByPath(p);
            return f instanceof TFile ? this.app.metadataCache.getFileCache(f)?.frontmatter ?? null : null;
          },
          read: async (p) => {
            const f = this.app.vault.getAbstractFileByPath(p);
            return f instanceof TFile ? this.app.vault.cachedRead(f) : "";
          },
        })
      : null;
    // The tab may have moved on while the note was read.
    const stillShown = !!leaf && (leaf.view as { file?: TFile | null })?.file?.path === file.path;
    const decision = decidePdfOpen({
      enabled: this.data.settings.openPdfInViewer,
      viewType: stillShown ? leaf!.view.getViewType() : null,
      pdfPath: file.path,
      bypass: !!leaf && this.nativePdfLeaves.get(leaf) === file.path,
      busy: this.redirecting.has(file.path),
      notePath,
    });
    if (decision.action !== "viewer" || !leaf) return;
    this.redirecting.add(file.path);
    try {
      // A restored tab that was never shown holds a placeholder view: read its saved state.
      const same = this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNCED_VIEWER).find((l) => {
        const st = (l.view instanceof SyncedViewerView ? l.view.getState() : l.getViewState?.().state) as { mdPath?: unknown; pdfPath?: unknown } | undefined;
        return st?.mdPath === decision.mdPath && st?.pdfPath === decision.pdfPath;
      });
      if (same && same !== leaf) {
        // The pair is already open: show that tab. The PDF tab goes back to
        // what it showed before (the file explorer opens a PDF in the
        // current tab); only a tab opened just for this PDF is closed. This
        // is what Obsidian itself does when a tab's file is deleted.
        const history = (leaf as unknown as { history?: { backHistory?: unknown[]; back?: () => Promise<void> } }).history;
        if (history?.back && (history.backHistory?.length ?? 0) > 0) await history.back();
        else leaf.detach();
        this.app.workspace.revealLeaf(same);
        return;
      }
      // replacesPdf: the viewer keeps the PDF step out of the tab's history,
      // so Back goes to what was open before instead of redirecting again.
      await leaf.setViewState({ type: VIEW_TYPE_SYNCED_VIEWER, active: true, state: { mdPath: decision.mdPath, pdfPath: decision.pdfPath, replacesPdf: true } });
    } finally {
      this.redirecting.delete(file.path);
    }
  }

  /** The PDF tab showing this file: the active one, else any tab with it. */
  private pdfLeafFor(path: string): WorkspaceLeaf | null {
    const shows = (l: WorkspaceLeaf | null | undefined) => {
      const v = l?.view as { getViewType?: () => string; file?: TFile | null } | undefined;
      return !!v && v.getViewType?.() === "pdf" && v.file?.path === path;
    };
    const recent = this.app.workspace.getMostRecentLeaf?.() ?? null;
    if (shows(recent)) return recent;
    return this.app.workspace.getLeavesOfType("pdf").find((l) => shows(l) && this.nativePdfLeaves.get(l) !== path) ?? null;
  }

  /**
   * "PDF만 보기" in the Synced Viewer: the lecture PDF in Obsidian's own PDF
   * view, in a split next to the viewer. That tab is marked so it is not
   * turned back into the viewer.
   */
  async openNativePdf(pdfPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(pdfPath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    this.nativePdfLeaves.set(leaf, file.path);
    await leaf.openFile(file);
  }

  /** The Synced Viewer for a note and its PDF, reusing an open viewer tab. */
  async openSyncedViewer(mdPath: string, pdfPath: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNCED_VIEWER)[0];
    const view = existing?.view;
    if (view instanceof SyncedViewerView && view.getState().mdPath === mdPath && view.getState().pdfPath === pdfPath) {
      // Same pair (a re-import): load both again, the PDF may have changed.
      await view.openPair(mdPath, pdfPath);
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_SYNCED_VIEWER,
      active: true,
      state: { mdPath, pdfPath },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Editor extensions registered once; emptied or filled when the setting changes. */
  private editorExtensions: Extension[] = [];

  /** Applies "관리 주석 숨기기" to open editors and Synced Viewers. */
  applyCommentHiding(): void {
    this.editorExtensions.length = 0;
    if (this.data.settings.hideManagedComments) {
      this.editorExtensions.push(managedCommentHider((state) => state.field(editorLivePreviewField, false) ?? true));
    }
    this.app.workspace.updateOptions?.();
    for (const leaf of this.app.workspace.getLeavesOfType?.(VIEW_TYPE_SYNCED_VIEWER) ?? []) {
      if (leaf.view instanceof SyncedViewerView) void leaf.view.refreshMarkdownOnly();
    }
  }

  // ---- 1.x layout migration (spec 4.5) ----

  /** Dry run: every move the migration would make, nothing changed. */
  planVaultMigration(): MigrationPlan {
    const files: VaultFileEntry[] = this.app.vault.getFiles().map((file) => {
      if (file.extension !== "md") return { path: file.path };
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const source = typeof fm?.source === "string" ? fm.source : "";
      const isLectureNote = !!fm && (!!fm.alt_id || !!fm.alt_local_id || source === "alt2obsidian" || source === "alt2obsidian-cc-skill");
      return { path: file.path, isLectureNote };
    });
    return planLayoutMigration(this.data.settings.baseFolderPath, files);
  }

  /** Moves through app.fileManager.renameFile, so Obsidian rewrites links to the moved files. */
  async applyVaultMigration(plan: MigrationPlan): Promise<MigrationResult> {
    const result = await applyLayoutMigration(plan, {
      exists: (path) => !!this.app.vault.getAbstractFileByPath(path),
      ensureFolder: (path) => this.vaultManager!.ensureFolder(path),
      rename: async (from, to) => {
        const file = this.app.vault.getAbstractFileByPath(from);
        if (!(file instanceof TFile)) throw new Error("파일이 아님");
        await this.app.fileManager.renameFile(file, to);
      },
    });
    // Recent imports point at the moved files.
    const moved = new Map(result.moved.map((m) => [m.from, m.to]));
    if (moved.size > 0) {
      for (const r of this.data.recentImports) {
        r.path = moved.get(r.path) ?? r.path;
        if (r.pdfPath) r.pdfPath = moved.get(r.pdfPath) ?? r.pdfPath;
      }
      await this.savePluginData();
    }
    return result;
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
    const { altData, bundle } = await this.urlSource.fetch(url);
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
      bundle,
    };
  }

  // ---- Alt local sources (spec 4.1, 2.2) ----

  /** Alt's data folder: the settings override, else the platform default. */
  altUserData(): string {
    return this.data.settings.altDataDir.trim() || altUserDataDir();
  }

  /**
   * Connect to Alt: the local API when Alt answers, else a private copy of
   * its database. Replaces (and closes) the previous source.
   */
  async connectLocal(): Promise<ConnectResult> {
    // Overlapping calls (refresh clicks, the viewer) share one connect, so
    // no database copy is opened twice and left behind.
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.localSource?.close?.();
      this.localSource = null;
      const result = await connectAltLocal(this.altUserData());
      // Unloaded while connecting: close the source (and its DB copy) now.
      if (this.unloaded) {
        result.source?.close?.();
        return { ...result, source: null };
      }
      this.localSource = result.source;
      return result;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  private connecting: Promise<ConnectResult> | null = null;

  /**
   * The current source, or null after a connection or ownership failure
   * (it is closed and dropped, so the next use goes through connectLocal).
   */
  getLocalSource(): AltLocalSource | null {
    if (this.localSource?.failed) {
      this.localSource.close?.();
      this.localSource = null;
    }
    return this.localSource;
  }

  /** The current source, connecting again when there is none. */
  private async usableSource(): Promise<AltLocalSource | null> {
    return this.getLocalSource() ?? (await this.connectLocal()).source;
  }

  /** Import preview for a local note: the whole bundle, PDF read from disk. */
  async previewLocal(id: string): Promise<ImportPreview> {
    const source = await this.usableSource();
    if (!source) throw new Error("Alt에 연결하지 못했습니다. 상태 표시를 눌러 다시 확인하세요.");
    const bundle = await source.getBundle(id);
    return this.previewFromBundle(bundle);
  }

  previewFromBundle(bundle: LectureBundle): ImportPreview {
    const transcript = bundle.transcript.map((s) => s.text).join("\n");
    const summaryParts = [bundle.summaryMarkdown ?? ""];
    if (bundle.memoMarkdown) summaryParts.push(`## Alt 메모\n\n${bundle.memoMarkdown}`);
    const summary = summaryParts.filter((p) => p.trim()).join("\n\n");
    const hasContent = !!bundle.pdf || transcript.length > 0 || summary.length > 0;
    return {
      altData: {
        title: bundle.title,
        summary,
        pdfUrl: null,
        transcript: transcript || null,
        metadata: { noteId: bundle.sourceId, createdAt: bundle.lectureDate ?? null, visibility: null, sourceKind: bundle.sourceKind },
        parseQuality: hasContent ? "full" : "partial",
      },
      pdfData: bundle.pdf,
      pdfUrl: null,
      suggestedSubject: inferSubject(bundle.folderPath ?? [], bundle.title),
      bundle,
    };
  }

  /** Lecture notes under the base folder with their Alt identity (frontmatter). */
  vaultLectureNotes(): VaultNoteInfo[] {
    // The whole vault: a lecture note may have been moved out of the base folder.
    const out: VaultNoteInfo[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm || (!fm.alt_local_id && !fm.alt_id)) continue;
      out.push({
        path: file.path,
        title: typeof fm.title === "string" ? fm.title : file.basename,
        subject: typeof fm.subject === "string" ? fm.subject : undefined,
        altLocalId: typeof fm.alt_local_id === "string" ? fm.alt_local_id : undefined,
        altId: typeof fm.alt_id === "string" ? fm.alt_id : undefined,
        altCreated: typeof fm.alt_created === "string" ? fm.alt_created : undefined,
      });
    }
    return out;
  }

  /** New / imported / link candidate, without the (slower) slide comparison. */
  localNoteStatus(note: { id: string; title: string; lectureDate: string | null }, vault: VaultNoteInfo[], slidesTitle?: string | null): LocalNoteStatus {
    const own = vault.find((v) => v.altLocalId === note.id);
    if (own) return { kind: "imported", path: own.path, changed: null };
    const candidates = vault.filter((v) => isLinkCandidate(v, note, slidesTitle));
    return candidates.length > 0 ? { kind: "link", candidates } : { kind: "new" };
  }

  /**
   * Slides of the Alt PDF whose text hash is not in the imported note (spec
   * 4.7 hashes). Null when the note has no slide markers or the PDF cannot
   * be read.
   */
  async slideChanges(notePath: string, pdfPath: string, sourceId: string): Promise<number | null> {
    const noteFile = this.app.vault.getAbstractFileByPath(notePath);
    if (!(noteFile instanceof TFile) || !this.pdfProcessor) return null;
    const sections = splitMultiManagedNote(await this.app.vault.cachedRead(noteFile)).sections;
    if (sections.length === 0) return null;
    const pdf = await this.pdfPageTexts(pdfPath);
    if (!pdf) return null;
    // Textless pages hash their position with the note's id (spec 4.7). A
    // linked 1.x or URL note used its public id: compare those pages by
    // position against either id, so they do not count as changed.
    const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
    const ids = [sourceId, typeof fm?.alt_id === "string" ? fm.alt_id : null].filter((x): x is string => !!x);
    const byNum = new Map(sections.map((s) => [s.slideNum, s.hash]));
    const hashes: string[] = [];
    for (let i = 0; i < pdf.length; i++) {
      const own = await computeSlideHash(pdf[i], i + 1, sourceId);
      const textless = !pdf[i] || !pdf[i]!.replace(/\s+/g, "");
      let h = own;
      if (textless) {
        for (const id of ids) {
          const alt = await computeSlideHash(pdf[i], i + 1, id);
          if (byNum.get(i + 1) === alt) h = alt;
        }
      }
      hashes.push(h);
    }
    return slideChangeCount(hashes, sections.map((s) => s.hash));
  }

  /** Cache key of a local file: path, size and mtime; null when it cannot be read. */
  private async fileKey(path: string): Promise<string | null> {
    try {
      const st = await fsp.stat(path);
      return `${path}:${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  private async readLocalPdf(path: string): Promise<ArrayBuffer> {
    const buf = await fsp.readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  /** Page texts of a local PDF, cached by path, size and mtime. */
  private async pdfPageTexts(pdfPath: string): Promise<Array<string | null> | null> {
    const key = await this.fileKey(pdfPath);
    if (!key) return null;
    const cached = this.textCache.get(key);
    if (cached) return cached;
    try {
      const texts = await this.pdfProcessor!.getPageTexts(await this.readLocalPdf(pdfPath));
      this.textCache.set(key, texts);
      this.pageCountCache.set(key, texts.length);
      return texts;
    } catch (e) {
      console.warn("[Alt2Obsidian] slide text check failed:", e);
      return null;
    }
  }

  /** Page count of a local PDF (sidebar meta line), cached; null when unreadable. */
  async localPdfPageCount(pdfPath: string): Promise<number | null> {
    if (!this.pdfProcessor) return null;
    const key = await this.fileKey(pdfPath);
    if (!key) return null;
    const cached = this.pageCountCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const n = await this.pdfProcessor.getPageCount(await this.readLocalPdf(pdfPath));
      if (n > 0) this.pageCountCache.set(key, n);
      return n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * One-time link of a 1.x or URL-imported note to its Alt local note: adds
   * `alt_local_id` to the frontmatter. Nothing else in the note changes; the
   * user confirmed the match in the sidebar.
   */
  async linkLocalNote(path: string, localId: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`노트를 찾지 못했습니다: ${path}`);
    // One line inserted as text (processFrontMatter would reformat the YAML).
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, insertFrontmatterLine(content, `alt_local_id: ${JSON.stringify(localId)}`));
  }

  /**
   * Where a local import is written: the note already linked to this Alt
   * note (wherever the user moved it), else <base>/<subject>/<title>.md. A
   * different lecture at that path (another id, or an unlinked 1.x note)
   * is never merged into: the lecture date is added to the file name.
   */
  resolveNotePath(preview: ImportPreview, subject: string): string {
    const vm = this.vaultManager!;
    const alt = preview.altData;
    const base = lecturePath(vm.getBasePath(), subject, alt.title).replace(/\.md$/, "");
    if (alt.metadata.sourceKind !== "alt-local") {
      // A URL re-import updates the note with this public id wherever it is,
      // or a 1.x note still at <subject>/<title>.md (vault not migrated).
      const own = alt.metadata.noteId ? this.vaultLectureNotes().find((v) => v.altId === alt.metadata.noteId) : undefined;
      if (own) return own.path;
      // The 1.x path only for this lecture's own note: the same alt_id, or an
      // Alt2Obsidian note with no id at all (never another lecture's note).
      const legacy = `${vm.getBasePath()}/${sanitizeFilename(subject)}/${sanitizeFilename(alt.title)}.md`;
      const file = this.app.vault.getAbstractFileByPath(legacy);
      if (file instanceof TFile) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const sameId = !!alt.metadata.noteId && fm?.alt_id === alt.metadata.noteId;
        const ours = typeof fm?.source === "string" && fm.source.startsWith("alt2obsidian");
        if (sameId || (ours && !fm?.alt_id && !fm?.alt_local_id)) return legacy;
      }
      return `${base}.md`;
    }
    const own = this.vaultLectureNotes().find((v) => v.altLocalId === alt.metadata.noteId);
    if (own) return own.path;
    const taken = (path: string) => !!this.app.vault.getAbstractFileByPath(path);
    if (!taken(`${base}.md`)) return `${base}.md`;
    const suffix = alt.metadata.createdAt || alt.metadata.noteId.slice(-6);
    let path = `${base} (${sanitizeFilename(suffix)}).md`;
    for (let n = 2; taken(path); n++) path = `${base} (${sanitizeFilename(suffix)} ${n}).md`;
    return path;
  }

  /**
   * Frontmatter carried over or added on an import, so both identities
   * survive a re-import from either source (merge replaces the frontmatter):
   * - local import: a linked note's public `alt_id`, and the new alignment;
   * - URL import: an existing `alt_local_id` / `alt_source` and `alt_alignment`.
   */
  private preservedFrontmatter(notePath: string, sourceKind: "alt-local" | "alt-url" | undefined, alignment: LectureAlignment | null): string[] {
    const lines: string[] = [];
    const file = this.app.vault.getAbstractFileByPath(notePath);
    const fm = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    if (sourceKind === "alt-local") {
      if (str(fm?.alt_id)) lines.push(`alt_id: ${JSON.stringify(fm!.alt_id)}`);
      if (alignment && alignment.value) lines.push(`alt_alignment: ${JSON.stringify(alignment.value)}`);
    } else {
      if (str(fm?.alt_local_id)) lines.push(`alt_local_id: ${JSON.stringify(fm!.alt_local_id)}`);
      if (str(fm?.alt_source)) lines.push(`alt_source: ${JSON.stringify(fm!.alt_source)}`);
      if (str(fm?.alt_alignment)) lines.push(`alt_alignment: ${JSON.stringify(fm!.alt_alignment)}`);
    }
    return lines;
  }

  /** Test hook: where the transcript cache lives (default: the OS cache folder). */
  cacheRoot: string | null = null;

  /**
   * Timestamped transcripts for the viewer panel, outside the vault (so
   * vault sync never carries lecture text): the OS cache folder, one
   * subfolder per vault.
   */
  private transcriptCacheDir(): string {
    return joinPath(this.vaultCacheDir(), "transcripts");
  }

  /** This vault's folder in the OS cache (transcripts, Notion pages): never inside the vault. */
  private vaultCacheDir(): string {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const vaultKey = createHash("sha1")
      .update(adapter.getBasePath?.() ?? this.app.vault.getName?.() ?? "vault")
      .digest("hex")
      .slice(0, 12);
    return joinPath(this.cacheRoot ?? pluginCacheDir(), vaultKey);
  }

  private transcriptCachePath(localId: string): string {
    return joinPath(this.transcriptCacheDir(), `${localId.replace(/[^0-9A-Za-z-]/g, "")}.json`);
  }

  private async cacheTranscript(bundle: LectureBundle | undefined): Promise<void> {
    if (!bundle || bundle.sourceKind !== "alt-local") return;
    const timed = bundle.transcript.filter((s) => s.startMs !== null);
    if (timed.length === 0) return;
    await fsp.mkdir(this.transcriptCacheDir(), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ v: 1, id: bundle.sourceId, segments: timed.map((s) => [s.startMs, s.endMs, s.text]) });
    await fsp.writeFile(this.transcriptCachePath(bundle.sourceId), body, { mode: 0o600 });
  }

  /**
   * Drops cached transcripts of notes no longer in the vault. `keep` is
   * spared (a note just written may not be indexed yet), and so is anything
   * written in the last hour.
   */
  async pruneTranscriptCache(keep: string[] = []): Promise<number> {
    const dir = this.transcriptCacheDir();
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    const live = new Set([...keep, ...this.vaultLectureNotes().map((v) => v.altLocalId).filter((x): x is string => !!x)]);
    let removed = 0;
    for (const name of names) {
      const id = name.replace(/\.json$/, "");
      if (live.has(id)) continue;
      const p = joinPath(dir, name);
      try {
        if (Date.now() - (await fsp.stat(p)).mtimeMs < 3600 * 1000) continue;
        await fsp.rm(p, { force: true });
        removed++;
      } catch {
        // already gone
      }
    }
    return removed;
  }

  /** Timestamped transcript of a local note for the Synced Viewer panel; null when unknown. */
  async loadTranscript(localId: string): Promise<Array<{ startMs: number; endMs: number; text: string }> | null> {
    try {
      const json = JSON.parse(await fsp.readFile(this.transcriptCachePath(localId), "utf8"));
      if (Array.isArray(json?.segments)) {
        return (json.segments as Array<[number, number, string]>).map(([startMs, endMs, text]) => ({ startMs, endMs, text }));
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("[Alt2Obsidian] transcript cache unreadable:", e);
    }
    // Not cached (imported elsewhere, or cache cleared): ask Alt.
    try {
      const source = await this.usableSource();
      if (!source) return null;
      const bundle = await source.getBundle(localId);
      await this.cacheTranscript(bundle);
      return bundle.transcript
        .filter((s) => s.startMs !== null && s.endMs !== null)
        .map((s) => ({ startMs: s.startMs as number, endMs: s.endMs as number, text: s.text }));
    } catch (e) {
      console.warn("[Alt2Obsidian] transcript load failed:", e);
      return null;
    }
  }

  private async providerFor(
    task: TaskId,
    workDir: string,
    usage: UsageTracker,
    signal?: AbortSignal,
    setting: TaskLLMSetting = this.data.settings.tasks[task]
  ): Promise<ILLMProvider> {
    return createTaskProvider(setting, {
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
    llm: ILLMProvider,
    conceptLlm: ILLMProvider,
    onProgress?: (stage: string, percent: number) => void,
    onConfirmUpdate?: (summary: ImportUpdateSummary) => Promise<boolean>,
    signal?: AbortSignal,
    notePathOverride?: string
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
        signal,
        notePathOverride ?? this.resolveNotePath(preview, subject)
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

    // Lecture-level note: this path runs only when there is no slide plan
    // (no PDF, or a PDF without pages). Slides go through runCliImport.
    const pdfData = await pdfDataPromise;
    const notePath = notePathOverride ?? this.resolveNotePath(preview, subject);

    // Generate markdown
    onProgress?.("마크다운 노트 생성 중...", 70);

    const llmResult = {
      processedSummary: altData.summary,
      concepts: conceptResult.concepts,
      tags: conceptResult.tags,
      subjectSuggestion: subject,
      knownConceptNames: Array.from(existingConceptNames),
    };

    const { lectureMarkdown, conceptNotes } = await new NoteGenerator(llm).generate(
      altData,
      llmResult,
      subject,
      this.preservedFrontmatter(notePath, altData.metadata.sourceKind, null)
    );

    return this.saveLecture({
      url,
      altData,
      subject,
      lectureMarkdown,
      conceptNotes,
      pdfData,
      notePath,
      bundle: preview.bundle,
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
    lectureMarkdown: string;
    conceptNotes: import("./types").ConceptNote[];
    pdfData: ArrayBuffer | null;
    /** Default: <base>/<subject>/Lectures/<title>.md (URL imports). */
    notePath?: string;
    /** Local sources: its timestamped transcript is cached for the viewer. */
    bundle?: LectureBundle;
    /** Diagram images embedded in the note, written after it (spec 4.8). */
    attachments?: Array<{ path: string; data: ArrayBuffer }>;
    onProgress?: (stage: string, percent: number) => void;
    onConfirmUpdate?: (summary: ImportUpdateSummary) => Promise<boolean>;
    /** A cancelled import must not write anything. */
    signal?: AbortSignal;
  }): Promise<ImportRecord> {
    const { url, altData, subject, lectureMarkdown, conceptNotes, pdfData, onProgress, onConfirmUpdate, signal } = args;
    const vm = this.vaultManager!;
    // Save everything to vault
    onProgress?.("Vault에 저장 중...", 90);

    const noteFilename = sanitizeFilename(altData.title);
    const notePath = args.notePath ?? lecturePath(vm.getBasePath(), subject, altData.title);
    const noteStem = notePath.replace(/\.md$/, "");
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
      // Sibling of the note (the Synced Viewer looks for <note>.pdf).
      pdfPath = await vm.saveRawFile(pdfData, `${noteStem}.pdf`);
    }
    // Same path on every import: an image is replaced, never duplicated.
    for (const a of args.attachments ?? []) await vm.saveRawFile(a.data, a.path);
    await this.cacheTranscript(args.bundle).catch((e) => console.warn("[Alt2Obsidian] transcript cache write failed:", e));
    void this.pruneTranscriptCache(args.bundle ? [args.bundle.sourceId] : []).catch(() => undefined);

    onProgress?.("완료!", 100);

    const local = altData.metadata.sourceKind === "alt-local";
    const record: ImportRecord = {
      url,
      title: altData.title,
      subject,
      path: notePath,
      date: formatDate(),
      parseQuality: "full",
      altId: local ? undefined : altData.metadata.noteId || undefined,
      altLocalId: local ? altData.metadata.noteId : undefined,
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
    onProgress?: (stage: string, percent: number) => void
  ): Promise<PreparedImport> {
    const settings = this.data.settings;
    // Fail before any work when a configured CLI cannot be found.
    // The alignment check is optional: a missing CLI for it is handled at run time.
    for (const task of ["commentary", "concepts"] as TaskId[]) {
      const p = settings.tasks[task].provider;
      if (p === "claude-cli") await this.resolveBin("claude");
      if (p === "codex-cli") await this.resolveBin("codex");
    }
    const subject = subjectOverride || preview.suggestedSubject;
    const vm = this.vaultManager!;
    const altData = preview.altData;
    const notePath = this.resolveNotePath(preview, subject);
    const context: LectureContext = {
      title: altData.title,
      subjectTags: vm.getSubjectTags(subject),
      knownConcepts: Array.from(await vm.getExistingConceptNames(subject)),
    };

    onProgress?.("PDF 내려받는 중...", 10);
    const pdfData = altData.parseQuality === "partial" ? null : await this.downloadPdfForImport(preview);
    let plan: DeckPlan | null = null;
    let alignment: LectureAlignment | null = null;
    let slideTexts: string[] = [];
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
        // Timestamped transcript (local sources): aligned to the slides, no tokens (spec 4.3).
        slideTexts = layouts.map(layoutAlignmentText);
        alignment = alignLecture(slideTexts, preview.bundle?.transcript, { scanned: analysis.scanned });
        plan = planDeck({
          ...analysis,
          layouts,
          transcript: altData.transcript,
          transcriptChunks: alignment?.chunks,
          transcriptCapChars: settings.generation.transcriptCapChars,
          batchSize: batchSizeFor(settings.tasks.commentary.provider, settings.generation.batchSize),
          deckTitle: altData.title,
          existing: existingNote ? parseExistingSlides(existingNote) : undefined,
        });
      }
    }
    onProgress?.("예산 산정 완료", 100);
    const diagramPages = plan && settings.generation.saveKeyDiagrams ? selectKeyDiagrams(plan.slides, plan.scanned) : [];
    return this.withEstimate({ url, preview, subject, notePath, pdfData, plan, context, fewerImages: false, alignment, slideTexts, diagramPages, overrides: {} });
  }

  /** The setting a task of this run uses: the run's choice, else the saved setting. */
  runTask(prepared: Pick<PreparedImport, "overrides">, id: TaskId): TaskLLMSetting {
    return prepared.overrides[id] ?? this.data.settings.tasks[id];
  }

  /** Same plan with visual slides sent as text only (spec 5.5 "fewer images"). */
  reduceImages(prepared: PreparedImport): PreparedImport {
    if (!prepared.plan) return prepared;
    return this.withEstimate({
      ...prepared,
      plan: withFewerImages(
        prepared.plan,
        batchSizeFor(this.runTask(prepared, "commentary").provider, this.data.settings.generation.batchSize)
      ),
      fewerImages: true,
    });
  }

  /**
   * The same import with another model for one task, for this run only (the
   * sidebar's picker). The saved settings do not change. A different
   * provider regroups the batches (Codex takes twice as many slides per
   * call), and the estimate is computed again.
   */
  withRunChoice(prepared: PreparedImport, task: TaskId, choice: TaskLLMSetting): PreparedImport {
    const setting = sanitizeTask(choice, this.data.settings.tasks[task]);
    const overrides = { ...prepared.overrides, [task]: setting };
    let plan = prepared.plan;
    // Batches always follow the run's commentary provider (cheap to rebuild).
    if (plan && task === "commentary") plan = { ...plan, batches: makeBatches(plan.slides, batchSizeFor(setting.provider, this.data.settings.generation.batchSize)) };
    return this.withEstimate({ ...prepared, plan, overrides });
  }

  /** The effort the estimate counts for a task (see `estimateEffort`: none for Haiku 4.5, the model's default for "CLI 기본값"). */
  private estimatedEffort(t: TaskLLMSetting): EffortLevel {
    return estimateEffort(t.provider, t.model, t.effort, this.modelCatalog());
  }

  private withEstimate(p: Omit<PreparedImport, "estimate" | "overCap">): PreparedImport {
    const commentary = this.runTask(p, "commentary");
    const concepts = this.runTask(p, "concepts");
    const alignmentTask = this.runTask(p, "alignment");
    const asProvider = (id: ProviderId | "none"): ProviderId => (id === "none" ? "claude-cli" : id);
    let estimate: BudgetEstimate = p.plan
      ? estimateLecture(p.plan, p.context, p.preview.altData.summary, asProvider(commentary.provider), asProvider(concepts.provider), {
          commentaryEffort: this.estimatedEffort(commentary),
          conceptEffort: this.estimatedEffort(concepts),
        })
      : this.estimateLectureLevel(p.preview, commentary, concepts);
    // Optional alignment check (spec 4.3 step 3): one small text call.
    const checkPrompt = p.alignment && alignmentTask.provider !== "none" ? buildAlignmentCheckPrompt(p.preview.altData.title, p.alignment, p.slideTexts) : null;
    if (checkPrompt && alignmentTask.provider !== "none") {
      const check = estimateCalls([{ promptText: checkPrompt, images: 0, schema: true, outputTokens: 200 }], alignmentTask.provider, this.estimatedEffort(alignmentTask));
      estimate = { ...estimate, calls: estimate.calls + check.calls, inputTokens: estimate.inputTokens + check.inputTokens, outputTokens: estimate.outputTokens + check.outputTokens };
    }
    return { ...p, estimate, overCap: exceedsCap(estimate, this.data.settings.generation.tokenCapPerLecture) };
  }

  /**
   * No PDF: the 1.x lecture-level flow (one transcript pass when there is a
   * transcript, then concepts), estimated from the same prompt templates.
   */
  private estimateLectureLevel(preview: ImportPreview, commentaryTask: TaskLLMSetting, conceptTask: TaskLLMSetting): BudgetEstimate {
    const asProvider = (id: ProviderId | "none"): ProviderId => (id === "none" ? "claude-cli" : id);
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
    const main = estimateCalls(calls, asProvider(commentaryTask.provider), this.estimatedEffort(commentaryTask));
    // Concepts read the (enhanced) summary: assume about 6000 characters.
    const concept = estimateCalls(
      [{ promptText: conceptExtractionTemplateText + "가".repeat(Math.max(alt.summary.length, 6000)), images: 0, outputTokens: 3800, schema: false }],
      asProvider(conceptTask.provider),
      this.estimatedEffort(conceptTask)
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
    usage.onRecord((entry) => hooks.onModel?.(entry.task, entry.resolvedModel || entry.model));
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (hooks.signal?.aborted) controller.abort();
    hooks.signal?.addEventListener("abort", forward, { once: true });
    this.activeJobs.add(controller);
    const signal = controller.signal;
    const commentaryTask = this.runTask(prepared, "commentary");
    const conceptTask = this.runTask(prepared, "concepts");
    try {
      const commentaryLlm = await this.providerFor("commentary", job, usage, signal, commentaryTask);
      const conceptLlm = await this.providerFor("concepts", job, usage, signal, conceptTask);
      const { preview, subject, url, pdfData } = prepared;
      let { plan, alignment } = prepared;
      const altData = preview.altData;

      if (!plan || !pdfData) {
        // No PDF: 1.x lecture-level note, generated by the CLI provider.
        hooks.onStep?.("overview");
        return await this.runLegacyImport(url, preview, subject, commentaryLlm, conceptLlm, hooks.onProgress, hooks.onConfirmUpdate, signal, prepared.notePath);
      }

      // Optional LLM check of the uncertain alignment spans (spec 4.3 step 3).
      const alignmentTask = this.runTask(prepared, "alignment");
      if (alignment && alignment.lowSpans.length > 0 && alignmentTask.provider !== "none") {
        hooks.onProgress?.("전사 정렬 확인 중...", 0);
        alignment = await this.checkAlignment(alignment, prepared.slideTexts, altData.title, job, usage, signal, alignmentTask);
        if (alignment.llmChanged > 0) plan = withTranscriptChunks(plan, alignment.chunks, settings.generation.transcriptCapChars);
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
      // Key diagram images (spec 4.8): rendered now, written after the note.
      const diagrams = await this.renderKeyDiagrams(pdfData, prepared.diagramPages, prepared.notePath);
      const diagramByPage = new Map(diagrams.map((d) => [d.page, d.path]));
      const slides = run.slidesResult.slides.map((sec) => (diagramByPage.has(sec.slideNum) ? { ...sec, diagram: diagramByPage.get(sec.slideNum) } : sec));
      const existingConceptNames = new Set(prepared.context.knownConcepts);
      const concepts = this.normalizeConcepts(run.concepts, existingConceptNames);
      const tags = run.tags;
      const providerLabel = `${PROVIDER_LABELS[commentaryTask.provider]}${commentaryTask.model ? " " + commentaryTask.model : ""}`;
      const errors = [
        ...run.slidesResult.errors,
        ...run.warnings.map((reason) => ({ slideNum: 0, reason })),
      ];
      const { lectureMarkdown, conceptNotes } = await new NoteGenerator(commentaryLlm).generatePageAnchored(
        altData,
        { ...run.slidesResult, slides, errors },
        { processedSummary: run.overview, concepts, tags, subjectSuggestion: subject, knownConceptNames: prepared.context.knownConcepts },
        subject,
        [
          formatUsageFrontmatter(usage.total(), providerLabel, {
            model: usage.modelFor("commentary") || commentaryTask.model,
            effort: commentaryTask.effort,
            conceptModel: usage.modelFor("concepts") ?? undefined,
          }),
          ...this.preservedFrontmatter(prepared.notePath, altData.metadata.sourceKind, alignment),
        ]
      );
      return await this.saveLecture({
        url,
        altData,
        subject,
        lectureMarkdown,
        conceptNotes,
        pdfData,
        notePath: prepared.notePath,
        bundle: preview.bundle,
        attachments: diagrams.filter((d) => slides.some((sec) => sec.diagram === d.path)),
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

  /** "기본값으로 저장" of a run's model choice: the task's saved setting (the preset becomes 사용자 지정). */
  async saveTaskDefault(task: TaskId, setting: TaskLLMSetting): Promise<void> {
    // In place: the settings tab and open panels hold this object.
    Object.assign(this.data.settings.tasks[task], sanitizeTask(setting, this.data.settings.tasks[task]));
    this.data.settings.preset = "custom";
    await this.savePluginData();
  }

  /** Models for the dropdowns: Claude Code's and Codex's own caches, and what each requested model last resolved to. */
  modelCatalog(): ModelCatalog {
    return { claude: this.claudeModels(), codex: this.codexModels(), resolved: this.data.resolvedModels ?? {} };
  }

  private claudeModelsCache: ModelInfo[] | null = null;

  /**
   * Claude models from Claude Code's model catalog cache
   * ($CLAUDE_CONFIG_DIR or ~/.claude, cache/model-catalog/*-cc.json, the
   * newest file). No process is started and no model is called. Empty (the
   * built-in list is used) when Claude Code has not written one.
   */
  claudeModels(): ModelInfo[] {
    if (this.claudeModelsCache) return this.claudeModelsCache;
    const dir = joinPath(process.env.CLAUDE_CONFIG_DIR || joinPath(homedir(), ".claude"), "cache", "model-catalog");
    let found: ModelInfo[] = [];
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith("-cc.json"))
        .map((f) => ({ f, t: statSync(joinPath(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (files.length > 0) found = parseClaudeModelCatalog(readFileSync(joinPath(dir, files[0].f), "utf8"));
    } catch {
      // No catalog yet.
    }
    if (found.length > 0) this.claudeModelsCache = found;
    return found;
  }

  /**
   * PNG renders (long edge 1600) of the key diagram pages, at
   * <subject folder>/Attachments/<lecture>-<page>.png. A page that fails to
   * render is left out (no embed pointing at a missing file).
   */
  private async renderKeyDiagrams(pdfData: ArrayBuffer, pages: number[], notePath: string): Promise<Array<{ page: number; path: string; data: ArrayBuffer }>> {
    if (pages.length === 0 || !this.pdfProcessor) return [];
    const images = await this.pdfProcessor.renderPagesToImages(pdfData, pages, 1600);
    return images.map((img) => {
      const buf = Buffer.from(img.base64Png, "base64");
      return {
        page: img.pageNum,
        path: attachmentPathForNote(notePath, img.pageNum),
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      };
    });
  }

  /** The alignment check call; a failure keeps the script alignment. */
  private async checkAlignment(
    alignment: LectureAlignment,
    slideTexts: string[],
    title: string,
    job: string,
    usage: UsageTracker,
    signal?: AbortSignal,
    setting?: TaskLLMSetting
  ): Promise<LectureAlignment> {
    try {
      const llm = await this.providerFor("alignment", job, usage, signal, setting);
      return await checkAlignmentWithLlm(llm, title, alignment, slideTexts, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn("[Alt2Obsidian] alignment check failed, keeping the script alignment:", e);
      return alignment;
    }
  }

  /** Abort every running CLI import (plugin unload). */
  abortAllJobs(): void {
    for (const c of this.activeJobs) c.abort();
  }

  /**
   * Cumulative usage, recently used models (spec 5.5, 4.2), and the id each
   * requested model resolved to (an alias such as "opus" is recorded with
   * the full id the CLI reported), so the dropdowns show "현재 ..." and the
   * settings "마지막 실행". The model of every call counts, including a
   * one-run choice from the sidebar.
   */
  private async recordUsage(usage: UsageTracker, countLecture = true): Promise<void> {
    this.data.usageTotals = accumulateTotals(this.data.usageTotals, usage, formatDate(), countLecture);
    const resolved = { ...(this.data.resolvedModels ?? {}) };
    for (const e of usage.entries()) {
      if (e.task === "notion-fetch") continue;
      rememberModel(this.data.settings, e.provider, e.model);
      if (e.resolvedModel) resolved[resolvedKey(e.provider, e.model)] = { id: e.resolvedModel, at: formatDate() };
    }
    this.data.resolvedModels = resolved;
    await this.savePluginData();
  }

  // ---- note verification (spec 4.6) ----

  /** The lecture note's PDF next to it: `<stem>.pdf`, or `<stem>.PDF`. */
  siblingPdf(notePath: string): TFile | null {
    const stem = notePath.replace(/\.md$/, "");
    for (const ext of [".pdf", ".PDF", ".Pdf"]) {
      const f = this.app.vault.getAbstractFileByPath(stem + ext);
      if (f instanceof TFile) return f;
    }
    return null;
  }

  /** Lecture notes the verifier can check against: the vault's Alt lecture notes. */
  verifyTargets(): VaultNoteInfo[] {
    return this.vaultLectureNotes().sort((a, b) => a.path.localeCompare(b.path, "ko", { numeric: true }));
  }

  /** Markdown files that can be the checked note (not lecture or verification notes). */
  verifySourceFiles(): string[] {
    const lectures = new Set(this.vaultLectureNotes().map((v) => v.path));
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => !lectures.has(f.path) && this.app.metadataCache.getFileCache(f)?.frontmatter?.source !== "alt2obsidian-verify")
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  }

  /**
   * Raw markdown of a Notion page through the user's Notion MCP (one Claude
   * CLI call that may only use the Notion fetch tool; the content is the
   * tool's result, not model text), cached outside the vault. The model
   * only calls the tool, so the light concept model is used when that task
   * is on the Claude CLI, else the CLI default, low effort. Cancel with
   * `signal`; plugin unload cancels it too.
   */
  /** The model the Notion fetch runs on: the concept task's model on the Claude CLI, else the CLI default; low effort. */
  notionFetchModel(): { model: string; effort: EffortLevel } {
    const concepts = this.data.settings.tasks.concepts;
    return { model: concepts.provider === "claude-cli" ? concepts.model.trim() : "", effort: "low" };
  }

  async fetchNotionMarkdown(url: string, signal?: AbortSignal): Promise<NotionFetchResult & { model: string }> {
    const settings = this.data.settings;
    const bin = await this.resolveBin("claude");
    const job = createJobDir();
    const usage = new UsageTracker();
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", forward, { once: true });
    this.activeJobs.add(controller);
    try {
      const { model, effort } = this.notionFetchModel();
      const provider = new NotionFetchProvider({
        bin,
        model,
        effort,
        timeoutMs: Math.max(30, settings.cliTimeoutSec || 300) * 1000,
        workDir: job,
        usage,
        task: "notion-fetch",
        signal: controller.signal,
        ownsWorkDir: false,
      });
      const page = await fetchNotionPage(provider, {
        bin,
        url,
        cacheDir: joinPath(this.vaultCacheDir(), "notion"),
        workDir: job,
        toolName: settings.notionFetchTool,
        signal: controller.signal,
      });
      return { ...page, model: usage.modelFor("notion-fetch") ?? model };
    } finally {
      signal?.removeEventListener("abort", forward);
      this.activeJobs.delete(controller);
      removeJobDir(job);
      if (usage.total().calls > 0) await this.recordUsage(usage, false).catch((e) => console.warn("[Alt2Obsidian] usage record failed:", e));
    }
  }

  /**
   * Claims, evidence and the estimate (no tokens): the lecture's slide texts
   * from its sibling PDF, its timestamped transcript and stored alignment
   * when it is an Alt local note.
   */
  async prepareVerification(input: { targetPath: string; markdown: string; source: string; sourcePath?: string }): Promise<PreparedVerification> {
    const target = this.app.vault.getAbstractFileByPath(input.targetPath);
    if (!(target instanceof TFile)) throw new Error(`강의 노트를 찾지 못했습니다: ${input.targetPath}`);
    if (!input.markdown.trim()) throw new Error("검증할 노트 내용이 비어 있습니다.");
    const outPath = verificationPathForNote(input.targetPath);
    if (input.sourcePath && (input.sourcePath === input.targetPath || input.sourcePath === outPath)) {
      throw new Error("강의 노트나 검증 결과 노트는 검증할 노트로 고를 수 없습니다.");
    }
    const pdf = this.siblingPdf(input.targetPath);
    if (!pdf || !this.pdfProcessor) throw new Error(`강의 PDF가 없어 슬라이드와 대조할 수 없습니다: ${input.targetPath.replace(/\.md$/, ".pdf")}`);
    const layouts = await this.pdfProcessor.getPageLayouts(await this.app.vault.readBinary(pdf));
    const slideTexts = layouts.map(layoutAlignmentText);
    const fm = this.app.metadataCache.getFileCache(target)?.frontmatter;
    let transcript: VerifyInput["transcript"] = null;
    if (typeof fm?.alt_local_id === "string" && fm.alt_local_id) {
      const segments = await this.loadTranscript(fm.alt_local_id);
      if (segments && segments.length > 0) {
        const spans = parseAlignment(fm.alt_alignment);
        transcript = { segments, spans: spans.length > 0 ? spans : null };
      }
    }
    const plan = planVerification({ lecture: target.basename, notePath: target.path, noteMarkdown: input.markdown, slideTexts, transcript });
    return this.withVerifyChoice({ targetPath: input.targetPath, outPath, source: input.source, plan }, this.data.settings.tasks.verification);
  }

  /**
   * The verification with a model for this run only (the panel's picker;
   * the saved setting is not changed), and its estimate for that choice.
   */
  withVerifyChoice(p: Pick<PreparedVerification, "targetPath" | "outPath" | "source" | "plan">, choice: TaskLLMSetting): PreparedVerification {
    const task = sanitizeTask(choice, this.data.settings.tasks.verification);
    const estimate = estimateVerification(p.plan, isCliProvider(task.provider) ? task.provider : "claude-cli", this.estimatedEffort(task));
    return {
      targetPath: p.targetPath,
      outPath: p.outPath,
      source: p.source,
      plan: p.plan,
      estimate,
      overCap: exceedsCap(estimate, this.data.settings.generation.tokenCapPerLecture),
      task,
    };
  }

  /**
   * Judge the claims and write Verification/<lecture> verification.md. Only
   * that note is written (its section after the managed block is kept); the
   * checked note is never modified. Usage is recorded even on failure.
   */
  async runVerification(
    prepared: PreparedVerification,
    hooks: { signal?: AbortSignal; onProgress?: (p: VerifyProgress) => void; onUsage?: (u: LLMUsage) => void; onModel?: (model: string) => void } = {}
  ): Promise<VerifyRunResult> {
    const task = prepared.task ?? this.data.settings.tasks.verification;
    if (task.provider === "none") throw new Error("노트 검증에 쓸 LLM이 설정되어 있지 않습니다.");
    const job = createJobDir();
    const usage = new UsageTracker();
    usage.onChange((total) => hooks.onUsage?.(total));
    usage.onRecord((entry) => hooks.onModel?.(entry.resolvedModel || entry.model));
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (hooks.signal?.aborted) controller.abort();
    hooks.signal?.addEventListener("abort", forward, { once: true });
    this.activeJobs.add(controller);
    try {
      const llm = await this.providerFor("verification", job, usage, controller.signal, task);
      const result = await runNoteVerification(prepared.plan, llm, { signal: controller.signal, onProgress: hooks.onProgress });
      if (controller.signal.aborted) throw new CliRunError("aborted", "취소되었습니다");
      // Nothing judged at all (usage limit, CLI failure): keep the previous result note.
      const judged = result.items;
      if (judged.length > 0 && judged.every((i) => i.verdict === null)) {
        throw new Error(`주장을 하나도 판정하지 못해 결과 노트를 쓰지 않았습니다: ${judged[0].reason}`);
      }
      const used = usage.modelFor("verification") || task.model;
      const label = `${PROVIDER_LABELS[task.provider]}${task.model ? " " + task.model : ""}`;
      const next = renderVerificationNote(result, {
        source: prepared.source,
        date: formatDate(),
        usageLine: usage.total().calls > 0 ? formatUsageFrontmatter(usage.total(), label, { model: used, effort: task.effort }) : null,
        model: used && used !== task.model ? `${label} (${used})` : label,
      });
      const existing = await this.vaultManager!.readNoteIfExists(prepared.outPath);
      const path = await this.vaultManager!.saveNote(mergeVerificationNote(existing, next), prepared.outPath);
      return { path, counts: verdictCounts(result), warnings: result.warnings };
    } finally {
      hooks.signal?.removeEventListener("abort", forward);
      this.activeJobs.delete(controller);
      removeJobDir(job);
      if (usage.total().calls > 0) {
        await this.recordUsage(usage, false).catch((e) => console.warn("[Alt2Obsidian] usage record failed:", e));
      }
    }
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
      // Every candidate's --version and --help are read (no model call): one
      // missing a flag the providers pass is skipped, the newest usable one wins.
      const resolved = await resolveCliBinary(name, {
        configuredPath: name === "claude" ? settings.claudePath : settings.codexPath,
        cachedPath: force ? undefined : this.data.cliDetection[name]?.path,
        checkFeatures: true,
        readVersion: (bin) => readCliVersion(bin),
      });
      const detection: CliDetection = { path: resolved.path, version: resolved.version ?? "", detectedAt: new Date().toISOString(), featuresOk: true };
      if (resolved.warning) detection.warning = resolved.warning;
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

  private codexModelsCache: CodexModels | null = null;

  /**
   * Models and their effort levels for the Codex dropdowns, from Codex's own
   * models cache ($CODEX_HOME or ~/.codex, models_cache.json). No process is
   * started and no model is called. A found list is kept for the session;
   * an empty one (Codex never ran yet) is read again next time.
   */
  codexModels(): CodexModels {
    if (this.codexModelsCache) return this.codexModelsCache;
    const home = process.env.CODEX_HOME || joinPath(homedir(), ".codex");
    let found: CodexModels = { models: [], efforts: {} };
    try {
      found = parseCodexModels(readFileSync(joinPath(home, "models_cache.json"), "utf8"));
    } catch {
      // No cache yet.
    }
    if (found.models.length > 0) this.codexModelsCache = found;
    return found;
  }

  /** Path of the CLI for a call: the cached lookup when still valid, else a new lookup. */
  async resolveBin(name: CliName): Promise<string> {
    const configured = (name === "claude" ? this.data.settings.claudePath : this.data.settings.codexPath).trim();
    const cached = this.data.cliDetection[name];
    // A cached path from before the feature check is checked again.
    if (cached && (!configured || configured === cached.path) && isExecutable(cached.path) && cached.featuresOk) return cached.path;
    const found = await this.detectCli(name, !!cached && !cached.featuresOk);
    if (!found) throw new Error(this.cliErrors[name] || cliNotFoundMessage(name));
    return found.path;
  }

  /**
   * Once after a migration (fresh install, 1.x data, or tasks moved off the
   * removed Gemini/Ollama providers). Nothing here calls a model: the checks
   * are `--version`, `--help` and `claude auth status`. The Claude CLI stays
   * when it is logged in; otherwise the Codex CLI takes its tasks when it is
   * installed.
   */
  private async applyCliDefaultOnce(): Promise<void> {
    await this.showFilledNotice();
    if (!this.data.pendingCliDefault) return;
    const claude = await this.detectCli("claude");
    const claudeUsable = !!claude && (await probeCliLogin("claude", claude.path));
    const codexFound = claudeUsable ? false : !!(await this.detectCli("codex"));
    const cli = chooseCli(claudeUsable, codexFound);
    // Only the tasks the migration itself set; a task the user put on the Claude CLI stays.
    const moved = this.data.pendingMovedTasks ?? [];
    if (cli === "codex-cli") moveClaudeTasksToCodex(this.data.settings, moved);
    const notice = this.data.removedProviderNotice;
    const removedFrom = Array.isArray(notice) ? notice : notice ? (["gemini"] as Array<"gemini" | "ollama">) : [];
    delete this.data.pendingCliDefault;
    delete this.data.pendingMovedTasks;
    delete this.data.removedProviderNotice;
    if (removedFrom.length > 0) {
      // Data written by beta.4 has no pendingMovedTasks: its Gemini/Ollama
      // tasks were already put on the Claude CLI then and nothing moves now.
      const target = cli === null ? null : moved.length > 0 ? cli : "claude-cli";
      const hint =
        target === "claude-cli" && cli === "codex-cli"
          ? " 로그인된 Claude CLI가 없습니다. Claude에 로그인하거나 설정의 '작업별 모델'에서 Codex CLI로 바꾸세요."
          : "";
      new Notice(removedProviderMessage(removedFrom, target) + hint, 15000);
    } else if (cli === "codex-cli" && moved.length > 0) {
      new Notice("Alt2Obsidian: 로그인된 Claude CLI가 없어 작업을 Codex CLI로 설정했습니다. 설정의 '작업별 모델'에서 확인하세요.");
    } else if (!cli) {
      new Notice("Alt2Obsidian: Claude Code나 Codex CLI가 필요합니다. 설치하고 로그인한 뒤 설정의 'LLM 연결'에서 '다시 찾기'를 누르세요.");
    }
    await this.savePluginData();
  }

  /** Once after the version 3 migration filled empty model/effort values. */
  private async showFilledNotice(): Promise<void> {
    const lines = this.data.pendingFilledNotice;
    if (!lines || lines.length === 0) return;
    new Notice(
      "Alt2Obsidian: 'CLI 기본값'(빈 칸)이던 모델과 effort를 작업 기본값으로 바꿨습니다.\n" +
        lines.join("\n") +
        "\n설정의 '작업별 모델'에서 다시 'CLI 기본값'으로 돌릴 수 있습니다.",
      15000
    );
    delete this.data.pendingFilledNotice;
    await this.savePluginData();
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
    signal?: AbortSignal,
    notePath?: string
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

    const vm = this.vaultManager!;
    notePath = notePath ?? lecturePath(vm.getBasePath(), subject, altData.title);
    const noteGenerator = new NoteGenerator(llm);
    const { lectureMarkdown } = await noteGenerator.generate(
      altData,
      {
        processedSummary: altData.summary,
        concepts: [],
        tags: [],
        subjectSuggestion: subject,
      },
      subject,
      this.preservedFrontmatter(notePath, altData.metadata.sourceKind, null)
    );
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
      pdfPath = await vm.saveRawFile(pdfData, notePath.replace(/\.md$/, ".pdf"));
    }

    onProgress?.("완료!", 100);

    const record: ImportRecord = {
      url,
      title: altData.title,
      subject,
      path: notePath,
      date: formatDate(),
      parseQuality: "partial",
      altId: altData.metadata.sourceKind === "alt-local" ? undefined : altData.metadata.noteId || undefined,
      altLocalId: altData.metadata.sourceKind === "alt-local" ? altData.metadata.noteId : undefined,
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

  /** Concepts as written to the vault (see `normalizeConcepts` in src/core/conceptNames.ts). */
  private normalizeConcepts(concepts: ConceptData[], existingConceptNames: Set<string>): ConceptData[] {
    return normalizeConcepts(concepts, existingConceptNames);
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
      const key = item.altLocalId || item.altId || item.url || item.path;
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
    if (a.altLocalId && b.altLocalId) return a.altLocalId === b.altLocalId;
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
    const { settings, needsCliDefault, movedTasks, removedFrom, filled } = migrateSettings(saved.settings);
    this.data.settings = settings;
    // Removed in 2.0.0-beta.4 with the Gemini/Ollama providers.
    delete (this.data as { cliSwitchOffered?: boolean }).cliSwitchOffered;
    this.data.recentImports = Array.isArray(saved.recentImports) ? saved.recentImports : [];
    this.data.cliDetection = { ...(saved.cliDetection ?? {}) };
    this.data.usageTotals = {
      ...DEFAULT_PLUGIN_DATA.usageTotals,
      ...(saved.usageTotals ?? {}),
      byProvider: { ...(saved.usageTotals?.byProvider ?? {}) },
    };
    if (needsCliDefault) {
      this.data.pendingCliDefault = true;
      this.data.pendingMovedTasks = movedTasks;
    }
    if (removedFrom.length > 0) this.data.removedProviderNotice = removedFrom;
    if (filled.length > 0) this.data.pendingFilledNotice = describeFilled(filled);
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }
}
