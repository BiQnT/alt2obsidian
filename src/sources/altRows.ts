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

function byOrder(a: ComponentRow, b: ComponentRow): number {
  return (a.display_order ?? 0) - (b.display_order ?? 0);
}

/** The slides component the PDF comes from: first by display order with a file. */
export function pickSlides(components: ComponentRow[]): ComponentRow | null {
  const slides = components.filter((c) => c.component_type === "slides").sort(byOrder);
  return slides.find((c) => !!c.file_path) ?? slides[0] ?? null;
}

export function detailsFromComponents(components: ComponentRow[]): AltNoteDetails {
  const slides = pickSlides(components);
  const transcript = components.filter((c) => c.component_type === "transcript").flatMap((c) => parseTranscript(c.content_text));
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
  if (slides && !pdfPath) warnings.push("슬라이드 PDF 파일 경로를 찾지 못했습니다. 슬라이드 없이 가져옵니다.");
  if (pdfPath) {
    try {
      pdf = await input.readFile(pdfPath);
    } catch (e) {
      warnings.push(`슬라이드 PDF를 읽지 못했습니다 (${e instanceof Error ? e.message : String(e)}). 슬라이드 없이 가져옵니다.`);
    }
  }
  const transcript = components
    .filter((c) => c.component_type === "transcript")
    .sort(byOrder)
    .flatMap((c) => parseTranscript(c.content_text));
  const summary = components
    .filter((c) => c.component_type === "summary")
    .sort(byOrder)
    .map((c) => componentTextToMarkdown(c.content_text, c.metadata))
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
  const memos: string[] = [];
  for (const c of components.filter((c) => c.component_type === "memo" || c.component_type === "meeting_notes").sort(byOrder)) {
    const md = componentTextToMarkdown(c.content_text, c.metadata);
    if (md.trim()) memos.push(md);
  }
  const slideMemos = components
    .filter((c) => c.component_type === "slide_memo")
    .map((c) => ({ index: slideIndexOf(c.metadata), md: componentTextToMarkdown(c.content_text, c.metadata) }))
    .filter((m) => m.md.trim().length > 0)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const m of slideMemos) memos.push(`### 슬라이드 ${m.index ?? "?"} 메모\n\n${m.md}`);

  const summaryRow = toSummary(note, input.folders);
  return {
    sourceId: note.id,
    sourceKind: "alt-local",
    title: summaryRow.title,
    lectureDate: summaryRow.lectureDate ?? undefined,
    folderPath: summaryRow.folderPath,
    pdf,
    pdfPath,
    slideTexts: null,
    transcript,
    summaryMarkdown: summary || undefined,
    memoMarkdown: memos.length > 0 ? memos.join("\n\n") : undefined,
    warnings,
  };
}
