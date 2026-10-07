// Batched section summaries for lectures without slides (spec 4.10), the
// counterpart of BatchCommentaryGenerator: one call covers several
// transcript sections, every call starts with the same bytes (fixed
// instructions, then the lecture-wide context) so the prompt cache serves
// them, and the answer is JSON checked here. Retries, stop rules and the
// "keep the previous summary when generation fails" rule are the slide
// path's (src/llm/jsonBatches.ts).

import { LLMProvider } from "../types";
import { renderPrompt } from "../prompts/render";
import { formatSlideMeta } from "../core/slideMeta";
import { formatClock, sectionHeadingText, sectionRange } from "../core/sections";
import { runJsonBatches } from "../llm/jsonBatches";
import type { LectureContext } from "./BatchCommentaryGenerator";
import type { PlannedSection, TranscriptPlan } from "../pipeline/transcriptPlan";
import systemTemplate from "../../prompts/transcript-section-batch.system.md";
import contextTemplate from "../../prompts/transcript-section-batch.context.md";
import userTemplate from "../../prompts/transcript-section-batch.user.md";
import sectionTemplate from "../../prompts/transcript-section-batch.section.md";

export const SUMMARY_LIMIT = 900;
export const GIST_LIMIT = 60;
/** A section of announcements or small talk gets one short line ("- 수업 안내뿐이다. [00:12]"); below this it is no summary. */
const MIN_SUMMARY_CHARS = 10;
/** Models count characters loosely. */
const MAX_SLACK = 1.6;

export const SECTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "summary", "gist"],
        properties: {
          section: { type: "integer", description: "구간 번호" },
          summary: { type: "string", description: "마크다운 요약, 300~900자, 불릿 끝에 [mm:ss]" },
          gist: { type: "string", description: "60자 이내 한 줄 요지" },
        },
      },
    },
  },
};

export function buildSectionSystemPrompt(): string {
  return renderPrompt(systemTemplate, {});
}

function durationText(plan: TranscriptPlan): string {
  if (plan.durationMs === null) return "(전사 시각 없음)";
  return `${Math.max(1, Math.round(plan.durationMs / 60000))}분`;
}

/** Lecture-wide block, byte-identical for every batch of a lecture. */
export function buildSectionContextBlock(ctx: LectureContext, plan: TranscriptPlan): string {
  return renderPrompt(contextTemplate, {
    title: ctx.title,
    duration: durationText(plan),
    sectionCount: plan.sections.length,
    subjectTags: ctx.subjectTags.length > 0 ? ctx.subjectTags.slice(0, 60).join(", ") : "(없음)",
    knownConcepts: ctx.knownConcepts.length > 0 ? ctx.knownConcepts.slice(0, 100).join(", ") : "(없음)",
    sectionList: plan.sections.map((s) => `${s.num}. ${sectionRange(s.startMs, s.endMs) || "(시각 없음)"}`).join("\n"),
  });
}

export function buildSectionBlock(section: PlannedSection): string {
  return renderPrompt(sectionTemplate, {
    heading: sectionHeadingText(section.num, section.startMs, section.endMs).replace(/^⏱ /, ""),
    text: section.text.trim() || "(전사 없음)",
  });
}

export function buildSectionUserPrompt(contextBlock: string, sections: PlannedSection[]): string {
  return (
    contextBlock +
    "\n\n" +
    renderPrompt(userTemplate, {
      sectionNums: sections.map((s) => s.num).join(", "),
      sectionBlocks: sections.map(buildSectionBlock).join("\n\n"),
    })
  );
}

interface SectionItem {
  section: number;
  summary: string;
  gist: string;
}

/** Accepted summaries by section, and a reason per requested section that failed. */
export function checkSectionAnswer(raw: unknown, requested: PlannedSection[]): { ok: Map<number, SectionItem>; failed: Map<number, string> } {
  const ok = new Map<number, SectionItem>();
  const failed = new Map<number, string>();
  const items = (raw as { sections?: unknown })?.sections;
  const byNum = new Map<number, unknown>();
  if (Array.isArray(items)) {
    for (const it of items) {
      const n = Number((it as { section?: unknown })?.section);
      if (Number.isInteger(n) && !byNum.has(n)) byNum.set(n, it);
    }
  }
  for (const s of requested) {
    const it = byNum.get(s.num) as Partial<SectionItem> | undefined;
    if (!it) {
      failed.set(s.num, Array.isArray(items) ? "응답에 이 구간이 없음" : "응답 JSON 형식 오류");
      continue;
    }
    const summary = typeof it.summary === "string" ? it.summary.trim() : "";
    if (summary.length < MIN_SUMMARY_CHARS) {
      failed.set(s.num, `요약이 너무 짧음 (${summary.length}자)`);
      continue;
    }
    if (summary.length > SUMMARY_LIMIT * MAX_SLACK) {
      failed.set(s.num, `요약이 너무 김 (${summary.length}자)`);
      continue;
    }
    const gistRaw = typeof it.gist === "string" ? it.gist.replace(/\s+/g, " ").trim() : "";
    const gist = gistRaw.length > GIST_LIMIT ? gistRaw.slice(0, GIST_LIMIT) : gistRaw;
    if (!gist) {
      failed.set(s.num, "요지(gist)가 비어 있음");
      continue;
    }
    ok.set(s.num, { section: s.num, summary, gist });
  }
  return { ok, failed };
}

/** One section of the note: its summary and the meta line (gist) kept inside the managed block. */
export interface SectionResult {
  num: number;
  hash: string;
  startMs: number | null;
  endMs: number | null;
  summary: string;
  /** `<!-- alt2obs:meta img:none gist:"..." -->`, absent when the section kept a summary from a different transcript. */
  meta?: string;
}

export interface SectionProgress {
  batch: number;
  batches: number;
  done: number;
  total: number;
  retry: boolean;
}

export interface SectionGenerationResult {
  sections: SectionResult[];
  errors: Array<{ section: number; reason: string }>;
  /** Gist per section for generated and reused sections (overview and concept input). */
  gists: Map<number, string>;
  /** Sections sent in each call, retries included. */
  calls: number[][];
  generatedCount: number;
  /** Failed sections that kept their previous summary (listed in `errors` too). */
  keptPrevious: number[];
}

/** Expected output tokens of one section summary: Korean text at about 0.9 tokens a character, plus the gist and JSON keys. */
export function sectionOutputTokens(textChars: number): number {
  return Math.round(Math.min(800, Math.max(150, 120 + textChars * 0.2)));
}

export class SectionSummaryGenerator {
  constructor(private llm: LLMProvider) {}

  async generate(opts: {
    plan: TranscriptPlan;
    context: LectureContext;
    signal?: AbortSignal;
    onProgress?(p: SectionProgress): void;
  }): Promise<SectionGenerationResult> {
    const { plan } = opts;
    const system = buildSectionSystemPrompt();
    const contextBlock = buildSectionContextBlock(opts.context, plan);
    const byNum = new Map(plan.sections.map((s) => [s.num, s]));
    const llmTotal = plan.sections.filter((s) => s.mode === "llm").length;
    const { done, failures, calls } = await runJsonBatches<PlannedSection, number, SectionItem>({
      batches: plan.batches.map((b) => b.map((n) => byNum.get(n)!)),
      key: (s) => s.num,
      unitObject: "구간을",
      signal: opts.signal,
      call: (sections) =>
        this.llm.generateJSON(buildSectionUserPrompt(contextBlock, sections), (r) => r, {
          systemPrompt: system,
          schema: SECTION_SCHEMA,
          signal: opts.signal,
          attempts: 1,
          // The per-call timeout is sized for an 8-slide batch (about 3.4k output tokens).
          timeoutScale: Math.max(1, sections.reduce((n, s) => n + sectionOutputTokens(s.text.length), 0) / 3400),
        }),
      check: checkSectionAnswer,
      onProgress: (p) => opts.onProgress?.({ batch: p.batch, batches: p.batches, done: p.done, total: llmTotal, retry: p.retry }),
    });

    return { ...assembleSections(plan, done, failures), calls };
  }
}

/**
 * The note's sections from the accepted answers (the plugin's calls, or the
 * Skill's own answers): reused sections keep their summary, a failed one
 * keeps its previous summary when the note had one, else a warning callout.
 */
export function assembleSections(
  plan: TranscriptPlan,
  done: Map<number, { summary: string; gist: string }>,
  failures: Map<number, string>
): Omit<SectionGenerationResult, "calls"> {
  const sections: SectionResult[] = [];
  const gists = new Map<number, string>();
  const errors: SectionGenerationResult["errors"] = [];
  const keptPrevious: number[] = [];
  let generatedCount = 0;
  for (const s of plan.sections) {
    const base = { num: s.num, hash: s.hash, startMs: s.startMs, endMs: s.endMs };
    if (s.mode === "reuse" && s.reused) {
      sections.push({ ...base, summary: s.reused.body, meta: formatSlideMeta(null, s.reused.gist) });
      gists.set(s.num, s.reused.gist);
      continue;
    }
    const item = done.get(s.num);
    if (item) {
      sections.push({ ...base, summary: item.summary, meta: formatSlideMeta(null, item.gist) });
      gists.set(s.num, item.gist);
      generatedCount++;
      continue;
    }
    const reason = failures.get(s.num) ?? "응답에 이 구간이 없음";
    if (s.previous && s.previous.body.trim()) {
      // The old summary stays; its gist (meta) only when the transcript is the same.
      const same = s.previous.hash === s.hash;
      sections.push({ ...base, summary: s.previous.body, meta: same && s.previous.gist ? formatSlideMeta(null, s.previous.gist) : undefined });
      if (same && s.previous.gist) gists.set(s.num, s.previous.gist);
      keptPrevious.push(s.num);
      errors.push({ section: s.num, reason: `새 요약 생성 실패, 이전 요약을 유지했습니다 (${reason})` });
    } else {
      sections.push({ ...base, summary: `> [!warning] 이 구간은 요약하지 못했습니다\n> ${reason}` });
      errors.push({ section: s.num, reason });
    }
  }
  return { sections, errors, gists, generatedCount, keptPrevious };
}

/** "구간 3 [24:10~36:02]: gist" lines for the overview and concept prompts. */
export function sectionGistLines(gists: Map<number, string>, plan: Pick<TranscriptPlan, "sections">): string {
  const byNum = new Map(plan.sections.map((s) => [s.num, s]));
  return Array.from(gists.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([n, gist]) => {
      const s = byNum.get(n);
      const range = s && s.startMs !== null ? ` [${formatClock(s.startMs)}]` : "";
      return `구간 ${n}${range}: ${gist}`;
    })
    .join("\n");
}
