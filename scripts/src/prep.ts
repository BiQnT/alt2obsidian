// Skill-side deterministic prep CLI (spec 4.7, 5.1). Runs the plugin's
// SlideAnalyzer, TranscriptCompressor and batch planner, so a Skill import
// skips, deduplicates, compresses and batches exactly like the plugin.
//
// Usage: node scripts/phase2/prep.mjs <pdfPath> <sourceId> [options]
//   --title <text>          deck title for the cover template line
//   --transcript <file>     transcript text (split evenly per slide, then compressed)
//   --bundle <bundle.json>  alt-local.mjs export: its timestamped transcript is
//                           aligned to the slides (spec 4.3) instead of the even
//                           split; output gets "alignment" (frontmatter value
//                           of alt_alignment, spans, low-confidence count)
//   --cap <chars>           per-slide transcript cap (default 600)
//   --batch <K>             slides per batch (default 8, K/2 with images)
//   --image-rule auto|text-only
//   --renders <dir>         grayscale PGM renders named <prefix>-<page>.pgm
//                           (pdftoppm -gray -scale-to 160). Without it the CLI
//                           runs pdftoppm itself when it is installed;
//   --no-render             or skips rendering (image ratio and image signal null)
//   --existing <note.md>    previous note: slides with the same text hash and
//                           image signal are marked "reuse"
// Prints {"scanned","transcriptChars","pages":[...],"batches":[[...]],"alignment"}.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSlides, GrayImage } from "../../src/core/prep/SlideAnalyzer";
import { ANALYSIS_LONG_EDGE, extractPageLayouts, layoutAlignmentText, parsePgm } from "../../src/core/prep/pageLayout";
import { alignLecture } from "../../src/pipeline/alignment";
import { TranscriptSegment } from "../../src/sources/types";
import { parseExistingSlides, planDeck } from "../../src/pipeline/batchPlan";
import { fail, openPdf } from "./cli-common";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readPgmDir(dir: string, pageCount: number): Array<GrayImage | null> {
  const grays: Array<GrayImage | null> = new Array(pageCount).fill(null);
  for (const f of readdirSync(dir)) {
    const m = f.match(/-(\d+)\.pgm$/);
    if (!m) continue;
    const page = parseInt(m[1], 10);
    if (page >= 1 && page <= pageCount) grays[page - 1] = parsePgm(new Uint8Array(readFileSync(join(dir, f))));
  }
  return grays;
}

/** pdftoppm renders, or all null when pdftoppm is missing or fails. */
function renderWithPdftoppm(pdfPath: string, pageCount: number): Array<GrayImage | null> {
  const dir = mkdtempSync(join(tmpdir(), "alt2obs-prep-"));
  try {
    const r = spawnSync("pdftoppm", ["-gray", "-scale-to", String(ANALYSIS_LONG_EDGE), pdfPath, join(dir, "p")], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (r.status !== 0) {
      process.stderr.write("prep: pdftoppm not available, image ratio and image signal skipped\n");
      return new Array(pageCount).fill(null);
    }
    return readPgmDir(dir, pageCount);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [pdfPath, sourceId] = args;
  if (!pdfPath || !sourceId || pdfPath.startsWith("--") || sourceId.startsWith("--")) {
    process.stderr.write("Usage: node scripts/phase2/prep.mjs <pdfPath> <sourceId> [--title T] [--transcript F | --bundle B] [--cap N] [--batch K] [--image-rule auto|text-only] [--renders DIR | --no-render] [--existing NOTE]\n");
    process.exit(2);
  }
  const imageRule = option(args, "--image-rule") === "text-only" ? "text-only" : "auto";
  const transcriptFile = option(args, "--transcript");
  const existingFile = option(args, "--existing");
  const rendersDir = option(args, "--renders");

  const pdf = await openPdf(pdfPath);
  try {
    const layouts = await extractPageLayouts(pdf);
    const grays = args.includes("--no-render")
      ? new Array(layouts.length).fill(null)
      : rendersDir
        ? readPgmDir(rendersDir, layouts.length)
        : renderWithPdftoppm(pdfPath, layouts.length);
    const analysis = await analyzeSlides(layouts, grays, { sourceId, imageRule });
    const bundleFile = option(args, "--bundle");
    const segments: TranscriptSegment[] | undefined = bundleFile ? JSON.parse(readFileSync(bundleFile, "utf8")).transcript : undefined;
    const alignment = alignLecture(layouts.map(layoutAlignmentText), segments, { scanned: analysis.scanned });
    const transcriptText = transcriptFile ? readFileSync(transcriptFile, "utf8") : segments ? segments.map((s) => s.text).join("\n") : null;
    const plan = planDeck({
      ...analysis,
      layouts,
      transcript: transcriptText,
      transcriptChunks: alignment?.chunks,
      transcriptCapChars: parseInt(option(args, "--cap") ?? "600", 10),
      batchSize: parseInt(option(args, "--batch") ?? "8", 10),
      deckTitle: option(args, "--title") ?? "",
      existing: existingFile ? parseExistingSlides(readFileSync(existingFile, "utf8")) : undefined,
    });
    const pages = plan.slides.map((s) => ({
      page: s.page,
      hash: s.hash,
      textChars: s.textChars,
      imageRatio: s.imageRatio,
      kind: s.kind,
      dupOf: s.dupOf,
      sendImage: s.sendImage,
      mode: s.mode,
      template: s.template ?? null,
      transcript: s.transcript,
      imageSignal: s.imageSignal,
      reusedGist: s.reused?.gist ?? null,
    }));
    process.stdout.write(
      JSON.stringify({
        scanned: plan.scanned,
        transcriptChars: plan.transcriptChars,
        pages,
        batches: plan.batches.map((b) => b.pages),
        alignment: alignment
          ? {
              value: alignment.value,
              spans: alignment.result.spans.map((s) => ({ slide: s.slide, startMs: s.startMs, endMs: s.endMs, confidence: s.confidence })),
              lowSpans: alignment.lowSpans.length,
            }
          : null,
      }) + "\n"
    );
  } finally {
    await pdf.destroy();
  }
}

main().catch((e: unknown) => fail(e, "prep"));
