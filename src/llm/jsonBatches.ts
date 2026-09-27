// Batched JSON calls with the Phase 1 retry and stop rules, shared by the
// slide commentary (BatchCommentaryGenerator) and the note verifier:
//
// - Items missing from an answer or failing the checks are asked for once
//   more, together in one call (spec 4.2 rule 4).
// - An answer that is not parsable JSON counts as every item invalid (the
//   same one-time retry), not as a failed call.
// - A failed call (the CLI process failed) is not repeated as is; a
//   timed-out call of several items is tried once more in two halves.
// - A fatal error (missing CLI, not logged in, usage limit) or two failed
//   calls in a row stop the run; the remaining items get the stop reason.

import { CliRunError, isAbortError } from "./cli/CliRunner";
import { isFatalCliError, isUsageLimitError } from "./cli/CliProviderBase";

/** Whole-call failures in a row after which the run stops (review M3). */
export const MAX_CONSECUTIVE_CALL_FAILURES = 2;

export interface JsonBatchProgress {
  batch: number;
  batches: number;
  /** Items with an accepted answer so far. */
  done: number;
  retry: boolean;
}

export interface JsonBatchOptions<I, K, V> {
  batches: I[][];
  key(item: I): K;
  /** One LLM call for these items: the raw parsed JSON. Throws CliRunError when the process failed. */
  call(items: I[]): Promise<unknown>;
  /** Accepted answers by key, and a reason per requested item that failed. */
  check(raw: unknown, items: I[]): { ok: Map<K, V>; failed: Map<K, string> };
  /** Object form of the item noun for stop messages, e.g. "슬라이드를", "주장을". */
  unitObject: string;
  signal?: AbortSignal;
  onProgress?(p: JsonBatchProgress): void;
}

export interface JsonBatchResult<K, V> {
  done: Map<K, V>;
  /** Reason per item without an accepted answer. */
  failures: Map<K, string>;
  /** Keys sent in each call, retries included. */
  calls: K[][];
}

export async function runJsonBatches<I, K, V>(opts: JsonBatchOptions<I, K, V>): Promise<JsonBatchResult<K, V>> {
  const done = new Map<K, V>();
  const failures = new Map<K, string>();
  const calls: K[][] = [];
  let stopReason: string | null = null;
  let consecutiveCallFailures = 0;
  const total = opts.batches.length;

  type CallResult = { kind: "ok"; invalid: Map<K, string> } | { kind: "failed"; timeout: boolean };
  const runCall = async (items: I[]): Promise<CallResult> => {
    calls.push(items.map(opts.key));
    let raw: unknown;
    try {
      raw = await opts.call(items);
    } catch (e) {
      if (isAbortError(e) || opts.signal?.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof CliRunError)) {
        // The CLI answered but not with parsable JSON: every item is invalid.
        consecutiveCallFailures = 0;
        return { kind: "ok", invalid: new Map(items.map((it) => [opts.key(it), `응답 JSON 형식 오류: ${msg.slice(0, 120)}`])) };
      }
      for (const it of items) failures.set(opts.key(it), msg);
      consecutiveCallFailures++;
      if (isFatalCliError(e)) {
        stopReason = isUsageLimitError(e)
          ? `사용 한도에 걸려 남은 ${opts.unitObject} 중단했습니다: ${msg}`
          : `CLI 오류로 남은 ${opts.unitObject} 중단했습니다: ${msg}`;
      } else if (consecutiveCallFailures >= MAX_CONSECUTIVE_CALL_FAILURES) {
        stopReason = `호출이 ${MAX_CONSECUTIVE_CALL_FAILURES}번 연속 실패해 남은 ${opts.unitObject} 중단했습니다: ${msg}`;
      }
      return { kind: "failed", timeout: e.kind === "timeout" };
    }
    consecutiveCallFailures = 0;
    const { ok, failed } = opts.check(raw, items);
    for (const [k, v] of ok) {
      done.set(k, v);
      failures.delete(k);
    }
    return { kind: "ok", invalid: failed };
  };
  const record = (invalid: Map<K, string>) => {
    for (const [k, reason] of invalid) failures.set(k, reason);
  };
  const retryInvalid = async (items: I[], invalid: Map<K, string>, batch: number) => {
    if (invalid.size === 0 || stopReason) {
      record(invalid);
      return;
    }
    opts.onProgress?.({ batch, batches: total, done: done.size, retry: true });
    const retry = await runCall(items.filter((it) => invalid.has(opts.key(it))));
    if (retry.kind === "ok") record(retry.invalid);
  };

  for (let b = 0; b < total; b++) {
    const items = opts.batches[b];
    if (stopReason) {
      for (const it of items) failures.set(opts.key(it), stopReason);
      continue;
    }
    opts.onProgress?.({ batch: b + 1, batches: total, done: done.size, retry: false });
    const first = await runCall(items);
    if (first.kind === "ok") {
      await retryInvalid(items, first.invalid, b + 1);
    } else if (first.timeout && items.length > 1 && !stopReason) {
      // A timed-out batch is tried once more in two halves.
      opts.onProgress?.({ batch: b + 1, batches: total, done: done.size, retry: true });
      const mid = Math.ceil(items.length / 2);
      for (const half of [items.slice(0, mid), items.slice(mid)]) {
        if (stopReason) {
          for (const it of half) failures.set(opts.key(it), stopReason);
          continue;
        }
        const r = await runCall(half);
        if (r.kind === "ok") await retryInvalid(half, r.invalid, b + 1);
      }
    }
  }
  opts.onProgress?.({ batch: total, batches: total, done: done.size, retry: false });
  return { done, failures, calls };
}
