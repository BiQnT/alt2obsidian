/**
 * Test: the settings tab as Obsidian 1.13 and later use it, without a DOM.
 * getSettingDefinitions() returns a well-formed tree (groups with the tab's
 * headings, named rows that are either a control or a render callback) and
 * has no side effects (no CLI lookup, model list, save or DOM access), and
 * getControlValue / setControlValue read and write the plugin's settings,
 * refuse what the fields below 1.13 refused, run the same side effects and
 * save. How display() and the definitions draw is test/dom-settings.mjs.
 * Run: node test/test-settings-tab.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";

const { Alt2ObsSettingsTab, DEFAULT_SETTINGS, TASK_LABELS } = await importTs("test/helpers/settings-tab-entry.ts");

const HEADINGS = [undefined, "LLM 연결", "작업별 모델", "생성 옵션", "사용량", "보기", "저장", "사용법"];
const CONTROL_TYPES = new Set(["toggle", "dropdown", "text", "number"]);

function makePlugin() {
  const calls = [];
  const spy = (name, ret) => () => (calls.push(name), ret);
  return {
    calls,
    data: {
      settings: structuredClone(DEFAULT_SETTINGS),
      recentImports: [],
      cliDetection: {},
      usageTotals: { calls: 3, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, imagesSent: 0, costUsd: 0, lectures: 1, byProvider: {}, since: "2026-10-01" },
    },
    cliErrors: {},
    savePluginData: async () => void calls.push("save"),
    detectCli: spy("detectCli", Promise.resolve(null)),
    modelCatalog: spy("modelCatalog", { claude: [], codex: { models: [], efforts: {} }, resolved: {} }),
    applyCommentHiding: spy("applyCommentHiding"),
    updateBasePath: spy("updateBasePath"),
    keepOpenPdfTabsPlain: spy("keepOpenPdfTabsPlain"),
  };
}

const at = (obj, key) => key.split(".").reduce((o, k) => o?.[k], obj);
const rows = (defs) => defs.flatMap((g) => g.items);
const shape = (defs) =>
  JSON.stringify(defs.map((g) => [g.type, g.heading, g.items.map((d) => [d.name, d.desc ?? null, d.aliases ?? null, d.control ? [d.control.type, d.control.key] : "render"])]));

// ---- the tree, and no side effects ----
{
  const plugin = makePlugin();
  const tab = new Alt2ObsSettingsTab({}, plugin);
  const before = structuredClone(plugin.data);
  // Any DOM access from getSettingDefinitions() throws.
  tab.containerEl = new Proxy({}, { get: (_, p) => assert.fail(`getSettingDefinitions() touched containerEl.${String(p)}`) });
  const defs = tab.getSettingDefinitions();
  assert.ok(Array.isArray(defs) && defs.length > 0, "a non-empty list: Obsidian 1.13 draws the tab from it");
  assert.deepEqual(plugin.calls, [], "no CLI lookup, model list, save or side effect while listing");
  assert.deepEqual(plugin.data, before, "the plugin data is untouched");
  assert.equal(tab.updates, 0);
  assert.equal(shape(tab.getSettingDefinitions()), shape(defs), "the same tree each time");

  assert.deepEqual(defs.map((g) => g.type), defs.map(() => "group"));
  assert.deepEqual(defs.map((g) => g.heading), HEADINGS, "the section headings of the tab, in order (the notice first, without one)");
  const names = new Set();
  for (const g of defs) {
    assert.ok(Array.isArray(g.items) && g.items.length > 0, `group ${g.heading}: rows`);
    for (const d of g.items) {
      assert.equal(typeof d.name, "string");
      assert.ok(d.name.trim(), `group ${g.heading}: every row has a name (search and Obsidian's row key)`);
      assert.ok(!names.has(d.name), `one row named ${d.name}`);
      names.add(d.name);
      assert.ok(d.desc === undefined || (typeof d.desc === "string" && d.desc.trim()), `${d.name}: desc`);
      assert.ok(d.aliases === undefined || (Array.isArray(d.aliases) && d.aliases.every((a) => typeof a === "string" && a.trim())), `${d.name}: aliases`);
      assert.ok(d.visible === undefined || typeof d.visible === "function", `${d.name}: visible`);
      assert.equal(["control", "render", "action"].filter((k) => d[k] !== undefined).length, 1, `${d.name}: one of control / render`);
      assert.ok(d.action === undefined && d.type === undefined, `${d.name}: a setting row, not an action or a page`);
      if (!d.control) {
        assert.equal(typeof d.render, "function");
        continue;
      }
      const c = d.control;
      assert.ok(CONTROL_TYPES.has(c.type), `${d.name}: control type ${c.type}`);
      assert.deepEqual(
        Object.keys(c).filter((k) => !["type", "key", "options", "placeholder", "min", "defaultValue", "validate"].includes(k)),
        [],
        `${d.name}: only Obsidian's control fields (no getter or setter leaks in)`
      );
      assert.notEqual(at(plugin.data.settings, c.key), undefined, `${d.name}: key ${c.key} is a value in the settings`);
      if (c.type === "dropdown") assert.ok(Object.keys(c.options).includes(at(plugin.data.settings, c.key)), `${d.name}: the current value is an option`);
      if (c.type === "number") {
        assert.ok(c.defaultValue >= c.min, `${d.name}: default at least the minimum`);
        // Obsidian reads the field with parseFloat: a fraction is refused, not saved without its decimals.
        assert.equal(c.validate(c.defaultValue), undefined, `${d.name}: a whole number passes`);
        assert.equal(c.validate(8.5), "정수로 입력하세요", `${d.name}: a fraction is refused`);
      } else assert.equal(c.validate, undefined, `${d.name}: no validate`);
    }
  }
  for (const label of Object.values(TASK_LABELS)) assert.equal(typeof rows(defs).find((d) => d.name === label)?.render, "function", `task row ${label}`);
  for (const name of ["실행 파일 경로", "프리셋", "누적 사용량", "저장 폴더", "Alt 데이터 폴더", "CLI 호출 제한 시간 (초)"]) assert.ok(names.has(name), name);
  const aliases = rows(defs).flatMap((d) => d.aliases ?? []);
  for (const word of ["model", "effort", "folder", "Claude", "Codex", "Notion"]) assert.ok(aliases.includes(word), `search alias ${word}`);

  // The legacy key row shows only while a key is stored; the check is cheap.
  const legacy = rows(defs).find((d) => d.name === "이전 API 키 지우기");
  assert.equal(legacy.visible(), false);
  plugin.data.settings.geminiApiKey = "k";
  assert.equal(legacy.visible(), true);
  assert.deepEqual(plugin.calls, []);
  console.log(`PASS: getSettingDefinitions() lists ${defs.length} groups and ${names.size} named rows, with no side effects`);
}

// ---- getControlValue / setControlValue ----
{
  const plugin = makePlugin();
  const tab = new Alt2ObsSettingsTab({}, plugin);
  const controls = rows(tab.getSettingDefinitions()).filter((d) => d.control).map((d) => d.control);
  assert.equal(controls.length, 14);
  const settings = () => plugin.data.settings;
  const write = async (key, value) => {
    plugin.calls.length = 0;
    await tab.setControlValue(key, value);
    return [...plugin.calls];
  };

  // Every key reads its settings value, and a new value round-trips and saves.
  const next = {
    toggle: (v) => !v,
    dropdown: (v, c) => Object.keys(c.options).find((o) => o !== v),
    text: (v, c) => ({ notionFetchTool: "mcp__notion__notion-fetch", baseFolderPath: "Lectures 2026", altDataDir: "/tmp/alt data" })[c.key],
    number: (v) => v + 7,
  };
  for (const c of controls) {
    assert.equal(tab.getControlValue(c.key), at(settings(), c.key), `read ${c.key}`);
    const value = next[c.type](tab.getControlValue(c.key), c);
    const calls = await write(c.key, value);
    assert.equal(tab.getControlValue(c.key), value, `write ${c.key}`);
    assert.equal(at(settings(), c.key), value, `${c.key} in the settings`);
    assert.equal(calls.filter((x) => x === "save").length, 1, `${c.key}: saved once`);
  }

  // The side effects, in the order display() ran them before.
  assert.deepEqual(await write("hideManagedComments", true), ["save", "applyCommentHiding"]);
  assert.deepEqual(await write("openPdfInViewer", true), ["keepOpenPdfTabsPlain", "save"]);
  assert.deepEqual(await write("openPdfInViewer", false), ["save"]);
  assert.deepEqual(await write("baseFolderPath", "Notes"), ["save", "updateBasePath"]);
  assert.deepEqual(await write("baseFolderPath", ""), ["save", "updateBasePath"]);
  assert.equal(settings().baseFolderPath, DEFAULT_SETTINGS.baseFolderPath, "an empty folder is the default one");
  assert.deepEqual(await write("altDataDir", "  /Users/me/alt  "), ["save"]);
  assert.equal(settings().altDataDir, "/Users/me/alt");
  // The preset sets the task table, then the tab is drawn again (update() from 1.13 on).
  const updates = tab.updates;
  assert.deepEqual(await write("preset", "saving"), ["save"]);
  assert.equal(settings().preset, "saving");
  assert.equal(settings().tasks.commentary.model, "haiku");
  assert.equal(tab.updates, updates + 1, "the task rows are drawn again");

  // Values the fields below 1.13 refused are refused: nothing changes, nothing is saved.
  const refused = async (key, value) => {
    const old = tab.getControlValue(key);
    assert.deepEqual(await write(key, value), [], `${key} = ${JSON.stringify(value)} is refused`);
    assert.equal(tab.getControlValue(key), old);
  };
  await refused("generation.batchSize", 0);
  await refused("generation.batchSize", "abc");
  await refused("generation.transcriptCapChars", -1);
  await refused("cliTimeoutSec", 29);
  await refused("cliTimeoutSec", "");
  await refused("notionFetchTool", "notion-fetch");
  await refused("generation.imageRule", "never");
  await refused("language", "toString");
  await refused("preset", 3);
  await refused("no.such.key", 1);
  assert.equal(tab.getControlValue("no.such.key"), undefined);
  // Whole numbers: the old text field's "12.7", and a fraction that reaches setControlValue anyway (1.13's validate() refuses it first).
  await write("generation.batchSize", "12.7");
  assert.equal(settings().generation.batchSize, 12);
  await write("cliTimeoutSec", 99.9);
  assert.equal(settings().cliTimeoutSec, 99);
  await write("notionFetchTool", "  ");
  assert.equal(settings().notionFetchTool, "", "empty: found with claude mcp list");

  // Obsidian keeps the definitions from when the tab was added; a settings
  // object loaded later (the 2.0.0 data import) is still the one read and written.
  plugin.data = { ...plugin.data, settings: structuredClone(DEFAULT_SETTINGS) };
  assert.equal(tab.getControlValue("generation.batchSize"), DEFAULT_SETTINGS.generation.batchSize);
  await write("generation.batchSize", 5);
  assert.equal(plugin.data.settings.generation.batchSize, 5);
  console.log(`PASS: getControlValue / setControlValue round-trip all ${controls.length} controls, save once each, keep the old side effects and refusals`);
}
