/**
 * DOM test: the settings tab (src/ui/SettingsTab.ts) laid out by Obsidian
 * 1.14's setting rules (test/fixtures/dom/obsidian-settings.css) plus the
 * plugin's styles.css in a real headless Chromium, at settings pane widths
 * from the narrowest settings window (about 360px for the pane) to a wide
 * one, drawn both ways: by display() as Obsidian before 1.13 does, and from
 * getSettingDefinitions() as 1.13 and later do (a stand-in for Obsidian
 * 1.14.4's renderer, test/helpers/dom-settings-entry.ts). No description may
 * collapse to a narrow column, the CLI card's description spans the card,
 * and no row grows an empty gap (Obsidian's narrow-pane container query
 * turns rows into columns). A plain Setting row without the plugin's
 * classes is the control: under the same rules its description does
 * collapse, as users saw in 2.0.0-beta.3.
 *
 * Also: display() draws what it drew before the definitions came
 * (test/fixtures/dom/settings-outline.json: headings, names, descriptions,
 * controls with their values and options, blocks with their text), the
 * definitions draw exactly the same, every row display() draws has a
 * definition, and changes made through either path's controls save and
 * draw the tab again.
 *
 * Needs a Chromium binary, so it is not part of `npm test`:
 *   npm run test:dom                 (finds Playwright's headless shell or Google Chrome)
 *   ALT2OBS_CHROME=/path/to/chrome npm run test:dom
 * Fails (does not skip) when no browser is found.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import esbuild from "esbuild";
import { repo } from "./helpers/bundle-ts.mjs";

function findChrome() {
  if (process.env.ALT2OBS_CHROME) return process.env.ALT2OBS_CHROME;
  const pw = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(pw, d))) {
        const bin = join(pw, d, sub, "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(mac) ? mac : null;
}

const chrome = findChrome();
assert.ok(chrome, "no Chromium found: set ALT2OBS_CHROME");

const WIDTHS = [360, 460, 620, 760, 1000];
const dir = mkdtempSync(join(tmpdir(), "alt-to-obs-dom-settings-"));
writeFileSync(
  join(dir, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="obsidian.css"><link rel="stylesheet" href="styles.css"></head>' +
    '<body><div id="pane"></div><div id="control" style="width:280px"></div><pre id="out">pending</pre><script type="module" src="./bundle.js"></script></body></html>'
);
writeFileSync(join(dir, "obsidian.css"), readFileSync(join(repo, "test/fixtures/dom/obsidian-settings.css")));
writeFileSync(join(dir, "styles.css"), readFileSync(join(repo, "styles.css")));
await esbuild.build({
  entryPoints: [join(repo, "test/helpers/dom-settings-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(dir, "bundle.js"),
  loader: { ".md": "text", ".css": "text" },
  logLevel: "error",
  plugins: [{ name: "obsidian-stub", setup: (b) => b.onResolve({ filter: /^obsidian$/ }, () => ({ path: join(repo, "test/helpers/obsidian-browser-stub.js") })) }],
});

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const file = join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless", `--remote-debugging-port=${port}`, "--window-size=1400,900", `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const interactions = {};
try {
  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(100);
    }
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d), pending.delete(d.id);
    else if (d.method === "Runtime.exceptionThrown") console.error("page exception:", d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  await send("Runtime.enable");
  const load = async (query) => {
    await send("Page.navigate", { url: `${base}?${query}` });
    let out = "pending";
    for (let i = 0; i < 120 && out === "pending"; i++) {
      await sleep(100);
      const r = await send("Runtime.evaluate", { expression: "document.getElementById('out')?.textContent ?? 'pending'" });
      out = r.result?.result?.value ?? "pending";
    }
    assert.ok(!out.startsWith("ERROR") && out !== "pending", `${query}: ${out}`);
    return JSON.parse(out);
  };
  for (const path of ["old", "new"]) for (const w of WIDTHS) results.push(await load(`w=${w}&path=${path}`));
  for (const path of ["old", "new"]) results.push(await load(`w=760&path=${path}&scenario=full`));
  for (const path of ["old", "new"]) interactions[path] = await load(`w=760&path=${path}&scenario=full&mode=interact`);
  ws.close();
} finally {
  proc.kill();
  server.close();
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}

for (const r of results) {
  const at = `${r.path} path, pane ${r.w}px`;
  assert.ok(r.controlDescW < 60, `the control row collapses under these rules (${r.controlDescW}px), so they reproduce the beta.3 bug`);
  // The pane's side padding, and a setting group's row padding on the new path.
  const content = r.w - 64 - (r.path === "new" ? 40 : 0);
  for (const row of r.rows.filter((x) => x.hasDesc)) {
    assert.ok(row.descW >= Math.min(200, content - 40), `${at}, "${row.name}": description ${row.descW}px wide`);
    assert.ok(row.infoH <= row.textH + 12, `${at}, "${row.name}": info box ${row.infoH}px tall for ${row.textH}px of text (no empty gap)`);
  }
  assert.equal(r.cards.length, 2);
  for (const c of r.cards) {
    assert.ok(c.descW >= c.cardW - 2, `${at}: the card description spans the card (${c.descW} of ${c.cardW}px)`);
    assert.ok(c.inputW >= 100, `${at}: the path field stays usable (${c.inputW}px)`);
  }
  // A block row (notice, cards, model note, help) is the block, full width.
  assert.equal(r.blocks.length, r.path === "new" ? 4 : 0, `${at}: block rows`);
  for (const b of r.blocks) assert.ok(b.childW >= b.w - 40 - 2, `${at}: the block spans its row (${b.childW} of ${b.w}px)`);
}
console.log(`PASS: settings tab under Obsidian 1.14 setting rules at panes of ${WIDTHS.join(", ")}px, drawn by display() and from the definitions: no collapsed description, CLI card descriptions span the card, no empty gaps (the plain Setting control collapses to ${results[0].controlDescW}px)`);

const expected = JSON.parse(readFileSync(join(repo, "test/fixtures/dom/settings-outline.json"), "utf8"));
for (const scenario of ["default", "full"]) {
  const old = results.find((r) => r.path === "old" && r.scenario === scenario);
  const now = results.find((r) => r.path === "new" && r.scenario === scenario);
  assert.deepEqual(old.outline, expected[scenario], `${scenario}: display() draws what it drew before`);
  assert.deepEqual(now.outline, old.outline, `${scenario}: the definitions draw what display() draws`);
  const missing = old.displayNames.filter((n) => !old.definitionNames.includes(n));
  assert.deepEqual(missing, [], `${scenario}: every heading and row display() draws has a definition`);
}
console.log("PASS: display() draws the tab as before (fixture), the definitions draw the same rows, texts, controls and values, and every row display() draws has a definition");

for (const path of ["old", "new"]) {
  const r = interactions[path];
  assert.equal(r.preset, "saving", `${path}: preset`);
  assert.equal(r.commentaryModel, "haiku", `${path}: the preset set the task table`);
  assert.equal(r.commentaryModelSelect, "haiku", `${path}: the task rows were drawn again`);
  assert.equal(r.batchSize, 12, `${path}: number field`);
  assert.equal(r.saveKeyDiagrams, false, `${path}: toggle`);
  assert.equal(r.usageCalls, 0, `${path}: usage reset`);
  assert.equal(r.usageDesc, "아직 기록이 없습니다.", `${path}: the usage row was drawn again`);
  assert.equal(r.legacyKey, null, `${path}: legacy key cleared`);
  assert.equal(r.legacyRowShown, false, `${path}: its row is gone`);
  assert.equal(r.saves, 5, `${path}: one save per change`);
  // Obsidian 1.13 and later: redrawn with update() (preset, usage, legacy keys); before 1.13 with display()'s drawing.
  assert.equal(r.updates, path === "new" ? 3 : null, `${path}: redraws`);
}
console.log("PASS: changes through the controls of either path save once each and draw the tab again (update() from 1.13 on)");
