// Pre-run token estimate (spec 5.5). Rough by design: it drives a preview and
// a cap check, not billing. Counts come from the actual prompt strings the
// generator will send, so only the per-token rates are approximations.

import type { ProviderId } from "../../types";

/**
 * Tokens for a text: about 2 ASCII characters per token and about 0.9
 * tokens per Hangul or other non-ASCII character. Fitted on two real Claude
 * calls (2026-09-28): a 4-slide batch of pdfjs slide text (4,246 ASCII +
 * 705 other characters, 3,239 input tokens) and the tiny smoke call. Slide
 * text from pdfjs is full of runs of spaces and symbols, so English does
 * not reach the usual 4 characters per token.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 2 + other * 0.9);
}

/**
 * Per provider, measured with test/smoke-cli.mjs (2026-09-28, claude 2.1.283
 * haiku, codex 0.155.1):
 * - fixedPerTurn: tokens the CLI adds to every model turn (its own
 *   instructions). Claude with stream-json input, tools off, own system
 *   prompt: about 0.3k (fitted together with the text rate above). Codex with the trim config: about 11.9k, most of it Codex's base
 *   instructions plus the user's global ~/.codex/AGENTS.md, which has no
 *   documented off switch (it was 18.3k before the trim config).
 * - schemaTurns / imageTurns: extra model turns per call. Both are 0 now:
 *   Claude gets images inline and the JSON format in the prompt (one turn),
 *   Codex answers --output-schema in one turn.
 * - perImage: input tokens of one 1024x768 JPEG, measured on 4 real slides
 *   (02-What-is-OS pages 2, 3, 8, 13): Claude 1,053 per image (7,450 with
 *   images minus 3,239 without, over 4). Codex about 1,750 per image
 *   (21,466 for the same batch; its text-only baseline was estimated, not
 *   measured, so this one is less certain).
 */
export const PROVIDER_COSTS: Record<
  ProviderId,
  { fixedPerTurn: number; schemaTurns: number; imageTurns: number; perImage: number }
> = {
  "claude-cli": { fixedPerTurn: 300, schemaTurns: 0, imageTurns: 0, perImage: 1060 },
  "codex-cli": { fixedPerTurn: 11900, schemaTurns: 0, imageTurns: 0, perImage: 1750 },
};

/** Expected output per generated slide: commentary + gist + JSON keys. */
export const OUTPUT_TOKENS_PER_SLIDE = { content: 420, visual: 620 } as const;
export const OVERVIEW_OUTPUT_TOKENS = 1400;
export const CONCEPTS_OUTPUT_TOKENS = 3800;

export interface CallShape {
  promptText: string;
  images: number;
  outputTokens: number;
  /** Structured (schema) answer. */
  schema: boolean;
}

export interface BudgetEstimate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  imagesSent: number;
  slidesTotal: number;
  slidesGenerated: number;
  slidesTemplated: number;
  slidesDeduped: number;
  slidesReused: number;
}

export function estimateCalls(
  calls: CallShape[],
  provider: ProviderId
): Pick<BudgetEstimate, "calls" | "inputTokens" | "outputTokens" | "imagesSent"> {
  const cost = PROVIDER_COSTS[provider];
  let input = 0;
  let output = 0;
  let images = 0;
  for (const c of calls) {
    const turns = 1 + (c.schema ? cost.schemaTurns : 0) + (c.images > 0 ? cost.imageTurns : 0);
    input += turns * (cost.fixedPerTurn + estimateTextTokens(c.promptText)) + c.images * cost.perImage;
    output += c.outputTokens;
    images += c.images;
  }
  return { calls: calls.length, inputTokens: input, outputTokens: output, imagesSent: images };
}

/** Over the per-lecture cap? A cap of 0 means no cap. */
export function exceedsCap(estimate: Pick<BudgetEstimate, "inputTokens" | "outputTokens">, cap: number): boolean {
  return cap > 0 && estimate.inputTokens + estimate.outputTokens > cap;
}
