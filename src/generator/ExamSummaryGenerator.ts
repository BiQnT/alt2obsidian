import { LLMProvider, ExamPeriod } from "../types";
import { VaultManager } from "../vault/VaultManager";
import { TokenChunker } from "../llm/TokenChunker";
import { sanitizeFilename, formatDate } from "../utils/helpers";

export class ExamSummaryGenerator {
  private chunker = new TokenChunker();

  constructor(
    private llm: LLMProvider,
    private vaultManager: VaultManager
  ) {}

  async generate(subject: string, period?: ExamPeriod): Promise<string> {
    const notes = await this.vaultManager.readNotesForSubject(subject, period);

    if (notes.length === 0) {
      const periodLabel = period === "midterm" ? "중간고사" : period === "final" ? "기말고사" : "";
      throw new Error(
        `"${subject}"${periodLabel ? ` ${periodLabel}` : ""} 범위의 강의 노트가 없습니다.`
      );
    }

    const combinedContent = notes
      .map((n) => `## ${n.title}\n\n${n.content}`)
      .join("\n\n---\n\n");

    const totalTokens = this.llm.estimateTokens(combinedContent);
    let summaryInput: string;

    if (totalTokens > this.llm.maxInputTokens * 0.8) {
      const chunks = this.chunker.chunkText(
        combinedContent,
        Math.floor(this.llm.maxInputTokens * 0.6)
      );

      const chunkSummaries: string[] = [];
      for (const chunk of chunks) {
        const summary = await this.llm.generateText(
          `Summarize the key concepts and relationships from these lecture notes:\n\n${chunk}`,
          {
            systemPrompt:
              "You are an academic summarizer. Extract key concepts and relationships concisely.",
            maxOutputTokens: 2048,
          }
        );
        chunkSummaries.push(summary);
      }
      summaryInput = chunkSummaries.join("\n\n---\n\n");
    } else {
      summaryInput = combinedContent;
    }

    const periodLabel =
      period === "midterm" ? "중간고사" : period === "final" ? "기말고사" : "전체";

    const prompt = `You are creating a ${periodLabel} exam preparation summary for the course "${subject}".

Given these lecture notes (${notes.length}강의), create a comprehensive exam summary in Korean with:

1. **강의 관계도**: Show how lectures connect using arrows (→). Show the progression of topics.
   Example: Lec1(기본개념) → Lec2(확장) → Lec3(응용)

2. **강의별 핵심 요약**: For each lecture, provide 3-5 bullet points of the most important exam topics.
   Use [[Concept Name]] wikilinks for key terms.
   Mark high-priority topics with ⭐.

3. **강의 간 연결**: Show how concepts from different lectures relate to each other.
   Use [[wikilinks]] to reference concept notes.

4. **예상 출제 유형**: List 3-5 likely exam question patterns based on the material.

Format as Obsidian markdown. Use ## for section headers.

Lecture notes:
${summaryInput}`;

    const examContent = await this.llm.generateText(prompt, {
      systemPrompt:
        "You are an academic exam preparation assistant. Create clear, structured summaries in Korean using Obsidian markdown format with [[wikilinks]].",
      maxOutputTokens: 4096,
    });

    const titleLabel = period ? `${subject} ${periodLabel} 시험요약` : `${subject} 시험요약`;
    const frontmatter = [
      "---",
      `title: "${titleLabel}"`,
      `subject: "${subject}"`,
      `tags: [${subject.toLowerCase()}, exam-summary${period ? `, ${period}` : ""}]`,
      `date: "${formatDate()}"`,
      `lectures: ${notes.length}`,
      period ? `exam_period: "${period}"` : null,
      `source: "alt2obsidian"`,
      "---",
      "",
    ]
      .filter((l) => l !== null)
      .join("\n");

    const fullContent =
      frontmatter + `# ${titleLabel}\n\n` + examContent;

    const filename = sanitizeFilename(titleLabel);
    const examFolder = `${this.vaultManager.getBasePath()}/Exam`;
    const path = `${examFolder}/${filename}.md`;
    await this.vaultManager.saveNote(fullContent, path);

    return path;
  }
}
