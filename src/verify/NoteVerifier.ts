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
import { buildEvidenceIndex, ClaimEvidence, findEvidence, transcriptChunks, UncoveredSlide, uncoveredSlides, withContextEvidence } from "./evidence";
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
  /** Lecture note title (shown, and the link alias). */
  lecture: string;
  /** Vault path of the lecture note (`.md`): links are path-qualified with it. */
  notePath?: string | null;
  noteMarkdown: string;
  /** Page texts, index 0 = slide 1. */
  slideTexts: string[];
  /** Timestamped transcript and the note's stored alignment, when known. */
  transcript?: { segments: TimedSegment[]; spans: StoredSpan[] | null } | null;
}

export interface VerifyPlan {
  lecture: string;
  notePath: string | null;
  claims: ClaimEvidence[];
  /** Claims sent to the LLM, likely-true ones last. Every claim with any evidence is judged. */
  judged: ClaimEvidence[];
  batches: ClaimEvidence[][];
  /** Claims no route found evidence for: listed apart, never given a verdict by the script. */
  unmatched: ClaimEvidence[];
  uncovered: UncoveredSlide[];
  hasTranscript: boolean;
}

export function planVerification(input: VerifyInput, perCall = CLAIMS_PER_CALL): VerifyPlan {
  const claims = splitClaims(input.noteMarkdown);
  const chunks = input.transcript ? transcriptChunks(input.transcript.segments, input.transcript.spans) : [];
  const index = buildEvidenceIndex(input.slideTexts, chunks);
  const evidence = withContextEvidence(claims.map((c) => findEvidence(c, index)), index);
  const unmatched = evidence.filter((e) => e.unmatched);
  const judged = [...evidence.filter((e) => !e.unmatched && !e.likelyTrue), ...evidence.filter((e) => !e.unmatched && e.likelyTrue)];
  const batches: ClaimEvidence[][] = [];
  for (let i = 0; i < judged.length; i += perCall) batches.push(judged.slice(i, i + perCall));
  return {
    lecture: input.lecture,
    notePath: input.notePath ?? null,
    claims: evidence,
    judged,
    batches,
    unmatched,
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
  const evidenceNote = e.source === "direct" ? "" : " (주장과 겹치는 용어가 없어 같은 절의 문맥으로 찾은 후보)";
  return renderPrompt(claimTemplate, { id: e.claim.id, claim: e.claim.text, evidenceNote, evidence: lines.join("\n") || "- (없음)" });
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

/** Share of claims without any evidence above which the estimate warns (terms of note and slides do not meet). */
export const UNMATCHED_WARN_SHARE = 0.3;

export interface VerifyEstimate {
  claims: number;
  judged: number;
  /** Judged with context evidence (no shared term: neighbours, heading, section). */
  contextEvidence: number;
  /** Not judged: no evidence by any route. */
  unmatched: number;
  /** More than 30% of the claims are unmatched. */
  unmatchedWarning: boolean;
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
    contextEvidence: plan.judged.filter((c) => c.source !== "direct").length,
    unmatched: plan.unmatched.length,
    unmatchedWarning: plan.claims.length > 0 && plan.unmatched.length / plan.claims.length > UNMATCHED_WARN_SHARE,
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
}

export interface MissingCandidate {
  slide: number;
  title: string;
  reason: string;
}

export interface VerifyResult {
  lecture: string;
  notePath: string | null;
  /** Judged claims, in note order. */
  items: VerifiedClaim[];
  /** Claims no route found evidence for (not judged). */
  unmatched: ClaimEvidence[];
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
    // "근거없음" and "근거 없음" are the same verdict.
    const raw = typeof it.v === "string" ? it.v.replace(/\s+/g, "") : "";
    const v = VERDICTS.find((x) => x.replace(/\s+/g, "") === raw);
    if (!v) {
      failed.set(e.claim.id, `판정 값이 올바르지 않음 (${String(it.v).slice(0, 20)})`);
      continue;
    }
    const r = typeof it.r === "string" ? it.r.replace(/\s+/g, " ").trim() : "";
    ok.set(e.claim.id, { v, r: r.length > REASON_MAX ? `${r.slice(0, REASON_MAX - 3)}...` : r });
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
    out.push({ slide: u.slide, title: u.title, reason: typeof it.r === "string" ? it.r.replace(/\s+/g, " ").trim().slice(0, REASON_MAX) : "" });
  }
  return out.sort((a, b) => a.slide - b.slide);
}

/** The model's verdict per judged claim, or none with the failure reason; unmatched claims apart. */
function assembleResult(plan: VerifyPlan, done: Map<number, JudgeItem>, failures: Map<number, string>, missing: MissingCandidate[], warnings: string[]): VerifyResult {
  const items: VerifiedClaim[] = plan.claims
    .filter((e) => !e.unmatched)
    .map((e) => {
      const d = done.get(e.claim.id);
      if (d) return { evidence: e, verdict: d.v, reason: d.r };
      return { evidence: e, verdict: null, reason: failures.get(e.claim.id) ?? "응답에 이 주장이 없음" };
    });
  const failedCount = items.filter((i) => i.verdict === null).length;
  const out = [...warnings];
  if (failedCount > 0) out.push(`주장 ${failedCount}개는 판정하지 못했습니다.`);
  return { lecture: plan.lecture, notePath: plan.notePath, items, unmatched: plan.unmatched, missing, warnings: out };
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

export function verdictCounts(result: VerifyResult): Record<Verdict | "failed" | "missing" | "unmatched", number> {
  const counts = { 맞음: 0, 틀림: 0, "근거 없음": 0, "전사 불확실": 0, failed: 0, missing: result.missing.length, unmatched: result.unmatched.length } as Record<Verdict | "failed" | "missing" | "unmatched", number>;
  for (const it of result.items) counts[it.verdict ?? "failed"]++;
  return counts;
}

export interface LectureRef {
  title: string;
  /** Vault path of the lecture note (".md"), or null (title-only links). */
  path: string | null;
}

/** Characters a wikilink target or alias cannot hold. */
const LINK_UNSAFE = /[#^[\]|]/;

function aliasText(text: string): string {
  return text.replace(/[#^[\]|]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Link to a lecture note (and a slide heading): path-qualified with an
 * alias, `[[<path>#📚 슬라이드 3|<title> · 슬라이드 3]]`, so two lectures with
 * the same title never mix. A path holding # ^ [ ] | (Obsidian cannot put
 * those in a wikilink target) becomes a Markdown link with the path
 * percent-encoded.
 */
export function lectureLink(ref: LectureRef, slide?: number): string {
  const heading = slide ? `📚 슬라이드 ${slide}` : "";
  const alias = aliasText(slide ? `${ref.title} · 슬라이드 ${slide}` : ref.title);
  const target = ref.path ? ref.path.replace(/\.md$/, "") : ref.title;
  if (!LINK_UNSAFE.test(target)) return `[[${target}${heading ? `#${heading}` : ""}|${alias}]]`;
  const file = ref.path ?? `${ref.title}.md`;
  const url = file.split("/").map(encodeURIComponent).join("/") + (heading ? `#${encodeURIComponent(heading)}` : "");
  return `[${alias}](${url})`;
}

function refOf(result: VerifyResult): LectureRef {
  return { title: result.lecture, path: result.notePath };
}

function evidenceLinks(ref: LectureRef, e: ClaimEvidence): string {
  const parts = e.slides.map((h) => lectureLink(ref, h.slide));
  for (const t of e.transcript) parts.push(`[${formatTimestamp(t.startMs)}]${t.slide ? ` (슬라이드 ${t.slide})` : ""}`);
  return parts.join(" · ");
}

/** Quote safe inside a callout: one line, no leading callout syntax. */
function quote(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^\[!/, "[\\!").replace(/<!--/g, "&lt;!--").trim();
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
  const ref = refOf(result);
  const fm = [
    "---",
    `lecture: ${JSON.stringify(lectureLink(ref))}`,
    `verified_source: ${JSON.stringify(meta.source)}`,
    `date: "${meta.date}"`,
    `source: "alt2obsidian-verify"`,
    `claims: ${result.items.length + result.unmatched.length}`,
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
    `> 맞음 ${c["맞음"]} · 틀림 ${c["틀림"]} · 근거 없음 ${c["근거 없음"]} · 전사 불확실 ${c["전사 불확실"]} · 누락 후보 ${c.missing}${c.failed ? ` · 판정 실패 ${c.failed}` : ""}${c.unmatched ? ` · 근거 검색 실패 ${c.unmatched}` : ""}`,
    `> 대상 노트: ${meta.source} · 강의: ${lectureLink(ref)} · ${meta.model} · ${meta.date}`,
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
      const links = evidenceLinks(ref, it.evidence);
      body.push(
        `> [!${sec.callout}]${sec.fold ? "-" : ""} ${label}${it.evidence.source !== "direct" ? " (문맥 근거)" : ""}`,
        `> "${quote(it.evidence.claim.text)}"`,
        `> ${it.reason || "(이유 없음)"}`,
        ...(links ? [`> 근거: ${links}`] : []),
        ""
      );
    }
  }
  if (result.missing.length > 0) {
    body.push(`## 📭 ${MISSING_LABEL} (${result.missing.length})`, "");
    for (const m of result.missing) body.push(`- ${lectureLink(ref, m.slide)} ${m.title}${m.reason ? `: ${m.reason}` : ""}`);
    body.push("");
  }
  if (result.unmatched.length > 0) {
    body.push(`## 🔎 용어 불일치로 근거 검색 실패 (${result.unmatched.length})`, "", "판정이 아닙니다. 슬라이드와 전사, 같은 절의 문맥 어디에서도 근거 후보를 찾지 못해 모델에 보내지 않았습니다.", "");
    for (const e of result.unmatched) body.push(`- "${quote(e.claim.text)}"`);
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
  if (!existing || !existing.trim()) return next;
  // The last marker: an end marker quoted from the checked note inside the block does not cut it short.
  const end = existing.lastIndexOf(VERIFY_BLOCK_END);
  if (end < 0) {
    // No managed block (the marker was removed, or a user file sits at this
    // path): nothing of it is dropped; it follows the new block in full.
    return `${next.trimEnd()}\n\n## 이전 내용 (Alt2Obsidian이 관리하지 않음)\n\n${existing.trim()}\n`;
  }
  const userPart = existing.slice(end + VERIFY_BLOCK_END.length);
  const nextEnd = next.lastIndexOf(VERIFY_BLOCK_END);
  return next.slice(0, nextEnd + VERIFY_BLOCK_END.length) + userPart;
}

export type { Claim };
