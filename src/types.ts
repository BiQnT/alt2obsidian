export interface Alt2ObsidianSettings {
  apiKey: string;
  provider: "gemini" | "openai" | "claude";
  geminiModel: string;
  baseFolderPath: string;
  language: "ko" | "en";
  rateDelayMs: number;
}

export const DEFAULT_SETTINGS: Alt2ObsidianSettings = {
  apiKey: "",
  provider: "gemini",
  geminiModel: "gemini-2.5-flash",
  baseFolderPath: "Alt2Obsidian",
  language: "ko",
  rateDelayMs: 4000,
};

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
  noteId: string;
  createdAt: string | null;
  visibility: string | null;
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
}

export interface ImportRecord {
  url: string;
  title: string;
  subject: string;
  path: string;
  date: string;
  parseQuality: "full" | "partial";
  altId?: string;
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
}

export interface PluginData {
  settings: Alt2ObsidianSettings;
  recentImports: ImportRecord[];
}

export const DEFAULT_PLUGIN_DATA: PluginData = {
  settings: DEFAULT_SETTINGS,
  recentImports: [],
};

export interface LLMProvider {
  name: string;
  maxInputTokens: number;
  generateText(
    prompt: string,
    options?: { systemPrompt?: string; maxOutputTokens?: number }
  ): Promise<string>;
  generateJSON<T>(
    prompt: string,
    validate: (raw: unknown) => T,
    options?: { systemPrompt?: string }
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
}

export const MANAGED_NOTE_START = "<!-- alt2obsidian:start -->";
export const MANAGED_NOTE_END = "<!-- alt2obsidian:end -->";
