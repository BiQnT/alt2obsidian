// Note verification (spec 4.6): the user's own notes checked against the
// lecture's slides and aligned transcript. No obsidian import: the plugin,
// the Skill CLI (scripts/phase2/verify-prep.mjs) and the acceptance eval run
// this same code.
//
//   1. claims       script: sentences and bullets of the note
//   2. evidence     script: BM25 top 2 slides + top 2 transcript chunks
//                   per claim; no shared term at all = "근거 없음" without
//                   a call; likely-true claims go last in the batches
//   3. judgment     LLM: 20 claims with their own evidence per call,
//                   verdict + short reason (src/llm/jsonBatches.ts rules)
//   4. missing      script + one LLM call: slides no claim covers, titles
//                   and key sentences only, the model picks "누락 후보"
//   5. output       Verification/<lecture> verification.md; the user's
//                   note is never modified

import { LLMProvider, ProviderId } from "../types";
import { renderPrompt } from "../prompts/render";
import { runJsonBatches } from "../llm/jsonBatches";
import { isAbortError } from "../llm/cli/CliRunner";
import { estimateCalls } from "../core/budget/estimate";
import { StoredSpan, TimedSegment } from "../core/prep/TranscriptAligner";
import { Claim, splitClaims } from "./claims";
import { buildEvidenceIndex, ClaimEvidence, findEvidence, transcriptChunks, UncoveredSlide, uncoveredSlides } from "./evidence";
import systemTemplate from "../../prompts/note-verify.system.md";
import userTemplate from "../../prompts/note-verify.user.md";
import claimTemplate from "../../prompts/note-verify.claim.md";
import missingTemplate from "../../prompts/note-verify-missing.md";

export const VERDICTS = ["맞음", "틀림", "근거 없음", "전사 불확실"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const MISSING_LABEL = "누락 후보";
export const CLAIMS_PER_CALL = 20;
/** Expected output tokens per judged claim (id, verdict, a short reason) and for the missing call. */
export const OUTPUT_TOKENS_PER_CLAIM = 55;
export const MISSING_OUTPUT_TOKENS = 400;
const REASON_MAX = 120;

export interface VerifyInput {
  /** Lecture note name (link target of `[[<lecture>#📚 슬라이드 N]]`). */
  lecture: string;
  noteMarkdown: string;
  /** Page texts, index 0 = slide 1. */
  slideTexts: string[];
  /** Timestamped transcript and the note's stored alignment, when known. */
  transcript?: { segments: TimedSegment[]; spans: StoredSpan[] | null } | null;
}

export interface VerifyPlan {
  lecture: string;
  claims: ClaimEvidence[];
  /** Claims sent to the LLM, likely-true ones last. */
  judged: ClaimEvidence[];
  batches: ClaimEvidence[][];
  /** Claims with no evidence at all (script verdict "근거 없음"). */
  unsupported: ClaimEvidence[];
  uncovered: UncoveredSlide[];
  hasTranscript: boolean;
}

export function planVerification(input: VerifyInput, perCall = CLAIMS_PER_CALL): VerifyPlan {
  const claims = splitClaims(input.noteMarkdown);
  const chunks = input.transcript ? transcriptChunks(input.transcript.segments, input.transcript.spans) : [];
  const index = buildEvidenceIndex(input.slideTexts, chunks);
  const evidence = claims.map((c) => findEvidence(c, index));
  const unsupported = evidence.filter((e) => e.noEvidence);
  const judged = [...evidence.filter((e) => !e.noEvidence && !e.likelyTrue), ...evidence.filter((e) => !e.noEvidence && e.likelyTrue)];
  const batches: ClaimEvidence[][] = [];
  for (let i = 0; i < judged.length; i += perCall) batches.push(judged.slice(i, i + perCall));
  return {
    lecture: input.lecture,
    claims: evidence,
    judged,
    batches,
    unsupported,
    uncovered: uncoveredSlides(input.slideTexts, evidence),
    hasTranscript: chunks.length > 0,
  };
}

// ---- prompts ----

/** "12:03", or "1:02:03" past an hour. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ms2 = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return h > 0 ? `${h}:${ms2}` : ms2;
}

export function buildJudgeSystemPrompt(): string {
  return renderPrompt(systemTemplate, {});
}

function claimBlock(e: ClaimEvidence): string {
  const lines = [
    ...e.slides.map((h) => `- 슬라이드 ${h.slide}: ${h.excerpt}`),
    ...e.transcript.map((h) => `- 전사 [${formatTimestamp(h.startMs)}]${h.slide ? ` (슬라이드 ${h.slide} 구간)` : ""}: ${h.excerpt}`),
  ];
  return renderPrompt(claimTemplate, { id: e.claim.id, claim: e.claim.text, evidence: lines.join("\n") || "- (없음)" });
}

export function buildJudgePrompt(lecture: string, batch: ClaimEvidence[]): string {
  return renderPrompt(userTemplate, {
    title: lecture,
    claimCount: batch.length,
    idList: batch.map((e) => e.claim.id).join(", "),
    claimBlocks: batch.map(claimBlock).join("\n\n"),
  });
}

export function buildMissingPrompt(plan: VerifyPlan): string | null {
  if (plan.uncovered.length === 0) return null;
  const slides = plan.uncovered.map((u) => `- 슬라이드 ${u.slide}: ${u.title || "(제목 없음)"}${u.keySentences ? ` / ${u.keySentences}` : ""}`).join("\n");
  return renderPrompt(missingTemplate, { title: plan.lecture, slides });
}

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "v", "r"],
        properties: {
          id: { type: "integer", description: "주장 번호" },
          v: { type: "string", enum: [...VERDICTS] },
          r: { type: "string", description: "이유, 60자 이내" },
        },
      },
    },
  },
};

export const MISSING_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["missing"],
  properties: {
    missing: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["s", "r"],
        properties: { s: { type: "integer", description: "슬라이드 번호" }, r: { type: "string" } },
      },
    },
  },
};

// ---- estimate ----

export interface VerifyEstimate {
  claims: number;
  judged: number;
  /** Claims decided by the script ("근거 없음", no shared term). */
  scriptOnly: number;
  likelyTrue: number;
  uncoveredSlides: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Pre-run estimate from the exact prompts (spec 5.5). Evidence retrieval itself costs no tokens. */
export function estimateVerification(plan: VerifyPlan, provider: ProviderId): VerifyEstimate {
  const system = buildJudgeSystemPrompt();
  const shapes = plan.batches.map((b) => ({
    promptText: system + buildJudgePrompt(plan.lecture, b) + JSON.stringify(JUDGE_SCHEMA),
    images: 0,
    schema: true,
    outputTokens: b.length * OUTPUT_TOKENS_PER_CLAIM,
  }));
  const missing = buildMissingPrompt(plan);
  if (missing) shapes.push({ promptText: missing + JSON.stringify(MISSING_SCHEMA), images: 0, schema: true, outputTokens: MISSING_OUTPUT_TOKENS });
  const e = estimateCalls(shapes, provider);
  return {
    claims: plan.claims.length,
    judged: plan.judged.length,
    scriptOnly: plan.unsupported.length,
    likelyTrue: plan.judged.filter((c) => c.likelyTrue).length,
    uncoveredSlides: plan.uncovered.length,
    calls: e.calls,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
  };
}

// ---- run ----

export interface VerifiedClaim {
  evidence: ClaimEvidence;
  /** null: no verdict (the call failed or the run stopped). */
  verdict: Verdict | null;
  reason: string;
  /** Decided by the script, not the model. */
  byScript: boolean;
}

export interface MissingCandidate {
  slide: number;
  title: string;
  reason: string;
}

export interface VerifyResult {
  lecture: string;
  items: VerifiedClaim[];
  missing: MissingCandidate[];
  warnings: string[];
}

export interface VerifyProgress {
  batch: number;
  batches: number;
  judged: number;
  total: number;
  retry: boolean;
  step: "judge" | "missing";
}

interface JudgeItem {
  v: Verdict;
  r: string;
}

/** Accepted verdicts by claim id, and a reason per requested claim that failed. */
export function checkJudgeAnswer(raw: unknown, batch: ClaimEvidence[]): { ok: Map<number, JudgeItem>; failed: Map<number, string> } {
  const ok = new Map<number, JudgeItem>();
  const failed = new Map<number, string>();
  const items = (raw as { results?: unknown })?.results;
  const byId = new Map<number, { v?: unknown; r?: unknown }>();
  if (Array.isArray(items)) {
    for (const it of items) {
      const id = Number((it as { id?: unknown })?.id);
      if (Number.isInteger(id) && !byId.has(id)) byId.set(id, it as { v?: unknown; r?: unknown });
    }
  }
  for (const e of batch) {
    const it = byId.get(e.claim.id);
    if (!it) {
      failed.set(e.claim.id, Array.isArray(items) ? "응답에 이 주장이 없음" : "응답 JSON 형식 오류");
      continue;
    }
    const v = typeof it.v === "string" ? it.v.trim() : "";
    if (!(VERDICTS as readonly string[]).includes(v)) {
      failed.set(e.claim.id, `판정 값이 올바르지 않음 (${String(it.v).slice(0, 20)})`);
      continue;
    }
    const r = typeof it.r === "string" ? it.r.replace(/\s+/g, " ").trim() : "";
    ok.set(e.claim.id, { v: v as Verdict, r: r.length > REASON_MAX ? `${r.slice(0, REASON_MAX - 3)}...` : r });
  }
  return { ok, failed };
}

export async function runVerification(
  plan: VerifyPlan,
  llm: LLMProvider,
  opts: { signal?: AbortSignal; onProgress?(p: VerifyProgress): void } = {}
): Promise<VerifyResult> {
  const warnings: string[] = [];
  const system = buildJudgeSystemPrompt();
  const { done, failures } = await runJsonBatches<ClaimEvidence, number, JudgeItem>({
    batches: plan.batches,
    key: (e) => e.claim.id,
    unitObject: "주장을",
    signal: opts.signal,
    call: (batch) =>
      llm.generateJSON(buildJudgePrompt(plan.lecture, batch), (r) => r, {
        systemPrompt: system,
        schema: JUDGE_SCHEMA,
        signal: opts.signal,
        attempts: 1,
        timeoutScale: Math.max(1, batch.length / CLAIMS_PER_CALL),
      }),
    check: checkJudgeAnswer,
    onProgress: (p) =>
      opts.onProgress?.({ batch: p.batch, batches: p.batches, judged: p.done, total: plan.judged.length, retry: p.retry, step: "judge" }),
  });

  let missing: MissingCandidate[] = [];
  const missingPrompt = buildMissingPrompt(plan);
  if (missingPrompt) {
    opts.onProgress?.({ batch: plan.batches.length, batches: plan.batches.length, judged: done.size, total: plan.judged.length, retry: false, step: "missing" });
    try {
      missing = await llm.generateJSON(missingPrompt, (raw) => checkMissingAnswer(raw, plan), { schema: MISSING_SCHEMA, signal: opts.signal });
    } catch (e) {
      if (isAbortError(e) || opts.signal?.aborted) throw e;
      warnings.push(`누락 탐지 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return assembleResult(plan, done, failures, missing, warnings);
}

/** Missing candidates from an answer: only slides that were offered, once each, in deck order. */
export function checkMissingAnswer(raw: unknown, plan: VerifyPlan): MissingCandidate[] {
  const list = (raw as { missing?: unknown })?.missing;
  if (!Array.isArray(list)) throw new Error("missing 배열이 없음");
  const allowed = new Map(plan.uncovered.map((u) => [u.slide, u]));
  const out: MissingCandidate[] = [];
  for (const it of list as Array<{ s?: unknown; r?: unknown }>) {
    const u = allowed.get(Number(it?.s));
    if (!u || out.some((o) => o.slide === u.slide)) continue;
    out.push({ slide: u.slide, title: u.title, reason: typeof it.r === "string" ? it.r.trim().slice(0, REASON_MAX) : "" });
  }
  return out.sort((a, b) => a.slide - b.slide);
}

/** Verdict per claim: the script's, the model's, or none with the failure reason. */
function assembleResult(plan: VerifyPlan, done: Map<number, JudgeItem>, failures: Map<number, string>, missing: MissingCandidate[], warnings: string[]): VerifyResult {
  const items: VerifiedClaim[] = plan.claims.map((e) => {
    if (e.noEvidence) return { evidence: e, verdict: "근거 없음", reason: "슬라이드와 전사에서 겹치는 용어를 찾지 못했습니다 (스크립트 판정).", byScript: true };
    const d = done.get(e.claim.id);
    if (d) return { evidence: e, verdict: d.v, reason: d.r, byScript: false };
    return { evidence: e, verdict: null, reason: failures.get(e.claim.id) ?? "응답에 이 주장이 없음", byScript: false };
  });
  const failedCount = items.filter((i) => i.verdict === null).length;
  const out = [...warnings];
  if (failedCount > 0) out.push(`주장 ${failedCount}개는 판정하지 못했습니다.`);
  return { lecture: plan.lecture, items, missing, warnings: out };
}

/**
 * Result from answers produced elsewhere (the Skill judges the same batch
 * prompts in its own session): every `{"results":[...]}` answer is checked
 * like a plugin answer; claims without a valid verdict are reported.
 */
export function resultFromAnswers(plan: VerifyPlan, answers: unknown[], missingAnswer?: unknown): VerifyResult {
  const done = new Map<number, JudgeItem>();
  const failures = new Map<number, string>();
  for (const batch of plan.batches) {
    for (const raw of answers) {
      const { ok } = checkJudgeAnswer(raw, batch);
      for (const [id, item] of ok) if (!done.has(id)) done.set(id, item);
    }
    for (const e of batch) if (!done.has(e.claim.id)) failures.set(e.claim.id, "답에 이 주장이 없음");
  }
  const warnings: string[] = [];
  let missing: MissingCandidate[] = [];
  if (missingAnswer !== undefined) {
    try {
      missing = checkMissingAnswer(missingAnswer, plan);
    } catch (e) {
      warnings.push(`누락 탐지 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return assembleResult(plan, done, failures, missing, warnings);
}

// ---- output note ----

export const VERIFY_BLOCK_START = "<!-- alt2obs:verify start -->";
export const VERIFY_BLOCK_END = "<!-- alt2obs:verify end -->";

const SECTIONS: Array<{ key: Verdict | "failed"; icon: string; callout: string; fold: boolean }> = [
  { key: "틀림", icon: "❌", callout: "failure", fold: false },
  { key: "전사 불확실", icon: "🎙️", callout: "warning", fold: false },
  { key: "근거 없음", icon: "❔", callout: "question", fold: false },
  { key: "failed", icon: "⚠️", callout: "bug", fold: false },
  { key: "맞음", icon: "✅", callout: "success", fold: true },
];

export function verdictCounts(result: VerifyResult): Record<Verdict | "failed" | "missing", number> {
  const counts = { 맞음: 0, 틀림: 0, "근거 없음": 0, "전사 불확실": 0, failed: 0, missing: result.missing.length } as Record<Verdict | "failed" | "missing", number>;
  for (const it of result.items) counts[it.verdict ?? "failed"]++;
  return counts;
}

function slideLink(lecture: string, slide: number): string {
  return `[[${lecture}#📚 슬라이드 ${slide}]]`;
}

function evidenceLinks(lecture: string, e: ClaimEvidence): string {
  const parts = e.slides.map((h) => slideLink(lecture, h.slide));
  for (const t of e.transcript) parts.push(`[${formatTimestamp(t.startMs)}]${t.slide ? ` (슬라이드 ${t.slide})` : ""}`);
  return parts.join(" · ");
}

/** Quote safe inside a callout: one line, no leading callout syntax. */
function quote(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^\[!/, "[\\!").trim();
}

export interface VerificationMeta {
  /** Where the checked note came from, shown in the header ("[[my note]]", a Notion URL, "붙여넣기"). */
  source: string;
  date: string;
  /** Frontmatter line `alt2obs_usage: {...}` or null. */
  usageLine: string | null;
  model: string;
}

export function renderVerificationNote(result: VerifyResult, meta: VerificationMeta): string {
  const c = verdictCounts(result);
  const lecture = result.lecture;
  const fm = [
    "---",
    `lecture: ${JSON.stringify(`[[${lecture}]]`)}`,
    `verified_source: ${JSON.stringify(meta.source)}`,
    `date: "${meta.date}"`,
    `source: "alt2obsidian-verify"`,
    `claims: ${result.items.length}`,
    `verdicts: {"맞음": ${c["맞음"]}, "틀림": ${c["틀림"]}, "근거 없음": ${c["근거 없음"]}, "전사 불확실": ${c["전사 불확실"]}, "누락 후보": ${c.missing}}`,
    ...(meta.usageLine ? [meta.usageLine] : []),
    "---",
    "",
  ];
  const body: string[] = [
    `# ${lecture} 검증`,
    "",
    VERIFY_BLOCK_START,
    `> [!abstract] 판정 요약`,
    `> 맞음 ${c["맞음"]} · 틀림 ${c["틀림"]} · 근거 없음 ${c["근거 없음"]} · 전사 불확실 ${c["전사 불확실"]} · 누락 후보 ${c.missing}${c.failed ? ` · 판정 실패 ${c.failed}` : ""}`,
    `> 대상 노트: ${meta.source} · 강의: [[${lecture}]] · ${meta.model} · ${meta.date}`,
    "> 근거 검색은 스크립트로 했고, 판정만 모델이 했습니다. 원본 노트는 바꾸지 않았습니다.",
    "",
  ];
  for (const w of result.warnings) body.push(`> [!warning] ${w}`, "");
  for (const sec of SECTIONS) {
    const items = result.items.filter((i) => (i.verdict ?? "failed") === sec.key);
    if (items.length === 0) continue;
    const label = sec.key === "failed" ? "판정 실패" : sec.key;
    body.push(`## ${sec.icon} ${label} (${items.length})`, "");
    for (const it of items) {
      const links = evidenceLinks(lecture, it.evidence);
      body.push(
        `> [!${sec.callout}]${sec.fold ? "-" : ""} ${label}${it.byScript ? " (스크립트)" : ""}`,
        `> "${quote(it.evidence.claim.text)}"`,
        `> ${it.reason || "(이유 없음)"}`,
        ...(links ? [`> 근거: ${links}`] : []),
        ""
      );
    }
  }
  if (result.missing.length > 0) {
    body.push(`## 📭 ${MISSING_LABEL} (${result.missing.length})`, "");
    for (const m of result.missing) body.push(`- ${slideLink(lecture, m.slide)} ${m.title}${m.reason ? `: ${m.reason}` : ""}`);
    body.push("");
  }
  body.push(VERIFY_BLOCK_END, "", "## 내 메모", "");
  return fm.join("\n") + body.join("\n");
}

/**
 * Re-run: the new note replaces the old one up to the end of the managed
 * block; whatever the user wrote after the block (the "## 내 메모" section)
 * is kept.
 */
export function mergeVerificationNote(existing: string | null, next: string): string {
  if (!existing) return next;
  const end = existing.indexOf(VERIFY_BLOCK_END);
  if (end < 0) return next;
  const userPart = existing.slice(end + VERIFY_BLOCK_END.length);
  const nextEnd = next.indexOf(VERIFY_BLOCK_END);
  return next.slice(0, nextEnd + VERIFY_BLOCK_END.length) + userPart;
}

export type { Claim };
