/**
 * Test: the Skill CLIs lecture-material.mjs, overview-block.mjs,
 * link-concepts.mjs, prep.mjs and verify-prep.mjs produce exactly what the plugin code
 * produces for the same input. (merge-note.mjs is covered by test-merge.mjs, slide-hashes.mjs
 * by test-slide-hash.mjs.)
 * Run: node test/test-skill-clis.mjs [pdfPath]
 *
 * Uses the committed fixture test/fixtures/text-deck.pdf, plus a real deck
 * (the given path, or the first PDF in Alt's local storage) when available.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  // prep: same analysis and plan as the plugin modules, with and without renders.
  const prepMod = await importTs("test/helpers/pipeline-entry.ts");
  async function checkPrep(pdf, label) {
    const transcriptFile = join(dir, "transcript.txt");
    writeFileSync(transcriptFile, "음 오늘은 캐시를 배웁니다. 그러니까 MESI 프로토콜입니다. ".repeat(40));
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 }).promise;
    const layouts = await prepMod.extractPageLayouts(doc);
    await doc.destroy();
    const expectFor = async (grays) => {
      const analysis = await prepMod.analyzeSlides(layouts, grays, { sourceId: "src-1", imageRule: "auto" });
      const plan = prepMod.planDeck({
        ...analysis,
        layouts,
        transcript: readFileSync(transcriptFile, "utf8"),
        transcriptCapChars: 300,
        batchSize: 6,
        deckTitle: "Deck",
      });
      return { plan, analysis };
    };
    const args = [pdf, "src-1", "--title", "Deck", "--transcript", transcriptFile, "--cap", "300", "--batch", "6"];
    const noRender = JSON.parse(cli("prep", [...args, "--no-render"]));
    const exp = await expectFor(layouts.map(() => null));
    assert.deepEqual(noRender.batches, exp.plan.batches.map((b) => b.pages));
    assert.deepEqual(noRender.keyDiagrams, [], "no renders: no key diagrams");
    assert.deepEqual(
      noRender.pages.map((p) => [p.page, p.hash, p.kind, p.dupOf, p.mode, p.transcript]),
      exp.plan.slides.map((s) => [s.page, s.hash, s.kind, s.dupOf, s.mode, s.transcript])
    );
    let rendered = "";
    const pgmDir = join(dir, "pgm");
    try {
      execFileSync("pdftoppm", ["-gray", "-scale-to", "160", pdf, join(pgmDir, "p")], { stdio: "ignore" });
      rendered = "with pdftoppm renders";
    } catch {
      rendered = "";
    }
    if (rendered) {
      const out = JSON.parse(cli("prep", [...args, "--renders", pgmDir]));
      const { parsePgm } = prepMod;
      const grays = layouts.map((_, i) => {
        const f = readdirSync(pgmDir).find((n) => new RegExp(`-0*${i + 1}\\.pgm$`).test(n));
        return f ? parsePgm(new Uint8Array(readFileSync(join(pgmDir, f)))) : null;
      });
      const e2 = await expectFor(grays);
      assert.deepEqual(
        out.pages.map((p) => [p.imageRatio, p.imageSignal, p.kind, p.sendImage]),
        e2.plan.slides.map((s) => [s.imageRatio, s.imageSignal, s.kind, s.sendImage])
      );
      assert.deepEqual(out.keyDiagrams, prepMod.selectKeyDiagrams(e2.plan.slides, e2.plan.scanned), "same key diagram pages");
    }
    console.log(`PASS: prep.mjs matches the plugin prep on ${label} (${noRender.pages.length} pages, ${noRender.batches.length} batches${rendered ? ", " + rendered : ""})`);
  }
  mkdirSync(join(dir, "pgm"), { recursive: true });
  await checkPrep(FIXTURE_PATH, "the fixture deck");

  // prep --bundle: the timestamped transcript of an alt-local.mjs export is
  // aligned to the slides exactly like the plugin does (spec 4.3).
  {
    const lines = [
      "today we start with an introduction to caches",
      "alpha is the first topic, caches are small and fast",
      "cache coherence keeps copies consistent",
      "the MESI protocol has four states for coherence",
      "beta slide shows MESI again, coherence matters",
      "in summary gamma, any questions about the summary",
    ];
    const transcript = lines.flatMap((text, i) => [0, 1, 2].map((k) => ({ startMs: (i * 3 + k) * 5000, endMs: (i * 3 + k) * 5000 + 4800, text, speaker: "" })));
    const bundleFile = join(dir, "bundle.json");
    writeFileSync(bundleFile, JSON.stringify({ sourceId: "local-1", sourceKind: "alt-local", title: "Deck", transcript }));
    const out = JSON.parse(cli("prep", [FIXTURE_PATH, "local-1", "--title", "Deck", "--bundle", bundleFile, "--cap", "300", "--no-render"]));
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(FIXTURE_PATH)), verbosity: 0 }).promise;
    const layouts = await prepMod.extractPageLayouts(doc);
    await doc.destroy();
    const al = prepMod.alignLecture(layouts.map(prepMod.layoutAlignmentText), transcript);
    const analysis = await prepMod.analyzeSlides(layouts, layouts.map(() => null), { sourceId: "local-1", imageRule: "auto" });
    const plan = prepMod.planDeck({ ...analysis, layouts, transcript: lines.join("\n"), transcriptChunks: al.chunks, transcriptCapChars: 300, batchSize: 8, deckTitle: "Deck" });
    assert.equal(out.alignment.value, al.value);
    assert.deepEqual(out.pages.map((p) => p.transcript), plan.slides.map((s) => s.transcript));
    assert.ok(out.alignment.spans.length >= 2, "the lecture moves across slides");
    const noBundle = JSON.parse(cli("prep", [FIXTURE_PATH, "local-1", "--no-render"]));
    assert.equal(noBundle.alignment, null, "no bundle: no alignment");
    console.log(`PASS: prep.mjs --bundle aligns the transcript like the plugin (alt_alignment "${out.alignment.value}")`);

    // verify-prep: the plugin's claims, evidence, judge prompts and note (spec 4.6).
    {
      const v = await importTs("test/helpers/verify-entry.ts");
      const noteFile = join(dir, "my-note.md");
      const note = "# 정리\n- Alpha는 caches 소개로 시작한다\n- MESI coherence protocol은 상태가 네 개다\n- Gamma는 summary와 questions 슬라이드다\n- 양자 얽힘은 무관한 주장이다\n";
      writeFileSync(noteFile, note);
      const out = join(dir, "verify");
      const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(FIXTURE_PATH)), verbosity: 0 }).promise;
      const slideTexts = (await prepMod.extractPageLayouts(doc)).map(prepMod.layoutAlignmentText);
      await doc.destroy();
      const res = JSON.parse(cli("verify-prep", ["prep", FIXTURE_PATH, noteFile, "--lecture", "Deck", "--out", out, "--bundle", bundleFile, "--alignment", al.value]));
      const plan = v.planVerification({
        lecture: "Deck",
        noteMarkdown: note,
        slideTexts,
        transcript: { segments: transcript.map((t) => ({ startMs: t.startMs, endMs: t.endMs, text: t.text })), spans: v.parseAlignment(al.value) },
      });
      const est = v.estimateVerification(plan, "claude-cli");
      assert.equal(res.claims, 4);
      assert.equal(res.scriptOnly, 1);
      assert.equal(res.transcript, true);
      assert.deepEqual(res.estimate, { calls: est.calls, inputTokens: est.inputTokens, outputTokens: est.outputTokens }, "same estimate as the plugin");
      assert.deepEqual(res.batches.map((b) => b.ids), plan.batches.map((b) => b.map((e) => e.claim.id)));
      res.batches.forEach((b, i) => assert.equal(readFileSync(join(out, b.file), "utf8"), v.buildJudgePrompt("Deck", plan.batches[i]) + "\n", "same judge prompt as the plugin"));
      assert.ok(readFileSync(join(out, "system.md"), "utf8").startsWith(v.buildJudgeSystemPrompt()));
      assert.equal(statSync(out).mode & 0o777, 0o700);
      assert.equal(statSync(join(out, "plan.json")).mode & 0o777, 0o600);
      // render: answers checked like the plugin's, the same note.
      const answers = [{ results: plan.judged.map((e, i) => ({ id: e.claim.id, v: i === 0 ? "틀림" : "맞음", r: "근거 확인" })) }];
      writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
      const md = cli("verify-prep", ["render", out, "--answers", join(dir, "answers.json"), "--source", "[[my-note]]", "--model", "Claude Code"]);
      const expected = v.renderVerificationNote(v.resultFromAnswers(plan, answers), { source: "[[my-note]]", date: new Date().toISOString().slice(0, 10), usageLine: null, model: "Claude Code" });
      assert.equal(md, expected);
      assert.match(md, /## ❌ 틀림 \(1\)/);
      writeFileSync(join(dir, "old.md"), md.replace("## 내 메모\n", "## 내 메모\n내가 쓴 줄\n"));
      const again = cli("verify-prep", ["render", out, "--answers", join(dir, "answers.json"), "--source", "[[my-note]]", "--existing", join(dir, "old.md")]);
      assert.ok(again.includes("내가 쓴 줄"));
      console.log(`PASS: verify-prep.mjs matches the plugin verifier (${res.claims} claims, ${res.batches.length} batch, estimate ${res.estimate.inputTokens} input tokens) and renders the same note`);
    }
  }

  const deck = optionalRealDeck();
  if (!deck) {
    console.log("INFO: no real deck available, fixture only");
  } else {
    try {
      await checkMaterial(deck.pdf, "Lecture\n\nvirtual memory page table TLB 가상 메모리", deck.label);
      rmSync(join(dir, "pgm"), { recursive: true, force: true });
      mkdirSync(join(dir, "pgm"));
      await checkPrep(deck.pdf, deck.label);
    } finally {
      deck.cleanup();
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
