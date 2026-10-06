// Per-slide commentary prompt of the alt2obs Skill (one slide image per
// turn, Claude Code's own vision). The plugin uses the batch prompts
// (src/generator/BatchCommentaryGenerator.ts); both share the same writing
// rules (test/test-skill-prompts.mjs checks the rule block is identical).
// Rendered for the Skill by scripts/phase2/slide-prompt.mjs.

import { renderPrompt } from "./render";
import slideCommentarySystemTemplate from "../../prompts/slide-commentary.system.md";
import slideCommentaryUserTemplate from "../../prompts/slide-commentary.user.md";

export function buildSlideSystemPrompt(): string {
  return renderPrompt(slideCommentarySystemTemplate, {});
}

/**
 * The user prompt for slide `slideNum`. The two optional fragments keep the
 * 1.1.0 format: the existing concept names (first 100) and the slide's
 * transcript chunk, each after a blank line; empty when there is nothing.
 */
export function buildSlidePrompt(
  slideNum: number,
  totalSlides: number,
  transcriptChunk: string | null,
  existingConceptNames: string[]
): string {
  const conceptList =
    existingConceptNames.length > 0
      ? `\n\n[기존 개념 목록 (같은 의미면 이 이름을 그대로 쓰시오. 새 개념은 새 이름으로 도입 가능)]\n${existingConceptNames.slice(0, 100).join(", ")}`
      : "";
  const transcriptBlock =
    transcriptChunk && transcriptChunk.trim()
      ? `\n\n[해당 구간 음성 전사 (참고용. 그대로 붙여넣지 말고 교수님이 강조한 점만 골라 쓰시오)]\n${transcriptChunk.trim()}`
      : "";
  return renderPrompt(slideCommentaryUserTemplate, { slideNum, totalSlides, conceptList, transcriptBlock });
}
