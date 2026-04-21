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

export interface SlideImage {
  pageNum: number;
  data: ArrayBuffer;
  filename: string;
}

export interface LLMResult {
  processedSummary: string;
  concepts: ConceptData[];
  tags: string[];
  subjectSuggestion: string;
  imagePlacements: ImagePlacement[];
}

export interface ConceptData {
  name: string;
  definition: string;
  relatedConcepts: string[];
}

export interface ConceptNote {
  name: string;
  definition: string;
  relatedLectures: string[];
  relatedConcepts: string[];
}

export interface ImagePlacement {
  imageIndex: number;
  afterSection: string;
}

export interface ImportRecord {
  url: string;
  title: string;
  subject: string;
  path: string;
  date: string;
  parseQuality: "full" | "partial";
  examPeriod?: ExamPeriod;
  pdfPath?: string;
}

export interface ImportPreview {
  altData: AltNoteData;
  pdfData: ArrayBuffer | null;
  slideThumbnails: string[];
  suggestedSubject: string;
  slideCount: number;
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
  estimateTokens(text: string): number;
}
