/**
 * Test: the Skill CLIs lecture-material.mjs and overview-block.mjs produce
 * exactly what the plugin code produces for the same input.
 * Run: node test/test-skill-clis.mjs [pdfPath]
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";

const cli = (name, args) =>
  execFileSync("node", [join(repo, "scripts/phase2", `${name}.mjs`), ...args], { encoding: "utf8" });
const dir = mkdtempSync(join(tmpdir(), "skill-cli-test-"));

try {
  // overview-block
  const { buildOverviewSection } = await importTs("src/core/markdown.ts");
  const summary = "# 강의\n## 캐시\n캐시 일관성 (Cache Coherence)과 캐시.\n```\n## code\n```\n";
  const names = ["캐시", "캐시 일관성 (Cache Coherence)"];
  writeFileSync(join(dir, "summary.md"), summary);
  writeFileSync(join(dir, "names.json"), JSON.stringify(names));
  assert.equal(cli("overview-block", [join(dir, "summary.md"), join(dir, "names.json")]), buildOverviewSection(summary, names));
  assert.equal(cli("overview-block", [join(dir, "summary.md")]), buildOverviewSection(summary, []));
  console.log("PASS: overview-block.mjs matches buildOverviewSection");

  // lecture-material, on a real deck
  let pdf = process.argv[2];
  if (!pdf) {
    const slides = join(homedir(), "Library/Application Support/alt/data/storage/slides");
    let name;
    try {
      name = readdirSync(slides).find((f) => f.toLowerCase().endsWith(".pdf"));
    } catch {
      // handled below
    }
    if (!name) {
      console.error(`No PDF given and none found in ${slides}. Pass a PDF path.`);
      process.exit(1);
    }
    pdf = join(dir, "deck.pdf");
    copyFileSync(join(slides, name), pdf);
  }
  const seed = "CSED311 Lec16\n\nvirtual memory page table TLB 가상 메모리";
  writeFileSync(join(dir, "seed.txt"), seed);
  const out = JSON.parse(cli("lecture-material", [pdf, join(dir, "seed.txt")]));

  const { extractLectureMaterialContext } = await importTs("src/core/lectureMaterial.ts");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 }).promise;
  const ctx = await extractLectureMaterialContext(doc, seed);
  await doc.destroy();
  assert.ok(ctx, "deck has a text layer");
  assert.deepEqual(out.material, {
    pageCount: ctx.pageCount,
    excerptPageCount: ctx.pages.length,
    excerptScope: ctx.truncated ? "일부 발췌" : "전체 발췌",
    materialText: ctx.text,
  });
  console.log(`PASS: lecture-material.mjs matches the plugin excerpt (${ctx.pages.length}/${ctx.pageCount} pages, ${ctx.text.length} chars)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
