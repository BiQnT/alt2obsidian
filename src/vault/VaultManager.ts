import { App, TFolder, normalizePath } from "obsidian";
import {
  ConceptNote,
  ExamPeriod,
  ImportUpdateSummary,
} from "../types";
import { sanitizeFilename } from "../utils/helpers";
import { ConceptRegistry } from "./ConceptRegistry";
import {
  assertNoPageAnchoredDowngrade,
  findOverviewBlock,
  hasMultiManagedMarkers,
  mergeMultiManagedNote,
  mergeNote,
  splitManagedNote,
  splitMultiManagedNote,
} from "../core/merge";

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
    // Page-anchored or legacy single-block merge (src/core/merge.ts, shared
    // with the Skill CLI). Throws before writing on a page-anchored downgrade.
    const updatedContent = mergeNote(currentContent, content).merged;
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
    assertNoPageAnchoredDowngrade(currentContent, nextContent);
    const nextHasMulti = hasMultiManagedMarkers(nextContent);
    const currentHasMulti = hasMultiManagedMarkers(currentContent);

    // Heading + concept diff is always meaningful; compute it once on the
    // managed body (legacy path) or full content (multi path).
    const currentParts = splitManagedNote(currentContent);
    const nextParts = splitManagedNote(nextContent);
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
      const merge = mergeMultiManagedNote(currentContent, nextContent);
      summary.slideReorders = merge.reorders;
      summary.slideInsertions = merge.insertions;
      summary.slideDeletions = merge.deletions;
      summary.slideDrifts = merge.drifts;
      summary.confirmDeckReplacement = merge.confirmDeckReplacement;
      if (merge.notes.length > 0) summary.notes = [...(summary.notes ?? []), ...merge.notes];
    } else if (nextHasMulti && !currentHasMulti) {
      // Legacy → B1 migration: every incoming section is "new" relative to
      // the legacy single-block content. Surface it so the user sees the
      // structural shift.
      const next = splitMultiManagedNote(nextContent);
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

  /** Headings outside the overview block (its body is regenerated LLM text). */
  private extractHeadings(content: string): Set<string> {
    const headings = new Set<string>();
    const overview = findOverviewBlock(content);
    const scanned = overview
      ? content.slice(0, overview.bodyStart) + content.slice(overview.bodyEnd)
      : content;
    for (const line of scanned.split("\n")) {
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
