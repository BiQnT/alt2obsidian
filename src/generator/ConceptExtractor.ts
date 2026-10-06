import { LLMProvider, ConceptData } from "../types";
import { renderPrompt } from "../prompts/render";
import conceptExtractionTemplate from "../../prompts/concept-extraction.md";
import conceptExtractionSystemKoTemplate from "../../prompts/concept-extraction.system.ko.md";
import conceptExtractionSystemEnTemplate from "../../prompts/concept-extraction.system.en.md";
import conceptExtractionGistsTemplate from "../../prompts/concept-extraction-gists.md";
import conceptExtractionSectionsTemplate from "../../prompts/concept-extraction-sections.md";

/** Schema for the CLI providers. Every field is required (Codex strict mode); "" means none. */
export const CONCEPT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["concepts", "tags"],
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "definition", "lectureContext", "example", "caution", "relatedConcepts"],
        properties: {
          name: { type: "string" },
          definition: { type: "string" },
          lectureContext: { type: "string" },
          example: { type: "string" },
          caution: { type: "string" },
          relatedConcepts: { type: "array", items: { type: "string" } },
        },
      },
    },
    tags: { type: "array", items: { type: "string" } },
  },
};

export interface GistConceptInput {
  subject: string;
  gists: Array<{ page: number; gist: string }>;
  /** Names the slide commentary already wrapped in [[...]]. */
  linkCandidates: string[];
  existingConceptNames: string[];
  subjectTags: string[];
  signal?: AbortSignal;
}

export type ConceptResult = { concepts: ConceptData[]; tags: string[] };

/** Concepts of a lecture without slides (spec 4.10): from the section gists. */
export interface SectionConceptInput {
  subject: string;
  /** "구간 N [mm:ss]: gist" lines (sectionGistLines). */
  gistLines: string;
  linkCandidates: string[];
  existingConceptNames: string[];
  subjectTags: string[];
  signal?: AbortSignal;
}

function existingHint(existingConceptNames: string[]): string {
  return existingConceptNames.length > 0
    ? `\nExisting concept notes in this course (REUSE these exact names when the same concept appears, also when a name is in the older "한국어 (English)" order):\n${existingConceptNames
        .map((name) => `- ${name}`)
        .join("\n")}\n`
    : "";
}

export class ConceptExtractor {
  constructor(
    private llm: LLMProvider,
    private language: "ko" | "en" = "ko"
  ) {}

  private langInstruction(): string {
    return this.language === "ko"
      ? "Write ALL concept fields (definition, example, caution, lectureContext) as Korean (한국어) sentences. Inside them write academic terms and concept names in their original English (e.g., Lottery Scheduling, Context Switch, vruntime), never translated or transliterated; general words stay Korean. Do NOT write whole English sentences."
      : "Write all concept fields in clear English.";
  }

  private systemPrompt(): string {
    return renderPrompt(
      this.language === "ko" ? conceptExtractionSystemKoTemplate : conceptExtractionSystemEnTemplate,
      {}
    );
  }

  /** 1.x path: concepts from the (enhanced) lecture summary. */
  async extract(summary: string, subject: string, existingConceptNames: string[] = []): Promise<ConceptResult> {
    const prompt = renderPrompt(conceptExtractionTemplate, {
      subject,
      langInstruction: this.langInstruction(),
      existingConceptHint: existingHint(existingConceptNames),
      summary,
    });

    return this.llm.generateJSON(prompt, validateConcepts, { systemPrompt: this.systemPrompt() });
  }

  /**
   * 2.0 path (spec 5.4): concepts from the slide gists, the names the
   * commentary already linked, and the existing concept notes. No summary or
   * commentary body is sent.
   */
  async extractFromGists(input: GistConceptInput): Promise<ConceptResult> {
    const prompt = renderPrompt(conceptExtractionGistsTemplate, {
      subject: input.subject,
      langInstruction: this.langInstruction(),
      existingConceptHint: existingHint(input.existingConceptNames),
      subjectTags: input.subjectTags.length > 0 ? input.subjectTags.join(", ") : "(none)",
      linkCandidates: input.linkCandidates.length > 0 ? input.linkCandidates.join(", ") : "(none)",
      gists: input.gists.map((g) => `p.${g.page}: ${g.gist}`).join("\n"),
    });
    return this.llm.generateJSON(prompt, validateConcepts, {
      systemPrompt: this.systemPrompt(),
      schema: CONCEPT_SCHEMA,
      signal: input.signal,
    });
  }

  /** Prompt of `extractFromSectionGists` (the Skill renders the same one). */
  sectionPrompt(input: Omit<SectionConceptInput, "signal">): string {
    return renderPrompt(conceptExtractionSectionsTemplate, {
      subject: input.subject,
      langInstruction: this.langInstruction(),
      existingConceptHint: existingHint(input.existingConceptNames),
      subjectTags: input.subjectTags.length > 0 ? input.subjectTags.join(", ") : "(none)",
      linkCandidates: input.linkCandidates.length > 0 ? input.linkCandidates.join(", ") : "(none)",
      gists: input.gistLines,
    });
  }

  /** System prompt of the concept calls (by language). */
  conceptSystemPrompt(): string {
    return this.systemPrompt();
  }

  /** Transcript summary note (spec 4.10): concepts from the section gists, like `extractFromGists`. */
  async extractFromSectionGists(input: SectionConceptInput): Promise<ConceptResult> {
    return this.llm.generateJSON(this.sectionPrompt(input), validateConcepts, {
      systemPrompt: this.systemPrompt(),
      schema: CONCEPT_SCHEMA,
      signal: input.signal,
    });
  }
}

export function validateConcepts(raw: unknown): ConceptResult {
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.concepts)) {
    throw new Error("Expected concepts array");
  }
  if (!Array.isArray(obj.tags)) {
    throw new Error("Expected tags array");
  }
  const concepts: ConceptData[] = obj.concepts.map((c: Record<string, unknown>) => ({
    name: String(c.name || ""),
    definition: String(c.definition || ""),
    example: c.example ? String(c.example) : undefined,
    caution: c.caution ? String(c.caution) : undefined,
    lectureContext: c.lectureContext ? String(c.lectureContext) : undefined,
    relatedConcepts: Array.isArray(c.relatedConcepts) ? c.relatedConcepts.map(String) : [],
  }));
  // Soft quality warnings: do not fail the import, but surface what came
  // back below the bar so the user knows when a stronger model might help.
  for (const c of concepts) {
    if (c.definition.length < 80) {
      console.warn(
        `[Alt2Obsidian] concept "${c.name}" has a short definition (${c.definition.length} chars), consider re-running with a stronger model.`
      );
    }
  }
  if (concepts.length >= 2) {
    const orphan = concepts.find((c) => !c.relatedConcepts || c.relatedConcepts.length === 0);
    if (orphan) {
      console.warn(
        `[Alt2Obsidian] concept "${orphan.name}" has no relatedConcepts despite ${concepts.length} concepts in the lecture, graph linking may be incomplete.`
      );
    }
  }
  return { concepts, tags: obj.tags.map(String) };
}
