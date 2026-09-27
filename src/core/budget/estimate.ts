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
 * Per provider, measured with test/smoke-cli.mjs (2026-09-27, claude 2.1.283
 * haiku, codex 0.155.1):
 * - fixedPerTurn: tokens the CLI adds to every model turn (its own
 *   instructions and tool definitions). Claude with our flags: about 2.2k.
 *   Codex: about 18k, most of it Codex's base instructions plus the user's
 *   global ~/.codex/AGENTS.md, which `codex exec` always loads.
 * - schemaTurns / imageTurns: extra model turns per call, each re-sending
 *   the prompt. Claude returns schema output through a tool call (one extra
 *   turn) and reads images with the Read tool (one more); Codex answers in
 *   one turn.
 * - perImage: input tokens of one 1024px JPEG.
 */
export const PROVIDER_COSTS: Record<
  ProviderId,
  { fixedPerTurn: number; schemaTurns: number; imageTurns: number; perImage: number }
> = {
  "claude-cli": { fixedPerTurn: 2200, schemaTurns: 1, imageTurns: 1, perImage: 1100 },
  "codex-cli": { fixedPerTurn: 18000, schemaTurns: 0, imageTurns: 0, perImage: 800 },
  gemini: { fixedPerTurn: 0, schemaTurns: 0, imageTurns: 0, perImage: 260 },
  ollama: { fixedPerTurn: 0, schemaTurns: 0, imageTurns: 0, perImage: 600 },
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
