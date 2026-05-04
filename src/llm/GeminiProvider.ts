import { requestUrl } from "obsidian";
import { LLMProvider, VisionImageRef } from "../types";
import { delay } from "../utils/helpers";

export class GeminiProvider implements LLMProvider {
  name = "Gemini";
  maxInputTokens = 1000000;

  private apiKeys: string[];
  private model: string;
  private rateDelayMs: number;
  private currentKeyIdx = 0;
  // Per-key rate limit tracker. Each free-tier key has its OWN RPM window,
  // so we want each key to enforce its own delay independently. Keying by
  // the trimmed key string is fine — apiKeys are unique by definition.
  private lastCallByKey: Map<string, number> = new Map();

  constructor(apiKey: string, model: string, rateDelayMs: number) {
    // Multi-key rotation: comma-separated list of API keys is split and
    // round-robined on 429. Single-key path (no comma) is unchanged.
    // See docs/gemini-rpm-options.md §3.
    this.apiKeys = apiKey
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (this.apiKeys.length === 0) this.apiKeys = [""];
    this.model = model;
    this.rateDelayMs = rateDelayMs;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Run an API operation, rotating to the next configured key on 429
   * (rate-limit) responses. Each key gets one attempt per call. If all
   * keys are exhausted, throws the user-friendly Korean limit message.
   * Non-rate-limit errors bubble up immediately with the first key —
   * a 401 on key #1 means key #1 is bad, not that the rest will work.
   */
  private async tryWithKeyRotation<T>(
    op: (key: string) => Promise<T>,
    label: string
  ): Promise<T> {
    if (this.apiKeys.length <= 1) {
      const key = this.apiKeys[0] ?? "";
      await this.waitForRateLimit(key);
      return await op(key);
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.apiKeys.length; attempt++) {
      const key = this.apiKeys[this.currentKeyIdx];
      try {
        await this.waitForRateLimit(key);
        return await op(key);
      } catch (e: unknown) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        const isRateLimit =
          msg.includes("429") ||
          msg.includes("RESOURCE_EXHAUSTED") ||
          msg.includes("한도 초과");
        if (!isRateLimit) throw e; // 401/403/404/etc — surface immediately
        console.warn(
          `[Alt2Obsidian] Gemini key #${this.currentKeyIdx + 1}/${this.apiKeys.length} hit 429 on ${label}, rotating to next key.`
        );
        this.currentKeyIdx = (this.currentKeyIdx + 1) % this.apiKeys.length;
      }
    }
    console.error(
      `[Alt2Obsidian] All ${this.apiKeys.length} Gemini keys exhausted on ${label}.`
    );
    throw new Error(
      `모든 API 키 (${this.apiKeys.length}개) 가 한도 초과 상태입니다. 잠시 후 재시도하거나 추가 키를 등록해주세요. (마지막 에러: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      })`
    );
  }

  async generateText(
    prompt: string,
    options?: { systemPrompt?: string; maxOutputTokens?: number }
  ): Promise<string> {
    return this.tryWithKeyRotation(async (key) => {
      const body: Record<string, unknown> = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: options?.maxOutputTokens || 8192,
        },
      };
      if (options?.systemPrompt) {
        body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${key}`;
      try {
        console.log(`[Alt2Obsidian] Gemini request: model=${this.model}`);
        const response = await requestUrl({
          url,
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
          // Re-throw with 429 in message so tryWithKeyRotation can detect.
          throw new Error(`429 요청 한도 초과: ${msg}`);
        }
        if (msg.includes("404")) {
          throw new Error(`모델 "${this.model}"을(를) 찾을 수 없습니다. 설정에서 모델명을 확인해주세요.`);
        }
        throw new Error(`LLM 요청 실패: ${msg}`);
      }
    }, "generateText");
  }

  async generateMultimodal(
    prompt: string,
    images: VisionImageRef[],
    options?: { systemPrompt?: string; maxOutputTokens?: number }
  ): Promise<string> {
    return this.tryWithKeyRotation(async (key) => {
      const parts: Array<Record<string, unknown>> = [{ text: prompt }];
      for (const img of images) {
        parts.push({ inlineData: { mimeType: "image/png", data: img.base64Png } });
      }
      const body: Record<string, unknown> = {
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: options?.maxOutputTokens || 4096 },
      };
      if (options?.systemPrompt) {
        body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${key}`;
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
          throw new Error(`429 요청 한도 초과: ${msg}`);
        }
        if (msg.includes("404")) {
          throw new Error(`모델 "${this.model}"을(를) 찾을 수 없습니다.`);
        }
        throw new Error(`LLM 멀티모달 요청 실패: ${msg}`);
      }
    }, "generateMultimodal");
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

  private async waitForRateLimit(key: string): Promise<void> {
    const now = Date.now();
    const last = this.lastCallByKey.get(key) ?? 0;
    const elapsed = now - last;
    if (elapsed < this.rateDelayMs) {
      await delay(this.rateDelayMs - elapsed);
    }
    this.lastCallByKey.set(key, Date.now());
  }
}
