import {
  AltNoteData,
  LLMResult,
  ConceptNote,
  LLMProvider,
  MANAGED_NOTE_START,
  MANAGED_NOTE_END,
} from "../types";
import { sanitizeFilename, formatDate } from "../utils/helpers";

export class NoteGenerator {
  constructor(private llm: LLMProvider) {}

  async generate(
    altData: AltNoteData,
    llmResult: LLMResult,
    subject: string
  ): Promise<{ lectureMarkdown: string; conceptNotes: ConceptNote[] }> {
    // Handle partial parse quality
    if (altData.parseQuality === "partial") {
      return this.generatePartialNote(altData, subject);
    }

    const title = sanitizeFilename(altData.title);
    const tags = [subject.toLowerCase(), ...llmResult.tags];

    // Build frontmatter (NO # prefix in YAML)
    const frontmatter = [
      "---",
      `title: "${altData.title}"`,
      `subject: "${subject}"`,
      `tags: [${tags.join(", ")}]`,
      `date: "${formatDate()}"`,
      `source: "alt2obsidian"`,
      altData.metadata.createdAt
        ? `alt_created: "${altData.metadata.createdAt}"`
        : null,
      `alt_id: "${altData.metadata.noteId}"`,
      "---",
      "",
    ]
      .filter((line) => line !== null)
      .join("\n");

    // Process summary with wikilinks for generated concept notes.
    let content = llmResult.processedSummary || altData.summary;

    // Insert concept wikilinks
    for (const concept of llmResult.concepts) {
      const regex = new RegExp(`(?<!\\[\\[)${this.escapeRegex(concept.name)}(?!\\]\\])`, "gi");
      content = content.replace(regex, `[[${concept.name}]]`);
    }

    const lectureMarkdown =
      frontmatter +
      `${MANAGED_NOTE_START}\n` +
      `# ${altData.title}\n\n` +
      content.trim() +
      `\n${MANAGED_NOTE_END}\n\n` +
      "## 내 메모\n";

    // Build concept notes
    const conceptNotes: ConceptNote[] = llmResult.concepts.map((c) => ({
      name: c.name,
      definition: c.definition,
      relatedLectures: [title],
      relatedConcepts: c.relatedConcepts,
      example: c.example,
      caution: c.caution,
      lectureContext: c.lectureContext,
    }));

    return { lectureMarkdown, conceptNotes };
  }

  private generatePartialNote(
    altData: AltNoteData,
    subject: string
  ): { lectureMarkdown: string; conceptNotes: ConceptNote[] } {
    const frontmatter = [
      "---",
      `title: "${altData.title}"`,
      `subject: "${subject}"`,
      `tags: [${subject.toLowerCase()}]`,
      `date: "${formatDate()}"`,
      `source: "alt2obsidian"`,
      `parse_quality: "partial"`,
      "---",
      "",
    ].join("\n");

    const lectureMarkdown =
      frontmatter +
      `${MANAGED_NOTE_START}\n` +
      `# ${altData.title}\n\n` +
      `> [!warning] Partial import\n` +
      `> Alt page format may have changed. Only title and description were extracted.\n\n` +
      (altData.summary || "내용을 추출할 수 없습니다.") +
      `\n${MANAGED_NOTE_END}\n\n` +
      "## 내 메모\n";

    return { lectureMarkdown, conceptNotes: [] };
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
