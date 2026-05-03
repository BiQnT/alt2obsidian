import { requestUrl } from "obsidian";
import { LLMProvider, VisionImageRef } from "../types";
import { delay } from "../utils/helpers";

export class GeminiProvider implements LLMProvider {
  name = "Gemini";
  maxInputTokens = 1000000;

  private apiKey: string;
  private model: string;
  private rateDelayMs: number;
  private lastCallTime = 0;

  constructor(apiKey: string, model: string, rateDelayMs: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.rateDelayMs = rateDelayMs;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async generateText(
    prompt: string,
    options?: { systemPrompt?: string; maxOutputTokens?: number }
  ): Promise<string> {
    await this.waitForRateLimit();

    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: options?.maxOutputTokens || 8192,
      },
    };

    if (options?.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: options.systemPrompt }],
      };
    }

    // Use query parameter for API key (most reliable across Obsidian versions)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    try {
      console.log(`[Alt2Obsidian] Gemini request: model=${this.model}`);

      const response = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = response.json;
      const candidate = data?.candidates?.[0];
      if (!candidate?.content?.parts?.[0]?.text) {
        console.error("[Alt2Obsidian] Gemini response:", JSON.stringify(data).slice(0, 500));
        throw new Error("Gemini에서 응답을 받지 못했습니다");
      }
      return candidate.content.parts[0].text;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Alt2Obsidian] Gemini error: ${msg}`);
      if (msg.includes("401") || msg.includes("403")) {
        throw new Error("API 키를 확인해주세요");
      }
      if (msg.includes("429")) {
        throw new Error("요청 한도 초과 — 잠시 후 재시도합니다");
      }
      if (msg.includes("404")) {
        throw new Error(`모델 "${this.model}"을(를) 찾을 수 없습니다. 설정에서 모델명을 확인해주세요.`);
      }
      throw new Error(`LLM 요청 실패: ${msg}`);
    }
  }

  async generateMultimodal(
    prompt: string,
    images: VisionImageRef[],
    options?: { systemPrompt?: string; maxOutputTokens?: number }
  ): Promise<string> {
    await this.waitForRateLimit();

    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const img of images) {
      parts.push({
        inlineData: { mimeType: "image/png", data: img.base64Png },
      });
    }

    const body: Record<string, unknown> = {
      contents: [{ parts }],
      generationConfig: {
        maxOutputTokens: options?.maxOutputTokens || 4096,
      },
    };

    if (options?.systemPrompt) {
      body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    try {
      const response = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = response.json;
      const candidate = data?.candidates?.[0];
      if (!candidate?.content?.parts?.[0]?.text) {
        console.error(
          "[Alt2Obsidian] Gemini multimodal response:",
          JSON.stringify(data).slice(0, 500)
        );
        throw new Error("Gemini에서 응답을 받지 못했습니다");
      }
      return candidate.content.parts[0].text;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Alt2Obsidian] Gemini multimodal error: ${msg}`);
      if (msg.includes("401") || msg.includes("403")) {
        throw new Error("API 키를 확인해주세요");
      }
      if (msg.includes("429")) {
        throw new Error("요청 한도 초과 — 잠시 후 재시도합니다");
      }
      if (msg.includes("404")) {
        throw new Error(`모델 "${this.model}"을(를) 찾을 수 없습니다.`);
      }
      throw new Error(`LLM 멀티모달 요청 실패: ${msg}`);
    }
  }

  async generateJSON<T>(
    prompt: string,
    validate: (raw: unknown) => T,
    options?: { systemPrompt?: string }
  ): Promise<T> {
    const jsonPrompt = `${prompt}\n\nIMPORTANT: Respond with valid JSON only. No markdown code blocks, no explanation.`;

    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const text = await this.generateText(jsonPrompt, options);

      try {
        // Strip markdown code blocks if present
        const cleaned = text
          .replace(/^```(?:json)?\s*\n?/m, "")
          .replace(/\n?```\s*$/m, "")
          .trim();
        const parsed = JSON.parse(cleaned);
        return validate(parsed);
      } catch (e) {
        lastError =
          e instanceof Error ? e : new Error("JSON parse/validation failed");
        if (attempt < maxRetries) {
          console.warn(
            `[Alt2Obsidian] JSON validation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`
          );
        }
      }
    }

    throw lastError || new Error("JSON generation failed after retries");
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.rateDelayMs) {
      await delay(this.rateDelayMs - elapsed);
    }
    this.lastCallTime = Date.now();
  }
}
