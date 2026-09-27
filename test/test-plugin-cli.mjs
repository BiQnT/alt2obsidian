/**
 * Test: the plugin's 2.0 CLI import wiring (src/main.ts) end to end, with an
 * in-memory vault, a stubbed PDF renderer and the fake claude (no tokens):
 * 1.x settings migration and CLI default, prepare + estimate, run, note and
 * concept files, usage frontmatter and totals, re-import reusing every
 * unchanged slide, and cancel leaving the vault untouched.
 * Run: node test/test-plugin-cli.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, fakeSession } from "./helpers/fake-cli.mjs";

// pdfjs (bundled via PdfProcessor) warns about missing canvas polyfills on load.
const quiet = { log: console.log, warn: console.warn };
console.log = console.warn = () => {};
const { default: Plugin } = await importTs("src/main.ts");
Object.assign(console, quiet);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeApp() {
  const files = new Map();
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (files.has(p) ? { path: p } : null),
      createFolder: async () => {},
      create: async (p, c) => void files.set(p, c),
      read: async (f) => files.get(f.path),
      modify: async (f, c) => void files.set(f.path, c),
      getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map((path) => ({ path })),
      createBinary: async (p) => void files.set(p, "<binary>"),
      modifyBinary: async (f) => void files.set(f.path, "<binary>"),
      adapter: { getResourcePath: (p) => p },
    },
    metadataCache: {
      getFileCache: (f) => {
        const m = (files.get(f.path) ?? "").match(/^---\n[\s\S]*?tags: \[([^\]]*)\]/);
        return m ? { frontmatter: { tags: m[1].split(",").map((t) => t.trim()) } } : null;
      },
    },
    workspace: { onLayoutReady: () => {} },
  };
  return { app, files };
}

async function makePlugin(saved) {
  const { app, files } = makeApp();
  const plugin = new Plugin();
  let stored = saved;
  Object.assign(plugin, {
    app,
    manifest: { dir: ".obsidian/plugins/alt2obsidian" },
    loadData: async () => stored,
    saveData: async (d) => void (stored = JSON.parse(JSON.stringify(d))),
    registerView: () => {},
    addRibbonIcon: () => {},
    addCommand: () => {},
    addSettingTab: () => {},
  });
  await plugin.onload();
  return { plugin, files, stored: () => stored };
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

const s = fakeSession("ok");
try {
  // Fresh install without a Gemini key: the logged-in Claude CLI becomes the default.
  {
    const fresh = await makePlugin(undefined);
    fresh.plugin.data.settings.claudePath = FAKE_CLAUDE;
    await fresh.plugin.applyCliDefaultOnce();
    assert.deepEqual(fresh.plugin.data.settings.tasks.commentary, { provider: "claude-cli", model: "sonnet", effort: "medium" });
    // Logged out: nothing switches.
    process.env.FAKE_CLAUDE_LOGGED_OUT = "1";
    const loggedOut = await makePlugin(undefined);
    loggedOut.plugin.data.settings.claudePath = FAKE_CLAUDE;
    await loggedOut.plugin.applyCliDefaultOnce();
    assert.equal(loggedOut.plugin.data.settings.tasks.commentary.provider, "gemini");
    await assert.rejects(loggedOut.plugin.switchToClaudeCli(), /로그인되어 있지 않습니다/);
    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
    assert.equal(s.calls().length, 0, "the login check never calls a model");
  }

  // 1.x data with a Gemini key: kept, the switch is only offered (review H2).
  const { plugin, files, stored } = await makePlugin({
    settings: { apiKey: "old-key", provider: "gemini", geminiModel: "gemma-3-27b-it", baseFolderPath: "Alt2Obsidian", language: "ko", rateDelayMs: 5000 },
    recentImports: [],
  });
  assert.equal(plugin.data.pendingCliDefault, true);
  plugin.data.settings.claudePath = FAKE_CLAUDE;
  await plugin.applyCliDefaultOnce();
  assert.equal(plugin.data.settings.tasks.commentary.provider, "gemini", "working Gemini setup kept");
  assert.equal(plugin.data.cliSwitchOffered, true);
  assert.equal(stored().pendingCliDefault, undefined);
  await plugin.switchToClaudeCli();
  assert.equal(plugin.data.settings.tasks.commentary.provider, "claude-cli");
  assert.equal(plugin.data.settings.tasks.concepts.model, "haiku");
  assert.equal(plugin.data.settings.apiKey, "old-key");
  assert.equal(plugin.data.settings.geminiModel, "gemma-3-27b-it");
  assert.equal(plugin.data.cliDetection.claude.version, "2.1.283 (Claude Code)");
  assert.ok(plugin.isCliCommentary());
  plugin.pdfProcessor = pdfStub;
  console.log("PASS: CLI default only without a working setup and after a free login check; 1.x Gemini users get an offer");

  // Prepare: no CLI call, estimate matches the plan.
  const prepared = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311", "midterm");
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
  assert.ok(note.startsWith("---\n"));
  assert.match(note, /alt2obs_usage: \{provider: "Claude CLI sonnet", calls: \d+, input: \d+, cached: \d+, output: \d+, images: 1\}/);
  assert.match(note, /tags: \[csed311, cache, memory, midterm\]/);
  assert.equal((note.match(/<!-- alt2obs:meta img:/g) ?? []).length, 6);
  assert.ok(files.has("Alt2Obsidian/CSED311/Concepts/캐시.md"));
  assert.ok(files.has("Alt2Obsidian/CSED311/Lec7 Caches.pdf"));
  assert.equal(plugin.data.usageTotals.lectures, 1);
  assert.equal(plugin.data.usageTotals.calls, lastUsage.calls);
  assert.deepEqual(plugin.data.settings.recentModels["claude-cli"], ["haiku", "sonnet"]);
  assert.equal(plugin.data.recentImports[0].path, record.path);
  console.log(`PASS: CLI import writes the note (usage frontmatter, meta, tags), concepts and PDF; ${lastUsage.calls} calls recorded`);

  // Re-import of the same deck: every generated slide reused, memo kept.
  files.set(record.path, note.replace("> [!note] 내 메모\n> \n\n## 📚 슬라이드 3", "> [!note] 내 메모\n> 내 메모 유지\n\n## 📚 슬라이드 3"));
  const again = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311", "midterm");
  assert.equal(again.estimate.slidesReused, 6);
  assert.equal(again.estimate.calls, 2, "only overview and concepts");
  const before = s.calls().length;
  let confirmed = null;
  await plugin.runCliImport(again, { onConfirmUpdate: async (sum) => ((confirmed = sum), true) });
  assert.equal(s.calls().length - before, 2);
  assert.equal(confirmed.isUpdate, true);
  assert.equal(confirmed.slideDrifts.length, 0);
  assert.ok(files.get(record.path).includes("내 메모 유지"));
  console.log("PASS: re-import reuses all unchanged slides (2 calls), keeps the memo");

  // Every slide fails: the note is not touched, the error says why, usage is still recorded (review H1, L1).
  {
    // The CLI answers (tokens spent) but never with valid JSON.
    process.env.FAKE_CLI_MODE = "badjson";
    plugin.data.settings.generation.onlyChangedSlides = false;
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
}
