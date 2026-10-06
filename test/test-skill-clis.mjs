/**
 * Test: the Skill CLIs lecture-material.mjs, overview-block.mjs,
 * link-concepts.mjs, prep.mjs, verify-prep.mjs and transcript-note.mjs produce
 * exactly what the plugin code produces for the same input. (merge-note.mjs is covered by test-merge.mjs, slide-hashes.mjs
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
    "[[캐시 일관성 (Cache Coherence)]]은 [[캐시]]와 캐시 사이 문제. 비용 [[$&]].",
    "the first mention of each concept per slide file"
  );
  // --known: a link written to an existing note under another name is pointed at that note.
  writeFileSync(join(dir, "known.json"), JSON.stringify(["로터리 스케줄링 (Lottery Scheduling)"]));
  const linkBody = "[[Lottery Scheduling (로터리 스케줄링)|Lottery Scheduling]]은 무작위입니다.";
  const linkFile = join(dir, "slide-k.md");
  writeFileSync(linkFile, linkBody);
  cli("link-concepts", [join(dir, "names.json"), "--known", join(dir, "known.json"), linkFile]);
  assert.equal(readFileSync(linkFile, "utf8"), "[[로터리 스케줄링 (Lottery Scheduling)|Lottery Scheduling]]은 무작위입니다.");
  writeFileSync(join(dir, "summary-k.md"), linkBody);
  assert.equal(
    cli("overview-block", [join(dir, "summary-k.md"), join(dir, "names.json"), "--known", join(dir, "known.json")]),
    buildOverviewSection(linkBody, names, ["로터리 스케줄링 (Lottery Scheduling)"])
  );
  console.log("PASS: link-concepts.mjs matches linkConceptNames (also with --known)");

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
      const named = JSON.parse(cli("prep", [...args, "--renders", pgmDir, "--note-path", "V/C#/Lectures/[OS] 3강.md"]));
      assert.deepEqual(named.keyDiagramFiles.map((f) => f.page), out.keyDiagrams);
      for (const f of named.keyDiagramFiles) {
        assert.equal(f.path, `V/C#/Attachments/OS 3강-${f.page}.png`, "image named after the target note, without [ ] #");
        assert.equal(f.embed, prepMod.formatDiagramEmbed(f.path));
      }
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
      const res = JSON.parse(cli("verify-prep", ["prep", FIXTURE_PATH, noteFile, "--lecture", "Deck", "--out", out, "--note-path", "Vault/S/Lectures/Deck.md", "--bundle", bundleFile, "--alignment", al.value]));
      const plan = v.planVerification({
        lecture: "Deck",
        notePath: "Vault/S/Lectures/Deck.md",
        noteMarkdown: note,
        slideTexts,
        transcript: { segments: transcript.map((t) => ({ startMs: t.startMs, endMs: t.endMs, text: t.text })), spans: v.parseAlignment(al.value) },
      });
      const est = v.estimateVerification(plan, "claude-cli");
      assert.equal(res.claims, 4);
      assert.equal(res.unmatched, 0);
      assert.equal(res.contextEvidence, 1, "the off-topic claim is judged with context evidence");
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
      assert.match(md, /\[\[Vault\/S\/Lectures\/Deck#📚 슬라이드 \d\|Deck · 슬라이드 \d\]\]/, "path-qualified links from --note-path");
      // --existing: a missing file is a first run; anything else unreadable stops.
      assert.ok(cli("verify-prep", ["render", out, "--answers", join(dir, "answers.json"), "--source", "x", "--existing", join(dir, "nope.md")]).includes("alt2obs:verify end"));
      assert.throws(() => execFileSync("node", [join(repo, "scripts/phase2/verify-prep.mjs"), "render", out, "--answers", join(dir, "answers.json"), "--source", "x", "--existing", dir], { stdio: "pipe" }), "a folder as --existing is an error, not a first run");
      writeFileSync(join(dir, "old.md"), md.replace("## 내 메모\n", "## 내 메모\n내가 쓴 줄\n"));
      const again = cli("verify-prep", ["render", out, "--answers", join(dir, "answers.json"), "--source", "[[my-note]]", "--existing", join(dir, "old.md")]);
      assert.ok(again.includes("내가 쓴 줄"));
      console.log(`PASS: verify-prep.mjs matches the plugin verifier (${res.claims} claims, ${res.batches.length} batch, estimate ${res.estimate.inputTokens} input tokens) and renders the same note`);
    }
  }

  // transcript-note: a lecture without slides (spec 4.10), the plugin's
  // sections, prompts, answer checks and note; verify-prep against its sections.
  {
    const t = await importTs("test/helpers/transcript-entry.ts");
    const talk = [];
    for (let ms = 0, i = 0; ms < 40 * 60000; ms += 6000, i++) {
      const topic = ms < 12 * 60000 ? "lexer token regex" : ms < 25 * 60000 ? "parser grammar derivation" : ms < 33 * 60000 ? "first follow nullable" : "lalr merging yacc";
      talk.push({ startMs: ms, endMs: ms + 4800, text: `음 ${topic} 이야기 ${i}번입니다.`, speaker: "" });
    }
    const tb = join(dir, "t-bundle.json");
    writeFileSync(tb, JSON.stringify({ sourceId: "local-t", sourceKind: "alt-local", title: "L9", transcript: talk }));
    writeFileSync(join(dir, "t-known.json"), JSON.stringify(["캐시"]));
    writeFileSync(join(dir, "t-tags.json"), JSON.stringify(["parsing"]));
    const out = join(dir, "tn");
    const res = JSON.parse(cli("transcript-note", ["prep", tb, "--title", "L9", "--out", out, "--known", join(dir, "t-known.json"), "--tags", join(dir, "t-tags.json")]));
    const plan = await t.planTranscript({ segments: talk, sourceId: "local-t" });
    const context = { title: "L9", subjectTags: ["parsing"], knownConcepts: ["캐시"] };
    assert.equal(res.timed, true);
    assert.deepEqual(res.sections.map((x) => [x.num, x.hash, x.mode]), plan.sections.map((x) => [x.num, x.hash, x.mode]));
    assert.deepEqual(res.batches.map((b) => b.sections), plan.batches);
    const byNum = new Map(plan.sections.map((x) => [x.num, x]));
    res.batches.forEach((b, i) =>
      assert.equal(readFileSync(join(out, b.file), "utf8"), t.buildSectionUserPrompt(t.buildSectionContextBlock(context, plan), plan.batches[i].map((n) => byNum.get(n))) + "\n", "same batch prompt as the plugin")
    );
    assert.ok(readFileSync(join(out, "system.md"), "utf8").startsWith(t.buildSectionSystemPrompt()));
    const est = t.estimateTranscriptSummary(plan, context, "", "claude-cli", "claude-cli");
    assert.deepEqual(res.estimate, { calls: est.calls, inputTokens: est.inputTokens, outputTokens: est.outputTokens }, "same estimate as the plugin");
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(join(out, "plan.json")).mode & 0o777, 0o600);
    // followup: the answers checked like the plugin's; the overview and concept prompts from the gists.
    const answers = [{ sections: plan.sections.map((x) => ({ section: x.num, summary: `- 구간 ${x.num}: 캐시 내용 정리 [${t.formatClock(x.startMs)}]\n- ${"설명 ".repeat(12).trim()}`, gist: `구간 ${x.num} 요지다` })) }];
    writeFileSync(join(dir, "t-answers.json"), JSON.stringify(answers));
    const fu = JSON.parse(cli("transcript-note", ["followup", out, "--answers", join(dir, "t-answers.json"), "--subject", "CSED423"]));
    assert.deepEqual(fu, { ok: plan.sections.map((x) => x.num), failed: [] });
    const gists = new Map(plan.sections.map((x) => [x.num, `구간 ${x.num} 요지다`]));
    assert.equal(readFileSync(join(out, "overview.md"), "utf8"), `${t.buildSectionOverviewSystemPrompt()}\n\n${t.buildSectionOverviewPrompt("L9", "", gists, plan)}\n`);
    const conceptPrompt = readFileSync(join(out, "concepts.md"), "utf8");
    assert.ok(conceptPrompt.includes("구간 1 [00:00]: 구간 1 요지다") && conceptPrompt.includes('Cite sections as "구간 3"') && conceptPrompt.includes("JSON schema:"));
    // render: the plugin's NoteGenerator for the same answers.
    writeFileSync(join(dir, "t-overview.md"), "## 흐름\n- lexer에서 parser로 (구간 1~2)");
    const conceptsAnswer = { concepts: [{ name: "Cache (캐시)", definition: "Cache는 자주 쓰는 데이터를 프로세서 가까이에 두는 작고 빠른 메모리다. 접근 지역성을 이용해 평균 접근 시간을 줄인다. 계층마다 크기와 속도가 다르다.", lectureContext: "", example: "", caution: "", relatedConcepts: [] }], tags: ["parsing"] };
    writeFileSync(join(dir, "t-concepts.json"), JSON.stringify(conceptsAnswer));
    const md = cli("transcript-note", ["render", out, "--answers", join(dir, "t-answers.json"), "--overview", join(dir, "t-overview.md"), "--concepts", join(dir, "t-concepts.json"), "--subject", "CSED423", "--id", "local-t", "--local", "--created", "2026-09-30"]);
    const done = new Map(answers[0].sections.map((x) => [x.section, { summary: x.summary, gist: x.gist }]));
    const assembled = t.assembleSections(plan, done, new Map());
    const expected = new t.NoteGenerator(null).generateTranscriptNote(
      { title: "L9", summary: "", pdfUrl: null, transcript: null, parseQuality: "full", metadata: { noteId: "local-t", createdAt: "2026-09-30", visibility: null, sourceKind: "alt-local" } },
      { sections: assembled.sections, errors: assembled.errors },
      { processedSummary: "## 흐름\n- lexer에서 parser로 (구간 1~2)", concepts: t.normalizeConcepts(conceptsAnswer.concepts, ["캐시"]), tags: ["parsing"], subjectSuggestion: "CSED423", knownConceptNames: ["캐시"] },
      "CSED423",
      [],
      "alt2obsidian-cc-skill"
    ).lectureMarkdown;
    assert.equal(md, expected, "the same note as the plugin");
    assert.match(md, /\nsource: "alt2obsidian-cc-skill"\nalt_kind: "transcript"\n/);
    assert.match(md, /\nalt_local_id: "local-t"\nalt_source: "alt-local"\n/);
    // --existing keeps the other identity (a linked note's public alt_id), like the plugin.
    writeFileSync(join(dir, "t-linked.md"), '---\ntitle: "L9"\nalt_id: "pub-9"\nalt_local_id: "local-t"\n---\n# L9\n');
    const linked = cli("transcript-note", ["render", out, "--answers", join(dir, "t-answers.json"), "--overview", join(dir, "t-overview.md"), "--concepts", join(dir, "t-concepts.json"), "--subject", "CSED423", "--id", "local-t", "--local", "--existing", join(dir, "t-linked.md")]);
    assert.match(linked, /\nalt_local_id: "local-t"\nalt_source: "alt-local"\nalt_id: "pub-9"\n---/);
    // Nothing answered: nothing to write.
    writeFileSync(join(dir, "t-empty.json"), "[]");
    assert.throws(() => execFileSync("node", [join(repo, "scripts/phase2/transcript-note.mjs"), "render", out, "--answers", join(dir, "t-empty.json"), "--overview", join(dir, "t-overview.md"), "--concepts", join(dir, "t-concepts.json"), "--subject", "S", "--id", "x"], { stdio: "pipe" }));
    cli("transcript-note", ["followup", out, "--answers", join(dir, "t-answers.json"), "--language", "en"]);
    assert.ok(readFileSync(join(out, "concepts.md"), "utf8").includes("Write all concept fields in clear English."), "--language en");
    // Re-import with --existing: every section reused, nothing to send.
    writeFileSync(join(dir, "t-note.md"), md);
    const again = JSON.parse(cli("transcript-note", ["prep", tb, "--title", "L9", "--out", join(dir, "tn2"), "--existing", join(dir, "t-note.md")]));
    assert.deepEqual([again.sections.every((x) => x.mode === "reuse"), again.batches], [true, []]);
    console.log(`PASS: transcript-note.mjs matches the plugin (${res.sections.length} sections, ${res.batches.length} batch, prompts, answer checks, overview and concept prompts, the note; --existing reuses every section)`);

    // verify-prep "-": a lecture without slides, evidence from the note's sections.
    const vnote = join(dir, "t-my-note.md");
    writeFileSync(vnote, "# 정리\n- lalr merging은 yacc가 쓴다\n- parser grammar derivation은 다루지 않았다\n");
    const vout = join(dir, "tv");
    const vres = JSON.parse(cli("verify-prep", ["prep", "-", vnote, "--lecture", "L9", "--out", vout, "--bundle", tb, "--lecture-note", join(dir, "t-note.md"), "--note-path", "V/S/Lectures/L9.md"]));
    const timed = t.timedSegments(talk);
    const vplan = t.planVerification({ lecture: "L9", notePath: "V/S/Lectures/L9.md", noteMarkdown: readFileSync(vnote, "utf8"), slideTexts: [], transcript: { segments: timed, spans: null }, sections: t.verifySectionsFromNote(md, timed) });
    assert.equal(vres.unit, "section");
    assert.equal(vres.claims, vplan.claims.length);
    vres.batches.forEach((b, i) => assert.equal(readFileSync(join(vout, b.file), "utf8"), t.buildJudgePrompt("L9", vplan.batches[i], "section") + "\n"));
    assert.ok(readFileSync(join(vout, "system.md"), "utf8").startsWith(t.buildJudgeSystemPrompt("section")));
    writeFileSync(join(dir, "tv-answers.json"), JSON.stringify([{ results: vplan.judged.map((e) => ({ id: e.claim.id, v: "맞음", r: "전사 확인" })) }]));
    const vmd = cli("verify-prep", ["render", vout, "--answers", join(dir, "tv-answers.json"), "--source", "[[정리]]"]);
    assert.match(vmd, /\[\[V\/S\/Lectures\/L9#⏱ 구간 \d \d\d \d\d \d\d \d\d\|L9 · 구간 \d\]\] \[\d\d:\d\d\]/);
    assert.throws(() => execFileSync("node", [join(repo, "scripts/phase2/verify-prep.mjs"), "prep", "-", vnote, "--lecture", "L9", "--out", join(dir, "tv2")], { stdio: "pipe" }), "no slides needs the timestamped transcript");
    console.log("PASS: verify-prep.mjs - (no slides) matches the plugin's section verification and links to the section headings");
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
