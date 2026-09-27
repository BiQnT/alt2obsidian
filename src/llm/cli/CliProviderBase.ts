// Shared part of the Claude and Codex CLI providers: temp files for images
// and schemas, JSON parsing with one retry, usage reporting, cancel.

import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  EffortLevel,
  ImageInput,
  JsonCallOptions,
  LLMProvider,
  LLMUsage,
  ProviderId,
  TextCallOptions,
  VisionImageRef,
} from "../../types";
import { UsageTracker } from "../usage";
import { EFFORT_LEVELS, isSafeModelName } from "../../settings/llmSettings";
import { CliRunError, removeJobDir } from "./CliRunner";

export interface CliProviderConfig {
  bin: string;
  model: string;
  effort: EffortLevel;
  timeoutMs: number;
  /** Per-job temp folder outside the vault; cwd of every call. */
  workDir: string;
  usage?: UsageTracker;
  /** Task label for usage records ("commentary", "concepts", ...). */
  task?: string;
  /** Job-wide cancel, combined with each call's own signal. */
  signal?: AbortSignal;
  /** Remove `workDir` on dispose(). Default true. */
  ownsWorkDir?: boolean;
}

export interface CliCall {
  prompt: string;
  systemPrompt?: string;
  schema?: Record<string, unknown>;
  images?: ImageInput[];
  signal?: AbortSignal;
}

export interface CliCallResult {
  /** Final assistant text. */
  text: string;
  /** Parsed structured output when the CLI returns it separately (Claude). */
  structured?: unknown;
  usage: LLMUsage;
}

const USAGE_LIMIT = /usage limit|rate.?limit|\b429\b|quota|limit reached|resets? at|too many requests|overloaded/i;
const AUTH_FAILURE = /not logged in|log ?in required|please (run )?(\/)?login|authenticat|unauthori[sz]ed|\b401\b|invalid api key|oauth token/i;

/** Text the CLI itself reported as an error (stderr and its error fields). Model output is never included. */
function cliErrorText(e: unknown): string {
  return e instanceof CliRunError ? `${e.cliError}\n${e.stderr}` : "";
}

/** A subscription or rate limit: retrying now will not help. */
export function isUsageLimitError(e: unknown): boolean {
  return USAGE_LIMIT.test(cliErrorText(e));
}

/**
 * Errors that make the rest of the run pointless (spec 4.2 rule 5, review
 * M3): timeout, missing binary, spawn failure, not logged in, usage limit.
 */
export function isFatalCliError(e: unknown): boolean {
  if (!(e instanceof CliRunError)) return false;
  if (e.kind === "timeout" || e.kind === "not-found" || e.kind === "spawn" || e.kind === "aborted") return true;
  return AUTH_FAILURE.test(cliErrorText(e)) || isUsageLimitError(e);
}

/** Signal that fires when either input fires. `dispose` removes the listeners. */
export function anySignal(a?: AbortSignal, b?: AbortSignal): { signal?: AbortSignal; dispose: () => void } {
  if (!a || !b) return { signal: a ?? b, dispose: () => undefined };
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (a.aborted || b.aborted) ctrl.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return {
    signal: ctrl.signal,
    dispose: () => {
      a.removeEventListener("abort", abort);
      b.removeEventListener("abort", abort);
    },
  };
}

/** Parse a model's JSON answer, tolerating a ```json fence around it. */
export function parseJsonText(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  return JSON.parse(cleaned);
}

let fileCounter = 0;

export abstract class CliProviderBase implements LLMProvider {
  abstract name: string;
  abstract maxInputTokens: number;
  abstract readonly providerId: ProviderId;
  supportsBatch = true;
  /** Codex takes images and the schema as files; Claude gets them inline. */
  protected usesFiles = true;

  constructor(protected config: CliProviderConfig) {
    // Model and effort become argv entries: never let one read as a flag.
    if (!isSafeModelName(config.model)) throw new Error(`모델 이름이 올바르지 않습니다: ${config.model}`);
    if (!EFFORT_LEVELS.includes(config.effort)) throw new Error(`effort 값이 올바르지 않습니다: ${config.effort}`);
  }

  protected abstract invoke(call: CliCall, files: { images: string[]; schema?: string }): Promise<CliCallResult>;

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  get model(): string {
    return this.config.model;
  }

  async generateText(prompt: string, options?: TextCallOptions): Promise<string> {
    const res = await this.call({ prompt, systemPrompt: options?.systemPrompt, signal: options?.signal });
    return res.text.trim();
  }

  async generateMultimodal(prompt: string, images: VisionImageRef[], options?: TextCallOptions): Promise<string> {
    const res = await this.call({
      prompt,
      systemPrompt: options?.systemPrompt,
      signal: options?.signal,
      images: images.map((img) => ({ pageNum: img.pageNum, mimeType: "image/png", base64: img.base64Png })),
    });
    return res.text.trim();
  }

  /**
   * Structured call. The schema is enforced by the CLI; the result is also
   * checked by `validate`. An unparsable or invalid answer is asked for once
   * more (spec 4.2 rule 4); process failures are not retried here.
   */
  async generateJSON<T>(prompt: string, validate: (raw: unknown) => T, options?: JsonCallOptions): Promise<T> {
    let lastError: unknown = null;
    const attempts = Math.max(1, options?.attempts ?? 2);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const res = await this.call({
        prompt,
        systemPrompt: options?.systemPrompt,
        schema: options?.schema,
        images: options?.images,
        signal: options?.signal,
      });
      try {
        const raw = res.structured !== undefined ? res.structured : parseJsonText(res.text);
        return validate(raw);
      } catch (e) {
        lastError = e;
        console.warn(`[Alt2Obsidian] ${this.name}: invalid JSON answer (attempt ${attempt + 1}/${attempts}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${this.name}: JSON 응답을 해석하지 못했습니다`);
  }

  /** One CLI call with temp files written and removed around it. */
  async call(call: CliCall): Promise<CliCallResult> {
    const combined = anySignal(this.config.signal, call.signal);
    const signal = combined.signal;
    if (signal?.aborted) {
      combined.dispose();
      throw new CliRunError("aborted", "취소되었습니다");
    }
    const written: string[] = [];
    try {
      const images = (this.usesFiles ? call.images ?? [] : []).map((img) => {
        const ext = img.mimeType === "image/png" ? "png" : "jpg";
        const path = join(this.config.workDir, `slide-${img.pageNum}-${++fileCounter}.${ext}`);
        writeFileSync(path, Buffer.from(img.base64, "base64"));
        written.push(path);
        return path;
      });
      let schema: string | undefined;
      if (call.schema && this.usesFiles) {
        schema = join(this.config.workDir, `schema-${++fileCounter}.json`);
        writeFileSync(schema, JSON.stringify(call.schema));
        written.push(schema);
      }
      const res = await this.invoke({ ...call, signal }, { images, schema });
      res.usage.imagesSent = (call.images ?? []).length;
      this.config.usage?.record({
        ...res.usage,
        provider: this.providerId,
        model: this.config.model,
        task: this.config.task ?? "",
      });
      return res;
    } finally {
      combined.dispose();
      for (const f of written) {
        try {
          unlinkSync(f);
        } catch {
          // already removed
        }
      }
    }
  }

  dispose(): void {
    if (this.config.ownsWorkDir !== false) removeJobDir(this.config.workDir);
  }
}
