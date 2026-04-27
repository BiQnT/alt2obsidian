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
  estimateTokens(text: string): number;
}

export const MANAGED_NOTE_START = "<!-- alt2obsidian:start -->";
export const MANAGED_NOTE_END = "<!-- alt2obsidian:end -->";
