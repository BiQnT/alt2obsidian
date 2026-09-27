import { App, TFile, TFolder, normalizePath } from "obsidian";
import {
  ConceptNote,
  ImportUpdateSummary,
} from "../types";
import { sanitizeFilename } from "../utils/helpers";
import { ConceptRegistry } from "./ConceptRegistry";
import { CONCEPTS_DIR, conceptsFolder as conceptsFolderOf, EXAM_DIR, subjectFolder } from "./layout";
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

    // Page-anchored details whenever the new note uses slide markers. Covers
    // both a normal re-import and a legacy single-block note migrating to
    // page-anchored (mergeMultiManagedNote reports every slide as inserted
    // and adds the backup note), so the modal matches merge-note.mjs.
    if (nextHasMulti) {
      const merge = mergeMultiManagedNote(currentContent, nextContent);
      summary.slideReorders = merge.reorders;
      summary.slideInsertions = merge.insertions;
      summary.slideDeletions = merge.deletions;
      summary.slideDrifts = merge.drifts;
      summary.confirmDeckReplacement = merge.confirmDeckReplacement;
      if (merge.notes.length > 0) summary.notes = [...(summary.notes ?? []), ...merge.notes];
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
      ? normalizePath(conceptsFolderOf(this.basePath, subject))
      : normalizePath(`${this.basePath}/${CONCEPTS_DIR}`);
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

  /**
   * Tags already used by this subject's notes, most used first, from
   * Obsidian's metadataCache (spec 4.8 TagIndex). Put in the prompts so the
   * model reuses tags instead of inventing new spellings.
   */
  getSubjectTags(subject: string, limit = 60): string[] {
    const prefix = normalizePath(subjectFolder(this.basePath, subject)) + "/";
    const counts = new Map<string, number>();
    const skip = new Set(["concept", "midterm", "final", subject.toLowerCase()]);
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
      const tags: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
      for (const t of tags) {
        const tag = String(t).replace(/^#/, "").trim();
        if (!tag || skip.has(tag.toLowerCase())) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([t]) => t);
  }

  /** Current content of a note, or null when it does not exist. */
  async readNoteIfExists(path: string): Promise<string | null> {
    const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!existing || existing instanceof TFolder) return null;
    return this.app.vault.read(existing as TFile);
  }

  async getExistingConceptNames(subject: string): Promise<Set<string>> {
    const cacheKey = this.normalizeSubjectKey(subject);
    const cached = this.conceptNameCache.get(cacheKey);
    if (cached) return new Set(cached);

    const conceptsFolder = normalizePath(conceptsFolderOf(this.basePath, subject));
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
          child.name !== CONCEPTS_DIR &&
          child.name !== EXAM_DIR
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
