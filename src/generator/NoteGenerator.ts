import {
  AltNoteData,
  LLMResult,
  ConceptNote,
  LLMProvider,
  MANAGED_NOTE_START,
  MANAGED_NOTE_END,
  PerSlideGenerationResult,
  SlideSection,
} from "../types";
import { sanitizeFilename, formatDate } from "../utils/helpers";

export class NoteGenerator {
  constructor(private llm: LLMProvider) {}

  /**
   * Page-anchored assembly path (plan Task 1.2). Used when per-slide
   * commentary is available (full-quality + PDF available + per-slide
   * Gemini calls succeeded). Output structure:
   *
   *   ---
   *   frontmatter
   *   ---
   *
   *   # Lecture Title
   *
   *   ## 📚 슬라이드 N
   *   <!-- alt2obs:slide:N hash:HHHHHHHH start -->
   *   [Gemini commentary, with [[Concept]] wikilinks injected]
   *   <!-- alt2obs:slide:N hash:HHHHHHHH end -->
   *
   *   > [!note] 내 메모
   *   >
   *
   * Round 5 invariant — the per-slide `> [!note]` callout sits OUTSIDE the
   * managed-block markers, so re-import preserves it via the multi-managed
   * merge algorithm validated in spike 1.0b.
   *
   * Caller is responsible for selecting between this and `generate()` based
   * on slide availability.
   */
  async generatePageAnchored(
    altData: AltNoteData,
    slidesResult: PerSlideGenerationResult,
    llmResult: LLMResult,
    subject: string
  ): Promise<{ lectureMarkdown: string; conceptNotes: ConceptNote[] }> {
    if (slidesResult.slides.length === 0) {
      // No usable slide commentary — fall back to lecture-level path.
      return this.generate(altData, llmResult, subject);
    }

    const title = sanitizeFilename(altData.title);
    const tags = [subject.toLowerCase(), ...llmResult.tags];

    const frontmatter = [
      "---",
      `title: "${altData.title}"`,
      `subject: "${subject}"`,
      `tags: [${tags.join(", ")}]`,
      `date: "${formatDate()}"`,
      `source: "alt2obsidian"`,
      `slide_count: ${slidesResult.slides.length}`,
      altData.metadata.createdAt
        ? `alt_created: "${altData.metadata.createdAt}"`
        : null,
      `alt_id: "${altData.metadata.noteId}"`,
      "---",
      "",
    ]
      .filter((line) => line !== null)
      .join("\n");

    // Concept-name list drives global wikilink injection across all sections.
    // Plan §Task 1.2 risk note: "a concept linked in slide 5 should also be
    // linked in slide 12 even if [[X]] already exists locally — handled by
    // running the regex pass once per section over all concepts[]". This
    // matches: every section is rewritten with all known concept names.
    const conceptNames = llmResult.concepts.map((c) => c.name);
    const sections = slidesResult.slides
      .map((slide) => this.buildSlideSection(slide, conceptNames))
      .join("\n\n");

    const orphanFooter =
      slidesResult.errors.length > 0
        ? `\n\n## ⚠️ 처리 실패 슬라이드\n\n` +
          slidesResult.errors
            .map((e) => `- 슬라이드 ${e.slideNum}: ${e.reason}`)
            .join("\n") +
          "\n"
        : "";

    const lectureMarkdown =
      frontmatter +
      `# ${altData.title}\n\n` +
      sections +
      orphanFooter +
      "\n";

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

  /**
   * Build a single slide section. The managed-block markers (start/end)
   * sandwich only the LLM commentary. The `> [!note] 내 메모` callout below
   * the end marker is the user's free-space anchor — preserved on regen by
   * the multi-managed merge algorithm (Task 1.3).
   */
  private buildSlideSection(slide: SlideSection, conceptNames: string[]): string {
    let body = slide.commentary;
    for (const name of conceptNames) {
      const regex = new RegExp(
        `(?<!\\[\\[)${this.escapeRegex(name)}(?!\\]\\])`,
        "gi"
      );
      body = body.replace(regex, `[[${name}]]`);
    }
    const startMarker = `<!-- alt2obs:slide:${slide.slideNum} hash:${slide.hash} start -->`;
    const endMarker = `<!-- alt2obs:slide:${slide.slideNum} hash:${slide.hash} end -->`;
    return [
      `## 📚 슬라이드 ${slide.slideNum}`,
      "",
      startMarker,
      body,
      endMarker,
      "",
      "> [!note] 내 메모",
      "> ",
    ].join("\n");
  }

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
