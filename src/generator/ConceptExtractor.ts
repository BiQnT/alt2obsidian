import { LLMProvider, ConceptData } from "../types";
import { renderPrompt } from "../prompts/render";
import conceptExtractionTemplate from "../../prompts/concept-extraction.md";
import conceptExtractionSystemKoTemplate from "../../prompts/concept-extraction.system.ko.md";
import conceptExtractionSystemEnTemplate from "../../prompts/concept-extraction.system.en.md";

export class ConceptExtractor {
  constructor(
    private llm: LLMProvider,
    private language: "ko" | "en" = "ko"
  ) {}

  async extract(
    summary: string,
    subject: string,
    existingConceptNames: string[] = []
  ): Promise<{ concepts: ConceptData[]; tags: string[] }> {
    const existingConceptHint =
      existingConceptNames.length > 0
        ? `\nExisting concept notes in this course (REUSE these exact names when the same concept appears):\n${existingConceptNames
            .map((name) => `- ${name}`)
            .join("\n")}\n`
        : "";

    const langInstruction =
      this.language === "ko"
        ? "Write ALL concept fields (definition, example, caution, lectureContext) in Korean (한국어). Do NOT mix English explanations into Korean fields, but technical terms can be parenthesized in English (e.g., **명세(Specification)**)."
        : "Write all concept fields in clear English.";

    const prompt = renderPrompt(conceptExtractionTemplate, {
      subject,
      langInstruction,
      existingConceptHint,
      summary,
    });

    return this.llm.generateJSON(
      prompt,
      (raw: unknown): { concepts: ConceptData[]; tags: string[] } => {
        const obj = raw as Record<string, unknown>;
        if (!Array.isArray(obj.concepts)) {
          throw new Error("Expected concepts array");
        }
        if (!Array.isArray(obj.tags)) {
          throw new Error("Expected tags array");
        }
        const concepts: ConceptData[] = obj.concepts.map(
          (c: Record<string, unknown>) => ({
            name: String(c.name || ""),
            definition: String(c.definition || ""),
            example: c.example ? String(c.example) : undefined,
            caution: c.caution ? String(c.caution) : undefined,
            lectureContext: c.lectureContext
              ? String(c.lectureContext)
              : undefined,
            relatedConcepts: Array.isArray(c.relatedConcepts)
              ? c.relatedConcepts.map(String)
              : [],
          })
        );
        // Soft quality warnings — do not fail the import, but surface what
        // came back below the bar so the user knows when re-running with
        // a stronger model might help.
        for (const c of concepts) {
          if (c.definition.length < 80) {
            console.warn(
              `[Alt2Obsidian] concept "${c.name}" has a short definition (${c.definition.length} chars) — consider re-running with a stronger model.`
            );
          }
        }
        if (concepts.length >= 2) {
          const orphan = concepts.find(
            (c) => !c.relatedConcepts || c.relatedConcepts.length === 0
          );
          if (orphan) {
            console.warn(
              `[Alt2Obsidian] concept "${orphan.name}" has no relatedConcepts despite ${concepts.length} concepts in the lecture — graph linking may be incomplete.`
            );
          }
        }
        return { concepts, tags: obj.tags.map(String) };
      },
      {
        systemPrompt: renderPrompt(
          this.language === "ko"
            ? conceptExtractionSystemKoTemplate
            : conceptExtractionSystemEnTemplate,
          {}
        ),
      }
    );
  }
}
