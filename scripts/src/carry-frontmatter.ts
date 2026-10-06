// Skill-side frontmatter carry-over for a re-import (spec 4.10, 2.0.0-beta.6):
// the plugin's preservedFrontmatterLines on the note the import updates, so
// a Skill re-import keeps the other identity (a linked note's alt_id, or
// alt_local_id and alt_source) and a PDF the user attached, exactly like a
// plugin re-import (the merge replaces the whole frontmatter).
//
// Usage: node scripts/phase2/carry-frontmatter.mjs <target note> --local|--url [--alignment "<alt_alignment value>"]
// Prints {"lines":[...],"attachedPdf":"<path>"|null}: the frontmatter lines
// to add to the new note, and the PDF next to the target when it is an
// attached one: the target is marked alt_pdf_source: "attached", or the
// target does not exist yet (use it as the deck and never copy Alt's PDF
// over it). A target that does not exist gives no lines.

import { existsSync } from "node:fs";
import { preservedFrontmatterLines } from "../../src/generator/NoteGenerator";
import { fail, readFrontmatter } from "./cli-common";

function main(): void {
  const args = process.argv.slice(2);
  const [target] = args;
  const local = args.includes("--local");
  if (!target || target.startsWith("--") || local === args.includes("--url")) {
    process.stderr.write('Usage: node scripts/phase2/carry-frontmatter.mjs <target note> --local|--url [--alignment "<value>"]\n');
    process.exit(2);
  }
  const i = args.indexOf("--alignment");
  const alignment = i >= 0 ? args[i + 1] ?? null : null;
  const fm = readFrontmatter(target);
  const stem = target.replace(/\.md$/i, "");
  const pdf = [".pdf", ".PDF", ".Pdf"].map((ext) => stem + ext).find((p) => existsSync(p)) ?? null;
  // Like the plugin: marked, or no note yet (a PDF put there before the first import).
  const attachedPdf = fm?.alt_pdf_source === "attached" || !existsSync(target) ? pdf : null;
  // The mark follows the PDF the import uses: without the attached file it is not carried.
  const lines = preservedFrontmatterLines(fm, local ? "alt-local" : "alt-url", alignment).filter((l) => attachedPdf || !l.startsWith("alt_pdf_source:"));
  process.stdout.write(JSON.stringify({ lines, attachedPdf }) + "\n");
}

try {
  main();
} catch (e) {
  fail(e, "carry-frontmatter");
}
