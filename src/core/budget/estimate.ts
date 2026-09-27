// Pre-run token estimate (spec 5.5). Rough by design: it drives a preview and
// a cap check, not billing. Counts come from the actual prompt strings the
// generator will send, so only the per-token rates are approximations.

import type { ProviderId } from "../../types";

/**
 * Tokens for a text: about 4 ASCII characters per token, and about one
 * token per Hangul or other non-ASCII character (Claude and OpenAI
 * tokenizers both land near 0.8 to 1.1 on Korean lecture text).
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other * 0.9);
}

/**
 * Per provider: fixed tokens every CLI call carries on top of our prompt
 * (tool definitions, CLI instructions), and input tokens per 1024px image.
 * Measured with test/smoke-cli.mjs; see README.
 */
export const PROVIDER_COSTS: Record<ProviderId, { fixedPerCall: number; perImage: number }> = {
  "claude-cli": { fixedPerCall: 0, perImage: 1100 },
  "codex-cli": { fixedPerCall: 0, perImage: 800 },
  gemini: { fixedPerCall: 0, perImage: 260 },
  ollama: { fixedPerCall: 0, perImage: 600 },
};

/** Expected output per generated slide: commentary + gist + JSON keys. */
export const OUTPUT_TOKENS_PER_SLIDE = { content: 420, visual: 620 } as const;
export const OVERVIEW_OUTPUT_TOKENS = 1400;
export const CONCEPTS_OUTPUT_TOKENS = 3800;

export interface CallShape {
  promptText: string;
  images: number;
  outputTokens: number;
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
    input += cost.fixedPerCall + estimateTextTokens(c.promptText) + c.images * cost.perImage;
    output += c.outputTokens;
    images += c.images;
  }
  return { calls: calls.length, inputTokens: input, outputTokens: output, imagesSent: images };
}

/** Over the per-lecture cap? A cap of 0 means no cap. */
export function exceedsCap(estimate: Pick<BudgetEstimate, "inputTokens" | "outputTokens">, cap: number): boolean {
  return cap > 0 && estimate.inputTokens + estimate.outputTokens > cap;
}
