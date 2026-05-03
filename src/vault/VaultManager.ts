import { App, TFolder, normalizePath } from "obsidian";
import {
  ConceptNote,
  ExamPeriod,
  ImportUpdateSummary,
  MANAGED_NOTE_START,
  MANAGED_NOTE_END,
} from "../types";
import { sanitizeFilename } from "../utils/helpers";
import { ConceptRegistry } from "./ConceptRegistry";

export class VaultManager {
  private conceptRegistry = new ConceptRegistry();
  private conceptNameCache = new Map<string, Set<string>>();

  constructor(
    private app: App,
    private basePath: string
  ) {}

  setBasePath(path: string): void {
    this.basePath = path;
  }

  getBasePath(): string {
    return this.basePath;
  }

  async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return;

    try {
      await this.app.vault.createFolder(normalized);
    } catch {
      // Folder may already exist (race condition) — that's fine
    }
  }

  async saveNote(content: string, path: string): Promise<string> {
    const normalized = normalizePath(path);
    const dir = normalized.substring(0, normalized.lastIndexOf("/"));
    await this.ensureFolder(dir);

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) {
      await this.app.vault.modify(existing as any, content);
    } else {
      await this.app.vault.create(normalized, content);
    }

    return normalized;
  }

  async saveManagedNote(
    content: string,
    path: string
  ): Promise<{ path: string; wasUpdate: boolean }> {
    const normalized = normalizePath(path);
    const dir = normalized.substring(0, normalized.lastIndexOf("/"));
    await this.ensureFolder(dir);

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!existing) {
      await this.app.vault.create(normalized, content);
      return { path: normalized, wasUpdate: false };
    }

    const currentContent = await this.app.vault.read(existing as any);
    // Dispatch: B1 multi-managed merge if either side uses the new format,
    // legacy single-block merge otherwise. The legacy path retains its
    // "## 이전 노트 백업" behavior for the original 1.0.x → managed-block
    // transition (see plan Task 1.3 backward-compat rules).
    const nextHasMulti = this.hasMultiManagedMarkers(content);
    const currentHasMulti = this.hasMultiManagedMarkers(currentContent);
    const updatedContent =
      nextHasMulti || currentHasMulti
        ? this.mergeMultiManagedNote(currentContent, content).merged
        : this.mergeManagedNote(currentContent, content);
    await this.app.vault.modify(existing as any, updatedContent);

    return { path: normalized, wasUpdate: true };
  }

  async buildManagedNoteUpdateSummary(
    path: string,
    nextContent: string,
    nextConceptNames: string[]
  ): Promise<ImportUpdateSummary> {
    const normalized = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!existing) {
      return {
        isUpdate: false,
        addedSections: [],
        removedSections: [],
        addedConcepts: nextConceptNames,
        removedConcepts: [],
        changedLineCount: 0,
      };
    }

    const currentContent = await this.app.vault.read(existing as any);
    const nextHasMulti = this.hasMultiManagedMarkers(nextContent);
    const currentHasMulti = this.hasMultiManagedMarkers(currentContent);

    // Heading + concept diff is always meaningful; compute it once on the
    // managed body (legacy path) or full content (multi path).
    const currentParts = this.splitManagedNote(currentContent);
    const nextParts = this.splitManagedNote(nextContent);
    const currentBody = currentParts.managed || currentContent;
    const nextBody = nextParts.managed || nextContent;

    const summary: ImportUpdateSummary = {
      isUpdate: true,
      addedSections: this.diffSet(
        this.extractHeadings(nextBody),
        this.extractHeadings(currentBody)
      ),
      removedSections: this.diffSet(
        this.extractHeadings(currentBody),
        this.extractHeadings(nextBody)
      ),
      addedConcepts: this.diffSet(new Set(nextConceptNames), this.extractWikilinks(currentBody)),
      removedConcepts: this.diffSet(this.extractWikilinks(currentBody), new Set(nextConceptNames)),
      changedLineCount: this.countChangedLines(currentBody, nextBody),
    };

    // B1 multi-managed details — only when both sides use the new format.
    if (nextHasMulti && currentHasMulti) {
      const merge = this.mergeMultiManagedNote(currentContent, nextContent);
      summary.slideReorders = merge.reorders;
      summary.slideInsertions = merge.insertions;
      summary.slideDeletions = merge.deletions;
      summary.slideDrifts = merge.drifts;
      summary.confirmDeckReplacement = merge.confirmDeckReplacement;
    } else if (nextHasMulti && !currentHasMulti) {
      // Legacy → B1 migration: every incoming section is "new" relative to
      // the legacy single-block content. Surface it so the user sees the
      // structural shift.
      const next = this.splitMultiManagedNote(nextContent);
      summary.slideInsertions = next.sections.map((s) => s.slideNum);
      summary.notes = [
        ...(summary.notes ?? []),
        "기존 단일 블록 형식에서 페이지별 구조로 마이그레이션됩니다.",
      ];
    }

    return summary;
  }

  async saveConceptNotes(
    concepts: ConceptNote[],
    lectureTitle: string,
    subject?: string
  ): Promise<string[]> {
    // Organize concepts inside subject folder: Alt2Obsidian/{subject}/Concepts/
    const conceptsFolder = subject
      ? normalizePath(`${this.basePath}/${sanitizeFilename(subject)}/Concepts`)
      : normalizePath(`${this.basePath}/Concepts`);
    await this.ensureFolder(conceptsFolder);

    const acquiredNames: string[] = [];
    const savedPaths: string[] = [];

    try {
      for (const concept of concepts) {
        const filename = sanitizeFilename(concept.name);
        const path = normalizePath(`${conceptsFolder}/${filename}.md`);
        const existing = this.app.vault.getAbstractFileByPath(path);

        if (existing) {
          const currentContent = await this.app.vault.read(existing as any);
          const updated = this.updateExistingConceptNote(
            currentContent,
            concept,
            lectureTitle
          );
          if (updated !== currentContent) await this.app.vault.modify(existing as any, updated);
          savedPaths.push(path);
        } else if (this.conceptRegistry.acquire(concept.name)) {
          acquiredNames.push(concept.name);
          const content = this.buildConceptNoteContent(concept);
          await this.app.vault.create(path, content);
          savedPaths.push(path);
        }
      }
    } finally {
      this.conceptRegistry.releaseAll(acquiredNames);
      if (subject) this.conceptNameCache.delete(this.normalizeSubjectKey(subject));
    }

    return savedPaths;
  }

  async getExistingConceptNames(subject: string): Promise<Set<string>> {
    const cacheKey = this.normalizeSubjectKey(subject);
    const cached = this.conceptNameCache.get(cacheKey);
    if (cached) return new Set(cached);

    const conceptsFolder = normalizePath(
      `${this.basePath}/${sanitizeFilename(subject)}/Concepts`
    );
    const folder = this.app.vault.getAbstractFileByPath(conceptsFolder);
    const names = new Set<string>();

    if (!(folder instanceof TFolder)) return names;

    for (const child of folder.children) {
      if (child.name.endsWith(".md")) {
        names.add(child.name.replace(/\.md$/, ""));
      }
    }

    this.conceptNameCache.set(cacheKey, new Set(names));
    return names;
  }

  async readNotesForSubject(
    subject: string,
    period?: ExamPeriod
  ): Promise<{ title: string; content: string }[]> {
    const subjectFolder = normalizePath(`${this.basePath}/${sanitizeFilename(subject)}`);
    const folder = this.app.vault.getAbstractFileByPath(subjectFolder);

    if (!(folder instanceof TFolder)) return [];

    const notes: { title: string; content: string }[] = [];
    for (const child of folder.children) {
      if (!child.name.endsWith(".md")) continue;
      const content = await this.app.vault.read(child as any);

      if (period) {
        const tagsMatch = content.match(/^tags:\s*\[([^\]]+)\]/m);
        const tags = tagsMatch
          ? tagsMatch[1].split(",").map((t) => t.trim())
          : [];
        if (!tags.includes(period)) continue;
      }

      notes.push({ title: child.name.replace(/\.md$/, ""), content });
    }

    return notes;
  }

  async saveRawFile(data: ArrayBuffer, path: string): Promise<string> {
    const normalized = normalizePath(path);
    const dir = normalized.substring(0, normalized.lastIndexOf("/"));
    await this.ensureFolder(dir);

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) {
      await this.app.vault.modifyBinary(existing as any, data);
    } else {
      await this.app.vault.createBinary(normalized, data);
    }
    return normalized;
  }

  getKnownSubjects(): string[] {
    const baseFolder = this.app.vault.getAbstractFileByPath(
      normalizePath(this.basePath)
    );
    if (!(baseFolder instanceof TFolder)) return [];

    return baseFolder.children
      .filter(
        (child) =>
          child instanceof TFolder &&
          child.name !== "Concepts" &&
          child.name !== "Exam"
      )
      .map((child) => child.name);
  }

  private buildConceptNoteContent(concept: ConceptNote): string {
    const related = concept.relatedConcepts
      .map((c) => `[[${c}]]`)
      .join(", ");
    const lectures = concept.relatedLectures
      .map((l) => `[[${l}]]`)
      .join(", ");

    return [
      "---",
      `tags: [concept]`,
      "---",
      "",
      `# ${concept.name}`,
      "",
      `**정의:** ${concept.definition}`,
      "",
      concept.lectureContext ? `**강의 맥락:** ${concept.lectureContext}` : "",
      concept.example ? `**예시:** ${concept.example}` : "",
      concept.caution ? `**주의:** ${concept.caution}` : "",
      "",
      lectures ? `**관련 강의:** ${lectures}` : "",
      related ? `**관련 개념:** ${related}` : "",
      "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private updateExistingConceptNote(
    content: string,
    concept: ConceptNote,
    lectureTitle: string
  ): string {
    let updated = this.appendLectureReference(content, lectureTitle);
    updated = this.appendMissingConceptField(
      updated,
      "**강의 맥락:**",
      concept.lectureContext
    );
    updated = this.appendMissingConceptField(
      updated,
      "**예시:**",
      concept.example
    );
    updated = this.appendMissingConceptField(
      updated,
      "**주의:**",
      concept.caution
    );
    updated = this.appendRelatedConcepts(updated, concept.relatedConcepts);
    return updated;
  }

  private appendLectureReference(
    content: string,
    lectureTitle: string
  ): string {
    const ref = `[[${lectureTitle}]]`;
    if (content.includes(ref)) return content;

    const marker = "**관련 강의:**";
    const existingLine = content.match(/^(\*\*관련 강의:\*\*\s*)(.*)$/m);
    if (existingLine) {
      const currentRefs = existingLine[2].trim();
      const nextRefs = currentRefs ? `${currentRefs}, ${ref}` : ref;
      return content.replace(existingLine[0], `${marker} ${nextRefs}`);
    }
    return content + `\n**관련 강의:** ${ref}\n`;
  }

  private appendMissingConceptField(
    content: string,
    marker: string,
    value?: string
  ): string {
    if (!value || content.includes(marker)) return content;
    const relatedMarker = "**관련 강의:**";
    const line = `${marker} ${value}`;
    if (content.includes(relatedMarker)) {
      return content.replace(relatedMarker, `${line}\n\n${relatedMarker}`);
    }
    return content.trimEnd() + `\n\n${line}\n`;
  }

  private appendRelatedConcepts(content: string, relatedConcepts: string[]): string {
    if (relatedConcepts.length === 0) return content;

    const refs = relatedConcepts.map((concept) => `[[${concept}]]`);
    const existingLine = content.match(/^(\*\*관련 개념:\*\*\s*)(.*)$/m);
    if (!existingLine) {
      return content.trimEnd() + `\n**관련 개념:** ${refs.join(", ")}\n`;
    }

    const current = existingLine[2].trim();
    const additions = refs.filter((ref) => !current.includes(ref));
    if (additions.length === 0) return content;

    const nextRefs = current ? `${current}, ${additions.join(", ")}` : additions.join(", ");
    return content.replace(existingLine[0], `**관련 개념:** ${nextRefs}`);
  }

  private mergeManagedNote(currentContent: string, nextContent: string): string {
    const nextParts = this.splitManagedNote(nextContent);
    const currentParts = this.splitManagedNote(currentContent);

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

    // Plan Task 1.3 backward-compat: skip the "## 이전 노트 백업" write if the
    // current file already has one. Honors Principle 2 (1.0.x notes
    // untouched a second time) by not stacking duplicate backup sections
    // on repeated re-imports of legacy files.
    const hasExistingBackup = /(^|\n)## 이전 노트 백업\s*\n/.test(currentContent);
    if (hasExistingBackup) {
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

  private splitManagedNote(content: string): {
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

  private hasMultiManagedMarkers(content: string): boolean {
    return /<!-- alt2obs:slide:\d+ hash:[0-9a-f]{8}(?: dup:\d+)? (start|end) -->/.test(
      content
    );
  }

  private splitMultiManagedNote(content: string): {
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
      if (pairIdx < 0) continue; // unpaired start — ignore
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

  private formatSlideMarker(
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
  private mergeMultiManagedNote(
    existingContent: string,
    nextContent: string
  ): {
    merged: string;
    reorders: Array<{ from: number; to: number; hash: string }>;
    insertions: number[];
    deletions: Array<{ slideNum: number; hash: string }>;
    drifts: Array<{ slideNum: number; oldHash: string; newHash: string }>;
    confirmDeckReplacement: boolean;
  } {
    const existing = this.splitMultiManagedNote(existingContent);
    const next = this.splitMultiManagedNote(nextContent);

    if (existing.sections.length === 0) {
      return {
        merged: nextContent,
        reorders: [],
        insertions: next.sections.map((s) => s.slideNum),
        deletions: [],
        drifts: [],
        confirmDeckReplacement: false,
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

    // PASS 1 — hash-match (preferred): preserves callouts attached to identical content.
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

    // PASS 2 — N-match-with-drift for hash-unmatched incoming.
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

    // PASS 3 — insertions: hash-unmatched + N-unmatched
    next.sections.forEach((ns, i) => {
      if (!matched.has(i)) insertions.push(ns.slideNum);
    });

    // PASS 4 — orphans
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
        const startMarker = this.formatSlideMarker(ns.slideNum, ns.hash, ns.dup, "start");
        const endMarker = this.formatSlideMarker(ns.slideNum, ns.hash, ns.dup, "end");
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
          after.startsWith("\n") ? after.slice(1) : after,
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

    const merged = next.frontmatter + next.preamble + sectionMarkdown + orphanFooter;

    return { merged, reorders, insertions, deletions, drifts, confirmDeckReplacement };
  }

  private extractHeadings(content: string): Set<string> {
    const headings = new Set<string>();
    for (const line of content.split("\n")) {
      const match = line.match(/^#{1,6}\s+(.+)$/);
      if (match) headings.add(match[1].trim());
    }
    return headings;
  }

  private extractWikilinks(content: string): Set<string> {
    const links = new Set<string>();
    const regex = /\[\[([^\]|#\n]+?)(?:\|[^\]]+)?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      links.add(match[1].trim());
    }
    return links;
  }

  private diffSet(left: Set<string>, right: Set<string>): string[] {
    return Array.from(left)
      .filter((item) => !right.has(item))
      .slice(0, 8);
  }

  private countChangedLines(currentContent: string, nextContent: string): number {
    const currentLines = new Set(
      currentContent.split("\n").map((line) => line.trim()).filter(Boolean)
    );
    return nextContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !currentLines.has(line))
      .length;
  }

  private normalizeSubjectKey(subject: string): string {
    return sanitizeFilename(subject).toLowerCase();
  }
}
