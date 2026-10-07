/**
 * Test: the plugin's 2.0 CLI import wiring (src/main.ts) end to end, with an
 * in-memory vault, a stubbed PDF renderer and the fake claude (no tokens):
 * 1.x settings migration and CLI default, prepare + estimate, run, note and
 * concept files, usage frontmatter and totals, re-import reusing every
 * unchanged slide, and cancel leaving the vault untouched.
 * Run: node test/test-plugin-cli.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTs } from "./helpers/bundle-ts.mjs";
import { FAKE_CLAUDE, FAKE_CODEX, fakeSession } from "./helpers/fake-cli.mjs";

// pdfjs (bundled via PdfProcessor) warns about missing canvas polyfills on load.
const quiet = { log: console.log, warn: console.warn };
console.log = console.warn = () => {};
const { default: Plugin, TFile, TFolder, insertFrontmatterLine, notices, SyncedViewerView, VIEW_TYPE_SYNCED_VIEWER } = await importTs("test/helpers/plugin-entry.ts");
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
  // Binary contents by path (PDFs); a path without one reads as 8 zero bytes.
  const binaries = new Map();
  // Paths moved to the trash.
  const trashed = [];
  const tfile = (path) => Object.assign(new TFile(), { path, basename: path.split("/").pop().replace(/\.md$/, "") });
  // A folder holds the files under it (VaultManager lists concept notes this way).
  const tfolder = (path) =>
    Object.assign(new TFolder(), {
      path,
      get children() {
        return [...new Set([...files.keys()].filter((k) => k.startsWith(path + "/")).map((k) => k.slice(path.length + 1).split("/")[0]))].map((name) => ({ name, path: `${path}/${name}` }));
      },
    });
  const app = {
    vault: {
      configDir: ".obsidian",
      on: () => ({}),
      getAbstractFileByPath: (p) => (files.has(p) ? tfile(p) : [...files.keys()].some((k) => k.startsWith(p + "/")) ? tfolder(p) : null),
      createFolder: async () => {},
      create: async (p, c) => void files.set(p, c),
      read: async (f) => files.get(f.path),
      modify: async (f, c) => void files.set(f.path, c),
      // Obsidian's atomic read-modify-write.
      process: async (f, fn) => {
        const next = fn(files.get(f.path));
        files.set(f.path, next);
        return next;
      },
      cachedRead: async (f) => files.get(f.path),
      readBinary: async (f) => binaries.get(f.path) ?? new ArrayBuffer(8),
      getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map(tfile),
      createBinary: async (p, d) => void (files.set(p, "<binary>"), binaries.set(p, d)),
      modifyBinary: async (f, d) => void (files.set(f.path, "<binary>"), binaries.set(f.path, d)),
      // Obsidian's vault.trash(file, true): the system trash (else .trash), recoverable.
      trash: async (f, system) => void (assert.equal(system, true, "the system trash"), trashed.push(f.path), files.delete(f.path), binaries.delete(f.path)),
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
      // Obsidian's trash (the user's trash setting): gone from the vault.
      trashFile: async () => {
        throw new Error("use vault.trash(file, true): the recoverable trash");
      },
      renameFile: async (f, to) => {
        files.set(to, files.get(f.path));
        if (binaries.has(f.path)) binaries.set(to, binaries.get(f.path));
        files.delete(f.path);
        binaries.delete(f.path);
      },
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
  return { app, files, config, binaries, trashed };
}

/** `setup(config)` runs before onload (files in the vault's config folder). */
async function makePlugin(saved, setup) {
  const { app, files, config, binaries, trashed } = makeApp();
  setup?.(config);
  const plugin = new Plugin();
  let stored = saved;
  Object.assign(plugin, {
    app,
    manifest: { dir: ".obsidian/plugins/alt2obs" },
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
  return { plugin, files, config, binaries, trashed, stored: () => stored };
}

// Deck: cover, 6 content slides (one visual), closing slide.
const TEXTS = ["Lecture 7 Caches", ...[2, 3, 4, 5, 6, 7].map((i) => (i === 4 ? "" : `Slide ${i}: cache topic ${i} ${"details ".repeat(i)} ${i * 7919}`)), "Thank you"];
function grayFor(i) {
  const img = { width: 160, height: 120, data: new Uint8Array(160 * 120).fill(255) };
  if (i === 3) for (let y = 30; y < 110; y++) for (let x = 10; x < 150; x++) img.data[y * 160 + x] = 60;
  return img;
}
const pdfStub = {
  // A 3-byte "PDF" has no readable page (an unreadable Alt file).
  analyzeForPrep: async (data) => (data?.byteLength === 3 ? { layouts: [], grays: [] } : { layouts: TEXTS.map((text) => ({ text, boxes: [] })), grays: TEXTS.map((_, i) => grayFor(i)) }),
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

// Rename to Alt2Obs (id alt2obs): the old plugin's data.json is imported once, read only.
{
  const LEGACY_DATA = ".obsidian/plugins/alt2obsidian/data.json";
  const legacy = {
    // 1.x and beta.3 API keys in the old data are left behind.
    settings: { baseFolderPath: "Lectures", settingsVersion: 3, apiKey: "old-key", geminiApiKey: "g-key", claudeApiKey: "c-key", tasks: { commentary: { provider: "codex-cli", model: "", effort: "high" } } },
    recentImports: [{ url: "", title: "L1", subject: "S", path: "Lectures/S/Lectures/L1.md", date: "2026-10-01", parseQuality: "full", altLocalId: "n1" }],
    cliDetection: { codex: { path: "/opt/codex", version: "0.155.1", detectedAt: "2026-10-01T00:00:00.000Z", featuresOk: true } },
    attachedCopies: [{ path: "Lectures/S/Lectures/L1.pdf", size: 3, sha1: "abc" }],
  };
  const legacyText = JSON.stringify(legacy, null, 2);
  const withLegacy = (config) => config.set(LEGACY_DATA, legacyText);
  const imported = await makePlugin(undefined, withLegacy);
  const d = imported.plugin.data;
  assert.equal(d.settings.baseFolderPath, "Lectures", "settings come along");
  assert.deepEqual(d.settings.tasks.commentary, { provider: "codex-cli", model: "", effort: "high" });
  assert.equal(d.recentImports[0].altLocalId, "n1");
  assert.equal(d.cliDetection.codex.path, "/opt/codex");
  assert.deepEqual(d.attachedCopies, legacy.attachedCopies, "attach records come along (the copies stay recoverable)");
  assert.equal(imported.stored().settings.baseFolderPath, "Lectures", "saved as Alt2Obs data right away, so the import happens once");
  assert.equal(imported.stored().pendingRenameNotice, true);
  for (const k of ["apiKey", "geminiApiKey", "claudeApiKey"]) {
    assert.equal(d.settings[k], undefined, `${k} is not imported`);
    assert.equal(imported.stored().settings[k], undefined, `${k} is not saved`);
  }
  assert.equal(imported.config.get(LEGACY_DATA), legacyText, "the old data.json is not changed");
  assert.deepEqual([...imported.config.keys()], [LEGACY_DATA], "nothing written to the config folder");
  // The old plugin is still enabled: one notice that says what came along and to remove it, then a warning per start.
  imported.config.set(".obsidian/community-plugins.json", JSON.stringify(["alt2obsidian", "alt2obs"]));
  imported.config.set(".obsidian/plugins/alt2obsidian/manifest.json", JSON.stringify({ id: "alt2obsidian", name: "Alt2Obsidian" }));
  let n = notices.length;
  await imported.plugin.showRenameNotices();
  assert.equal(notices.length, n + 1);
  assert.ok(notices[n].includes("가져왔습니다") && notices[n].includes("Alt2Obsidian을 끄고 삭제하세요"), notices[n]);
  assert.equal(imported.stored().pendingRenameNotice, undefined, "told once");
  n = notices.length;
  await imported.plugin.showRenameNotices();
  assert.ok(notices.length === n + 1 && notices[n].includes("아직 켜져 있습니다"), "the old plugin enabled: warned on start");
  // While it is enabled, lecture PDFs are left to the old plugin (no race on one tab) and its tabs are not taken over.
  const ws = imported.plugin.app.workspace;
  ws.getMostRecentLeaf = ws.getLeavesOfType = () => {
    throw new Error("no redirect while the old plugin is enabled");
  };
  await imported.plugin.onPdfOpened(Object.assign(new TFile(), { path: "Lectures/S/Lectures/L1.pdf" }));
  assert.equal(await imported.plugin.adoptLegacyLeaves(), 0);
  imported.config.set(".obsidian/community-plugins.json", JSON.stringify(["alt2obs"]));
  n = notices.length;
  await imported.plugin.showRenameNotices();
  assert.equal(notices.length, n, "disabled: nothing to say");
  // Disabled: tabs Obsidian kept under the old view types become the Alt2Obs views with the same state.
  const viewStates = [];
  const oldLeaf = (type, state) => ({ getViewState: () => ({ type, state, pinned: true }), setViewState: async (vs) => void viewStates.push(vs) });
  const oldLeaves = { "alt2obsidian-sidebar": [oldLeaf("alt2obsidian-sidebar", {})], "alt2obsidian-synced-viewer": [oldLeaf("alt2obsidian-synced-viewer", { mdPath: "L/a.md", pdfPath: "L/a.pdf" })] };
  ws.getLeavesOfType = (type) => oldLeaves[type] ?? [];
  assert.equal(await imported.plugin.adoptLegacyLeaves(), 2);
  assert.deepEqual(viewStates, [
    { type: "alt2obs-sidebar", state: {}, pinned: true, active: false },
    { type: "alt2obs-synced-viewer", state: { mdPath: "L/a.md", pdfPath: "L/a.pdf" }, pinned: true, active: false },
  ]);
  // New files copied into the old folder: that folder is Alt2Obs now, not the old plugin.
  imported.config.set(".obsidian/community-plugins.json", JSON.stringify(["alt2obsidian"]));
  imported.config.set(".obsidian/plugins/alt2obsidian/manifest.json", JSON.stringify({ id: "alt2obs", name: "Alt2Obs" }));
  await imported.plugin.showRenameNotices();
  assert.equal(notices.length, n, "no warning for a folder that holds Alt2Obs");

  // Alt2Obs data of its own wins; the old data is not read again.
  const own = await makePlugin({ settings: { baseFolderPath: "Own", settingsVersion: 3 } }, withLegacy);
  assert.equal(own.plugin.data.settings.baseFolderPath, "Own");
  assert.equal(own.plugin.data.pendingRenameNotice, undefined);
  // No old data, or unreadable: a fresh install.
  const fresh = await makePlugin(undefined);
  assert.equal(fresh.plugin.data.settings.baseFolderPath, "Alt2Obsidian", "default folder unchanged by the rename");
  assert.equal(fresh.stored(), undefined, "nothing imported, nothing saved at load");
  // An old data.json that cannot be read: not a fresh install. The user is told, and every
  // start tries again until it reads (then its data replaces what was saved meanwhile) or is gone.
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(" "));
  const broken = await makePlugin(undefined, (config) => config.set(LEGACY_DATA, "{ not json"));
  assert.ok(warned.some((w) => w.includes("could not be read")), "an unreadable old data.json is reported in the console");
  assert.equal(broken.plugin.data.pendingRenameNotice, undefined);
  assert.deepEqual(broken.plugin.data.recentImports, []);
  assert.equal(broken.stored(), undefined, "nothing saved at load");
  assert.equal(broken.plugin.data.legacyImportRetry, true);
  n = notices.length;
  await broken.plugin.showRenameNotices();
  assert.ok(notices.length === n + 1 && notices[n].includes("읽지 못해") && notices[n].includes("다시 시도"), notices[n]);
  broken.plugin.data.settings.language = "en";
  await broken.plugin.savePluginData();
  assert.equal(broken.stored().legacyImportRetry, true, "a later save keeps asking for another try");
  const stillBroken = await makePlugin(broken.stored(), (config) => config.set(LEGACY_DATA, "{ not json"));
  assert.equal(stillBroken.plugin.data.settings.language, "en", "until then the saved data is used");
  assert.equal(stillBroken.plugin.data.legacyImportRetry, true);
  const readable = await makePlugin(broken.stored(), withLegacy);
  console.warn = warn;
  assert.equal(readable.plugin.data.settings.baseFolderPath, "Lectures", "readable now: imported");
  assert.equal(readable.plugin.data.recentImports[0].altLocalId, "n1");
  assert.equal(readable.stored().legacyImportRetry, undefined);
  assert.equal(readable.stored().pendingRenameNotice, true);
  assert.equal(readable.stored().settings.apiKey, undefined);
  const gone = await makePlugin(broken.stored());
  assert.equal(gone.plugin.data.settings.language, "en");
  assert.equal(gone.stored().legacyImportRetry, undefined, "old data gone: nothing left to retry");
  console.log("PASS: rename to Alt2Obs: the old Alt2Obsidian data.json is imported once (read only, without old API keys), the user is told once; an unreadable one is retried on every start; while the old plugin is enabled it is warned about and handles lecture PDFs alone; old view tabs are converted once it is off");
}

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
    // Data written by beta.4: the flag is `true`, no pendingMovedTasks. Claude logged out, Codex found:
    // nothing moves, so the Notice must not claim a move to Codex.
    const beta4 = await makePlugin({
      settings: {
        settingsVersion: 3,
        tasks: {
          commentary: { provider: "claude-cli", model: "sonnet", effort: "medium" },
          concepts: { provider: "claude-cli", model: "haiku", effort: "low" },
          alignment: { provider: "none", model: "", effort: "" },
          verification: { provider: "claude-cli", model: "sonnet", effort: "medium" },
        },
      },
      pendingCliDefault: true,
      removedProviderNotice: true,
    });
    beta4.plugin.data.settings.claudePath = FAKE_CLAUDE;
    beta4.plugin.data.settings.codexPath = FAKE_CODEX;
    const n1 = notices.length;
    await beta4.plugin.applyCliDefaultOnce();
    assert.equal(beta4.plugin.data.settings.tasks.commentary.provider, "claude-cli", "nothing moved");
    const said = notices.slice(n1).join("\n");
    assert.ok(!said.includes("Codex CLI로 옮겼습니다") && said.includes("Claude CLI로 옮겼습니다") && said.includes("Codex CLI로 바꾸세요"), said);
    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
    assert.equal(s.calls().length, 0, "the login check never calls a model");
  }

  // 1.x data (Gemini key): the Gemini/Ollama tasks move to the Claude CLI and the user is told once.
  const { plugin, files, config, binaries, trashed, stored } = await makePlugin({
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
  // The model the CLI actually ran: the alias "sonnet" comes back as its full id.
  assert.match(note, /alt2obs_usage: \{provider: "Claude CLI sonnet", model: "claude-sonnet-5-5", effort: "medium", concept_model: "claude-haiku-4-5-20251001", calls: \d+, input: \d+, cached: \d+, output: \d+, images: 1\}/);
  assert.deepEqual(plugin.data.resolvedModels["claude-cli:sonnet"].id, "claude-sonnet-5-5", "the resolved id is recorded for the dropdowns");
  assert.deepEqual(plugin.data.resolvedModels["claude-cli:haiku"].id, "claude-haiku-4-5-20251001");
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

    // Opening the lecture PDF opens the Synced Viewer for the pair (setting on by default).
    {
      const pdfPath = rec.path.replace(/\.md$/, ".pdf");
      const leaves = [];
      let revealed = null;
      const leaf = (viewType, file = null) => {
        const l = {
          view: { getViewType: () => viewType, file },
          detached: false,
          state: null,
          async setViewState(st) {
            l.state = st;
            l.view = { getViewType: () => st.type };
          },
          detach() {
            l.detached = true;
          },
          async openFile(f) {
            l.view = { getViewType: () => "pdf", file: f };
            await plugin.onPdfOpened(f);
          },
        };
        leaves.push(l);
        return l;
      };
      let active = null;
      const ws = plugin.app.workspace;
      Object.assign(ws, {
        getMostRecentLeaf: () => active,
        getLeavesOfType: (t) => leaves.filter((l) => !l.detached && l.view.getViewType() === t),
        getLeaf: () => (active = leaf("empty")),
        revealLeaf: (l) => (revealed = l),
      });
      const pdf = Object.assign(new TFile(), { path: pdfPath, extension: "pdf" });
      assert.equal(plugin.data.settings.openPdfInViewer, true, "on by default");
      // A lecture PDF opened in a tab: that tab becomes the viewer.
      active = leaf("pdf", pdf);
      await plugin.onPdfOpened(pdf);
      assert.deepEqual(active.state, { type: VIEW_TYPE_SYNCED_VIEWER, active: true, state: { mdPath: rec.path, pdfPath, replacesPdf: true } }, "the PDF step is kept out of the tab history");
      // "PDF만 보기": a plain PDF tab that is not turned back into the viewer.
      await plugin.openNativePdf(pdfPath);
      assert.equal(active.view.getViewType(), "pdf", "the PDF-only tab stays a PDF (no loop)");
      assert.equal(active.state, null);
      // Another lecture PDF opened in that tab is still redirected.
      const otherPdf = Object.assign(new TFile(), { path: "Alt2Obsidian/CSED311/Lectures/Lec7 Caches.pdf" });
      assert.ok(files.has(otherPdf.path) && files.has("Alt2Obsidian/CSED311/Lectures/Lec7 Caches.md"));
      await active.openFile(otherPdf);
      assert.deepEqual(active.state?.state, { mdPath: "Alt2Obsidian/CSED311/Lectures/Lec7 Caches.md", pdfPath: otherPdf.path, replacesPdf: true });
      // A PDF of no lecture note opens as usual.
      files.set("Alt2Obsidian/misc/paper.pdf", "<binary>");
      active = leaf("pdf", Object.assign(new TFile(), { path: "Alt2Obsidian/misc/paper.pdf" }));
      await plugin.onPdfOpened(active.view.file);
      assert.equal(active.state, null, "any other PDF stays a PDF");
      // The pair is already open in a viewer: that tab is shown and the new PDF tab closed.
      const viewerLeaf = leaf("x");
      const viewer = new SyncedViewerView(viewerLeaf);
      viewer.mdPath = rec.path;
      viewer.pdfPath = pdfPath;
      viewerLeaf.view = viewer;
      viewer.getViewType = () => VIEW_TYPE_SYNCED_VIEWER;
      active = leaf("pdf", pdf);
      await plugin.onPdfOpened(pdf);
      assert.equal(active.detached, true, "a tab opened just for this PDF is closed");
      assert.equal(revealed, viewerLeaf);
      // The PDF replaced a note in the user's tab: that tab goes back to the note, it is not closed.
      revealed = null;
      active = leaf("pdf", pdf);
      const prevNote = Object.assign(new TFile(), { path: rec.path });
      active.history = {
        backHistory: [{ state: { type: "markdown", state: { file: rec.path } } }],
        back: async () => {
          active.history.backHistory.pop();
          active.view = { getViewType: () => "markdown", file: prevNote };
          active.wentBack = true;
        },
      };
      await plugin.onPdfOpened(pdf);
      assert.deepEqual([active.detached, active.wentBack, active.view.getViewType()], [false, true, "markdown"], "the tab and its history are kept");
      assert.equal(revealed, viewerLeaf);
      // Turning the setting on later leaves the PDF tabs already open as they are.
      const openBefore = leaf("pdf", pdf);
      plugin.keepOpenPdfTabsPlain();
      active = openBefore;
      await plugin.onPdfOpened(pdf);
      assert.deepEqual([openBefore.state, openBefore.detached], [null, false], "a PDF tab open when the redirect started stays a PDF");
      // Setting off: nothing changes.
      plugin.data.settings.openPdfInViewer = false;
      active = leaf("pdf", pdf);
      await plugin.onPdfOpened(pdf);
      assert.deepEqual([active.state, active.detached], [null, false]);
      plugin.data.settings.openPdfInViewer = true;
      files.delete("Alt2Obsidian/misc/paper.pdf");
      console.log("PASS: opening a lecture PDF opens the Synced Viewer (reusing an open one), PDF-only tabs and other PDFs stay PDFs, setting off does nothing");
    }

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
      // Another model for this verification only (the panel's picker).
      const saved = JSON.stringify(plugin.data.settings.tasks.verification);
      const base = await plugin.prepareVerification({ targetPath: rec.path, markdown: mine, source: `[[노션/7강 정리]]`, sourcePath: src });
      assert.deepEqual(base.task, plugin.data.settings.tasks.verification, "the saved model by default");
      const pvOpus = plugin.withVerifyChoice(base, { provider: "claude-cli", model: "claude-opus-5-5", effort: "low" });
      assert.ok(pvOpus.estimate.outputTokens < base.estimate.outputTokens, "low effort: less output expected");
      const n1 = s.calls().length;
      let ran = "";
      await plugin.runVerification(pvOpus, { onModel: (m) => (ran = m) });
      const vcalls = s.calls().slice(n1);
      assert.ok(vcalls.length > 0 && vcalls.every((c) => c.argv[c.argv.indexOf("--model") + 1] === "claude-opus-5-5"), "the chosen model judges");
      assert.equal(ran, "claude-opus-5-5");
      assert.match(files.get(pv.outPath), /alt2obs_usage: \{provider: "Claude CLI claude-opus-5-5", model: "claude-opus-5-5", effort: "low", /);
      assert.equal(JSON.stringify(plugin.data.settings.tasks.verification), saved, "the setting is unchanged");
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

  // Lectures without slides (spec 4.10): kind, no silent fallback, the
  // summary note and its re-import, verification against the transcript,
  // a PDF attached from the vault (the note becomes a slide note, the memo
  // kept) and from disk.
  {
    process.env.FAKE_CLI_MODE = "ok";
    plugin.data.settings.generation.onlyChangedSlides = true;
    const enc = (t) => new TextEncoder().encode(t).buffer;
    const bytes = (b) => Array.from(new Uint8Array(b));
    // 30 minutes, three topics of ten minutes, a segment every 6 s.
    const talk = [];
    for (let t = 0, i = 0; t < 30 * 60000; t += 6000, i++) {
      const topic = t < 10 * 60000 ? "cache line tag" : t < 20 * 60000 ? "write back policy" : "coherence protocol snooping";
      talk.push({ startMs: t, endMs: t + 4800, text: `음 오늘은 ${topic} 설명 ${i}번입니다.`, speaker: "" });
    }
    const noSlides = (id) => ({ sourceId: id, sourceKind: "alt-local", title: "L9", lectureDate: "2026-09-30", folderPath: ["CSED423: 컴파일러설계"], pdf: null, pdfPath: null, slideTexts: null, transcript: talk, warnings: [] });
    const pv = plugin.previewFromBundle(noSlides("local-9"));
    const notePath = plugin.notePathForLocal({ id: "local-9", title: "L9", lectureDate: "2026-09-30" }, "CSED423");
    assert.equal(notePath, "Alt2Obsidian/CSED423/Lectures/L9.md");
    assert.equal(plugin.lectureKindFor({ altType: "note", hasSlides: false, hasTranscript: true, notePath }), "transcript");
    assert.equal(plugin.lectureKindFor({ altType: "slide", hasSlides: false, hasTranscript: true, notePath }), "slides-missing");
    assert.equal(plugin.lectureKindFor({ altType: "slide", hasSlides: true, hasTranscript: true, notePath }), "slides");
    const n0 = s.calls().length;
    await assert.rejects(plugin.prepareCliImport("", pv, "CSED423"), (e) => e.name === "MissingPdfError" && e.notePath === notePath && e.hasTranscript === true, "no silent fallback without a PDF");
    const prep = await plugin.prepareCliImport("", pv, "CSED423", undefined, { withoutPdf: "summary" });
    assert.equal(s.calls().length, n0, "prepare spends no tokens");
    assert.equal(prep.plan, null);
    assert.equal(prep.pdfSource, null);
    assert.deepEqual(prep.transcriptPlan.sections.map((x) => Math.round(x.startMs / 60000)), [0, 10, 20], "cut where the topic changes");
    assert.equal(prep.estimate.calls, 3);
    const steps = [];
    const rec = await plugin.runCliImport(prep, { onStep: (st) => steps.push(st) });
    assert.deepEqual(steps, ["commentary", "overview", "concepts", "save"]);
    assert.equal(s.calls().length - n0, prep.estimate.calls, "estimated call count");
    const note = files.get(rec.path);
    assert.equal(rec.path, notePath);
    assert.match(note, /^alt_kind: "transcript"$/m);
    assert.match(note, /^alt_local_id: "local-9"$/m);
    assert.ok(!/alt_alignment|slide_count/.test(note), "no alignment, no slides");
    assert.match(note, /\n## ⏱ 구간 1 \[00:00~09:5\d\]\n\n<!-- alt2obs:section:1 hash:[0-9a-f]{8} start -->/);
    assert.match(note, /alt2obs_usage: \{provider: "Claude CLI sonnet", model: "claude-sonnet-5-5"/);
    assert.ok(files.has("Alt2Obsidian/CSED423/Concepts/캐시.md"), "concepts from the section gists");
    assert.equal(rec.pdfPath, undefined);
    assert.ok(!files.has("Alt2Obsidian/CSED423/Lectures/L9.pdf"));
    assert.equal(plugin.vaultLectureNotes().find((v) => v.path === notePath).kind, "transcript");
    // Re-import: every section unchanged (2 calls), the memo kept.
    files.set(notePath, note.replace(/(<!-- alt2obs:section:2 hash:[0-9a-f]{8} end -->\n\n> \[!note\] 내 메모\n> )/, "$1구간 2 메모"));
    const again = await plugin.prepareCliImport("", pv, "CSED423", undefined, { withoutPdf: "summary" });
    assert.deepEqual([again.estimate.sectionsReused, again.estimate.calls], [3, 2]);
    let confirmed = null;
    const n1 = s.calls().length;
    await plugin.runCliImport(again, { onConfirmUpdate: async (sum) => ((confirmed = sum), true) });
    assert.equal(s.calls().length - n1, 2);
    assert.equal(confirmed.unit, "section");
    assert.deepEqual([confirmed.slideDrifts.length, confirmed.slideDeletions.length], [0, 0]);
    assert.ok(files.get(notePath).includes("구간 2 메모"));
    console.log("PASS: a lecture without slides stops before any token unless the user chose 요약 노트; the summary note (3 calls, sections, concepts) and its re-import (2 calls, memo kept)");

    // A PDF put next to the summary note by hand (not attached, so not marked):
    // "요약 노트 다시 만들기" stays a summary import, and a plain import does not use it.
    files.set("Alt2Obsidian/CSED423/Lectures/L9.pdf", "<binary>");
    binaries.set("Alt2Obsidian/CSED423/Lectures/L9.pdf", enc("%PDF-1.7 stray"));
    const keepSummary = await plugin.prepareCliImport("", pv, "CSED423", undefined, { withoutPdf: "summary" });
    assert.deepEqual([keepSummary.plan, keepSummary.pdfSource, !!keepSummary.transcriptPlan], [null, null, true], "the user's choice: a summary note");
    await assert.rejects(plugin.prepareCliImport("", pv, "CSED423"), (e) => e.name === "MissingPdfError", "an unmarked PDF next to a summary note is not the slides");
    files.delete("Alt2Obsidian/CSED423/Lectures/L9.pdf");
    binaries.delete("Alt2Obsidian/CSED423/Lectures/L9.pdf");

    // Verification against the transcript sections (no PDF).
    const vsrc = "노트/L9 정리.md";
    files.set(vsrc, "# L9\n- write back policy를 설명했다\n- coherence protocol snooping은 다루지 않았다 (거짓)\n");
    const vprep = await plugin.prepareVerification({ targetPath: notePath, markdown: files.get(vsrc), source: "[[노트/L9 정리]]", sourcePath: vsrc });
    assert.equal(vprep.plan.unit, "section");
    assert.equal(vprep.plan.sections.length, 3);
    const vres = await plugin.runVerification(vprep);
    const vout = files.get(vprep.outPath);
    assert.match(vout, /\[\[Alt2Obsidian\/CSED423\/Lectures\/L9#⏱ 구간 \d \d\d \d\d \d\d \d\d\|L9 · 구간 \d\]\] \[\d\d:\d\d\]/, "links to the section heading and the time");
    assert.equal(vres.counts["틀림"], 1);
    files.delete(vsrc);
    console.log("PASS: verification of a summary note: transcript sections as evidence, links to 구간 headings with [mm:ss]");

    // Attach from the vault: a non-PDF is refused; a PDF is copied next to the note and the note marked.
    files.set("자료/readme.pdf", "<binary>");
    binaries.set("자료/readme.pdf", enc("hello"));
    await assert.rejects(plugin.attachPdf(notePath, { kind: "vault", path: "자료/readme.pdf" }), /PDF 파일이 아닙니다/);
    assert.ok(!files.has("Alt2Obsidian/CSED423/Lectures/L9.pdf"));
    const pdfBytes = enc("%PDF-1.7\nL9 slides");
    files.set("자료/compiler-L9.pdf", "<binary>");
    binaries.set("자료/compiler-L9.pdf", pdfBytes);
    const beforeAttach = files.get(notePath);
    const att = await plugin.attachPdf(notePath, { kind: "vault", path: "자료/compiler-L9.pdf" });
    assert.deepEqual(att, { pdfPath: "Alt2Obsidian/CSED423/Lectures/L9.pdf", replaced: false, marked: true });
    assert.deepEqual(bytes(binaries.get(att.pdfPath)), bytes(pdfBytes), "the picked PDF's bytes");
    assert.equal(files.get(notePath).replace('alt_pdf_source: "attached"\n', ""), beforeAttach, "one frontmatter line added, nothing else");
    assert.ok(files.has("자료/compiler-L9.pdf"), "the source stays where it was");
    assert.equal(plugin.lectureKindFor({ altType: "note", hasSlides: false, hasTranscript: true, notePath }), "attached");
    // The next import treats it as a slide lecture; the summary note becomes a slide note, nothing lost.
    const conv = await plugin.prepareCliImport("", pv, "CSED423");
    assert.equal(conv.pdfSource, "attached");
    assert.ok(conv.plan && !conv.transcriptPlan);
    assert.ok(conv.alignment, "the timestamped transcript is aligned to the attached slides");
    let convSummary = null;
    const convRec = await plugin.runCliImport(conv, { onConfirmUpdate: async (sum) => ((convSummary = sum), true) });
    const converted = files.get(notePath);
    const convFm = converted.slice(0, converted.indexOf("\n---\n", 4));
    assert.match(convFm, /\nalt_pdf_source: "attached"(\n|$)/);
    assert.match(convFm, /\nalt_alignment: "/);
    assert.ok(!/\nalt_kind:/.test(convFm), "no longer a summary note");
    assert.match(converted, /\n## 📚 슬라이드 2\n/);
    assert.ok(converted.includes("## 이전 노트 백업") && converted.includes("구간 2 메모"), "the old note and the memo kept");
    assert.ok(convSummary.notes.some((x) => x.includes("전사 구간 요약 노트를 슬라이드별 노트로")));
    assert.equal(convRec.pdfPath, "Alt2Obsidian/CSED423/Lectures/L9.pdf");
    assert.deepEqual(bytes(binaries.get(convRec.pdfPath)), bytes(pdfBytes), "still the attached PDF");
    assert.equal((await plugin.prepareCliImport("", pv, "CSED423")).pdfSource, "attached", "remembered for later imports");
    // Verification of the converted note compares with the slides (its old summary note sits in the backup).
    files.set(vsrc, "# L9\n- slide 3 cache topic 3 details 23757\n");
    const vconv = await plugin.prepareVerification({ targetPath: notePath, markdown: files.get(vsrc), source: "x", sourcePath: vsrc });
    assert.equal(vconv.plan.unit, "slide", "a slide note is checked against its slides");
    files.delete(vsrc);
    // Alt gets the slides later: the attached PDF still wins, the estimate says so,
    // and "Alt 슬라이드로 바꾸기" (only the frontmatter line goes) switches the next import to Alt's.
    const withAlt = plugin.previewFromBundle({ ...noSlides("local-9"), pdf: new ArrayBuffer(8), pdfPath: "/alt/L9.pdf" });
    const still = await plugin.prepareCliImport("", withAlt, "CSED423");
    assert.deepEqual([still.pdfSource, still.altPdfIgnored], ["attached", true]);
    assert.equal(plugin.lectureKindFor({ altType: "slide", hasSlides: true, hasTranscript: true, notePath }), "attached");
    const beforeSwitch = files.get(notePath);
    const sw = await plugin.useAltSlides(notePath);
    assert.equal(files.get(notePath), beforeSwitch.replace('alt_pdf_source: "attached"\n', ""), "only the mark is removed");
    assert.deepEqual(sw, { pdfPath: "Alt2Obsidian/CSED423/Lectures/L9.pdf", trashed: true, keptAt: null }, "the attached copy goes to the trash before Alt's PDF is written there");
    assert.ok(trashed.includes("Alt2Obsidian/CSED423/Lectures/L9.pdf") && files.has("자료/compiler-L9.pdf"), "the user's original stays");
    const switched = await plugin.prepareCliImport("", withAlt, "CSED423");
    assert.deepEqual([switched.pdfSource, switched.altPdfIgnored], ["alt", false], "the next import uses Alt's slides");
    assert.equal(plugin.lectureKindFor({ altType: "slide", hasSlides: true, hasTranscript: true, notePath }), "slides");
    // "첨부 해제": the attached PDF to the trash and the mark gone; the lecture has no slides again.
    await plugin.attachPdf(notePath, { kind: "disk", name: "again.pdf", data: pdfBytes });
    assert.match(files.get(notePath).slice(0, files.get(notePath).indexOf("\n---\n", 4)), /\nalt_pdf_source: "attached"(\n|$)/);
    await plugin.detachPdf(notePath);
    assert.ok(!files.has("Alt2Obsidian/CSED423/Lectures/L9.pdf") && trashed.filter((p) => p.endsWith("/L9.pdf")).length === 2, "the attached copy is in the (system) trash");
    const fmText = (t) => t.slice(0, t.indexOf("\n---\n", 4));
    assert.ok(!/alt_pdf_source/.test(fmText(files.get(notePath))), "the mark is gone from the frontmatter (the backed-up old note may still mention it)");
    assert.equal(plugin.lectureKindFor({ altType: "note", hasSlides: false, hasTranscript: true, notePath }), "transcript");
    await assert.rejects(plugin.prepareCliImport("", pv, "CSED423"), (e) => e.name === "MissingPdfError");
    // The user's own vault file already at <note>.pdf, attached in place (no copy): never trashed.
    const own = "Alt2Obsidian/CSED423/Lectures/L9.pdf";
    files.set(own, "<binary>");
    binaries.set(own, enc("%PDF-1.7 my own scan"));
    await plugin.attachPdf(notePath, { kind: "vault", path: own });
    assert.equal(await plugin.attachedPdfIsCopy(notePath), false, "no copy was made: not a plugin copy");
    const before = trashed.length;
    assert.deepEqual(await plugin.detachPdf(notePath), { pdfPath: own, trashed: false, keptAt: own }, "only the mark goes");
    assert.ok(files.has(own) && trashed.length === before, "the user's file stays where it is");
    // "Alt 슬라이드로 바꾸기" with the user's own file: renamed out of the way, never overwritten or trashed.
    await plugin.attachPdf(notePath, { kind: "vault", path: own });
    const kept = await plugin.useAltSlides(notePath);
    assert.deepEqual(kept, { pdfPath: own, trashed: false, keptAt: "Alt2Obsidian/CSED423/Lectures/L9 (첨부한 PDF).pdf" });
    assert.ok(!files.has(own) && bytes(binaries.get(kept.keptAt)).length === enc("%PDF-1.7 my own scan").byteLength && trashed.length === before);
    // Only a recorded, unchanged plugin copy is ever trashed (size and SHA-1 at copy time).
    const copyPath = "Alt2Obsidian/CSED423/Lectures/L9.pdf";
    // A copy the user changed afterwards (annotations): kept.
    await plugin.attachPdf(notePath, { kind: "disk", name: "c1.pdf", data: pdfBytes });
    assert.equal(await plugin.attachedPdfIsCopy(notePath), true);
    binaries.set(copyPath, enc("%PDF-1.7\nL9 slides, with my highlights"));
    assert.equal(await plugin.attachedPdfIsCopy(notePath), false, "hash mismatch");
    assert.deepEqual(await plugin.detachPdf(notePath), { pdfPath: copyPath, trashed: false, keptAt: copyPath }, "a modified copy is kept");
    assert.ok(files.has(copyPath));
    // The user's own file moved into the PDF's place (no record for it): never trashed.
    files.delete(copyPath);
    binaries.delete(copyPath);
    await plugin.attachPdf(notePath, { kind: "disk", name: "c2.pdf", data: pdfBytes });
    files.delete(copyPath);
    files.set("내 자료/L9 원본.pdf", "<binary>");
    binaries.set("내 자료/L9 원본.pdf", enc("%PDF-1.7 my original"));
    await plugin.app.fileManager.renameFile({ path: "내 자료/L9 원본.pdf" }, copyPath);
    await plugin.onVaultRename({ path: copyPath }, "내 자료/L9 원본.pdf");
    assert.deepEqual(await plugin.useAltSlides(notePath), { pdfPath: copyPath, trashed: false, keptAt: "Alt2Obsidian/CSED423/Lectures/L9 (첨부한 PDF 2).pdf" }, "renamed out of the way (a free name), never trashed");
    assert.deepEqual(bytes(binaries.get("Alt2Obsidian/CSED423/Lectures/L9 (첨부한 PDF 2).pdf")), bytes(enc("%PDF-1.7 my original")));
    // A recorded copy moved with its note (a folder rename) is still recognised there, and trashed.
    files.delete("Alt2Obsidian/CSED423/Lectures/L9 (첨부한 PDF).pdf");
    files.delete("Alt2Obsidian/CSED423/Lectures/L9 (첨부한 PDF 2).pdf");
    await plugin.attachPdf(notePath, { kind: "disk", name: "c3.pdf", data: pdfBytes });
    const movedNote = "Alt2Obsidian/CSED423/Moved/L9.md";
    for (const [from, to] of [[notePath, movedNote], [copyPath, "Alt2Obsidian/CSED423/Moved/L9.pdf"]]) {
      files.set(to, files.get(from));
      if (binaries.has(from)) binaries.set(to, binaries.get(from));
      files.delete(from);
      binaries.delete(from);
    }
    await plugin.onVaultRename({ path: "Alt2Obsidian/CSED423/Moved" }, "Alt2Obsidian/CSED423/Lectures");
    const n3 = trashed.length;
    assert.deepEqual(await plugin.detachPdf(movedNote), { pdfPath: "Alt2Obsidian/CSED423/Moved/L9.pdf", trashed: true, keptAt: null });
    assert.equal(trashed.length, n3 + 1);
    // Data from an earlier beta.6 build: its in-place list means "never trash", even with a matching record.
    await plugin.attachPdf(movedNote, { kind: "disk", name: "c4.pdf", data: pdfBytes });
    plugin.data.attachedInPlace = ["Alt2Obsidian/CSED423/Moved/L9.pdf"];
    assert.equal((await plugin.detachPdf(movedNote)).trashed, false);
    // Records of files that are gone are pruned.
    plugin.data.attachedCopies.push({ path: "gone/x.pdf", size: 1, sha1: "00" });
    await plugin.pruneAttachRecords();
    assert.ok(!plugin.data.attachedCopies.some((c) => c.path === "gone/x.pdf"));
    for (const [from, to] of [[movedNote, notePath], ["Alt2Obsidian/CSED423/Moved/L9.pdf", copyPath]]) {
      files.set(to, files.get(from));
      binaries.set(to, binaries.get(from));
      files.delete(from);
      binaries.delete(from);
    }
    plugin.data.attachedInPlace = [];
    await plugin.detachPdf(notePath);
    files.delete(copyPath);
    // Before the first import, a PDF attached next to the future note wins over Alt's and the estimate says so.
    const fresh = plugin.previewFromBundle({ ...noSlides("local-10"), title: "L10", pdf: new ArrayBuffer(8), pdfPath: "/alt/L10.pdf" });
    await plugin.attachPdf("Alt2Obsidian/CSED423/Lectures/L10.md", { kind: "disk", name: "l10.pdf", data: pdfBytes });
    const pre = await plugin.prepareCliImport("", fresh, "CSED423");
    assert.deepEqual([pre.pdfSource, pre.altPdfIgnored], ["attached", true], "the user's file, not silently overwritten by Alt's");
    // "요약 노트 만들기" is the user's explicit choice: no PDF, attached or Alt's.
    const chosen = await plugin.prepareCliImport("", fresh, "CSED423", undefined, { withoutPdf: "summary" });
    assert.deepEqual([chosen.plan, chosen.pdfSource, !!chosen.transcriptPlan], [null, null, true]);
    console.log("PASS: PDF attached from the vault: copied as <lecture>.pdf, alt_pdf_source marked; the next import is a slide import and keeps the summary note under 이전 노트 백업");

    // A URL lecture without a PDF: the same choice; a PDF from disk (read into memory) makes it a slide lecture.
    const urlPv = preview();
    urlPv.pdfData = null;
    urlPv.altData = { ...urlPv.altData, title: "Lec8 Disk", metadata: { ...urlPv.altData.metadata, noteId: "note-8" } };
    urlPv.bundle = { sourceId: "note-8", sourceKind: "alt-url", title: "Lec8 Disk", pdf: null, slideTexts: null, transcript: urlPv.altData.transcript.split(/(?<=다\.) /).map((text) => ({ startMs: null, endMs: null, text, speaker: "" })) };
    const urlNote = "Alt2Obsidian/CSED311/Lectures/Lec8 Disk.md";
    await assert.rejects(plugin.prepareCliImport("u8", urlPv, "CSED311"), (e) => e.name === "MissingPdfError" && e.notePath === urlNote);
    const summaryUrl = await plugin.prepareCliImport("u8", urlPv, "CSED311", undefined, { withoutPdf: "summary" });
    assert.equal(summaryUrl.transcriptPlan.timed, false, "a URL transcript has no times");
    await assert.rejects(plugin.attachPdf(urlNote, { kind: "disk", name: "notes.txt", data: enc("plain text") }), /PDF 파일이 아닙니다: notes.txt/);
    const att2 = await plugin.attachPdf(urlNote, { kind: "disk", name: "lec8.pdf", data: pdfBytes });
    assert.deepEqual(att2, { pdfPath: "Alt2Obsidian/CSED311/Lectures/Lec8 Disk.pdf", replaced: false, marked: false }, "no note yet: nothing to mark");
    const urlPrep = await plugin.prepareCliImport("u8", urlPv, "CSED311");
    assert.equal(urlPrep.pdfSource, "attached");
    const urlRec = await plugin.runCliImport(urlPrep);
    assert.equal(urlRec.path, urlNote);
    assert.match(files.get(urlNote), /^alt_pdf_source: "attached"$/m);
    assert.match(files.get(urlNote), /^alt_id: "note-8"$/m);
    // Replacing: attaching again overwrites the same file (the mark is read from the note text: no second line).
    const att3 = await plugin.attachPdf(urlNote, { kind: "disk", name: "lec8-v2.pdf", data: enc("%PDF-1.7 v2") });
    assert.deepEqual([att3.replaced, att3.marked], [true, false]);
    assert.equal((files.get(urlNote).match(/^alt_pdf_source:/gm) ?? []).length, 1);
    // A URL PDF that fails to download is not "no slides": the error says so and offers a retry.
    const dlPv = preview();
    dlPv.pdfData = null;
    dlPv.pdfUrl = "https://example.invalid/lec5.pdf";
    dlPv.altData = { ...dlPv.altData, title: "Lec5 Download", metadata: { ...dlPv.altData.metadata, noteId: "note-5" } };
    plugin.pdfProcessor.downloadPdf = async () => {
      throw new Error("network down");
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      await assert.rejects(plugin.prepareCliImport("u5", dlPv, "CSED311"), (e) => e.name === "MissingPdfError" && e.downloadError === "network down" && /내려받지 못했습니다/.test(e.message));
    } finally {
      console.warn = warn;
      delete plugin.pdfProcessor.downloadPdf;
    }
    // A page parsed only in part (title and description) asks too, before any estimate.
    const partialPv = preview();
    partialPv.pdfData = null;
    partialPv.altData = { ...partialPv.altData, title: "Lec4 Partial", parseQuality: "partial", transcript: null, metadata: { ...partialPv.altData.metadata, noteId: "note-4" } };
    await assert.rejects(plugin.prepareCliImport("u4", partialPv, "CSED311"), (e) => e.name === "MissingPdfError" && /일부만 읽었습니다/.test(e.message));
    const partialOk = await plugin.prepareCliImport("u4", partialPv, "CSED311", undefined, { withoutPdf: "summary" });
    assert.deepEqual([partialOk.plan, partialOk.transcriptPlan], [null, null], "the chosen lecture-level note");
    // A slide note is never replaced by a summary note, even when its PDF is gone: stopped before any token.
    files.delete("Alt2Obsidian/CSED311/Lectures/Lec8 Disk.pdf");
    binaries.delete("Alt2Obsidian/CSED311/Lectures/Lec8 Disk.pdf");
    const n2 = s.calls().length;
    await assert.rejects(plugin.prepareCliImport("u8", urlPv, "CSED311", undefined, { withoutPdf: "summary" }), /이미 슬라이드별 노트가 있어/);
    assert.equal(s.calls().length, n2);
    // An Alt PDF without a readable page: the PDF the user attached next to the (new) note is used instead.
    const badPv = preview();
    badPv.pdfData = new ArrayBuffer(3);
    badPv.altData = { ...badPv.altData, title: "Lec6 Broken", metadata: { ...badPv.altData.metadata, noteId: "note-6" } };
    await assert.rejects(plugin.prepareCliImport("u6", badPv, "CSED311"), (e) => e.name === "MissingPdfError" && /읽지 못했습니다/.test(e.message));
    await plugin.attachPdf("Alt2Obsidian/CSED311/Lectures/Lec6 Broken.md", { kind: "disk", name: "lec6.pdf", data: pdfBytes });
    const fixed = await plugin.prepareCliImport("u6", badPv, "CSED311");
    assert.equal(fixed.pdfSource, "attached", "no loop: the attached PDF takes over");
    // An unmarked PDF next to an existing note is the plugin's own copy, not an attachment.
    const copyNote = "Alt2Obsidian/CSED311/Lectures/Vault Copy.md";
    files.set(copyNote, '---\ntitle: "Vault Copy"\nalt_id: "note-vc"\nsource: "alt2obsidian"\n---\n<!-- alt2obsidian:start -->\n# Vault Copy\n본문\n<!-- alt2obsidian:end -->\n\n## 내 메모\n');
    files.set("Alt2Obsidian/CSED311/Lectures/Vault Copy.pdf", "<binary>");
    binaries.set("Alt2Obsidian/CSED311/Lectures/Vault Copy.pdf", pdfBytes);
    const vcPv = preview();
    vcPv.pdfData = null;
    vcPv.altData = { ...vcPv.altData, title: "Vault Copy", metadata: { ...vcPv.altData.metadata, noteId: "note-vc" } };
    const vc = await plugin.prepareCliImport("uvc", vcPv, "CSED311");
    assert.equal(vc.pdfSource, "vault");
    await plugin.runCliImport(vc, { onConfirmUpdate: async () => true });
    assert.ok(!/alt_pdf_source/.test(files.get(copyNote)), "not marked as attached");
    assert.equal(plugin.lectureKindFor({ altType: null, hasSlides: false, hasTranscript: true, notePath: copyNote }), "vault-copy", "a slide note with its saved PDF: a slide lecture (never 노트(전사만))");
    // A PDF next to the note spelled <note>.PDF is used and written in place, never doubled as <note>.pdf.
    const upperPv = preview();
    upperPv.pdfData = null;
    upperPv.altData = { ...upperPv.altData, title: "Upper Case", metadata: { ...upperPv.altData.metadata, noteId: "note-uc" } };
    files.set("Alt2Obsidian/CSED311/Lectures/Upper Case.PDF", "<binary>");
    binaries.set("Alt2Obsidian/CSED311/Lectures/Upper Case.PDF", pdfBytes);
    const ucRec = await plugin.runCliImport(await plugin.prepareCliImport("uuc", upperPv, "CSED311"));
    assert.equal(ucRec.pdfPath, "Alt2Obsidian/CSED311/Lectures/Upper Case.PDF");
    assert.ok(!files.has("Alt2Obsidian/CSED311/Lectures/Upper Case.pdf"), "no second copy (a case-insensitive disk would refuse it)");
    // Obsidian's metadata cache lags right after a write: the mark is read from the note text.
    const realCache = plugin.app.metadataCache.getFileCache;
    const frozen = new Map();
    plugin.app.metadataCache.getFileCache = (f) => {
      if (!frozen.has(f.path)) frozen.set(f.path, realCache(f));
      return frozen.get(f.path);
    };
    try {
      await plugin.attachPdf(copyNote, { kind: "disk", name: "vc.pdf", data: pdfBytes });
      await plugin.attachPdf(copyNote, { kind: "disk", name: "vc2.pdf", data: pdfBytes });
      assert.equal((files.get(copyNote).match(/^alt_pdf_source:/gm) ?? []).length, 1, "attached twice before the cache caught up: one line");
      assert.equal((await plugin.prepareCliImport("uvc", vcPv, "CSED311")).pdfSource, "attached", "the next import sees the mark at once");
    } finally {
      plugin.app.metadataCache.getFileCache = realCache;
    }
    console.log("PASS: URL lecture without a PDF: same choice (untimed summary or attach); a PDF from disk is read into memory, copied, and the import marks the note");
  }

  // Model choice for one run (the sidebar's picker): the estimate follows, the settings never change, the note says what ran.
  {
    process.env.FAKE_CLI_MODE = "ok";
    plugin.data.settings.generation.onlyChangedSlides = false;
    const saved = JSON.stringify(plugin.data.settings.tasks);
    const prep = await plugin.prepareCliImport("https://altalt.io/note/x", preview(), "CSED311");
    const opus = plugin.withRunChoice(prep, "commentary", { provider: "claude-cli", model: "claude-opus-5-5", effort: "high" });
    assert.equal(opus.estimate.inputTokens, prep.estimate.inputTokens, "the same prompts");
    assert.ok(opus.estimate.outputTokens > prep.estimate.outputTokens, "high effort: more output expected");
    assert.equal(JSON.stringify(plugin.data.settings.tasks), saved, "a run choice never changes the settings");
    const codex = plugin.withRunChoice(prep, "commentary", { provider: "codex-cli", model: "", effort: "medium" });
    assert.ok(codex.plan.batches.length < prep.plan.batches.length, "Codex groups twice the slides per call");
    assert.ok(codex.estimate.inputTokens > prep.estimate.inputTokens, "Codex's fixed cost per call");
    assert.deepEqual(plugin.runTask(codex, "concepts"), plugin.data.settings.tasks.concepts, "other tasks keep the settings");
    const n0 = s.calls().length;
    const reported = [];
    const rec = await plugin.runCliImport(opus, { onConfirmUpdate: async () => true, onModel: (t, m) => reported.push(`${t}=${m}`) });
    const calls = s.calls().slice(n0);
    const modelOf = (c) => c.argv[c.argv.indexOf("--model") + 1];
    assert.ok(calls.filter((c) => !c.stdin.includes("concept")).every((c) => modelOf(c) === "claude-opus-5-5"), "commentary and overview on the chosen model");
    assert.ok(calls.some((c) => modelOf(c) === "haiku"), "concepts on the saved model");
    assert.ok(reported.includes("commentary=claude-opus-5-5") && reported.includes("concepts=claude-haiku-4-5-20251001"), reported.join(", "));
    assert.match(files.get(rec.path), /alt2obs_usage: \{provider: "Claude CLI claude-opus-5-5", model: "claude-opus-5-5", effort: "high", concept_model: "claude-haiku-4-5-20251001", /);
    assert.equal(JSON.stringify(plugin.data.settings.tasks), saved, "still unchanged after the run");
    assert.equal(plugin.data.resolvedModels["claude-cli:claude-opus-5-5"].id, "claude-opus-5-5");
    // "기본값으로 저장" makes it the saved setting, in the same object the settings tab holds.
    const held = plugin.data.settings.tasks.commentary;
    await plugin.saveTaskDefault("commentary", { provider: "claude-cli", model: "claude-opus-5-5", effort: "high" });
    assert.equal(plugin.data.settings.tasks.commentary, held, "updated in place");
    assert.deepEqual(stored().settings.tasks.commentary, { provider: "claude-cli", model: "claude-opus-5-5", effort: "high" });
    assert.equal(plugin.data.settings.preset, "custom");
    plugin.data.settings.tasks = JSON.parse(saved);
    plugin.data.settings.generation.onlyChangedSlides = true;
    console.log("PASS: a run's model choice: estimate follows (effort, Codex batches), settings untouched, the CLI gets the id, the note and the panel show the model that ran, 기본값으로 저장 saves it");
  }

  // Concept notes named the other way round are reused, never duplicated or renamed.
  {
    const folder = "Alt2Obsidian/CSED311/Concepts";
    const oldNote = `${folder}/로터리 스케줄링 (Lottery Scheduling).md`;
    files.set(oldNote, "---\ntags: [concept]\n---\n\n# 로터리 스케줄링 (Lottery Scheduling)\n\n**정의:** 무작위로 고른다.\n\n**관련 강의:** [[6강]]\n");
    const names = await plugin.vaultManager.getExistingConceptNames("CSED311");
    assert.ok(names.has("로터리 스케줄링 (Lottery Scheduling)"), [...names].join(", "));
    const norm = plugin.normalizeConcepts(
      [
        { name: "Lottery Scheduling (로터리 스케줄링)", definition: "새 정의", relatedConcepts: ["stride scheduling (스트라이드 스케줄링)", "Unknown (모름)"] },
        { name: "Stride Scheduling (스트라이드 스케줄링)", definition: "d", relatedConcepts: ["lottery scheduling"] },
        { name: "로터리 스케줄링", definition: "", relatedConcepts: [] },
      ],
      names
    );
    assert.deepEqual(norm.map((c) => c.name), ["로터리 스케줄링 (Lottery Scheduling)", "Stride Scheduling (스트라이드 스케줄링)"], "the existing name wins; duplicates merge");
    assert.deepEqual(norm[0].relatedConcepts, ["Stride Scheduling (스트라이드 스케줄링)"], "related names canonical, unknown ones dropped");
    assert.deepEqual(norm[1].relatedConcepts, ["로터리 스케줄링 (Lottery Scheduling)"]);
    const before = [...files.keys()].filter((k) => k.startsWith(folder)).length;
    // Even a name that was not canonicalized finds the note written the other way round.
    await plugin.vaultManager.saveConceptNotes(
      [{ name: "Lottery Scheduling (로터리 스케줄링)", definition: "d", relatedLectures: ["9강"], relatedConcepts: [] }, { name: "Stride Scheduling (스트라이드 스케줄링)", definition: "d", relatedLectures: ["9강"], relatedConcepts: [] }],
      "9강",
      "CSED311"
    );
    assert.ok(!files.has(`${folder}/Lottery Scheduling (로터리 스케줄링).md`), "no duplicate note in the new order");
    assert.match(files.get(oldNote), /\*\*관련 강의:\*\* \[\[6강\]\], \[\[9강\]\]/, "the existing note gets the lecture, keeps its name");
    assert.ok(files.has(`${folder}/Stride Scheduling (스트라이드 스케줄링).md`), "a new concept uses the new order");
    assert.equal([...files.keys()].filter((k) => k.startsWith(folder)).length, before + 1);
    // The update dialog compares concept links as concepts: a link in the other order is not "removed".
    const lect = "Alt2Obsidian/CSED311/Lectures/Order Lec.md";
    files.set(lect, "---\ntitle: x\n---\n<!-- alt2obsidian:start -->\n# x\n[[로터리 스케줄링 (Lottery Scheduling)|Lottery Scheduling]]\n<!-- alt2obsidian:end -->\n");
    const summary = await plugin.vaultManager.buildManagedNoteUpdateSummary(lect, "---\ntitle: x\n---\n<!-- alt2obsidian:start -->\n# x\n본문\n<!-- alt2obsidian:end -->\n", ["Lottery Scheduling (로터리 스케줄링)"]);
    assert.deepEqual([summary.addedConcepts, summary.removedConcepts], [[], []]);
    files.delete(lect);
    console.log("PASS: concept notes match in either name order (English or Korean part): existing notes reused and kept, new ones named English (한국어); the update dialog compares them as concepts");
  }

  // Claude Code's model catalog: the newest *-cc.json under CLAUDE_CONFIG_DIR, kept once found.
  {
    const cfg = mkdtempSync(join(tmpdir(), "alt2obs-claude-config-"));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      const fresh = await makePlugin(undefined);
      assert.deepEqual(fresh.plugin.claudeModels(), [], "no catalog yet: the built-in list is used");
      const dir = join(cfg, "cache", "model-catalog");
      mkdirSync(dir, { recursive: true });
      const cat = (id, name) => JSON.stringify({ catalog: { config: { models: [{ id, name, section: "main", thinking: { type: "effort", effort_options: [{ id: "low" }] } }] } } });
      writeFileSync(join(dir, "old-cc.json"), cat("claude-old-1", "Old 1"));
      writeFileSync(join(dir, "new-cc.json"), cat("claude-new-2", "New 2"));
      writeFileSync(join(dir, "other.json"), cat("claude-other", "Other"));
      const past = (Date.now() - 3600 * 1000) / 1000;
      utimesSync(join(dir, "old-cc.json"), past, past);
      assert.deepEqual(fresh.plugin.claudeModels().map((m) => m.id), ["claude-new-2"], "read again after an empty result; the newest -cc.json wins");
      writeFileSync(join(dir, "new-cc.json"), cat("claude-newer-3", "Newer 3"));
      assert.deepEqual(fresh.plugin.claudeModels().map((m) => m.id), ["claude-new-2"], "kept for the session once found");
      assert.equal(fresh.plugin.modelCatalog().claude[0].name, "New 2");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      rmSync(cfg, { recursive: true, force: true });
    }
    console.log("PASS: Claude Code's model catalog: newest -cc.json under CLAUDE_CONFIG_DIR, read again until found, then kept");
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
