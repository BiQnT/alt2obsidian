// Re-import merge of Alt2Obsidian lecture notes. Pure module (no obsidian
// import) shared by VaultManager and the Skill CLI scripts/phase2/merge-note.mjs,
// so a Skill re-import preserves memos exactly like a plugin re-import.

import {
  MANAGED_NOTE_START,
  MANAGED_NOTE_END,
  OVERVIEW_BLOCK_START,
  OVERVIEW_BLOCK_END,
} from "../types";

/**
 * A page-anchored note must never be overwritten by a single-block note
 * (per-slide generation failed or no PDF): the multi-managed merge would
 * orphan every slide section. Throws so the import aborts before anything
 * is written; the caller surfaces the message.
 */
export const LEGACY_MIGRATION_NOTE =
  "기존 단일 블록 형식에서 페이지별 구조로 마이그레이션됩니다. 기존 노트 전체는 맨 아래 '이전 노트 백업'에 보관됩니다.";

export function assertNoPageAnchoredDowngrade(currentContent: string, nextContent: string): void {
  if (
    hasMultiManagedMarkers(currentContent) &&
    !hasMultiManagedMarkers(nextContent)
  ) {
    throw new Error(
      "기존 노트는 슬라이드별 형식인데 이번 결과에는 슬라이드별 해설이 없어 덮어쓰지 않고 가져오기를 중단했습니다. " +
        "PDF를 내려받거나 읽지 못했거나, 현재 LLM 공급자가 이미지 입력(멀티모달)을 지원하지 않는 경우입니다. " +
        "PDF 접근과 LLM 공급자 설정(Gemini 권장)을 확인한 뒤 다시 시도해주세요."
    );
  }
}

export function mergeManagedNote(currentContent: string, nextContent: string): string {
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

/**
 * Append the whole previous note under "## 이전 노트 백업" so nothing the user
 * wrote is lost when the new note cannot merge with it (a note without
 * managed markers, or a 1.0.x single-block note migrating to page-anchored).
 */
function appendPreviousNoteBackup(
  currentContent: string,
  nextContent: string,
  opts: { skipIfBackupExists: boolean }
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
    "> 이 내용은 Alt2Obsidian 관리 구간이 도입되기 전의 기존 노트입니다.",
    "",
    currentContent.trim(),
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

/**
 * Multi-managed merge: preserves the user's per-slide free-space across
 * regen by mapping incoming sections to existing sections via two-pass
 * hash-match → N-match-drift logic. Returns merged file content + summary
 * of what changed, suitable for ImportUpdateSummary surfacing.
 */
export function mergeMultiManagedNote(
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
    // No slide sections to map onto (1.0.x single-block note migrating to
    // page-anchored): keep the old note, including user text inside and
    // outside its managed block, as a backup instead of dropping it. Always
    // append here, even over an older backup: nesting beats losing text.
    return {
      merged: appendPreviousNoteBackup(existingContent, nextContent, { skipIfBackupExists: false }),
      reorders: [],
      insertions: next.sections.map((s) => s.slideNum),
      deletions: [],
      drifts: [],
      confirmDeckReplacement: false,
      notes: existingContent.trim() ? [LEGACY_MIGRATION_NOTE] : [],
    };
  }

  const used = new Set<number>();
  const matched = new Map<number, (typeof existing.sections)[number]>();
  const reorders: Array<{ from: number; to: number; hash: string }> = [];
  const insertions: number[] = [];
  const deletions: Array<{ slideNum: number; hash: string }> = [];
  const drifts: Array<{ slideNum: number; oldHash: string; newHash: string }> = [];

  // Bucket existing by hash for O(1) lookup; preserve deck order within bucket.
  const buckets = new Map<string, (typeof existing.sections)[number][]>();
  for (const s of existing.sections) {
    if (!buckets.has(s.hash)) buckets.set(s.hash, []);
    buckets.get(s.hash)!.push(s);
  }

  // PASS 1: hash-match (preferred): preserves callouts attached to identical content.
  next.sections.forEach((ns, i) => {
    const candidates = buckets.get(ns.hash) ?? [];
    for (const c of candidates) {
      const idx = existing.sections.indexOf(c);
      if (!used.has(idx)) {
        used.add(idx);
        matched.set(i, c);
        if (c.slideNum !== ns.slideNum) {
          reorders.push({ from: c.slideNum, to: ns.slideNum, hash: ns.hash });
        }
        break;
      }
    }
  });

  // PASS 2: N-match-with-drift for hash-unmatched incoming.
  next.sections.forEach((ns, i) => {
    if (matched.has(i)) return;
    const idx = existing.sections.findIndex(
      (s, j) => !used.has(j) && s.slideNum === ns.slideNum
    );
    if (idx >= 0) {
      used.add(idx);
      matched.set(i, existing.sections[idx]);
      drifts.push({
        slideNum: ns.slideNum,
        oldHash: existing.sections[idx].hash,
        newHash: ns.hash,
      });
    }
  });

  // PASS 3: insertions: hash-unmatched + N-unmatched
  next.sections.forEach((ns, i) => {
    if (!matched.has(i)) insertions.push(ns.slideNum);
  });

  // PASS 4: orphans
  for (let i = 0; i < existing.sections.length; i++) {
    if (!used.has(i)) {
      deletions.push({
        slideNum: existing.sections[i].slideNum,
        hash: existing.sections[i].hash,
      });
    }
  }

  // Plan §B v1.1 touch-up: deck-replacement confirm modal threshold.
  // Known limitation (spike doc §10): overlap on slide numbers can mask
  // orphans behind drifts; Task 1.3 may want to extend this signal.
  const confirmDeckReplacement =
    existing.sections.length > 0 &&
    deletions.length > 0.5 * existing.sections.length;

  // Re-emit: frontmatter + preamble + sections (with preserved free-space) + orphan footer
  const sectionMarkdown = next.sections
    .map((ns, i) => {
      const cand = matched.get(i);
      const startMarker = formatSlideMarker(ns.slideNum, ns.hash, ns.dup, "start");
      const endMarker = formatSlideMarker(ns.slideNum, ns.hash, ns.dup, "end");
      // Preserve user free-space if hash/N-matched, else default empty memo callout.
      const after = cand && cand.after.trim().length > 0
        ? cand.after
        : "\n\n> [!note] 내 메모\n> \n\n";
      return [
        `## 📚 슬라이드 ${ns.slideNum}`,
        "",
        startMarker,
        ns.managed.trim(),
        endMarker,
        // Same shape for kept and default memos (one blank line before, one
        // after) so re-importing an unchanged deck leaves the file unchanged.
        "\n" + after.replace(/^\n+|\n+$/g, "") + "\n\n",
      ].join("\n");
    })
    .join("\n");

  let orphanFooter = "";
  if (deletions.length > 0) {
    const orphanBlocks = existing.sections
      .map((s, i) => (used.has(i) ? null : s))
      .filter((s): s is (typeof existing.sections)[number] => s !== null)
      .map((s) => {
        const dupSuffix = s.dup !== undefined ? ` dup:${s.dup}` : "";
        const orphanMarker = `<!-- alt2obs:orphan slide:${s.slideNum} hash:${s.hash}${dupSuffix} -->`;
        return `${orphanMarker}\n${s.after.trim()}`;
      })
      .join("\n\n");
    orphanFooter = `\n\n## 🗑️ 삭제된 슬라이드 (orphan)\n\n${orphanBlocks}\n`;
  }

  const { preamble, notes } = mergeOverviewPreamble(existing.preamble, next.preamble);
  const merged = next.frontmatter + preamble + sectionMarkdown + orphanFooter;

  return { merged, reorders, insertions, deletions, drifts, confirmDeckReplacement, notes };
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
  /** "multi" = page-anchored merge, "legacy" = single managed block merge. */
  mode: "multi" | "legacy";
  reorders: Array<{ from: number; to: number; hash: string }>;
  insertions: number[];
  deletions: Array<{ slideNum: number; hash: string }>;
  drifts: Array<{ slideNum: number; oldHash: string; newHash: string }>;
  confirmDeckReplacement: boolean;
  notes: string[];
}

/**
 * Merge a freshly generated note into the existing file content. Throws on a
 * page-anchored to single-block downgrade. Page-anchored merge when either
 * side uses slide markers, legacy single-block merge otherwise (which keeps
 * its "## 이전 노트 백업" behaviour for 1.0.x notes).
 */
export function mergeNote(currentContent: string, nextContent: string): NoteMergeResult {
  assertNoPageAnchoredDowngrade(currentContent, nextContent);
  if (hasMultiManagedMarkers(nextContent) || hasMultiManagedMarkers(currentContent)) {
    return { mode: "multi", ...mergeMultiManagedNote(currentContent, nextContent) };
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
