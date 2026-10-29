import { editorLivePreviewField, MarkdownView, normalizePath, Plugin, Notice, WorkspaceLeaf } from "obsidian";
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
  ImageInput,
  LLMUsage,
  ProviderId,
  TaskId,
  TaskLLMSetting,
} from "./types";
import { AltPublicUrlSource } from "./sources/AltPublicUrlSource";
import { AltLocalSource, altUserDataDir, connectAltLocal, ConnectResult, inferSubject, LectureBundle } from "./sources";
import { alignLecture, buildAlignmentCheckPrompt, checkAlignmentWithLlm, LectureAlignment } from "./pipeline/alignment";
import { layoutAlignmentText } from "./core/prep/pageLayout";
import { computeSlideHash, normalizePageText } from "./core/slideHash";
import { hasMultiManagedMarkers, splitMultiManagedNote, splitSectionNote, toLf } from "./core/merge";
import { isLinkCandidate, LectureKind, lectureKind, LocalNoteStatus, MissingPdfError, slideChangeCount, VaultNoteInfo } from "./core/noteStatus";
import { hasSectionMarkers, headingLinkTarget } from "./core/sections";
import { ATTACHED_LINE, attachedPdfPath, looksLikePdf, markedAttached, MAX_ATTACH_BYTES, sha1Hex } from "./core/pdfAttach";
import { parseExistingSections, planTranscript, TranscriptPlan, verifySectionsFromNote } from "./pipeline/transcriptPlan";
import { estimateTranscriptSummary, runTranscriptSummary } from "./pipeline/transcriptPipeline";
import { choose, pickPdf, PickedPdf } from "./ui/attachPdf";
import { PdfProcessor } from "./pdf/PdfProcessor";
import { createPdfWorkerUrl } from "./pdf/pdfWorker";
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
  LEGACY_KEY_FIELDS,
  migrateSettings,
  describeFilled,
  isCliProvider,
  moveClaudeTasksToCodex,
  moveOldTranscriptCap,
  parseClaudeModelCatalog,
  parseCodexModels,
  removedProviderMessage,
  PROVIDER_LABELS,
  rememberModel,
  resolvedKey,
  sanitizeTask,
  estimateEffort,
  withTasksSinceV4,
} from "./settings/llmSettings";
import { analyzeSlides, selectKeyDiagrams } from "./core/prep/SlideAnalyzer";
import { DeckPlan, makeBatches, parseExistingSlides, planDeck, withFewerImages, withTranscriptChunks } from "./pipeline/batchPlan";
import { estimateLecture, PipelineStep, runBatchedLecture } from "./pipeline/lecturePipeline";
import type { BatchProgress, LectureContext } from "./generator/BatchCommentaryGenerator";
import {
  BudgetEstimate,
  CallShape,
  CONCEPTS_OUTPUT_TOKENS,
  estimateCalls,
  estimateTextTokens,
  exceedsCap,
  LECTURE_NOTE_CHARS,
  LECTURE_NOTE_OUTPUT_TOKENS,
  textStandIn,
} from "./core/budget/estimate";
import { MATERIAL_MAX_CHARS } from "./core/lectureMaterial";
import conceptExtractionTemplateText from "../prompts/concept-extraction.md";
import { ConceptExtractor } from "./generator/ConceptExtractor";
import { insertFrontmatterLine, NoteGenerator, preservedFrontmatterLines, removeFrontmatterLine } from "./generator/NoteGenerator";
import { VaultManager } from "./vault/VaultManager";
import { Alt2ObsSettingsTab } from "./ui/SettingsTab";
import {
  Alt2ObsSidebarView,
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
import { attachmentPathForNote, briefPathForNote, lecturePath, stemOf, subjectFolderOfNote, verificationPathForNote } from "./vault/layout";
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
import { parseAlignment, spansForSlide } from "./core/prep/TranscriptAligner";
import { applyLayoutMigration, MigrationPlan, MigrationResult, planLayoutMigration, VaultFileEntry } from "./vault/layoutMigration";
import { MigrationModal } from "./ui/MigrationModal";
import { AllBriefsPlan, AllBriefsResult, BriefsModal } from "./ui/BriefsModal";
import { normalizeConcepts } from "./core/conceptNames";
import { decidePdfOpen, isLectureFrontmatter, isLectureNote, lectureNoteForPdf } from "./ui/pdfOpen";
import { aiInputFor, BriefAiStep, BriefFiles, readLectureBrief, updateLectureBrief } from "./brief/briefStore";
import { aiPartStatus, BRIEF_AI_OUTPUT_TOKENS, BRIEF_AI_SCHEMA, briefAiInput } from "./brief/briefAi";
import { commentaryText, fmString, isBriefFrontmatter, memoText, parseLectureNote, readFrontmatter } from "./brief/lectureNote";
import { aiOf, briefChatBody, buildBriefScript, composeBrief, isEditedBrief, neighbourLectures, subjectOfNote } from "./brief/lectureBrief";
import { ChatBriefState, ChatLecture, ChatView, SlideMaterial } from "./ui/ChatView";
import { ChatPanelController, VIEW_TYPE_CHAT } from "./ui/chatPanel";
import { ChatErrorInfo, ChatRunRequest, ChatRunResult, ThreadStore } from "./chat/threads";
import { formatTranscriptLines, segmentsInSpans, TEXTLESS_PAGE_CHARS, TimedText, transcriptLines } from "./chat/contextPack";
import { SLIDE_TEXT_STANDIN_TOKENS, SlideRow } from "./chat/addMaterial";
import { isAuthError, isUsageLimitError } from "./llm/cli/CliProviderBase";
import { renderPrompt } from "./prompts/render";
// The lecture-level note (no slide plan, no transcript sections) is the
// whole body, so it gets the full-note prompts; the short summary-*.md
// overviews are for the Skill's slide path only.
import lectureNoteFromTranscriptTemplate from "../prompts/lecture-note-from-transcript.md";
import lectureNoteEnhanceTranscriptTemplate from "../prompts/lecture-note-enhance-transcript.md";
import lectureNoteEnhanceMaterialTemplate from "../prompts/lecture-note-enhance-material.md";
import lectureNoteFromMaterialTemplate from "../prompts/lecture-note-from-material.md";
import lectureNoteSystemTemplate from "../prompts/lecture-note.system.md";
import subjectDetectionTemplate from "../prompts/subject-detection.md";

/** A CLI import after prep and estimate, before any LLM call. */
export interface PreparedImport {
  url: string;
  preview: ImportPreview;
  subject: string;
  notePath: string;
  pdfData: ArrayBuffer | null;
  /** Slide plan; null without a PDF (then `transcriptPlan`, or the lecture-level flow). */
  plan: DeckPlan | null;
  /**
   * Lecture without slides, the user chose "요약 노트 만들기" (spec 4.10):
   * transcript sections summarized into a summary note. Null otherwise.
   */
  transcriptPlan: TranscriptPlan | null;
  /**
   * Where the slides PDF comes from: Alt (or the URL), a PDF the user
   * attached in the plugin, or the vault copy next to a slide note whose
   * Alt PDF cannot be read now; null without a PDF.
   */
  pdfSource: "alt" | "attached" | "vault" | null;
  /** Alt (or the URL) has a slides PDF too, but the attached one is used. */
  altPdfIgnored: boolean;
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
  /** What the lecture brief's AI part will do (2.1.0 spec 4.5): the estimate's "챗봇 브리프" row. */
  brief: BriefEstimatePlan;
}

/**
 * The brief's AI part in an import estimate: a call (with the prompt it
 * would send, regenerated gists counted as stand-ins), or why there is
 * none: the setting (off, script only), no timestamped transcript, no
 * candidate sentence, a brief the user edited, or the same input as the
 * AI part already there.
 */
export interface BriefEstimatePlan {
  state: "off" | "script" | "no-transcript" | "no-candidates" | "edited" | "unchanged" | "call";
  promptText?: string;
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
  /** A step after the note was saved went wrong (the lecture brief's AI part): one line for the progress panel. */
  onWarning?: (text: string) => void;
}

/** What the import's brief step needs from the run (spec 4.4, 4.5). */
interface BriefStepContext {
  /** The brief task of this run (the estimate panel's picker, else the setting). */
  task: TaskLLMSetting;
  /** The lecture's timestamped transcript from the import; null: read from the cache or Alt. */
  transcript: TimedText[] | null;
  signal?: AbortSignal;
  onWarning?: (text: string) => void;
}

/**
 * The id 2.0.0 was released under. From 2.0.1 the plugin has its directory
 * id "alt2obsidian" again (spec D13), so to Obsidian 2.0.0 is another
 * plugin: its folder is only ever read.
 */
const ALT_TO_OBS_ID = "alt-to-obs";

/** View types of 2.0.0, and the ones that replace them (those of 1.x and the betas). */
const ALT_TO_OBS_VIEW_TYPES: Record<string, string> = {
  "alt-to-obs-sidebar": VIEW_TYPE_SIDEBAR,
  "alt-to-obs-synced-viewer": VIEW_TYPE_SYNCED_VIEWER,
};

/** 2.0.0's data.json: not there, there but unreadable, or its content; with its modification time when known. */
type AltToObsRead =
  | { state: "missing" }
  | { state: "unreadable"; error: string; mtime: number | null }
  | { state: "ok"; data: Record<string, unknown>; mtime: number | null };

/** The timestamped part of an import's transcript (local sources), null without one. */
function timedTranscript(bundle: LectureBundle | undefined): TimedText[] | null {
  const timed = (bundle?.transcript ?? [])
    .filter((s) => s.startMs !== null && s.endMs !== null)
    .map((s) => ({ startMs: s.startMs as number, endMs: s.endMs as number, text: s.text }));
  return timed.length > 0 ? timed : null;
}

/** Saved data without the API keys of 1.x and 2.0.0-beta.3 (nothing reads them; they are not carried over). */
function withoutLegacyKeys(data: Record<string, unknown>): Record<string, unknown> {
  const settings = data.settings;
  if (!settings || typeof settings !== "object") return data;
  const kept = { ...(settings as Record<string, unknown>) };
  for (const k of LEGACY_KEY_FIELDS) delete kept[k];
  return { ...data, settings: kept };
}

export default class Alt2ObsPlugin extends Plugin {
  data: PluginData = DEFAULT_PLUGIN_DATA;
  vaultManager: VaultManager | null = null;

  private urlSource = new AltPublicUrlSource();
  private pdfProcessor: PdfProcessor | null = null;
  /** Current Alt local source (API or database copy); see `connectLocal`. */
  private localSource: AltLocalSource | null = null;
  /** Slide hashes of local PDFs by path + size + mtime (sidebar status). */
  private textCache = new Map<string, Array<string | null>>();
  private pageCountCache = new Map<string, number>();
  /** Question threads by lecture note, kept while the plugin runs (2.1.0 spec 5.1). */
  chatThreads = new ThreadStore();
  /** Opens and closes the question panel. */
  private chatPanel: ChatPanelController | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    // Initialize vault manager
    this.vaultManager = new VaultManager(
      this.app,
      this.data.settings.baseFolderPath
    );

    // The PDF.js worker is inside main.js and runs from a Blob URL (revoked on unload).
    this.pdfWorkerUrl = createPdfWorkerUrl();
    this.pdfProcessor = new PdfProcessor(this.pdfWorkerUrl);

    // Register sidebar view
    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
      return new Alt2ObsSidebarView(leaf, this);
    });

    // Register Synced Viewer (Task 1.5, A2 default)
    this.registerView(VIEW_TYPE_SYNCED_VIEWER, (leaf) => {
      return new SyncedViewerView(
        leaf,
        (id) => this.loadTranscript(id),
        () => this.data.settings.hideManagedComments,
        (pdfPath) => this.openNativePdf(pdfPath),
        { toggle: () => void this.toggleChatPanel(), isOpen: () => !!this.chatPanel?.isOpen() }
      );
    });

    // The question panel (2.1.0 spec 5): on demand in the right sidebar.
    this.chatPanel = new ChatPanelController(this.app.workspace, (open) => this.showChatOpen(open));
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

    // Attached PDF copies are tracked by path: follow renames and moves (spec 4.10).
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onVaultRename(file, oldPath).catch((e) => console.warn("[Alt2Obs] attach record update failed:", e))));

    // Live Preview: hide the alt2obs management comment lines (setting "관리 주석 숨기기").
    this.registerEditorExtension(this.editorExtensions);
    this.applyCommentHiding();

    // Add ribbon icon
    this.addRibbonIcon("book-open", "Alt 강의 가져오기", () => {
      void this.activateSidebarView();
    });

    // Add command
    this.addCommand({
      id: "open-sidebar",
      name: "Open sidebar",
      callback: () => this.activateSidebarView(),
    });

    this.addCommand({
      id: "import-note",
      name: "Import lecture note (local list or URL)",
      callback: () => this.activateSidebarView(),
    });

    this.addCommand({
      id: "migrate-vault-layout",
      name: "Migrate 1.x vault layout",
      callback: () => new MigrationModal(this.app, this.planVaultMigration(), (plan) => this.applyVaultMigration(plan)).open(),
    });

    // 2.0.0's data (id alt-to-obs) on request, e.g. after it was left out as older (spec D13).
    this.addCommand({
      id: "import-alt-to-obs-settings",
      name: "Import settings from version 2.0.0 (alt-to-obs)",
      callback: () => this.confirmAltToObsImport(),
    });

    // Offered while a note or a PDF is open (the same test as the commands'); they say when it is not a lecture's.
    const noteOrPdfOpen = () => {
      const ext = this.app.workspace.getActiveFile()?.extension;
      return ext === "md" || ext?.toLowerCase() === "pdf";
    };
    this.addCommand({
      id: "open-synced-viewer",
      name: "Open synced viewer (PDF + lecture .md)",
      checkCallback: (checking) => {
        if (!noteOrPdfOpen()) return false;
        if (!checking) void this.openSyncedViewerForActiveNote();
        return true;
      },
    });

    this.addCommand({
      id: "attach-lecture-pdf",
      name: "Attach lecture PDF to the current lecture note",
      checkCallback: (checking) => {
        if (!noteOrPdfOpen()) return false;
        if (!checking) void this.attachPdfToActiveNote();
        return true;
      },
    });

    this.addCommand({
      id: "toggle-question-panel",
      name: "질문 패널 열기/닫기",
      callback: () => void this.toggleChatPanel(),
    });

    this.addCommand({
      id: "build-all-briefs",
      name: "모든 강의 브리프 만들기",
      callback: () => new BriefsModal(this.app, this).open(),
    });

    this.addCommand({
      id: "rebuild-brief",
      name: "이 강의 브리프 다시 만들기",
      callback: () => void this.activeLectureNote().then((path) => this.rebuildBrief(path)).catch((e) => new Notice(`브리프를 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`)),
    });

    // Register settings tab
    this.addSettingTab(new Alt2ObsSettingsTab(this.app, this));

    // The login-shell lookup can take a moment: run it after startup.
    this.app.workspace.onLayoutReady(() => {
      this.showAltToObsNotices().catch((e) => console.warn("[Alt2Obs] 2.0.0 notice failed:", e));
      this.adoptAltToObsLeaves().catch((e) => console.warn("[Alt2Obs] 2.0.0 view tabs not converted:", e));
      this.applyCliDefaultOnce().catch((e) => console.warn("[Alt2Obs] CLI default check failed:", e));
      this.pruneAttachRecords().catch((e) => console.warn("[Alt2Obs] attach record prune failed:", e));
      // The question panel opens only on demand: a panel restored with the layout goes.
      this.chatPanel?.detachRestored();
      // Lecture PDFs opened from now on go to the Synced Viewer (setting
      // "강의 PDF를 열면 뷰어로 열기"). Registered after the layout is
      // restored, and the PDF tabs it restored are left as plain PDFs.
      if (this.data.settings.openPdfInViewer) this.keepOpenPdfTabsPlain();
      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          if (file instanceof TFile) void this.onPdfOpened(file).catch((e) => console.warn("[Alt2Obs] lecture PDF redirect failed:", e));
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
        this.pruneTranscriptCache().catch((e) => console.warn("[Alt2Obs] transcript cache prune failed:", e));
      })
    );
  }

  onunload(): void {
    // Kill running CLI processes; their finally blocks remove the temp folders.
    this.abortAllJobs();
    this.unloaded = true;
    // Running answers stop with the plugin; the panel's close (before or after this) changes nothing more.
    this.chatThreads.dropAll();
    this.chatPanel?.dispose();
    this.localSource?.close?.();
    this.localSource = null;
    if (this.pdfWorkerUrl) URL.revokeObjectURL(this.pdfWorkerUrl);
    this.pdfWorkerUrl = null;
  }
  private unloaded = false;
  /** Blob URL of the bundled PDF.js worker (src/pdf/pdfWorker.ts). */
  private pdfWorkerUrl: string | null = null;

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
    // A lecture without slides (spec 4.10) has no viewer: say why, offer "PDF 첨부".
    if (!pdfFile || this.frontmatterOf(mdPath)?.alt_kind === "transcript") {
      if (isLectureFrontmatter(this.frontmatterOf(mdPath))) {
        await this.explainNoViewer(mdPath);
        return;
      }
      new Notice(`같은 폴더에 같은 이름의 PDF가 없습니다: ${mdPath.replace(/\.md$/, ".pdf")}. 강의를 가져오면 PDF가 함께 저장됩니다.`);
      return;
    }
    await this.openSyncedViewer(mdPath, pdfFile.path);
  }

  /** Command "Attach lecture PDF": the open lecture note (or its PDF) gets a PDF; the next import makes it a slide note. */
  async attachPdfToActiveNote(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    const mdPath = active?.extension.toLowerCase() === "pdf" ? active.path.replace(/\.pdf$/i, ".md") : active?.extension === "md" ? active.path : null;
    if (!mdPath || !isLectureFrontmatter(this.frontmatterOf(mdPath))) {
      new Notice("Alt에서 가져온 강의 노트를 연 뒤 다시 시도하세요.");
      return;
    }
    await this.attachPdfInteractive(mdPath);
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
    // 2.0.0 (id alt-to-obs), still enabled, would turn this PDF into its own viewer: two would race on one tab.
    // It leaves PDFs alone too while this plugin is enabled, so none is redirected until it is off.
    if (await this.altToObsEnabled()) return;
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
      viewType: stillShown ? leaf.view.getViewType() : null,
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
        void this.app.workspace.revealLeaf(same);
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
      void this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_SYNCED_VIEWER,
      active: true,
      state: { mdPath, pdfPath },
    });
    void this.app.workspace.revealLeaf(leaf);
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
    return planLayoutMigration(normalizePath(this.data.settings.baseFolderPath), files);
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
   * Phase 1 (preview): scrape page and defer PDF download until import.
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
      // A lecture brief carries the lecture's alt_local_id but is not the lecture.
      if (!fm || (!fm.alt_local_id && !fm.alt_id) || isBriefFrontmatter(fm)) continue;
      out.push({
        path: file.path,
        title: typeof fm.title === "string" ? fm.title : file.basename,
        subject: typeof fm.subject === "string" ? fm.subject : undefined,
        altLocalId: typeof fm.alt_local_id === "string" ? fm.alt_local_id : undefined,
        altId: typeof fm.alt_id === "string" ? fm.alt_id : undefined,
        altCreated: typeof fm.alt_created === "string" ? fm.alt_created : undefined,
        kind: typeof fm.alt_kind === "string" ? fm.alt_kind : undefined,
        slideNote: fm.slide_count !== undefined && fm.slide_count !== null,
        pdfSource: typeof fm.alt_pdf_source === "string" ? fm.alt_pdf_source : undefined,
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
      console.warn("[Alt2Obs] slide text check failed:", e);
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
    // One line inserted as text (processFrontMatter would reformat the YAML), atomically.
    await this.app.vault.process(file, (content) => insertFrontmatterLine(content, `alt_local_id: ${JSON.stringify(localId)}`));
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
      // Alt2Obs (Alt2Obsidian) note with no id at all (never another lecture's note).
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
    return preservedFrontmatterLines(this.frontmatterOf(notePath), sourceKind, alignment?.value || null);
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

  /** The transcript from this vault's cache only (nothing asked of Alt), null when it is not there. */
  async cachedTranscript(localId: string): Promise<TimedText[] | null> {
    try {
      const json = JSON.parse(await fsp.readFile(this.transcriptCachePath(localId), "utf8")) as { segments?: unknown } | null;
      if (Array.isArray(json?.segments)) {
        return (json.segments as Array<[number, number, string]>).map(([startMs, endMs, text]) => ({ startMs, endMs, text }));
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("[Alt2Obs] transcript cache unreadable:", e);
    }
    return null;
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
    const cached = await this.cachedTranscript(localId);
    if (cached) return cached;
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
      console.warn("[Alt2Obs] transcript load failed:", e);
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
      cliFeatures: (name) => this.data.cliDetection[name]?.optionalFeatures ?? [],
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
    notePathOverride?: string,
    brief?: BriefStepContext
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
        notePathOverride ?? this.resolveNotePath(preview, subject),
        brief
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
          renderPrompt(lectureNoteFromTranscriptTemplate, {
            memoContext,
            transcript: transcriptText,
          }),
          {
            systemPrompt: renderPrompt(lectureNoteSystemTemplate, {}),
            maxOutputTokens: 8192,
          }
        );
      } else if (!summaryAlreadyDetailed) {
        onProgress?.("트랜스크립트로 요약 보강 중...", 10);

        altData.summary = await llm.generateText(
          renderPrompt(lectureNoteEnhanceTranscriptTemplate, {
            summary: altData.summary,
            transcript: transcriptText,
          }),
          {
            systemPrompt: renderPrompt(lectureNoteSystemTemplate, {}),
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
      brief,
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
    /** The brief step's run context (its model, the transcript). */
    brief?: BriefStepContext;
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
      // Sibling of the note (the Synced Viewer looks for <note>.pdf); an existing <note>.PDF is reused.
      pdfPath = await vm.saveRawFile(pdfData, this.siblingPdf(notePath)?.path ?? `${noteStem}.pdf`);
    }
    // Same path on every import: an image is replaced, never duplicated.
    for (const a of args.attachments ?? []) await vm.saveRawFile(a.data, a.path);
    await this.cacheTranscript(args.bundle).catch((e) => console.warn("[Alt2Obs] transcript cache write failed:", e));
    void this.pruneTranscriptCache(args.bundle ? [args.bundle.sourceId] : []).catch(() => undefined);
    await this.writeBriefAfterImport(notePath, args.brief, onProgress);

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
   *
   * The slides PDF is Alt's (or the URL's), else a PDF the user attached
   * next to the note (spec 4.10; an attached PDF also wins over Alt's). A
   * lecture with no PDF at all stops here with a MissingPdfError unless
   * `withoutPdf: "summary"` says the user chose "요약 노트 만들기": then its
   * transcript is cut into sections for a summary note (or, without a
   * transcript, the lecture-level note is made from Alt's summary). There is
   * no silent fallback to a note without slides.
   */
  async prepareCliImport(
    url: string,
    preview: ImportPreview,
    subjectOverride: string | undefined,
    onProgress?: (stage: string, percent: number) => void,
    opts: { withoutPdf?: "summary" } = {}
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
    const partial = altData.parseQuality === "partial";
    const notePath = this.resolveNotePath(preview, subject);
    const context: LectureContext = {
      title: altData.title,
      subjectTags: vm.getSubjectTags(subject),
      knownConcepts: Array.from(await vm.getExistingConceptNames(subject)),
    };

    onProgress?.("PDF 내려받는 중...", 10);
    const download = partial ? { data: null, error: null } : await this.fetchAltPdf(preview);
    const altPdf = download.data;
    const existingNote = await vm.readNoteIfExists(notePath);
    // The slides PDF, in this order (one that cannot be read is skipped):
    // - a PDF the user attached: the note is marked, or there is no note yet
    //   (attachPdf marks every existing note), so it wins over Alt's;
    // - Alt's (or the URL's);
    // - the copy an earlier import saved next to a note that is not a
    //   summary note (a slide note whose Alt PDF cannot be read now).
    // "요약 노트 만들기" is the user's explicit choice: no PDF then.
    const sibling = this.siblingPdf(notePath);
    const marked = markedAttached(existingNote);
    const summaryNote = !!existingNote && hasSectionMarkers(existingNote) && !hasMultiManagedMarkers(existingNote);
    const attachedFirst = !!sibling && (marked || !existingNote);
    const candidates: Array<{ source: NonNullable<PreparedImport["pdfSource"]>; load: () => Promise<ArrayBuffer> }> = [];
    if (opts.withoutPdf !== "summary") {
      if (sibling && attachedFirst) candidates.push({ source: "attached", load: () => this.app.vault.readBinary(sibling) });
      if (altPdf) candidates.push({ source: "alt", load: async () => altPdf });
      if (sibling && !attachedFirst && !summaryNote) candidates.push({ source: "vault", load: () => this.app.vault.readBinary(sibling) });
    }
    let pdfData: ArrayBuffer | null = null;
    let pdfSource: PreparedImport["pdfSource"] = null;
    let plan: DeckPlan | null = null;
    let alignment: LectureAlignment | null = null;
    let slideTexts: string[] = [];
    let unreadable: string | null = null;
    for (const c of this.pdfProcessor ? candidates : []) {
      const data = await c.load();
      onProgress?.("슬라이드 분석 중...", 20);
      let prep: Awaited<ReturnType<PdfProcessor["analyzeForPrep"]>>;
      try {
        prep = await this.pdfProcessor!.analyzeForPrep(data, (page, total) =>
          onProgress?.(`슬라이드 분석 (${page}/${total})...`, 20 + Math.round((page / total) * 60))
        );
      } catch (e) {
        unreadable = unreadable ?? (e instanceof Error ? e.message : String(e));
        continue;
      }
      const { layouts, grays } = prep;
      if (layouts.length === 0) {
        unreadable = unreadable ?? "페이지가 없음";
        continue;
      }
      const analysis = await analyzeSlides(layouts, grays, {
        sourceId: altData.metadata.noteId,
        imageRule: settings.generation.imageRule,
      });
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
        // Without reuse the old sections still back up the slides that fail (review H1).
        existing: existingNote ? parseExistingSlides(existingNote) : undefined,
        reuse: settings.generation.onlyChangedSlides,
      });
      pdfData = data;
      pdfSource = c.source;
      break;
    }
    let transcriptPlan: TranscriptPlan | null = null;
    if (!plan) {
      const segments = partial ? [] : preview.bundle?.transcript ?? [];
      const hasTranscript = segments.some((x) => x.text.trim().length > 0);
      if (opts.withoutPdf !== "summary") {
        throw new MissingPdfError(
          download.error
            ? `슬라이드 PDF를 내려받지 못했습니다 (${download.error}). 다시 시도하거나, 강의 PDF를 첨부하거나, 슬라이드 없이 요약 노트를 만들 수 있습니다.`
            : unreadable
              ? `슬라이드 PDF를 읽지 못했습니다 (${unreadable}). 다른 PDF를 첨부하거나 슬라이드 없이 요약 노트를 만들 수 있습니다.`
              : partial
                ? "Alt 노트 페이지를 일부만 읽었습니다 (제목과 설명만, PDF와 전사 없음). 강의 PDF를 첨부하거나 읽은 내용만으로 노트를 만들 수 있습니다."
                : "이 강의에는 슬라이드 PDF가 없습니다. 강의 PDF를 첨부하거나 슬라이드 없이 요약 노트를 만들 수 있습니다.",
          notePath,
          hasTranscript,
          download.error
        );
      }
      if (hasTranscript) {
        onProgress?.("전사를 구간으로 나누는 중...", 40);
        transcriptPlan = await planTranscript({
          segments,
          sourceId: altData.metadata.noteId,
          existing: existingNote ? parseExistingSections(existingNote) : undefined,
          reuse: settings.generation.onlyChangedSlides,
        });
      }
      // A slide note (or a summary note, without a transcript now) is never
      // replaced by a note without slides: stop before any token is spent.
      if (existingNote && hasMultiManagedMarkers(existingNote)) {
        throw new Error("이 강의에는 이미 슬라이드별 노트가 있어 슬라이드 없는 노트로 덮어쓰지 않습니다. Alt에서 슬라이드 PDF를 내려받거나 PDF를 첨부한 뒤 다시 가져오세요.");
      }
      if (existingNote && !transcriptPlan && hasSectionMarkers(existingNote)) {
        throw new Error("이 강의에는 전사 구간 요약 노트가 있는데 지금은 전사가 없어 덮어쓰지 않습니다. Alt에서 전사가 보이는지 확인한 뒤 다시 가져오세요.");
      }
    }
    onProgress?.("예산 산정 완료", 100);
    const diagramPages = plan && settings.generation.saveKeyDiagrams ? selectKeyDiagrams(plan.slides, plan.scanned) : [];
    const altPdfIgnored = pdfSource === "attached" && !!altPdf;
    const brief = await this.planBriefEstimate({ notePath, preview, subject, plan, transcriptPlan, alignment, existingNote });
    return this.withEstimate({ url, preview, subject, notePath, pdfData, plan, transcriptPlan, pdfSource, altPdfIgnored, context, fewerImages: false, alignment, slideTexts, diagramPages, overrides: {}, brief });
  }

  /**
   * What the brief step of this import will cost (spec 4.5): one call with
   * the prompt the run would send, or none (see BriefEstimatePlan). Gists
   * of slides the run generates are not known yet: a stand-in of a gist's
   * length is counted for each. With nothing generated the input is exact,
   * so an AI part already made from it means no call.
   */
  private async planBriefEstimate(o: {
    notePath: string;
    preview: ImportPreview;
    subject: string;
    plan: DeckPlan | null;
    transcriptPlan: TranscriptPlan | null;
    alignment: LectureAlignment | null;
    existingNote: string | null;
  }): Promise<BriefEstimatePlan> {
    const mode = this.data.settings.briefMode;
    if (mode !== "ai") return { state: mode === "off" ? "off" : "script" };
    const transcript = timedTranscript(o.preview.bundle);
    if (!transcript) return { state: "no-transcript" };
    const existingBrief = await this.briefFiles().read(briefPathForNote(o.notePath));
    if (existingBrief !== null && (await isEditedBrief(existingBrief))) return { state: "edited" };
    const old = o.existingNote ? await buildBriefScript(o.notePath, o.existingNote) : null;
    const script = old ? { ...old, title: o.preview.altData.title, subject: o.subject, alignment: o.alignment?.value ?? "" } : null;
    const generated = o.plan ? o.plan.slides.some((x) => x.mode === "llm") : o.transcriptPlan ? o.transcriptPlan.sections.some((x) => x.mode === "llm") : true;
    if (!generated && script && existingBrief !== null) {
      const exact = await aiInputFor(script, transcript);
      const had = aiOf(existingBrief);
      if (!exact) return { state: "no-candidates" };
      if (had.hash === exact.hash && aiPartStatus(had.part) === "ok") return { state: "unchanged" };
      return { state: "call", promptText: `${exact.system}\n\n${exact.user}` };
    }
    const units = o.plan ? o.plan.slides.length : o.transcriptPlan ? o.transcriptPlan.sections.length : 0;
    const known = new Map((script?.map ?? []).map((e) => [e.num, e]));
    const map = Array.from({ length: units }, (_, i) => known.get(i + 1) ?? { num: i + 1, range: "", text: "가".repeat(40) });
    const input = await briefAiInput({
      title: o.preview.altData.title,
      subject: o.subject,
      kind: o.plan ? "slides" : o.transcriptPlan ? "transcript" : "lecture",
      map,
      units,
      transcript,
      spans: parseAlignment(o.alignment?.value ?? ""),
    });
    return input ? { state: "call", promptText: `${input.system}\n\n${input.user}` } : { state: "no-candidates" };
  }

  /** Parsed frontmatter of a vault note, or null. */
  private frontmatterOf(path: string): Record<string, unknown> | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? (this.app.metadataCache.getFileCache(f)?.frontmatter ?? null) : null;
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
    const efforts = { commentaryEffort: this.estimatedEffort(commentary), conceptEffort: this.estimatedEffort(concepts) };
    let estimate: BudgetEstimate = p.plan
      ? estimateLecture(p.plan, p.context, p.preview.altData.summary, asProvider(commentary.provider), asProvider(concepts.provider), efforts)
      : p.transcriptPlan
        ? estimateTranscriptSummary(p.transcriptPlan, p.context, p.preview.altData.summary, asProvider(commentary.provider), asProvider(concepts.provider), efforts)
        : this.estimateLectureLevel(p.preview, commentary, concepts);
    // Optional alignment check (spec 4.3 step 3): one small text call.
    const checkPrompt = p.alignment && alignmentTask.provider !== "none" ? buildAlignmentCheckPrompt(p.preview.altData.title, p.alignment, p.slideTexts) : null;
    if (checkPrompt && alignmentTask.provider !== "none") {
      const check = estimateCalls([{ promptText: checkPrompt, images: 0, schema: true, outputTokens: 200 }], alignmentTask.provider, this.estimatedEffort(alignmentTask));
      estimate = { ...estimate, calls: estimate.calls + check.calls, inputTokens: estimate.inputTokens + check.inputTokens, outputTokens: estimate.outputTokens + check.outputTokens };
    }
    // The lecture brief's AI part (spec 4.5): one call, output 800 times the effort factor; counted in the cap.
    const briefTask = this.runTask(p, "brief");
    if (p.brief.state === "call" && p.brief.promptText && isCliProvider(briefTask.provider)) {
      const b = estimateCalls([{ promptText: p.brief.promptText, images: 0, schema: true, outputTokens: BRIEF_AI_OUTPUT_TOKENS }], briefTask.provider, this.estimatedEffort(briefTask));
      estimate = {
        ...estimate,
        calls: estimate.calls + b.calls,
        inputTokens: estimate.inputTokens + b.inputTokens,
        outputTokens: estimate.outputTokens + b.outputTokens,
        brief: { calls: b.calls, inputTokens: b.inputTokens, outputTokens: b.outputTokens },
      };
    }
    return { ...p, estimate, overCap: exceedsCap(estimate, this.data.settings.generation.tokenCapPerLecture) };
  }

  /**
   * No slide plan: the 1.x lecture-level flow (runLegacyImport), estimated
   * from the same prompt templates. Each note call writes the whole note:
   * one from the transcript when Alt's summary is under 2500 characters,
   * and one that adds the PDF text when the run gets a PDF (the run reads
   * it again; one without a text layer skips that call, which the estimate
   * cannot know). The concepts then read the note. A page read in part gets
   * one note from the PDF text and no concepts (savePartialNote).
   */
  private estimateLectureLevel(preview: ImportPreview, commentaryTask: TaskLLMSetting, conceptTask: TaskLLMSetting): BudgetEstimate {
    const asProvider = (id: ProviderId | "none"): ProviderId => (id === "none" ? "claude-cli" : id);
    const alt = preview.altData;
    const transcript = (alt.transcript ?? "").slice(0, 15000);
    const material = this.pdfProcessor && (preview.pdfData || preview.pdfUrl) ? textStandIn(MATERIAL_MAX_CHARS) : null;
    const noteCall = (template: string, input: string): CallShape => ({
      promptText: lectureNoteSystemTemplate + template + input,
      images: 0,
      outputTokens: LECTURE_NOTE_OUTPUT_TOKENS,
      schema: false,
    });
    const calls: CallShape[] = [];
    const conceptCalls: CallShape[] = [];
    if (alt.parseQuality === "partial") {
      if (material) calls.push(noteCall(lectureNoteFromMaterialTemplate, alt.summary.slice(0, 4000) + material));
    } else {
      // What the concepts read: the last note written, else Alt's summary.
      let note = alt.summary;
      if (transcript && alt.summary.length < 2500) {
        calls.push(noteCall(alt.summary.length < 500 ? lectureNoteFromTranscriptTemplate : lectureNoteEnhanceTranscriptTemplate, alt.summary + transcript));
        note = textStandIn(LECTURE_NOTE_CHARS);
      }
      if (material) {
        calls.push(noteCall(lectureNoteEnhanceMaterialTemplate, note.slice(0, 18000) + material));
        // The PDF pass writes up to 8000 characters, or keeps a longer note's length.
        if (note.length < LECTURE_NOTE_CHARS) note = textStandIn(LECTURE_NOTE_CHARS);
      }
      conceptCalls.push({ promptText: conceptExtractionTemplateText + note, images: 0, outputTokens: CONCEPTS_OUTPUT_TOKENS, schema: false });
    }
    const main = estimateCalls(calls, asProvider(commentaryTask.provider), this.estimatedEffort(commentaryTask));
    const concept = estimateCalls(conceptCalls, asProvider(conceptTask.provider), this.estimatedEffort(conceptTask));
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
    const brief: BriefStepContext = { task: this.runTask(prepared, "brief"), transcript: timedTranscript(prepared.preview.bundle), signal, onWarning: hooks.onWarning };
    try {
      const commentaryLlm = await this.providerFor("commentary", job, usage, signal, commentaryTask);
      const conceptLlm = await this.providerFor("concepts", job, usage, signal, conceptTask);
      const { preview, subject, url, pdfData } = prepared;
      let { plan, alignment } = prepared;
      const altData = preview.altData;

      if (prepared.transcriptPlan) {
        return await this.runTranscriptImport(prepared, prepared.transcriptPlan, { commentaryLlm, conceptLlm, commentaryTask, usage, signal, hooks, brief });
      }

      if (!plan || !pdfData) {
        // No PDF: 1.x lecture-level note, generated by the CLI provider.
        hooks.onStep?.("overview");
        return await this.runLegacyImport(url, preview, subject, commentaryLlm, conceptLlm, hooks.onProgress, hooks.onConfirmUpdate, signal, prepared.notePath, brief);
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
          // The attached mark follows the PDF this import used.
          ...this.preservedFrontmatter(prepared.notePath, altData.metadata.sourceKind, alignment).filter((l) => !l.startsWith("alt_pdf_source:")),
          ...(prepared.pdfSource === "attached" ? [ATTACHED_LINE] : []),
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
        brief,
      });
    } finally {
      hooks.signal?.removeEventListener("abort", forward);
      this.activeJobs.delete(controller);
      removeJobDir(job);
      if (usage.total().calls > 0) {
        await this.recordUsage(usage).catch((e) => console.warn("[Alt2Obs] usage record failed:", e));
      }
    }
  }

  /**
   * The summary note of a lecture without slides (spec 4.10): section
   * summaries in batches, then the overview and the concepts from the
   * section gists, written like a slide note (merge keeps the memos).
   */
  private async runTranscriptImport(
    prepared: PreparedImport,
    plan: TranscriptPlan,
    r: { commentaryLlm: ILLMProvider; conceptLlm: ILLMProvider; commentaryTask: TaskLLMSetting; usage: UsageTracker; signal: AbortSignal; hooks: CliImportHooks; brief: BriefStepContext }
  ): Promise<ImportRecord> {
    const { preview, subject, url } = prepared;
    const altData = preview.altData;
    const { hooks, signal, usage, commentaryTask } = r;
    const run = await runTranscriptSummary({
      plan,
      context: prepared.context,
      subject,
      language: this.data.settings.language,
      altSummary: altData.summary,
      commentaryLlm: r.commentaryLlm,
      conceptLlm: r.conceptLlm,
      signal,
      onStep: hooks.onStep,
      onBatch: (p) => hooks.onBatch?.({ batch: p.batch, batches: p.batches, slidesDone: p.done, slidesTotal: p.total, retry: p.retry }),
    });
    if (signal.aborted) throw new CliRunError("aborted", "취소되었습니다");
    // Nothing summarized at all: keep the existing note as it is.
    const llmSections = plan.sections.filter((x) => x.mode === "llm").length;
    if (llmSections > 0 && run.sectionsResult.generatedCount === 0) {
      const first = run.sectionsResult.errors[0]?.reason ?? "알 수 없는 오류";
      throw new Error(`전사 구간을 하나도 요약하지 못해 노트를 저장하지 않았습니다: ${first}`);
    }
    hooks.onStep?.("save");
    const concepts = this.normalizeConcepts(run.concepts, new Set(prepared.context.knownConcepts));
    const providerLabel = `${PROVIDER_LABELS[commentaryTask.provider]}${commentaryTask.model ? " " + commentaryTask.model : ""}`;
    const { lectureMarkdown, conceptNotes } = new NoteGenerator(r.commentaryLlm).generateTranscriptNote(
      altData,
      { sections: run.sectionsResult.sections, errors: [...run.sectionsResult.errors, ...run.warnings.map((reason) => ({ section: 0, reason }))] },
      { processedSummary: run.overview, concepts, tags: run.tags, subjectSuggestion: subject, knownConceptNames: prepared.context.knownConcepts },
      subject,
      [
        formatUsageFrontmatter(usage.total(), providerLabel, {
          model: usage.modelFor("commentary") || commentaryTask.model,
          effort: commentaryTask.effort,
          conceptModel: usage.modelFor("concepts") ?? undefined,
        }),
        ...this.preservedFrontmatter(prepared.notePath, altData.metadata.sourceKind, null),
      ]
    );
    return this.saveLecture({
      url,
      altData,
      subject,
      lectureMarkdown,
      conceptNotes,
      pdfData: null,
      notePath: prepared.notePath,
      bundle: preview.bundle,
      onProgress: hooks.onProgress,
      onConfirmUpdate: hooks.onConfirmUpdate,
      signal,
      brief: r.brief,
    });
  }

  // ---- lecture brief (2.1.0 spec 4) ----

  /** The vault as the brief store sees it: read, write (vault.process / create, folders made), list a folder. */
  briefFiles(): BriefFiles {
    const vault = this.app.vault;
    return {
      read: async (path) => {
        const f = vault.getAbstractFileByPath(path);
        return f instanceof TFile ? vault.read(f) : null;
      },
      write: async (path, text) => {
        const f = vault.getAbstractFileByPath(path);
        if (f instanceof TFile) {
          await vault.process(f, () => text);
          return;
        }
        await this.vaultManager!.ensureFolder(path.replace(/\/[^/]*$/, ""));
        await vault.create(path, text);
      },
      list: async (folder) => vault.getMarkdownFiles().filter((f) => f.path.replace(/\/?[^/]*$/, "") === folder).map((f) => f.path),
    };
  }

  /**
   * The import's brief step, after the note is saved (spec 4.4): the script
   * part (no tokens) unless the setting "가져올 때 챗봇 브리프 만들기" is off;
   * with "AI 강조점 포함" and a timestamped transcript, the AI part too (one
   * call of the brief task when its input changed). A failure never fails
   * the import: a failed AI part leaves the script part with
   * ai_part.status "failed" and one warning line.
   */
  private async writeBriefAfterImport(notePath: string, ctx?: BriefStepContext, onProgress?: (stage: string, percent: number) => void): Promise<void> {
    const mode = this.data.settings.briefMode;
    if (mode === "off") return;
    try {
      onProgress?.("챗봇 브리프 만드는 중...", 98);
      const ai = mode === "ai" ? await this.briefAiStep(notePath, ctx?.task ?? this.data.settings.tasks.brief, ctx?.transcript ?? null, ctx?.signal) : undefined;
      const result = await updateLectureBrief(this.briefFiles(), notePath, { today: formatDate(), ai });
      if (result.ai === "failed") ctx?.onWarning?.(`챗봇 브리프의 강조점을 만들지 못해 스크립트 부분만 썼습니다: ${result.aiError ?? "알 수 없는 오류"}`);
    } catch (e) {
      console.warn("[Alt2Obs] lecture brief not written:", e);
      ctx?.onWarning?.(`챗봇 브리프를 쓰지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The AI step of a lecture's brief: its timestamped transcript (the
   * import's, else the cache or Alt) and one call of the brief task, its
   * usage added to the plugin totals (never to the note's alt2obs_usage).
   * Undefined without a transcript: the script part only.
   */
  async briefAiStep(notePath: string, task: TaskLLMSetting, transcript: TimedText[] | null, signal?: AbortSignal): Promise<BriefAiStep | undefined> {
    if (!isCliProvider(task.provider)) return undefined;
    let segments = transcript;
    if (!segments || segments.length === 0) {
      const id = fmString(this.frontmatterOf(notePath) ?? {}, "alt_local_id");
      segments = id ? await this.loadTranscript(id) : null;
    }
    if (!segments || segments.length === 0) return undefined;
    return {
      transcript: segments,
      run: async (prompt, validate) => {
        const job = createJobDir();
        const usage = new UsageTracker();
        const controller = new AbortController();
        const forward = () => controller.abort();
        if (signal?.aborted) controller.abort();
        signal?.addEventListener("abort", forward, { once: true });
        this.activeJobs.add(controller);
        try {
          const llm = await this.providerFor("brief", job, usage, controller.signal, task);
          const ai = await llm.generateJSON(prompt.user, validate, { systemPrompt: prompt.system, schema: BRIEF_AI_SCHEMA, signal: controller.signal });
          const total = usage.total();
          return { ai, model: usage.modelFor("brief") || task.model, input: total.inputTokens, output: total.outputTokens };
        } finally {
          signal?.removeEventListener("abort", forward);
          this.activeJobs.delete(controller);
          removeJobDir(job);
          if (usage.total().calls > 0) await this.recordUsage(usage, false).catch((e) => console.warn("[Alt2Obs] usage record failed:", e));
        }
      },
    };
  }

  /**
   * The lecture the brief command means: the active lecture note, or the
   * note of the active Synced Viewer. Null when neither is open.
   */
  private async activeLectureNote(): Promise<string | null> {
    const chat = this.app.workspace.getActiveViewOfType(ChatView)?.lecturePath();
    if (chat) return chat;
    const viewer = this.app.workspace.getActiveViewOfType(SyncedViewerView);
    const viewerNote = viewer?.getState().mdPath;
    if (typeof viewerNote === "string" && viewerNote) return viewerNote;
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return null;
    const text = await this.app.vault.cachedRead(file);
    return isLectureNote(readFrontmatter(text), text) ? file.path : null;
  }

  /**
   * "이 강의 브리프 다시 만들기": the script part built again (no tokens). A
   * brief the user edited is overwritten only after they confirm.
   */
  async rebuildBrief(notePath: string | null): Promise<boolean> {
    if (!notePath) {
      new Notice("강의 노트나 synced viewer를 연 뒤 다시 시도하세요.");
      return false;
    }
    const files = this.briefFiles();
    const state = await readLectureBrief(files, notePath);
    if (state.status === "edited" || state.status === "edited-stale") {
      const answer = await choose(
        this.app,
        "브리프 다시 만들기",
        [`직접 고친 브리프입니다: ${state.path}. 다시 만들면 고친 내용이 노트에서 새로 만든 내용으로 바뀝니다.`],
        [
          { id: "rebuild", text: "덮어쓰기", cta: true },
          { id: "cancel", text: "취소" },
        ]
      );
      if (answer !== "rebuild") return false;
    }
    const result = await updateLectureBrief(files, notePath, { today: formatDate(), force: true });
    new Notice(`브리프를 다시 만들었습니다: ${result.path}`);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
      if (leaf.view instanceof ChatView && leaf.view.lecturePath() === notePath) void leaf.view.reloadBrief();
    }
    return true;
  }

  // ---- question panel (2.1.0 spec 5, 6) ----

  async toggleChatPanel(): Promise<void> {
    await this.chatPanel?.toggle();
  }

  closeChatPanel(): void {
    this.chatPanel?.close();
  }

  /** The panel's view closed: the right sidebar goes back to how it was (ChatPanelController.dispose covers the unload). */
  chatPanelClosed(leaf: WorkspaceLeaf): void {
    this.chatPanel?.closed(leaf);
  }

  /** The viewers' "💬 질문" buttons show whether the panel is open. */
  private showChatOpen(open: boolean): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNCED_VIEWER)) {
      if (leaf.view instanceof SyncedViewerView) leaf.view.setChatActive(open);
    }
  }

  /** Transcripts the panel read, by Alt id (a few lectures, for this session). */
  private chatTranscripts = new Map<string, Promise<TimedText[] | null>>();

  private chatTranscript(altLocalId: string): Promise<TimedText[] | null> {
    let found = this.chatTranscripts.get(altLocalId);
    if (!found) {
      found = this.loadTranscript(altLocalId);
      // Not found now (Alt closed, cache cleared): asked again next time.
      void found.then((t) => {
        if (!t) this.chatTranscripts.delete(altLocalId);
      });
      this.chatTranscripts.set(altLocalId, found);
      for (const key of Array.from(this.chatTranscripts.keys()).slice(0, Math.max(0, this.chatTranscripts.size - 3))) this.chatTranscripts.delete(key);
    }
    return found;
  }

  /** Page texts of a lecture PDF for the panel (lines kept), read once per file version. */
  private chatPageTextCache = new Map<string, string[]>();
  /** Page images of textless pages, by PDF version and page (the last PDF only). */
  private chatPageImageCache = new Map<string, SlideMaterial["image"]>();

  private pdfVersion(pdf: TFile): string {
    return `${pdf.path}:${pdf.stat?.mtime ?? 0}:${pdf.stat?.size ?? 0}`;
  }

  private async chatPageTexts(pdf: TFile): Promise<string[]> {
    const key = this.pdfVersion(pdf);
    const cached = this.chatPageTextCache.get(key);
    if (cached) return cached;
    const layouts = await this.pdfProcessor!.getPageLayouts(await this.app.vault.readBinary(pdf));
    const texts = layouts.map(layoutAlignmentText);
    this.chatPageTextCache.clear();
    this.chatPageTextCache.set(key, texts);
    return texts;
  }

  private async chatPageImage(pdf: TFile, page: number): Promise<SlideMaterial["image"]> {
    const key = `${this.pdfVersion(pdf)}#${page}`;
    if (this.chatPageImageCache.has(key)) return this.chatPageImageCache.get(key) ?? null;
    const image = await this.pdfProcessor!.renderPageJpeg(await this.app.vault.readBinary(pdf), page);
    if (![...this.chatPageImageCache.keys()].every((k) => k.startsWith(`${this.pdfVersion(pdf)}#`))) this.chatPageImageCache.clear();
    this.chatPageImageCache.set(key, image);
    return image;
  }

  /** The lecture of a note for the panel; null when the note is not a lecture note (spec 5.2). */
  async chatLecture(notePath: string): Promise<ChatLecture | null> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile) || !/\.md$/i.test(notePath)) return null;
    const text = await this.app.vault.cachedRead(file);
    const parts = parseLectureNote(text);
    // The metadata cache reads YAML as Obsidian does (Properties may rewrite it); the note's own text until it is indexed.
    const fm = this.frontmatterOf(notePath) ?? parts.frontmatter;
    if (!isLectureNote(fm, text)) return null;
    const maxNum = parts.units.reduce((n, u) => Math.max(n, u.num), 0);
    // The alignment's end until a slide's material reads the transcript (its end then counts).
    const spans = parseAlignment(fm.alt_alignment);
    const alignmentEnd = spans.length > 0 ? Math.max(...spans.map((s) => s.endMs)) : null;
    const folder = notePath.replace(/\/?[^/]*$/, "");
    const siblings = this.vaultLectureNotes()
      .filter((v) => v.path.replace(/\/?[^/]*$/, "") === folder)
      .map((v) => ({ name: stemOf(v.path), altCreated: v.altCreated }));
    if (!siblings.some((l) => l.name === stemOf(notePath))) siblings.push({ name: stemOf(notePath), altCreated: fmString(fm, "alt_created") || undefined });
    return {
      notePath,
      name: stemOf(notePath),
      subject: subjectOfNote(notePath, fm),
      kind: parts.kind,
      pdfPath: parts.kind === "slides" ? this.siblingPdf(notePath)?.path ?? null : null,
      slideCount: parts.kind === "slides" ? Math.max(maxNum, Number(fm.slide_count) || 0) : 0,
      sectionCount: parts.kind === "transcript" ? maxNum : 0,
      lengthMs: alignmentEnd,
      neighbours: neighbourLectures(stemOf(notePath), siblings),
    };
  }

  async chatBrief(notePath: string): Promise<ChatBriefState> {
    const state = await readLectureBrief(this.briefFiles(), notePath);
    return { status: state.status, body: state.body, path: state.path, sourceHash: state.script.sourceHash };
  }

  /** The panel's brief buttons: the script part, or with `withAi` the AI part too ("강조점까지 만들기"). */
  async buildChatBrief(notePath: string, force: boolean, withAi = false): Promise<void> {
    const ai = withAi ? await this.briefAiStep(notePath, this.data.settings.tasks.brief, null) : undefined;
    const result = await updateLectureBrief(this.briefFiles(), notePath, { today: formatDate(), force, ai });
    if (result.ai === "failed") new Notice(`강조점을 만들지 못해 스크립트 부분만 썼습니다: ${result.aiError ?? "알 수 없는 오류"}`);
  }

  /**
   * Tokens (input plus output) of a lecture's brief AI part, for the
   * panel's "강조점까지 만들기 · 약 Nk": null when it has no cached
   * transcript or no candidate (no button then).
   */
  async briefAiEstimate(notePath: string): Promise<number | null> {
    const b = await this.briefAiCost(notePath);
    return b ? b.inputTokens + b.outputTokens : null;
  }

  /** The brief AI call of a lecture as the estimate counts it (cached transcript only), null when it makes none. */
  private async briefAiCost(notePath: string): Promise<{ calls: number; inputTokens: number; outputTokens: number } | null> {
    const task = this.data.settings.tasks.brief;
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile) || !isCliProvider(task.provider)) return null;
    const text = await this.app.vault.cachedRead(file);
    const id = fmString(this.frontmatterOf(notePath) ?? readFrontmatter(text), "alt_local_id");
    const transcript = id ? await this.cachedTranscript(id) : null;
    if (!transcript || transcript.length === 0) return null;
    const input = await aiInputFor(await buildBriefScript(notePath, text), transcript);
    if (!input) return null;
    return estimateCalls([{ promptText: `${input.system}\n\n${input.user}`, images: 0, schema: true, outputTokens: BRIEF_AI_OUTPUT_TOKENS }], task.provider, this.estimatedEffort(task));
  }

  /** "모든 강의 브리프 만들기" (spec 4.6): lecture notes whose brief is missing or out of date, those the user edited, the AI estimate. */
  async planAllBriefs(): Promise<AllBriefsPlan> {
    const files = this.briefFiles();
    const plan: AllBriefsPlan = { todo: [], edited: [], aiEstimate: null };
    const ai = { calls: 0, inputTokens: 0, outputTokens: 0 };
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!isLectureNote(fm, null)) continue;
      const state = await readLectureBrief(files, file.path);
      if (state.status === "edited" || state.status === "edited-stale") plan.edited.push(file.path);
      if (state.status !== "missing" && state.status !== "outdated") continue;
      const cost = await this.briefAiCost(file.path);
      plan.todo.push({ notePath: file.path, hasTranscript: !!cost });
      if (cost) {
        ai.calls += cost.calls;
        ai.inputTokens += cost.inputTokens;
        ai.outputTokens += cost.outputTokens;
      }
    }
    plan.todo.sort((a, b) => a.notePath.localeCompare(b.notePath, "ko", { numeric: true }));
    plan.aiEstimate = ai.calls > 0 ? ai : null;
    return plan;
  }

  /** Builds the planned briefs one by one (the AI part only for lectures with a transcript); stops between lectures on cancel. */
  async buildAllBriefs(plan: AllBriefsPlan, withAi: boolean, o: { signal: AbortSignal; onProgress(done: number, total: number, notePath: string): void }): Promise<AllBriefsResult> {
    const result: AllBriefsResult = { made: 0, skipped: plan.edited.length, failed: 0, cancelled: false };
    const files = this.briefFiles();
    for (const [i, item] of plan.todo.entries()) {
      if (o.signal.aborted) {
        result.cancelled = true;
        break;
      }
      o.onProgress(i, plan.todo.length, item.notePath);
      try {
        const ai = withAi && item.hasTranscript ? await this.briefAiStep(item.notePath, this.data.settings.tasks.brief, null, o.signal) : undefined;
        const r = await updateLectureBrief(files, item.notePath, { today: formatDate(), ai });
        if (r.ai === "failed") result.failed++;
        else if (r.result === "written") result.made++;
        else result.skipped++;
      } catch (e) {
        console.warn("[Alt2Obs] brief not built:", item.notePath, e);
        result.failed++;
      }
    }
    if (o.signal.aborted) result.cancelled = true;
    o.onProgress(plan.todo.length, plan.todo.length, plan.todo[plan.todo.length - 1]?.notePath ?? "");
    return result;
  }

  /** One slide's material (spec 6.2): page text (or its image), commentary, memo, aligned transcript. */
  async chatMaterial(lecture: ChatLecture, slide: number): Promise<SlideMaterial> {
    const file = this.app.vault.getAbstractFileByPath(lecture.notePath);
    if (!(file instanceof TFile)) throw new Error(`강의 노트를 찾지 못했습니다: ${lecture.notePath}`);
    // Read now, not cached: a memo typed a moment ago and a re-imported commentary count (spec 6.2).
    const parts = parseLectureNote(await this.app.vault.read(file));
    const fm = this.frontmatterOf(lecture.notePath) ?? parts.frontmatter;
    const unit = parts.units.find((u) => u.num === slide);
    const spans = spansForSlide(parseAlignment(fm.alt_alignment), slide);
    let slideText = "";
    let image: SlideMaterial["image"] = null;
    const pdf = lecture.pdfPath ? this.app.vault.getAbstractFileByPath(lecture.pdfPath) : null;
    if (pdf instanceof TFile && this.pdfProcessor) {
      try {
        slideText = (await this.chatPageTexts(pdf))[slide - 1] ?? "";
        // A page without a text layer goes as an image (long edge 1024, JPEG 80), rendered once per PDF version.
        if (normalizePageText(slideText).length < TEXTLESS_PAGE_CHARS) image = await this.chatPageImage(pdf, slide);
      } catch (e) {
        console.warn("[Alt2Obs] slide text not read:", e);
      }
    }
    const id = fmString(fm, "alt_local_id");
    const transcript = id && spans.length > 0 ? (await this.chatTranscript(id)) ?? [] : [];
    return {
      slideText,
      image,
      commentary: unit ? commentaryText(unit.managed) : "",
      memo: unit ? memoText(unit.after) : "",
      segments: segmentsInSpans(transcript, spans),
      spans,
      transcriptEndMs: transcript.length > 0 ? Math.max(...transcript.map((s) => s.endMs)) : null,
    };
  }

  /**
   * One question (spec 5.4, 7.2): the chat task's CLI with the pack as
   * system prompt and user message, streamed. Usage goes to the totals as
   * the chat task (not a lecture) and the model it resolved is recorded.
   */
  async runChat(req: ChatRunRequest): Promise<ChatRunResult> {
    if (this.unloaded) throw new Error("플러그인이 꺼져 있어 질문을 보내지 않았습니다.");
    const task = sanitizeTask(req.task, this.data.settings.tasks.chat);
    if (!isCliProvider(task.provider)) throw new Error("질문에 쓸 LLM이 설정되어 있지 않습니다.");
    // A CLI that cannot be found is its own error card.
    try {
      await this.resolveBin(task.provider === "claude-cli" ? "claude" : "codex");
    } catch (e) {
      throw e instanceof CliRunError ? e : new CliRunError("not-found", e instanceof Error ? e.message : String(e));
    }
    const job = createJobDir();
    const usage = new UsageTracker();
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (req.signal.aborted) controller.abort();
    req.signal.addEventListener("abort", forward, { once: true });
    this.activeJobs.add(controller);
    try {
      const llm = await this.providerFor("chat", job, usage, controller.signal, task);
      if (!llm.streamText) throw new Error(`${llm.name}: 질문 패널에 쓸 수 없는 프로바이더입니다.`);
      const text = await llm.streamText(req.user, {
        systemPrompt: req.system,
        images: req.images,
        signal: controller.signal,
        onDelta: (piece) => req.onDelta(piece),
        onReset: () => req.onReset?.(),
      });
      const record = usage.entries().pop();
      return { text, usage: usage.total(), model: record?.resolvedModel || record?.model || task.model };
    } finally {
      req.signal.removeEventListener("abort", forward);
      this.activeJobs.delete(controller);
      removeJobDir(job);
      if (usage.total().calls > 0) await this.recordUsage(usage, false).catch((e) => console.warn("[Alt2Obs] usage record failed:", e));
    }
  }

  /** Why a question failed, as the panel's error card shows it (spec 5.6). */
  chatErrorInfo(e: unknown): ChatErrorInfo {
    const message = e instanceof Error ? e.message : String(e);
    if (isAuthError(e)) return { kind: "auth", message };
    if (isUsageLimitError(e)) return { kind: "limit", message: (e instanceof CliRunError && e.cliError) || message };
    if (e instanceof CliRunError && (e.kind === "not-found" || e.kind === "spawn")) return { kind: "missing", message };
    if (e instanceof CliRunError && e.kind === "timeout") return { kind: "timeout", message };
    return { kind: "other", message };
  }

  /** Lecture notes for the panel's "강의 없음" card, by subject and name. */
  lectureChoices(): Array<{ path: string; name: string; subject: string }> {
    return this.vaultLectureNotes()
      .map((v) => ({ path: v.path, name: stemOf(v.path), subject: v.subject || subjectFolderOfNote(v.path).split("/").pop() || "" }))
      .sort((a, b) => a.subject.localeCompare(b.subject, "ko") || a.name.localeCompare(b.name, "ko", { numeric: true }));
  }

  /**
   * A lecture's slides for "+ 자료 추가" (spec 5.7): the brief's slide map
   * (gist, time) and rough tokens of each part. Page texts count only when
   * the panel has read that PDF already (a stand-in otherwise); a send
   * counts exactly.
   */
  async chatSlideList(lecture: ChatLecture): Promise<SlideRow[]> {
    const file = this.app.vault.getAbstractFileByPath(lecture.notePath);
    if (!(file instanceof TFile) || lecture.kind !== "slides") return [];
    const text = await this.app.vault.cachedRead(file);
    const parts = parseLectureNote(text);
    const map = new Map((await buildBriefScript(lecture.notePath, text)).map.map((e) => [e.num, e]));
    const fm = this.frontmatterOf(lecture.notePath) ?? parts.frontmatter;
    const alignment = parseAlignment(fm.alt_alignment);
    const pdf = lecture.pdfPath ? this.app.vault.getAbstractFileByPath(lecture.pdfPath) : null;
    const pages = pdf instanceof TFile ? this.chatPageTextCache.get(this.pdfVersion(pdf)) ?? null : null;
    const id = fmString(fm, "alt_local_id");
    const transcript = id && alignment.length > 0 ? (await this.chatTranscript(id)) ?? [] : [];
    const cap = this.data.settings.generation.transcriptCapChars;
    return [...parts.units]
      .sort((a, b) => a.num - b.num)
      .map((u) => {
        const segments = segmentsInSpans(transcript, spansForSlide(alignment, u.num));
        return {
          num: u.num,
          gist: map.get(u.num)?.text ?? "",
          range: map.get(u.num)?.range ?? "",
          tokens: {
            slideText: pages ? estimateTextTokens(pages[u.num - 1] ?? "") : SLIDE_TEXT_STANDIN_TOKENS,
            commentary: estimateTextTokens(commentaryText(u.managed)),
            transcript: segments.length > 0 ? estimateTextTokens(formatTranscriptLines(transcriptLines(segments, cap, ""))) : 0,
            memo: estimateTextTokens(memoText(u.after)),
          },
        };
      });
  }

  /** Another lecture's brief for a question: its file's body, else the script part built in memory (nothing written). */
  async chatOtherBrief(lecture: ChatLecture): Promise<string> {
    const state = await readLectureBrief(this.briefFiles(), lecture.notePath);
    return state.body ?? briefChatBody(await composeBrief(state.script, null, formatDate()));
  }

  /** An added slide's page as an image (long edge 1024, JPEG 80), null without its PDF. */
  async chatSlideImage(lecture: ChatLecture, slide: number): Promise<ImageInput | null> {
    const pdf = lecture.pdfPath ? this.app.vault.getAbstractFileByPath(lecture.pdfPath) : null;
    if (!(pdf instanceof TFile) || !this.pdfProcessor) return null;
    return this.chatPageImage(pdf, slide);
  }

  /** "노트에서 선택한 글" (spec 5.7): the selection in the note the reader was on, the viewer's note pane or an editor. */
  noteSelection(): string {
    const view = this.app.workspace.getMostRecentLeaf?.()?.view;
    if (view instanceof SyncedViewerView) return view.getSelectedText();
    if (view instanceof MarkdownView) return view.editor.getSelection();
    return "";
  }

  /** The plugin's settings tab (Obsidian's settings window has no public API for this). */
  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open?: unknown; openTabById?: unknown } }).setting;
    if (typeof setting?.open === "function") (setting.open as () => void).call(setting);
    if (typeof setting?.openTabById === "function") (setting.openTabById as (id: string) => void).call(setting, this.manifest.id);
  }

  /** "뷰어로 열기" of the panel: the lecture's Synced Viewer, or why there is none. */
  async openLectureViewer(notePath: string): Promise<void> {
    const pdf = this.siblingPdf(notePath);
    if (!pdf || this.frontmatterOf(notePath)?.alt_kind === "transcript") {
      await this.explainNoViewer(notePath);
      return;
    }
    await this.openSyncedViewer(notePath, pdf.path);
  }

  /** The open Synced Viewer of a lecture note, or one opened for it; null without its PDF. */
  private async viewerFor(notePath: string): Promise<SyncedViewerView | null> {
    const find = () => this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNCED_VIEWER).find((l) => l.view instanceof SyncedViewerView && l.view.getState().mdPath === notePath);
    let leaf = find();
    if (!leaf) {
      const pdf = this.siblingPdf(notePath);
      if (!pdf || this.frontmatterOf(notePath)?.alt_kind === "transcript") return null;
      await this.openSyncedViewer(notePath, pdf.path);
      leaf = find();
    }
    if (!leaf || !(leaf.view instanceof SyncedViewerView)) return null;
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  /** A heading of a note in the editor (its link target, as Obsidian matches headings). */
  private async openHeading(notePath: string, heading: string): Promise<void> {
    await this.app.workspace.openLinkText(`${notePath}#${headingLinkTarget(heading)}`, "", false);
  }

  /** A slide chip of the panel (spec 5.5): the slide in the lecture's viewer, else its heading in the note. */
  async gotoSlide(lecture: ChatLecture, slide: number): Promise<void> {
    const viewer = await this.viewerFor(lecture.notePath);
    if (viewer) viewer.gotoSlide(slide);
    else await this.openHeading(lecture.notePath, `📚 슬라이드 ${slide}`);
  }

  /** A time chip: the viewer's transcript at that time; in a summary note, the heading of the section that holds it. */
  async gotoTime(lecture: ChatLecture, ms: number): Promise<void> {
    if (lecture.kind === "slides") {
      const viewer = await this.viewerFor(lecture.notePath);
      if (viewer) await viewer.showTranscriptAt(ms);
      return;
    }
    const section = (await this.sectionHeadings(lecture.notePath)).find((h) => h.startMs !== null && h.endMs !== null && ms >= h.startMs && ms < h.endMs);
    if (section) await this.openHeading(lecture.notePath, section.text);
  }

  /** A section chip: the section's heading in the summary note. */
  async gotoSection(lecture: ChatLecture, num: number): Promise<void> {
    const section = (await this.sectionHeadings(lecture.notePath)).find((h) => h.num === num);
    if (section) await this.openHeading(lecture.notePath, section.text);
  }

  private async sectionHeadings(notePath: string): Promise<Array<{ num: number; text: string; startMs: number | null; endMs: number | null }>> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return [];
    return splitSectionNote(toLf(await this.app.vault.cachedRead(file)))
      .sections.filter((x) => x.parsed)
      .map((x) => ({ num: x.num, text: x.parsed!.text, startMs: x.parsed!.startMs, endMs: x.parsed!.endMs }));
  }

  /** A vault file in a new tab ("브리프 열기"). */
  async openVaultFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
  }

  // ---- lectures without slides: kind and attached PDF (spec 4.10) ----

  /** The note an import of this Alt local note writes (the same rule as an import). */
  notePathForLocal(note: { id: string; title: string; lectureDate: string | null }, subject: string): string {
    const preview = {
      altData: { title: note.title, summary: "", pdfUrl: null, transcript: null, parseQuality: "full" as const, metadata: { noteId: note.id, createdAt: note.lectureDate, visibility: null, sourceKind: "alt-local" as const } },
      pdfData: null,
      suggestedSubject: subject,
    };
    return this.resolveNotePath(preview, subject);
  }

  /**
   * The PDF next to a note that an import would use as attached: the note
   * is marked so, or there is no note yet and Alt has no PDF (an unmarked
   * PDF next to an existing note is the plugin's own copy).
   */
  attachedPdfFor(notePath: string, altHasPdf: boolean): TFile | null {
    const sibling = this.siblingPdf(notePath);
    if (!sibling) return null;
    const note = this.app.vault.getAbstractFileByPath(notePath);
    const fm = this.frontmatterOf(notePath);
    return fm?.alt_pdf_source === "attached" || (!(note instanceof TFile) && !altHasPdf) ? sibling : null;
  }

  /** Kind of an Alt lecture as the sidebar shows it ("슬라이드", "노트(전사만)", ...). */
  lectureKindFor(input: { altType: string | null; hasSlides: boolean; hasTranscript: boolean; notePath: string }): LectureKind {
    const attached = !!this.attachedPdfFor(input.notePath, input.hasSlides);
    const fm = this.frontmatterOf(input.notePath);
    // A slide note with the PDF an earlier import saved next to it: imported with that copy.
    const vaultCopy = !attached && !!this.siblingPdf(input.notePath) && fm?.slide_count !== undefined && fm?.slide_count !== null && fm?.alt_kind !== "transcript";
    return lectureKind({ altType: input.altType, hasSlides: input.hasSlides, hasTranscript: input.hasTranscript, attachedPdf: attached, vaultCopy });
  }

  /** Records of the PDFs the plugin copied when the user attached one (and the legacy "never trash" list). */
  private async recordCopy(path: string, data: ArrayBuffer | null): Promise<void> {
    const copies = (this.data.attachedCopies ?? []).filter((c) => c.path !== path);
    if (data) copies.push({ path, size: data.byteLength, sha1: await sha1Hex(data) });
    this.data.attachedCopies = copies;
    if (data && this.data.attachedInPlace) this.data.attachedInPlace = this.data.attachedInPlace.filter((p) => p !== path);
    await this.savePluginData();
  }

  /** A vault rename (a note and its PDF moved, a folder renamed): the records follow the files. */
  async onVaultRename(file: { path: string }, oldPath: string): Promise<void> {
    const move = (p: string) => (p === oldPath ? file.path : p.startsWith(oldPath + "/") ? file.path + p.slice(oldPath.length) : p);
    const copies = this.data.attachedCopies ?? [];
    const inPlace = this.data.attachedInPlace ?? [];
    if (!copies.some((c) => move(c.path) !== c.path) && !inPlace.some((p) => move(p) !== p)) return;
    this.data.attachedCopies = copies.map((c) => ({ ...c, path: move(c.path) }));
    if (this.data.attachedInPlace) this.data.attachedInPlace = inPlace.map(move);
    await this.savePluginData();
  }

  /** Drops records whose file is gone. */
  async pruneAttachRecords(): Promise<void> {
    const exists = (p: string) => this.app.vault.getAbstractFileByPath(p) instanceof TFile;
    const copies = this.data.attachedCopies ?? [];
    const inPlace = this.data.attachedInPlace ?? [];
    const keptCopies = copies.filter((c) => exists(c.path));
    const keptInPlace = inPlace.filter(exists);
    if (keptCopies.length === copies.length && keptInPlace.length === inPlace.length) return;
    this.data.attachedCopies = keptCopies;
    if (this.data.attachedInPlace) this.data.attachedInPlace = keptInPlace;
    await this.savePluginData();
  }

  /**
   * The PDF next to a note is a copy the plugin made and nobody changed
   * since: a record with its path, the same size and the same SHA-1. Any
   * other file (the user's own, moved or renamed there, or a copy the user
   * edited) is not, and is never trashed.
   */
  async attachedPdfIsCopy(notePath: string): Promise<boolean> {
    const pdf = this.siblingPdf(notePath);
    if (!pdf || (this.data.attachedInPlace ?? []).includes(pdf.path)) return false;
    const record = (this.data.attachedCopies ?? []).find((c) => c.path === pdf.path);
    if (!record) return false;
    const data = await this.app.vault.readBinary(pdf);
    return data.byteLength === record.size && (await sha1Hex(data)) === record.sha1;
  }

  /**
   * The attached PDF next to a note leaves its place: a copy the plugin made
   * (see `attachedPdfIsCopy`) is deleted the way the user set Obsidian to
   * delete files (FileManager.trashFile: the system trash by default, the
   * vault's .trash folder, or for good); any other file is the user's own
   * and is never trashed: renamed to a free "<note> (첨부한 PDF).pdf" when `rename` (so an
   * import cannot overwrite it), else left where it is.
   */
  private async releaseAttachedPdf(notePath: string, rename: boolean): Promise<{ pdfPath: string | null; trashed: boolean; keptAt: string | null }> {
    await this.pruneAttachRecords();
    const pdf = this.siblingPdf(notePath);
    if (!pdf) return { pdfPath: null, trashed: false, keptAt: null };
    const path = pdf.path;
    if (await this.attachedPdfIsCopy(notePath)) {
      await this.app.fileManager.trashFile(pdf);
      await this.recordCopy(path, null);
      return { pdfPath: path, trashed: true, keptAt: null };
    }
    if (!rename) return { pdfPath: path, trashed: false, keptAt: path };
    const stem = notePath.replace(/\.md$/i, "");
    let target = `${stem} (첨부한 PDF).pdf`;
    for (let n = 2; this.app.vault.getAbstractFileByPath(target); n++) target = `${stem} (첨부한 PDF ${n}).pdf`;
    await this.app.fileManager.renameFile(pdf, target);
    await this.onVaultRename({ path: target }, path);
    return { pdfPath: path, trashed: false, keptAt: target };
  }

  /** The note loses its `alt_pdf_source` line (as text; nothing else changes). */
  private async unmarkAttached(notePath: string): Promise<void> {
    const note = this.app.vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile)) return;
    if (markedAttached(await this.app.vault.read(note))) {
      await this.app.vault.process(note, (content) => removeFrontmatterLine(content, "alt_pdf_source"));
    }
  }

  /**
   * "Alt 슬라이드로 바꾸기": the next import uses Alt's PDF instead of the
   * attached one, and writes Alt's PDF as `<note>.pdf`. So the attached PDF
   * leaves first (see `releaseAttachedPdf`: a copy to the trash, the user's
   * own file renamed, never overwritten), then the mark goes.
   */
  async useAltSlides(notePath: string): Promise<{ pdfPath: string | null; trashed: boolean; keptAt: string | null }> {
    const released = await this.releaseAttachedPdf(notePath, true);
    await this.unmarkAttached(notePath);
    return released;
  }

  /**
   * "첨부 해제": the attached PDF leaves (a copy to the trash, the user's own
   * vault file stays where it is) and the note loses its `alt_pdf_source`
   * line. Nothing else in the note changes.
   */
  async detachPdf(notePath: string): Promise<{ pdfPath: string | null; trashed: boolean; keptAt: string | null }> {
    const released = await this.releaseAttachedPdf(notePath, false);
    await this.unmarkAttached(notePath);
    return released;
  }

  /**
   * Copies a picked PDF next to the lecture note (`<note>.pdf`, or the
   * existing `.PDF` sibling) and marks an existing note `alt_pdf_source:
   * "attached"` (one frontmatter line; nothing else in the note changes).
   * The next import uses it as the slides: a summary note becomes a slide
   * note, its old text kept under "이전 노트 백업".
   */
  async attachPdf(notePath: string, picked: PickedPdf): Promise<{ pdfPath: string; replaced: boolean; marked: boolean }> {
    let data: ArrayBuffer;
    let name: string;
    if (picked.kind === "vault") {
      const f = this.app.vault.getAbstractFileByPath(picked.path);
      if (!(f instanceof TFile)) throw new Error(`보관함에서 PDF를 찾지 못했습니다: ${picked.path}`);
      data = await this.app.vault.readBinary(f);
      name = picked.path;
    } else {
      data = picked.data;
      name = picked.name;
    }
    if (data.byteLength > MAX_ATTACH_BYTES) throw new Error(`PDF가 너무 큽니다 (${Math.round(data.byteLength / 1048576)} MB, 최대 ${MAX_ATTACH_BYTES / 1048576} MB): ${name}`);
    if (!looksLikePdf(data)) throw new Error(`PDF 파일이 아닙니다: ${name}`);
    const existing = this.siblingPdf(notePath);
    const target = existing?.path ?? attachedPdfPath(notePath);
    // The user's own file already at <note>.pdf is used where it is (no copy, so no record: never trashed).
    const inPlace = picked.kind === "vault" && picked.path === target;
    if (!inPlace) await this.vaultManager!.saveRawFile(data, target);
    await this.recordCopy(target, inPlace ? null : data);
    let marked = false;
    const note = this.app.vault.getAbstractFileByPath(notePath);
    if (note instanceof TFile) {
      if (!markedAttached(await this.app.vault.read(note))) {
        // One line inserted as text (processFrontMatter would reformat the YAML), atomically.
        await this.app.vault.process(note, (content) => (markedAttached(content) ? content : insertFrontmatterLine(content, ATTACHED_LINE)));
        marked = true;
      }
    }
    return { pdfPath: target, replaced: !!existing, marked };
  }

  /** "PDF 첨부" from a command or the viewer explanation: pick, copy, and say what happens next. */
  async attachPdfInteractive(notePath: string): Promise<boolean> {
    const target = this.siblingPdf(notePath)?.path ?? attachedPdfPath(notePath);
    const picked = await pickPdf(this.app, { title: notePath.split("/").pop()!.replace(/\.md$/, ""), target, replacing: !!this.siblingPdf(notePath) });
    if (!picked) return false;
    try {
      const res = await this.attachPdf(notePath, picked);
      new Notice(`PDF를 첨부했습니다: ${res.pdfPath}\n사이드바의 Alt 노트 목록에서 이 강의를 다시 가져오면 슬라이드 노트로 바뀝니다 (내 메모는 보존).`, 10000);
      return true;
    } catch (e) {
      new Notice(`PDF를 첨부하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** A lecture note without a PDF has no Synced Viewer: say why and offer "PDF 첨부". */
  async explainNoViewer(notePath: string): Promise<void> {
    const pending = !!this.siblingPdf(notePath);
    const summaryNote = this.frontmatterOf(notePath)?.alt_kind === "transcript";
    const paragraphs = !summaryNote
      ? [
          `이 강의 노트 옆에 PDF가 없습니다: ${attachedPdfPath(notePath)}. Alt에 슬라이드가 있으면 사이드바에서 다시 가져올 때 함께 저장됩니다.`,
          "Alt에 슬라이드가 없으면 강의 PDF를 첨부하세요. 다음 가져오기부터 그 PDF를 슬라이드로 씁니다.",
        ]
      : pending
        ? ["이 노트는 녹음 전사로 만든 요약 노트입니다. PDF가 첨부되어 있으니 사이드바의 Alt 노트 목록에서 이 강의를 다시 가져오면 슬라이드 노트로 바뀌고 synced viewer로 볼 수 있습니다 (내 메모는 '이전 노트 백업'에 보존)."]
        : [
            "이 강의에는 슬라이드 PDF가 없어 녹음 전사로 요약 노트를 만들었습니다. Synced viewer는 PDF와 슬라이드별 노트를 나란히 보여 주므로 이 노트에는 쓸 수 없습니다.",
            "강의 PDF를 첨부하면 다음 가져오기에서 슬라이드 노트로 바뀌고(슬라이드별 해설, 전사 정렬, 슬라이드 대조 검증) synced viewer로 볼 수 있습니다. 지금 노트의 내용과 내 메모는 '이전 노트 백업'에 그대로 남습니다.",
          ];
    const choice = await choose(
      this.app,
      "Synced viewer를 열 수 없습니다",
      paragraphs,
      pending && summaryNote ? [{ id: "close", text: "닫기", cta: true }] : [{ id: "close", text: "닫기" }, { id: "attach", text: "PDF 첨부", cta: true }]
    );
    if (choice === "attach") await this.attachPdfInteractive(notePath);
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
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
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
      console.warn("[Alt2Obs] alignment check failed, keeping the script alignment:", e);
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
      .filter((f) => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        return !lectures.has(f.path) && fm?.source !== "alt2obsidian-verify" && !isBriefFrontmatter(fm);
      })
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
      if (usage.total().calls > 0) await this.recordUsage(usage, false).catch((e) => console.warn("[Alt2Obs] usage record failed:", e));
    }
  }

  /**
   * Claims, evidence and the estimate (no tokens): the lecture's slide texts
   * from its sibling PDF, its timestamped transcript and stored alignment
   * when it is an Alt local note. A lecture without slides (a transcript
   * summary note, or any lecture note with no PDF) is checked against its
   * transcript sections instead (spec 4.10).
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
    const lectureContent = await this.app.vault.cachedRead(target);
    // A summary note; a slide note keeps an old summary note only as a backup (its section markers there do not count).
    const transcriptNote =
      this.frontmatterOf(input.targetPath)?.alt_kind === "transcript" || (hasSectionMarkers(lectureContent) && !hasMultiManagedMarkers(lectureContent));
    if (!pdf || !this.pdfProcessor || transcriptNote) return this.prepareTranscriptVerification(target, lectureContent, input, outPath);
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
   * Verification of a lecture without slides: the evidence is its
   * timestamped transcript, cut into the note's sections (their headings
   * carry the times). A URL import has no timestamps and cannot be checked.
   */
  private async prepareTranscriptVerification(
    target: TFile,
    lectureContent: string,
    input: { markdown: string; source: string },
    outPath: string
  ): Promise<PreparedVerification> {
    const id = this.frontmatterOf(target.path)?.alt_local_id;
    const segments = typeof id === "string" && id ? await this.loadTranscript(id) : null;
    if (!segments || segments.length === 0) {
      throw new Error(
        `강의 PDF도, 시각이 있는 전사도 없어 대조할 수 없습니다: ${target.path}. URL로 가져온 강의의 전사에는 시각이 없습니다. 강의 PDF를 첨부해 다시 가져오거나, Alt 노트 목록에서 가져온 강의를 고르세요.`
      );
    }
    const sections = verifySectionsFromNote(lectureContent, segments);
    const plan = planVerification({ lecture: target.basename, notePath: target.path, noteMarkdown: input.markdown, slideTexts: [], transcript: { segments, spans: null }, sections });
    return this.withVerifyChoice({ targetPath: target.path, outPath, source: input.source, plan }, this.data.settings.tasks.verification);
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
        await this.recordUsage(usage, false).catch((e) => console.warn("[Alt2Obs] usage record failed:", e));
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
      const detection: CliDetection = {
        path: resolved.path,
        version: resolved.version ?? "",
        detectedAt: new Date().toISOString(),
        featuresOk: true,
        optionalFeatures: resolved.optional ?? [],
      };
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
    // A cached path from before the feature check (or the optional feature check of 2.1.0) is checked again.
    if (cached && (!configured || configured === cached.path) && isExecutable(cached.path) && cached.featuresOk && cached.optionalFeatures) return cached.path;
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
      new Notice("Alt2Obs: 로그인된 Claude CLI가 없어 작업을 Codex CLI로 설정했습니다. 설정의 '작업별 모델'에서 확인하세요.");
    } else if (!cli) {
      new Notice("Alt2Obs: Claude Code나 Codex CLI가 필요합니다. 설치하고 로그인한 뒤 설정의 'LLM 연결'에서 '다시 찾기'를 누르세요.");
    }
    await this.savePluginData();
  }

  /** Once after the version 3 migration filled empty model/effort values. */
  private async showFilledNotice(): Promise<void> {
    const lines = this.data.pendingFilledNotice;
    if (!lines || lines.length === 0) return;
    new Notice(
      "Alt2Obs: 'CLI 기본값'(빈 칸)이던 모델과 effort를 작업 기본값으로 바꿨습니다.\n" +
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
    notePath?: string,
    brief?: BriefStepContext
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
    await this.writeBriefAfterImport(notePath, brief, onProgress);

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
    const prompt = renderPrompt(lectureNoteEnhanceMaterialTemplate, {
      summary: this.truncateForPrompt(summary, 18000),
      pageCount: materialContext.pageCount,
      excerptPageCount: materialContext.pages.length,
      excerptScope: materialContext.truncated ? "일부 발췌" : "전체 발췌",
      materialText: materialContext.text,
    });

    return llm.generateText(prompt, {
      systemPrompt: renderPrompt(lectureNoteSystemTemplate, {}),
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
    const prompt = renderPrompt(lectureNoteFromMaterialTemplate, {
      memoContext,
      pageCount: materialContext.pageCount,
      excerptPageCount: materialContext.pages.length,
      materialText: materialContext.text,
    });

    return llm.generateText(prompt, {
      systemPrompt: renderPrompt(lectureNoteSystemTemplate, {}),
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

  /** Alt's (or the URL's) PDF, with the download error when there was a PDF to download and it failed. */
  private async fetchAltPdf(preview: ImportPreview): Promise<{ data: ArrayBuffer | null; error: string | null }> {
    if (preview.pdfData) return { data: preview.pdfData, error: null };
    if (!preview.pdfUrl || !this.pdfProcessor) return { data: null, error: null };
    try {
      return { data: await this.pdfProcessor.downloadPdf(preview.pdfUrl), error: null };
    } catch (e) {
      console.warn("[Alt2Obs] PDF download failed:", e);
      return { data: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async downloadPdfForImport(
    preview: ImportPreview
  ): Promise<ArrayBuffer | null> {
    if (preview.pdfData) return preview.pdfData;
    if (!preview.pdfUrl || !this.pdfProcessor) return null;

    try {
      return await this.pdfProcessor.downloadPdf(preview.pdfUrl);
    } catch (e) {
      console.warn("[Alt2Obs] PDF download failed:", e);
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
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_SIDEBAR,
        active: true,
      });
      void this.app.workspace.revealLeaf(leaf);
    }
  }

  async loadPluginData(): Promise<void> {
    const own = (await this.loadData()) as (Record<string, unknown> & { altToObsImport?: unknown }) | null;
    // 2.0.0 ran under the id alt-to-obs (spec D13). Its data comes along once:
    // on the first start of 2.0.1 or later when it is the data to take (see
    // altToObsIsNewer), or on a later start when it could not be read before.
    const retry = own?.altToObsImport === "retry";
    const altToObs = own?.altToObsImport === "done" ? null : await this.readAltToObsData();
    const found = altToObs && altToObs.state !== "missing" ? altToObs : null;
    const take = !!found && (retry || (await this.altToObsIsNewer(own, found.mtime)));
    const imported = take && found?.state === "ok" ? withoutLegacyKeys(found.data) : null;
    const saved = (imported || own || {}) as Partial<PluginData> & Record<string, unknown>;
    this.data = Object.assign({}, DEFAULT_PLUGIN_DATA, saved);
    // Keep every 1.x value; add the 2.0 per-task settings (spec 4.2).
    const { settings, needsCliDefault, movedTasks, removedFrom, filled } = migrateSettings(saved.settings);
    this.data.settings = settings;
    // 2.0.2's transcript cap default: a saved 600 (the old default) becomes 1200 once per data, 2.0.0's imported data included.
    const capMoved = !saved.transcriptCapChecked && moveOldTranscriptCap(settings);
    this.data.transcriptCapChecked = true;
    // Removed in 2.0.0-beta.4 with the Gemini/Ollama providers.
    delete (this.data as { cliSwitchOffered?: boolean }).cliSwitchOffered;
    // 2.0.0's flags for its own import from this folder mean nothing here.
    delete (this.data as { legacyImportRetry?: boolean }).legacyImportRetry;
    delete (this.data as { pendingRenameNotice?: boolean }).pendingRenameNotice;
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
    } else if (this.data.pendingMovedTasks && !(typeof saved.settings?.settingsVersion === "number" && saved.settings.settingsVersion >= 4)) {
      // A CLI default still pending from data before version 4: the chat and brief tasks it just got follow the commentary task.
      this.data.pendingMovedTasks = withTasksSinceV4(this.data.pendingMovedTasks, settings);
    }
    if (removedFrom.length > 0) this.data.removedProviderNotice = removedFrom;
    if (filled.length > 0) this.data.pendingFilledNotice = describeFilled(filled);
    this.altToObsReadError = take && found?.state === "unreadable" ? found.error : null;
    if (imported) {
      // Saved now, so the import happens once; 2.0.0's folder is left as it is.
      this.data.altToObsImport = "done";
      this.data.pendingAltToObsNotice = true;
      await this.savePluginData();
    } else if (take) {
      // Unreadable. Not a fresh install: whatever is saved from now on asks for another try next start.
      this.data.altToObsImport = "retry";
      // Saved now when the transcript cap moved, so the move happens once.
      if (capMoved) await this.savePluginData();
    } else {
      this.data.altToObsImport = "done";
      // 2.0.0's data left out because this data is newer: told once, with the command that imports it anyway.
      if (found?.state === "ok") this.data.pendingAltToObsKeptNotice = true;
      // Saved now when this decided something: 2.0.0's older data stays out for good, nothing is left to retry, or the transcript cap moved.
      if (found || retry || capMoved) await this.savePluginData();
    }
  }

  /**
   * Command "Import settings from version 2.0.0 (alt-to-obs)": after the
   * user confirms, 2.0.0's data.json replaces this plugin's settings and
   * records now.
   */
  private async confirmAltToObsImport(): Promise<void> {
    const answer = await choose(
      this.app,
      "2.0.0 설정 가져오기",
      [
        `${this.altToObsDir()}/data.json의 설정과 기록(CLI 경로, 사용량, 최근 노트, 첨부 기록)으로 지금 설정과 기록을 바꿉니다. 노트와 폴더는 그대로입니다.`,
        "예전 API 키는 가져오지 않고, 2.0.0의 폴더는 바꾸지 않습니다.",
      ],
      [
        { id: "import", text: "가져오기", cta: true },
        { id: "cancel", text: "취소" },
      ]
    );
    if (answer === "import") await this.importAltToObsNow();
  }

  /**
   * 2.0.0's data.json replaces this plugin's data now, the way a start
   * whose import is still to be retried takes it (see loadPluginData):
   * read only, without old API keys, saved once; the user is told what
   * happened.
   */
  async importAltToObsNow(): Promise<void> {
    this.data.altToObsImport = "retry";
    await this.savePluginData();
    await this.loadPluginData();
    this.updateBasePath();
    this.applyCommentHiding();
    if (this.data.pendingAltToObsNotice || this.altToObsReadError !== null) await this.showAltToObsNotices();
    else new Notice(`Alt2Obs: ${this.altToObsDir()}/data.json이 없어 가져올 것이 없습니다.`);
  }

  /** Why 2.0.0's data.json could not be read on this start (shown once on layout ready); null when it was. */
  private altToObsReadError: string | null = null;

  /** This plugin's folder in the config folder. */
  private ownDir(): string {
    return normalizePath(this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
  }

  /** 2.0.0's folder in this vault's config folder. */
  private altToObsDir(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${ALT_TO_OBS_ID}`);
  }

  /**
   * 2.0.0's data.json in this vault's config folder. Read only: that folder
   * is never changed or removed. When 2.0.1 files were copied into it, it is
   * this plugin's own folder and there is nothing to import.
   */
  private async readAltToObsData(): Promise<AltToObsRead> {
    const dir = this.altToObsDir();
    if (dir === this.ownDir()) return { state: "missing" };
    const path = `${dir}/data.json`;
    let mtime: number | null = null;
    try {
      if (!(await this.app.vault.adapter.exists(path))) return { state: "missing" };
      mtime = await this.configMtime(path);
      const data: unknown = JSON.parse(await this.app.vault.adapter.read(path));
      if (data === null) return { state: "missing" };
      if (typeof data === "object" && !Array.isArray(data)) return { state: "ok", data: data as Record<string, unknown>, mtime };
      return { state: "unreadable", error: "설정 객체가 아님", mtime };
    } catch (e) {
      console.warn("[Alt2Obs] the 2.0.0 (alt-to-obs) data could not be read:", e);
      return { state: "unreadable", error: e instanceof Error ? e.message : String(e), mtime };
    }
  }

  /** Modification time of a file in the config folder; null when unknown. */
  private async configMtime(path: string): Promise<number | null> {
    try {
      return (await this.app.vault.adapter.stat(path))?.mtime ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 2.0.0's data is the one to take: this plugin has no data yet, or 2.0.0's
   * data.json changed after this plugin's did. 2.0.0 imported the 1.x or
   * beta data in this folder on its first start and went on from there, so
   * its data is newer; only a data.json of this folder written later (1.x or
   * a beta used again after 2.0.0) keeps it out. An unknown time counts as
   * newer.
   */
  private async altToObsIsNewer(own: unknown, altToObsMtime: number | null): Promise<boolean> {
    if (!own) return true;
    const ownMtime = await this.configMtime(`${this.ownDir()}/data.json`);
    return altToObsMtime === null || ownMtime === null || altToObsMtime >= ownMtime;
  }

  /**
   * Tabs of 2.0.0's views that Obsidian kept (the sidebar and the Synced
   * Viewer under 2.0.0's view types) become this plugin's views with the
   * same state. Only when 2.0.0 is not enabled, so its own tabs are never
   * taken over.
   */
  async adoptAltToObsLeaves(): Promise<number> {
    if (await this.altToObsEnabled()) return 0;
    let converted = 0;
    for (const [oldType, newType] of Object.entries(ALT_TO_OBS_VIEW_TYPES)) {
      for (const leaf of this.app.workspace.getLeavesOfType(oldType)) {
        await leaf.setViewState({ ...leaf.getViewState(), type: newType, active: false });
        converted++;
      }
    }
    return converted;
  }

  /**
   * 2.0.0 is installed and enabled in this vault (read from the config
   * folder): community-plugins.json lists alt-to-obs and that folder's
   * manifest has that id (not 2.0.1 files copied into it).
   */
  private async altToObsEnabled(): Promise<boolean> {
    const { adapter, configDir } = this.app.vault;
    try {
      const enabled: unknown = JSON.parse(await adapter.read(normalizePath(`${configDir}/community-plugins.json`)));
      if (!Array.isArray(enabled) || !enabled.includes(ALT_TO_OBS_ID)) return false;
      const manifest = JSON.parse(await adapter.read(`${this.altToObsDir()}/manifest.json`)) as { id?: unknown };
      return manifest.id === ALT_TO_OBS_ID;
    } catch {
      return false;
    }
  }

  /**
   * After the return to the id alt2obsidian (2.0.1): once after 2.0.0's data
   * was imported, and on every start while 2.0.0 is still enabled (both
   * would turn lecture PDFs into a viewer, hide comments and so on).
   */
  async showAltToObsNotices(): Promise<void> {
    if (this.altToObsReadError !== null) {
      new Notice(
        `Alt2Obs: 2.0.0(플러그인 폴더 alt-to-obs)의 설정 파일(data.json)을 읽지 못해 가져오지 못했습니다: ${this.altToObsReadError}. ` +
          "Obsidian을 켤 때마다 다시 시도하고, 읽히면 그 설정과 기록으로 바꿉니다. 그 폴더는 바꾸지 않습니다.",
        0
      );
      this.altToObsReadError = null;
    }
    // 2.0.0, while enabled, tells the user to remove "Alt2Obsidian": that is this plugin (its folder and id).
    const notThis = "2.0.0이 Alt2Obsidian을 끄고 삭제하라고 알리면 이 플러그인을 가리키는 것이니 따르지 마세요.";
    if (this.data.pendingAltToObsNotice) {
      new Notice(
        "Alt2Obs: 2.0.0(플러그인 폴더 alt-to-obs)의 설정과 기록을 가져왔습니다. 노트와 폴더는 그대로입니다. " +
          "설정 → 커뮤니티 플러그인에서 버전이 2.0.0인 Alt2Obs를 끄고 삭제하세요. 2.0.0이 켜져 있는 동안은 두 플러그인 모두 강의 PDF를 뷰어로 바꾸지 않습니다. " +
          `${notThis} 2.0.0 명령에 단축키를 지정했다면 다시 지정하세요.`,
        0
      );
      delete this.data.pendingAltToObsNotice;
      await this.savePluginData();
      return;
    }
    if (this.data.pendingAltToObsKeptNotice) {
      new Notice(
        `Alt2Obs: 이 플러그인의 data.json이 2.0.0의 ${this.altToObsDir()}/data.json보다 나중에 바뀌어, 2.0.0의 설정과 기록은 가져오지 않았습니다. ` +
          "2.0.0의 것을 쓰려면 명령 팔레트에서 'Import settings from version 2.0.0 (alt-to-obs)'를 실행하세요(지금 설정과 기록을 그것으로 바꿈). " +
          "필요 없으면 버전이 2.0.0인 Alt2Obs를 끄고 삭제하세요.",
        0
      );
      delete this.data.pendingAltToObsKeptNotice;
      await this.savePluginData();
    }
    if (await this.altToObsEnabled()) {
      new Notice(
        "Alt2Obs: 2.0.0(플러그인 폴더 alt-to-obs)이 아직 켜져 있습니다. 그동안 두 플러그인 모두 강의 PDF를 뷰어로 바꾸지 않습니다. " +
          `설정 → 커뮤니티 플러그인에서 버전이 2.0.0인 Alt2Obs를 끄고 삭제하세요. ${notThis}`,
        15000
      );
    }
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }
}
