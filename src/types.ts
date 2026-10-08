import type { LectureBundle, SourceKind } from "./sources/types";

/**
 * LLM backends: the user's installed `claude` / `codex`. Gemini API and
 * Ollama were removed in 2.0.0-beta.4; saved settings naming them are
 * mapped to a CLI on load (src/settings/llmSettings.ts).
 */
export type ProviderId = "claude-cli" | "codex-cli";

/**
 * Tasks with their own provider, model and effort (spec 4.2). `alignment`
 * is the optional LLM check of low-confidence transcript alignment (off =
 * "none", the default); `verification` judges the user's notes (spec 4.6).
 */
export type TaskId = "commentary" | "concepts" | "alignment" | "verification";

/** "" = the CLI's own default. Mapped per CLI (Claude `--effort`, Codex `model_reasoning_effort`). */
export type EffortLevel = "" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TaskLLMSetting {
  provider: ProviderId | "none";
  /** Free text. "" = the provider's default model. */
  model: string;
  effort: EffortLevel;
}

export type PresetId = "saving" | "quality" | "custom";

/** "auto": images only for visual slides or PDFs without a text layer (spec 5.2). */
export type ImageRule = "auto" | "text-only";

export interface GenerationOptions {
  /** Slides per CLI call (spec 5.3). Batches with images use half. */
  batchSize: number;
  imageRule: ImageRule;
  /** Per-slide transcript cap after compression (spec 5.1). 1200 since 2.0.2, 600 before. */
  transcriptCapChars: number;
  /** Estimated input + output tokens per lecture. 0 = no cap. */
  tokenCapPerLecture: number;
  /** Save image-heavy slides to Attachments/ and embed them in the note (spec 4.8). */
  saveKeyDiagrams: boolean;
  /** Re-import: reuse slides whose text hash and image signal are unchanged. */
  onlyChangedSlides: boolean;
}

export interface Alt2ObsSettings {
  baseFolderPath: string;
  language: "ko" | "en";
  /**
   * 2 since 2.0.0-beta.1, 3 since 2.0.0-beta.4 (CLI providers only, empty
   * model and effort filled with the task defaults). Missing = 1.x data.
   */
  settingsVersion: number;
  /** Absolute path overrides. "" = auto-detect (spec 4.2 rule 1). */
  claudePath: string;
  codexPath: string;
  /** Per-call timeout for CLI providers (spec 4.2 rule 5). */
  cliTimeoutSec: number;
  tasks: Record<TaskId, TaskLLMSetting>;
  preset: PresetId;
  /** Recently used model names per provider, newest first. */
  recentModels: Partial<Record<ProviderId, string[]>>;
  generation: GenerationOptions;
  /** Alt's data folder override (read only). "" = the platform default. */
  altDataDir: string;
  /**
   * Notion MCP fetch tool for the note verifier, e.g.
   * "mcp__notion__notion-fetch". "" = found with `claude mcp list`.
   */
  notionFetchTool: string;
  /**
   * Hide the alt2obs management comments (slide markers, metadata, overview
   * markers) in Live Preview and in the Synced Viewer. The note text is
   * never changed.
   */
  hideManagedComments: boolean;
  /**
   * Opening a lecture PDF (a PDF next to a lecture note of the same name)
   * in a normal tab opens the Synced Viewer for the pair instead.
   */
  openPdfInViewer: boolean;
}

export const DEFAULT_GENERATION: GenerationOptions = {
  batchSize: 8,
  imageRule: "auto",
  transcriptCapChars: 1200,
  tokenCapPerLecture: 0,
  saveKeyDiagrams: true,
  onlyChangedSlides: true,
};

/**
 * Model and effort a task gets when its provider is chosen (spec 4.2 / D5).
 * Codex has no stable model alias, so its model stays "" (the model in
 * ~/.codex/config.toml) and only the effort is set.
 */
export const TASK_DEFAULTS: Record<ProviderId, Record<TaskId, { model: string; effort: EffortLevel }>> = {
  "claude-cli": {
    commentary: { model: "sonnet", effort: "medium" },
    concepts: { model: "haiku", effort: "low" },
    alignment: { model: "haiku", effort: "low" },
    verification: { model: "sonnet", effort: "medium" },
  },
  "codex-cli": {
    commentary: { model: "", effort: "medium" },
    concepts: { model: "", effort: "low" },
    alignment: { model: "", effort: "low" },
    verification: { model: "", effort: "medium" },
  },
};

/** Default task table: everything on the Claude CLI, the alignment check off. */
export const CLAUDE_TASK_DEFAULTS: Record<TaskId, TaskLLMSetting> = {
  commentary: { provider: "claude-cli", ...TASK_DEFAULTS["claude-cli"].commentary },
  concepts: { provider: "claude-cli", ...TASK_DEFAULTS["claude-cli"].concepts },
  alignment: { provider: "none", model: "", effort: "" },
  verification: { provider: "claude-cli", ...TASK_DEFAULTS["claude-cli"].verification },
};

export const DEFAULT_SETTINGS: Alt2ObsSettings = {
  // The folder name from before the rename to Alt2Obs (2.0.0): existing
  // vaults and the Skill keep writing to the same place.
  baseFolderPath: "Alt2Obsidian",
  language: "ko",
  settingsVersion: 3,
  claudePath: "",
  codexPath: "",
  cliTimeoutSec: 300,
  tasks: CLAUDE_TASK_DEFAULTS,
  preset: "custom",
  recentModels: {},
  generation: DEFAULT_GENERATION,
  altDataDir: "",
  notionFetchTool: "",
  hideManagedComments: true,
  openPdfInViewer: true,
};

/** 1.x exam period tag. Exam summaries are gone (spec G5); old records may still carry it. */
export type ExamPeriod = "midterm" | "final";

export interface AltNoteData {
  title: string;
  summary: string;
  pdfUrl: string | null;
  transcript: string | null;
  metadata: AltNoteMetadata;
  parseQuality: "full" | "partial";
}

export interface AltNoteMetadata {
  /** Public share id (URL source) or Alt local UUID (local sources). */
  noteId: string;
  createdAt: string | null;
  visibility: string | null;
  /** Missing = "alt-url" (1.x). Local notes get `alt_local_id` instead of `alt_id`. */
  sourceKind?: SourceKind;
}

export interface LLMResult {
  processedSummary: string;
  concepts: ConceptData[];
  tags: string[];
  subjectSuggestion: string;
  /**
   * Concept notes already in the subject folder: a link the model wrote to
   * one of them under another name is pointed at the note's real name.
   */
  knownConceptNames?: string[];
}

export interface ConceptData {
  name: string;
  definition: string;
  relatedConcepts: string[];
  example?: string;
  caution?: string;
  lectureContext?: string;
}

export interface ConceptNote {
  name: string;
  definition: string;
  relatedLectures: string[];
  relatedConcepts: string[];
  example?: string;
  caution?: string;
  lectureContext?: string;
}

export interface LectureMaterialPage {
  pageNum: number;
  text: string;
  score: number;
}

export interface LectureMaterialContext {
  pageCount: number;
  pages: LectureMaterialPage[];
  text: string;
  extractedCharCount: number;
  truncated: boolean;
}

/**
 * A single PDF page rendered to a base64 PNG (key diagram images).
 * Produced by `PdfProcessor.renderPagesToImages`.
 */
export interface VisionImageRef {
  pageNum: number;
  base64Png: string;
}

/**
 * Per-slide commentary produced by `BatchCommentaryGenerator`. The hash is
 * the 8-hex SHA-1 of the rendered slide PNG and drives the page-anchored
 * managed-block markers (plan §B Decision B). `commentary` is the LLM's
 * markdown body for that slide: no headers, no markers; the assembler
 * (Task 1.2) wraps it in `## 📚 슬라이드 N` + `<!-- alt2obs:slide:... -->`.
 */
export interface SlideSection {
  slideNum: number;
  hash: string;
  commentary: string;
  citedConcepts: string[];
  /** 2.0 metadata comment (src/core/slideMeta.ts), appended after concept linking. */
  meta?: string;
  /** Vault path of the slide's saved diagram image (spec 4.8), embedded before `meta`. */
  diagram?: string;
}

export interface PerSlideGenerationResult {
  slides: SlideSection[];
  totalWallTimeMs: number;
  perSlideWallTimeMs: number[];
  errors: Array<{ slideNum: number; reason: string }>;
}

export interface ImportUpdateSummary {
  isUpdate: boolean;
  addedSections: string[];
  removedSections: string[];
  addedConcepts: string[];
  removedConcepts: string[];
  changedLineCount: number;
  // Page-anchored (B1 multi-managed-block) merge details. Populated only when
  // both the existing and the next file use B1 markers. The merge algorithm
  // is the spike-validated 2-pass routine, see
  // .omc/research/spike-1.0b-hash-algo.md §3.
  slideReorders?: Array<{ from: number; to: number; hash: string }>;
  slideInsertions?: number[];
  slideDeletions?: Array<{ slideNum: number; hash: string }>;
  slideDrifts?: Array<{ slideNum: number; oldHash: string; newHash: string }>;
  /**
   * True when more than half of existing sections orphaned: likely the user
   * accidentally re-imported a different lecture onto this file. Caller should
   * confirm before write (plan §B v1.1 deck-replacement modal touch-up).
   */
  confirmDeckReplacement?: boolean;
  /** Free-text notes appended to the user-facing summary modal. */
  notes?: string[];
  /** What the slide* fields count: slides (default) or transcript sections (spec 4.10). */
  unit?: "slide" | "section";
}

export interface ImportRecord {
  url: string;
  title: string;
  subject: string;
  path: string;
  date: string;
  parseQuality: "full" | "partial";
  altId?: string;
  /** Alt local UUID (local sources). */
  altLocalId?: string;
  /** 1.x only (exam summaries were removed in 2.0); kept so old records load. */
  examPeriod?: ExamPeriod;
  pdfPath?: string;
  wasUpdate?: boolean;
  updateSummary?: ImportUpdateSummary;
}

export interface ImportPreview {
  altData: AltNoteData;
  pdfData: ArrayBuffer | null;
  pdfUrl?: string | null;
  suggestedSubject: string;
  /** Local sources: the full bundle (timestamped transcript for alignment). */
  bundle?: LectureBundle;
}

/** Token usage of LLM calls, as reported by the CLI JSON output (spec 5.5). */
export interface LLMUsage {
  calls: number;
  inputTokens: number;
  /** Part of `inputTokens` served from the prompt cache. */
  cachedInputTokens: number;
  outputTokens: number;
  imagesSent: number;
  /** Claude CLI reports an API-equivalent cost; 0 when unknown. */
  costUsd: number;
}

export const EMPTY_USAGE: LLMUsage = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  imagesSent: 0,
  costUsd: 0,
};

export interface UsageTotals extends LLMUsage {
  lectures: number;
  byProvider: Partial<Record<ProviderId, LLMUsage>>;
  since: string;
}

export type CliName = "claude" | "codex";

/** Result of the one-time binary lookup, cached in plugin data (spec 4.2 rule 1). */
export interface CliDetection {
  path: string;
  version: string;
  detectedAt: string;
  /** Its help listed every flag the providers pass (missing on data from before the check). */
  featuresOk?: boolean;
  /** Older than the tested version, with every flag present. */
  warning?: string;
}

export interface PluginData {
  settings: Alt2ObsSettings;
  recentImports: ImportRecord[];
  cliDetection: Partial<Record<CliName, CliDetection>>;
  usageTotals: UsageTotals;
  /**
   * Set by a migration (fresh install, 1.x data, or a task on the removed
   * Gemini/Ollama providers) until the CLI lookup has run once.
   */
  pendingCliDefault?: boolean;
  /** The tasks that migration set to the Claude CLI; only these may move on to Codex. */
  pendingMovedTasks?: TaskId[];
  /**
   * Removed providers the saved data used ("gemini", "ollama"): the user is
   * told once, with pendingCliDefault. `true` is the beta.4 form (Gemini).
   */
  removedProviderNotice?: Array<"gemini" | "ollama"> | boolean;
  /** Lines of the once-only Notice about empty model/effort filled with the task defaults. */
  pendingFilledNotice?: string[];
  /**
   * This data was imported from 2.0.0, released under the id "alt-to-obs"
   * (spec D13): the user is told once and asked to disable and remove it.
   */
  pendingAltToObsNotice?: boolean;
  /**
   * 2.0.0's data.json was there and readable but left out, because this
   * data.json changed later: the user is told once, with the command that
   * imports it anyway.
   */
  pendingAltToObsKeptNotice?: boolean;
  /**
   * The check for 2.0.0's data.json (`<configDir>/plugins/alt-to-obs/`).
   * Missing: not made yet (data of 1.x or a beta, or a fresh install not
   * saved yet). "done": made (imported, this data kept, or nothing there).
   * "retry": 2.0.0's data was the one to take but could not be read; every
   * start tries again, and data it can read replaces this data.
   */
  altToObsImport?: "done" | "retry";
  /**
   * The one-time move of a per-slide transcript cap still at 600, the
   * default before 2.0.2, to the new default (see moveOldTranscriptCap).
   * Missing: not made yet (data of 2.0.1 or older, 2.0.0's imported data,
   * or a fresh install not saved yet). true: made; a 600 saved from then on
   * is the user's own and stays. A flag of its own, not `settingsVersion`:
   * that is 3 from beta.4 on and older versions write 3 back.
   */
  transcriptCapChecked?: boolean;
  /**
   * The model id each requested model resolved to on its last real run
   * (Claude: the modelUsage key of the CLI result), keyed by
   * "<provider>:<requested>" ("" = the CLI default). Shown as "현재 ..."
   * next to aliases and as "마지막 실행" in the settings.
   */
  resolvedModels?: Record<string, { id: string; at: string }>;
  /**
   * PDFs the plugin copied next to a lecture note when the user attached
   * one (spec 4.10): path, size and SHA-1 at copy time. "첨부 해제" and "Alt
   * 슬라이드로 바꾸기" move a file to the trash only when it still matches
   * its record; any other file is the user's own and is never trashed.
   * Kept up to date on vault renames; records of missing files are pruned.
   */
  attachedCopies?: AttachedCopy[];
  /**
   * 2.0.0-beta.6 development data: paths of user files attached in place.
   * Read only, as "never trash" (renames still update it).
   */
  attachedInPlace?: string[];
}

/** A PDF the plugin copied when the user attached one. */
export interface AttachedCopy {
  path: string;
  size: number;
  /** Hex SHA-1 of the copied bytes. */
  sha1: string;
}

export const DEFAULT_PLUGIN_DATA: PluginData = {
  settings: DEFAULT_SETTINGS,
  recentImports: [],
  cliDetection: {},
  usageTotals: { ...EMPTY_USAGE, lectures: 0, byProvider: {}, since: "" },
};

/** An image handed to a CLI provider as a file (spec 5.2: JPEG, long edge 1024). */
export interface ImageInput {
  pageNum: number;
  mimeType: "image/jpeg" | "image/png";
  base64: string;
}

export interface TextCallOptions {
  systemPrompt?: string;
  maxOutputTokens?: number;
  /** Cancels the call (CLI providers kill the process group). */
  signal?: AbortSignal;
}

export interface JsonCallOptions {
  systemPrompt?: string;
  /** JSON Schema the CLI enforces (Claude `--json-schema`, Codex `--output-schema`). */
  schema?: Record<string, unknown>;
  images?: ImageInput[];
  signal?: AbortSignal;
  /** Calls made when the answer does not parse or validate. Default 2 (one retry). */
  attempts?: number;
  /** Multiplies the provider's per-call timeout (bigger batches, images). Default 1. */
  timeoutScale?: number;
}

export interface LLMProvider {
  name: string;
  maxInputTokens: number;
  /** True for providers that take a multi-slide JSON batch (the CLI providers). */
  supportsBatch?: boolean;
  generateText(prompt: string, options?: TextCallOptions): Promise<string>;
  generateJSON<T>(
    prompt: string,
    validate: (raw: unknown) => T,
    options?: JsonCallOptions
  ): Promise<T>;
  estimateTokens(text: string): number;
  /** Releases temp files (CLI providers). */
  dispose?(): void;
}

export const MANAGED_NOTE_START = "<!-- alt2obsidian:start -->";
export const MANAGED_NOTE_END = "<!-- alt2obsidian:end -->";

export const OVERVIEW_BLOCK_START = "<!-- alt2obs:overview start -->";
export const OVERVIEW_BLOCK_END = "<!-- alt2obs:overview end -->";
