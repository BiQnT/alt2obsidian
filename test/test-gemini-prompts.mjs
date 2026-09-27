/**
 * Test: the per-slide (Gemini/Ollama) commentary path sends exactly the
 * prompts it sent in 1.1.0. The golden file was recorded from the 1.1.0
 * generator before the 2.0 batch path was added.
 * Run: node test/test-gemini-prompts.mjs            (compare)
 *      node test/test-gemini-prompts.mjs --update   (re-record the golden file)
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";

const GOLDEN = join(repo, "test/fixtures/gemini-per-slide-prompts.json");
const { PerSlideCommentaryGenerator } = await importTs("src/generator/PerSlideCommentaryGenerator.ts");

const texts = ["Intro to caches", "Cache coherence MESI", null, "Summary"];
const calls = [];
const llm = {
  name: "FakeGemini",
  maxInputTokens: 1000000,
  estimateTokens: (t) => Math.ceil(t.length / 4),
  generateText: async () => "",
  generateJSON: async () => ({}),
  generateMultimodal: async (prompt, images, options) => {
    calls.push({ prompt, images: images.map((i) => i.pageNum), options });
    return `해설 ${calls.length} [[캐시]]`;
  },
};
const pdfProcessor = {
  getPageCount: async () => texts.length,
  getPageTexts: async () => texts,
  renderPagesToImages: async (_data, pages) => pages.map((pageNum) => ({ pageNum, base64Png: "AAAA" })),
};

const result = await new PerSlideCommentaryGenerator(llm, pdfProcessor).generate(new ArrayBuffer(8), {
  transcript: "음 오늘은 캐시를 배웁니다. 캐시 일관성은 MESI 프로토콜로 유지됩니다. 마지막으로 요약합니다. 질문 있나요?",
  existingConceptNames: ["캐시", "MESI 프로토콜"],
  sourceId: "note-1",
});
const recorded = {
  calls,
  slides: result.slides.map((s) => ({ slideNum: s.slideNum, hash: s.hash, commentary: s.commentary, citedConcepts: s.citedConcepts })),
  errors: result.errors,
};

if (process.argv.includes("--update")) {
  writeFileSync(GOLDEN, JSON.stringify(recorded, null, 2) + "\n");
  console.log(`wrote ${GOLDEN}`);
} else {
  assert.deepEqual(recorded, JSON.parse(readFileSync(GOLDEN, "utf8")));
  console.log(`PASS: per-slide (Gemini) prompts unchanged from 1.1.0 (${calls.length} calls)`);
}
