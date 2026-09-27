// Skill-side note verification (spec 4.6, 4.7): the plugin's claim split,
// evidence retrieval, batch prompts and note rendering, so a Skill run sends
// the model exactly what the plugin sends and writes the same note.
//
// Usage:
//   node scripts/phase2/verify-prep.mjs prep <pdfPath> <noteFile> --lecture <name> --out <dir>
//        [--bundle <bundle.json>] [--alignment "<alt_alignment value>"]
//     Writes into <dir> (created 0700): plan.json, system.md (the judge
//     instructions), batch-<n>.md (one judge prompt per 20 claims) and
//     missing.md (the missing-slide prompt, when any slide is uncovered).
//     --bundle is an alt-local.mjs export: its timestamped transcript is the
//     secondary evidence, grouped by --alignment (the lecture note's
//     alt_alignment) or, without it, by a fresh alignment. Prints
//     {"claims","judged","scriptOnly","likelyTrue","uncoveredSlides","batches":[{"file","ids"}],
//      "missing","estimate":{"calls","inputTokens","outputTokens"}}.
//   node scripts/phase2/verify-prep.mjs render <dir> --answers <answers.json> --source <label>
//        [--missing <missing.json>] [--model <label>] [--existing <verification note>]
//     <answers.json> holds the {"results":[...]} answers (an array of them, or
//     one object); prints the verification note, merged with --existing
//     (the user's section below the managed block is kept).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractPageLayouts, layoutAlignmentText } from "../../src/core/prep/pageLayout";
import { parseAlignment } from "../../src/core/prep/TranscriptAligner";
import { alignLecture, timedSegments } from "../../src/pipeline/alignment";
import {
  buildJudgePrompt,
  buildJudgeSystemPrompt,
  buildMissingPrompt,
  estimateVerification,
  JUDGE_SCHEMA,
  MISSING_SCHEMA,
  mergeVerificationNote,
  planVerification,
  renderVerificationNote,
  resultFromAnswers,
  VerifyInput,
  VerifyPlan,
} from "../../src/verify/NoteVerifier";
import { formatDate } from "../../src/utils/helpers";
import { fail, openPdf } from "./cli-common";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "Usage: node scripts/phase2/verify-prep.mjs prep <pdfPath> <noteFile> --lecture <name> --out <dir> [--bundle B] [--alignment V]\n" +
      "       node scripts/phase2/verify-prep.mjs render <dir> --answers <answers.json> --source <label> [--missing M] [--model L] [--existing NOTE]\n"
  );
  process.exit(2);
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function prep(args: string[]): Promise<void> {
  const [pdfPath, noteFile] = args;
  const lecture = option(args, "--lecture");
  const out = option(args, "--out");
  if (!pdfPath || !noteFile || !lecture || !out || pdfPath.startsWith("--") || noteFile.startsWith("--")) usage();
  const pdf = await openPdf(pdfPath);
  let slideTexts: string[];
  try {
    slideTexts = (await extractPageLayouts(pdf)).map(layoutAlignmentText);
  } finally {
    await pdf.destroy();
  }
  let transcript: VerifyInput["transcript"] = null;
  const bundleFile = option(args, "--bundle");
  if (bundleFile) {
    const bundleSegments = JSON.parse(readFileSync(bundleFile, "utf8")).transcript;
    const segments = timedSegments(bundleSegments);
    if (segments) {
      const value = option(args, "--alignment") ?? alignLecture(slideTexts, bundleSegments)?.value ?? "";
      const spans = parseAlignment(value);
      transcript = { segments, spans: spans.length > 0 ? spans : null };
    }
  }
  const plan = planVerification({ lecture, noteMarkdown: readFileSync(noteFile, "utf8"), slideTexts, transcript });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  writePrivate(join(out, "plan.json"), JSON.stringify(plan));
  // The Skill answers in its own session: the schema goes with the instructions.
  writePrivate(join(out, "system.md"), `${buildJudgeSystemPrompt()}\n\nJSON schema: ${JSON.stringify(JUDGE_SCHEMA)}\n`);
  const batches = plan.batches.map((b, i) => {
    const file = `batch-${i + 1}.md`;
    writePrivate(join(out, file), buildJudgePrompt(plan.lecture, b) + "\n");
    return { file, ids: b.map((e) => e.claim.id) };
  });
  const missingPrompt = buildMissingPrompt(plan);
  if (missingPrompt) writePrivate(join(out, "missing.md"), `${missingPrompt}\n\nJSON schema: ${JSON.stringify(MISSING_SCHEMA)}\n`);
  const e = estimateVerification(plan, "claude-cli");
  process.stdout.write(
    JSON.stringify({
      claims: e.claims,
      judged: e.judged,
      scriptOnly: e.scriptOnly,
      likelyTrue: e.likelyTrue,
      uncoveredSlides: e.uncoveredSlides,
      transcript: plan.hasTranscript,
      batches,
      missing: missingPrompt ? "missing.md" : null,
      estimate: { calls: e.calls, inputTokens: e.inputTokens, outputTokens: e.outputTokens },
    }) + "\n"
  );
}

function render(args: string[]): void {
  const [dir] = args;
  const answersFile = option(args, "--answers");
  const source = option(args, "--source");
  if (!dir || dir.startsWith("--") || !answersFile || !source) usage();
  const plan: VerifyPlan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  const raw = JSON.parse(readFileSync(answersFile, "utf8"));
  const missingFile = option(args, "--missing");
  const result = resultFromAnswers(plan, Array.isArray(raw) ? raw : [raw], missingFile ? JSON.parse(readFileSync(missingFile, "utf8")) : undefined);
  const next = renderVerificationNote(result, { source, date: formatDate(), usageLine: null, model: option(args, "--model") ?? "Claude Code (alt2obs Skill)" });
  const existingFile = option(args, "--existing");
  let existing: string | null = null;
  if (existingFile) {
    try {
      existing = readFileSync(existingFile, "utf8");
    } catch {
      existing = null;
    }
  }
  process.stdout.write(mergeVerificationNote(existing, next));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "prep") return prep(rest);
  if (cmd === "render") return render(rest);
  usage();
}

main().catch((e: unknown) => fail(e, "verify-prep"));
