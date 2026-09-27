// Lecture sources (spec 4.1). Every source returns the same LectureBundle.
// No obsidian import: the Skill CLI (scripts/src/alt-local.ts) shares them.

/** One transcript segment. URL source: times are null (no timestamps). */
export interface TranscriptSegment {
  startMs: number | null;
  endMs: number | null;
  text: string;
  speaker: string;
}

export type SourceKind = "alt-local" | "alt-url";

export interface LectureBundle {
  /** Alt local UUID, or the public share id for the URL source. */
  sourceId: string;
  sourceKind: SourceKind;
  title: string;
  /** YYYY-MM-DD when known. */
  lectureDate?: string;
  /** Alt folder names from the root down; used to infer the subject. */
  folderPath?: string[];
  pdf: ArrayBuffer | null;
  /** Local file the PDF was read from (local sources). */
  pdfPath?: string | null;
  /** Page texts, when the source has them; the pipeline extracts them from the PDF otherwise. */
  slideTexts: string[] | null;
  transcript: TranscriptSegment[];
  summaryMarkdown?: string;
  memoMarkdown?: string;
  /** Non-fatal problems met while reading (missing PDF file and so on). */
  warnings?: string[];
}

/** One Alt note in the sidebar list. */
export interface AltNoteSummary {
  id: string;
  title: string;
  /** lecture_notes.type: "slide" | "note" | "legacy" | ... */
  type: string;
  lectureDate: string | null;
  folderId: string | null;
  /** Folder names from the root down ([] = no folder). */
  folderPath: string[];
  updatedAt: string | null;
}

/** Cheap per-note details for the list line (slides, transcript length). */
export interface AltNoteDetails {
  hasSlides: boolean;
  /** Title of the slides component (usually the PDF file name without .pdf). */
  slidesTitle: string | null;
  pdfPath: string | null;
  /** Transcript length in minutes; null without a transcript. */
  transcriptMinutes: number | null;
  /** True when at least one segment carries timestamps (always for Alt local). */
  timestamps: boolean;
}

export type SourceMode = "api" | "db";

export interface AltLocalSource {
  mode: SourceMode;
  /** Status line for the sidebar ("Alt 연결됨 · 로컬 API"). */
  label: string;
  listNotes(): Promise<AltNoteSummary[]>;
  noteDetails(id: string): Promise<AltNoteDetails>;
  getBundle(id: string): Promise<LectureBundle>;
  close?(): void;
  /** True after a connection or ownership failure: connect again before the next use. */
  failed?: boolean;
}
