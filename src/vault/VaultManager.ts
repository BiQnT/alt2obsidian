import { App, TFolder, normalizePath } from "obsidian";
import { SlideImage, ConceptNote } from "../types";
import { sanitizeFilename } from "../utils/helpers";
import { ConceptRegistry } from "./ConceptRegistry";

export class VaultManager {
  private conceptRegistry = new ConceptRegistry();

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

  async saveImage(image: SlideImage, folderPath: string): Promise<string> {
    const normalized = normalizePath(
      `${folderPath}/${sanitizeFilename(image.filename)}`
    );
    await this.ensureFolder(folderPath);

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) {
      await this.app.vault.modifyBinary(existing as any, image.data);
    } else {
      await this.app.vault.createBinary(normalized, image.data);
    }

    return image.filename;
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
          // Update existing concept note: append lecture reference
          const currentContent = await this.app.vault.read(existing as any);
          if (!currentContent.includes(`[[${lectureTitle}]]`)) {
            const updated = this.appendLectureReference(
              currentContent,
              lectureTitle
            );
            await this.app.vault.modify(existing as any, updated);
          }
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
    }

    return savedPaths;
  }

  async readNotesForSubject(subject: string): Promise<{ title: string; content: string }[]> {
    const subjectFolder = normalizePath(`${this.basePath}/${sanitizeFilename(subject)}`);
    const folder = this.app.vault.getAbstractFileByPath(subjectFolder);

    if (!(folder instanceof TFolder)) return [];

    const notes: { title: string; content: string }[] = [];
    for (const child of folder.children) {
      if (child.name.endsWith(".md")) {
        const content = await this.app.vault.read(child as any);
        notes.push({
          title: child.name.replace(/\.md$/, ""),
          content,
        });
      }
    }

    return notes;
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
      lectures ? `**관련 강의:** ${lectures}` : "",
      related ? `**관련 개념:** ${related}` : "",
      "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private appendLectureReference(
    content: string,
    lectureTitle: string
  ): string {
    const ref = `[[${lectureTitle}]]`;
    const marker = "**관련 강의:**";
    if (content.includes(marker)) {
      return content.replace(marker, `${marker} ${ref},`);
    }
    return content + `\n**관련 강의:** ${ref}\n`;
  }
}
