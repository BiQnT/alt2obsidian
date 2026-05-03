// Per-slide LLM commentary generator (plan Task 1.1).
//
// Renders each PDF page to a PNG, hashes it with the spike-validated 8-hex
// SHA-1, and calls the LLM's multimodal endpoint with [prompt, image,
// transcript-chunk]. Returns SlideSection[] for the assembler (Task 1.2) to
// wrap in `## 📚 슬라이드 N` + `<!-- alt2obs:slide:N hash:H -->` markers.
//
// Pattern mirrors junnnnnw00/autonotes' `_process_slide`: one LLM call per
// slide, sequential, with rate-limit guard already enforced inside
// GeminiProvider.waitForRateLimit. Errors per slide are isolated — one bad
// slide does not abort the whole import.

import {
  LLMProvider,
  PerSlideGenerationResult,
  SlideSection,
  VisionImageRef,
} from "../types";
import { PdfProcessor } from "../pdf/PdfProcessor";
import { hashSlidePngBase64 } from "../vault/slideHash";

export interface PerSlideGenerationOptions {
  /**
   * Lecture audio transcript (concatenated segments from `RscParser`). Passed
   * to the LLM in even-sized chunks across slides. The current `RscParser`
   * loses per-segment timestamps (segments are joined by " "), so we cannot
   * yet do altToNotes-style time-proportional mapping; even-split is the
   * stop-gap. Pass `null` to skip transcript injection entirely.
   */
  transcript: string | null;
  /**
   * Concept names already present in this subject's `Concepts/` folder. The
   * prompt instructs the LLM to reuse these names when the same concept
   * appears, so we don't end up with `[[Big-O]]` and `[[Big-O 표기법]]` as
   * separate concept notes.
   */
  existingConceptNames: string[];
  /** Max render width in px. Default 1024 (matches PdfProcessor default). */
  maxPngWidth?: number;
  /** Override per-slide max output tokens. Default 2048. */
  maxOutputTokens?: number;
  /** Progress callback for UI. Called at each stage transition. */
  onProgress?: (
    slideNum: number,
    total: number,
    stage: "rendering" | "hashing" | "calling" | "done"
  ) => void;
}

const SYSTEM_PROMPT =
  "You are an academic note-taking assistant for Korean university students. Produce concise, well-structured Korean Markdown for studying. Output only the section body — never section headers.";

function buildSlidePrompt(
  slideNum: number,
  totalSlides: number,
  transcriptChunk: string | null,
  existingConceptNames: string[]
): string {
  const conceptList =
    existingConceptNames.length > 0
      ? `\n\n[기존 개념 목록 — 같은 의미면 이 이름을 그대로 쓰시오. 새 개념은 새 이름으로 도입 가능]\n${existingConceptNames.slice(0, 100).join(", ")}`
      : "";
  const transcriptBlock = transcriptChunk
    ? `\n\n[해당 구간 음성 전사 (참고용 — raw 그대로 붙여넣기 금지, 교수님 강조 포인트만 발췌해 큐레이팅하시오)]\n${transcriptChunk.trim()}`
    : "";

  return `다음은 강의 슬라이드 ${slideNum}/${totalSlides}의 이미지입니다. 슬라이드 내용을 보고 학생이 공부하기 좋은 한국어 마크다운 해설을 작성하시오.

규칙:
- 출력은 마크다운 본문만. 섹션 헤더(\`#\`, \`##\`) 사용 금지 — 호출자가 슬라이드 헤더를 따로 붙입니다.
- 슬라이드의 핵심 정의는 \`> [!definition] 개념명\` callout으로 표시.
- 예시/공식/코드는 \`> [!example]\` callout으로 표시.
- 시험 출제 포인트는 \`> [!important]\` callout으로 표시.
- 음성 전사가 있으면 교수님이 강조한 1-2개 포인트만 \`> "..."\` 인용 형태로 (raw 덤프 X).
- 핵심 개념(아래 목록 또는 슬라이드에서 새로 정의된 것)은 \`[[개념명]]\` wikilink로 감싸시오.
- 분량: 200-500자 한국어. 표지/목차/Thank you 같은 비실질 슬라이드는 한 줄로 짧게.${conceptList}${transcriptBlock}`;
}

export class PerSlideCommentaryGenerator {
  constructor(
    private llm: LLMProvider,
    private pdfProcessor: PdfProcessor
  ) {}

  async generate(
    pdfData: ArrayBuffer,
    options: PerSlideGenerationOptions
  ): Promise<PerSlideGenerationResult> {
    if (!this.llm.generateMultimodal) {
      throw new Error(
        `현재 LLM 공급자(${this.llm.name})는 멀티모달 호출을 지원하지 않습니다. Gemini를 사용해주세요.`
      );
    }

    const totalStart = Date.now();
    const pageCount = await this.pdfProcessor.getPageCount(pdfData);
    if (pageCount === 0) {
      return {
        slides: [],
        totalWallTimeMs: 0,
        perSlideWallTimeMs: [],
        errors: [{ slideNum: 0, reason: "PDF has zero pages" }],
      };
    }

    const transcriptChunks = this.splitTranscriptEvenly(options.transcript, pageCount);
    const slides: SlideSection[] = [];
    const errors: PerSlideGenerationResult["errors"] = [];
    const perSlideWallTimeMs: number[] = [];
    const maxWidth = options.maxPngWidth ?? 1024;
    const maxOutputTokens = options.maxOutputTokens ?? 2048;

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const slideStart = Date.now();
      try {
        options.onProgress?.(pageNum, pageCount, "rendering");
        const images = await this.pdfProcessor.renderPagesToImages(
          pdfData,
          [pageNum],
          maxWidth
        );
        if (images.length === 0) {
          errors.push({ slideNum: pageNum, reason: "render returned no image" });
          continue;
        }
        const img: VisionImageRef = images[0];

        options.onProgress?.(pageNum, pageCount, "hashing");
        const hash = await hashSlidePngBase64(img.base64Png);

        options.onProgress?.(pageNum, pageCount, "calling");
        const prompt = buildSlidePrompt(
          pageNum,
          pageCount,
          transcriptChunks[pageNum - 1] ?? null,
          options.existingConceptNames
        );
        const commentary = await this.llm.generateMultimodal!(prompt, [img], {
          systemPrompt: SYSTEM_PROMPT,
          maxOutputTokens,
        });

        slides.push({
          slideNum: pageNum,
          hash,
          commentary: commentary.trim(),
          citedConcepts: this.extractCitedConcepts(
            commentary,
            options.existingConceptNames
          ),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ slideNum: pageNum, reason: msg });
        console.warn(`[Alt2Obsidian] slide ${pageNum} commentary failed: ${msg}`);
      } finally {
        perSlideWallTimeMs.push(Date.now() - slideStart);
        options.onProgress?.(pageNum, pageCount, "done");
      }
    }

    return {
      slides,
      totalWallTimeMs: Date.now() - totalStart,
      perSlideWallTimeMs,
      errors,
    };
  }

  /**
   * Split transcript into N equal-character chunks, one per slide. Even-split
   * is the stop-gap until `RscParser` preserves segment timestamps (then we
   * can do altToNotes-style time-proportional mapping). For now an even split
   * works because the LLM has the slide image as the primary anchor; the
   * transcript chunk provides surrounding-context only.
   */
  private splitTranscriptEvenly(
    transcript: string | null,
    slideCount: number
  ): Array<string | null> {
    if (!transcript || slideCount === 0) {
      return new Array(slideCount).fill(null);
    }
    const chunkSize = Math.ceil(transcript.length / slideCount);
    const chunks: Array<string | null> = [];
    for (let i = 0; i < slideCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, transcript.length);
      const chunk = transcript.slice(start, end).trim();
      chunks.push(chunk.length > 0 ? chunk : null);
    }
    return chunks;
  }

  /**
   * Extract which existing-concept names the LLM cited via wikilinks. The
   * assembler (Task 1.2) does global dedup — wrapping the same concept name
   * everywhere it appears across all sections. So this list is informational,
   * not the source of truth for final wikilinks.
   */
  private extractCitedConcepts(
    commentary: string,
    existingConceptNames: string[]
  ): string[] {
    const cited = new Set<string>();
    const wikiMatches = commentary.match(/\[\[([^\]|#\n]+?)(?:\|[^\]]+)?\]\]/g) ?? [];
    for (const m of wikiMatches) {
      const inner = m.slice(2, -2).split("|")[0].trim();
      if (existingConceptNames.includes(inner)) cited.add(inner);
    }
    return Array.from(cited);
  }
}
