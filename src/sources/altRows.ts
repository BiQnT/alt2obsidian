// Alt rows (HTTP API responses and database rows have the same columns) to
// the source types. Pure except for the injected file reader.

import { componentTextToMarkdown } from "./plateToMarkdown";
import { AltNoteDetails, AltNoteSummary, LectureBundle, TranscriptSegment } from "./types";

export interface NoteRow {
  id: string;
  title: string | null;
  type: string | null;
  lecture_date: string | null;
  folder_id: string | null;
  updated_at?: string | null;
}

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface ComponentRow {
  id: string;
  note_id: string;
  component_type: string;
  title: string | null;
  content_text: string | null;
  metadata: string | null;
  display_order?: number | null;
  /** Local file of a file component (slides, recording), when known. */
  file_path?: string | null;
  /** Synced file reference (desktop sync); its local path is in the database only. */
  file_ref_id?: string | null;
}

export function folderChain(folderId: string | null, folders: Map<string, FolderRow>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let id = folderId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const f = folders.get(id);
    if (!f) break;
    names.unshift(f.name);
    id = f.parent_id;
  }
  return names;
}

export function toSummary(row: NoteRow, folders: Map<string, FolderRow>): AltNoteSummary {
  return {
    id: row.id,
    title: (row.title ?? "").trim() || "(제목 없음)",
    type: row.type ?? "",
    lectureDate: row.lecture_date ? String(row.lecture_date).slice(0, 10) : null,
    folderId: row.folder_id,
    folderPath: folderChain(row.folder_id, folders),
    updatedAt: row.updated_at ?? null,
  };
}

interface RawEntry {
  relativeStart?: number;
  originalText?: string;
  segments?: Array<{ start?: number; end?: number; text?: string; speaker?: string }>;
  speaker?: string;
}

/**
 * Transcript component JSON to segments. Segment `start`/`end` are already
 * recording-relative ms (Alt sets each entry's `relativeStart` to its first
 * segment's `start`); an entry without segments is one segment from its
 * `relativeStart` to the next entry's, like Alt's own flattening.
 */
export function parseTranscript(contentText: string | null | undefined): TranscriptSegment[] {
  if (!contentText) return [];
  let entries: RawEntry[];
  try {
    const v = JSON.parse(contentText);
    if (!Array.isArray(v)) return [];
    entries = v as RawEntry[];
  } catch {
    return [];
  }
  const out: TranscriptSegment[] = [];
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry.segments) && entry.segments.length > 0) {
      for (const s of entry.segments) {
        const text = typeof s?.text === "string" ? s.text.trim() : "";
        if (!text) continue;
        const start = typeof s.start === "number" ? s.start : null;
        const end = typeof s.end === "number" ? s.end : start;
        out.push({ startMs: start, endMs: end, text, speaker: typeof s.speaker === "string" ? s.speaker : entry.speaker ?? "" });
      }
      return;
    }
    const text = typeof entry.originalText === "string" ? entry.originalText.trim() : "";
    if (!text) return;
    const start = typeof entry.relativeStart === "number" ? entry.relativeStart : null;
    const next = entries[i + 1]?.relativeStart;
    const end = start !== null && typeof next === "number" && next > start ? next : start !== null ? start + 1 : null;
    out.push({ startMs: start, endMs: end, text, speaker: entry.speaker ?? "" });
  });
  // Entries are appended as recording goes on; keep time order anyway.
  if (out.every((s) => s.startMs !== null)) out.sort((a, b) => (a.startMs as number) - (b.startMs as number));
  return out;
}

export function transcriptMinutes(segments: TranscriptSegment[]): number | null {
  let end = 0;
  for (const s of segments) if (s.endMs !== null && s.endMs > end) end = s.endMs;
  return segments.length > 0 ? Math.max(1, Math.round(end / 60000)) : null;
}

function compareOptionalString(a: string | null | undefined, b: string | null | undefined): number {
  const x = a ?? "";
  const y = b ?? "";
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * Alt's display order (compareNoteComponentsForDisplay): display_order with
 * missing values last, then component_type, title and id.
 */
export function compareForDisplay(a: ComponentRow, b: ComponentRow): number {
  const oa = a.display_order ?? Number.MAX_SAFE_INTEGER;
  const ob = b.display_order ?? Number.MAX_SAFE_INTEGER;
  return oa - ob || compareOptionalString(a.component_type, b.component_type) || compareOptionalString(a.title, b.title) || compareOptionalString(a.id, b.id);
}

/**
 * The component Alt shows for a type (findDisplayComponentByType): a note
 * can hold several rows of one type (an older transcript, a replaced
 * summary); Alt uses the first in display order, and so does the import.
 */
export function displayComponent(components: ComponentRow[], type: string): ComponentRow | null {
  return [...components].sort(compareForDisplay).find((c) => c.component_type === type) ?? null;
}

/** The slides component the PDF comes from: the one Alt displays. */
export function pickSlides(components: ComponentRow[]): ComponentRow | null {
  return displayComponent(components, "slides");
}

export function detailsFromComponents(components: ComponentRow[]): AltNoteDetails {
  const slides = pickSlides(components);
  const transcript = parseTranscript(displayComponent(components, "transcript")?.content_text);
  return {
    hasSlides: !!slides,
    slidesTitle: slides?.title ?? null,
    pdfPath: slides?.file_path ?? null,
    transcriptMinutes: transcriptMinutes(transcript),
    timestamps: transcript.some((s) => s.startMs !== null),
  };
}

function slideIndexOf(metadata: string | null): number | null {
  try {
    const v = metadata ? JSON.parse(metadata) : null;
    return typeof v?.slideIndex === "number" ? v.slideIndex : null;
  } catch {
    return null;
  }
}

/**
 * Subject guess from the Alt folder (spec 4.1 folderPath): a course code
 * ("CSED311 컴퓨터구조" -> "CSED311"), else the part before ":", else the
 * top folder's name; without a folder, a course code in the title.
 */
export function inferSubject(folderPath: string[], title: string): string {
  const code = (s: string) => s.match(/([A-Za-z]{2,}[\s-]?\d{2,}[A-Za-z]?)/)?.[1]?.replace(/[\s-]+/g, "").toUpperCase() ?? null;
  for (let i = folderPath.length - 1; i >= 0; i--) {
    const c = code(folderPath[i]);
    if (c) return c;
  }
  if (folderPath.length > 0) {
    const top = folderPath[0];
    const head = top.split(":")[0].trim();
    return head || top.trim();
  }
  return code(title) ?? "미분류";
}

export interface BundleInput {
  note: NoteRow;
  folders: Map<string, FolderRow>;
  components: ComponentRow[];
  readFile(path: string): Promise<ArrayBuffer>;
}

export async function bundleFromRows(input: BundleInput): Promise<LectureBundle> {
  const { note, components } = input;
  const warnings: string[] = [];
  const slides = pickSlides(components);
  let pdf: ArrayBuffer | null = null;
  const pdfPath = slides?.file_path ?? null;
  if (slides && !pdfPath) {
    warnings.push(
      slides.file_ref_id
        ? "슬라이드 PDF가 동기화된 파일인데 이 컴퓨터의 경로를 찾지 못했습니다 (Alt에서 슬라이드를 한 번 열어 내려받은 뒤 다시 시도하세요). 슬라이드 없이 가져옵니다."
        : "슬라이드 PDF 파일 경로를 찾지 못했습니다. 슬라이드 없이 가져옵니다."
    );
  }
  if (pdfPath) {
    try {
      pdf = await input.readFile(pdfPath);
    } catch (e) {
      warnings.push(`슬라이드 PDF를 읽지 못했습니다 (${e instanceof Error ? e.message : String(e)}). 슬라이드 없이 가져옵니다.`);
    }
  }
  // One displayed component per single-valued type (transcript, summary,
  // memo, meeting notes); slide memos are one per slide and all kept.
  const transcriptRow = displayComponent(components, "transcript");
  const transcript = parseTranscript(transcriptRow?.content_text);
  const summaryRow = displayComponent(components, "summary");
  const summary = summaryRow ? componentTextToMarkdown(summaryRow.content_text, summaryRow.metadata).trim() : "";
  const memos: string[] = [];
  for (const type of ["memo", "meeting_notes"]) {
    const c = displayComponent(components, type);
    const md = c ? componentTextToMarkdown(c.content_text, c.metadata) : "";
    if (md.trim()) memos.push(md);
  }
  const slideMemos = components
    .filter((c) => c.component_type === "slide_memo")
    .map((c) => ({ index: slideIndexOf(c.metadata), md: componentTextToMarkdown(c.content_text, c.metadata) }))
    .filter((m) => m.md.trim().length > 0)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const m of slideMemos) memos.push(`### 슬라이드 ${m.index ?? "?"} 메모\n\n${m.md}`);

  const noteInfo = toSummary(note, input.folders);
  return {
    sourceId: note.id,
    sourceKind: "alt-local",
    title: noteInfo.title,
    lectureDate: noteInfo.lectureDate ?? undefined,
    folderPath: noteInfo.folderPath,
    pdf,
    pdfPath,
    slideTexts: null,
    transcript,
    summaryMarkdown: summary || undefined,
    memoMarkdown: memos.length > 0 ? memos.join("\n\n") : undefined,
    warnings,
  };
}
