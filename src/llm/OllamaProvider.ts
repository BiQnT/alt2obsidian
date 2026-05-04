import { requestUrl } from "obsidian";
import { LLMProvider, VisionImageRef } from "../types";

interface OllamaChatResponse {
  message?: { content?: string };
  done?: boolean;
}

export class OllamaProvider implements LLMProvider {
  name = "Ollama";
  maxInputTokens = 8192;

  private endpoint: string;
  private model: string;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, "") || "http://localhost:11434";
    this.model = model || "gemma3:4b";
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async generateText(
    prompt: string,
    options?: { systemPrompt?: string; maxOutputTokens?: number }
  ): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: options?.maxOutputTokens
        ? { num_predict: options.maxOutputTokens }
        : undefined,
    };

    return this.requestChat(body);
  }

  async generateMultimodal(
    prompt: string,
    images: VisionImageRef[],
    options?: { systemPrompt?: string; maxOutputTokens?: number }
  ): Promise<string> {
    const messages: Array<{
      role: string;
      content: string;
      images?: string[];
    }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({
      role: "user",
      content: prompt,
      images: images.map((img) => img.base64Png),
    });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: options?.maxOutputTokens
        ? { num_predict: options.maxOutputTokens }
        : undefined,
    };

    console.log(
      `[Alt2Obsidian] Ollama multimodal request: model=${this.model}, images=${images.length}`
    );
    return this.requestChat(body, true);
  }

  async generateJSON<T>(
    prompt: string,
    validate: (raw: unknown) => T,
    options?: { systemPrompt?: string }
  ): Promise<T> {
    const messages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({
      role: "user",
      content: `${prompt}\n\nIMPORTANT: Respond with valid JSON only. No markdown code blocks, no explanation.`,
    });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      format: "json",
    };

    const maxRetries = 2;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const text = await this.requestChat(body);
      try {
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
            `[Alt2Obsidian] Ollama JSON validation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`
          );
        }
      }
    }
    throw lastError || new Error("Ollama JSON generation failed after retries");
  }

  private async requestChat(
    body: Record<string, unknown>,
    isMultimodal = false
  ): Promise<string> {
    const url = `${this.endpoint}/api/chat`;
    try {
      if (!isMultimodal) {
        console.log(
          `[Alt2Obsidian] Ollama request: endpoint=${this.endpoint}, model=${this.model}`
        );
      }

      const response = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = response.json as OllamaChatResponse;
      const content = data?.message?.content;
      if (!content || typeof content !== "string") {
        console.error(
          "[Alt2Obsidian] Ollama response:",
          JSON.stringify(data).slice(0, 500)
        );
        throw new Error("Ollama에서 응답을 받지 못했습니다");
      }
      return content;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Alt2Obsidian] Ollama error: ${msg}`);
      if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
        throw new Error(
          `Ollama 서버에 연결할 수 없습니다 (${this.endpoint}). 'ollama serve'가 실행 중인지 확인해주세요.`
        );
      }
      if (msg.includes("404")) {
        throw new Error(
          `Ollama 모델 "${this.model}"을(를) 찾을 수 없습니다. 'ollama pull ${this.model}'을 먼저 실행해주세요.`
        );
      }
      if (
        isMultimodal &&
        (msg.includes("does not support") ||
          msg.includes("image") ||
          msg.includes("multimodal") ||
          msg.includes("vision"))
      ) {
        throw new Error(
          `Ollama 모델 "${this.model}"이(가) 이미지 입력을 지원하지 않습니다. 멀티모달 모델(예: gemma3:4b, gemma3:12b, llava)로 변경해주세요.`
        );
      }
      throw new Error(`Ollama 요청 실패: ${msg}`);
    }
  }
}
