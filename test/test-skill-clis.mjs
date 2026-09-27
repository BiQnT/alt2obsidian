/**
 * Test: the Skill CLIs lecture-material.mjs, overview-block.mjs and
 * link-concepts.mjs produce exactly what the plugin code produces for the
 * same input. (merge-note.mjs is covered by test-merge.mjs, slide-hashes.mjs
 * by test-slide-hash.mjs.)
 * Run: node test/test-skill-clis.mjs [pdfPath]
 *
 * Uses the committed fixture test/fixtures/text-deck.pdf, plus a real deck
 * (the given path, or the first PDF in Alt's local storage) when available.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";
import { optionalRealDeck } from "./helpers/decks.mjs";
import { FIXTURE_PATH } from "./helpers/synthetic-pdf.mjs";

const cli = (name, args) =>
  execFileSync("node", [join(repo, "scripts/phase2", `${name}.mjs`), ...args], { encoding: "utf8" });
const dir = mkdtempSync(join(tmpdir(), "skill-cli-test-"));

try {
  const { buildOverviewSection, linkConceptNames } = await importTs("src/core/markdown.ts");
  const names = ["캐시", "캐시 일관성 (Cache Coherence)", "$&"];
  writeFileSync(join(dir, "names.json"), JSON.stringify(names));

  // overview-block
  const summary = "# 강의\n## 캐시\n캐시 일관성 (Cache Coherence)과 캐시.\n```\n## code\n```\nSetext\n---\n";
  writeFileSync(join(dir, "summary.md"), summary);
  assert.equal(cli("overview-block", [join(dir, "summary.md"), join(dir, "names.json")]), buildOverviewSection(summary, names));
  assert.equal(cli("overview-block", [join(dir, "summary.md")]), buildOverviewSection(summary, []));
  console.log("PASS: overview-block.mjs matches buildOverviewSection");

  // link-concepts, several files in place
  const bodies = [
    "캐시 일관성 (Cache Coherence)은 [[캐시]]와 캐시 사이 문제. 비용 $&.",
    "> [!definition] 캐시\n> 캐시는 빠른 메모리",
  ];
  const files = bodies.map((b, i) => {
    const f = join(dir, `slide-${i + 1}.md`);
    writeFileSync(f, b);
    return f;
  });
  cli("link-concepts", [join(dir, "names.json"), ...files]);
  files.forEach((f, i) => assert.equal(readFileSync(f, "utf8"), linkConceptNames(bodies[i], names)));
  assert.equal(
    readFileSync(files[0], "utf8"),
    "[[캐시 일관성 (Cache Coherence)]]은 [[캐시]]와 [[캐시]] 사이 문제. 비용 [[$&]]."
  );
  console.log("PASS: link-concepts.mjs matches linkConceptNames");

  // lecture-material
  const { extractLectureMaterialContext } = await importTs("src/core/lectureMaterial.ts");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  async function checkMaterial(pdf, seed, label) {
    writeFileSync(join(dir, "seed.txt"), seed);
    const out = JSON.parse(cli("lecture-material", [pdf, join(dir, "seed.txt")]));
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 }).promise;
    const ctx = await extractLectureMaterialContext(doc, seed);
    await doc.destroy();
    assert.ok(ctx, `${label} has a text layer`);
    assert.deepEqual(out.material, {
      pageCount: ctx.pageCount,
      excerptPageCount: ctx.pages.length,
      excerptScope: ctx.truncated ? "일부 발췌" : "전체 발췌",
      materialText: ctx.text,
    });
    console.log(`PASS: lecture-material.mjs matches the plugin excerpt on ${label} (${ctx.pages.length}/${ctx.pageCount} pages, ${ctx.text.length} chars)`);
    return out.material;
  }
  const fixture = await checkMaterial(FIXTURE_PATH, "Caches\n\ncache coherence MESI", "the fixture deck");
  assert.equal(fixture.pageCount, 5);
  assert.equal(fixture.excerptPageCount, 4, "the image-only page has no excerpt");

  const deck = optionalRealDeck();
  if (!deck) {
    console.log("INFO: no real deck available, fixture only");
  } else {
    try {
      await checkMaterial(deck.pdf, "Lecture\n\nvirtual memory page table TLB 가상 메모리", deck.label);
    } finally {
      deck.cleanup();
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
