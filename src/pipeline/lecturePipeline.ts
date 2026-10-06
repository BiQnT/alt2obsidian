// Batched lecture generation for the CLI providers (spec 5.0):
//   plan (prep, no tokens) -> estimate -> batched commentary -> overview from
//   gists + Alt summary (map-reduce) -> concepts from gists.
// No obsidian import: the plugin and the headless benchmark
// (scripts/bench) run this same code.

import { ConceptData, ImageInput, LLMProvider, ProviderId } from "../types";
import { renderPrompt } from "../prompts/render";
import {
  BatchCommentaryGenerator,
  BatchGenerationResult,
  BatchProgress,
  buildBatchSystemPrompt,
  buildBatchUserPrompt,
  buildLectureContextBlock,
  BATCH_SCHEMA,
  LectureContext,
} from "../generator/BatchCommentaryGenerator";
import { ConceptExtractor } from "../generator/ConceptExtractor";
import { isAbortError } from "../llm/cli/CliRunner";
import { DeckPlan, planCounts } from "./batchPlan";
import {
  BudgetEstimate,
  CallShape,
  CONCEPTS_OUTPUT_TOKENS,
  estimateCalls,
  OUTPUT_TOKENS_PER_SLIDE,
  OVERVIEW_OUTPUT_TOKENS,
} from "../core/budget/estimate";
import overviewTemplate from "../../prompts/overview-from-gists.md";
import overviewSystemTemplate from "../../prompts/overview-from-gists.system.md";
import conceptGistsTemplate from "../../prompts/concept-extraction-gists.md";

export type PipelineStep = "commentary" | "overview" | "concepts";

const ALT_SUMMARY_MAX = 6000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(text.length - Math.floor(max * 0.3));
  return `${head}\n\n[...중간 내용 생략...]\n\n${tail}`;
}

export function gistLines(gists: Map<number, string>): string {
  return Array.from(gists.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([page, gist]) => `p.${page}: ${gist}`)
    .join("\n");
}

export function buildOverviewPrompt(title: string, altSummary: string, gists: Map<number, string>): string {
  return renderPrompt(overviewTemplate, {
    title,
    altSummary: altSummary.trim() ? truncate(altSummary.trim(), ALT_SUMMARY_MAX) : "(없음)",
    gists: gistLines(gists),
  });
}

/** Concept names wrapped in [[...]] by the commentary (heading links excluded). */
export function wikilinkCandidates(bodies: string[]): string[] {
  const names = new Set<string>();
  for (const body of bodies) {
    const re = /\[\[([^\]|#\n]+?)(?:\|[^\]]+)?\]\]/g;
    let m: RegExpExecArray | null;
    // Inside a table the alias pipe is written `\|`: drop the backslash from the name.
    while ((m = re.exec(body)) !== null) names.add(m[1].trim().replace(/\\$/, "").trim());
  }
  return Array.from(names);
}

export interface LectureRunInput {
  plan: DeckPlan;
  context: LectureContext;
  subject: string;
  language: "ko" | "en";
  altSummary: string;
  commentaryLlm: LLMProvider;
  conceptLlm: LLMProvider;
  renderImage(page: number): Promise<ImageInput | null>;
  signal?: AbortSignal;
  onStep?(step: PipelineStep): void;
  onBatch?(p: BatchProgress): void;
}

export interface LectureRunResult {
  slidesResult: BatchGenerationResult;
  overview: string;
  concepts: ConceptData[];
  tags: string[];
  /** Non-fatal problems (overview or concepts fell back). */
  warnings: string[];
}

export async function runBatchedLecture(input: LectureRunInput): Promise<LectureRunResult> {
  const warnings: string[] = [];
  input.onStep?.("commentary");
  const slidesResult = await new BatchCommentaryGenerator(input.commentaryLlm).generate({
    plan: input.plan,
    context: input.context,
    renderImage: input.renderImage,
    signal: input.signal,
    onProgress: input.onBatch,
  });

  // Gists of generated and reused slides only: template slides add nothing.
  const contentGists = new Map(
    Array.from(slidesResult.gists.entries()).filter(([page]) => {
      const s = input.plan.slides[page - 1];
      return s && s.mode !== "template";
    })
  );

  input.onStep?.("overview");
  let overview = input.altSummary;
  if (contentGists.size > 0) {
    try {
      overview = await input.commentaryLlm.generateText(
        buildOverviewPrompt(input.context.title, input.altSummary, contentGists),
        { systemPrompt: renderPrompt(overviewSystemTemplate, {}), signal: input.signal }
      );
    } catch (e) {
      if (isAbortError(e) || input.signal?.aborted) throw e;
      warnings.push(`전체 요약 생성 실패, Alt 요약을 그대로 씁니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  input.onStep?.("concepts");
  let concepts: ConceptData[] = [];
  let tags: string[] = [];
  if (contentGists.size > 0) {
    try {
      const res = await new ConceptExtractor(input.conceptLlm, input.language).extractFromGists({
        subject: input.subject,
        gists: Array.from(contentGists.entries()).map(([page, gist]) => ({ page, gist })),
        linkCandidates: wikilinkCandidates(slidesResult.slides.map((s) => s.commentary)),
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

  return { slidesResult, overview, concepts, tags, warnings };
}

/** Pre-run estimate from the exact batch prompts (spec 5.5). */
export function estimateLecture(
  plan: DeckPlan,
  context: LectureContext,
  altSummary: string,
  commentaryProvider: ProviderId,
  conceptProvider: ProviderId
): BudgetEstimate {
  const system = buildBatchSystemPrompt();
  const contextBlock = buildLectureContextBlock(context, plan);
  const byPage = new Map(plan.slides.map((s) => [s.page, s]));
  const batchCalls: CallShape[] = plan.batches.map((b) => {
    const slides = b.pages.map((p) => byPage.get(p)!);
    return {
      // The schema travels with every call (Claude: appended text; Codex: --output-schema).
      promptText: system + buildBatchUserPrompt(contextBlock, slides) + JSON.stringify(BATCH_SCHEMA),
      images: slides.filter((s) => s.sendImage).length,
      schema: true,
      outputTokens: slides.reduce(
        (n, s) => n + (s.kind === "visual" ? OUTPUT_TOKENS_PER_SLIDE.visual : OUTPUT_TOKENS_PER_SLIDE.content),
        0
      ),
    };
  });
  const counts = planCounts(plan);
  // Gists are not known yet: assume 40 characters each.
  const fakeGists = new Map<number, string>();
  for (const s of plan.slides) if (s.mode !== "template") fakeGists.set(s.page, "가".repeat(40));
  const followUps: CallShape[] = [];
  if (fakeGists.size > 0) {
    followUps.push({
      promptText: renderPrompt(overviewSystemTemplate, {}) + buildOverviewPrompt(context.title, altSummary, fakeGists),
      images: 0,
      schema: false,
      outputTokens: OVERVIEW_OUTPUT_TOKENS,
    });
  }
  const main = estimateCalls([...batchCalls, ...followUps], commentaryProvider);
  const conceptCalls: CallShape[] =
    fakeGists.size > 0
      ? [
          {
            promptText:
              conceptGistsTemplate +
              context.knownConcepts.join("\n") +
              context.subjectTags.join(", ") +
              gistLines(fakeGists),
            images: 0,
            schema: true,
            outputTokens: CONCEPTS_OUTPUT_TOKENS,
          },
        ]
      : [];
  const concept = estimateCalls(conceptCalls, conceptProvider);
  return {
    calls: main.calls + concept.calls,
    inputTokens: main.inputTokens + concept.inputTokens,
    outputTokens: main.outputTokens + concept.outputTokens,
    imagesSent: main.imagesSent,
    slidesTotal: counts.total,
    slidesGenerated: counts.llm,
    slidesTemplated: counts.templated,
    slidesDeduped: counts.deduped,
    slidesReused: counts.reused,
  };
}
