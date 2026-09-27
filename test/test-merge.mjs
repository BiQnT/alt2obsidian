/**
 * Test: re-import merge keeps memos on their slides (content-only hash),
 * splices only the overview body, and refuses a single-block downgrade.
 * Run: node test/test-merge.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";

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
async function note(texts, summary = "## 개요\n요약 본문") {
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
    { slides, errors: [], totalWallTimeMs: 0, perSlideWallTimeMs: [] },
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

async function reimport(oldTexts, newTexts) {
  const { vm, files } = makeVault();
  files.set(PATH, addMemos(await note(oldTexts)));
  const next = await note(newTexts);
  const summary = await vm.buildManagedNoteUpdateSummary(PATH, next, []);
  await vm.saveManagedNote(next, PATH);
  return { md: files.get(PATH), summary };
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
  const { vm, files } = makeVault();
  const old = addMemos(await note(["alpha"], "## 옛 개요\n옛 요약"));
  const withUserText = old
    .replace("# lec\n\n", "# lec\n\n내가 쓴 머리말\n\n")
    .replace("<!-- alt2obs:overview end -->\n", "<!-- alt2obs:overview end -->\n\n개요 아래 내 메모\n");
  files.set(PATH, withUserText);
  const next = await note(["alpha"], "## 새 개요\n새 요약");
  const summary = await vm.buildManagedNoteUpdateSummary(PATH, next, []);
  await vm.saveManagedNote(next, PATH);
  const md = files.get(PATH);
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

// A single-block note must not overwrite a page-anchored note.
{
  const { vm, files } = makeVault();
  const old = addMemos(await note(["alpha"]));
  files.set(PATH, old);
  const single = "---\ntitle: x\n---\n<!-- alt2obsidian:start -->\n# lec\n본문\n<!-- alt2obsidian:end -->\n";
  const before = notices.length;
  await assert.rejects(vm.buildManagedNoteUpdateSummary(PATH, single, []), /덮어쓰지 않고/);
  await assert.rejects(vm.saveManagedNote(single, PATH), /덮어쓰지 않고/);
  assert.equal(files.get(PATH), old, "existing note untouched");
  assert.equal(notices.length, before + 2, "a Notice is shown");
  console.log("PASS: single-block downgrade refused with a Notice");
}
