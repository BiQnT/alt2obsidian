import { LLMProvider } from "../types";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAIProvider } from "./OpenAIProvider";
import { ClaudeProvider } from "./ClaudeProvider";
import { OllamaProvider } from "./OllamaProvider";

export interface CreateProviderOptions {
  /** Used by Ollama provider only. */
  ollamaEndpoint?: string;
  /** Used by Ollama provider only. */
  ollamaModel?: string;
}

export function createProvider(
  type: string,
  apiKey: string,
  model?: string,
  rateDelayMs = 4000,
  options: CreateProviderOptions = {}
): LLMProvider {
  switch (type) {
    case "gemini":
      return new GeminiProvider(apiKey, model || "gemini-2.5-flash", rateDelayMs);
    case "openai":
      return new OpenAIProvider(apiKey, model);
    case "claude":
      return new ClaudeProvider(apiKey, model);
    case "ollama":
      return new OllamaProvider(
        options.ollamaEndpoint || "http://localhost:11434",
        options.ollamaModel || "gemma3:4b"
      );
    default:
      throw new Error(`Unknown LLM provider: ${type}`);
  }
}
