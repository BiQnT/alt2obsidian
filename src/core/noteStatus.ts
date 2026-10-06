// Sidebar status of an Alt local note against the vault (spec 6 row 2).
// Pure: the plugin passes frontmatter facts and slide hashes in.

/** Lecture note facts read from its frontmatter. */
export interface VaultNoteInfo {
  path: string;
  title: string;
  subject?: string;
  altLocalId?: string;
  /** Public share id (1.x and URL imports). */
  altId?: string;
  /** Alt creation time of a URL import (ISO), used for the date match. */
  altCreated?: string;
  /** `alt_kind`: "transcript" for a summary note of a lecture without slides (spec 4.10). */
  kind?: string;
  /** `alt_pdf_source`: "attached" when the user attached the PDF in the plugin. */
  pdfSource?: string;
  /** A slide note (`slide_count` in its frontmatter). */
  slideNote?: boolean;
}

export function normalizeTitle(title: string): string {
  return title.normalize("NFC").toLowerCase().replace(/\.pdf$/, "").replace(/[^0-9a-z가-힣]+/g, "");
}

function dayNumber(date: string | undefined | null): number | null {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : null;
}

/**
 * A 1.x or URL-imported note that is probably this Alt local note: it has
 * no `alt_local_id` yet, its title equals the Alt title or the slides file
 * name, and its Alt date (when both are known) is within a day of the
 * lecture date (time zones). Linking still needs the user's confirmation.
 */
export function isLinkCandidate(
  info: VaultNoteInfo,
  note: { title: string; lectureDate: string | null },
  slidesTitle?: string | null
): boolean {
  if (info.altLocalId || !info.altId) return false;
  const t = normalizeTitle(info.title);
  if (!t) return false;
  const titleMatch = t === normalizeTitle(note.title) || (!!slidesTitle && t === normalizeTitle(slidesTitle));
  if (!titleMatch) return false;
  const a = dayNumber(info.altCreated);
  const b = dayNumber(note.lectureDate);
  return a === null || b === null || Math.abs(a - b) <= 1;
}

/**
 * Slides that differ between the PDF and the note's slide markers, by text
 * hash (spec 4.7): new or changed pages of the PDF, or sections whose page
 * is gone, whichever is larger (a changed page counts once).
 */
export function slideChangeCount(pdfHashes: string[], noteHashes: string[]): number {
  const pool = new Map<string, number>();
  for (const h of noteHashes) pool.set(h, (pool.get(h) ?? 0) + 1);
  let added = 0;
  for (const h of pdfHashes) {
    const n = pool.get(h) ?? 0;
    if (n > 0) pool.set(h, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of pool.values()) removed += n;
  return Math.max(added, removed);
}

export type LocalNoteStatus =
  | { kind: "new" }
  /** `changed` null: not computed yet (or the note has no slide markers). */
  | { kind: "imported"; path: string; changed: number | null }
  | { kind: "link"; candidates: VaultNoteInfo[] };

export function statusChip(status: LocalNoteStatus): { text: string; cls: string } {
  switch (status.kind) {
    case "new":
      return { text: "새 노트", cls: "is-new" };
    case "link":
      return { text: "기존 노트와 연결?", cls: "is-link" };
    default:
      return status.changed && status.changed > 0
        ? { text: `슬라이드 ${status.changed}장 변경`, cls: "is-changed" }
        : { text: "가져옴", cls: "is-imported" };
  }
}

// ---- Lecture kind (spec 4.10, 2.0.0-beta.6) ----
// Alt's "노트 추가" dialog creates a note of type "note" (a recording and its
// transcript; Alt cannot attach slides to it) or "slide" (slides can be
// attached in Alt); older notes are "legacy". The plugin shows which kind a
// lecture is, so the user knows why it has no slide commentary:
//   slides          a slides PDF exists (Alt's)                 -> slide path
//   attached        the user attached a PDF in the plugin       -> slide path
//   slides-missing  type "slide" but no slides attached in Alt  -> attach in Alt and refresh;
//                   "PDF 첨부" or "요약 노트 만들기" in the plugin
//   transcript      type "note" (or "legacy", or a URL note) without slides,
//                   with a transcript                           -> "요약 노트 만들기" or "PDF 첨부"
//   empty           no slides and no transcript                 -> a lecture-level note from Alt's summary and memo

export type LectureKind = "slides" | "attached" | "slides-missing" | "transcript" | "empty";

export interface LectureKindFacts {
  /** lecture_notes.type ("note" | "slide" | "legacy"); null or "" when unknown (URL source). */
  altType?: string | null;
  /** Alt has a slides PDF for the note. */
  hasSlides: boolean;
  /** The transcript has text. */
  hasTranscript: boolean;
  /**
   * A PDF the user attached in the plugin is next to the note (`<note>.pdf`)
   * and is used: the note is marked `alt_pdf_source: "attached"`, or Alt has
   * no PDF for it.
   */
  attachedPdf: boolean;
}

export function lectureKind(f: LectureKindFacts): LectureKind {
  if (f.attachedPdf) return "attached";
  if (f.hasSlides) return "slides";
  if (f.altType === "slide") return "slides-missing";
  return f.hasTranscript ? "transcript" : "empty";
}

export const LECTURE_KIND_LABELS: Record<LectureKind, string> = {
  slides: "슬라이드",
  attached: "슬라이드(PDF 첨부)",
  "slides-missing": "슬라이드(미첨부)",
  transcript: "노트(전사만)",
  empty: "노트(전사 없음)",
};

/** Kinds that are imported without a PDF unless the user attaches one. */
export function lacksPdf(kind: LectureKind): boolean {
  return kind === "slides-missing" || kind === "transcript" || kind === "empty";
}

/**
 * An import found no slides PDF (none in Alt, none attached) and the user
 * did not choose "요약 노트 만들기": the import stops before any token is
 * spent instead of silently making a note without slides. `notePath` is
 * where an attached PDF would go (`<note>.pdf`).
 */
export class MissingPdfError extends Error {
  constructor(
    message: string,
    public notePath: string,
    public hasTranscript: boolean
  ) {
    super(message);
    this.name = "MissingPdfError";
  }
}
