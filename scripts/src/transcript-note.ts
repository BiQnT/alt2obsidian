// Skill-side summary note for a lecture without slides (spec 4.10): the
// plugin's section split, prompts, answer checks and note assembly, so a
// Skill import sends the session exactly the prompts the plugin sends to
// its CLI and writes the same note.
//
// Usage:
//   node scripts/phase2/transcript-note.mjs prep <bundle.json | transcript.txt> --title <T> --out <dir>
//        [--source-id <id>] [--existing <note.md>] [--known <names.json>] [--tags <tags.json>] [--no-reuse]
//     Cuts the transcript into sections (bundle.json from alt-local.mjs keeps
//     the timestamps; a plain transcript.txt has none) and writes into <dir>
//     (created 0700, files 0600, they hold lecture text): plan.json,
//     system.md (the section instructions and the JSON schema) and
//     batch-<n>.md (the batch prompts). With --existing, sections whose
//     transcript is unchanged reuse their summary. Prints
//     {"timed","durationMs","sections":[{"num","range","hash","mode","chars"}],
//      "batches":[{"file","sections"}],"estimate":{"calls","inputTokens","outputTokens"}}.
//   node scripts/phase2/transcript-note.mjs followup <dir> --answers <answers.json> [--alt-summary <summary.md>] [--subject <S>] [--language ko|en]
//     Checks the {"sections":[...]} answers (an array of them, or one) like
//     the plugin, and writes overview.md (the overview prompt: system, then
//     user) and concepts.md (the concept prompt with its JSON schema) into
//     <dir>. Prints {"ok":[...],"failed":[{"section","reason"}]}.
//   node scripts/phase2/transcript-note.mjs render <dir> --answers <answers.json> --overview <overview.md>
//        --concepts <concepts.json> --subject <S> --id <noteId> [--local] [--created <date>] [--existing <note.md>]
//     Prints the note (source "alt2obsidian-cc-skill"): the plugin's
//     NoteGenerator with the concept names linked. --existing (the note this
//     import updates) carries its other identity over like the plugin (a
//     linked note's alt_id, or alt_local_id and alt_source). Exits 1 when no
//     section was answered (nothing to write).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkSectionAnswer, assembleSections, buildSectionContextBlock, buildSectionSystemPrompt, buildSectionUserPrompt, SECTION_SCHEMA, sectionGistLines } from "../../src/generator/SectionSummaryGenerator";
import { CONCEPT_SCHEMA, ConceptExtractor, validateConcepts } from "../../src/generator/ConceptExtractor";
import { NoteGenerator, preservedFrontmatterLines } from "../../src/generator/NoteGenerator";
import { parseExistingSections, planTranscript, TranscriptPlan } from "../../src/pipeline/transcriptPlan";
import { buildSectionOverviewPrompt, buildSectionOverviewSystemPrompt, estimateTranscriptSummary } from "../../src/pipeline/transcriptPipeline";
import { wikilinkCandidates } from "../../src/pipeline/lecturePipeline";
import { untimedSegments } from "../../src/sources/segments";
import { normalizeConcepts } from "../../src/core/conceptNames";
import { sectionRange } from "../../src/core/sections";
import type { LectureContext } from "../../src/generator/BatchCommentaryGenerator";
import type { TranscriptSegment } from "../../src/sources/types";
import { ensureWebCrypto, fail } from "./cli-common";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function jsonList(file: string | undefined): string[] {
  if (!file) return [];
  const v: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${file} must be a JSON array of strings`);
  return v as string[];
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

interface Saved {
  plan: TranscriptPlan;
  context: LectureContext;
}

function usage(): never {
  process.stderr.write(
    "Usage: node scripts/phase2/transcript-note.mjs prep <bundle.json|transcript.txt> --title T --out DIR [--source-id ID] [--existing NOTE] [--known names.json] [--tags tags.json] [--no-reuse]\n" +
      "       node scripts/phase2/transcript-note.mjs followup DIR --answers answers.json [--alt-summary summary.md] [--subject S]\n" +
      "       node scripts/phase2/transcript-note.mjs render DIR --answers answers.json --overview overview.md --concepts concepts.json --subject S --id ID [--local] [--created DATE]\n"
  );
  process.exit(2);
}

async function prep(args: string[]): Promise<void> {
  const [input] = args;
  const title = option(args, "--title");
  const out = option(args, "--out");
  if (!input || input.startsWith("--") || !title || !out) usage();
  const raw = readFileSync(input, "utf8");
  let segments: TranscriptSegment[];
  let sourceId = option(args, "--source-id") ?? "";
  if (input.endsWith(".json")) {
    const bundle = JSON.parse(raw) as { transcript?: TranscriptSegment[]; sourceId?: string };
    if (!Array.isArray(bundle.transcript)) throw new Error("bundle.json has no transcript");
    segments = bundle.transcript;
    sourceId = sourceId || bundle.sourceId || "";
  } else {
    segments = untimedSegments(raw);
  }
  const existingFile = option(args, "--existing");
  const plan = await planTranscript({
    segments,
    sourceId,
    existing: existingFile ? parseExistingSections(readFileSync(existingFile, "utf8")) : undefined,
    reuse: !args.includes("--no-reuse"),
  });
  if (plan.sections.length === 0) throw new Error("the transcript has no text");
  const context: LectureContext = { title, subjectTags: jsonList(option(args, "--tags")), knownConcepts: jsonList(option(args, "--known")) };
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  writePrivate(join(out, "plan.json"), JSON.stringify({ plan, context } satisfies Saved));
  // The Skill answers in its own session: the schema goes with the instructions.
  writePrivate(join(out, "system.md"), `${buildSectionSystemPrompt()}\n\nJSON schema: ${JSON.stringify(SECTION_SCHEMA)}\n`);
  const contextBlock = buildSectionContextBlock(context, plan);
  const byNum = new Map(plan.sections.map((s) => [s.num, s]));
  const batches = plan.batches.map((b, i) => {
    const file = `batch-${i + 1}.md`;
    writePrivate(join(out, file), buildSectionUserPrompt(contextBlock, b.map((n) => byNum.get(n)!)) + "\n");
    return { file, sections: b };
  });
  const e = estimateTranscriptSummary(plan, context, "", "claude-cli", "claude-cli");
  process.stdout.write(
    JSON.stringify({
      timed: plan.timed,
      durationMs: plan.durationMs,
      sections: plan.sections.map((s) => ({ num: s.num, range: sectionRange(s.startMs, s.endMs), hash: s.hash, mode: s.mode, chars: s.text.length })),
      batches,
      estimate: { calls: e.calls, inputTokens: e.inputTokens, outputTokens: e.outputTokens },
    }) + "\n"
  );
}

/** `key: value` lines of a note's frontmatter (JSON string values decoded); null without a file or block. */
function existingFrontmatter(file: string | undefined): Record<string, unknown> | null {
  if (!file) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const block = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return null;
  const fm: Record<string, unknown> = {};
  for (const line of block[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v: unknown = m[2].trim();
    if (typeof v === "string" && v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        // keep the raw text
      }
    }
    fm[m[1]] = v;
  }
  return fm;
}

function load(dir: string): Saved {
  return JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as Saved;
}

/** Accepted answers of every batch, and a reason per section without one. */
function checked(saved: Saved, answersFile: string): { done: Map<number, { summary: string; gist: string }>; failures: Map<number, string> } {
  const raw: unknown = JSON.parse(readFileSync(answersFile, "utf8"));
  const answers = Array.isArray(raw) ? raw : [raw];
  const done = new Map<number, { summary: string; gist: string }>();
  const failures = new Map<number, string>();
  const byNum = new Map(saved.plan.sections.map((s) => [s.num, s]));
  for (const batch of saved.plan.batches) {
    const sections = batch.map((n) => byNum.get(n)!);
    for (const answer of answers) {
      const { ok, failed } = checkSectionAnswer(answer, sections);
      for (const [n, item] of ok) if (!done.has(n)) done.set(n, item);
      for (const [n, reason] of failed) if (!done.has(n)) failures.set(n, reason);
    }
    for (const n of batch) if (done.has(n)) failures.delete(n);
  }
  return { done, failures };
}

function followup(args: string[]): void {
  const [dir] = args;
  const answers = option(args, "--answers");
  if (!dir || dir.startsWith("--") || !answers) usage();
  const saved = load(dir);
  const { done, failures } = checked(saved, answers);
  const result = assembleSections(saved.plan, done, failures);
  const altSummaryFile = option(args, "--alt-summary");
  const altSummary = altSummaryFile ? readFileSync(altSummaryFile, "utf8") : "";
  writePrivate(
    join(dir, "overview.md"),
    `${buildSectionOverviewSystemPrompt()}\n\n${buildSectionOverviewPrompt(saved.context.title, altSummary, result.gists, saved.plan)}\n`
  );
  const extractor = new ConceptExtractor({} as never, option(args, "--language") === "en" ? "en" : "ko");
  const conceptPrompt = extractor.sectionPrompt({
    subject: option(args, "--subject") ?? "",
    gistLines: sectionGistLines(result.gists, saved.plan),
    linkCandidates: wikilinkCandidates(result.sections.map((s) => s.summary)),
    existingConceptNames: saved.context.knownConcepts,
    subjectTags: saved.context.subjectTags,
  });
  writePrivate(join(dir, "concepts.md"), `${extractor.conceptSystemPrompt()}\n\n${conceptPrompt}\n\nJSON schema: ${JSON.stringify(CONCEPT_SCHEMA)}\n`);
  process.stdout.write(
    JSON.stringify({
      ok: Array.from(done.keys()).sort((a, b) => a - b),
      failed: Array.from(failures.entries()).map(([section, reason]) => ({ section, reason })),
    }) + "\n"
  );
}

function render(args: string[]): void {
  const [dir] = args;
  const answers = option(args, "--answers");
  const overviewFile = option(args, "--overview");
  const conceptsFile = option(args, "--concepts");
  const subject = option(args, "--subject");
  const id = option(args, "--id");
  if (!dir || dir.startsWith("--") || !answers || !overviewFile || !conceptsFile || !subject || !id) usage();
  const saved = load(dir);
  const { done, failures } = checked(saved, answers);
  if (saved.plan.sections.some((x) => x.mode === "llm") && done.size === 0) {
    throw new Error("no section was answered: nothing to write (the plugin keeps the existing note in this case)");
  }
  const result = assembleSections(saved.plan, done, failures);
  const concepts = validateConcepts(JSON.parse(readFileSync(conceptsFile, "utf8")));
  const known = saved.context.knownConcepts;
  const names = normalizeConcepts(concepts.concepts, new Set(known));
  const local = args.includes("--local");
  const { lectureMarkdown } = new NoteGenerator({} as never).generateTranscriptNote(
    {
      title: saved.context.title,
      summary: "",
      pdfUrl: null,
      transcript: null,
      parseQuality: "full",
      metadata: { noteId: id, createdAt: option(args, "--created") ?? null, visibility: null, sourceKind: local ? "alt-local" : "alt-url" },
    },
    { sections: result.sections, errors: result.errors },
    { processedSummary: readFileSync(overviewFile, "utf8"), concepts: names, tags: concepts.tags, subjectSuggestion: subject, knownConceptNames: known },
    subject,
    preservedFrontmatterLines(existingFrontmatter(option(args, "--existing")), local ? "alt-local" : "alt-url", null),
    "alt2obsidian-cc-skill"
  );
  process.stdout.write(lectureMarkdown);
}

async function main(): Promise<void> {
  ensureWebCrypto();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "prep") return prep(rest);
  if (cmd === "followup") return followup(rest);
  if (cmd === "render") return render(rest);
  usage();
}

main().catch((e: unknown) => fail(e, "transcript-note"));
