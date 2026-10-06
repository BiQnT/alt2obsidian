// Token usage bookkeeping (spec 5.5). Providers report each call; the import
// pipeline shows the running total in the sidebar, writes it to the note's
// `alt2obs_usage` frontmatter and adds it to the plugin's cumulative totals.

import { EMPTY_USAGE, LLMUsage, ProviderId, UsageTotals } from "../types";

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    imagesSent: a.imagesSent + b.imagesSent,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}

export interface UsageRecord extends LLMUsage {
  provider: ProviderId;
  /** The model as requested ("" = the CLI default, or an alias). */
  model: string;
  /** The id the CLI reported it used ("" when it does not say, e.g. Codex). */
  resolvedModel?: string;
  task: string;
}

export class UsageTracker {
  private records: UsageRecord[] = [];
  private listeners: Array<(total: LLMUsage) => void> = [];
  private recordListeners: Array<(entry: UsageRecord) => void> = [];

  record(entry: UsageRecord): void {
    this.records.push(entry);
    const total = this.total();
    for (const l of this.listeners) l(total);
    for (const l of this.recordListeners) l(entry);
  }

  onChange(listener: (total: LLMUsage) => void): void {
    this.listeners.push(listener);
  }

  /** Called with every call's record (the run panels show the model actually used). */
  onRecord(listener: (entry: UsageRecord) => void): void {
    this.recordListeners.push(listener);
  }

  /**
   * The model a task's calls actually used: the resolved id of its last
   * call, else what was requested ("" = the CLI default). Null when the
   * task made no call.
   */
  modelFor(task: string): string | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.task === task) return r.resolvedModel || r.model;
    }
    return null;
  }

  total(): LLMUsage {
    return this.records.reduce<LLMUsage>((acc, r) => addUsage(acc, r), { ...EMPTY_USAGE });
  }

  byProvider(): Partial<Record<ProviderId, LLMUsage>> {
    const out: Partial<Record<ProviderId, LLMUsage>> = {};
    for (const r of this.records) out[r.provider] = addUsage(out[r.provider] ?? { ...EMPTY_USAGE }, r);
    return out;
  }

  entries(): UsageRecord[] {
    return [...this.records];
  }
}

/** Adds one lecture's usage (or, `countLecture` false, a verification run's) to the plugin-wide totals. */
export function accumulateTotals(totals: UsageTotals, tracker: UsageTracker, today: string, countLecture = true): UsageTotals {
  const byProvider = { ...totals.byProvider };
  for (const [p, u] of Object.entries(tracker.byProvider()) as Array<[ProviderId, LLMUsage]>) {
    byProvider[p] = addUsage(byProvider[p] ?? { ...EMPTY_USAGE }, u);
  }
  return {
    ...addUsage(totals, tracker.total()),
    lectures: totals.lectures + (countLecture ? 1 : 0),
    byProvider,
    since: totals.since || today,
  };
}

/** The models a run used, for the `alt2obs_usage` frontmatter (values as the CLI reported them). */
export interface UsageModels {
  /** The main task's model actually used ("" = unknown, e.g. the Codex default). */
  model?: string;
  effort?: string;
  /** The concept task's model, when it differs from `model`. */
  conceptModel?: string;
}

const yamlString = (v: string) => `"${v.replace(/["\\]/g, "'")}"`;

/** One-line YAML flow mapping for the `alt2obs_usage` frontmatter key. */
export function formatUsageFrontmatter(usage: LLMUsage, providerLabel: string, models: UsageModels = {}): string {
  const extra = [
    models.model ? `model: ${yamlString(models.model)}, ` : "",
    models.effort ? `effort: ${yamlString(models.effort)}, ` : "",
    models.conceptModel && models.conceptModel !== models.model ? `concept_model: ${yamlString(models.conceptModel)}, ` : "",
  ].join("");
  return (
    `alt2obs_usage: {provider: ${yamlString(providerLabel)}, ${extra}calls: ${usage.calls}, ` +
    `input: ${usage.inputTokens}, cached: ${usage.cachedInputTokens}, output: ${usage.outputTokens}, ` +
    `images: ${usage.imagesSent}}`
  );
}

/** "12.3k" style compact number for the sidebar. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
