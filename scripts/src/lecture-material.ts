// Skill-side lecture-material excerpt CLI. Produces the variables of
// prompts/summary-enhance-material.md exactly as the plugin computes them
// (src/core/lectureMaterial.ts).
//
// Usage: node scripts/phase2/lecture-material.mjs <pdfPath> <seedTextFile>
// <seedTextFile> holds "<title>\n\n<alt summary>" (the summary as scraped,
// before any enhancement). Prints
// {"material":{"pageCount":N,"excerptPageCount":K,"excerptScope":"...","materialText":"..."}}
// or {"material":null} when the PDF has no text layer.

import { readFile } from "node:fs/promises";
import { extractLectureMaterialContext } from "../../src/core/lectureMaterial";
import { fail, openPdf } from "./node-pdf";

async function main(): Promise<void> {
  const [pdfPath, seedFile] = process.argv.slice(2);
  if (!pdfPath || !seedFile) {
    process.stderr.write("Usage: node scripts/phase2/lecture-material.mjs <pdfPath> <seedTextFile>\n");
    process.exit(2);
  }

  const seedText = await readFile(seedFile, "utf8");
  const pdf = await openPdf(pdfPath);
  try {
    const ctx = await extractLectureMaterialContext(pdf, seedText);
    const material = ctx && {
      pageCount: ctx.pageCount,
      excerptPageCount: ctx.pages.length,
      excerptScope: ctx.truncated ? "일부 발췌" : "전체 발췌",
      materialText: ctx.text,
    };
    process.stdout.write(JSON.stringify({ material }) + "\n");
  } finally {
    await pdf.destroy();
  }
}

main().catch((e: unknown) => fail(e, "lecture-material"));
