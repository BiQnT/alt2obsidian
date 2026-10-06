// Skill-side per-slide prompt CLI (spec 4.7): renders the commentary
// prompts the Skill sends with each slide image, from the same prompt files
// and code as tests, so the Skill never formats prompt fragments by hand.
//
// Usage:
//   node scripts/phase2/slide-prompt.mjs <totalSlides> [--concepts names.json]
//        [--prep prep.json | --chunks chunks.json | --transcript transcript.txt]
//   names.json   JSON array of existing concept names (step 4.1)
//   prep.json    the output of prep.mjs: each page's `transcript` (aligned and
//                compressed) is that slide's chunk
//   chunks.json  JSON array, index 0 = slide 1, string or null per slide
//   transcript   the whole transcript, split evenly by characters (1.1.0 rule)
// Prints {"system":"...","slides":[{"slide":1,"user":"..."}, ...]}.

import { readFileSync } from "node:fs";
import { buildSlidePrompt, buildSlideSystemPrompt } from "../../src/prompts/slidePrompt";
import { splitTranscriptEvenly } from "../../src/core/prep/TranscriptCompressor";
import { fail } from "./cli-common";

function main(): void {
  const args = process.argv.slice(2);
  const total = parseInt(args[0] ?? "", 10);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!Number.isInteger(total) || total < 1) {
    process.stderr.write("Usage: node scripts/phase2/slide-prompt.mjs <totalSlides> [--concepts names.json] [--prep prep.json | --chunks chunks.json | --transcript transcript.txt]\n");
    process.exit(2);
  }
  const conceptsFile = flag("--concepts");
  const concepts: unknown = conceptsFile ? JSON.parse(readFileSync(conceptsFile, "utf8")) : [];
  if (!Array.isArray(concepts) || !concepts.every((c) => typeof c === "string")) throw new Error("--concepts must be a JSON array of strings");
  const prepFile = flag("--prep");
  const chunksFile = flag("--chunks");
  const transcriptFile = flag("--transcript");
  let chunks: Array<string | null>;
  if (prepFile) {
    const prep = JSON.parse(readFileSync(prepFile, "utf8")) as { pages?: Array<{ page?: number; transcript?: unknown }> };
    if (!Array.isArray(prep.pages)) throw new Error("--prep must be the JSON printed by prep.mjs");
    chunks = new Array(total).fill(null);
    for (const p of prep.pages) if (typeof p.page === "number" && typeof p.transcript === "string" && p.transcript) chunks[p.page - 1] = p.transcript;
  } else if (chunksFile) {
    const raw: unknown = JSON.parse(readFileSync(chunksFile, "utf8"));
    if (!Array.isArray(raw)) throw new Error("--chunks must be a JSON array");
    chunks = raw.map((c) => (typeof c === "string" ? c : null));
  } else {
    chunks = splitTranscriptEvenly(transcriptFile ? readFileSync(transcriptFile, "utf8") : null, total);
  }
  const slides = Array.from({ length: total }, (_, i) => ({
    slide: i + 1,
    user: buildSlidePrompt(i + 1, total, chunks[i] ?? null, concepts as string[]),
  }));
  process.stdout.write(JSON.stringify({ system: buildSlideSystemPrompt(), slides }) + "\n");
}

try {
  main();
} catch (e) {
  fail(e, "slide-prompt");
}
