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
