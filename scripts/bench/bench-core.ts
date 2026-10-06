// Headless import benchmark (spec 5.6). Runs the plugin's pipeline code on a
// PDF + transcript without Obsidian and reports tokens, cache hits, calls,
// images and time. Bundled and started by scripts/bench/bench.mjs.
//
// Providers: claude-cli, codex-cli (the batched path in src/pipeline, same
// code as the plugin). The 1.1.0 Gemini mode was removed with the Gemini
// provider in 2.0.0-beta.4.

import { spawnSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { webcrypto } from "crypto";
import type { GrayImage } from "../../src/core/prep/SlideAnalyzer";
import { analyzeSlides } from "../../src/core/prep/SlideAnalyzer";
import { ANALYSIS_LONG_EDGE, extractPageLayouts, parsePgm } from "../../src/core/prep/pageLayout";
import { planDeck, planCounts, withFewerImages } from "../../src/pipeline/batchPlan";
import { estimateLecture, runBatchedLecture } from "../../src/pipeline/lecturePipeline";
import { ClaudeCliProvider } from "../../src/llm/cli/ClaudeCliProvider";
import { CodexCliProvider } from "../../src/llm/cli/CodexCliProvider";
import { createJobDir, removeJobDir, resolveCliBinary } from "../../src/llm/cli/CliRunner";
import { UsageTracker } from "../../src/llm/usage";
import { NoteGenerator } from "../../src/generator/NoteGenerator";
import { batchSizeFor } from "../../src/settings/llmSettings";
import type { AltNoteData, EffortLevel, ImageInput } from "../../src/types";

export interface BenchOptions {
  pdf: string;
  transcript: string | null;
  summary: string;
  title: string;
  subject: string;
  provider: "claude-cli" | "codex-cli";
  model: string;
  effort: EffortLevel;
  conceptModel: string;
  conceptEffort: EffortLevel;
  batchSize: number;
  capChars: number;
  imageRule: "auto" | "text-only";
  fewerImages: boolean;
  bin: string;
  timeoutSec: number;
  out: string | null;
  dryRun: boolean;
}

export interface BenchResult {
  provider: string;
  model: string;
  effort: string;
  slides: { total: number; generated: number; templated: number; deduped: number; reused: number; failed: number };
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheHitPct: number;
  outputTokens: number;
  imagesSent: number;
  costUsd: number;
  estimate: { calls: number; inputTokens: number; outputTokens: number; imagesSent: number } | null;
  transcriptChars: { before: number; after: number } | null;
  wallTimeMs: number;
  dryRun: boolean;
}

// ---- rendering with pdftoppm ----

function pdftoppm(args: string[]): void {
  const r = spawnSync("pdftoppm", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.error || r.status !== 0) {
    throw new Error(`pdftoppm failed (${r.error?.message ?? r.stderr?.toString().trim()}). Install poppler: brew install poppler`);
  }
}

function grayRenders(pdf: string, pageCount: number): Array<GrayImage | null> {
  const dir = mkdtempSync(join(tmpdir(), "alt2obs-bench-"));
  try {
    pdftoppm(["-gray", "-scale-to", String(ANALYSIS_LONG_EDGE), pdf, join(dir, "p")]);
    const grays: Array<GrayImage | null> = new Array(pageCount).fill(null);
    for (const f of readdirSync(dir)) {
      const m = f.match(/-(\d+)\.pgm$/);
      if (m) grays[parseInt(m[1], 10) - 1] = parsePgm(new Uint8Array(readFileSync(join(dir, f))));
    }
    return grays;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderOne(pdf: string, page: number, format: "jpeg" | "png"): string | null {
  const dir = mkdtempSync(join(tmpdir(), "alt2obs-bench-"));
  try {
    const args =
      format === "jpeg"
        ? ["-jpeg", "-jpegopt", "quality=80", "-scale-to", "1024"]
        : ["-png", "-scale-to-x", "1024", "-scale-to-y", "-1"];
    pdftoppm([...args, "-f", String(page), "-l", String(page), "-singlefile", pdf, join(dir, "out")]);
    const file = readdirSync(dir)[0];
    return file ? readFileSync(join(dir, file)).toString("base64") : null;
  } catch (e) {
    console.error(`render of page ${page} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function openPdf(path: string) {
  if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
}

function altData(o: BenchOptions): AltNoteData {
  return {
    title: o.title,
    summary: o.summary,
    pdfUrl: null,
    transcript: o.transcript,
    metadata: { noteId: "bench", createdAt: null, visibility: null },
    parseQuality: "full",
  };
}

// ---- 2.0 CLI path ----

async function runCli(o: BenchOptions): Promise<BenchResult> {
  const started = Date.now();
  const doc = await openPdf(o.pdf);
  const layouts = await extractPageLayouts(doc);
  await doc.destroy();
  const analysis = await analyzeSlides(layouts, grayRenders(o.pdf, layouts.length), { sourceId: "bench", imageRule: o.imageRule });
  let plan = planDeck({
    ...analysis,
    layouts,
    transcript: o.transcript,
    transcriptCapChars: o.capChars,
    batchSize: batchSizeFor(o.provider, o.batchSize),
    deckTitle: o.title,
  });
  if (o.fewerImages) plan = withFewerImages(plan, batchSizeFor(o.provider, o.batchSize));
  const context = { title: o.title, subjectTags: [], knownConcepts: [] };
  const estimate = estimateLecture(plan, context, o.summary, o.provider as "claude-cli", o.provider as "claude-cli");
  const counts = planCounts(plan);
  const base = {
    provider: o.provider,
    model: o.model || "(CLI default)",
    effort: o.effort || "(CLI default)",
    estimate: { calls: estimate.calls, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens, imagesSent: estimate.imagesSent },
    transcriptChars: plan.transcriptChars,
    dryRun: o.dryRun,
  };
  const slides = { total: counts.total, generated: counts.llm, templated: counts.templated, deduped: counts.deduped, reused: counts.reused, failed: 0 };
  if (o.dryRun) {
    return { ...base, slides, calls: 0, inputTokens: 0, cachedInputTokens: 0, cacheHitPct: 0, outputTokens: 0, imagesSent: 0, costUsd: 0, wallTimeMs: Date.now() - started };
  }

  const name = o.provider === "claude-cli" ? "claude" : "codex";
  const bin = (await resolveCliBinary(name, { configuredPath: o.bin })).path;
  const job = createJobDir();
  const usage = new UsageTracker();
  try {
    const Provider = o.provider === "claude-cli" ? ClaudeCliProvider : CodexCliProvider;
    const common = { bin, timeoutMs: o.timeoutSec * 1000, workDir: job, usage, ownsWorkDir: false };
    const commentaryLlm = new Provider({ ...common, model: o.model, effort: o.effort, task: "commentary" });
    const conceptLlm = new Provider({ ...common, model: o.conceptModel, effort: o.conceptEffort, task: "concepts" });
    const run = await runBatchedLecture({
      plan,
      context,
      subject: o.subject,
      language: "ko",
      altSummary: o.summary,
      commentaryLlm,
      conceptLlm,
      renderImage: async (page): Promise<ImageInput | null> => {
        const b64 = renderOne(o.pdf, page, "jpeg");
        return b64 ? { pageNum: page, mimeType: "image/jpeg", base64: b64 } : null;
      },
      onBatch: (p) => process.stderr.write(`batch ${p.batch}/${p.batches}${p.retry ? " (retry)" : ""}\n`),
    });
    if (o.out) {
      const note = await new NoteGenerator(commentaryLlm).generatePageAnchored(
        altData(o),
        { ...run.slidesResult, errors: [...run.slidesResult.errors, ...run.warnings.map((reason) => ({ slideNum: 0, reason }))] },
        { processedSummary: run.overview, concepts: run.concepts, tags: run.tags, subjectSuggestion: o.subject },
        o.subject
      );
      writeFileSync(o.out, note.lectureMarkdown);
    }
    const t = usage.total();
    return {
      ...base,
      slides: { ...slides, failed: run.slidesResult.errors.length },
      calls: t.calls,
      inputTokens: t.inputTokens,
      cachedInputTokens: t.cachedInputTokens,
      cacheHitPct: t.inputTokens > 0 ? Math.round((t.cachedInputTokens / t.inputTokens) * 1000) / 10 : 0,
      outputTokens: t.outputTokens,
      imagesSent: t.imagesSent,
      costUsd: t.costUsd,
      wallTimeMs: Date.now() - started,
    };
  } finally {
    removeJobDir(job);
  }
}

export async function runBench(o: BenchOptions): Promise<BenchResult> {
  return runCli(o);
}

export function formatTable(r: BenchResult): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const rows: Array<[string, string]> = [
    ["provider", r.provider],
    ["model / effort", `${r.model} / ${r.effort}`],
    ["mode", r.dryRun ? "dry run (plan + estimate only, no LLM calls)" : "full run"],
    [
      "slides",
      `${r.slides.total} total: ${r.slides.generated} generated, ${r.slides.templated} template, ${r.slides.deduped} duplicate, ${r.slides.reused} reused, ${r.slides.failed} failed`,
    ],
    ["calls", n(r.calls)],
    ["input tokens", n(r.inputTokens)],
    ["cached input tokens", `${n(r.cachedInputTokens)} (${r.cacheHitPct}%)`],
    ["output tokens", n(r.outputTokens)],
    ["images sent", n(r.imagesSent)],
    ["API-equivalent cost (Claude only)", r.costUsd ? `$${r.costUsd.toFixed(4)}` : "-"],
    ["estimate (calls / in / out / images)", r.estimate ? `${r.estimate.calls} / ${n(r.estimate.inputTokens)} / ${n(r.estimate.outputTokens)} / ${r.estimate.imagesSent}` : "-"],
    ["transcript chars (before -> after)", r.transcriptChars ? `${n(r.transcriptChars.before)} -> ${n(r.transcriptChars.after)}` : "-"],
    ["wall time", `${(r.wallTimeMs / 1000).toFixed(1)} s`],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return ["| metric | value |", "|---|---|", ...rows.map(([k, v]) => `| ${k.padEnd(w)} | ${v} |`)].join("\n");
}
