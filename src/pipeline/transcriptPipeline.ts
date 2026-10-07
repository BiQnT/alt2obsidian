// Summary note of a lecture without slides (spec 4.10), the transcript
// counterpart of lecturePipeline.ts:
//   plan (sections, no tokens) -> estimate -> batched section summaries ->
//   overview from the section gists + Alt summary (map-reduce) -> concepts
//   from the gists.
// No obsidian import: the plugin, the Skill CLI and the tests run this code.

import { ConceptData, EffortLevel, LLMProvider, ProviderId } from "../types";
import { renderPrompt } from "../prompts/render";
import type { LectureContext } from "../generator/BatchCommentaryGenerator";
import {
  buildSectionContextBlock,
  buildSectionSystemPrompt,
  buildSectionUserPrompt,
  SECTION_SCHEMA,
  SectionGenerationResult,
  sectionGistLines,
  sectionOutputTokens,
  SectionProgress,
  SectionSummaryGenerator,
} from "../generator/SectionSummaryGenerator";
import { ConceptExtractor } from "../generator/ConceptExtractor";
import { isAbortError } from "../llm/cli/CliRunner";
import { BudgetEstimate, CallShape, CONCEPTS_OUTPUT_TOKENS, estimateCalls, OVERVIEW_OUTPUT_TOKENS } from "../core/budget/estimate";
import { wikilinkCandidates } from "./lecturePipeline";
import type { TranscriptPlan } from "./transcriptPlan";
import overviewTemplate from "../../prompts/overview-from-sections.md";
import overviewSystemTemplate from "../../prompts/overview-from-sections.system.md";
import conceptSectionsTemplate from "../../prompts/concept-extraction-sections.md";

const ALT_SUMMARY_MAX = 6000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(text.length - Math.floor(max * 0.3));
  return `${head}\n\n[...중간 내용 생략...]\n\n${tail}`;
}

export function buildSectionOverviewPrompt(title: string, altSummary: string, gists: Map<number, string>, plan: Pick<TranscriptPlan, "sections">): string {
  return renderPrompt(overviewTemplate, {
    title,
    altSummary: altSummary.trim() ? truncate(altSummary.trim(), ALT_SUMMARY_MAX) : "(없음)",
    gists: sectionGistLines(gists, plan),
  });
}

export function buildSectionOverviewSystemPrompt(): string {
  return renderPrompt(overviewSystemTemplate, {});
}

export interface TranscriptRunInput {
  plan: TranscriptPlan;
  context: LectureContext;
  subject: string;
  language: "ko" | "en";
  altSummary: string;
  commentaryLlm: LLMProvider;
  conceptLlm: LLMProvider;
  signal?: AbortSignal;
  onStep?(step: "commentary" | "overview" | "concepts"): void;
  onBatch?: (p: SectionProgress) => void;
}

export interface TranscriptRunResult {
  sectionsResult: SectionGenerationResult;
  overview: string;
  concepts: ConceptData[];
  tags: string[];
  /** Non-fatal problems (overview or concepts fell back). */
  warnings: string[];
}

export async function runTranscriptSummary(input: TranscriptRunInput): Promise<TranscriptRunResult> {
  const warnings: string[] = [];
  input.onStep?.("commentary");
  const sectionsResult = await new SectionSummaryGenerator(input.commentaryLlm).generate({
    plan: input.plan,
    context: input.context,
    signal: input.signal,
    onProgress: input.onBatch,
  });

  input.onStep?.("overview");
  let overview = input.altSummary;
  if (sectionsResult.gists.size > 0) {
    try {
      overview = await input.commentaryLlm.generateText(buildSectionOverviewPrompt(input.context.title, input.altSummary, sectionsResult.gists, input.plan), {
        systemPrompt: buildSectionOverviewSystemPrompt(),
        signal: input.signal,
      });
    } catch (e) {
      if (isAbortError(e) || input.signal?.aborted) throw e;
      warnings.push(`전체 요약 생성 실패, Alt 요약을 그대로 씁니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  input.onStep?.("concepts");
  let concepts: ConceptData[] = [];
  let tags: string[] = [];
  if (sectionsResult.gists.size > 0) {
    try {
      const res = await new ConceptExtractor(input.conceptLlm, input.language).extractFromSectionGists({
        subject: input.subject,
        gistLines: sectionGistLines(sectionsResult.gists, input.plan),
        linkCandidates: wikilinkCandidates(sectionsResult.sections.map((s) => s.summary)),
        existingConceptNames: input.context.knownConcepts,
        subjectTags: input.context.subjectTags,
        signal: input.signal,
      });
      concepts = res.concepts;
      tags = res.tags;
    } catch (e) {
      if (isAbortError(e) || input.signal?.aborted) throw e;
      warnings.push(`개념 추출 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { sectionsResult, overview, concepts, tags, warnings };
}

/** Pre-run estimate from the exact prompts (spec 5.5), like `estimateLecture`. */
export function estimateTranscriptSummary(
  plan: TranscriptPlan,
  context: LectureContext,
  altSummary: string,
  commentaryProvider: ProviderId,
  conceptProvider: ProviderId,
  efforts: { commentaryEffort?: EffortLevel; conceptEffort?: EffortLevel } = {}
): BudgetEstimate {
  const system = buildSectionSystemPrompt();
  const contextBlock = buildSectionContextBlock(context, plan);
  const byNum = new Map(plan.sections.map((s) => [s.num, s]));
  const batchCalls: CallShape[] = plan.batches.map((b) => {
    const sections = b.map((n) => byNum.get(n)!);
    return {
      promptText: system + buildSectionUserPrompt(contextBlock, sections) + JSON.stringify(SECTION_SCHEMA),
      images: 0,
      schema: true,
      outputTokens: sections.reduce((n, s) => n + sectionOutputTokens(s.text.length), 0),
    };
  });
  // Gists are not known yet: assume 40 characters each.
  const fakeGists = new Map<number, string>();
  for (const s of plan.sections) fakeGists.set(s.num, "가".repeat(40));
  const followUps: CallShape[] = [];
  if (fakeGists.size > 0) {
    followUps.push({
      promptText: buildSectionOverviewSystemPrompt() + buildSectionOverviewPrompt(context.title, altSummary, fakeGists, plan),
      images: 0,
      schema: false,
      outputTokens: OVERVIEW_OUTPUT_TOKENS,
    });
  }
  const main = estimateCalls([...batchCalls, ...followUps], commentaryProvider, efforts.commentaryEffort);
  const conceptCalls: CallShape[] =
    fakeGists.size > 0
      ? [
          {
            promptText: conceptSectionsTemplate + context.knownConcepts.join("\n") + context.subjectTags.join(", ") + sectionGistLines(fakeGists, plan),
            images: 0,
            schema: true,
            outputTokens: CONCEPTS_OUTPUT_TOKENS,
          },
        ]
      : [];
  const concept = estimateCalls(conceptCalls, conceptProvider, efforts.conceptEffort);
  const generated = plan.sections.filter((s) => s.mode === "llm").length;
  return {
    calls: main.calls + concept.calls,
    inputTokens: main.inputTokens + concept.inputTokens,
    outputTokens: main.outputTokens + concept.outputTokens,
    imagesSent: 0,
    slidesTotal: 0,
    slidesGenerated: 0,
    slidesTemplated: 0,
    slidesDeduped: 0,
    slidesReused: 0,
    sectionsGenerated: generated,
    sectionsReused: plan.sections.length - generated,
  };
}
