// Batched slide commentary for the CLI providers (spec 5.2, 5.3).
//
// One call covers up to K slides. Every call's prompt starts with the same
// bytes, so the CLI's prompt cache serves them from the second batch on:
//   1. fixed instructions      prompts/slide-commentary-batch.system.md
//   2. lecture-wide context    prompts/slide-commentary-batch.context.md
//   3. this batch's slides     prompts/slide-commentary-batch.user.md (last)
// The answer is JSON (Codex: --output-schema; Claude: schema stated at the
// end of the prompt), validated here. Slides missing from the answer or
// failing the checks are asked for once more, alone (spec 4.2 rule 4). A
// failed call is not retried as is (a timed-out one is tried once in two
// halves); a fatal error (missing CLI, not logged in, usage limit) or two
// failed calls in a row stop the run (src/llm/jsonBatches.ts, shared with
// the note verifier). Slides still failing keep their previous commentary when the note had one, and
// are listed under "⚠️ 처리 실패 슬라이드" like 1.x.

import { ImageInput, LLMProvider, PerSlideGenerationResult, SlideSection } from "../types";
import { renderPrompt } from "../prompts/render";
import { formatSlideMeta } from "../core/slideMeta";
import { templateGist } from "../core/prep/SlideAnalyzer";
import { DeckPlan, PlannedSlide } from "../pipeline/batchPlan";
import { runJsonBatches } from "../llm/jsonBatches";
import batchSystemTemplate from "../../prompts/slide-commentary-batch.system.md";
import batchContextTemplate from "../../prompts/slide-commentary-batch.context.md";
import batchUserTemplate from "../../prompts/slide-commentary-batch.user.md";
import batchSlideTemplate from "../../prompts/slide-commentary-batch.slide.md";

export interface LectureContext {
  title: string;
  /** Tags already used in this subject's notes (vault metadataCache). */
  subjectTags: string[];
  /** Existing concept note names of the subject. */
  knownConcepts: string[];
}

export const COMMENTARY_LIMITS = { content: 500, visual: 700 } as const;
export const GIST_LIMIT = 60;
/** Answers are checked with slack: models count characters loosely. */
const MIN_COMMENTARY_CHARS = 80;
const MAX_SLACK = 1.6;

export const BATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["slides"],
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slide", "commentary", "gist"],
        properties: {
          slide: { type: "integer", description: "슬라이드 번호" },
          commentary: { type: "string", description: "마크다운 해설. content 200~500자, visual 700자 이내" },
          gist: { type: "string", description: "60자 이내 한 줄 요지" },
        },
      },
    },
  },
};

export function buildBatchSystemPrompt(): string {
  return renderPrompt(batchSystemTemplate, {});
}

/** Lecture-wide block, byte-identical for every batch of a lecture. */
export function buildLectureContextBlock(ctx: LectureContext, plan: DeckPlan): string {
  const titles = plan.slides.map((s) => `${s.page}. ${s.title || "(텍스트 없음)"}`).join("\n");
  return renderPrompt(batchContextTemplate, {
    title: ctx.title,
    slideCount: plan.slides.length,
    subjectTags: ctx.subjectTags.length > 0 ? ctx.subjectTags.slice(0, 60).join(", ") : "(없음)",
    knownConcepts: ctx.knownConcepts.length > 0 ? ctx.knownConcepts.slice(0, 100).join(", ") : "(없음)",
    slideTitles: titles,
  });
}

export function buildSlideBlock(slide: PlannedSlide): string {
  return renderPrompt(batchSlideTemplate, {
    slideNum: slide.page,
    kind: slide.kind,
    slideText: slide.text.trim() || "(텍스트 레이어 없음)",
    transcriptBlock: slide.transcript ? `\n[전사 발췌]\n${slide.transcript}` : "",
    imageNote: slide.sendImage ? "\n[이미지 첨부: 도표, 그림, 그래프를 읽고 설명하시오]" : "",
  });
}

export function buildBatchUserPrompt(contextBlock: string, slides: PlannedSlide[]): string {
  return (
    contextBlock +
    "\n\n" +
    renderPrompt(batchUserTemplate, {
      slideList: slides.map((s) => s.page).join(", "),
      slideBlocks: slides.map(buildSlideBlock).join("\n\n"),
    })
  );
}

interface BatchItem {
  slide: number;
  commentary: string;
  gist: string;
}

/** Accepted items by page, and a reason per requested page that failed. */
export function checkBatchAnswer(
  raw: unknown,
  requested: PlannedSlide[]
): { ok: Map<number, BatchItem>; failed: Map<number, string> } {
  const ok = new Map<number, BatchItem>();
  const failed = new Map<number, string>();
  const items = (raw as { slides?: unknown })?.slides;
  const byPage = new Map<number, unknown>();
  if (Array.isArray(items)) {
    for (const it of items) {
      const n = Number((it as { slide?: unknown })?.slide);
      if (Number.isInteger(n) && !byPage.has(n)) byPage.set(n, it);
    }
  }
  for (const s of requested) {
    const it = byPage.get(s.page) as Partial<BatchItem> | undefined;
    if (!it) {
      failed.set(s.page, Array.isArray(items) ? "응답에 이 슬라이드가 없음" : "응답 JSON 형식 오류");
      continue;
    }
    const commentary = typeof it.commentary === "string" ? it.commentary.trim() : "";
    const limit = s.kind === "visual" ? COMMENTARY_LIMITS.visual : COMMENTARY_LIMITS.content;
    if (commentary.length < MIN_COMMENTARY_CHARS) {
      failed.set(s.page, `해설이 너무 짧음 (${commentary.length}자)`);
      continue;
    }
    if (commentary.length > limit * MAX_SLACK) {
      failed.set(s.page, `해설이 너무 김 (${commentary.length}자)`);
      continue;
    }
    const gistRaw = typeof it.gist === "string" ? it.gist.replace(/\s+/g, " ").trim() : "";
    const gist = gistRaw.length > GIST_LIMIT ? gistRaw.slice(0, GIST_LIMIT) : gistRaw;
    if (!gist) {
      failed.set(s.page, "요지(gist)가 비어 있음");
      continue;
    }
    ok.set(s.page, { slide: s.page, commentary, gist });
  }
  return { ok, failed };
}

export interface BatchProgress {
  batch: number;
  batches: number;
  slidesDone: number;
  slidesTotal: number;
  retry: boolean;
}

export interface BatchGenerateOptions {
  plan: DeckPlan;
  context: LectureContext;
  /** JPEG render of a page for slides with `sendImage` (null = render failed). */
  renderImage: (page: number) => Promise<ImageInput | null>;
  signal?: AbortSignal;
  onProgress?: (p: BatchProgress) => void;
}

export interface BatchGenerationResult extends PerSlideGenerationResult {
  /** Gist per page for LLM and reused slides (overview and concept input). */
  gists: Map<number, string>;
  /** Pages sent in each call, retries included (benchmark detail). */
  calls: number[][];
  /** LLM slides that got new commentary in this run. */
  generatedCount: number;
  /** Failed LLM slides that kept their previous commentary (listed in `errors` too). */
  keptPrevious: number[];
}

export class BatchCommentaryGenerator {
  constructor(private llm: LLMProvider) {}

  async generate(opts: BatchGenerateOptions): Promise<BatchGenerationResult> {
    const started = Date.now();
    const { plan } = opts;
    const system = buildBatchSystemPrompt();
    const contextBlock = buildLectureContextBlock(opts.context, plan);
    const byPage = new Map(plan.slides.map((s) => [s.page, s]));
    const llmTotal = plan.slides.filter((s) => s.mode === "llm").length;
    const { done, failures, calls } = await runJsonBatches<PlannedSlide, number, BatchItem>({
      batches: plan.batches.map((b) => b.pages.map((p) => byPage.get(p)!)),
      key: (s) => s.page,
      unitObject: "슬라이드를",
      signal: opts.signal,
      call: async (slides) => {
        const images: ImageInput[] = [];
        for (const s of slides) {
          if (!s.sendImage) continue;
          const img = await opts.renderImage(s.page);
          if (img) images.push(img);
        }
        return this.llm.generateJSON(buildBatchUserPrompt(contextBlock, slides), (r) => r, {
          systemPrompt: system,
          schema: BATCH_SCHEMA,
          images,
          signal: opts.signal,
          // Retries are per failed slide (runJsonBatches).
          attempts: 1,
          // The per-call timeout is for an 8-slide text batch; bigger
          // batches (Codex uses 16) and images get proportionally longer.
          timeoutScale: Math.max(1, slides.length / 8) + 0.1 * images.length,
        });
      },
      check: checkBatchAnswer,
      onProgress: (p) => opts.onProgress?.({ batch: p.batch, batches: p.batches, slidesDone: p.done, slidesTotal: llmTotal, retry: p.retry }),
    });

    const sections: SlideSection[] = [];
    const gists = new Map<number, string>();
    const errors: PerSlideGenerationResult["errors"] = [];
    const keptPrevious: number[] = [];
    for (const s of plan.slides) {
      if (s.mode === "template") {
        sections.push({ slideNum: s.page, hash: s.hash, commentary: s.template ?? "", citedConcepts: [] });
        const g = templateGist(s);
        if (g) gists.set(s.page, g);
      } else if (s.mode === "reuse" && s.reused) {
        sections.push({
          slideNum: s.page,
          hash: s.hash,
          commentary: s.reused.commentary,
          citedConcepts: [],
          meta: formatSlideMeta(s.imageSignal, s.reused.gist),
        });
        gists.set(s.page, s.reused.gist);
      } else {
        const item = done.get(s.page);
        if (item) {
          sections.push({
            slideNum: s.page,
            hash: s.hash,
            commentary: item.commentary,
            citedConcepts: [],
            meta: formatSlideMeta(s.imageSignal, item.gist),
          });
          gists.set(s.page, item.gist);
          continue;
        }
        const reason = failures.get(s.page) ?? "응답에 이 슬라이드가 없음";
        if (s.previous && s.previous.commentary.trim()) {
          // Keep the old commentary. Its meta (image signal, gist) only on a
          // hash match: a same-number match describes other content, so it
          // gets no reusable meta and the next import regenerates it.
          const sameContent = s.previous.hash === s.hash;
          sections.push({
            slideNum: s.page,
            hash: s.hash,
            commentary: s.previous.commentary,
            citedConcepts: [],
            meta: sameContent ? s.previous.meta || undefined : undefined,
          });
          if (sameContent && s.previous.gist) gists.set(s.page, s.previous.gist);
          keptPrevious.push(s.page);
          errors.push({ slideNum: s.page, reason: `새 해설 생성 실패, 이전 해설을 유지했습니다 (${reason})` });
        } else {
          errors.push({ slideNum: s.page, reason });
        }
      }
    }
    return {
      slides: sections,
      errors,
      gists,
      calls,
      generatedCount: done.size,
      keptPrevious,
      totalWallTimeMs: Date.now() - started,
      perSlideWallTimeMs: [],
    };
  }
}
