/**
 * Test: the plugin's 2.0 CLI import wiring (src/main.ts) end to end, with an
 * in-memory vault, a stubbed PDF renderer and the fake claude (no tokens):
 * 1.x settings migration and CLI default, prepare + estimate, run, note and
 * concept files, usage frontmatter and totals, re-import reusing every
 * unchanged slide, and cancel leaving the vault untouched.
 * Run: node test/test-plugin-cli.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTs } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, FAKE_CODEX, fakeSession } from "./helpers/fake-cli.mjs";

// pdfjs (bundled via PdfProcessor) warns about missing canvas polyfills on load.
const quiet = { log: console.log, warn: console.warn };
console.log = console.warn = () => {};
const { default: Plugin, TFile, insertFrontmatterLine, notices } = await importTs("test/helpers/plugin-entry.ts");
Object.assign(console, quiet);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Frontmatter of a stored note: `key: "value"` lines and the tags list. */
function frontmatterOf(content) {
  const block = (content ?? "").match(/^---\n([\s\S]*?)\n---/);
  if (!block) return null;
  const fm = {};
  for (const line of block[1].split("\n")) {
    const kv = line.match(/^(\w+): (.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    fm[kv[1]] = kv[1] === "tags" ? v.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()) : v.replace(/^"(.*)"$/, "$1");
  }
  return fm;
}

function makeApp() {
  const files = new Map();
  const config = new Map();
  const tfile = (path) => Object.assign(new TFile(), { path, basename: path.split("/").pop().replace(/\.md$/, "") });
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (files.has(p) ? tfile(p) : null),
      createFolder: async () => {},
      create: async (p, c) => void files.set(p, c),
      read: async (f) => files.get(f.path),
      modify: async (f, c) => void files.set(f.path, c),
      cachedRead: async (f) => files.get(f.path),
      readBinary: async () => new ArrayBuffer(8),
      getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map(tfile),
      createBinary: async (p) => void files.set(p, "<binary>"),
      modifyBinary: async (f) => void files.set(f.path, "<binary>"),
      adapter: {
        getResourcePath: (p) => p,
        exists: async (p) => config.has(p) || [...config.keys()].some((k) => k.startsWith(p + "/")),
        mkdir: async () => {},
        write: async (p, c) => void config.set(p, c),
        read: async (p) => config.get(p),
      },
    },
    metadataCache: {
      on: () => ({}),
      getFileCache: (f) => {
        const fm = frontmatterOf(files.get(f.path));
        return fm ? { frontmatter: fm } : null;
      },
    },
    fileManager: {
      // Obsidian's processFrontMatter, enough for adding one key.
      processFrontMatter: async (f, fn) => {
        const content = files.get(f.path);
        const fm = frontmatterOf(content);
        const before = { ...fm };
        fn(fm);
        const added = Object.keys(fm).filter((k) => !(k in before)).map((k) => `${k}: ${JSON.stringify(fm[k])}`);
        files.set(f.path, content.replace(/\n---\n/, `\n${added.join("\n")}\n---\n`));
      },
    },
    workspace: { onLayoutReady: () => {} },
  };
  return { app, files, config };
}

async function makePlugin(saved) {
  const { app, files, config } = makeApp();
  const plugin = new Plugin();
  let stored = saved;
  Object.assign(plugin, {
    app,
    manifest: { dir: ".obsidian/plugins/alt2obsidian" },
    loadData: async () => stored,
    saveData: async (d) => void (stored = JSON.parse(JSON.stringify(d))),
    registerView: () => {},
    registerEvent: () => {},
    addRibbonIcon: () => {},
    addCommand: () => {},
    addSettingTab: () => {},
    registerEditorExtension: () => {},
  });
  await plugin.onload();
  return { plugin, files, config, stored: () => stored };
}

// Deck: cover, 6 content slides (one visual), closing slide.
const TEXTS = ["Lecture 7 Caches", ...[2, 3, 4, 5, 6, 7].map((i) => (i === 4 ? "" : `Slide ${i}: cache topic ${i} ${"details ".repeat(i)} ${i * 7919}`)), "Thank you"];
function grayFor(i) {
  const img = { width: 160, height: 120, data: new Uint8Array(160 * 120).fill(255) };
  if (i === 3) for (let y = 30; y < 110; y++) for (let x = 10; x < 150; x++) img.data[y * 160 + x] = 60;
  return img;
}
const pdfStub = {
  analyzeForPrep: async () => ({ layouts: TEXTS.map((text) => ({ text, boxes: [] })), grays: TEXTS.map((_, i) => grayFor(i)) }),
  renderPageJpeg: async (_d, page) => ({ pageNum: page, mimeType: "image/png", base64: PNG_1PX }),
  extractLectureMaterialContext: async () => null,
  getPageTexts: async () => TEXTS,
  getPageLayouts: async () => TEXTS.map((text) => ({ text, boxes: [] })),
  renderPagesToImages: async (_d, pages) => pages.map((pageNum) => ({ pageNum, base64Png: PNG_1PX })),
  getPageCount: async () => TEXTS.length,
};
const preview = () => ({
  altData: {
    title: "Lec7 Caches",
    summary: "Alt 요약입니다.",
    pdfUrl: null,
    transcript: "음 오늘은 캐시를 배웁니다. 그러니까 캐시 일관성이 중요합니다. ".repeat(50),
    metadata: { noteId: "note-7", createdAt: null, visibility: null },
    parseQuality: "full",
  },
  pdfData: new ArrayBuffer(8),
  pdfUrl: null,
  suggestedSubject: "CSED311",
});

// Linking adds one frontmatter line as text; everything else stays byte for byte.
assert.equal(insertFrontmatterLine('---\ntitle: "x"\ntags: [a,  b]   # kept\n---\nbody\n', 'alt_local_id: "id"'), '---\ntitle: "x"\ntags: [a,  b]   # kept\nalt_local_id: "id"\n---\nbody\n');
assert.equal(insertFrontmatterLine("body only\n", 'k: "v"'), '---\nk: "v"\n---\nbody only\n');
assert.equal(insertFrontmatterLine("---\n---\nbody", 'k: "v"'), '---\nk: "v"\n---\nbody');
assert.equal(insertFrontmatterLine('---\r\na: 1\r\n---\r\nb', 'k: "v"'), '---\r\na: 1\r\nk: "v"\r\n---\r\nb', "the file's CRLF is reused");
assert.equal(insertFrontmatterLine('\uFEFF---\na: 1\n---\nb', 'k: "v"'), '\uFEFF---\na: 1\nk: "v"\n---\nb', "BOM kept in front");
assert.equal(insertFrontmatterLine('---\na: 1\nalt_local_id:\nb: 2\n---\nx', 'alt_local_id: "id"'), '---\na: 1\nalt_local_id: "id"\nb: 2\n---\nx', "an empty key is filled, not duplicated");
assert.equal(insertFrontmatterLine('---\nalt_local_id: ""\n---\nx', 'alt_local_id: "id"'), '---\nalt_local_id: "id"\n---\nx');
assert.equal(insertFrontmatterLine('---\r\nalt_local_id:\r\nb: 2\r\n---\r\nx', 'alt_local_id: "id"'), '---\r\nalt_local_id: "id"\r\nb: 2\r\n---\r\nx', "CRLF empty key filled");
assert.equal(insertFrontmatterLine('---\nalt_local_id: null\n---\nx', 'alt_local_id: "id"'), '---\nalt_local_id: "id"\n---\nx', "null is empty");
assert.equal(insertFrontmatterLine('---\nalt_local_id: ~\n---\nx', 'alt_local_id: "id"'), '---\nalt_local_id: "id"\n---\nx', "~ is empty");
console.log("PASS: frontmatter line insert keeps the YAML text as it is");

const s = fakeSession("ok");
const cacheRoot = mkdtempSync(join(tmpdir(), "alt2obs-cache-test-"));
try {
  // Fresh install: the Claude CLI table stays when Claude is logged in; no notice.
  {
    const fresh = await makePlugin(undefined);
    fresh.plugin.data.settings.claudePath = FAKE_CLAUDE;
    fresh.plugin.data.settings.codexPath = FAKE_CODEX;
    await fresh.plugin.applyCliDefaultOnce();
    assert.deepEqual(fresh.plugin.data.settings.tasks.commentary, { provider: "claude-cli", model: "sonnet", effort: "medium" });
    assert.equal(fresh.plugin.data.pendingCliDefault, undefined);
    // Claude logged out, Codex installed: the tasks move to Codex.
    process.env.FAKE_CLAUDE_LOGGED_OUT = "1";
    const loggedOut = await makePlugin(undefined);
    loggedOut.plugin.data.settings.claudePath = FAKE_CLAUDE;
    loggedOut.plugin.data.settings.codexPath = FAKE_CODEX;
    const before = notices.length;
    await loggedOut.plugin.applyCliDefaultOnce();
    assert.deepEqual(loggedOut.plugin.data.settings.tasks.commentary, { provider: "codex-cli", model: "", effort: "medium" });
    assert.deepEqual(loggedOut.plugin.data.settings.tasks.concepts, { provider: "codex-cli", model: "", effort: "low" });
    assert.ok(notices.slice(before).some((n) => n.includes("Codex CLI로 설정했습니다")), "the user is told about Codex");
    // Beta data: an Ollama task moves, the task the user set to the Claude CLI stays, and the user hears about the cloud.
    const ollama = await makePlugin({
      settings: {
        settingsVersion: 2,
        tasks: {
          commentary: { provider: "claude-cli", model: "opus", effort: "high" },
          concepts: { provider: "ollama", model: "gemma3:4b", effort: "" },
          alignment: { provider: "none", model: "", effort: "" },
          verification: { provider: "claude-cli", model: "", effort: "" },
        },
      },
    });
    ollama.plugin.data.settings.claudePath = FAKE_CLAUDE;
    ollama.plugin.data.settings.codexPath = FAKE_CODEX;
    const n0 = notices.length;
    await ollama.plugin.applyCliDefaultOnce();
    assert.deepEqual(ollama.plugin.data.settings.tasks.commentary, { provider: "claude-cli", model: "opus", effort: "high" }, "explicit Claude task untouched");
    assert.deepEqual(ollama.plugin.data.settings.tasks.concepts, { provider: "codex-cli", model: "", effort: "low" }, "the Ollama task moved to Codex");
    assert.deepEqual(ollama.plugin.data.settings.tasks.verification, { provider: "claude-cli", model: "sonnet", effort: "medium" }, "empty values filled, provider kept");
    const told = notices.slice(n0);
    assert.ok(told.some((n) => n.includes("Ollama 지원이 끝났습니다") && n.includes("Codex CLI로 옮겼습니다") && n.includes("클라우드")), "Ollama users hear their text goes to a cloud CLI");
    assert.ok(told.some((n) => n.includes("작업 기본값으로 바꿨습니다") && n.includes("노트 검증: 모델 sonnet, effort medium")), "the filled defaults are listed once");
    assert.equal(ollama.stored().pendingFilledNotice, undefined);
    await ollama.plugin.applyCliDefaultOnce();
    assert.equal(notices.length, n0 + 2, "each told once");
    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
    assert.equal(s.calls().length, 0, "the login check never calls a model");
  }

  // 1.x data (Gemini key): the Gemini/Ollama tasks move to the Claude CLI and the user is told once.
  const { plugin, files, config, stored } = await makePlugin({
    settings: { apiKey: "old-key", provider: "gemini", geminiModel: "gemma-3-27b-it", baseFolderPath: "Alt2Obsidian", language: "ko", rateDelayMs: 5000 },
    // 1.x record of a lecture imported with an exam period (exam summaries are gone in 2.0).
    recentImports: [{ url: "u", title: "old", subject: "CSED311", path: "Alt2Obsidian/CSED311/old.md", date: "2026-03-01", parseQuality: "full", examPeriod: "midterm" }],
    cliSwitchOffered: true,
  });
  plugin.cacheRoot = cacheRoot;
  assert.equal(plugin.data.pendingCliDefault, true);
  assert.deepEqual(plugin.data.removedProviderNotice, ["gemini"]);
  assert.equal(plugin.data.cliSwitchOffered, undefined, "the beta.3 switch offer is gone");
  assert.equal(plugin.data.recentImports[0].examPeriod, "midterm", "1.x record with an exam period loads as is");
  assert.equal(typeof plugin.generateExamSummary, "undefined", "exam summary generation removed (spec G5)");
  assert.equal(typeof plugin.importNote, "undefined", "the Gemini/Ollama import path is gone");
  plugin.data.settings.claudePath = FAKE_CLAUDE;
  const noticesBefore = notices.length;
  await plugin.applyCliDefaultOnce();
  assert.deepEqual(plugin.data.settings.tasks.commentary, { provider: "claude-cli", model: "sonnet", effort: "medium" });
  assert.equal(plugin.data.settings.tasks.concepts.model, "haiku");
  assert.ok(notices.slice(noticesBefore).some((n) => n.includes("Gemini API 지원이 끝났습니다") && n.includes("Claude CLI로 옮겼습니다") && !n.includes("클라우드")));
  assert.equal(stored().pendingCliDefault, undefined);
  assert.equal(stored().removedProviderNotice, undefined);
  assert.equal(stored().pendingMovedTasks, undefined);
  await plugin.applyCliDefaultOnce();
  assert.equal(notices.length, noticesBefore + 1, "told once");
  assert.equal(stored().settings.apiKey, "old-key", "1.x values stay in the saved data (rollback)");
  assert.equal(plugin.data.cliDetection.claude.version, "2.1.283 (Claude Code)");
  assert.equal(plugin.data.cliDetection.claude.featuresOk, true);
  delete plugin.data.cliDetection.claude.featuresOk;
  plugin.data.cliDetection.claude.version = "2.1.77 (Claude Code)";
  assert.equal(await plugin.resolveBin("claude"), FAKE_CLAUDE);
  assert.equal(plugin.data.cliDetection.claude.version, "2.1.283 (Claude Code)", "a cached path from before the feature check is checked again");
  assert.equal(plugin.data.cliDetection.claude.featuresOk, true);
  plugin.pdfProcessor = pdfStub;
  console.log("PASS: migration picks Claude CLI (logged in) else Codex CLI after free checks; Gemini/Ollama users are moved and told once");

  // Prepare: no CLI call, estimate matches the plan.
  const prepared = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311");
  assert.equal(s.calls().length, 0, "prepare spends no tokens");
  assert.equal(prepared.estimate.slidesTotal, 8);
  assert.equal(prepared.estimate.slidesGenerated, 6);
  assert.equal(prepared.estimate.imagesSent, 1);
  assert.equal(prepared.estimate.calls, prepared.plan.batches.length + 2);
  const fewer = plugin.reduceImages(prepared);
  assert.equal(fewer.estimate.imagesSent, 1, "the visual slide has no text, so it keeps its image");

  const steps = [];
  let lastUsage = null;
  const record = await plugin.runCliImport(prepared, { onStep: (st) => steps.push(st), onUsage: (u) => (lastUsage = u) });
  assert.deepEqual(steps, ["commentary", "overview", "concepts", "save"]);
  assert.equal(s.calls().length, prepared.estimate.calls, "estimated call count");
  const note = files.get(record.path);
  assert.equal(record.path, "Alt2Obsidian/CSED311/Lectures/Lec7 Caches.md", "2.0 layout: Lectures/ (spec 4.5)");
  assert.ok(note.startsWith("---\n"));
  assert.match(note, /alt2obs_usage: \{provider: "Claude CLI sonnet", calls: \d+, input: \d+, cached: \d+, output: \d+, images: 1\}/);
  assert.match(note, /tags: \[csed311, cache, memory\]/, "no exam period tag (spec G5)");
  assert.equal((note.match(/<!-- alt2obs:meta img:/g) ?? []).length, 6);
  assert.ok(files.has("Alt2Obsidian/CSED311/Concepts/캐시.md"));
  // Key diagram (spec 4.8): the visual slide 4 saved to Attachments/ and embedded inside its managed block.
  assert.deepEqual(prepared.diagramPages, [4]);
  const diagram = "Alt2Obsidian/CSED311/Attachments/Lec7 Caches-4.png";
  assert.ok(files.has(diagram));
  assert.equal((note.match(/!\[\[[^\]]+\.png\]\]/g) ?? []).length, 1);
  assert.match(note, new RegExp(`hash:[0-9a-f]{8} start -->\\n[^]*?\\n\\n!\\[\\[${diagram.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]\\n\\n<!-- alt2obs:meta [^\\n]*\\n<!-- alt2obs:slide:4 hash:[0-9a-f]{8} end -->`));
  assert.ok(files.has("Alt2Obsidian/CSED311/Lectures/Lec7 Caches.pdf"));
  assert.equal(plugin.data.usageTotals.lectures, 1);
  assert.equal(plugin.data.usageTotals.calls, lastUsage.calls);
  assert.deepEqual(plugin.data.settings.recentModels["claude-cli"], ["haiku", "sonnet"]);
  assert.equal(plugin.data.recentImports[0].path, record.path);
  console.log(`PASS: CLI import writes the note (usage frontmatter, meta, tags), concepts and PDF; ${lastUsage.calls} calls recorded`);

  // Re-import of the same deck: every generated slide reused, memo kept.
  files.set(record.path, note.replace("> [!note] 내 메모\n> \n\n## 📚 슬라이드 3", "> [!note] 내 메모\n> 내 메모 유지\n\n## 📚 슬라이드 3"));
  const again = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311");
  assert.equal(again.estimate.slidesReused, 6);
  assert.equal(again.estimate.calls, 2, "only overview and concepts");
  const before = s.calls().length;
  let confirmed = null;
  await plugin.runCliImport(again, { onConfirmUpdate: async (sum) => ((confirmed = sum), true) });
  assert.equal(s.calls().length - before, 2);
  assert.equal(confirmed.isUpdate, true);
  assert.equal(confirmed.slideDrifts.length, 0);
  assert.ok(files.get(record.path).includes("내 메모 유지"));
  assert.equal((files.get(record.path).match(/^alt_id:/gm) ?? []).length, 1, "one alt_id line");
  assert.equal((files.get(record.path).match(/!\[\[[^\]]+\.png\]\]/g) ?? []).length, 1, "the diagram embed is not duplicated by a re-import");
  assert.equal([...files.keys()].filter((k) => k.includes("/Attachments/")).length, 1, "the image is replaced in place");
  // A URL import of a lecture whose 1.x note was never migrated updates that note in place.
  {
    const legacy = "Alt2Obsidian/CSED311/Old Lec.md";
    files.set(legacy, '---\ntitle: "Old Lec"\nalt_id: "note-old"\n---\n# Old Lec\n');
    const pv = preview();
    pv.altData = { ...pv.altData, title: "Old Lec", metadata: { ...pv.altData.metadata, noteId: "note-old" } };
    assert.equal(plugin.resolveNotePath(pv, "CSED311"), legacy, "found by alt_id");
    files.set(legacy, '---\ntitle: "Old Lec"\nsource: "alt2obsidian"\n---\n# Old Lec\n');
    assert.equal(plugin.resolveNotePath(pv, "CSED311"), legacy, "1.x path kept before migration (our note without an id)");
    files.set(legacy, '---\ntitle: "Old Lec"\nsource: "alt2obsidian"\nalt_id: "another-lecture"\n---\n# Old Lec\n');
    assert.equal(plugin.resolveNotePath(pv, "CSED311"), "Alt2Obsidian/CSED311/Lectures/Old Lec.md", "another lecture's 1.x note is never merged into");
    files.set(legacy, "# 내가 쓴 같은 이름의 노트\n");
    assert.equal(plugin.resolveNotePath(pv, "CSED311"), "Alt2Obsidian/CSED311/Lectures/Old Lec.md", "a user's own note is never merged into");
    files.delete(legacy);
    assert.equal(plugin.resolveNotePath(pv, "CSED311"), "Alt2Obsidian/CSED311/Lectures/Old Lec.md");
  }
  console.log("PASS: re-import reuses all unchanged slides (2 calls), keeps the memo");

  // Every slide fails: the note is not touched, the error says why, usage is still recorded (review H1, L1).
  {
    // The CLI answers (tokens spent) but never with valid JSON.
    process.env.FAKE_CLI_MODE = "badjson";
    plugin.data.settings.generation.onlyChangedSlides = false;
    plugin.data.settings.generation.saveKeyDiagrams = false;
    assert.deepEqual((await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311")).diagramPages, [], "setting off: no diagram");
    plugin.data.settings.generation.saveKeyDiagrams = true;
    const warn = console.warn;
    console.warn = () => {};
    const snap = files.get(record.path);
    const callsBefore = plugin.data.usageTotals.calls;
    const failing = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311");
    await assert.rejects(plugin.runCliImport(failing), /하나도 만들지 못해 노트를 저장하지 않았습니다/);
    assert.equal(files.get(record.path), snap);
    console.warn = warn;
    assert.ok(plugin.data.usageTotals.calls > callsBefore, "spent calls are counted");
    // Declining the update modal still records usage.
    process.env.FAKE_CLI_MODE = "ok";
    const before2 = plugin.data.usageTotals.calls;
    await assert.rejects(plugin.runCliImport(await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311"), { onConfirmUpdate: async () => false }), /취소/);
    assert.ok(plugin.data.usageTotals.calls > before2);
    assert.equal(files.get(record.path), snap);
    console.log("PASS: a run with no generated slide writes nothing; usage is recorded even when the update is declined");
  }

  // Alt local note (spec 4.1, 4.3): timestamped transcript aligned to the
  // slides, alt_local_id identity, a same-titled URL import never merged
  // into, one-time link of that note, transcript cached for the viewer.
  {
    process.env.FAKE_CLI_MODE = "ok";
    plugin.data.settings.generation.onlyChangedSlides = true;
    const seg = (i, text) => ({ startMs: i * 5000, endMs: i * 5000 + 4800, text, speaker: "" });
    const talk = [];
    for (const i of [2, 3, 4, 5, 6, 7]) for (let k = 0; k < 8; k++) talk.push(i === 4 ? "look at this diagram here" : `now slide ${i} cache topic ${i} details ${i * 7919}`);
    const bundle = (id) => ({
      sourceId: id,
      sourceKind: "alt-local",
      title: "Lec7 Caches",
      lectureDate: "2026-04-21",
      folderPath: ["CSED311 컴퓨터구조"],
      pdf: new ArrayBuffer(8),
      pdfPath: "/alt/slides/Lec7.pdf",
      slideTexts: null,
      transcript: talk.map((t, i) => seg(i, t)),
      summaryMarkdown: "## 요약\n\n캐시",
      memoMarkdown: "### 슬라이드 2 메모\n\n외우기",
      warnings: [],
    });
    const urlNotePath = record.path;
    const pv = plugin.previewFromBundle(bundle("local-1"));
    assert.equal(pv.suggestedSubject, "CSED311");
    assert.equal(pv.altData.metadata.sourceKind, "alt-local");
    assert.ok(pv.altData.summary.includes("## Alt 메모"));
    const callsBefore = s.calls().length;
    const prep = await plugin.prepareCliImport("", pv, "CSED311");
    assert.equal(s.calls().length, callsBefore, "prepare spends no tokens");
    assert.ok(prep.alignment, "timestamps: aligned");
    assert.equal(prep.notePath, "Alt2Obsidian/CSED311/Lectures/Lec7 Caches (2026-04-21).md", "the URL import with the same title is not merged into");
    const p5 = prep.plan.slides.find((x) => x.page === 5);
    const own = (p5.transcript.match(/slide 5 /g) ?? []).length;
    assert.ok(own >= 6 && !p5.transcript.includes("slide 7") && !p5.transcript.includes("slide 2"), `aligned chunk for slide 5: ${p5.transcript}`);
    const rec = await plugin.runCliImport(prep);
    const local = files.get(rec.path);
    assert.equal(rec.path, prep.notePath);
    assert.equal(rec.altLocalId, "local-1");
    assert.match(local, /alt_local_id: "local-1"\nalt_source: "alt-local"/);
    assert.ok(!/alt_id:/.test(local), "no public id for a local note");
    assert.match(local, /alt_alignment: "(\d+:[\d.]+-[\d.]+\??)( \d+:[\d.]+-[\d.]+\??)*"/);
    assert.ok(files.has("Alt2Obsidian/CSED311/Lectures/Lec7 Caches (2026-04-21).pdf"), "PDF next to the note");
    const cacheFiles = readdirSync(cacheRoot, { recursive: true }).filter((f) => String(f).endsWith("local-1.json"));
    assert.equal(cacheFiles.length, 1, "transcript cached outside the vault");
    const cached = JSON.parse(readFileSync(join(cacheRoot, String(cacheFiles[0])), "utf8"));
    assert.ok(![...config.keys()].some((k) => k.includes("transcripts")), "nothing written under .obsidian");
    assert.equal(cached.segments.length, talk.length);
    assert.deepEqual(await plugin.loadTranscript("local-1").then((t) => t[0]), { startMs: 0, endMs: 4800, text: talk[0] });
    const vault = plugin.vaultLectureNotes();
    assert.deepEqual(plugin.localNoteStatus({ id: "local-1", title: "Lec7 Caches", lectureDate: "2026-04-21" }, vault), { kind: "imported", path: rec.path, changed: null });
    console.log("PASS: local import: aligned chunks, alt_local_id and alt_alignment frontmatter, no merge into a same-titled URL note, transcript cached");

    // Note verification of a user note against this lecture (spec 4.6).
    {
      plugin.data.settings.tasks.verification = { provider: "claude-cli", model: "sonnet", effort: "medium" };
      const src = "노션/7강 정리.md";
      const mine = "# 7강 정리\n- slide 3 cache topic 3 details 23757 (거짓)\n- cache topic 5 details 39595\n- 양자 얽힘은 이 강의와 무관하다\n\n## 내 생각\n- cache topic 6 details 47514 잡음\n";
      files.set(src, mine);
      assert.ok(plugin.verifySourceFiles().includes(src));
      assert.ok(!plugin.verifySourceFiles().includes(rec.path), "lecture notes are targets, not sources");
      assert.ok(plugin.verifyTargets().some((t) => t.path === rec.path));
      files.set("Alt2Obsidian/CSED311/Lectures/Upper.PDF", "<binary>");
      assert.equal(plugin.siblingPdf("Alt2Obsidian/CSED311/Lectures/Upper.md").path, "Alt2Obsidian/CSED311/Lectures/Upper.PDF", "a .PDF sibling is found");
      files.delete("Alt2Obsidian/CSED311/Lectures/Upper.PDF");
      await assert.rejects(plugin.prepareVerification({ targetPath: rec.path, markdown: local, source: "x", sourcePath: rec.path }), /고를 수 없습니다/);
      const n0 = s.calls().length;
      const pv = await plugin.prepareVerification({ targetPath: rec.path, markdown: mine, source: `[[노션/7강 정리]]`, sourcePath: src });
      assert.equal(s.calls().length, n0, "prepare spends no tokens");
      assert.equal(pv.outPath, "Alt2Obsidian/CSED311/Verification/Lec7 Caches (2026-04-21) verification.md");
      assert.equal(pv.estimate.claims, 4);
      assert.equal(pv.estimate.unmatched, 0);
      assert.equal(pv.estimate.contextEvidence, 1, "the off-topic claim is judged with its neighbours' slides");
      assert.ok(pv.plan.hasTranscript, "the cached timestamped transcript and alt_alignment are used");
      const totalsBefore = { ...plugin.data.usageTotals };
      const vr = await plugin.runVerification(pv);
      assert.equal(s.calls().length - n0, pv.estimate.calls, "estimated call count");
      assert.equal(vr.path, pv.outPath);
      assert.equal(files.get(src), mine, "the checked note is never modified");
      assert.equal(vr.counts["틀림"], 1);
      assert.equal(vr.counts["전사 불확실"], 1);
      assert.equal(vr.counts["맞음"], 2);
      const out = files.get(pv.outPath);
      assert.match(out, /verified_source: "\[\[노션\/7강 정리\]\]"/);
      assert.match(out, /\[\[Alt2Obsidian\/CSED311\/Lectures\/Lec7 Caches \(2026-04-21\)#📚 슬라이드 3\|Lec7 Caches \(2026-04-21\) · 슬라이드 3\]\]/, "path-qualified slide link with alias");
      assert.match(out, /근거: .*\[\d\d:\d\d\] \(슬라이드 \d\)/);
      assert.equal(plugin.data.usageTotals.lectures, totalsBefore.lectures, "a verification is not counted as a lecture");
      assert.ok(plugin.data.usageTotals.calls > totalsBefore.calls);
      // Re-run: the user's section below the block is kept.
      files.set(pv.outPath, out.replace("## 내 메모\n", "## 내 메모\n다시 볼 것\n"));
      await plugin.runVerification(await plugin.prepareVerification({ targetPath: rec.path, markdown: mine, source: `[[노션/7강 정리]]`, sourcePath: src }));
      assert.ok(files.get(pv.outPath).includes("다시 볼 것"));
      // Nothing judged (usage limit): the previous result note stays as it is.
      const kept = files.get(pv.outPath);
      process.env.FAKE_CLI_MODE = "limit";
      await assert.rejects(plugin.runVerification(await plugin.prepareVerification({ targetPath: rec.path, markdown: mine, source: "x", sourcePath: src })), /하나도 판정하지 못해/);
      process.env.FAKE_CLI_MODE = "ok";
      assert.equal(files.get(pv.outPath), kept);
      files.delete(src);
      console.log("PASS: verification: sources and targets, estimate without tokens, Verification/<lecture> verification.md written, source untouched, re-run keeps the user's section");
    }

    // Another Alt local note with the URL note's title: offered as a link, linked on confirmation.
    const st = plugin.localNoteStatus({ id: "local-2", title: "Lec7 Caches", lectureDate: "2026-04-21" }, vault);
    assert.equal(st.kind, "link");
    assert.deepEqual(st.candidates.map((c) => c.path), [urlNotePath]);
    const beforeLink = files.get(urlNotePath);
    await plugin.linkLocalNote(urlNotePath, "local-2");
    const linked = files.get(urlNotePath);
    assert.equal(linked.replace('alt_local_id: "local-2"\n', ""), beforeLink, "only alt_local_id added");
    const pv2 = plugin.previewFromBundle(bundle("local-2"));
    assert.equal(plugin.resolveNotePath(pv2, "CSED311"), urlNotePath, "the linked note is updated from now on");
    // With the alignment check on, uncertain spans cost one more (small) call.
    plugin.data.settings.tasks.alignment = { provider: "claude-cli", model: "haiku", effort: "low" };
    const prep2 = await plugin.prepareCliImport("", pv2, "CSED311");
    const low = prep2.alignment.lowSpans.length;
    const n0 = s.calls().length;
    const rec2 = await plugin.runCliImport(prep2, { onConfirmUpdate: async () => true });
    assert.equal(s.calls().length - n0, prep2.estimate.calls, "estimate includes the check call");
    assert.equal(low > 0 ? 1 : 0, s.calls().slice(n0).filter((c) => c.stdin.includes("current guess")).length);
    const updated = files.get(rec2.path);
    assert.match(updated, /alt_id: "note-7"/, "the public id is kept");
    assert.equal((updated.match(/^alt_id:/gm) ?? []).length, 1, "one alt_id line");
    assert.equal((updated.match(/^alt_local_id:/gm) ?? []).length, 1, "one alt_local_id line");
    assert.match(updated, /alt_local_id: "local-2"/);
    assert.ok(updated.includes("내 메모 유지"), "memo kept");
    plugin.data.settings.tasks.alignment = { provider: "none", model: "", effort: "" };
    // A URL re-import of the linked note keeps its local identity and alignment.
    const beforeUrl = files.get(urlNotePath);
    const alignLine = beforeUrl.match(/^alt_alignment: .*$/m)[0];
    const urlPrep = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311");
    const urlRec = await plugin.runCliImport(urlPrep, { onConfirmUpdate: async () => true });
    const afterUrl = files.get(urlRec.path);
    assert.equal(urlRec.path, urlNotePath);
    assert.match(afterUrl, /^alt_id: "note-7"$/m);
    assert.match(afterUrl, /^alt_local_id: "local-2"$/m, "local id kept");
    assert.ok(afterUrl.includes(alignLine), "alignment kept");

    // Sidebar change count on the linked note: the textless slide was hashed
    // with the public id at the URL import; compared by position, it is unchanged.
    const pdfDir = mkdtempSync(join(tmpdir(), "alt2obs-pdf-test-"));
    const pdfFile = join(pdfDir, "deck.pdf");
    writeFileSync(pdfFile, "%PDF stub");
    assert.equal(await plugin.slideChanges(urlNotePath, pdfFile, "local-2"), 0, "textless slide not counted as changed");
    assert.equal(await plugin.localPdfPageCount(pdfFile), TEXTS.length);
    rmSync(pdfDir, { recursive: true, force: true });

    // Transcript cache pruning: ids no longer in the vault go, recent files and kept ids stay.
    const cacheDir = join(cacheRoot, String(readdirSync(cacheRoot)[0]), "transcripts");
    const oldTime = (Date.now() - 2 * 3600 * 1000) / 1000;
    writeFileSync(join(cacheDir, "gone-id.json"), "{}");
    utimesSync(join(cacheDir, "gone-id.json"), oldTime, oldTime);
    utimesSync(join(cacheDir, "local-1.json"), oldTime, oldTime);
    writeFileSync(join(cacheDir, "recent-id.json"), "{}");
    assert.equal(await plugin.pruneTranscriptCache(), 1);
    assert.deepEqual(readdirSync(cacheDir).sort(), ["local-1.json", "local-2.json", "recent-id.json"]);
    assert.equal(statSync(join(cacheDir, "local-1.json")).mode & 0o777, 0o600);
    console.log("PASS: URL re-import keeps alt_local_id and alt_alignment; transcript cache lives outside the vault (0600) and is pruned");

    console.log(`PASS: link offer and confirmed link keep the note and its public id; the optional alignment check (${low} uncertain spans) is estimated and run once`);
  }

  // Unload aborts running jobs (review M2).
  {
    process.env.FAKE_CLI_MODE = "hang";
    const job = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311");
    const run = plugin.runCliImport(job);
    for (let i = 0; i < 50 && s.pids().length < 2; i++) await sleep(100);
    plugin.onunload();
    await assert.rejects(run);
    console.log("PASS: plugin unload aborts a running CLI import");
  }

  // Cancel: the CLI is killed and nothing is written.
  process.env.FAKE_CLI_MODE = "hang";
  const snapshot = files.get(record.path);
  const third = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311");
  const ctrl = new AbortController();
  const run = plugin.runCliImport(third, { signal: ctrl.signal });
  for (let i = 0; i < 50 && s.pids().length < 2; i++) await sleep(100);
  ctrl.abort();
  await assert.rejects(run);
  assert.equal(files.get(record.path), snapshot, "vault unchanged after cancel");
  console.log("PASS: cancel stops the import before anything is written");
} finally {
  s.cleanup();
  rmSync(cacheRoot, { recursive: true, force: true });
}
