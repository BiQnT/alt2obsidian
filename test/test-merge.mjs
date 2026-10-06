/**
 * Test: re-import merge keeps memos on their slides (content-only hash),
 * refreshes only the overview section, and refuses a single-block downgrade.
 * Every scenario also runs the Skill CLI scripts/phase2/merge-note.mjs and
 * checks it produces the same note and change summary as the plugin.
 * Run: node test/test-merge.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";

const { VaultManager, NoteGenerator, computeSlideHash, notices } = await importTs(
  "test/helpers/merge-entry.ts"
);

// In-memory vault with the subset of the Obsidian API VaultManager uses.
function makeVault() {
  const files = new Map();
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (files.has(p) ? { path: p } : null),
      createFolder: async () => {},
      create: async (p, c) => void files.set(p, c),
      read: async (f) => files.get(f.path),
      modify: async (f, c) => void files.set(f.path, c),
    },
  };
  return { vm: new VaultManager(app, "Alt2Obsidian"), files };
}

const PATH = "Alt2Obsidian/S/lec.md";
const altData = {
  title: "lec",
  summary: "",
  transcript: null,
  parseQuality: "full",
  metadata: { noteId: "note-1", createdAt: "" },
};

// Builds a page-anchored note for slide texts, exactly as the plugin does.
async function note(texts, summary = "## 개요\n요약 본문", errors = []) {
  const slides = [];
  for (let i = 0; i < texts.length; i++) {
    slides.push({
      slideNum: i + 1,
      hash: await computeSlideHash(texts[i], i + 1, "note-1"),
      commentary: `해설 ${texts[i]}`,
      citedConcepts: [],
    });
  }
  const { lectureMarkdown } = await new NoteGenerator(null).generatePageAnchored(
    altData,
    { slides, errors, totalWallTimeMs: 0, perSlideWallTimeMs: [] },
    { processedSummary: summary, concepts: [], tags: [], subjectSuggestion: "S" },
    "S"
  );
  return lectureMarkdown;
}

// Writes a memo "memo <text>" under every slide section.
function addMemos(md) {
  return md.replace(
    /\n해설 (\S+)\n(<!-- alt2obs:slide:\d+ hash:[0-9a-f]{8} end -->\n\n> \[!note\] 내 메모\n> )/g,
    (_m, t, tail) => `\n해설 ${t}\n${tail}memo ${t}`
  );
}

// Returns [{slide, commentary, memo}] in document order, plus orphan memos.
function sections(md) {
  const out = [];
  const re = /## 📚 슬라이드 (\d+)\n\n<!-- alt2obs:slide:\d+ hash:[0-9a-f]{8} start -->\n해설 (\S+)\n<!-- alt2obs:slide:\d+ hash:[0-9a-f]{8} end -->\n\n> \[!note\] 내 메모\n> ?(.*)/g;
  let m;
  while ((m = re.exec(md))) out.push({ slide: +m[1], text: m[2], memo: m[3].trim() });
  const orphanIdx = md.indexOf("## 🗑️ 삭제된 슬라이드 (orphan)");
  const orphans = orphanIdx < 0 ? [] : [...md.slice(orphanIdx).matchAll(/memo (\S+)/g)].map((x) => x[1]);
  return { out, orphans };
}

const tmp = mkdtempSync(join(tmpdir(), "merge-test-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
let cliRuns = 0;

// Skill CLI on the same inputs; returns { merged, summary } or { error }.
function mergeCli(existing, next) {
  writeFileSync(join(tmp, "existing.md"), existing);
  writeFileSync(join(tmp, "next.md"), next);
  const args = [join(repo, "scripts/phase2/merge-note.mjs"), join(tmp, "existing.md"), join(tmp, "next.md")];
  try {
    const merged = execFileSync("node", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const summary = JSON.parse(execFileSync("node", [...args, "--summary"], { encoding: "utf8" }));
    return { merged, summary };
  } catch (e) {
    return { error: String(e.stderr) };
  }
}

// Plugin re-import of `next` onto `existing`, checked against the Skill CLI.
async function pluginMerge(existing, next) {
  const { vm, files } = makeVault();
  files.set(PATH, existing);
  const summary = await vm.buildManagedNoteUpdateSummary(PATH, next, []);
  await vm.saveManagedNote(next, PATH);
  const md = files.get(PATH);

  const cli = mergeCli(existing, next);
  assert.equal(cli.error, undefined, `merge-note.mjs failed: ${cli.error}`);
  assert.equal(cli.merged, md, "merge-note.mjs output equals the plugin merge");
  assert.equal(cli.summary.mode, "multi");
  assert.deepEqual(cli.summary.reorders, summary.slideReorders);
  assert.deepEqual(cli.summary.insertions, summary.slideInsertions);
  assert.deepEqual(cli.summary.deletions, summary.slideDeletions);
  assert.deepEqual(cli.summary.drifts, summary.slideDrifts);
  assert.equal(cli.summary.confirmDeckReplacement, summary.confirmDeckReplacement);
  assert.deepEqual(cli.summary.notes, summary.notes ?? []);
  cliRuns++;
  return { md, summary };
}

async function reimport(oldTexts, newTexts) {
  return pluginMerge(addMemos(await note(oldTexts)), await note(newTexts));
}

// Sanity: memos were attached.
{
  const { out } = sections(addMemos(await note(["alpha", "beta", "gamma"])));
  assert.deepEqual(out.map((s) => s.memo), ["memo alpha", "memo beta", "memo gamma"]);
}

// Insert at front: every memo follows its slide, the new slide has none.
{
  const { md, summary } = await reimport(["alpha", "beta", "gamma"], ["fresh", "alpha", "beta", "gamma"]);
  const { out, orphans } = sections(md);
  assert.deepEqual(out, [
    { slide: 1, text: "fresh", memo: "" },
    { slide: 2, text: "alpha", memo: "memo alpha" },
    { slide: 3, text: "beta", memo: "memo beta" },
    { slide: 4, text: "gamma", memo: "memo gamma" },
  ]);
  assert.deepEqual(orphans, []);
  assert.deepEqual(summary.slideInsertions, [1]);
  assert.equal(summary.slideDrifts.length, 0);
  assert.equal(summary.slideReorders.length, 3);
  console.log("PASS: insert at front keeps memos on their slides");
}

// Delete middle: memos of remaining slides follow them, the deleted one is orphaned.
{
  const { md, summary } = await reimport(["alpha", "beta", "gamma"], ["alpha", "gamma"]);
  const { out, orphans } = sections(md);
  assert.deepEqual(out, [
    { slide: 1, text: "alpha", memo: "memo alpha" },
    { slide: 2, text: "gamma", memo: "memo gamma" },
  ]);
  assert.deepEqual(orphans, ["beta"]);
  assert.deepEqual(summary.slideDeletions.map((d) => d.slideNum), [2]);
  assert.equal(summary.slideDrifts.length, 0);
  console.log("PASS: delete middle keeps memos, orphans the deleted slide's memo");
}

// Identical-text pages (animation builds) keep their memos in deck order.
{
  const { md } = await reimport(["same", "same", "end"], ["intro", "same", "same", "end"]);
  const { out } = sections(md);
  assert.deepEqual(out.map((s) => s.memo), ["", "memo same", "memo same", "memo end"]);
  assert.ok(!/dup:/.test(md), "no dup suffix is emitted");
  console.log("PASS: duplicate-text slides pair in deck order");
}

// Overview: only the body between the markers is replaced; user text outside is kept.
{
  const old = addMemos(await note(["alpha"], "## 옛 개요\n옛 요약"));
  const withUserText = old
    .replace("# lec\n\n", "# lec\n\n내가 쓴 머리말\n\n")
    .replace("<!-- alt2obs:overview end -->\n", "<!-- alt2obs:overview end -->\n\n개요 아래 내 메모\n");
  const { md, summary } = await pluginMerge(withUserText, await note(["alpha"], "## 새 개요\n새 요약"));
  assert.ok(md.includes("내가 쓴 머리말"), "user text above the overview kept");
  assert.ok(md.includes("개요 아래 내 메모"), "user text below the overview kept");
  assert.ok(md.includes("### 새 개요\n새 요약"), "new overview body with demoted heading");
  assert.ok(!md.includes("옛 요약"), "old overview body replaced");
  assert.equal(md.match(/<!-- alt2obs:overview start -->/g).length, 1);
  assert.deepEqual(sections(md).out.map((s) => s.memo), ["memo alpha"]);
  // Overview headings are not reported as section changes.
  assert.deepEqual(summary.addedSections, []);
  assert.deepEqual(summary.removedSections, []);
  console.log("PASS: overview body spliced, text outside kept, overview headings not diffed");
}

// 1.x note without an overview block: preamble text kept, overview inserted after the title.
{
  const old = addMemos(await note(["alpha"], ""));
  assert.ok(!old.includes("alt2obs:overview"));
  const withUserText = old.replace("# lec\n\n", "# lec\n\n내가 쓴 머리말\n\n");
  const { md } = await pluginMerge(withUserText, await note(["alpha"], "새 요약"));
  assert.ok(
    md.includes("# lec\n\n## 📋 전체 요약\n\n<!-- alt2obs:overview start -->\n새 요약\n<!-- alt2obs:overview end -->\n\n내가 쓴 머리말\n\n## 📚 슬라이드 1"),
    "overview inserted right after the title, user text kept below it"
  );
  assert.deepEqual(sections(md).out.map((s) => s.memo), ["memo alpha"]);
  console.log("PASS: note without overview block keeps its preamble, overview inserted after title");
}

// Start marker survived but the end marker was deleted: keep text before the heading, replace from there.
{
  const old = addMemos(await note(["alpha"], "옛 요약"));
  const broken = old
    .replace("# lec\n\n", "# lec\n\n내가 쓴 머리말\n\n")
    .replace("<!-- alt2obs:overview end -->\n", "사용자가 지운 끝 마커 뒤 텍스트\n");
  const { md } = await pluginMerge(broken, await note(["alpha"], "새 요약"));
  assert.ok(md.includes("# lec\n\n내가 쓴 머리말\n\n## 📋 전체 요약\n\n<!-- alt2obs:overview start -->\n새 요약\n<!-- alt2obs:overview end -->\n\n## 📚 슬라이드 1"));
  assert.ok(!md.includes("옛 요약"));
  assert.equal(md.match(/<!-- alt2obs:overview start -->/g).length, 1);
  console.log("PASS: overview with a missing end marker is replaced from its heading, text above kept");
}

// New summary empty: the old overview stays and the change summary says so.
{
  const old = addMemos(await note(["alpha"], "옛 요약"));
  const { md, summary } = await pluginMerge(old, await note(["alpha"], ""));
  assert.ok(md.includes("<!-- alt2obs:overview start -->\n옛 요약\n<!-- alt2obs:overview end -->"));
  assert.equal(summary.notes.length, 1);
  assert.match(summary.notes[0], /기존 전체 요약을 그대로/);
  console.log("PASS: empty new summary keeps the old overview and adds a note");
}

// A single-block note must not overwrite a page-anchored note.
{
  const { vm, files } = makeVault();
  const old = addMemos(await note(["alpha"]));
  files.set(PATH, old);
  const single = "---\ntitle: x\n---\n<!-- alt2obsidian:start -->\n# lec\n본문\n<!-- alt2obsidian:end -->\n";
  const before = notices.length;
  await assert.rejects(vm.buildManagedNoteUpdateSummary(PATH, single, []), /덮어쓰지 않고.*PDF 접근을 확인/);
  await assert.rejects(vm.saveManagedNote(single, PATH), /덮어쓰지 않고/);
  assert.equal(files.get(PATH), old, "existing note untouched");
  assert.equal(notices.length, before, "no separate Notice; the caller shows the error once");
  assert.match(mergeCli(old, single).error ?? "", /merge-note: .*덮어쓰지 않고/);
  console.log("PASS: single-block downgrade refused (plugin and merge-note.mjs), error names the cause");
}

// A 1.0.x single-block note migrating to page-anchored keeps all user text as a backup.
{
  const legacy =
    "---\ntitle: lec\n---\nMY INTRO\n\n<!-- alt2obsidian:start -->\n# lec\n본문\n<!-- alt2obsidian:end -->\n\nMY LEGACY MEMO\n";
  const next = await note(["alpha", "beta"]);
  const { md, summary } = await pluginMerge(legacy, next);
  assert.ok(md.startsWith(next.trimEnd()), "new page-anchored note comes first");
  assert.match(md, /\n## 이전 노트 백업\n/);
  assert.ok(md.includes("MY INTRO") && md.includes("MY LEGACY MEMO"), "user text outside the block kept");
  assert.ok(md.includes("본문"), "old managed body kept");
  assert.ok(md.includes("```yaml\n---\ntitle: lec\n---\n```\n\nMY INTRO"), "the old frontmatter is a fenced block in the backup");
  assert.ok((summary.notes ?? []).some((n) => n.includes("이전 노트 백업")), "modal mentions the backup");
  const again = await pluginMerge(legacy.replace("MY INTRO", "MY INTRO\n\n## 이전 노트 백업\n\nolder"), next);
  assert.ok(again.md.includes("older") && again.md.includes("MY LEGACY MEMO"), "an older backup section is kept, not dropped");
  console.log("PASS: 1.0.x single-block note migrating to page-anchored keeps the old note as a backup");
}

// Re-importing an unchanged deck is idempotent (no blank-line growth).
{
  const next = await note(["alpha", "beta", "gamma"]);
  const once = (await pluginMerge(addMemos(next), next)).md;
  const twice = (await pluginMerge(once, next)).md;
  const thrice = (await pluginMerge(twice, next)).md;
  assert.equal(twice, once, "second re-import changes nothing");
  assert.equal(thrice, once, "third re-import changes nothing");
  assert.deepEqual(sections(once).out.map((s) => s.memo), ["memo alpha", "memo beta", "memo gamma"]);
  console.log("PASS: re-importing an unchanged deck is idempotent");
}

// A freshly written note re-imported unchanged is byte for byte the same file.
{
  const fresh = await note(["alpha", "beta", "gamma"]);
  assert.equal((await pluginMerge(fresh, fresh)).md, fresh, "first re-import changes nothing");
  // The failure list is replaced, never kept in the last slide's memo.
  const failing = await note(["alpha", "beta"], "요약", [{ slideNum: 2, reason: "응답에 이 슬라이드가 없음" }, { slideNum: 0, reason: "개념 추출 실패" }]);
  assert.ok(failing.includes("<!-- alt2obs:failures start -->\n## ⚠️ 처리 실패 슬라이드\n\n- 슬라이드 2: 응답에 이 슬라이드가 없음\n- 전체: 개념 추출 실패\n<!-- alt2obs:failures end -->"));
  assert.equal((await pluginMerge(failing, failing)).md, failing);
  const healed = (await pluginMerge(addMemos(failing), await note(["alpha", "beta"], "요약"))).md;
  assert.ok(!healed.includes("처리 실패") && !healed.includes("alt2obs:failures"), "a clean re-import drops the old list");
  assert.deepEqual(sections(healed).out.map((x) => x.memo), ["memo alpha", "memo beta"]);
  // A note saved with CRLF keeps its memos.
  const crlf = (await pluginMerge(addMemos(fresh).replace(/\n/g, "\r\n"), fresh)).md;
  assert.deepEqual(sections(crlf).out.map((x) => x.memo), ["memo alpha", "memo beta", "memo gamma"]);
  assert.ok(!crlf.includes("\r"));
  console.log("PASS: unchanged first re-import is byte-identical; the failure list is replaced; CRLF notes keep their memos; the backed-up frontmatter is fenced");
}

console.log(`PASS: merge-note.mjs matched the plugin merge in all ${cliRuns} merge scenarios`);
