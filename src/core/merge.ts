// Re-import merge of Alt2Obsidian lecture notes. Pure module (no obsidian
// import) shared by VaultManager and the Skill CLI scripts/phase2/merge-note.mjs,
// so a Skill re-import preserves memos exactly like a plugin re-import.

import {
  MANAGED_NOTE_START,
  MANAGED_NOTE_END,
  OVERVIEW_BLOCK_START,
  OVERVIEW_BLOCK_END,
} from "../types";
import { hasSectionMarkers, parseSectionHeading, SECTION_MARKER_PATTERN, SectionHeading, sectionHeadingLineRegex, sectionMarker, sectionMarkerRegex, sectionRange } from "./sections";

/**
 * A page-anchored note must never be overwritten by a single-block note
 * (per-slide generation failed or no PDF): the multi-managed merge would
 * orphan every slide section. Throws so the import aborts before anything
 * is written; the caller surfaces the message.
 */
export const LEGACY_MIGRATION_NOTE =
  "기존 단일 블록 형식에서 페이지별 구조로 마이그레이션됩니다. 기존 노트 전체는 맨 아래 '이전 노트 백업'에 보관됩니다.";

/**
 * A transcript summary note (spec 4.10) becoming a slide note (a PDF was
 * attached or Alt got slides) keeps the whole old note, memos included, as
 * a backup; it never loses text the user wrote.
 */
export const TRANSCRIPT_TO_SLIDES_NOTE =
  "전사 구간 요약 노트를 슬라이드별 노트로 바꿉니다. 기존 노트 전체(구간 요약과 내 메모)는 맨 아래 '이전 노트 백업'에 보관됩니다.";
/** An older lecture-level note becoming a transcript summary note. */
export const TRANSCRIPT_MIGRATION_NOTE =
  "기존 강의 요약 노트를 전사 구간별 노트로 바꿉니다. 기존 노트 전체는 맨 아래 '이전 노트 백업'에 보관됩니다.";

export function assertNoPageAnchoredDowngrade(currentContent: string, nextContent: string): void {
  if (
    hasMultiManagedMarkers(currentContent) &&
    !hasMultiManagedMarkers(nextContent)
  ) {
    throw new Error(
      "기존 노트는 슬라이드별 형식인데 이번 결과에는 슬라이드별 해설이 없어 덮어쓰지 않고 가져오기를 중단했습니다. " +
        "PDF를 내려받거나 읽지 못한 경우입니다. PDF 접근을 확인한 뒤 다시 시도해주세요."
    );
  }
  // A transcript summary note only becomes a slide note, never a single block.
  if (hasSectionMarkers(currentContent) && !hasSectionMarkers(nextContent) && !hasMultiManagedMarkers(nextContent)) {
    throw new Error(
      "기존 노트는 전사 구간별 요약인데 이번 결과에는 구간 요약이 없어 덮어쓰지 않고 가져오기를 중단했습니다. " +
        "Alt에서 전사를 읽지 못한 경우입니다. Alt에서 전사가 보이는지 확인한 뒤 다시 시도해주세요."
    );
  }
}

/** LF line endings: a note saved with CRLF (Windows, some sync tools) merges like any other. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The merged note written back with the old note's line ending (CRLF stays CRLF). */
function inEolOf(original: string, merged: string): string {
  return /\r\n/.test(original) ? merged.replace(/\n/g, "\r\n") : merged;
}

export function mergeManagedNote(current: string, next: string): string {
  return inEolOf(current, mergeManagedLf(toLf(current), toLf(next)));
}

function mergeManagedLf(currentContent: string, nextContent: string): string {
  const nextParts = splitManagedNote(nextContent);
  const currentParts = splitManagedNote(currentContent);

  if (currentParts.managed) {
    return [
      nextParts.frontmatter,
      currentParts.before.trim(),
      nextParts.managed,
      currentParts.after.trim(),
    ]
      .filter(Boolean)
      .join("\n\n")
      .trimEnd() + "\n";
  }

  return appendPreviousNoteBackup(currentContent, nextContent, { skipIfBackupExists: true });
}

/** Why a note was backed up, shown in the backup's callout. */
export type BackupReason = "managed" | "to-slides" | "to-sections";

const BACKUP_REASONS: Record<BackupReason, string> = {
  managed: "이 내용은 Alt2Obsidian 관리 구간이 도입되기 전의 기존 노트입니다.",
  "to-slides": "이 내용은 슬라이드별 노트로 바뀌기 전의 전사 구간 요약 노트입니다. 내 메모는 필요한 슬라이드 아래로 옮기세요.",
  "to-sections": "이 내용은 전사 구간 요약 노트로 바뀌기 전의 강의 노트입니다. 내 메모는 필요한 구간 아래로 옮기세요.",
};

/**
 * The old note's text for the backup: its frontmatter, if any, as a fenced
 * YAML block (raw it would render as a rule and loose text, and could be
 * mistaken for the note's own frontmatter), then the rest as it was.
 */
function backupBody(current: string): string {
  const fm = current.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!fm) return current.trim();
  let fence = "```";
  while (fm[1].includes(fence)) fence += "`";
  return [`${fence}yaml`, "---", fm[1], "---", fence, "", current.slice(fm[0].length).trim()].join("\n").trim();
}

/**
 * Append the whole previous note under "## 이전 노트 백업" so nothing the user
 * wrote is lost when the new note cannot merge with it (a note without
 * managed markers, a 1.0.x single-block note migrating to page-anchored, a
 * transcript summary note becoming a slide note).
 */
function appendPreviousNoteBackup(
  currentContent: string,
  nextContent: string,
  opts: { skipIfBackupExists: boolean; reason?: BackupReason }
): string {
  // Plan Task 1.3 backward-compat: skip the "## 이전 노트 백업" write if the
  // current file already has one. Honors Principle 2 (1.0.x notes
  // untouched a second time) by not stacking duplicate backup sections
  // on repeated re-imports of legacy files.
  const hasExistingBackup = /(^|\n)## 이전 노트 백업\s*\n/.test(currentContent);
  if ((opts.skipIfBackupExists && hasExistingBackup) || currentContent.trim().length === 0) {
    return nextContent;
  }

  return [
    nextContent.trimEnd(),
    "",
    "## 이전 노트 백업",
    "",
    "> [!note]",
    `> ${BACKUP_REASONS[opts.reason ?? "managed"]}`,
    "",
    backupBody(currentContent),
    "",
  ].join("\n");
}

export function splitManagedNote(content: string): {
  frontmatter: string;
  before: string;
  managed: string;
  after: string;
} {
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n*/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0].trimEnd() : "";
  const contentStart = frontmatterMatch ? frontmatterMatch[0].length : 0;
  const start = content.indexOf(MANAGED_NOTE_START);
  const end = content.indexOf(MANAGED_NOTE_END);

  if (start === -1 || end === -1 || end < start) {
    return { frontmatter, before: "", managed: "", after: "" };
  }

  const managedEnd = end + MANAGED_NOTE_END.length;
  return {
    frontmatter,
    before: content.slice(contentStart, start),
    managed: content.slice(start, managedEnd).trimEnd(),
    after: content.slice(managedEnd),
  };
}

// ---- B1 page-anchored multi-managed-block support (Task 1.3) ----
// Algorithm validated by .omc/research/spike-1.0b-hash-algo.md §3 (two-pass
// hash-match → N-match-drift → insertion → orphan). Round 5 invariant
// (per-slide free-space preservation across regen) is enforced here.

export function hasMultiManagedMarkers(content: string): boolean {
  return /<!-- alt2obs:slide:\d+ hash:[0-9a-f]{8}(?: dup:\d+)? (start|end) -->/.test(
    content
  );
}

export function splitMultiManagedNote(content: string): {
  frontmatter: string;
  preamble: string;
  sections: Array<{
    slideNum: number;
    hash: string;
    dup?: number;
    managed: string;
    after: string;
  }>;
} {
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n*/);
  const frontmatter = fmMatch ? fmMatch[0] : "";
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;

  type RawMarker = {
    idx: number;
    end: number;
    slideNum: number;
    hash: string;
    dup?: number;
    type: "start" | "end";
  };
  const markers: RawMarker[] = [];
  const re = /<!-- alt2obs:slide:(\d+) hash:([0-9a-f]{8})(?: dup:(\d+))? (start|end) -->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    markers.push({
      idx: m.index,
      end: m.index + m[0].length,
      slideNum: parseInt(m[1], 10),
      hash: m[2],
      dup: m[3] ? parseInt(m[3], 10) : undefined,
      type: m[4] as "start" | "end",
    });
  }

  const sections: Array<{
    slideNum: number;
    hash: string;
    dup?: number;
    managed: string;
    after: string;
  }> = [];
  const sectionRanges: Array<{ startIdx: number; endIdxAfterMarker: number }> = [];
  const used = new Set<number>();

  for (let i = 0; i < markers.length; i++) {
    const s = markers[i];
    if (s.type !== "start" || used.has(i)) continue;
    let pairIdx = -1;
    for (let k = i + 1; k < markers.length; k++) {
      const e = markers[k];
      if (
        e.type === "end" &&
        !used.has(k) &&
        e.slideNum === s.slideNum &&
        e.hash === s.hash &&
        e.dup === s.dup
      ) {
        pairIdx = k;
        break;
      }
    }
    if (pairIdx < 0) continue; // unpaired start: ignore
    used.add(i);
    used.add(pairIdx);
    const e = markers[pairIdx];
    sections.push({
      slideNum: s.slideNum,
      hash: s.hash,
      dup: s.dup,
      managed: body.slice(s.end, e.idx),
      after: "",
    });
    sectionRanges.push({ startIdx: s.idx, endIdxAfterMarker: e.end });
  }

  if (sections.length === 0) {
    return { frontmatter, preamble: body, sections: [] };
  }

  // Truncate preamble to exclude any slide H2 heading that belongs to the
  // first section (we always regenerate H2s on emit).
  let preamble = body.slice(0, sectionRanges[0].startIdx);
  const slideH2 = preamble.match(/(^|\n)## 📚 슬라이드 \d+/);
  if (slideH2 && slideH2.index !== undefined) {
    const cutAt = slideH2.index + (slideH2[1] === "\n" ? 1 : 0);
    preamble = preamble.slice(0, cutAt);
  }

  // Assign 'after' for each section: from end-marker to next slide H2 (or
  // next section start, whichever comes first), or EOF.
  for (let i = 0; i < sections.length; i++) {
    const range = sectionRanges[i];
    const fromIdx = range.endIdxAfterMarker;
    const nextRange = sectionRanges[i + 1];
    const candidateEnd = nextRange ? nextRange.startIdx : body.length;
    const slice = body.slice(fromIdx, candidateEnd);
    const nextH2 = slice.search(/(^|\n)## 📚 슬라이드 \d+/);
    if (nextH2 >= 0) {
      const cutAt = nextH2 + (slice[nextH2] === "\n" ? 1 : 0);
      sections[i].after = slice.slice(0, cutAt);
    } else {
      sections[i].after = slice;
    }
  }

  return { frontmatter, preamble, sections };
}

function formatSlideMarker(
  slideNum: number,
  hash: string,
  dup: number | undefined,
  kind: "start" | "end"
): string {
  const dupSuffix = dup !== undefined ? ` dup:${dup}` : "";
  return `<!-- alt2obs:slide:${slideNum} hash:${hash}${dupSuffix} ${kind} -->`;
}

/** A section's identity for pairing: its number and content hash. */
interface SectionKey {
  num: number;
  hash: string;
}

/**
 * Pairs incoming sections with existing ones (spike 1.0b two-pass rule,
 * shared by slide and transcript sections): first by hash in order, then
 * (transcript sections, when `overlap` is given) by the most shared time,
 * then the unmatched ones by number ("drift"); what is left is an
 * insertion (incoming) or an orphan (existing). `matched` maps an incoming
 * index to an existing index.
 */
function pairSections(
  existing: SectionKey[],
  next: SectionKey[],
  overlap?: (existingIdx: number, nextIdx: number) => number
): {
  matched: Map<number, number>;
  used: Set<number>;
  reorders: Array<{ from: number; to: number; hash: string }>;
  insertions: number[];
  deletions: Array<{ slideNum: number; hash: string }>;
  drifts: Array<{ slideNum: number; oldHash: string; newHash: string }>;
} {
  const used = new Set<number>();
  const matched = new Map<number, number>();
  const reorders: Array<{ from: number; to: number; hash: string }> = [];
  const insertions: number[] = [];
  const deletions: Array<{ slideNum: number; hash: string }> = [];
  const drifts: Array<{ slideNum: number; oldHash: string; newHash: string }> = [];

  // Bucket existing by hash for O(1) lookup; preserve deck order within bucket.
  const buckets = new Map<string, number[]>();
  existing.forEach((s, idx) => {
    if (!buckets.has(s.hash)) buckets.set(s.hash, []);
    buckets.get(s.hash)!.push(idx);
  });

  // PASS 1: hash-match (preferred): preserves callouts attached to identical content.
  next.forEach((ns, i) => {
    for (const idx of buckets.get(ns.hash) ?? []) {
      if (!used.has(idx)) {
        used.add(idx);
        matched.set(i, idx);
        if (existing[idx].num !== ns.num) reorders.push({ from: existing[idx].num, to: ns.num, hash: ns.hash });
        break;
      }
    }
  });

  const drift = (i: number, idx: number) => {
    used.add(idx);
    matched.set(i, idx);
    drifts.push({ slideNum: next[i].num, oldHash: existing[idx].hash, newHash: next[i].hash });
  };

  // PASS 1b: the existing section sharing the most time (at least half of the shorter one).
  if (overlap) {
    next.forEach((_, i) => {
      if (matched.has(i)) return;
      let best = -1;
      let bestShare = 0.5;
      existing.forEach((_, idx) => {
        if (used.has(idx)) return;
        const share = overlap(idx, i);
        if (share >= bestShare && (best < 0 || share > bestShare)) {
          best = idx;
          bestShare = share;
        }
      });
      if (best >= 0) drift(i, best);
    });
  }

  // PASS 2: N-match-with-drift for hash-unmatched incoming.
  next.forEach((ns, i) => {
    if (matched.has(i)) return;
    const idx = existing.findIndex((s, j) => !used.has(j) && s.num === ns.num);
    if (idx >= 0) drift(i, idx);
  });

  // PASS 3: insertions: hash-unmatched + N-unmatched
  next.forEach((ns, i) => {
    if (!matched.has(i)) insertions.push(ns.num);
  });

  // PASS 4: orphans
  existing.forEach((s, i) => {
    if (!used.has(i)) deletions.push({ slideNum: s.num, hash: s.hash });
  });

  return { matched, used, reorders, insertions, deletions, drifts };
}

const DEFAULT_MEMO = "> [!note] 내 메모\n> ";

/** User free-space under a section: kept when paired and not empty, else an empty memo callout. */
function memoOf(after: string | undefined): string {
  const kept = after ? after.replace(/^\n+|\n+$/g, "") : "";
  return kept.trim().length > 0 ? kept : DEFAULT_MEMO;
}

// ---- Failure lists ("⚠️ 처리 실패 슬라이드/구간") ----
// The generated list sits after the last section between these markers, so
// a re-import replaces it instead of keeping the old one in the last
// section's free space. A list from before 2.0.0-beta.6 has no markers and
// stays as it is.
export const FAILURES_START = "<!-- alt2obs:failures start -->";
export const FAILURES_END = "<!-- alt2obs:failures end -->";
const FAILURES_RE = /\n*<!-- alt2obs:failures start -->[\s\S]*?<!-- alt2obs:failures end -->[ \t]*/g;

/** The failure list block of a note: heading and one line per failure, inside the markers. */
export function failuresBlock(heading: string, lines: string[]): string {
  return [FAILURES_START, heading, "", ...lines, FAILURES_END].join("\n");
}

/** The failure list block of a generated note, or "". */
function failuresOf(content: string): string {
  const m = content.match(/<!-- alt2obs:failures start -->[\s\S]*?<!-- alt2obs:failures end -->/);
  return m ? m[0] : "";
}

function withoutFailures(text: string): string {
  return text.replace(FAILURES_RE, "\n");
}

/** Sections, then the new failure list, then the orphan list, then one newline (the generator's layout). */
function assemble(head: string, sections: string[], failures: string, orphans: string): string {
  return head + [sections.join("\n\n"), failures, orphans].filter((x) => x.length > 0).join("\n\n") + "\n";
}

/**
 * Multi-managed merge: preserves the user's per-slide free-space across
 * regen by mapping incoming sections to existing sections via two-pass
 * hash-match → N-match-drift logic. Returns merged file content + summary
 * of what changed, suitable for ImportUpdateSummary surfacing.
 */
export function mergeMultiManagedNote(
  existingContent: string,
  nextContent: string
): ReturnType<typeof mergeMultiManagedLf> {
  const result = mergeMultiManagedLf(toLf(existingContent), toLf(nextContent));
  return { ...result, merged: inEolOf(existingContent, result.merged) };
}

function mergeMultiManagedLf(
  existingContent: string,
  nextContent: string
): {
  merged: string;
  reorders: Array<{ from: number; to: number; hash: string }>;
  insertions: number[];
  deletions: Array<{ slideNum: number; hash: string }>;
  drifts: Array<{ slideNum: number; oldHash: string; newHash: string }>;
  confirmDeckReplacement: boolean;
  notes: string[];
} {
  const existing = splitMultiManagedNote(existingContent);
  const next = splitMultiManagedNote(nextContent);

  if (existing.sections.length === 0) {
    // No slide sections to map onto (1.0.x single-block note, or a
    // transcript summary note, migrating to page-anchored): keep the old
    // note, including user text inside and outside its managed blocks, as a
    // backup instead of dropping it. Always append here, even over an older
    // backup: nesting beats losing text.
    return {
      merged: appendPreviousNoteBackup(existingContent, nextContent, { skipIfBackupExists: false, reason: hasSectionMarkers(existingContent) ? "to-slides" : "managed" }),
      reorders: [],
      insertions: next.sections.map((s) => s.slideNum),
      deletions: [],
      drifts: [],
      confirmDeckReplacement: false,
      notes: existingContent.trim() ? [hasSectionMarkers(existingContent) ? TRANSCRIPT_TO_SLIDES_NOTE : LEGACY_MIGRATION_NOTE] : [],
    };
  }

  const { matched, used, reorders, insertions, deletions, drifts } = pairSections(
    existing.sections.map((s) => ({ num: s.slideNum, hash: s.hash })),
    next.sections.map((s) => ({ num: s.slideNum, hash: s.hash }))
  );

  // Plan §B v1.1 touch-up: deck-replacement confirm modal threshold.
  // Known limitation (spike doc §10): overlap on slide numbers can mask
  // orphans behind drifts; Task 1.3 may want to extend this signal.
  const confirmDeckReplacement =
    existing.sections.length > 0 &&
    deletions.length > 0.5 * existing.sections.length;

  // Re-emit: frontmatter + preamble + sections (with preserved free-space) + failures + orphan footer
  const sectionMarkdown = next.sections.map((ns, i) => {
    const idx = matched.get(i);
    const cand = idx === undefined ? undefined : existing.sections[idx];
    return [
      `## 📚 슬라이드 ${ns.slideNum}`,
      "",
      formatSlideMarker(ns.slideNum, ns.hash, ns.dup, "start"),
      ns.managed.trim(),
      formatSlideMarker(ns.slideNum, ns.hash, ns.dup, "end"),
      "",
      memoOf(cand ? withoutFailures(cand.after) : undefined),
    ].join("\n");
  });

  let orphanFooter = "";
  if (deletions.length > 0) {
    const orphanBlocks = existing.sections
      .map((s, i) => (used.has(i) ? null : s))
      .filter((s): s is (typeof existing.sections)[number] => s !== null)
      .map((s) => {
        const dupSuffix = s.dup !== undefined ? ` dup:${s.dup}` : "";
        const orphanMarker = `<!-- alt2obs:orphan slide:${s.slideNum} hash:${s.hash}${dupSuffix} -->`;
        return `${orphanMarker}\n${withoutFailures(s.after).trim()}`;
      })
      .join("\n\n");
    orphanFooter = `## 🗑️ 삭제된 슬라이드 (orphan)\n\n${orphanBlocks}`;
  }

  const { preamble, notes } = mergeOverviewPreamble(existing.preamble, next.preamble);
  const merged = assemble(next.frontmatter + preamble, sectionMarkdown, failuresOf(nextContent), orphanFooter);

  return { merged, reorders, insertions, deletions, drifts, confirmDeckReplacement, notes };
}

// ---- Transcript sections (spec 4.10): lectures without slides ----
// Same rules as the slide sections above, with the section grammar of
// src/core/sections.ts: `## ⏱ 구간 N [mm:ss~mm:ss]`, then the managed block
// `<!-- alt2obs:section:N hash:H start --> ... <!-- ... end -->`, then the
// user's free space (`> [!note] 내 메모`) up to the next section heading.

export interface NoteSection {
  num: number;
  hash: string;
  /** The section's heading line as written ("## ⏱ 구간 3 [24:10~36:02]"), null when none precedes the block. */
  heading: string | null;
  /** The heading parsed (times, the user's text after the range), null without a heading. */
  parsed: SectionHeading | null;
  /** Text between the heading and the start marker (what the user wrote under the heading). */
  lead: string;
  managed: string;
  /** From the end marker to the next section's heading (or start marker), or the end of the note. */
  after: string;
}

/**
 * Sections of a transcript summary note. A section's heading is the last
 * "## ⏱ 구간 N" line with its own number before its start marker; the user's
 * free space runs from its end marker up to the next section's heading, so
 * anything between (a memo, a line the user wrote that looks like a
 * heading, the text of a section whose end marker was deleted) stays where
 * it is.
 */
export function splitSectionNote(content: string): { frontmatter: string; preamble: string; sections: NoteSection[] } {
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n*/);
  const frontmatter = fmMatch ? fmMatch[0] : "";
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;

  const markers: Array<{ idx: number; end: number; num: number; hash: string; type: "start" | "end" }> = [];
  const re = sectionMarkerRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    markers.push({ idx: m.index, end: m.index + m[0].length, num: parseInt(m[1], 10), hash: m[2], type: m[3] as "start" | "end" });
  }
  const pairs: Array<{ num: number; hash: string; startIdx: number; startEnd: number; endIdx: number; endEnd: number }> = [];
  const used = new Set<number>();
  for (let i = 0; i < markers.length; i++) {
    const s = markers[i];
    if (s.type !== "start" || used.has(i)) continue;
    const k = markers.findIndex((e, j) => j > i && !used.has(j) && e.type === "end" && e.num === s.num && e.hash === s.hash);
    if (k < 0) continue; // unpaired start: ignore
    used.add(i);
    used.add(k);
    pairs.push({ num: s.num, hash: s.hash, startIdx: s.idx, startEnd: s.end, endIdx: markers[k].idx, endEnd: markers[k].end });
  }
  if (pairs.length === 0) return { frontmatter, preamble: body, sections: [] };

  // Each section's own heading line: [start, end) offsets in body, or null.
  const headings = pairs.map((p, i) => {
    const from = i === 0 ? 0 : pairs[i - 1].endEnd;
    const region = body.slice(from, p.startIdx);
    let found: { start: number; end: number; text: string } | null = null;
    for (const h of region.matchAll(sectionHeadingLineRegex())) {
      if (h.index !== undefined && parseSectionHeading(h[0])?.num === p.num) found = { start: from + h.index, end: from + h.index + h[0].length, text: h[0] };
    }
    return found;
  });
  const preamble = body.slice(0, headings[0]?.start ?? pairs[0].startIdx);
  const sections: NoteSection[] = pairs.map((p, i) => {
    const h = headings[i];
    const next = i + 1 < pairs.length ? headings[i + 1]?.start ?? pairs[i + 1].startIdx : body.length;
    return {
      num: p.num,
      hash: p.hash,
      heading: h ? h.text.trimEnd() : null,
      parsed: h ? parseSectionHeading(h.text) : null,
      lead: h ? body.slice(h.end, p.startIdx).trim() : "",
      managed: body.slice(p.startEnd, p.endIdx),
      after: body.slice(p.endEnd, next),
    };
  });
  return { frontmatter, preamble, sections };
}

/**
 * Kept user text without the plugin's leftovers of a broken section: stray
 * section markers, meta lines, the old failure list, and a heading in the
 * exact generated form of a section that is written again anyway.
 */
/** A stray section marker or a meta line: the plugin's own lines, never the user's. */
const LEFTOVER_LINE = new RegExp(`^(?:${SECTION_MARKER_PATTERN}|<!-- alt2obs:meta [^\\n]* -->)\\s*$`);

function keptText(text: string, emitted: Set<number>): string {
  return withoutFailures(text)
    .split("\n")
    .filter((line) => {
      if (LEFTOVER_LINE.test(line)) return false;
      const h = parseSectionHeading(line);
      return !(h && h.plain && emitted.has(h.num));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Share of the shorter section's time that two sections share (0 without times). */
function timeOverlap(a: SectionHeading | null, b: SectionHeading | null): number {
  if (!a || !b || a.startMs === null || a.endMs === null || b.startMs === null || b.endMs === null) return 0;
  const shared = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return shared > 0 && shorter > 0 ? shared / shorter : 0;
}

/**
 * Transcript summary note merge: memos follow their section (by transcript
 * hash, else by shared time, else by number), text under a heading and
 * text the user added after a heading's time range are kept, the overview
 * block is refreshed like a slide note's, sections that are gone keep their
 * memos under "## 🗑️ 사라진 구간 (orphan)". An older note without sections
 * (the 2.0.0-beta.5 lecture-level note of the same lecture) is kept whole
 * as a backup.
 */
export function mergeTranscriptNote(existingContent: string, nextContent: string): Omit<NoteMergeResult, "mode"> {
  const result = mergeTranscriptLf(toLf(existingContent), toLf(nextContent));
  return { ...result, merged: inEolOf(existingContent, result.merged) };
}

/** Share of `a`'s own time that `b` covers (0 without times). */
function coveredShare(a: SectionHeading | null, b: SectionHeading | null): number {
  if (!a || !b || a.startMs === null || a.endMs === null || b.startMs === null || b.endMs === null || a.endMs <= a.startMs) return 0;
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)) / (a.endMs - a.startMs);
}

function mergeTranscriptLf(existingContent: string, nextContent: string): Omit<NoteMergeResult, "mode"> {
  const existing = splitSectionNote(existingContent);
  const next = splitSectionNote(nextContent);
  if (existing.sections.length === 0) {
    return {
      merged: appendPreviousNoteBackup(existingContent, nextContent, { skipIfBackupExists: false, reason: "to-sections" }),
      reorders: [],
      insertions: next.sections.map((s) => s.num),
      deletions: [],
      drifts: [],
      confirmDeckReplacement: false,
      notes: existingContent.trim() ? [TRANSCRIPT_MIGRATION_NOTE] : [],
    };
  }
  const paired = pairSections(existing.sections, next.sections, (e, n) => timeOverlap(existing.sections[e].parsed, next.sections[n].parsed));
  const { matched, used, reorders, insertions, drifts } = paired;
  const emitted = new Set(next.sections.map((s) => s.num));
  // Two old sections became one new section: the unpaired one's memo goes
  // under the new section that covers most of its time (at least half),
  // labelled with where it came from, instead of "사라진 구간".
  const absorbed = new Map<number, string[]>();
  const absorbedIdx = new Set<number>();
  const notes: string[] = [];
  existing.sections.forEach((old, idx) => {
    if (used.has(idx)) return;
    let best = -1;
    let bestShare = 0.5;
    next.sections.forEach((ns, i) => {
      const share = coveredShare(old.parsed, ns.parsed);
      if (share >= bestShare && (best < 0 || share > bestShare)) {
        best = i;
        bestShare = share;
      }
    });
    if (best < 0) return;
    absorbedIdx.add(idx);
    const text = [keptText(old.lead, emitted).trim(), keptText(old.after, emitted).trim()].filter((t) => t && t !== DEFAULT_MEMO.trim()).join("\n\n");
    if (!text) return; // an empty memo carries nothing
    const range = old.parsed ? sectionRange(old.parsed.startMs, old.parsed.endMs) : "";
    const block = [`<!-- alt2obs:merged section:${old.num} hash:${old.hash} -->`, `**이전 구간 ${old.num}${range ? ` ${range}` : ""}의 메모**`, "", text].join("\n");
    absorbed.set(best, [...(absorbed.get(best) ?? []), block]);
    notes.push(`구간 ${old.num}의 메모를 구간 ${next.sections[best].num} 아래로 옮겼습니다 (두 구간이 새 구간 하나로 합쳐짐).`);
  });
  const deletions = paired.deletions.filter((d) => !Array.from(absorbedIdx).some((idx) => existing.sections[idx].num === d.slideNum && existing.sections[idx].hash === d.hash));
  const confirmDeckReplacement = deletions.length > 0.5 * existing.sections.length;
  const sectionMarkdown = next.sections.map((ns, i) => {
    const idx = matched.get(i);
    const old = idx === undefined ? undefined : existing.sections[idx];
    const suffix = old?.parsed?.suffix ?? "";
    const lead = old ? keptText(old.lead, emitted).trim() : "";
    return [
      (ns.heading ?? `## ⏱ 구간 ${ns.num}`) + (suffix ? ` ${suffix}` : ""),
      "",
      ...(lead ? [lead, ""] : []),
      sectionMarker(ns.num, ns.hash, "start"),
      ns.managed.trim(),
      sectionMarker(ns.num, ns.hash, "end"),
      "",
      [memoOf(old ? keptText(old.after, emitted) : undefined), ...(absorbed.get(i) ?? [])].join("\n\n"),
    ].join("\n");
  });
  let orphanFooter = "";
  if (deletions.length > 0) {
    const blocks = existing.sections
      .filter((_, i) => !used.has(i) && !absorbedIdx.has(i))
      .map((s) => `<!-- alt2obs:orphan section:${s.num} hash:${s.hash} -->\n${[keptText(s.lead, emitted).trim(), keptText(s.after, emitted).trim()].filter(Boolean).join("\n\n")}`)
      .join("\n\n");
    orphanFooter = `## 🗑️ 사라진 구간 (orphan)\n\n${blocks}`;
  }
  const overview = mergeOverviewPreamble(existing.preamble, next.preamble);
  return {
    merged: assemble(next.frontmatter + overview.preamble, sectionMarkdown, failuresOf(nextContent), orphanFooter),
    reorders,
    insertions,
    deletions,
    drifts,
    confirmDeckReplacement,
    notes: [...overview.notes, ...notes],
  };
}

/**
 * Preamble for a merged note. User text in the existing preamble is never
 * dropped; only the overview section is refreshed:
 * - existing has a complete overview block: replace only its body;
 * - existing has a start marker but no end marker: keep the text before the
 *   "## 📋 전체 요약" heading (or the start marker) and replace from there;
 * - existing has no overview block (1.x notes): insert the new overview
 *   section right after the first "# " title line, or at the end of the
 *   preamble when there is no title;
 * - the new note has no overview (empty summary): keep the existing
 *   preamble as is and say so in `notes`.
 */
export function mergeOverviewPreamble(
  existingPreamble: string,
  nextPreamble: string
): { preamble: string; notes: string[] } {
  const nextSection = extractOverviewSection(nextPreamble);
  const existingStart = existingPreamble.indexOf(OVERVIEW_BLOCK_START);
  if (!nextSection) {
    const notes =
      existingStart >= 0
        ? ["새 요약이 비어 있어 기존 전체 요약을 그대로 두었습니다. 최신 내용이 아닐 수 있습니다."]
        : [];
    return { preamble: existingPreamble, notes };
  }

  const existingBlock = findOverviewBlock(existingPreamble);
  const nextBlock = findOverviewBlock(nextPreamble)!;
  if (existingBlock) {
    return {
      preamble:
        existingPreamble.slice(0, existingBlock.bodyStart) +
        nextPreamble.slice(nextBlock.bodyStart, nextBlock.bodyEnd) +
        existingPreamble.slice(existingBlock.bodyEnd),
      notes: [],
    };
  }

  if (existingStart >= 0) {
    const heading = existingPreamble.lastIndexOf(OVERVIEW_HEADING, existingStart);
    const cut = heading >= 0 ? heading : existingStart;
    return {
      preamble: withBlankLineAfter(existingPreamble.slice(0, cut)) + nextSection,
      notes: [],
    };
  }

  const title = existingPreamble.match(/^# .*(\n|$)/m);
  if (title && title.index !== undefined) {
    const head = existingPreamble.slice(0, title.index + title[0].length);
    const rest = existingPreamble.slice(head.length).replace(/^\n+/, "");
    return { preamble: withBlankLineAfter(head) + nextSection + rest, notes: [] };
  }
  return { preamble: withBlankLineAfter(existingPreamble) + nextSection, notes: [] };
}

const OVERVIEW_HEADING = "## 📋 전체 요약";

/** Overview section of a generated preamble: heading through end marker, then one blank line. */
function extractOverviewSection(preamble: string): string | null {
  const block = findOverviewBlock(preamble);
  if (!block) return null;
  const heading = preamble.lastIndexOf(OVERVIEW_HEADING, block.bodyStart);
  const from = heading >= 0 ? heading : preamble.indexOf(OVERVIEW_BLOCK_START);
  return preamble.slice(from, block.bodyEnd + OVERVIEW_BLOCK_END.length) + "\n\n";
}

/** `text` ending in exactly one blank line ("" stays ""). */
function withBlankLineAfter(text: string): string {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n` : "";
}

export function findOverviewBlock(text: string): { bodyStart: number; bodyEnd: number } | null {
  const start = text.indexOf(OVERVIEW_BLOCK_START);
  if (start < 0) return null;
  const bodyStart = start + OVERVIEW_BLOCK_START.length;
  const bodyEnd = text.indexOf(OVERVIEW_BLOCK_END, bodyStart);
  if (bodyEnd < 0) return null;
  return { bodyStart, bodyEnd };
}

/** Result of `mergeNote`, the same decision `VaultManager.saveManagedNote` makes. */
export interface NoteMergeResult {
  merged: string;
  /** "multi" = page-anchored merge, "sections" = transcript summary merge, "legacy" = single managed block merge. */
  mode: "multi" | "sections" | "legacy";
  reorders: Array<{ from: number; to: number; hash: string }>;
  insertions: number[];
  deletions: Array<{ slideNum: number; hash: string }>;
  drifts: Array<{ slideNum: number; oldHash: string; newHash: string }>;
  confirmDeckReplacement: boolean;
  notes: string[];
}

/**
 * Merge a freshly generated note into the existing file content. Throws on a
 * page-anchored (or transcript summary) to single-block downgrade.
 * Page-anchored merge when either side uses slide markers (a transcript
 * summary note becoming a slide note is kept whole as a backup), transcript
 * section merge when either side uses section markers, legacy single-block
 * merge otherwise (which keeps its "## 이전 노트 백업" behaviour for 1.0.x
 * notes).
 */
export function mergeNote(current: string, next: string): NoteMergeResult {
  const result = mergeNoteLf(toLf(current), toLf(next));
  return { ...result, merged: inEolOf(current, result.merged) };
}

function mergeNoteLf(currentContent: string, nextContent: string): NoteMergeResult {
  assertNoPageAnchoredDowngrade(currentContent, nextContent);
  if (hasMultiManagedMarkers(nextContent) || hasMultiManagedMarkers(currentContent)) {
    return { mode: "multi", ...mergeMultiManagedNote(currentContent, nextContent) };
  }
  if (hasSectionMarkers(nextContent) || hasSectionMarkers(currentContent)) {
    return { mode: "sections", ...mergeTranscriptNote(currentContent, nextContent) };
  }
  return {
    merged: mergeManagedNote(currentContent, nextContent),
    mode: "legacy",
    reorders: [],
    insertions: [],
    deletions: [],
    drifts: [],
    confirmDeckReplacement: false,
    notes: [],
  };
}
