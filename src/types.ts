import type { LectureBundle, SourceKind } from "./sources/types";

/** LLM backends. The CLI providers run the user's installed `claude` / `codex`. */
export type ProviderId = "claude-cli" | "codex-cli" | "gemini" | "ollama";

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
  /** Per-slide transcript cap after compression (spec 5.1). */
  transcriptCapChars: number;
  /** Estimated input + output tokens per lecture. 0 = no cap. */
  tokenCapPerLecture: number;
  /** Save image-heavy slides to Attachments/ and embed them in the note (spec 4.8). */
  saveKeyDiagrams: boolean;
  /** Re-import: reuse slides whose text hash and image signal are unchanged. */
  onlyChangedSlides: boolean;
}

export interface Alt2ObsidianSettings {
  apiKey: string;
  /**
   * 1.x single provider. Kept for Gemini/Ollama users and as the migration
   * source for `tasks`; 2.0 code reads `tasks` instead.
   */
  provider: "gemini" | "openai" | "claude" | "ollama";
  geminiModel: string;
  /** Ollama endpoint (http://localhost:11434 default). Used when provider="ollama". */
  ollamaEndpoint: string;
  /** Ollama model id, e.g. "gemma3:4b" (text), "llama3.2-vision:11b" (multimodal). */
  ollamaModel: string;
  baseFolderPath: string;
  language: "ko" | "en";
  rateDelayMs: number;
  /** 2 since 2.0.0-beta.1. Missing = 1.x data. */
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
}

export const DEFAULT_GENERATION: GenerationOptions = {
  batchSize: 8,
  imageRule: "auto",
  transcriptCapChars: 600,
  tokenCapPerLecture: 0,
  saveKeyDiagrams: true,
  onlyChangedSlides: true,
};

/** Spec 4.2 / D5 defaults, used when the Claude CLI is chosen. */
export const CLAUDE_TASK_DEFAULTS: Record<TaskId, TaskLLMSetting> = {
  commentary: { provider: "claude-cli", model: "sonnet", effort: "medium" },
  concepts: { provider: "claude-cli", model: "haiku", effort: "low" },
  alignment: { provider: "none", model: "", effort: "" },
  verification: { provider: "claude-cli", model: "sonnet", effort: "medium" },
};

export const DEFAULT_SETTINGS: Alt2ObsidianSettings = {
  apiKey: "",
  provider: "gemini",
  geminiModel: "gemini-2.5-flash",
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "gemma3:4b",
  baseFolderPath: "Alt2Obsidian",
  language: "ko",
  rateDelayMs: 4000,
  settingsVersion: 2,
  claudePath: "",
  codexPath: "",
  cliTimeoutSec: 300,
  tasks: {
    commentary: { provider: "gemini", model: "", effort: "" },
    concepts: { provider: "gemini", model: "", effort: "" },
    alignment: { provider: "none", model: "", effort: "" },
    verification: { provider: "gemini", model: "", effort: "" },
  },
  preset: "custom",
  recentModels: {},
  generation: DEFAULT_GENERATION,
  altDataDir: "",
  notionFetchTool: "",
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
 * Reference to a single PDF page rendered to a base64 PNG, suitable for
 * inline-data multimodal LLM calls (e.g., Gemini's `inlineData`).
 * Produced by `PdfProcessor.renderPagesToImages`.
 */
export interface VisionImageRef {
  pageNum: number;
  base64Png: string;
}

/**
 * Per-slide commentary produced by `PerSlideCommentaryGenerator`. The hash is
 * the 8-hex SHA-1 of the rendered slide PNG and drives the page-anchored
 * managed-block markers (plan §B Decision B). `commentary` is the LLM's
 * markdown body for that slide — no headers, no markers; the assembler
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
  // is the spike-validated 2-pass routine — see
  // .omc/research/spike-1.0b-hash-algo.md §3.
  slideReorders?: Array<{ from: number; to: number; hash: string }>;
  slideInsertions?: number[];
  slideDeletions?: Array<{ slideNum: number; hash: string }>;
  slideDrifts?: Array<{ slideNum: number; oldHash: string; newHash: string }>;
  /**
   * True when more than half of existing sections orphaned — likely the user
   * accidentally re-imported a different lecture onto this file. Caller should
   * confirm before write (plan §B v1.1 deck-replacement modal touch-up).
   */
  confirmDeckReplacement?: boolean;
  /** Free-text notes appended to the user-facing summary modal. */
  notes?: string[];
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
  settings: Alt2ObsidianSettings;
  recentImports: ImportRecord[];
  cliDetection: Partial<Record<CliName, CliDetection>>;
  usageTotals: UsageTotals;
  /** Set by the 1.x migration until the Claude CLI lookup has run once. */
  pendingCliDefault?: boolean;
  /** A working 1.x setup was kept although a logged-in Claude CLI exists: show the switch button. */
  cliSwitchOffered?: boolean;
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
  /**
   * Optional multimodal call (text prompt + 1+ inline images). Required for
   * the per-slide commentary path (plan Task 1.1). GeminiProvider implements
   * it via the `inlineData` field; OpenAI/Claude/Ollama providers without
   * vision support throw or return a useful error.
   */
  generateMultimodal?(
    prompt: string,
    images: VisionImageRef[],
    options?: { systemPrompt?: string; maxOutputTokens?: number }
  ): Promise<string>;
  estimateTokens(text: string): number;
  /** Releases temp files (CLI providers). */
  dispose?(): void;
}

export const MANAGED_NOTE_START = "<!-- alt2obsidian:start -->";
export const MANAGED_NOTE_END = "<!-- alt2obsidian:end -->";

export const OVERVIEW_BLOCK_START = "<!-- alt2obs:overview start -->";
export const OVERVIEW_BLOCK_END = "<!-- alt2obs:overview end -->";
