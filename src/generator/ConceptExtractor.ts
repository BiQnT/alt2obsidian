import { LLMProvider, ConceptData } from "../types";

export class ConceptExtractor {
  constructor(private llm: LLMProvider) {}

  async extract(
    summary: string,
    subject: string,
    existingConceptNames: string[] = []
  ): Promise<{ concepts: ConceptData[]; tags: string[] }> {
    const existingConceptHint =
      existingConceptNames.length > 0
        ? `\nExisting concept notes in this course:\n${existingConceptNames
            .map((name) => `- ${name}`)
            .join("\n")}\n`
        : "";

    const prompt = `You are analyzing a lecture note for the course "${subject}".

Given this lecture summary, extract the key academic concepts.

For each concept provide:
- name: The concept name (concise, 1-4 words)
- definition: A clear definition (1-2 sentences)
- example: A short example from the lecture when available
- caution: A common mistake, caveat, or exam trap when available
- lectureContext: How this concept was used in this lecture (1 sentence)
- relatedConcepts: Names of other concepts that are closely related. Only include concepts that are either in your extracted concepts list or already exist in the course concept notes listed below. Do not invent new related concept names only for linking.
If an extracted concept matches an existing concept note, reuse the exact existing concept note name.
${existingConceptHint}

Return a JSON object with this structure:
{
  "concepts": [
    {
      "name": "Pipeline Hazard",
      "definition": "A situation where the next instruction cannot execute in the following clock cycle due to dependencies or resource conflicts.",
      "example": "A load-use dependency can force a stall when the loaded value is needed immediately.",
      "caution": "Do not confuse data hazards with structural hazards.",
      "lectureContext": "Used to explain why pipelined CPUs need forwarding and stall logic.",
      "relatedConcepts": ["Data Hazard", "Forwarding"]
    }
  ],
  "tags": ["pipeline", "cpu-architecture", "hazard"]
}

Extract at least 3 key concepts. Tags should be lowercase, hyphenated keywords for the lecture.

Lecture summary:
${summary}`;

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
        return { concepts, tags: obj.tags.map(String) };
      },
      {
        systemPrompt:
          "You are an academic concept extraction assistant. Always respond with valid JSON.",
      }
    );
  }
}
